'use strict';
// src/audience.js — 场外围观观众 NPC（模拟真实观众陆续进场、有性格、按关键字回话、狡辩、归票）
//
// 设计：
//  - 观众不是游戏玩家，是直播间公屏的「吃瓜群众」。他们陆续进场（joinAt 错峰），
//    进场后才开始发言，模拟真实观众「慢慢凑过来」的观感。
//  - 每个观众有性格（复用 npc.PERSONALITIES），性格决定发言频率、是否爱归票、是否爱唱反调。
//  - 关键字驱动：根据解说广播 / 当前被投票人 / 上一场处决结果，选择「归票 / 狡辩 / 提问 / 闲聊」。
//  - 全部纯逻辑：产出消息对象 {name, personaKey, kind, text}，由调用方决定如何发出
//    （demo 里打印，live 里走导演的 dm() 发真实弹幕，或仅记日志）。
'use strict';

const npc = require('./npc');
const PERSONALITIES = npc.PERSONALITIES;
const PKEYS = Object.keys(PERSONALITIES);

const NAMES = [
  '路过的风', '吃瓜阿强', '深夜不睡星人', '弹幕护卫队', '前排小明', '三连击选手',
  '隔壁老王', '柠檬精本精', '理性分析菌', '键盘侠本侠', '佛系看戏', '热血青年',
  '毒舌评委', '吃糖少女', '退役狼王', '预言家粉丝', '划水冠军', '气氛组组长',
  '二把刀', '十级学者', '看戏的路人', '弹幕区扛把子', '夜猫子', '瓜子摊主',
];

const rnd = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- 观众发言素材 ----------
const BANK = {
  join: [
    '来了来了，占个前排',
    '刚进直播间，现在什么局势？',
    '签到！今天也来吃瓜',
    '前排出售瓜子饮料，要的扣1',
    '摸鱼路过，蹲一个高能',
  ],
  chatter: [
    '这局质量局啊，比昨天那把强多了',
    '弹幕区比游戏还精彩',
    '我就看看，我不说话（然后疯狂扣字）',
    '主播什么时候也来一局',
    '这个BGM我可以单曲循环',
    '楼上别带节奏，好好看戏',
    '卧槽这波操作我看不懂但大受震撼',
  ],
  accuse: [ // 归票：点名某号是狼，喊大家投他
    (no) => `${no}号我看就不对劲，这轮归${no}号没跑了`,
    (no) => `听我的，投${no}号，这货铁狼`,
    (no) => `${no}号前面那波发言水得不行，狼味冲天，冲他！`,
    (no) => `我盲猜${no}号，敢对跳的都不是好东西`,
  ],
  defend: [ // 狡辩/保人：替被点名的人说话
    (no) => `${no}号别慌，我看是好人，这波冤枉人了`,
    (no) => `凭什么咬${no}号？有证据吗就开麦`,
    (no) => `${no}号这演技我吃了，真狼早跳了`,
    (no) => `你们动动脑子，${no}号这时候跳出来送人头图啥`,
  ],
  question: [
    '所以现在到底几个狼几个好啊',
    '主播能科普下规则吗，萌新看不懂',
    '刚才那一票为啥投他？求解释',
    '狼人现在在开会吗，我们正好团建',
    '这游戏叫啥名，我也想去玩',
  ],
  reactWolf: [ // 处决揭示是狼
    (no) => `${no}号真的是狼！我就说吧，掌声`,
    (no) => `干净利落，${no}号这波血赚`,
    (no) => `事实证明${no}号就是一匹狼，下一位`,
  ],
  reactGood: [ // 处决揭示是好人（冤案）
    (no) => `${no}号是好人？？这波冤大头了`,
    (no) => `残酷，${no}号清白好人，狼人在暗处笑`,
    (no) => `${no}号用生命证明百口莫辩，好人反思`,
  ],
};

class Spectator {
  constructor(uid, name, personaKey, joinAtMs) {
    this.uid = uid;
    this.name = name;
    this.personaKey = personaKey;
    this.P = PERSONALITIES[personaKey];
    this.joinAtMs = joinAtMs;
    this.joined = false;
    this.lastSpeak = -1e9;
    this.heat = 0;
  }
}

class AudienceManager {
  constructor(opts = {}) {
    this.onMessage = opts.onMessage || (() => {});
    this.enabled = opts.enabled !== false;
    this.target = opts.target || 14;          // 同时在场观众上限
    this.joinWindowMs = opts.joinWindowMs || 45000; // 陆续进场时间窗
    this.spectators = [];
    this.t = 0;                              // 当前对局内流逝时间(ms)
    this._id = 0;
    this.knowledge = opts.knowledge || null; // evolve 引擎给的建议（含 personaTrust 等）
    this._lastCtx = null;
  }

