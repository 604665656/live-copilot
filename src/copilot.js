'use strict';
// 编排核心：弹幕 -> 点歌 / AI 解说 / 狼人杀播报
const { EventEmitter } = require('events');
const { BiliLive } = require('./bili.js');
const { searchQQ, searchNetease, Player, resolveTrack, getLyric } = require('./music.js');
const { Brain } = require('./brain.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 字符重合率：判断搜索结果是否真对得上观众输入的关键词
function similarity(a, b) {
  if (!a || !b) return 0;
  const A = new Set(String(a).split(''));
  const B = new Set(String(b).split(''));
  let same = 0;
  for (const ch of A) if (B.has(ch)) same++;
  return same / Math.max(A.size, B.size);
}

class Copilot extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = Object.assign({
      roomId: '',
      songCmd: '点歌',
      cutCmd: '切歌',
      aiCmd: '问',
      cooldownMs: 8000,
      maxQueue: 10,
      perUser: 2,
      aiOnDanmaku: true,
      aiChance: 0.25,
      sayPrefix: '【AI】',
      fallbackPrefix: '【兜底】',
      enableDanmakuReply: true,
      guessMode: true,
      gamePollMs: 6000,
      musicProvider: 'qq',
      volume: 70,
    }, cfg);
    this.brain = new Brain(cfg.ai || {});
    this.player = new Player({
      mpvPath: (cfg.ai && cfg.ai.mpvPath) || cfg.mpvPath,
      volume: this.cfg.volume,
      onEvent: (type, data) => this.emit('player', data),
    });
    this.queue = [];
    this._playing = false;   // 防止并发重复起播
    this.userCount = {};
    this.userCool = {};
    this.stats = { danmaku: 0, songs: 0, ai: 0, miss: 0 };
    this.lastSaid = '';
    this.sayHistory = [];
  }

  // ---------- 直播连接 ----------
  start() {
    if (!this.cfg.roomId) throw new Error('未配置直播间号');
    this.bili = new BiliLive(this.cfg.roomId, {
      onEvent: (type, data) => {
        if (type === 'danmaku') return this.onDanmaku(data);
        if (type === 'log') return this.emit('log', data);
        this.emit(type, data);
      },
    });
    this.bili.start();
    this.emit('log', `已启动，直播间 ${this.cfg.roomId}`);
  }

  stop() {
    this.bili && this.bili.stop();
    this.player.stop();
    this.emit('log', '已停止');
  }

  // ---------- 弹幕处理 ----------
  async onDanmaku(dm) {
    this.stats.danmaku += 1;
    this.emit('danmaku', dm);
    const text = (dm.text || '').trim();
    if (!text) return;

    // 点歌
    if (text.startsWith(this.cfg.songCmd)) {
      const kw = text.slice(this.cfg.songCmd.length).trim();
      return this.requestSong(dm, kw);
    }
    if (text === this.cfg.cutCmd) {
      this.emit('log', `切歌：${dm.user}`);
      await this.player.stop();
      return this.playNext();
    }
    if (text.startsWith(this.cfg.aiCmd)) {
      return this.replyAI(dm, text.slice(this.cfg.aiCmd.length).trim(), true);
    }
    if (this.cfg.aiOnDanmaku && Math.random() < this.cfg.aiChance) {
      return this.replyAI(dm, text, false);
    }
  }

  // ---------- 点歌 ----------
  async requestSong(dm, keyword) {
    if (!keyword) return;
    const now = Date.now();
    const key = String(dm.uid || dm.user);
    const last = this.userCool[key] || 0;
    if (now - last < this.cfg.cooldownMs) {
      return this.say(`@${dm.user} 别急，${Math.ceil((this.cfg.cooldownMs - (now - last)) / 1000)}秒后再点`);
    }
    if (this.userCount[key] >= this.cfg.perUser) {
      return this.say(`@${dm.user} 你已经点了${this.cfg.perUser}首啦，先听会`);
    }
    if (this.queue.length >= this.cfg.maxQueue) {
      return this.say(`@${dm.user} 歌单已满(${this.cfg.maxQueue})，稍后再来`);
    }

    let results = [];
    try {
      results = this.cfg.musicProvider === 'netease'
        ? await searchNetease(keyword, 5)
        : await searchQQ(keyword, 5);
      if (!results.length) results = await searchNetease(keyword, 5);
    } catch (e) {
      this.emit('log', '搜索失败: ' + e.message);
    }

    // 没找到：弹幕回应
    if (!results.length) {
      this.stats.miss += 1;
      this.emit('songmiss', { user: dm.user, keyword });
      const fb = await this.tryAI(`观众"${dm.user}"点了《${keyword}》，但曲库里没有这首歌。用一句话回应，并说会换一首或让他换歌名。`);
      return this.say(fb || `${this.cfg.fallbackPrefix||'【兜底】'} 曲库里没有《${keyword}》，换首歌名试试~`);
    }

    const track = results[0];
    // 校验：歌名与关键词偏差过大视为搜错（如搜"这首歌不存在"命中"XY&Z"）
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_·・,，.。!！?？()（）\[\]【】"'"'#~、]/g, '');
    const kwN = norm(keyword);
    const nameN = norm(track.name);
    const artistN = norm(track.artist);
    const related = kwN.length < 2
      || nameN.includes(kwN) || kwN.includes(nameN)
      || artistN.includes(kwN) || kwN.includes(artistN)
      || similarity(kwN, nameN) >= 0.5;
    if (!related) {
      this.stats.miss += 1;
      this.emit('songmiss', { user: dm.user, keyword, wrongHit: track.name });
      const fb = await this.tryAI(`观众"${dm.user}"点了《${keyword}》，曲库只匹配到不相关的《${track.name}》。用一句话回应，让他换个歌名。`);
      return this.say(fb || `${this.cfg.fallbackPrefix||'【兜底】'} 没找到《${keyword}》，换个歌名试试~`);
    }
    track.requester = dm.user;
    this.userCount[key] = (this.userCount[key] || 0) + 1;
    this.userCool[key] = Date.now();
    this.stats.songs += 1;
    this.queue.push(track);
    this.emit('queue', this.queue);
    this.say(`@${dm.user} 点歌成功《${track.name}》- ${track.artist}`);
    if (!this._playing) this.playNext();
  }

  // 依次播下一首：解析直链 -> 取歌词 -> 播放 -> 预告下一首
  // 解析不到播放地址的歌自动跳过，不会卡住队列
  async playNext() {
    let track = this.queue.shift();
    this.emit('queue', this.queue);
    while (track) {
      let resolved = null;
      try {
        resolved = track.url ? track : await resolveTrack(track);
      } catch (e) {
        this.emit('log', `解析《${track.name}》异常: ${e.message}`);
      }
      if (resolved && resolved.url) {
        try {
          resolved.lyric = (await getLyric(resolved)) || '';
        } catch (e) { resolved.lyric = ''; }
        this._playing = true;
        this.emit('playing', resolved);
        this.emit('next', this.queue[0] || null);
        await this.player.play(resolved);
        return;
      }
      this.emit('log', `《${track.name || '未知'}》无可用音源，已跳过`);
      track = this.queue.shift();
      this.emit('queue', this.queue);
    }
    this._playing = false;
    this.player.current = null;
    this.emit('player', { state: 'idle', track: null });
    this.emit('next', null);
  }

  // ---------- AI ----------
  async replyAI(dm, text, always) {
    if (!text) return;
    if (!this.brain.enabled && !always) return;
    const fb = this.brain.fallback('danmaku', dm);
    const out = await this.tryAI(`观众"${dm.user}"说：${text}\n请用一句简短回复。`);
    if (out) {
      this.stats.ai += 1;
      this.say(`${this.cfg.sayPrefix} ${out}`);
      this.emit('ai', { user: dm.user, in: text, out, source: 'ai' });
    } else if (always) {
      // 兜底文案必须标明来源，不能冒充 AI
      this.stats.fallback = (this.stats.fallback || 0) + 1;
      this.say(`${this.cfg.fallbackPrefix || '【兜底】'} ${fb}`);
      this.emit('ai', { user: dm.user, in: text, out: fb, source: 'fallback' });
    }
  }

  async tryAI(prompt) {
    try {
      if (!this.brain.enabled) return '';
      const r = await this.brain.chat(prompt, { maxTokens: 90 });
      return r;
    } catch (e) {
      // 本地模型没开时会连续失败，做节流避免刷屏
      this._aiFail = (this._aiFail || 0) + 1;
      if (this._aiFail <= 3 || this._aiFail % 20 === 0) this.emit('log', 'AI失败: ' + e.message);
      return '';
    }
  }

  // ---------- 输出到直播间 ----------
  say(text) {
    if (!text) return;
    if (text === this.lastSaid) return;
    this.lastSaid = text;
    const item = { text, time: Date.now() };
    this.sayHistory.push(item);
    if (this.sayHistory.length > 200) this.sayHistory.shift();
    this.emit('say', item);
  }

  // ---------- 弹幕狼人杀播报 ----------
  gameHint(kind, extra = {}) {
    return this.tryAI(`【弹幕狼人杀·${kind}】${JSON.stringify(extra)}\n作为主持人，说一句引导观众互动的话。`);
  }
}

module.exports = { Copilot };