  // 对局开始：生成一批观众，错峰进场
  spawn() {
    this.spectators = [];
    this._id = 0;
    const n = Math.min(this.target, NAMES.length);
    const shuffled = NAMES.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < n; i++) {
      const personaKey = PKEYS[(i * 5 + 3) % PKEYS.length];
      const name = shuffled[i];
      const joinAt = Math.floor(Math.random() * this.joinWindowMs); // 0~window 内随机进场
      this.spectators.push(new Spectator('aud' + this._id++, name, personaKey, joinAt));
    }
    return this.spectators.length;
  }

  joinedCount() { return this.spectators.filter((s) => s.joined).length; }
  totalCount() { return this.spectators.length; }

  // 推进时间 nowMs（对局内毫秒），按需产出消息
  tick(nowMs, ctx) {
    if (!this.enabled) return [];
    this.t = nowMs;
    this._lastCtx = ctx || null;
    const out = [];
    for (const s of this.spectators) {
      if (!s.joined) {
        if (nowMs >= s.joinAtMs) {
          s.joined = true;
          out.push(this._emit(s, 'join', rnd(BANK.join)));
        }
        continue;
      }
      // 性格发言频率 → 基础间隔
      const baseGap = 6000 + (1 - s.P.speak) * 9000;
      if (nowMs - s.lastSpeak < baseGap) continue;
      // 整体发言量受性格与现场热度影响
      const heat = (ctx && ctx.heat) || 0;
      const p = npc.speakProb(s.personaKey) * (0.35 + heat * 0.5);
      if (Math.random() > p) continue;
      const m = this._decide(s, ctx);
      if (m) { s.lastSpeak = nowMs; out.push(this._emit(s, m.kind, m.text)); }
    }
    return out;
  }

  _emit(s, kind, text) {
    const msg = { name: s.name, personaKey: s.personaKey, kind, text };
    try { this.onMessage(s.name, text, s.personaKey, kind, msg); } catch (e) {}
    return msg;
  }

  // 决定这名观众此刻说什么
  _decide(s, ctx) {
    ctx = ctx || {};
    // 处决刚揭示 → 强烈反应
    if (ctx.lastExecution) {
      const e = ctx.lastExecution;
      if (Math.random() < 0.6) {
        return { kind: e.isWolf ? 'reactWolf' : 'reactGood', text: rnd((e.isWolf ? BANK.reactWolf : BANK.reactGood))(e.no) };
      }
    }
    // 有人上台被投票 → 归票 / 狡辩 / 分析
    if (ctx.stagedNo != null) {
      const no = ctx.stagedNo;
      const r = Math.random();
      if (s.personaKey === 'leader' || s.personaKey === 'aggressive') {
        if (r < 0.7) return { kind: 'accuse', text: rnd(BANK.accuse)(no) };
      } else if (s.personaKey === 'contrarian') {
        if (r < 0.7) return { kind: 'defend', text: rnd(BANK.defend)(no) }; // 永远唱反调→保人
      } else if (s.personaKey === 'rational') {
        if (r < 0.5) return { kind: 'accuse', text: rnd(BANK.accuse)(no) };
      } else if (s.personaKey === 'follower') {
        if (r < 0.5) return { kind: 'accuse', text: rnd(BANK.accuse)(no) }; // 跟风向→随大流归票
      } else if (r < 0.3) {
        return { kind: 'defend', text: rnd(BANK.defend)(no) };
      }
    }
    // 关键字驱动：解说广播里点名某号是狼
    if (ctx.broadcast) {
      const m = ctx.broadcast.match(/(?:(\d{1,2})号.*狼|铁狼.*?(\d{1,2})号)/);
      if (m) {
        const no = Number(m[1] || m[2]);
        if (!isNaN(no) && Math.random() < 0.5) {
          return s.personaKey === 'contrarian'
            ? { kind: 'defend', text: rnd(BANK.defend)(no) }
            : { kind: 'accuse', text: rnd(BANK.accuse)(no) };
        }
      }
    }
    // 其余：闲聊 / 提问
    if (Math.random() < 0.18) return { kind: 'question', text: rnd(BANK.question) };
    return { kind: 'chatter', text: rnd(BANK.chatter) };
  }
}

module.exports = { AudienceManager, BANK, NAMES };
