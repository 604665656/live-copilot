'use strict';
// _director2.js — 弹幕狼人杀「导演 v2」总控
//
// v1 基础能力（保留）：双通道指挥（真人账号真实弹幕 + 机器人本机 API）、阶段状态机
// v2 新增：
//   ① 角色技能：花瓶妹(比赛女巫)投票复活死者(优先复活大人)、傲白大人投票刀人、
//      愤青(妈宝男)预设亡语目标、其余技能由游戏自动结算
//   ② NPC 性格：8 种人格，稳定分配到每个机器人；托管账号也有性格
//   ③ NPC 发言：气泡发言（狡辩/归票/分析/调侃/调戏），统一 2-3 秒延迟（弹幕游戏天然 latency）
//   ④ 投票摇摆：信念模型——发言真的会改变其他 NPC 的怀疑度和投票
//   ⑤ 关联弹幕回复：被观众点名(号码/姓名)会反击/调侃/调戏，同样 2-3 秒延迟
//   ⑦ NPC 换装：按性格穿衣服（脸/头/上衣/裤子/面具/道具），可重新随机
//   ⑧ 主播场外中立解说：不泄露身份、有故事性、随场面精彩度变化
//   ⑨ 主播换装：观众弹幕指令（主播换装/主播穿N）换主播衣服
//   ⑩ 福利托管：核酸/签到（每日碎片）、钓鱼（持续），账号轮流发
//
// 用法: node _director2.js [--dry] [--no-start]
const { gameSession } = require('./_game_cdp_lib');
const { loadAccounts } = require('./src/accounts');
const { sendDanmaku } = require('./src/bili');
const npc = require('./src/npc');
const { Commentator } = require('./src/commentator');
const CFG = require('./src/config').load(); // 统一配置中心（config.json，可人工改动）
const GAME_MODES = require('./src/config').GAME_MODES; // 地图/玩法模式表（助手 UI「地图切换」卡片同源）
// 行为开关默认值写进代码，避免 app 回写配置时丢掉 human 块（实测 app 重启会用内存旧配置覆盖 director.config.json）。
// autoNextGame 缺省开启（仅显式 false 才关）；真人接管 enabled 缺省关闭（需显式 true 才开）。
const AUTO_NEXT_GAME = !(CFG.human && CFG.human.autoNextGame === false);
const HUMAN_TAKEOVER = !!(CFG.human && CFG.human.enabled === true);
const HUMAN_RANDOM_SEAT = !(CFG.human && CFG.human.randomSeat === false);
try { console.log('[config] path=' + require('./src/config').configPath() + ' | audience.enabled=' + (CFG.livecast && CFG.livecast.audience && CFG.livecast.audience.enabled) + ' | evolve.enabled=' + (CFG.livecast && CFG.livecast.evolve && CFG.livecast.evolve.enabled) + ' | sendToRoom=' + (CFG.livecast && CFG.livecast.audience && CFG.livecast.audience.sendToRoom) + ' | autoNextGame(生效)=' + AUTO_NEXT_GAME + ' | humanTakeover(生效)=' + HUMAN_TAKEOVER + ' | randomSeat(生效)=' + HUMAN_RANDOM_SEAT); } catch (_) {}
const fs = require('fs');

const ROOM = Number(process.env.ROOM || CFG.room.roomId);
const DRY = process.argv.includes('--dry');
const NO_START = process.argv.includes('--no-start');
const STREAMER_UID = Number(process.env.STREAMER_UID || CFG.room.streamerUid); // 主播账号（参赛+场外解说+被点播换装）
const REACT_MIN = CFG.difficulty.npcReactMinMs, REACT_MAX = CFG.difficulty.npcReactMaxMs; // NPC 反应延迟窗口（模拟弹幕游戏 latency）

// ================= 地下城运行时层（RT / 知识库 / 自主决策）=================
// 设计：config.json 是持久配置（助手表单可改，重启生效）；RT 是本局运行时覆盖——
// 观众弹幕指令（策略/倍率/关卡/循环）与自主决策（autoTune/LLM）只改 RT，不写盘，
// 导演重启后回到 config 值。所有 gacha 参数读取都走下面的 gXxx() 访问器（RT 优先）。
const path = require('path');
let parentPort = null;
try { parentPort = require('worker_threads').parentPort; } catch (e) { /* 独立 node 运行时为 null */ }
const GC = CFG.gacha || {};
const RT = {
  buffMultiplier: 0,     // 0 = 用配置
  strategyMode: '',      // '' = 用配置（attack/balanced/resist/custom/auto）
  weights: null,         // {spd,atk,res,def} 覆盖
  preferPercent: null,   // true/false 覆盖
  startLv: 0,            // 0 = 用配置（预置值语义）
  endLv: 0,              // 0 = 用配置（实战关号语义）
  loopEnabled: null,     // null = 用配置
  healPct: 0,            // 0 = 用配置
  gameMode: '',          // '' = 用配置（弹幕「地图 X」实时切图，不写盘；重启回配置值）
  src: {},               // 参数 -> 来源（'弹幕:用户名' / 'autoTune' / 'llm'）
};
function gMult() { return Number(RT.buffMultiplier || GC.buffMultiplier || 999); }
function gHealPct() { const v = Number(RT.healPct || GC.healPct || 40); return Math.max(5, Math.min(95, v)); }
// 目标地图/玩法（优先级：弹幕「地图 X」实时覆盖 > 助手 UI「地图切换」卡片写的 config.gameMode > 默认 gacha）
// gacha=地下城 werewolf=弹幕狼人杀 rouge/chump/greatsword=其余玩法 auto=自动识别当前场景
// ball=抢球 frameball=抢球·跨房 draw=鼠王 dj=舞台 hd=航海探索 jz=打捞 pet=宠物 xiuxian=修仙（2026-10-24 补全，均无 autoDrive）
function gMode() {
  const m = String(RT.gameMode || CFG.gameMode || 'gacha');
  return (m === 'auto' || GAME_MODES[m]) ? m : 'gacha';
}
function gStartLv() { return Number(RT.startLv || GC.startLv || 0); }
function gEndLv() { return Number(RT.endLv || GC.endLv || 100); }
function gLoopOn() { return RT.loopEnabled === null ? !!(GC.loop && GC.loop.enabled) : !!RT.loopEnabled; }
function gMaxRounds() { return Math.max(0, Number((GC.loop && GC.loop.maxRounds) || 0)); }
function gThinkOn() { return !!(GC.think && GC.think.enabled); }
function gAutoTune() { return !!(GC.think && GC.think.autoTune); }
function gLlmCfg() { return (GC.think && GC.think.llm) || {}; }
// 选卡策略：mode → 分类权重 + 百分比优先（RT 覆盖优先）
// 分类（用户 2026-10-24 明确要求：属性攻击降权；优先 攻速 > 攻击 > 生命 > 防御）：
//   spd=攻速/暴击类  atk=纯攻击  hp=生命/血量  def=防御  ele=属性攻击(雷/火/魔/水…)  res=抗性
const STRATEGY_PRESETS = {
  attack:   { spd: 4, atk: 3, hp: 2, def: 1, ele: 0, res: 0 },   // 攻速>攻击>生命>防御；属性攻击/抗性降权（默认）
  balanced: { spd: 2, atk: 2, hp: 2, def: 2, ele: 1, res: 1 },   // 均衡
  resist:   { spd: 1, atk: 1, hp: 2, def: 2, ele: 1, res: 4 },   // 抗性/防御优先
};
function gStrategy() {
  const bs = GC.buffStrategy || {};
  let mode = RT.strategyMode || bs.mode || 'attack';
  // auto = 交给自主决策：采用知识库学到的策略（autoTune/LLM 写入 learned.strategy），没有则回退 attack
  if (mode === 'auto') {
    const learned = dkb.data && dkb.data.learned && dkb.data.learned.strategy;
    mode = (learned && STRATEGY_PRESETS[learned]) ? learned : 'attack';
  }
  let weights, preferPercent;
  if (mode === 'custom') weights = Object.assign({}, bs.weights || STRATEGY_PRESETS.attack);
  else weights = Object.assign({}, STRATEGY_PRESETS[mode] || STRATEGY_PRESETS.attack);
  if (RT.weights) weights = Object.assign({}, weights, RT.weights);
  preferPercent = RT.preferPercent === null || RT.preferPercent === undefined
    ? (bs.preferPercent !== false) : !!RT.preferPercent;
  return { mode: mode, weights: weights, preferPercent: preferPercent };
}

// ---------- 地下城知识库（跨局持久化：胜负/关卡统计/指令历史/学到的参数） ----------
const DUNGEON_KB_PATH = (GC.think && GC.think.kbPath)
  ? GC.think.kbPath
  : (process.env.USER_DATA_DIR ? path.join(process.env.USER_DATA_DIR, 'dungeon-knowledge.json')
       : path.join(__dirname, 'dungeon-knowledge.json'));
const dkb = {
  path: DUNGEON_KB_PATH,
  data: null,
  load() {
    const def = { version: 1, rounds: [], levelStats: {}, learned: { strategy: '', healPct: 0, note: '' }, commands: [], sentiment: { struggle: 0, cheer: 0 }, stats: { games: 0, wins: 0, loses: 0, totalLevels: 0, bestLv: 0 } };
    try {
      if (fs.existsSync(this.path)) {
        const raw = JSON.parse(fs.readFileSync(this.path, 'utf8').replace(/^\uFEFF/, ''));
        this.data = Object.assign(def, raw);
        this.data.stats = Object.assign(def.stats, raw.stats || {});
        this.data.learned = Object.assign(def.learned, raw.learned || {});
        this.data.sentiment = Object.assign(def.sentiment, raw.sentiment || {});
      } else this.data = def;
    } catch (e) { this.data = def; }
    return this.data;
  },
  save() {
    try {
      const d = this.data;
      if (!d) return;
      d.rounds = (d.rounds || []).slice(-50);
      d.commands = (d.commands || []).slice(-100);
      fs.writeFileSync(this.path, JSON.stringify(d, null, 2), 'utf8');
    } catch (e) { /* 磁盘异常不致命 */ }
  },
};
dkb.load();

// ---------- 本局追踪（供自主决策/状态上报） ----------
const dg = {
  gameStartAt: 0, maxLvThisGame: 0, healsThisGame: 0, rezesThisGame: 0,
  struggle: 0, cheer: 0, lastCmd: '', lastCmdBy: '',
  loopRounds: 0, endRecorded: false, lastLlmAt: 0, lastLlmLv: 0,
  statusAt: 0,
};
function postDungeon(extra) {
  if (!parentPort) return;
  const nowMs = Date.now();
  if (!(extra && extra.force) && nowMs - dg.statusAt < 800) return;   // 节流：UI 不需要 1.5s 级刷新
  dg.statusAt = nowMs;
  try {
    const st = gStrategy();
    parentPort.postMessage({ ch: 'dungeon', data: Object.assign({
      lv: dungeonLv, phase: dgPhase || 'unknown',
      strategy: st.mode, mult: gMult(), healPct: gHealPct(),
      loop: gLoopOn(), endLv: gEndLv(), startLv: gStartLv(), rounds: dg.loopRounds,
      sentiment: { struggle: dg.struggle, cheer: dg.cheer },
      lastCmd: dg.lastCmd, lastCmdBy: dg.lastCmdBy,
      mode: gMode(), modeName: (GAME_MODES[gMode()] ? GAME_MODES[gMode()].name : '自动识别'), sceneReady: modeSceneReady,
      kb: dkb.data ? { games: dkb.data.stats.games, wins: dkb.data.stats.wins, loses: dkb.data.stats.loses, bestLv: dkb.data.stats.bestLv } : null,
    }, extra || {}) });
  } catch (e) { /* ignore */ }
}
let dgPhase = 'unknown';

// epoch 令牌（多导演实例互斥） ----------
// 主进程每次启动导演写入新 epoch 到文件；本实例每 2s 校验，若文件被更新（新实例已启动）则主动退出，避免旧 Worker 残留抢戏/重复弹幕。
const DIRECTOR_EPOCH = process.env.DIRECTOR_EPOCH || '';
const EPOCH_FILE = process.env.DIRECTOR_EPOCH_FILE || '';
let _lastEpochCheck = 0;
async function checkEpoch() {
  if (!DIRECTOR_EPOCH || !EPOCH_FILE) return;
  const now = Date.now();
  if (now - _lastEpochCheck < 2000) return;
  _lastEpochCheck = now;
  try {
    const cur = fs.readFileSync(EPOCH_FILE, 'utf8').trim();
    if (cur && cur !== DIRECTOR_EPOCH) {
      log('  🔄 检测到更新的导演实例(epoch=' + cur + ')，本实例退出让位');
      process.exit(0);
    }
  } catch (e) {}
}
const LOG = fs.createWriteStream(process.env.WOLF_LOG || 'director2.log', { flags: 'a' });
function log(...a) { const s = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + a.join(' '); console.log(s); LOG.write(s + '\n'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

const ROLE = { 0: '老鼠', 1: '平民', 2: '女鬼', 3: '双面鬼', 4: '混血', 5: '流浪汉', 6: '鬼格格', 7: '花瓶妹', 8: '舔狗', 9: '妈宝男', 10: '狐狼', 11: '孤魂', 12: '狸猫', 13: '单眼鬼', 14: '蛊狼', 15: '酒鬼', 16: '狂人', 17: '武林高手', 18: '九尾妖狐', 19: '鳌大人', 20: '病原狼', 21: '比赛狮王', 22: '比赛狸猫', 23: '比赛女巫' };
const CAMP = { 1: '好人', 2: '狼人' };
// 角色判定：按游戏真实 roleName 匹配，规避 roleType 编号错位（实测：roleType 7=花瓶妹、5=流浪汉、19=鳌大人、2=女鬼…；探针见 live-copilot/_probe_rolenames.js）
const isSeer = (p) => /预言/.test(p.roleName || '');              // 预言家（查验）
const isVase = (p) => /花瓶/.test(p.roleName || '');              // 花瓶妹（投票复活）
const isAdult = (p) => /鳌|傲白/.test(p.roleName || '');           // 鳌大人 / 傲白大人（投票刀人）
const isMomTreasure = (p) => /妈宝|愤青/.test(p.roleName || '');   // 妈宝男（亡语预设）；游戏可能标「妈宝男」或「愤青」，两者都认
const LETTER = Object.assign({ 0: '大厅' }, CFG.commands.hideLetters); // 躲门字母（config 可改）
const VOTE_KILL = CFG.commands.voteKill, VOTE_SAVE = CFG.commands.voteSave; // 投票指令（config 可改）
// 托管账号性格（真人账号也按人设发言）——5 个账号全部参赛，含主播号
const ACCOUNT_PERSONA = { '298813': 'leader', '1542633399': 'aggressive', '98679142': 'rational', '3546882420771732': 'emotional', '1207903548': 'cautious' };

// ---------- 账号 ----------
const { usable } = loadAccounts();
const STREAMER = usable.find(a => Number(a.uid) === STREAMER_UID) || usable[0];
const PLAYING = usable; // 5 个账号全部上场参赛（主播号也报名，同时用她发场外解说）
const MY = new Map(); // uid(string) -> 账号
PLAYING.forEach(a => MY.set(String(a.uid), a));
log('=== 导演 v2 启动 ===');
log(`  参赛账号 ${PLAYING.length} 个（全部上场）: ${PLAYING.map(a => { const k = ACCOUNT_PERSONA[String(a.uid)] || 'aggressive'; return `${a.uname}[${npc.PERSONALITIES[k].name}]`; }).join(' / ')}`);
log(`  解说/点播换装账号: ${STREAMER.uname} (uid=${STREAMER.uid})（参赛中，解说弹幕不会被误解析为指令：游戏用 Number(info) 整串判断）`);

// ---------- 页面助手 ----------
const HELPERS = `(function(){
  window.__D = {
    mgr: function(){ return window.__require('LiveWolfMgr').default; },
    ctl: function(){
      var c = null;
      (function walk(n){ if(!n||c) return; var k=n.getComponent('LiveWolfCtl'); if(k){c=k;return;} (n.children||[]).forEach(walk); })(cc.director.getScene());
      return c;
    },
    actions: function(){ return window.__require('LiveWolfActions').default; },
    watch: function(){ return window.__require('LiveWolfWatchInfo').LiveWolfWatchInfo; }
  };
  // 弹幕监听钩子：所有真实弹幕进环形缓冲（注意 com 必须带 node，否则监听器会被删）
  if (!window.__DMHOOK) {
    window.__DMDATA = [];
    var CE = window.__require('ClientEventMgr').default;
    CE.on('liveBaseData', function(d){
      try {
        window.__DMDATA.push({u:String(d.uid), n:String(d.name||''), i:String(d.info||''), t:Date.now()});
        if (window.__DMDATA.length > 300) window.__DMDATA.splice(0, window.__DMDATA.length - 300);
      } catch(e) {}
    }, {node:{}});
    window.__DMHOOK = true;
  }
  return 'ok';
})()`;

(async () => {
  let g = await gameSession({ create: false });
  if (!g) { log('连不上游戏页签（Edge 9222）'); process.exit(1); }
  await E(HELPERS);
  // 带超时(20s) + 断线重连的页面执行——防主循环假死
  async function E(expr, awaitPromise) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await Promise.race([
          g.ev(expr, awaitPromise),
          new Promise((_, rej) => setTimeout(() => rej(new Error('页面执行超时')), 20000)),
        ]);
      } catch (e) {
        log(`  ⚠️ 页面执行失败(${e.message})，重连中…(${attempt + 1}/3)`);
        try { g.cdp.close(); } catch (e2) {}
        g = null;
        await sleep(1500);
        g = await gameSession({ create: false });
        if (!g) { await sleep(2000); continue; }
        g.ev(HELPERS).catch(() => {});
      }
    }
    throw new Error('页面执行连续失败');
  }

  // ---------- 状态读取 ----------
  async function readState() {
    const r = await E(`(function(){
      var m = window.__D.mgr();
      // buffs 里可能混入带节点引用的对象（CCClass 循环引用），统一降级成数字
      function safeBuffs(p){
        try {
          if (!p.role || !p.role.buffs) return [];
          return Array.from(p.role.buffs).map(function(b){
            if (b && typeof b === 'object') return b.buffType || b.type || b.id || b.roleType || 1;
            return Number(b) || 0;
          });
        } catch(e){ return []; }
      }
      var ps = [];
      m.players.forEach(function(p,uid){
        ps.push({uid:String(uid), no:p.no, name:p.name||'', robot:!!p.isRobot, die:!!p.isDie,
                 camp:p.role?p.role.campType:0, role:p.role?p.role.roleType:0, roleName:p.roleName||(p.role&&p.role.roleName)||'',
                 power:!!(p.role&&p.role.isNomalSuperPower), epower:!!(p.role&&p.role.isEventSuperPower),
                 selTar:p.role&&p.role.selectTar?String(p.role.selectTar):'',
                 buffs:safeBuffs(p),
                 mouseVue:p.role?p.role.mouseVue:0, place:p.role?p.role.placeType:-1});
      });
      var dp = [];
      m.diePlayers.forEach(function(p,uid){
        dp.push({uid:String(uid), no:p.no, name:p.name||'', camp:p.role?p.role.campType:0, role:p.role?p.role.roleType:0, roleName:p.roleName||(p.role&&p.role.roleName)||'',
                 place:p.role?p.role.placeType:-1, dieNight:p.role?p.role.dieNight:0});
      });
      var places = (m.places||[]).map(function(s){ return Array.from(s); });
      var sel = {};
      m.selectPlayer.forEach(function(v,k){ sel[k] = Array.from(v); });
      var nightInfo = '';
      try { var c = window.__D.ctl(); if (c && c.comLiveWolfNight && c.comLiveWolfNight.lab_night_info) nightInfo = c.comLiveWolfNight.lab_night_info.string || ''; } catch(e){}
      function slimNight(nd){ if(!nd) return null; var keysOf=function(v){ if(!v) return []; if(typeof v==='object'){ if(typeof v.keys==='function'&&typeof v.forEach==='function') return Array.from(v.keys()); return Object.keys(v); } return []; }; return {id_nosale:nd.id_nosale?String(nd.id_nosale):'',id_sale:nd.id_sale?String(nd.id_sale):'',count_nosalf_mouse:nd.count_nosalf_mouse||0,count_witch:nd.count_witch||0,count_ninefox_awake:nd.count_ninefox_awake||0,count_sale_wolf:nd.count_sale_wolf||0,hall_killed:keysOf(nd.hall_killed),rooms_killed:keysOf(nd.rooms_killed),id_virus_start:nd.id_virus_start?String(nd.id_virus_start):'',id_virus_end:nd.id_virus_end?String(nd.id_virus_end):''}; }
      return JSON.stringify({state:m.state, night:m.curNightNum, players:ps, dead:dp, places:places,
        votePlayerId:m.votePlayerId?String(m.votePlayerId):'', kill:Array.from(m.voteKillIds), life:Array.from(m.voteLifeIds),
        sel:sel, model:m.model, nightInfo:nightInfo, maxPlayer:m.maxPlayerCount, nightData: slimNight(m.nightData),
        stateEndTime:m.stateEndTime||0});
    })()`);
    return JSON.parse(r);
  }

  // ---------- 弹幕队列（防 10030 限流） ----------
  // B站直播间弹幕限流：同 IP 多账号 burst 发送会触发 10030「频率过快」。
  // 全局串行队列：任意两条弹幕间隔 >= DM_GAP；单账号额外间隔 >= DM_ACC_GAP；
  // 命中 10030 后该账号退避 DM_BACKOFF（非紧急消息跳过，紧急消息等待）。
  const DM_GAP = 3200, DM_ACC_GAP = 9000, DM_BACKOFF = 22000;
  const dmLastAt = new Map();   // uid -> 上次发送成功时间
  const dmBanUntil = new Map(); // uid -> 退避截止时间
  let dmChain = Promise.resolve();
  let dmGlobalLast = 0;
  // ---------- 弹幕队列抢占（投票不能堵在聊天弹幕后面） ----------
  // 事故：投票窗最短仅 11s（无真人观众时游戏提前收窗），账号投票整段堵在 15+ 条聊天弹幕队列里 13s+，全部错过窗口。
  // 机制：urgent（投票/选人/选门/报名）弹幕入队时 dmEpoch++；队列中尚未轮到的非 urgent 弹幕，
  // 开跑前发现代号已变 → keep=true（发言/解说）让位到队尾重排一次，keep=false（钓鱼/filler）直接跳过。
  // 注意：抢占只丢/延后低优弹幕，不改变实际发送速率（DM_GAP 不变），10030 风险不变。
  let dmEpoch = 0;
  function dmPreempt() { dmEpoch++; }
  async function dm(acc, text, urgent, keep) {
    if (DRY) { log(`  [DRY] ${acc.uname} -> 「${text}」`); return { ok: true }; }
    const uid = String(acc.uid);
    const banUntil = dmBanUntil.get(uid) || 0;
    if (Date.now() < banUntil) {
      if (!urgent) { log(`  ⏭️ ${acc.uname} 限流退避中，跳过「${text}」`); return { ok: false, code: 10030, skipped: true }; }
      await sleep(banUntil - Date.now() + 500);
    }
    if (urgent) dmPreempt(); // 高优弹幕入队即抢占：把队列里积压的低优弹幕标记为可让位
    const myEpoch = dmEpoch;
    const run = dmChain.then(async () => {
      if (!urgent && dmEpoch !== myEpoch) {
        if (keep) {
          // 让位到队尾重排一次（重排时 keep=false，最多一次，防无限重排）：解说/发言不丢，只是晚点发。
          // 必须 fire-and-forget：若 return dm(...) 让本任务等队尾消息，会与后续任务形成循环等待，整条链冻结。
          log(`  ⏠ ${acc.uname} 「${text}」 被高优弹幕抢占，让位重排`);
          dm(acc, text, urgent, false).catch(() => {});
          return { ok: false, code: -8, rescheduled: true };
        }
        log(`  ⏭️ ${acc.uname} 「${text}」 被高优弹幕抢占，跳过`);
        return { ok: false, code: -9, skipped: true };
      }
      const waitG = Math.max(0, DM_GAP - (Date.now() - dmGlobalLast));
      if (waitG) await sleep(waitG);
      const last = dmLastAt.get(uid) || 0;
      const waitA = Math.max(0, DM_ACC_GAP - (Date.now() - last));
      if (waitA) await sleep(waitA);
      dmGlobalLast = Date.now();
      dmLastAt.set(uid, Date.now());
      const r = await Promise.race([
        sendDanmaku({ cookie: acc.cookie, roomId: ROOM, text, biliJct: acc.keys.bili_jct, uid: acc.uid }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('弹幕发送超时')), 15000)),
      ]).catch(e => ({ ok: false, code: -3, message: e.message }));
      if (!r.ok && (r.code === 10030 || /频率/.test(r.message || ''))) {
        dmBanUntil.set(uid, Date.now() + DM_BACKOFF);
        log(`  🚫 ${acc.uname} 被限流(10030)，退避 ${DM_BACKOFF / 1000}s`);
      }
      log(`  💬 ${acc.uname}(uid=${acc.uid}) -> 「${text}」 ${r.ok ? '✅' : '❌ ' + r.code + ' ' + r.message}`);
      return r;
    });
    dmChain = run.then(() => {}, () => {});
    return run;
  }
  // 气泡发言（机器人用 uid 字符串， watcher/真人用数字 uid）
  async function speak(uid, name, text) {
    if (DRY) { log(`  [DRY] 气泡 ${name}: 「${text}」`); return; }
    try {
      await E(`(function(){
        var ctl = window.__D.ctl(); if(!ctl) return 'no-ctl';
        var m = window.__D.mgr();
        m.talkById(ctl, {uid:${JSON.stringify(uid)}, name:${JSON.stringify(name)}}, ${JSON.stringify(text)});
        return 'ok';
      })()`);
    } catch (e) { log('  气泡失败: ' + e.message); }
  }
  // 机器人本地动作（批量）
  async function robotAct(cmds, tag) {
    if (!cmds.length) return [];
    if (DRY) { log(`  [DRY] 机器人 ${cmds.length} 个动作: ${cmds.map(c => c.uid + ':' + c.action + ':' + c.arg).join(' ')}`); return []; }
    try {
      const r = await E(`(function(){
        var ctl = window.__D.ctl(); if(!ctl) return 'no-ctl';
        var A = window.__D.actions();
        var cmds = ${JSON.stringify(cmds)};
        var done = [];
        cmds.forEach(function(c){
          try {
            if (c.action==='hide') A.Hide(ctl, {uid:c.uid, info:c.arg});
            else if (c.action==='sel') A.SelectPlayer(ctl, {uid:c.uid, info:String(c.arg)});
            else if (c.action==='vote') A.VotePlayer(ctl, {uid:c.uid, info:c.arg});
            else if (c.action==='talk') window.__D.mgr().talkById(ctl, {uid:c.uid, name:c.name}, c.arg);
            else if (c.action==='skin') { var m=window.__D.mgr(); var p=m.players.get(c.uid); if(p&&p.skin) p.skin.setSkinByItems(c.arg); done.push(c.uid+':'+(p&&p.skin?p.skin.suitId:'ERR')); return; }
            else if (c.action==='suit') {
              var m=window.__D.mgr(); var p=m.players.get(c.uid);
              if(p&&p.skin){
                try { p.skin.setSkinOrSoulBySuitId(c.grade, c.suitId); } catch(e){}
                if (p.skin.suitId !== c.suitId && c.fallback) p.skin.setSkinByItems(c.fallback); // 套装没吃上→免费池兜底
                done.push(c.uid+':'+p.skin.suitId);
              } else done.push(c.uid+':ERR');
              return;
            }
            done.push(c.uid);
          } catch(e){ done.push(c.uid+':ERR'); }
        });
        return done.join(',');
      })()`);
      if (r === 'no-ctl') { log('  ⚠️ 机器人动作失败: no-ctl'); return []; }
      log(`  🤖 机器人 ${tag} ${cmds.length} 个动作完成`);
      return String(r).split(',');
    } catch (e) { log('  机器人动作失败: ' + e.message); return []; }
  }
  // 换 NPC 衣服（付费套装优先，失败自动回退免费池）
  async function dressNPC(uid, reshuffle) {
    const suit = npc.paidOutfitFor(uid, reshuffle);
    const res = await robotAct([{ uid: String(uid), action: 'suit', grade: suit.grade, suitId: suit.suitId, fallback: npc.outfitFor(uid) }], `换装(${suit.name})`);
    const ok = res.some(x => x === String(uid) + ':' + suit.suitId);
    if (!ok) log(`  ⚠️ ${uid} 套装 ${suit.name} 未生效，已回退免费池`);
    return suit;
  }

  // ---------- 主播（场外） ----------
  let streamerWatcher = false;
  let outfitIdx = 0;
  // 主播账号处理：参赛时无需观众席（报名即进场，m.players 里找她）；
  // 仅当主播号不参赛（STREAMER_UID 指向非 PLAYING 账号）时才加 watcher
  async function ensureStreamer() {
    if (DRY) return;
    if (MY.has(String(STREAMER.uid))) { streamerWatcher = false; return; }
    try {
      const r = await E(`(function(){
        var m = window.__D.mgr();
        if (m.watchers.has(${STREAMER.uid})) return 'has';
        var ctl = window.__D.ctl(); if(!ctl) return 'no-ctl';
        window.__D.watch().addWatcher(ctl, {uid:${STREAMER.uid}, name:${JSON.stringify(STREAMER.uname)}});
        return m.watchers.has(${STREAMER.uid}) ? 'added' : 'fail';
      })()`);
      if (r === 'has' || r === 'added') streamerWatcher = true;
      if (r === 'added') log(`  🎙️ 主播 ${STREAMER.uname} 已进场（观众席，不参赛）`);
    } catch (e) { log('  主播进场失败: ' + e.message); }
  }
  async function streamerOutfit(idx, viewerName) {
    if (DRY) { log(`  [DRY] 主播换装 #${idx}`); return; }
    const n = npc.STREAMER_SUITS.length;
    const suit = npc.STREAMER_SUITS[((idx % n) + n) % n];
    try {
      await E(`(function(){
        var m = window.__D.mgr();
        var w = m.players.get(${STREAMER.uid}) || m.watchers.get(${STREAMER.uid}); // 参赛时在 players，观众席在 watchers
        if (!w || !w.skin) return 'no-skin';
        try { w.skin.setSkinOrSoulBySuitId(${suit.grade}, ${suit.suitId}); } catch(e){}
        if (w.skin.suitId !== ${suit.suitId}) w.skin.setSkinByItems(${JSON.stringify(npc.outfitFor('zb' + idx))}); // 兜底免费池
        return 'ok:' + w.skin.suitId;
      })()`);
      const line = rnd([`谢谢${viewerName}的点播，新衣服好看吗`, `换装完成！${viewerName} 的眼光绝了`, `来了来了，这套${viewerName} 觉得还行吗`, `${viewerName} 点的这套${suit.name}，我营业了`]);
      await speak(STREAMER.uid, STREAMER.uname, line);
      log(`  👔 主播换装 #${((idx % n) + n) % n}「${suit.name}」（${viewerName} 点播）`);
    } catch (e) { log('  主播换装失败: ' + e.message); }
  }
  // 主播发真实弹幕（公屏解说）
  async function say(text) {
    if (!text) return;
    await dm(STREAMER, text, false, true); // keep=true：被投票等高优弹幕抢占时让位重排，不丢弃
  }

  // ---------- 直播增强子系统（场外围观观众 / 自主进化 / 换装播报）----------
  // 全部由 config.livecast.* 开关控制，默认关闭 → 完全不改变既有导演行为。
  // 任何出错都被 try/catch 吞掉，绝不影响主循环。需要在 config.json 里把对应 enabled 打开才生效。
  const livecast = (() => {
    const lc = CFG.livecast || {};
    const aCfg = lc.audience || {};
    const eCfg = lc.evolve || {};
    const on = !!aCfg.enabled || !!eCfg.enabled;
    let audience = null, evolve = null, roundAudience = [];
    function ensure() {
      if (!on) return;
      try {
        if (aCfg.enabled && !audience) {
          const { AudienceManager } = require('./src/audience');
          audience = new AudienceManager({
            enabled: true,
            target: aCfg.target || 14,
            joinWindowMs: aCfg.joinWindowMs || 30000,
            onMessage: (name, text, personaKey, kind) => log(`   [观众·${personaKey}] ${name}: ${text}`),
          });
          audience.spawn();
          log(`  🎬 livecast: 场外围观观众就位（${audience.totalCount()} 人，将在 ${aCfg.joinWindowMs || 30000}ms 内陆续进场）`);
        }
        if (eCfg.enabled && !evolve) {
          const { EvolutionEngine } = require('./src/evolve');
          evolve = new EvolutionEngine({ enabled: true });
          log(`  🧠 livecast: 自主进化引擎已加载（历史对局 ${evolve.kb.stats.rounds} 局 → ${evolve.path}）`);
        }
      } catch (e) { log('  ⚠️ livecast 模块加载失败（已忽略，不影响主循环）: ' + e.message); }
    }
    let lastTick = 0;
    async function tick(ctx) {
      if (!aCfg.enabled) return;
      try {
        ensure();
        if (!audience) return;
        const now = Date.now();
        const gap = aCfg.tickGapMs || 2500;
        if (now - lastTick < gap) return;
        lastTick = now;
        const msgs = audience.tick(now, ctx || {});
        for (const m of msgs) {
          if (m && m.kind) roundAudience.push({ kind: m.kind, personaKey: m.personaKey });
          if (aCfg.sendToRoom && STREAMER) { try { await dm(STREAMER, '【观众·' + (m.name || '观众') + '】' + m.text, false); } catch (e) {} }
          else log(`   [观众弹幕·${m.kind}] ${m.name}: ${m.text}`);
        }
      } catch (e) { log('  ⚠️ livecast.tick 出错（已忽略）: ' + e.message); }
    }
    async function recordRound(round) {
      if (!eCfg.enabled || !round) return;
      try {
        ensure();
        if (!evolve) return;
        round.audience = roundAudience.slice();
        evolve.recordRound(round);
        roundAudience = [];
        const s = evolve.summary();
        log(`  🧬 livecast: 记录本局 → 累计对局${s.rounds} 好胜${s.goodWin}/狼胜${s.wolfWin} 技能${s.skillsUsed} 观众${s.audienceMsgs}`);
      } catch (e) { log('  ⚠️ livecast.recordRound 出错（已忽略）: ' + e.message); }
    }
    function announceCostume(no, name, suit) {
      if (!aCfg.enabled) return;
      try { ensure(); log(`   [换装播报] 🎽 ${no}号${name} 换上了「${suit}」`); } catch (e) {}
    }
    return { on: () => on, tick, recordRound, announceCostume };
  })();
  if (livecast.on()) log('  🔌 livecast 子系统已挂载（audience/evolve 将按需懒加载）');

  // ---------- 信念模型 ----------
  const minds = new Map(); // uid -> Mind（好人视角）
  function mindOf(p) {
    if (!minds.has(p.uid)) {
      const m = new npc.Mind(p.uid);
      minds.set(p.uid, m);
    }
    return minds.get(p.uid);
  }
  // 让一群人听一段发言（belief 摇摆核心）
  function broadcastSpeech(speaker, type, targetPid, strength) {
    const sp = { speaker, type, target: targetPid, strength };
    minds.forEach((m, uid) => {
      if (uid === speaker) return;
      const P = npc.PERSONALITIES[m.persona];
      m.hear(sp, npc.influenceOf(uid));
    });
  }

  // ---------- 发言调度（统一 2-3 秒延迟） ----------
  const react = () => REACT_MIN + Math.random() * (REACT_MAX - REACT_MIN);
  // 公开票型最高的玩家（跟票对象）——selectPlayer 的 key 可能是 uid 也可能是号码
  function topSelTarget(st) {
    let best = null, bestN = 0;
    Object.entries(st.sel || {}).forEach(([k, voters]) => {
      const n = Array.isArray(voters) ? voters.length : (voters && voters.size) || 0;
      if (n <= bestN) return;
      const p = st.players.find(x => x.uid === String(k)) || st.players.find(x => String(x.no) === String(k));
      if (p && !p.die) { best = p; bestN = n; }
    });
    return bestN >= 2 ? best : null;
  }
  // 生成一条 NPC 台词（按性格+局势）
  function npcLine(p, st, kind) {
    const me = p.no;
    const alive = st.players.filter(x => !x.die);
    const wolves = alive.filter(x => x.camp === 2);
    const goods = alive.filter(x => x.camp === 1);
    const persona = npc.personalityOf(p.uid);
    if (kind === 'defend') {
      const accuser = alive.find(x => x.uid !== p.uid) || { no: '?' };
      return npc.defend(me, accuser.no);
    }
    if (kind === 'analyze' && alive.length > 3) {
      const a = rnd(alive).no, b = rnd(alive).no;
      if (a !== b) return npc.analyze(me, a, b);
    }
    if (p.camp === 2) {
      // 狼：构陷好人（冲票叙事）
      const tgt = goods.filter(x => !MY.has(x.uid)).length ? rnd(goods.filter(x => !MY.has(x.uid))) : rnd(goods);
      return tgt ? npc.frameGood(me, tgt.no) : npc.banter(me, rnd(alive).no);
    }
    // 好人：优先跟票公开票型最高的狼（真实玩家会跟票），否则随机指控已知狼
    if (wolves.length) {
      const top = topSelTarget(st);
      if (top && top.camp === 2 && Math.random() < CFG.difficulty.accuseWolfRate) return npc.accuseWolf(me, top.no);
      return npc.accuseWolf(me, rnd(wolves).no);
    }
    return npc.banter(me, rnd(alive).no);
  }
  // （抢沙发玩法已按需求移除）

  // ---------- 弹幕监听 + 关联回复 ----------
  let lastDmIdx = 0;
  let lastReplyAt = 0, lastReplyByUid = {};
  let lastOutfitAt = 0; // 主播换装点播限流
  const CMD_RE = /^(报名|[ABCDabcd]|大厅|\d{1,3}|444|666|雀食|离谱|换位置|咸鱼翻身|锁定.*|兑换.*|更换.*|签到|核酸|钓鱼.*|查询.*|献祭|诅咒|觉醒|舰长|检查部件|变大|变小|变色|滤镜|预订|赠礼|领取|进阶)$/;
  async function pollDanmaku(st) {
    let data = [];
    try { data = await E('JSON.stringify(window.__DMDATA||[])'); data = JSON.parse(data); } catch (e) { return; }
    if (!Array.isArray(data)) return;
    // 清理已处理的（页面侧不清，按时间戳去重）
    const now = Date.now();
    const fresh = data.filter(d => d.t > loopStart - 500 && now - d.t < 60000);
    for (const d of fresh) {
      if (MY.has(d.u) || Number(d.u) === Number(STREAMER.uid)) continue; // 忽略自己人
      const txt = (d.i || '').trim();
      // 真人接管报名（HUMAN_TAKEOVER 开启时）：识别真人「报名 [号数]」→ 接管指定存活座位或随机NPC座位
      if (HUMAN_TAKEOVER) {
        const joinM = /^报名\s*([1-9]\d?)?\s*号?\s*$/.exec(txt);
        if (joinM) { await handleHumanJoin(d, joinM[1] ? Number(joinM[1]) : null, st); continue; }
      }
      // 主播换装点播（观众指令，优先于指令过滤）
      if (/^主播(换装|换衣服|换套?衣服?)$/.test(txt)) {
        if (streamerWatcher && now - lastOutfitAt > 15000) {
          lastOutfitAt = now;
          await sleep(react());
          await streamerOutfit(outfitIdx++, d.n);
        }
        continue;
      }
      const mWear = /^主播穿\s*(\d{1,2})$/.exec(txt);
      if (mWear) {
        if (streamerWatcher && now - lastOutfitAt > 15000) {
          lastOutfitAt = now;
          await sleep(react());
          await streamerOutfit(Number(mWear[1]) - 1, d.n);
        }
        continue;
      }
      if (!txt || CMD_RE.test(txt)) continue;                           // 忽略指令弹幕
      // 主播喊话 → 解说员偶尔回应
      if (/主播/.test(d.i) && Math.random() < 0.3 && now - lastReplyAt > 8000) {
        lastReplyAt = now;
        await sleep(react());
        await say(rnd([`感谢${d.n}老板围观，解说正在状态`, `${d.n} 说得对，但我中立（狗头）`, `收到${d.n}的呐喊，继续看戏`]));
        continue;
      }
      // 匹配被点名的 NPC
      const hit = matchNPC(d.i, st);
      if (!hit) continue;
      if (Math.random() > 0.4) continue;                                 // 不是每条都回
      if (now - lastReplyAt < 2500) continue;                            // 全局限流
      if (now - (lastReplyByUid[hit.uid] || 0) < 12000) continue;        // 单 NPC 限流
      lastReplyAt = now; lastReplyByUid[hit.uid] = now;
      await sleep(react());                                              // 2-3 秒延迟
      const bad = /狼|刀|投|出|杀|飞|票/.test(d.i);
      const love = /好|爱|美|帅|喜欢|老婆|老公|宝贝/.test(d.i);
      let line;
      if (bad) line = npc.retort(hit.no, d.n);
      else if (love) line = npc.flirt(hit.no, d.n);
      else line = Math.random() < 0.5 ? npc.banter(hit.no, d.n) : npc.ack(hit.no, d.n);
      await speak(hit.uid, hit.name, line);
      log(`  💥 ${hit.no}号${hit.name} 回复 ${d.n}: 「${line}」`);
    }
    // 清空页面缓冲（已读完）
    try { await E('window.__DMDATA.length = 0'); } catch (e) {}
  }
  function matchNPC(info, st) {
    // 号码点名: 3号 / 三号
    const m = info.match(/(?:^|[^\d])(\d{1,2})号/);
    if (m) {
      const no = Number(m[1]);
      const p = st.players.find(x => x.no === no && !x.die && !humanSeats.has(x.no)); // 已真人接管的座位不替其发言
      if (p) return p;
    }
    // 姓名点名
    let best = null;
    st.players.forEach(p => {
      if (p.die || p.name.length < 2 || humanSeats.has(p.no)) return; // 已真人接管的座位不替其发言
      if (info.includes(p.name)) best = p;
    });
    return best;
  }

  // 真人接管：识别真人「报名 [号数]」→ 接管一个在场存活座位（指定号数 / 或随机NPC）
  // 说明：真人实际进场仍由游戏自身处理（游戏读取「报名」弹幕放行真人），导演只做「接管登记 + 弹幕欢迎 +
  // 在 matchNPC 中排除该座位（不再替真人发言）」。全部由 HUMAN_TAKEOVER 门控，默认关闭。
  async function handleHumanJoin(d, requestedNo, st) {
    const name = d.n || ('观众' + d.u);
    const uid = String(d.u);
    // 真人实际座位（若游戏已让其报名进场：uid 不在 MY、非主播、非 robot，会在 players 里）
    const actual = st.players.find(p => String(p.uid) === uid && !p.die);
    let seat = null;
    if (requestedNo != null) seat = st.players.find(p => p.no === requestedNo && !p.die); // 指定号数：接管该存活座位
    if (!seat) seat = actual;                                                             // 未指定号：用真人实际座位
    if (!seat && HUMAN_RANDOM_SEAT) {                                                     // 仍无：随机一个存活NPC座位
      const aliveNPC = st.players.filter(p => !p.die && p.robot);
      if (aliveNPC.length) seat = rnd(aliveNPC);
    }
    if (!seat) {
      log(`  🧑 真人 ${name} 报名：未找到可接管座位（指定号=${requestedNo}, randomSeat=${HUMAN_RANDOM_SEAT}），忽略`);
      return;
    }
    if (humanSeats.has(seat.no)) {
      log(`  🧑 真人 ${name} 报名：座位 ${seat.no} 已被 ${humanSeats.get(seat.no).name} 接管，忽略`);
      return;
    }
    humanSeats.set(seat.no, { uid: seat.uid, name, claimedAt: Date.now(), requested: requestedNo });
    log(`  🧑 真人接管：${name} → ${seat.no}号（${seat.name}）${seat.robot ? '（原NPC座位）' : ''}；当前真人座位: ` + [...humanSeats.keys()].sort((a, b) => a - b).join(', '));
    try { await say(`欢迎 ${name} 接管 ${seat.no}号，本局真人上场！弹幕扣1为TA应援～`); } catch (_) {}
  }

  // ---------- 福利调度 ----------
  const welfare = { hesuan: {}, fish: {} };
  async function welfareTick() {
    if (!started) return;   // 防御：未真正开战前绝不向直播间空发福利弹幕（避免空 lobby / 未连接时刷屏）
    const now = Date.now();
    for (const acc of PLAYING) {
      const u = String(acc.uid);
      // 核酸/签到：每 2 小时试一次（服务器 24h 冷却，重复发只会提示明日更新）
      if (now - (welfare.hesuan[u] || 0) > 2 * 3600e3) {
        welfare.hesuan[u] = now;
        await dm(acc, CFG.script.welfare[0] || '核酸');
        await sleep(1500);
      }
      // 钓鱼：每 4 分钟一次
      if (now - (welfare.fish[u] || 0) > 4 * 60e3) {
        welfare.fish[u] = now;
        await dm(acc, CFG.script.fish || '钓鱼');
        await sleep(1500);
      }
    }
  }

  // ---------- 阶段处理 ----------
  let gen = 0;          // 阶段代号，切换时旧任务全部作废
  let myGen = 0;
  let started = false;
  const done = new Set();
  const humanSeats = new Map(); // 真人接管：座位号(no) -> {uid,name,claimedAt,requested}（本局有效，新局清空）
  const commentator = new Commentator();
  let lastKill = 0, lastLife = 0, lastTop = '';
  let lastDeadCount = 0;

  // 找按钮并点击
  async function clickBtn(labelRe) {
    const name = await E(`(function(){
      var hit=null;
      (function walk(n){ if(!n||hit) return;
        var B=n.getComponent&&n.getComponent(cc.Button);
        if (B && n.active) {
          var lab='';
          (n.children||[]).forEach(function(c){ var L=c.getComponent&&c.getComponent(cc.Label); if(L&&L.string) lab=L.string; });
          if (${labelRe}.test(lab) || ${labelRe}.test(n.name)) hit=n.name;
        }
        (n.children||[]).forEach(walk);
      })(cc.director.getScene());
      return hit||'';
    })()`);
    if (!name) return null;
    return await Promise.race([
      g.clickNode(name),
      new Promise((_, rej) => setTimeout(() => rej(new Error('点击超时')), 15000)),
    ]).catch(e => { log('  点击失败: ' + e.message); return null; });
  }

  async function onReady(st) {
    log(`[Ready] 房间 ${st.players.length}/${st.maxPlayer} 人，我方账号 ${PLAYING.filter(a => st.players.some(p => p.uid === String(a.uid))).length}/${PLAYING.length}`);
    await ensureStreamer();
    if (NO_START || started) return;
    // ① 玩家先进：5 个账号先报名（从观众席入场；未进场的观众账号也先报名），再等进场
    for (const acc of PLAYING) {
      await dm(acc, '报名', true); // 报名是高优弹幕：抢占队列，避免进场被聊天弹幕堵迟
      await sleep(600);
    }
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      st = await readState();
      const inCnt = PLAYING.filter(a => st.players.some(p => p.uid === String(a.uid))).length;
      if (inCnt >= PLAYING.length) break;
    }
    const inCnt = PLAYING.filter(a => st.players.some(p => p.uid === String(a.uid))).length;
    log(`  玩家进场 ${inCnt}/${PLAYING.length}，总人数 ${st.players.length}`);
    // ② 加 31 NPC：一个一个错峰加（模拟真实入场，避免一次性刷出）
    let guard = 0;
    while (st.players.length < CFG.difficulty.botTarget && guard++ < 80) {
      const clicked = await clickBtn(/添加机器人/i);   // 单点 +1，逐个入场
      if (!clicked) break;
      await sleep(800 + Math.floor(Math.random() * 700)); // NPC 错峰快入（0.8~1.5s/个，提速：原 1.6~3.0s）
      st = await readState();
    }
    log(`  机器人补充后: ${st.players.length}/${st.maxPlayer}`);
    if (st.players.length > CFG.difficulty.botTarget) log('  ⚠️ 机器人超编，账号可能进不来，等下一局');
    // ③ NPC 按性格穿付费套装（R/SR/SSR/UR 混合，观众可见）
    const dressCmds = [];
    st.players.forEach(p => {
      if (!p.robot) return;
      const suit = npc.paidOutfitFor(p.uid);
      dressCmds.push({ uid: p.uid, action: 'suit', grade: suit.grade, suitId: suit.suitId, fallback: npc.outfitFor(p.uid) });
    });
    if (dressCmds.length) {
      log(`  👕 NPC 按性格穿付费套装 ${dressCmds.length} 套（分批加载，UR 骨骼远程加载防卡页）`);
      for (let i = 0; i < dressCmds.length; i += 6) {
        await robotAct(dressCmds.slice(i, i + 6), '换装');
        await sleep(500); // 换装批间提速：原 900ms → 500ms
      }
    }
    // ④ 场外围观观众 14 人错峰陆续进场（livecast.audience 开启时，由首次 onHide 的 livecast.tick 懒加载，见 livecast 子系统）
    // ⑤ 点击开始
    const r = await clickBtn(/开始|start/i);
    if (r) { log('  ▶ 点击「开始」发牌'); started = true; }
    else log('  ❌ 找不到开始按钮');
  }

  async function onHide(st) {
    const alive = st.players.filter(p => !p.die);
    const wolves = alive.filter(p => p.camp === 2);
    const goods = alive.filter(p => p.camp === 1);
    log(`[Hide 第${st.night + 1}天躲门] 存活 ${alive.length}（狼 ${wolves.length} / 好人 ${goods.length}）`);
    if (wolves.length) log('  狼: ' + wolves.map(w => w.no + '号' + (MY.has(w.uid) ? '(我方)' : '')).join(' '));
    await say(commentator.onPhase('Hide', st.night + 1));
    if ((st.players || []).some(p => !p.die && isSeer(p))) { try { await say(commentator.onSeerCheck()); } catch (_) {} }
    await livecast.tick({ phase: 'Hide', dayNo: st.night + 1, broadcast: '', heat: 0.4 }); // 场外观众陆续进场/闲聊（livecast 关闭时为空操作）

    // 老玩家持续换装：第 2 天起，白天躲门时随机抽 3-5 个存活 NPC 换套新付费套装
    if (st.night >= 1) {
      const redraw = alive.filter(p => p.robot).sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 3));
      for (const p of redraw) await dressNPC(p.uid, true);
    }

    const doors = [1, 2, 3, 4];
    // ① 虚拟好人布局（狼的狩猎参考）
    const virtual = Array.from({ length: 5 }, () => ({ wolves: 0, goods: 0 }));
    goods.forEach((p, i) => { virtual[i % 5].goods++; });
    const mouseVue0 = Math.min(18.33 + 15 * (st.night || 0), 63.33); // 大厅老鼠死亡概率%

    // ② 读取躲门倒计时截止时间（m.stateEndTime，unix 秒）——各阵营最后一秒才落位
    let endMs = 0;
    try {
      const v = await E(`(function(){ var m=window.__D.mgr(); return (m.stateEndTime||0)*1000; })()`);
      endMs = Number(v) || 0;
    } catch (e) {}
    const remain = endMs - Date.now();
    const cdOK = remain > 3000 && remain < 300000; // 倒计时有效（3s~5min）
    // 最后一秒窗口：狼机器人 -2.0s 先落位 → 好机器人 -1.2s 后手躲狼（账号弹幕在阶段开始时已发）
    const WOLF_LEAD = 2000, GOOD_LEAD = 1200;
    const waitTo = (lead) => {
      if (!cdOK) return sleep(600); // 拿不到倒计时就按老节奏立即落位，绝不miss阶段
      const t = endMs - lead - Date.now();
      return t > 0 ? sleep(t) : Promise.resolve();
    };
    if (cdOK) log(`  ⏱️ 躲门倒计时 ${(remain / 1000).toFixed(1)}s：账号先选 / 狼 -${WOLF_LEAD / 1000}s / 好机器人 -${GOOD_LEAD / 1000}s 最后一秒落位`);
    else log('  ⏱️ 倒计时不可用，按立即落位模式');

    // ③ 账号（真实玩家）：阶段一开始就发弹幕选房——弹幕有 1-3s 延迟+队列间隔，必须提前；
    //    真人观众也会早点选，狼机器人 -2s 落位时能看到账号实际落位
    const goodAccs0 = alive.filter(p => !p.robot && p.camp === 1 && MY.has(p.uid));
    const wolfAccs0 = alive.filter(p => !p.robot && p.camp === 2 && MY.has(p.uid));
    if (goodAccs0.length || wolfAccs0.length) {
      const ac0 = Array.from({ length: 5 }, () => ({ wolves: 0, goods: 0 }));
      const st0 = await readState();
      (st0.places || []).forEach((set, i) => set.forEach(u => {
        const p = st0.players.find(x => x.uid === String(u));
        if (p && !p.die) { if (p.camp === 2) ac0[i].wolves++; else ac0[i].goods++; }
      }));
      // 模拟未落位狼（机器人+狼账号）按 virtual 的狩猎落位，预测每房最终狼数
      // 【夜晚规则修正·读码确认】LiveWolfRoleWolf.getRoomAckCount()=1：普通狼每夜在房间
      // 必出 1 刀（没有≥2狼限制）——躲 1 狼房也危险；狼只进房门狩猎，大厅无刀只有老鼠独立判定
      const vcSim = virtual.map(v => ({ ...v }));
      const simWolves = alive.filter(p => p.camp === 2 && (p.robot || MY.has(p.uid)));
      simWolves.forEach(() => {
        const best = doors.slice().sort((a, b) => (vcSim[b].goods - vcSim[b].wolves) - (vcSim[a].goods - vcSim[a].wolves))[0];
        vcSim[best].wolves++;
      });
      const expectW = {};
      doors.forEach(d => { expectW[d] = ac0[d].wolves + vcSim[d].wolves; });
      // 预测每门好人数（用均摊布局 virtual 作代理：virtual[d].goods 已摊入全部好人含账号）
      const predGoods = (d) => (virtual[d] ? virtual[d].goods : 0);
      for (const gp of goodAccs0) {
        // 【风险对比·修正】原逻辑「只进 0 预期狼门」在 ≥4 狼局永远无门可选 → 好账号全挤大厅，
        // 被老鼠（第2天起 33%→48%→63%/夜）活活收走：实测 5 个账号第2天前死 3 个、剩 2 个卡大厅（观众看就是“只发钓鱼、不进房”）。
        // 改为与「好机器人」同款风险比较：优先 0 预期狼门；否则进「预期狼/(好+1)」最低的门，
        // 仅当最低房风险仍高于大厅老鼠率时才留大厅。狼机器人/狼账号仍只信预估布局，不读账号实际落位（反狙击不变）。
        const riskOf = (d) => expectW[d] / (predGoods(d) + 1);
        const zeroSafe = doors.filter(d => expectW[d] === 0);
        let room = 0;
        if (zeroSafe.length) {
          room = zeroSafe.slice().sort((a, b) => predGoods(a) - predGoods(b))[0];
        } else {
          const risks = doors.map(d => ({ d, r: riskOf(d) })).sort((a, b) => a.r - b.r);
          const best = risks[0];
          if (best.r * 100 <= mouseVue0) {
            // 与最低风险相差 ≤5 个百分点的门里随机挑一间：既保命又避免账号全挤同一间被狼一窝端
            const cands = risks.filter(x => x.r <= best.r + 0.05);
            room = cands[Math.floor(Math.random() * cands.length)].d;
          }
        }
        if (room === 0) {
          log(`  😇 好账号 ${gp.no}号${gp.name} → 大厅（各房预期有狼 ${doors.map(d => d + ':' + expectW[d] + '狼').join(' ')}，最低房风险已高于大厅老鼠 ${mouseVue0}%）`);
          await dm(MY.get(gp.uid), CFG.script.fish || '钓鱼', false); // 不发躲门指令即留在大厅
        } else {
          ac0[room].goods++;
          log(`  😇 好账号 ${gp.no}号${gp.name} → ${LETTER[room]}（预期狼${expectW[room]} 好~${predGoods(room)} 风险${(riskOf(room) * 100).toFixed(0)}% ≤ 大厅老鼠${mouseVue0}%）`);
          await dm(MY.get(gp.uid), LETTER[room], true);
        }
      }
      // 狼账号：按虚拟预估布局狩猎（与狼机器人同款 goods-wolves 比较器）——
      // 不再读取好账号实际落位(ac0)，避免 7 狼精准血洗先选房的账号（反狙击补丁）
      for (const w of wolfAccs0) {
        const best = doors.slice().sort((a, b) => (virtual[b].goods - virtual[b].wolves) - (virtual[a].goods - virtual[a].wolves))[0];
        virtual[best].wolves++;
        log(`  🐺 狼账号 ${w.no}号${w.name} → ${LETTER[best]}（预估好人${virtual[best].goods}）`);
        await dm(MY.get(w.uid), LETTER[best], true);
      }
      // 注意：账号实际落位(ac0)不再补进 virtual——狼机器人/狼账号只信预估布局，
      // 好账号先选房即便被撞上也是概率均摊，不再是精准狙击
    }

    // ④ 狼机器人：等到 -2.0s 按狩猎需求落位（虚拟布局已含账号实际落位）
    const vc = virtual.map(v => ({ ...v }));
    const wolfCmds = [];
    alive.filter(p => p.robot && p.camp === 2).forEach(p => {
      const best = doors.slice().sort((a, b) => (vc[b].goods - vc[b].wolves) - (vc[a].goods - vc[a].wolves))[0];
      vc[best].wolves++;
      wolfCmds.push({ uid: p.uid, action: 'hide', arg: LETTER[best] });
    });
    await waitTo(WOLF_LEAD);
    if (gen !== myGen) return;
    if (wolfCmds.length) log('  🐺 狼机器人狩猎(最后一秒): ' + wolfCmds.map(c => { const p = st.players.find(x => x.uid === c.uid); return (p ? p.no : c.uid) + '→' + c.arg; }).join(' '));
    await robotAct(wolfCmds, '躲门');
    await sleep(200);
    st = await readState();
    // ④ 实际房间计数 + 大厅老鼠率
    const ac = Array.from({ length: 5 }, () => ({ wolves: 0, goods: 0 }));
    const mouseVue = Math.min(18.33 + 15 * st.night, 63.33); // 大厅死亡概率%
    const countPlaces = () => {
      (st.places || []).forEach((set, i) => set.forEach(u => {
        const p = st.players.find(x => x.uid === String(u));
        if (p && !p.die) { if (p.camp === 2) ac[i].wolves++; else ac[i].goods++; }
      }));
    };
    countPlaces();
    // ⑤ 好机器人：等到 -1.2s，基于狼实际落位后手躲门
    await waitTo(GOOD_LEAD);
    if (gen !== myGen) return;
    st = await readState();
    ac.forEach(r => { r.wolves = 0; r.goods = 0; });
    countPlaces();
    const goodBotCmds = [];
    alive.filter(p => p.robot && p.camp === 1).forEach(p => {
      const zero = doors.filter(i => ac[i].wolves === 0).sort((a, b) => ac[a].goods - ac[b].goods);
      let room;
      if (zero.length) room = zero[0];
      else {
        const best = doors.slice().sort((a, b) => ac[a].wolves / (ac[a].goods + 1) - ac[b].wolves / (ac[b].goods + 1))[0];
        const roomRisk = ac[best].wolves / (ac[best].goods + 1);
        room = (roomRisk * 100 <= mouseVue) ? best : 0; // 大厅风险更低就回大厅
      }
      ac[room].goods++;
      goodBotCmds.push({ uid: p.uid, action: 'hide', arg: LETTER[room] });
    });
    if (goodBotCmds.length) log('  🤖 好机器人躲门(最后一秒): ' + goodBotCmds.map(c => { const p = st.players.find(x => x.uid === c.uid); return (p ? p.no : c.uid) + '→' + c.arg; }).join(' '));
    await robotAct(goodBotCmds, '躲门');
    await sleep(200);
    st = await readState();
  }

  // 技能目标：返回该玩家选人阶段应发的号码（null=按常规投票）
  function skillTarget(p, st) {
    // 花瓶妹（投票复活，没破）：复活死者——优先死去的鳌大人，再预言家，再任意好人
    if (isVase(p) && p.power && st.dead.length) {
      const deadGood = st.dead.filter(d => d.camp === 1 && !isVase(d));
      const adult = deadGood.find(d => isAdult(d));
      const prophet = deadGood.find(d => isSeer(d));
      const t = adult || prophet || deadGood[0];
      if (t) return { no: t.no, why: `复活${t.no}号${adult ? '(大人)' : ''}` };
    }
    // 鳌大人（傲白）：投票刀人（刀已知狼）
    if (isAdult(p) && p.epower) {
      const wolves = st.players.filter(x => !x.die && x.camp === 2 && x.uid !== p.uid);
      if (wolves.length) return { no: rnd(wolves).no, why: '大人刀狼' };
    }
    // 妈宝男（愤青）：预设亡语目标（选一头狼——被处决时带走它）
    if (isMomTreasure(p) && p.epower) {
      const wolves = st.players.filter(x => !x.die && x.camp === 2);
      if (wolves.length) return { no: rnd(wolves).no, why: '妈宝亡语预设' };
    }
    return null;
  }

  // ---------- 天亮盘点：进房的按房门口排列，已死的按身份排队 ----------
  async function dawnRollCall(st) {
    const LETTER = ['', 'A', 'B', 'C', 'D'];
    const rooms = [];
    for (let d = 1; d <= 4; d++) {
      const set = (st.places || [])[d] || [];
      const list = set.map(u => st.players.find(x => x.uid === String(u))).filter(Boolean)
        .sort((a, b) => a.no - b.no)
        .map(p => `${p.no}号${p.name}${MY.has(p.uid) ? '(我方)' : ''}[${ROLE[p.role]}]`);
      rooms.push({ door: LETTER[d], list });
    }
    const hallCnt = ((st.places || [])[0] || []).length;
    const dead = st.players.filter(p => p.die);
    const deadW = dead.filter(p => p.camp === 2).sort((a, b) => a.no - b.no);
    const deadG = dead.filter(p => p.camp === 1).sort((a, b) => a.no - b.no);
    const inRoom = rooms.reduce((s, r) => s + r.list.length, 0);
    log(`🌅 天亮盘点（第${st.night}夜结算后）：存活 ${st.players.filter(p => !p.die).length}，进房 ${inRoom}，大厅 ${hallCnt}`);
    rooms.forEach(r => log(`   ${r.door}房门口(${r.list.length}人): ${r.list.join('、') || '(空)'}`));
    log(`   ⚰️ 已死 ${dead.length} 人·按身份排队：`);
    if (deadW.length) log(`      🐺 狼人 ${deadW.length} 人: ` + deadW.map(p => `${p.no}号${p.name}[${ROLE[p.role]}]`).join('、'));
    if (deadG.length) log(`      😇 好人 ${deadG.length} 人: ` + deadG.map(p => `${p.no}号${p.name}[${ROLE[p.role]}]`).join('、'));
    // 直播间弹幕精简版（分 2 条，主播号发布——死亡账号弹幕仍可正常送达）
    await say(`天亮盘点！进房的——${rooms.map(r => r.door + '房' + r.list.length + '人').join('，')}。`);
    await sleep(react());
    if (dead.length) await say(`已死${dead.length}人按身份排队：狼人${deadW.length}人（${deadW.map(p => p.no + '号').join('、') || '无'}），好人${deadG.length}人（${deadG.map(p => p.no + '号').join('、') || '无'}）。`);
  }

  // ---------- 24 角色技能「灵活触发」专用播报（差异化解说） ----------
  // 跨夜快照 diff + nightData 技能计数，对 6 类技能事件做定向解说。全部 try/catch，绝不拖垮主循环。
  let skillPrev = null; // { dead:Set(uid), night:slimNight }
  function nameOf(uid, st) {
    uid = String(uid);
    const p = (st.players || []).find(x => x.uid === uid) || (st.dead || []).find(x => x.uid === uid);
    return p ? { no: p.no, name: p.name || '某选手' } : { no: '?', name: '某选手' };
  }
  async function narrateSkills(st) {
    try {
      const curDead = new Set((st.dead || []).map(d => d.uid));
      const cur = st.nightData;
      if (!skillPrev) { skillPrev = { dead: new Set(), night: {} }; } // 首夜以空基线 diff，连第1夜技能也播报（不 return）
      const events = [];
      // 本夜花瓶妹是否发动「投票复活」（游戏自身计数 count_witch）——若是，则复活事件归属花瓶妹，避免被笼统标成「瓶子复活」
      const vaseRevived = !!(cur && cur.count_witch > (skillPrev.night && skillPrev.night.count_witch || 0));
      // ① 瓶子复活：上轮死了、这轮还活着（酒鬼/比赛女巫）；花瓶妹复活单独标注，二者互斥避免重复/误标
      if (!vaseRevived) {
        for (const uid of skillPrev.dead) {
          if (!curDead.has(uid)) { const p = nameOf(uid, st); events.push({ pri: 5, line: commentator.onRevival(p.no, p.name), tag: '瓶子复活' }); }
        }
      }
      // ② 新死者分类
      for (const d of (st.dead || [])) {
        if (skillPrev.dead.has(d.uid)) continue;
        const isHall = (cur && cur.hall_killed.includes(d.uid)) || d.place === 0; // 大厅死亡=老鼠；房间死亡=狼刀
        const wolfVictim = cur && (cur.id_nosale === d.uid || cur.id_sale === d.uid);
        if (isHall) events.push({ pri: 3, line: commentator.onHallKill(d.no, d.name), tag: '老鼠大厅杀' });
        else if (String(d.roleName || '').indexOf('预言') !== -1) events.push({ pri: 4, line: commentator.onSeerDead(d.no, d.name), tag: '预言家阵亡' });
        else if (['妈宝', '愤青'].some(k => String(d.roleName || '').indexOf(k) !== -1)) { const wolfDown = (st.dead || []).some(x => x.camp === 2 && !skillPrev.dead.has(x.uid)); events.push({ pri: 3, line: commentator.onDeathRattle(d.no, d.name, wolfDown), tag: '妈宝亡语' }); }
        else if (!wolfVictim) events.push({ pri: 1, line: commentator.onWitchPoison(d.no, d.name), tag: '女巫毒杀' });
      }
      // ③ 女巫施救：狼的夜刀目标还活着（比赛女巫/女巫 role7/23）
      if (cur && cur.id_nosale && !curDead.has(cur.id_nosale)) {
        const p = nameOf(cur.id_nosale, st);
        if (p.no !== '?') events.push({ pri: 4, line: commentator.onWitchSave(p.no, p.name), tag: '女巫施救' });
      }
      // ③b 花瓶妹复活：游戏自身计数 count_witch = 花瓶妹把被投出去的好人拉回（专用播报，避免被「瓶子复活」笼统覆盖）
      if (cur && cur.count_witch > (skillPrev.night && skillPrev.night.count_witch || 0)) {
        events.push({ pri: 5, line: commentator.onVaseRevive(), tag: '花瓶妹复活' });
      }
      // ④ 九尾狐觉醒（额外风味）
      if (cur && skillPrev.night && cur.count_ninefox_awake > (skillPrev.night.count_ninefox_awake || 0)) events.push({ pri: 1, line: commentator.onNineFoxAwake(), tag: '九尾狐觉醒' });
      // 按优先级排序，最多发 4 条，避免刷屏
      events.sort((a, b) => b.pri - a.pri);
      const top = events.slice(0, 4);
      for (const e of top) { log('  🧪 技能播报[' + e.tag + ']: ' + e.line); try { await say(e.line); } catch (_) {} await sleep(Math.min(2200, 800 + Math.random() * 1200)); }
      skillPrev = { dead: curDead, night: cur };
    } catch (e) { log('  ⚠️ 技能播报出错（已忽略）: ' + e.message); }
  }

  async function onSelect(st) {
    const alive = st.players.filter(p => !p.die);
    const wolves = alive.filter(p => p.camp === 2);
    log(`[SelectPlayer 第${st.night}天选人] 存活 ${alive.length}，狼 ${wolves.length}: ${wolves.map(w => w.no + '号').join(' ') || '无'}`);
    await dawnRollCall(st);
    await narrateSkills(st);
    await say(commentator.onPhase('SelectPlayer', st.night));
    const top = topSelTarget(st);
    await livecast.tick({ phase: 'SelectPlayer', dayNo: st.night, stagedNo: top ? top.no : null, broadcast: top ? ('归票' + top.no + '号') : '', heat: 0.8 }); // 场外观众归票/狡辩

    // 常规目标
    const myWolves = wolves.filter(w => MY.has(w.uid));
    const pickForGood = () => {
      if (!wolves.length) return null;
      if (myWolves.length) { const other = wolves.filter(w => !MY.has(w.uid)); if (other.length) return other[0]; return myWolves[0]; }
      return wolves[0];
    };
    const pickForWolf = () => {
      const goods = alive.filter(p => p.camp === 1);
      const myGoods = goods.filter(x => MY.has(x.uid));
      if (myGoods.length) return myGoods[0];
      return goods[0] || null;
    };

    // ---------- 机器人：技能目标优先， staggered 选人 ----------
    const botJobs = [];
    alive.filter(p => p.robot).forEach(p => {
      const sk = skillTarget(p, st);
      let no, why = '';
      if (sk) { no = sk.no; why = sk.why; }
      else { const t = p.camp === 2 ? pickForWolf() : pickForGood(); no = t ? t.no : null; }
      if (no == null) return;
      botJobs.push(async () => {
        await sleep(1500 + Math.random() * 25000); // 1.5-26s 内陆续投票
        if (gen !== myGen) return;
        await robotAct([{ uid: p.uid, action: 'sel', arg: no }], why ? `选人(${why})` : '选人');
        if (why) log(`  🎭 ${p.no}号${p.name}(${ROLE[p.role]}) ${why} → 发 ${no}`);
      });
    });
    botJobs.forEach(j => j().catch(e => log('  选人任务出错: ' + e.message)));

    // ---------- 机器人发言：归票/分析，2-3 秒延迟起 ----------
    const speakers = alive.filter(p => p.robot && Math.random() < npc.speakProb(npc.personalityOf(p.uid))).slice(0, 5);
    speakers.forEach((p, i) => {
      (async () => {
        await sleep(react() + i * 2500 + Math.random() * 2000);
        if (gen !== myGen) return;
        const kind = Math.random() < 0.5 ? 'accuse' : (Math.random() < 0.5 ? 'analyze' : 'banter');
        const line = npcLine(p, st, kind);
        await speak(p.uid, p.name, line);
        log(`  🗣️ ${p.no}号${p.name}[${npc.PERSONALITIES[npc.personalityOf(p.uid)].name}]: 「${line}」`);
        // 发言影响其他人的信念（摇摆）
        const m = /^(\d+)号/.exec(line);
        if (m && kind !== 'banter') {
          const tgt = alive.find(x => x.no === Number(m[1]));
          if (tgt) broadcastSpeech(p.uid, kind === 'accuse' ? 'accuse' : 'analyze', tgt.uid, 0.8 + Math.random() * 0.6);
        }
      })().catch(e => log('  发言任务出错: ' + e.message));
    });

    // ---------- 托管账号：真实弹幕发言+选人 ----------
    for (const p of alive.filter(x => !x.robot && MY.has(x.uid))) {
      const acc = MY.get(p.uid);
      const persona = ACCOUNT_PERSONA[p.uid] || 'aggressive';
      // 账号发言（有性格）
      if (Math.random() < npc.speakProb(persona)) {
        await sleep(react());
        const line = npcLine(p, st, p.camp === 2 ? 'accuse' : 'accuse');
        await dm(acc, line, false, true); // keep=true：被随后的选人(urgent)抢占时让位重排，不丢弃
        const m = /^(\d+)号/.exec(line);
        if (m) { const tgt = alive.find(x => x.no === Number(m[1])); if (tgt) broadcastSpeech(p.uid, 'accuse', tgt.uid, 1.2); }
      }
      // 账号选人（技能优先）
      const sk = skillTarget(p, st);
      if (sk) { log(`  🎭 ${p.no}号${p.name}(${ROLE[p.role]}) ${sk.why} → 弹幕发 ${sk.no}`); await dm(acc, String(sk.no), true); }
      else {
        const t = p.camp === 2 ? pickForWolf() : pickForGood();
        if (t) { log(`  ${p.camp === 2 ? '🐺' : '😇'} ${p.no}号${p.name} → 选 ${t.no}号`); await dm(acc, String(t.no), true); }
      }
      await sleep(800);
    }
  }

  async function onVote(st) {
    const alive = st.players.filter(p => !p.die);
    const staged = st.players.find(p => p.uid === st.votePlayerId);
    if (!staged) { log('[VotePlayer] 无人上台'); return; }
    const stagedIsWolf = staged.camp === 2;
    const winLeft = st.stateEndTime ? (st.stateEndTime * 1000 - Date.now()) / 1000 : -1;
    log(`[VotePlayer 第${st.night}天投票] 上台: ${staged.no}号${staged.name}(${ROLE[staged.role]},${CAMP[staged.camp]})${winLeft >= 0 ? `，投票窗剩余 ${winLeft.toFixed(1)}s` : ''}`);

    // ---------- 托管账号投票：第一时间抢占弹幕队列发出（先投票，后解说） ----------
    // 事故记录（02:26 局）：投票窗仅 11s（无真人观众时游戏提前收窗），账号投票整段堵在
    // 15+ 条聊天弹幕队列里 13s+ 才发出，全部错过窗口，杀票仅 1（用户观感："不会投票了"）。
    // 现在：dm(urgent) 入队即抢占积压低优弹幕；5 账号按 3.2s 队列间隔发出，短窗内也能进 3-4 票。
    const voters = alive.filter(x => !x.robot && MY.has(x.uid));
    dmPreempt();
    voters.forEach(p => {
      const acc = MY.get(p.uid);
      const v = p.camp === 2 ? (stagedIsWolf ? '666' : '444') : (stagedIsWolf ? '444' : '666');
      log(`  ${p.camp === 2 ? '🐺' : '😇'} ${p.no}号${p.name} → 「${v}」`);
      dm(acc, v, true).catch(e => log('  投票发送出错: ' + (e && e.message || e)));
    });

    // 阶段解说（不阻塞投票；被抢占时会自动让位重排到队尾）
    say(commentator.onPhase('VotePlayer', st.night)).catch(e => log('  解说发送出错: ' + (e && e.message || e)));

    // 被上台者辩护（机器人）
    if (staged.robot) {
      (async () => {
        await sleep(react());
        if (gen !== myGen) return;
        await speak(staged.uid, staged.name, npc.defend(staged.no, '?'));
        log(`  🗣️ ${staged.no}号${staged.name}(上台): 「辩护」`);
      })().catch(e => log('  辩护任务出错: ' + e.message));
    }
    // 归票/拉票发言
    const callers = alive.filter(p => p.robot && npc.speakProb(npc.personalityOf(p.uid)) > 0.5).slice(0, 3);
    callers.forEach((p, i) => {
      (async () => {
        await sleep(react() + 4000 + i * 3500);
        if (gen !== myGen) return;
        const wolves = alive.filter(x => x.camp === 2);
        let line, tgtNo = null;
        if (p.camp === 2) { const g = alive.filter(x => x.camp === 1 && x.uid !== p.uid); const t = rnd(g); line = npc.frameGood(p.no, t.no); tgtNo = t.no; }
        else if (stagedIsWolf) { line = npc.accuseWolf(p.no, staged.no); tgtNo = staged.no; }
        else if (wolves.length) { const t = rnd(wolves); line = npc.accuseWolf(p.no, t.no); tgtNo = t.no; }
        else line = npc.banter(p.no, staged.no);
        await speak(p.uid, p.name, line);
        log(`  🗣️ ${p.no}号${p.name}: 「${line}」`);
        if (tgtNo) { const t = alive.find(x => x.no === tgtNo); if (t) broadcastSpeech(p.uid, p.camp === 2 ? 'accuse' : 'call', t.uid, 1.0); }
      })().catch(e => log('  归票任务出错: ' + e.message));
    });

    // ---------- 机器人投票：信念驱动（会摇摆），staggered ----------
    alive.filter(p => p.robot).forEach(p => {
      (async () => {
        await sleep(300 + Math.random() * 7700); // 0.3-8s 内陆续投票（原 4-44s：11s 短窗内大半赶不上）
        if (gen !== myGen) return;
        let v;
        if (p.camp === 2) {
          // 狼：救队友/杀好人；15% 概率伪装
          const saveTeammate = stagedIsWolf;
          v = (saveTeammate || Math.random() < CFG.difficulty.wolfSaveMateRate) ? '666' : '444';
          if (!stagedIsWolf && Math.random() < CFG.difficulty.wolfFakeGoodRate) v = '666'; // 狼偶尔装好人
        } else {
          const m = mindOf(p);
          v = m.decide(staged.uid, stagedIsWolf, p.uid === staged.uid);
        }
        await robotAct([{ uid: p.uid, action: 'vote', arg: v }], '投票');
      })().catch(e => log('  投票任务出错: ' + e.message));
    });
  }

  function onNight(st) {
    log(`[Night 第${st.night}天夜晚] 自动结算中… 存活 ${st.players.filter(p => !p.die).length}`);
  }

  async function onVoteResult(st) {
    const staged = st.players.find(p => p.uid === st.votePlayerId);
    log(`[VoteResult] 杀票 ${st.kill.length} / 救票 ${st.life.length}${staged ? '，上台者 ' + staged.no + '号' + staged.name : ''}`);
    if (!staged) return;
    const executed = st.kill.length > st.life.length;
    if (!executed) { await say('全员投票过半选择留下，这位选手逃过一劫，空气里都是劫后余生的味道'); return; }
    const isWolf = staged.camp === 2;
    await say(commentator.onExecution(staged.no, isWolf));
    if (isWolf) {
      const voters = new Set([...(st.sel[staged.uid] || []), ...st.kill]);
      const adultVoted = (st.players || []).some(p => !p.die && isAdult(p) && voters.has(p.uid));
      if (adultVoted) { const ln = commentator.onAdultKill(staged.no); log('  🧪 技能播报[大人刀人]: ' + ln); try { await say(ln); } catch (_) {} }
    }
    await livecast.tick({ phase: 'VoteResult', lastExecution: { no: staged.no, isWolf }, heat: 1.0 }); // 场外观众对处决结果反应
    // 信念更新：处决揭示（公开信息）
    const voters = new Set([...(st.sel[st.votePlayerId] || []), ...st.kill]);
    minds.forEach(m => m.onReveal(staged.uid, isWolf, Array.from(voters)));
    log(`  📢 处决揭示: ${staged.no}号是${CAMP[staged.camp]}，投票者信念已更新`);
  }

  async function onEnd(st) {
    const alive = st.players.filter(p => !p.die);
    const w = alive.filter(p => p.camp === 2).length;
    log(`[End] 游戏结束！存活 ${alive.length} 人，剩余狼 ${w} → ${w === 0 ? '✅ 好人阵营胜利' : '🐺 狼人阵营胜利'}`);
    log('  我方结局: ' + st.players.filter(p => MY.has(p.uid)).map(p => `${p.no}号${p.name}(${ROLE[p.role]})${p.die ? '死亡' : '存活'}`).join(' '));
    await say(commentator.onPhase('End', st.night));
    // 自主进化：把本局信息归类写入知识库（livecast.evolve 关闭时为空操作）
    const wEnd = st.players.filter(p => !p.die && p.camp === 2).length;
    await livecast.recordRound({
      result: wEnd === 0 ? 'good' : 'wolf',
      players: st.players.map(p => ({
        no: p.no, role: p.camp === 2 ? 'wolf' : 'good',
        persona: MY.has(p.uid) ? (ACCOUNT_PERSONA[String(p.uid)] || 'aggressive') : npc.personalityOf(p.uid),
        die: !!p.die,
      })),
      costumeChanges: [], skills: [],
    });
  }

  // ================= Gacha 怪兽模式自动适配 =================
  // 导演自动识别场景（game_bobo_master / bobo 节点）后接管：营地报名 → 抽装备 → 增益投票轮转 → 战斗加血 → 结束自动再来一局，
  // 并持续钉死「10000 倍攻击力」排行榜榜首（许许许许许丶若辰）。仅在识别到 Gacha 场景且 CFG.gacha.enabled 时生效，不干扰狼人杀。
  async function detectMode() {
    try {
      const r = await E(`(function(){
        var s = cc.director.getScene();
        if (!s) return 'none';
        var hasBobo = false, hasWolf = false;
        (function walk(n, d) {
          if (!n || d > 6) return;
          var nm = n.name || '';
          if (/bobo_master|bobo/i.test(nm)) hasBobo = true;
          if (/game_wolf|ComLiveWolf/i.test(nm)) hasWolf = true;
          (n.children || []).forEach(function (c) { walk(c, d + 1); });
        })(s, 0);
        if (window.__GS && window.__GS.find) { try { if (window.__GS.find('bobo')) hasBobo = true; } catch (e) {} }
        // 目标地图优先（唯一真源 = worker 侧 gMode()：弹幕「地图 X」RT 覆盖 > 助手 UI 写的 config.gameMode > 默认 gacha）：
        // 具体地图(gacha/werewolf/rouge/chump/greatsword) → 强制走对应分支，场景保底 ensureModeScene 负责切过去；
        // 'auto' → 按场景真实内容识别。__directorWantGacha 为旧版兼容标志（仅在没有 want-mode 时生效）。
        // 注意：曾把 gMode() 写进页面全局 __directorWantMode 只注入一次，弹幕 RT 覆盖后不同步——
        // 导致 detectMode 返回 stale 'gacha'、地下城保底与地图切换互相拉锯（2026-10-24 02:08 事故），故这里每次现取。
        var want = ${JSON.stringify(gMode())};
        if (want && want !== 'auto') return want;
        if (window.__directorWantGacha !== false) return 'gacha';
        return hasBobo ? 'gacha' : (hasWolf ? 'werewolf' : 'lobby');
      })()`);
      return r;
    } catch (e) { return 'unknown'; }
  }

  // 扫场景文案，粗判 Gacha 当前子阶段（营地/抽装备/增益投票/战斗/结束）
  async function gachaPhaseUI() {
    try {
      const r = await E(`(function(){
        var labels = [];
        (function walk(n, d) {
          if (!n || d > 8) return;
          try { var cs = n.getComponents(cc.Label); cs.forEach(function (L) { if (L.string) labels.push(String(L.string)); }); } catch (e) {}
          (n.children || []).forEach(function (c) { walk(c, d + 1); });
        })(cc.director.getScene(), 0);
        var txt = labels.join(' ');
        var hasJoin = /报名|加入营地|营地/.test(txt);
        var hasDraw = /抽(装备|卡|奖)?|装备/.test(txt);
        var hasBuff = /增益|BUFF|投票/.test(txt);
        var hasCombat = /战斗|血量|攻击|BOSS|boss/i.test(txt);
        var hasEnd = /再来一局|重新开始|胜利|失败|结束/.test(txt);
        return JSON.stringify({ phase: hasEnd ? 'end' : hasCombat ? 'combat' : hasBuff ? 'buff' : hasDraw ? 'draw' : hasJoin ? 'camp' : 'unknown', txt: txt.slice(0, 600) });
      })()`);
      return JSON.parse(r);
    } catch (e) { return { phase: 'unknown', txt: '' }; }
  }

  // 钉死「10000 倍攻击力」排行榜榜首：monkey-patch 排序组件的 addRand + 直接钉分数/标签（服务器权威，仅显示层生效）
  async function ensureRankBoost() {
    if (!CFG.gacha) return null;
    const uid = CFG.gacha.rankBoostUid;
    const BIG = CFG.gacha.rankBoostScore;
    try {
      const r = await E(`(function(){
        var patched = 0, applied = 0, labelSet = 0;
        var sc = cc.director.getScene();
        var sortComp = null;
        (function walk(n, d) {
          if (!n || sortComp || d > 8) return;
          var cs = n._components || [];
          for (var i = 0; i < cs.length; i++) {
            var cn = (cs[i] && cs[i].constructor && cs[i].constructor.name) || '';
            if (/Sort|Rank|TaskSort/i.test(cn)) { sortComp = cs[i]; break; }
          }
          (n.children || []).forEach(function (c) { walk(c, d + 1); });
        })(sc, 0);
        if (!sortComp) return JSON.stringify({ patched: 0, applied: 0, hasSort: false });
        var UID = ${JSON.stringify(String(uid))};
        var BIG = ${JSON.stringify(BIG)};
        if (typeof sortComp.addRand === 'function' && !sortComp.__boostPatched) {
          var orig = sortComp.addRand.bind(sortComp);
          sortComp.addRand = function (u, name, n) { if (String(u) === UID) n = BIG; return orig(u, name, n); };
          sortComp.__boostPatched = true; patched = 1;
        }
        try {
          var arr = sortComp.rankArrs || sortComp.scoreArrs || (sortComp.rankArr ? [sortComp.rankArr] : null);
          if (arr) { for (var k in arr) { var a = arr[k]; if (a && a.length) { var top = a[0]; if (top) { top.score = BIG; if (top.lab_score && top.lab_score.string !== undefined) { top.lab_score.string = String(BIG); labelSet = 1; } applied = 1; } } } }
        } catch (e) {}
        return JSON.stringify({ patched: patched, applied: applied, labelSet: labelSet, hasSort: true });
      })()`);
      return JSON.parse(r);
    } catch (e) { log('  ⚠️ 排行榜锁定失败: ' + e.message); return null; }
  }

  // ================= 地下城（BoBo Master）导演：攻克 100 关 =================
  // 决策点全部来自 game-bundle 实测（非猜测）：
  //  - 选增益：组件含 btn_items[]+buffIds[]+isCanSelect；btn_items[t]→selectBuff(t)
  //  - 选任务/boss：同组件 btn_items[t]→selectTask(t)；f.default.selectTask.taskId
  //  - 加血：liveBaseData info="加血"(耗3金,+30%HP)；复活：info="复活"(耗10金,满血)
  //  - 关卡：f.default.lv 当前关；BoboMonsterEndless.getById(lv) 本关配置；无尽模式自动进下一关
  //  - 技能：BoboMonsterSkill（boss 技能预警→走位躲避；玩家大招释放）键位待现场校准
  let dungeonLv = 0;
  // —— BUFF 数据直改（倍率可配：CFG.gacha.buffMultiplier / 弹幕「倍率 N」实时覆盖）——
  // 运行时配置表：window.config.BoboMonsterEndlessBuff（60条；选卡UI与效果应用(udateBuffAttrByBuffIds)都读它）
  // 幂等：表对象上打 __buffMult 标记记录当前倍率——同倍率跳过；倍率变了从 __buffOrig 原始快照重新应用，绝不重复乘
  let dungeonBuffsDone = false;
  async function dungeonPatchBuffs() {
    const mult = gMult();
    try {
      const r = await E(`(function(){
        var B = window.config && window.config.BoboMonsterEndlessBuff;
        if (!B || !B.list) return JSON.stringify({ok:false,err:'no table'});
        var mult = ${mult};
        if (B.__buffMult === String(mult)) return JSON.stringify({ok:true,skipped:true,n:B.list.length});
        if (!B.__buffOrig) B.__buffOrig = B.list.map(function(e){
          if (!e) return null;
          return {
            ap: (e.addAttPercents||[]).map(Number),
            av: (e.addAttValues||[]).map(Number),
            dec: e.dec
          };
        });
        var n = 0;
        B.list.forEach(function(e, idx){
          if (!e) return;
          var o = B.__buffOrig[idx];
          if (!o) return;
          for (var i=0;i<o.ap.length;i++) e.addAttPercents[i]=o.ap[i]*mult;
          for (var i=0;i<o.av.length;i++) e.addAttValues[i]=o.av[i]*mult;
          if (typeof o.dec==='string'&&/\\d+/.test(o.dec)) e.dec=o.dec.replace(/\\d+/,function(m){return String(Number(m)*mult);});
          n++;
        });
        B.__buffMult = String(mult);
        var v=B.getById(10003), v2=B.getById(10057);
        return JSON.stringify({ok:true,n:n,sample:(v&&v.dec)+' / '+(v2&&v2.dec)});
      })()`);
      const j = JSON.parse(r);
      if (j.ok) {
        dungeonBuffsDone = true;
        if (!j.skipped) {
          if (mult > 1) log('  [地下城·BUFF] 已将全部 ' + j.n + ' 条 BUFF 数据改为 ×' + mult + '（样例: ' + j.sample + '）');
          else log('  [地下城·BUFF] 倍率 ×1：已将全部 ' + j.n + ' 条 BUFF 数据按快照还原（样例: ' + j.sample + '；若快照曾被旧版污染，需刷新游戏页才能拿到真正原版数值）');
        }
      }
    } catch (e) { /* 表未就绪（场景未加载），下轮重试 */ }
  }

  async function dungeonPhaseUI() {
    try {
      const r = await E(`(function(){
        var sc=cc.director.getScene(); if(!sc) return 'none';
        var labels=[], hasBtnItems=false, isCanSelect=false, hasBuffIds=false, hasSelectTask=false, hasJoin=false, hasCombat=false;
        var selTask=false, selBuff=false, selEnd=false;
        (function walk(n,d){
          if(!n||d>14) return;
          var nm=n.name||'';
          // 节点名直达（组件类名被压缩，节点名稳定）：三个关键界面按 activeInHierarchy 判定
          if(nm==='comBoBoMasterTaskSelect'&&n.activeInHierarchy) selTask=true;
          if(nm==='comBoBoMasterTaskBuff'&&n.activeInHierarchy) selBuff=true;
          if(nm==='comBoBoMasterEnd'&&n.activeInHierarchy) selEnd=true;
          if(n.btn_items&&n.btn_items.length) hasBtnItems=true;
          if(n.buffIds&&n.buffIds.length) hasBuffIds=true;
          if(typeof n.selectTask==='function') hasSelectTask=true;
          if(n.isCanSelect!==undefined) isCanSelect=n.isCanSelect;
          try{ var cs=n.getComponents(cc.Label); cs.forEach(function(L){ if(L.string) labels.push(String(L.string)); }); }catch(e){}
          (n.children||[]).forEach(function(c){ walk(c,d+1); });
        })(sc,0);
        var txt=labels.join(' ');
        hasJoin=/加入|开始|队伍/.test(txt);
        // 去掉裸 \\d+秒（曾把「选择难度29秒/增溢30秒」误吞成 combat）；战斗特征词收紧
        hasCombat=/走位|躲避|加血|复活|出战|攻击/.test(txt);
        var phase='unknown';
        // 优先级：结算 > 任务/难度(节点名直达) > BUFF投票 > 战斗 > 报名
        // 注意：TaskSelect 的 item 卡片也带 buffIds 属性，旧版 buff 兜底先于 task 判定 → 难度界面被误判成 buff，故 task 必须优先
        if(selEnd) phase='end';
        else if(selTask||(hasBtnItems&&hasSelectTask)) phase='task';
        else if(selBuff||(hasBtnItems&&hasBuffIds)) phase='buff';
        else if(hasCombat) phase='combat';
        else if(hasJoin) phase='join';
        return JSON.stringify({phase:phase, txt:txt.slice(0,400), selTask:selTask, selBuff:selBuff, selEnd:selEnd, isCanSelect:isCanSelect});
      })()`);
      return JSON.parse(r);
    } catch (e) { return { phase: 'unknown', txt: '' }; }
  }

  // BUFF 投票界面（comBoBoMasterTaskBuff，「选择增溢效果」A/B/C）
  // bundle 实证：selectBuff(e) 有 isCanSelect 硬门槛（false 时调用无效）→ 内存置位 true 后调用
  // 定位加固：不依赖节点名（投票容器名可能变化），按 selectBuff 原型方法唯一匹配 + 界面可见性
  let dungeonLastBuffPick = '';
  async function dungeonPickBuff() {
    const info = await E(`(function(){
      var sc=cc.director.getScene(); var comp=null;
      (function walk(n,d){ if(!n||comp||d>14) return;
        try{
          var cs=n.getComponents(cc.Component);
          for(var i=0;i<cs.length;i++){ if(typeof cs[i].selectBuff==='function'&&n.activeInHierarchy){ comp=cs[i]; break; } }
        }catch(e){}
        (n.children||[]).forEach(function(c){walk(c,d+1);});
      })(sc,0);
      if(!comp) return null;
      var CFGb=(window.config&&window.config.BoboMonsterEndlessBuff);
      var ids=comp.buffIds?comp.buffIds.map(function(x){return x;}):[];
      var names=ids.map(function(id){ try{ return CFGb.getById(id).name||('b'+id); }catch(e){ return 'b'+id; } });
      var grades=ids.map(function(id){ try{ return CFGb.getById(id).grade; }catch(e){ return -1; } });
      // 百分比加成标记：addAttPercents 有非零值 = 百分比类（用户 2026-10-23：要百分比攻速和攻击）
      var pcts=ids.map(function(id){ try{ var e=CFGb.getById(id); return (e.addAttPercents||[]).some(function(v){ return Number(v)>0; }); }catch(err){ return false; } });
      return JSON.stringify({ids:ids,names:names,grades:grades,pcts:pcts,isCanSelect:comp.isCanSelect,lv:comp.lv});
    })()`).then(JSON.parse).catch(function () { return null; });
    if (!info || !info.ids || !info.ids.length) return;
    const key = info.ids.join(',');
    if (key === dungeonLastBuffPick) return;   // 同一组选项已投过，防重复
    dungeonLastBuffPick = key;
    // 选卡策略（默认「攻击」模式——用户 2026-10-24 明确要求：「属性攻击都降权 优先攻速 攻击 生命 防御」）：
    // 倍率拉满后 BOSS 刮痧玩家；攻速直接缩短每关通关时间，百分比加成数值最大。
    // 策略模式可配（助手表单 gacha.buffStrategy.mode，或弹幕「策略 攻击|均衡|防御」实时切换，RT 覆盖优先）：
    //   attack   spd4 atk3 hp2 def1 ele0 res0 —— 攻速>攻击>生命>防御，属性攻击/抗性降权（默认）
    //   balanced spd2 atk2 hp2 def2 ele1 res1 —— 攻防兼顾
    //   resist   spd1 atk1 hp2 def2 ele1 res4 —— 堆抗性保命（低倍率/手动尝试时）
    //   custom   weights 六维自由配（助手表单）；preferPercent=false 时不迷信百分比加成
    // 属性攻击识别：加雷攻/加火攻/加魔攻/加水攻…（ele）与纯「加攻击」（atk）分开计价
    function buffCat(n) {
      if (/攻速|暴击|暴伤|穿透|急速/.test(n)) return 'spd';
      if (/抗/.test(n)) return 'res';                                                        // 任何抗性（雷抗/魔抗/抗性）
      if (/(属性|雷|火|魔|水|冰|风|土|光|暗)/.test(n) && /攻/.test(n)) return 'ele';          // 属性攻击：加雷攻/加火攻/加魔攻/全属性攻击
      if (/攻/.test(n)) return 'atk';                                                        // 纯攻击：加攻击
      if (/血|生命/.test(n)) return 'hp';                                                    // 生命/血量
      if (/防/.test(n)) return 'def';                                                        // 防御
      return 'res';
    }
    const strat = gStrategy();
    var PRI = strat.weights;
    var best = 0, bestScore = -1;
    info.names.forEach(function (n, i) {
      var score = (PRI[buffCat(n)] || 0) * 1000 + ((strat.preferPercent && info.pcts && info.pcts[i]) ? 500 : 0) + (info.grades[i] || 0);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    var bestGrade = info.grades[best];
    await E(`(function(){
      var sc=cc.director.getScene(); var comp=null;
      (function walk(n,d){ if(!n||comp||d>14) return;
        try{
          var cs=n.getComponents(cc.Component);
          for(var i=0;i<cs.length;i++){ if(typeof cs[i].selectBuff==='function'&&n.activeInHierarchy){ comp=cs[i]; break; } }
        }catch(e){}
        (n.children||[]).forEach(function(c){walk(c,d+1);});
      })(sc,0);
      // 双保险跳过30秒倒计时：① 派发卡片按钮 TOUCH_END（100%复现玩家点击：回调内 selectBuff+unscheduleAllCallbacks+back 全做）
      // ② 内存三连兜底（isCanSelect置位+selectBuff+取消定时器+resolve show 的等待 Promise）
      if(comp){
        comp.isCanSelect=true;
        var btn=comp.btn_items&&comp.btn_items[${best}];
        if(btn){ try{ btn.emit(cc.Node.EventType.TOUCH_END); }catch(e){} }
        try{ comp.selectBuff(${best}); }catch(e){}
        try{ comp.unscheduleAllCallbacks(); }catch(e){}
        if(comp.back){ try{ comp.back(); }catch(e){} comp.back=null; }
      }
    })()`).catch(function () {});
    log('  [地下城·选增益·' + strat.mode + '] ' + JSON.stringify(info.names) + (info.pcts ? ' 百分比=' + JSON.stringify(info.pcts.map(function(p){return p?'%':'值';})) : '') + ' → 选 #' + best + ' (' + info.names[best] + (info.pcts && info.pcts[best] ? '·百分比' : '') + ', grade=' + bestGrade + ')');
  }

  // 任务/难度选择界面（节点 comBoBoMasterTaskSelect，「选择难度」A/B/C 或关卡任务卡）
  // 策略：选 #0 = A 档（普通/绿史莱姆，最快推进）；isCanSelect 门槛同样内存置位突破
  let dungeonLastTaskPick = '';
  async function dungeonPickTaskOrDiff() {
    const info = await E(`(function(){
      var sc=cc.director.getScene(); var comp=null;
      (function walk(n,d){ if(!n||comp||d>14) return; if((n.name==='comBoBoMasterTaskSelect')&&n.activeInHierarchy){ var cs=n.getComponents(cc.Component); for(var i=0;i<cs.length;i++){ if(typeof cs[i].selectTask==='function'){ comp=cs[i]; break; } } } (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
      if(!comp) return null;
      return JSON.stringify({ids:comp.taskIds?comp.taskIds.map(function(x){return x;}):[], index:comp.index, taskId:comp.taskId, lv:comp.lv, isCanSelect:comp.isCanSelect});
    })()`).then(JSON.parse).catch(function () { return null; });
    if (!info) return;
    const key = 'lv' + info.lv + '#' + (info.ids || []).join(',');
    if (key === dungeonLastTaskPick) return;   // 本轮已选过，防重复
    dungeonLastTaskPick = key;
    const pick = 0;
    await E(`(function(){
      var sc=cc.director.getScene(); var comp=null;
      (function walk(n,d){ if(!n||comp||d>14) return; if((n.name==='comBoBoMasterTaskSelect')&&n.activeInHierarchy){ var cs=n.getComponents(cc.Component); for(var i=0;i<cs.length;i++){ if(typeof cs[i].selectTask==='function'){ comp=cs[i]; break; } } } (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
      // 同选增益双保险：派发卡片按钮 TOUCH_END + 内存三连兜底，跳过30秒倒计时
      if(comp){
        comp.isCanSelect=true;
        var btn=comp.btn_items&&comp.btn_items[${pick}];
        if(btn){ try{ btn.emit(cc.Node.EventType.TOUCH_END); }catch(e){} }
        try{ comp.selectTask(${pick}); }catch(e){}
        try{ comp.unscheduleAllCallbacks(); }catch(e){}
        if(comp.back){ try{ comp.back(); }catch(e){} comp.back=null; }
      }
    })()`).catch(function () {});
    log('  [地下城·选任务/难度] lv=' + info.lv + ' 选项=' + JSON.stringify(info.ids) + ' → 选 #' + pick + ' (A档·最快推进)');
  }

  // 本局结算屏（节点 comBoBoMasterEnd）：读胜负结果 + 关卡，等待自动返回首页
  async function dungeonHandleEnd() {
    const info = await E(`(function(){
      var sc=cc.director.getScene(); var comp=null;
      (function walk(n,d){ if(!n||comp||d>14) return; if((n.name==='comBoBoMasterEnd')&&n.activeInHierarchy){ var cs=n.getComponents(cc.Component); for(var i=0;i<cs.length;i++){ if(cs[i].lab_result){ comp=cs[i]; break; } } } (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
      if(!comp) return null;
      var res='', lv='', bt='';
      try{ res=String(comp.lab_result.string||''); }catch(e){}
      try{ lv=String(comp.lab_lv.string||''); }catch(e){}
      try{ bt=String(comp.lab_backtime.string||''); }catch(e){}
      return JSON.stringify({res:res,lv:lv,backtime:bt});
    })()`).then(JSON.parse).catch(function () { return null; });
    if (!info) return;
    log('  [地下城·结算] ' + info.res + ' ' + info.lv + '（' + info.backtime + '）');
    dungeonLastBuffPick = ''; dungeonLastTaskPick = '';  // 新的一局，选择记忆清零
    dungeonRecordEnd(info);   // 知识库记录本局胜负/关卡/参数快照 + autoTune 自主反思（endRecorded 防重复）
  }

  // 战斗治疗节流状态（2026-10-23 卡死事故修复：实体缺失时 hp=0/maxHp=1 曾导致每2s狂发加血）
  let dungeonLastHealAt = 0, dungeonLastRezAt = 0, dungeonHealStreak = 0, lastNoPlayerLogAt = 0;
  async function dungeonCombat() {
    const st = await E(`(function(){
      var out={hp:0,maxHp:1,dead:false,lv:0,found:false};
      try{ var M=window.__require('LiveBoBoMasterMgr'); if(M&&M.default){ out.lv=M.default.lv||0; } }catch(e){}
      var sc=cc.director.getScene(); var me=null;
      (function walk(n,d){ if(!n||me||d>12) return; if(n.getComponent&&n.getComponent('LiveBoBoMasterPlayer')){ me=n.getComponent('LiveBoBoMasterPlayer'); } (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
      out.found=!!me;
      if(me){ try{ out.hp=me.hp||0; out.maxHp=me.maxHp||1; out.dead=(out.hp<=0); }catch(e){} }
      return JSON.stringify(out);
    })()`).then(JSON.parse).catch(function () { return null; });
    if (!st) return;
    if (st.lv && st.lv !== dungeonLv) {
      if (st.lv < dungeonLv) {
        // 关卡回退 = 新的一局（或循环拨回 startLv）→ 本局统计复位，供知识库/自主决策使用
        dg.maxLvThisGame = 0; dg.healsThisGame = 0; dg.rezesThisGame = 0; dg.gameStartAt = Date.now();
        log('  🔄 [地下城] 检测到新的一局（关卡回到 ' + st.lv + '），本局统计已复位');
      }
      dungeonLv = st.lv;
      if (st.lv > dg.maxLvThisGame) dg.maxLvThisGame = st.lv;
      log('  🏯 地下城进度：第 ' + dungeonLv + ' 关');   // 关卡变化才播报（旧版每2s刷屏）
    }
    if (!dg.gameStartAt) dg.gameStartAt = Date.now();
    // 场景里没有玩家实体（关卡间过渡屏/等待出战）→ 根本不在战斗中：旧版在此误判 HP=0% 每2s狂发「加血」
    if (!st.found) {
      if (Date.now() - lastNoPlayerLogAt > 30000) { lastNoPlayerLogAt = Date.now(); log('  [地下城·战斗] 当前无玩家实体（关卡间过渡），待命不治疗'); }
      dungeonHealStreak = 0;
      return;
    }
    var nowMs = Date.now();
    var pct = st.maxHp > 0 ? st.hp / st.maxHp : 0;
    if (st.dead || pct <= 0) {
      // 死亡/空血 → 复活（8s 节流，防刷屏烧钱）
      if (nowMs - dungeonLastRezAt > 8000) {
        dungeonLastRezAt = nowMs;
        dg.rezesThisGame++;
        await E(`(function(){ var C=window.__require('ClientEventMgr').default; C.emit('liveBaseData',{roomId:${JSON.stringify(String(CFG.room.roomId))},action:'Comment',uid:${JSON.stringify(String(STREAMER.uid))},name:${JSON.stringify(STREAMER.uname)},info:'复活'}); })()`).catch(function () {});
        log('  [地下城·战斗] 死亡→复活(耗10金)');
      }
      return;
    }
    if (pct < gHealPct() / 100) {
      // 加血 3s 节流；连续3次血量无起色 → 升级复活（可能已死或加血无效）
      if (nowMs - dungeonLastHealAt > 3000) {
        dungeonLastHealAt = nowMs;
        dungeonHealStreak++;
        dg.healsThisGame++;
        if (dungeonHealStreak >= 3) {
          dungeonHealStreak = 0;
          if (nowMs - dungeonLastRezAt > 8000) {
            dungeonLastRezAt = nowMs;
            dg.rezesThisGame++;
            await E(`(function(){ var C=window.__require('ClientEventMgr').default; C.emit('liveBaseData',{roomId:${JSON.stringify(String(CFG.room.roomId))},action:'Comment',uid:${JSON.stringify(String(STREAMER.uid))},name:${JSON.stringify(STREAMER.uname)},info:'复活'}); })()`).catch(function () {});
            log('  [地下城·战斗] 连续加血无效→复活(耗10金)');
          }
        } else {
          await E(`(function(){ var C=window.__require('ClientEventMgr').default; C.emit('liveBaseData',{roomId:${JSON.stringify(String(CFG.room.roomId))},action:'Comment',uid:${JSON.stringify(String(STREAMER.uid))},name:${JSON.stringify(STREAMER.uname)},info:'加血'}); })()`).catch(function () {});
          log('  [地下城·战斗] HP=' + (pct * 100).toFixed(0) + '%→加血(耗3金)');
        }
      }
    } else {
      dungeonHealStreak = 0; // 血量恢复即清零连击
    }
    // TODO(现场校准): 走位躲避（战斗中发【1-9】选位）与 大招 待现场接入
  }

  // 场景保底 + 起始关预置（2026-10-23）
  // 背景：autorun 的「自由模式」默认把游戏落进弹幕狼人杀；且每次重启/新局 gameSetUp 会把 Mgr.lv 重置为 0，
  // 导致「从 80 关开始」的预置屡次丢失。这里在 gacha 主循环里自动：① 场景不是地下城 → 调 Canvas 根组件 loadGame 切回；
  // ② Mgr.lv < CFG.gacha.startLv → 置位 startLv。
  // 教训（2026-10-24 01:35 事故）：场景保底曾与 startLv 绑定（startLv=0 时整体早退）——用户把表单预置值改成 0 后，
  // 游戏漂进一局狼人杀，导演对着狼人杀画面盲发「报名/开始」，把 5 个账号喂进了那局狼人杀。
  // 现改为：场景保底始终生效（与 startLv 无关），只有「关卡预置」受 startLv>0 控制。
  // 语义实证（22:32 日志 + bundle TaskSelectState 首行 lv++）：选任务界面执行时 Mgr.lv+1，
  // 故预置 78 → lv++ 后打第 79 关、通关后进 80——即「从第 79 关开始打」；
  // 旧值 79 会被 lv++ 推成 80，实际从 80 关开局（用户 2026-10-23 反馈「怎么还是从80开始」的根因）。
  let lastSceneFixAt = 0;
  async function dungeonEnsureSceneAndLv() {
    const startLv = gStartLv();   // RT 覆盖优先（弹幕「关卡 N」可实时改）；0=从第 1 关打起（不预置，但场景保底仍必须生效）
    const nowMs = Date.now();
    if (nowMs - lastSceneFixAt < 5000) return;   // 5s 节流（loadGame 是异步场景加载，给足切换时间）
    lastSceneFixAt = nowMs;
    try {
      const r = await E(`(function(){
        var out = { switched: false };
        var sc = cc.director.getScene();
        // 1) 地下城容器未激活 → Canvas 根组件的 loadGame 切场景（等价点玩法菜单的「地下城」按钮）
        var bm = null;
        (function w(n){ if(!n||bm) return; if((n.name||'')==='game_bobo_master'){ bm=n; return; } (n.children||[]).forEach(w); })(sc);
        if (!bm || !bm.activeInHierarchy) {
          var loader = null;
          try {
            var canvas = sc.getChildByName('Canvas');
            if (canvas) {
              var cs = canvas.getComponents(cc.Component);
              for (var i=0;i<cs.length;i++){ if (typeof cs[i].loadGame === 'function'){ loader = cs[i]; break; } }
            }
          } catch(e){}
          if (loader) { try{ loader.loadGame('res/livegames/game_bobo_master'); out.switched = true; }catch(e){ out.loadErr = String(e).slice(0,80); } }
        }
        if (out.switched) return JSON.stringify(out);   // 场景切换中，等下一轮再预置 lv（避免被 gameSetUp 覆盖）
        // 2) 关卡预置：lv 低于 startLv 时拉起（推进过 startLv 后不再干预；startLv=0 不预置，从第 1 关打起）
        if (${startLv} > 0) {
          try {
            var M = window.__require('LiveBoBoMasterMgr').default;
            out.lv = M.lv;
            if (M.lv < ${startLv}) { M.lv = ${startLv}; out.lvSet = true; out.lvNow = M.lv; }
          } catch(e){ out.mgrErr = String(e).slice(0,80); }
        }
        return JSON.stringify(out);
      })()`);
      const j = JSON.parse(r);
      if (j.switched) log('  [地下城] 场景保底：已切回地下城（loadGame game_bobo_master）');
      if (j.lvSet) {
        // 新局选择记忆清零：dungeonPickBuff 的防重 key（buffIds 组合）跨局不复位时，
        // 新局第一关若抽到与上局相同的 BUFF 选项组会被整个跳过——这正是「79 关 BUFF 被吞、80 关裸打打不过」的根因
        // （bundle 实证：TaskEndState 中 isWin && lv<100 → setState(TaskBuff)，通关必进投票；丢票纯属导演防重误杀）
        dungeonLastBuffPick = ''; dungeonLastTaskPick = '';
        firstTaskFixed = false;   // 新局重新补选任务
        log('  [地下城] 起始关预置：lv ' + j.lv + ' → ' + j.lvNow + '（选任务界面 lv++ 后即从第 ' + (j.lvNow + 1) + ' 关开打；选择记忆已清零，本关 BUFF 投票正常参与）');
      }
    } catch (e) {}
  }

  // ========== 地图/玩法切换（阶段五：助手 UI「地图切换」卡片 → CFG.gameMode → 热重启 → 本函数落地） ==========
  // 目标地图（gMode() 非 auto）时每轮巡检：精确根节点名（GAME_MODES[m].gameRoot）判就位，防大厅按钮名误命中；
  // entry='select'（狼人杀）：选择屏（path 末段根节点，如 game_select_wolf）出现 → 点 selectBtn（btn_auto=自动/自由模式）；
  // entry='direct'：未就位直接 loadGame(path)。切场景 8s 窗口防重复，选择屏点击 4s 节流。
  let lastModeSwitchAt = 0, lastSelectClickAt = 0, modeSceneReady = false;
  async function ensureModeScene() {
    const m = gMode();
    if (m === 'auto' || m === 'gacha') { modeSceneReady = true; return true; }   // auto 交 detectMode；gacha 归地下城分支管
    const info = GAME_MODES[m];
    if (!info) { modeSceneReady = true; return true; }
    try {
      const selRoot = info.path.split('/').pop();   // 选择屏根节点名（werewolf=game_select_wolf；direct 地图=游戏自身根节点）
      const r = await E(`(function(){
        var out = { hasGame: false, hasSelect: false, by: '' };
        var sc = cc.director.getScene();
        var gameRoot = ${JSON.stringify(info.gameRoot || '')};
        var selRoot = ${JSON.stringify(selRoot)};
        (function w(n,d){
          if(!n||d>12) return;
          try {
            var nm = n.name || '';
            if (gameRoot && nm === gameRoot) { out.hasGame = true; out.by = 'node:' + nm; }
            if (selRoot && nm === selRoot && selRoot !== gameRoot) out.hasSelect = true;
            var cs = n.getComponents ? n.getComponents(cc.Component) : [];
            for (var i=0;i<cs.length;i++){ var cn = cs[i] && cs[i].constructor ? cs[i].constructor.name : ''; if (cn && /${info.sig.source}/i.test(cn)) out.hasGame = true; }
          } catch(e){}
          (n.children||[]).forEach(function(c){ w(c,d+1); });
        })(sc,0);
        return JSON.stringify(out);
      })()`);
      const j = JSON.parse(r || '{}');
      // ① 选择屏在场且目标需经选择屏进入 → 点入口按钮（4s 节流）
      if (info.entry === 'select' && j.hasSelect) {
        if (Date.now() - lastSelectClickAt < 4000) return modeSceneReady;
        lastSelectClickAt = Date.now();
        const ck = await clickBtn(new RegExp('^' + info.selectBtn + '$'));
        if (ck) { log('  [地图切换] 选择屏已出现，点击「' + info.selectBtn + '」进入「' + info.name + '」'); lastModeSwitchAt = Date.now(); }
        return modeSceneReady;
      }
      // ② 已就位
      if (j.hasGame) {
        if (!modeSceneReady) log('  [地图切换] 已就位：「' + info.name + '」（' + (j.by || info.gameRoot) + '）');
        modeSceneReady = true;
        return true;
      }
      // ③ 未就位 → 切场景（8s 窗口防重复 loadGame）
      if (Date.now() - lastModeSwitchAt < 8000) return modeSceneReady;
      lastModeSwitchAt = Date.now();
      modeSceneReady = false;
      const lr = await E(`(function(){
        var sc = cc.director.getScene();
        var canvas = sc.getChildByName('Canvas');
        if (!canvas) return 'no-canvas';
        var cs = canvas.getComponents(cc.Component);
        for (var i=0;i<cs.length;i++){ if (typeof cs[i].loadGame === 'function'){ try { cs[i].loadGame(${JSON.stringify(info.path)}); return 'ok'; } catch(e){ return 'err:' + String(e).slice(0,60); } } }
        return 'no-loader';
      })()`);
      log('  [地图切换] 正在切换到「' + info.name + '」（' + info.path + '）→ ' + lr);
      return modeSceneReady;
    } catch (e) {
      log('  [地图切换] 检测出错: ' + String(e && e.message || e).slice(0, 80));
      return modeSceneReady;
    }
  }

  // 开始键：新局准备屏（Mgr.state=1）会亮出 btn_start，不点就一直卡在准备界面——自动派发 TOUCH_END 开局
  // 前置条件（2026-10-23）：Mgr.lv >= startLv 才点——否则点太早会启动 TaskSelectState 的 lv++ 流程，
  // 把预置（78）和报名保障都打乱（22:32 事故：点开始在预置前，79 关被跳过直接从 80 开局）。
  let lastStartClickAt = 0, lastStartLogAt = 0;
  async function dungeonClickStart() {
    const nowMs = Date.now();
    if (nowMs - lastStartClickAt < 3000) return;   // 3s 节流防重复点
    const startLv = gStartLv();   // RT 覆盖优先（弹幕「关卡 N」可实时改）
    if (startLv) {
      const lvNow = await E(`(function(){ try { return String(window.__require('LiveBoBoMasterMgr').default.lv); } catch(e){ return ''; } })()`).catch(function(){ return ''; });
      if (lvNow !== '' && Number(lvNow) < startLv) return;   // 预置未完成（新局 lv 归 0 中等），不点
    }
    const r = await E(`(function(){
      var sc=cc.director.getScene(); var btns=[];
      (function w(n,d){ if(!n||d>14||btns.length>4) return;
        if((n.name||'')==='btn_start'&&n.activeInHierarchy){ btns.push(n); }
        (n.children||[]).forEach(function(c){w(c,d+1);});
      })(sc,0);
      if(!btns.length) return 'none';
      // 带 mock 事件对象 emit：cc.Button 的 TOUCH_END 处理器会读 event.touch.getLocation() 等，裸 emit 会中途报错
      var mk=function(){ return { getLocation:function(){return cc.v2(0,0);}, getStartLocation:function(){return cc.v2(0,0);}, getPreviousLocation:function(){return cc.v2(0,0);}, getDelta:function(){return cc.v2(0,0);}, getLocationX:function(){return 0;}, getLocationY:function(){return 0;}, getID:function(){return 0;} }; };
      var mockEvent={ touch:mk(), target:btns[0], currentTarget:btns[0], type:cc.Node.EventType.TOUCH_END, stopPropagation:function(){}, preventDefault:function(){} };
      var err1='';
      try{ btns[0].emit(cc.Node.EventType.TOUCH_END, mockEvent); }catch(e){ err1=String(e.message).slice(0,60); }
      return 'clicked(total '+btns.length+')'+(err1?' mockErr:'+err1:'');
    })()`).catch(function(){ return 'err'; });
    if (r && r !== 'none') {
      lastStartClickAt = nowMs;
      if (nowMs - lastStartLogAt > 10000) { lastStartLogAt = nowMs; log('  [地下城] 已点「开始」键开局 (' + r + ')'); }
    }
  }

  // 账号进场保障（2026-10-23 修复「只有主播号在动，是不是还少了几个账号」）
  // bundle 实证（StartState）：新局只给主播号（anchor_info.uid）自动建玩家 + 播「报名成功!!」；
  // 其余号必须由直播服务器处理「报名」弹幕、在报名窗口期（准备屏，约29s）内推送进场。
  // 旧链路两个断点：① join 分支被战斗词优先级吞掉，机器人号从未发报名；
  //              ② dungeonClickStart 太早点「开始」键直接关闭报名窗口。
  // 现在：点开始键之前，先读 LiveBoBoMasterMgr.gamePlayers，未进场且准备屏亮着（btn_start active）→ 补发报名并等生效。
  let acctEnsureAt = 0, acctEnsureRound = 0;
  async function dungeonEnsureAccountsIn() {
    const joinCmd = (CFG.gacha && CFG.gacha.commands && CFG.gacha.commands.join) || '报名';
    const nowMs = Date.now();
    if (nowMs - acctEnsureAt < 3000) return;   // 3s 节流
    acctEnsureAt = nowMs;
    let j;
    try {
      const r = await E(`(function(){
        var M = window.__require('LiveBoBoMasterMgr').default;
        var inSet = {};
        try { if (M.gamePlayers) { M.gamePlayers.forEach(function(v,k){ inSet[String(k)]=1; }); } } catch(e){}
        var ready = false;   // 准备屏亮着「开始」键 = 报名窗口未关
        var sc = cc.director.getScene();
        (function w(n,d){ if(!n||d>14||ready) return;
          if((n.name||'')==='btn_start'&&n.activeInHierarchy){ ready=true; return; }
          (n.children||[]).forEach(function(c){w(c,d+1);});
        })(sc,0);
        return JSON.stringify({ in: inSet, lv: M.lv, state: M.state, ready: ready });
      })()`);
      j = JSON.parse(r);
    } catch (e) { return; }
    if (!j || !j.in) return;
    if (!j.ready) { acctEnsureRound = 0; return; }              // 报名窗口未开（战斗/结算中）：不浪费弹幕，轮次复位
    const outside = PLAYING.filter(a => !j.in[String(a.uid)]);
    if (!outside.length) { acctEnsureRound = 0; return; }       // 全员进场
    if (acctEnsureRound >= 2) return;                           // 本局已补 2 轮未果：停手防限流，等下局
    acctEnsureRound++;
    log('  [地下城] 账号进场保障：' + outside.length + '/' + PLAYING.length + ' 个账号未进场（第' + acctEnsureRound + '轮）: ' + outside.map(a => a.uname).join(' / '));
    for (const acc of outside) { await dm(acc, joinCmd, true); }
    for (let i = 0; i < 10; i++) {                              // 等弹幕生效（B站弹幕→游戏长连接有延迟）
      await sleep(1000);
      try {
        const r2 = await E(`(function(){
          var M = window.__require('LiveBoBoMasterMgr').default;
          var inSet = {};
          try { if (M.gamePlayers) { M.gamePlayers.forEach(function(v,k){ inSet[String(k)]=1; }); } } catch(e){}
          var ready = false;
          var sc = cc.director.getScene();
          (function w(n,d){ if(!n||d>14||ready) return;
            if((n.name||'')==='btn_start'&&n.activeInHierarchy){ ready=true; return; }
            (n.children||[]).forEach(function(c){w(c,d+1);});
          })(sc,0);
          return JSON.stringify({ in: inSet, ready: ready });
        })()`);
        const j2 = JSON.parse(r2);
        if (j2 && j2.in) {
          const still = PLAYING.filter(a => !j2.in[String(a.uid)]);
          if (!still.length) { log('  [地下城] 账号进场保障：' + PLAYING.length + '/' + PLAYING.length + ' 全部进场 ✅'); acctEnsureRound = 0; return; }
        }
        if (j2 && !j2.ready) return;                            // 窗口已关（主播点了开始/倒计时到），停止等待
      } catch (e) {}
    }
    log('  [地下城] 账号进场保障：等待 10s 仍有号未进场（报名窗口可能已关），本局不再补发');
  }

  // 突变开局补选任务（2026-10-23 修复「79 关 BUFF 被吞、80 关裸打打不过」）
  // bundle 实证：TaskBuff.show() 第一行读 selectTask.taskId 取 BUFF 池（buffIds1/2/3）；
  // lv 突变（0→79）跳过了 TaskSelectState → selectTask.taskId=0 → getById(0)=null → show() 抛异常 →
  // 79 关通关后投票界面胎死腹中 → 80 关无 BUFF 开打（探测实锤：selectBuff={buffId:0,buffIds:[]}）。
  // 修复：预置后把 selectTask.taskId 补成起始关任务池第一个，79 关通关后 TaskBuff 正常弹投票，dungeonPickBuff 正常参与。
  let firstTaskFixed = false;
  async function dungeonEnsureFirstTask() {
    if (firstTaskFixed) return;
    const startLv = gStartLv();   // RT 覆盖优先（弹幕「关卡 N」可实时改）
    if (!startLv) return;
    try {
      const r = await E(`(function(){
        var M = window.__require('LiveBoBoMasterMgr').default;
        var ok = false;
        try { ok = !!(M.selectTask && M.selectTask.taskId && window.config.BoboMonsterEndlessTask.getById(M.selectTask.taskId)); } catch(e){}
        if (ok || M.lv !== ${startLv}) return JSON.stringify({ skip: true, lv: M.lv, taskId: M.selectTask && M.selectTask.taskId });
        var lvCfg = window.config.BoboMonsterEndless.getById(${startLv});
        var tid = lvCfg && lvCfg.endlessTaskIds1 && lvCfg.endlessTaskIds1[0];
        if (!tid) return JSON.stringify({ err: 'no task pool' });
        M.selectTask = { taskId: tid, lv: 0, index: 0 };
        var tk = window.config.BoboMonsterEndlessTask.getById(tid);
        return JSON.stringify({ fixed: true, taskId: tid, name: tk && tk.name });
      })()`);
      const j = JSON.parse(r);
      if (j && j.fixed) {
        firstTaskFixed = true;
        log('  [地下城] 突变开局补选任务：selectTask.taskId 0 → ' + j.taskId + '（' + j.name + '）——保证本关通关后 BUFF 投票正常弹出，下一关带 BUFF 打');
      }
    } catch (e) {}
  }

  // 扭蛋保底（2026-10-24 用户改口：「抽扭蛋改20，手套披风那部分去掉」——10-23 旧需求「10级及以上+能抽到手套披风」作废）
  // bundle 实证：弹幕「抽N个」→ game-service.GameService.reqLiveBoBoPlayerMasterDrawFreeOrProp({count}) → 服务端返回 rewards
  // （Map：键 "type_id"、value=数量；sortRewards/Reward.play 从【键】解析类型与装备 id：
  //   t=equip_0~equip_19(100~119) 时显示「lv.(t-100+1)」→ t=119 → lv.20；s=装备 id，如 牛鬼手套11013/火龙12013/龙须虎13013）
  // 装备表 BoboMonsterEquip：type 5=gloves 手套 / 6=cloak 披风（本版本不再强制，保留服务端原装备）
  // 注意：game-service 模块导出为 {__esModule:true, GameService:{...}}，没有 .default —— 方法在 .GameService 上（探测实证，曾因误用 .default 报 TypeError）
  // 本 hook 为本地显示层（与 BUFF×999 / 排行榜钉分同性质）：抽奖动画与本地库存变 20 级，服务端档案不变
  // 【坑】页面幂等标志必须换名（__draw10 → __draw20）：运行中的页面已置 __draw10=true，沿用旧名会让新 hook 整个被跳过
  let dungeonDraw20Done = false;
  async function dungeonPatchDraw20() {
    if (dungeonDraw20Done) return;
    try {
      const r = await E(`(function(){
        if (window.__draw20) return JSON.stringify({ok:true,skipped:true});
        var M = window.__require('LiveBoBoMasterMgr').default;
        // ① 库存 hook：getMasterData 返回的每个装备方案 → 全部装备 lv 抬到 >=20（不再强制手套/披风槽位）
        var origGM = M.getMasterData;
        M.getMasterData = function(uid, name, force) {
          return origGM.call(this, uid, name, force).then(function(md){
            try {
              if (md && md.equipList) {
                for (var i in md.equipList) {
                  var ce = md.equipList[i] && md.equipList[i].curEquips;
                  if (!ce) continue;
                  for (var k in ce) { if (ce[k]) ce[k].lv = Math.max(20, Number(ce[k].lv) || 0); }
                }
              }
            } catch(e){}
            return md;
          });
        };
        // ② 抽奖响应 hook：rewards Map 等级位统一改成 equip_19（lv.20），装备 id 保留服务端原样
        // （类型/装备 id 由 Map 键 "type_id" 决定、value 是数量 → 键值必须一起换，只改 value 无效）
        var GS = window.__require('game-service').GameService;
        function patchDraw(name) {
          var orig = GS[name];
          if (typeof orig !== 'function') return;
          GS[name] = function(params) {
            return orig.call(this, params).then(function(resp){
              try {
                var d = resp && resp.getData ? resp.getData() : null;
                var rw = d && d.rewards;
                if (rw && typeof rw.forEach === 'function' && typeof rw.set === 'function') {
                  var nm = new Map();
                  rw.forEach(function(v, k){
                    var m = /^(\\d+)_(\\d+)$/.exec(String(k));
                    if (m) nm.set('119_' + m[2], v);   // 等级位 equip_19 = lv.20，装备 id 不变
                    else nm.set(k, v);                 // 键格式不符 → 原样保留，不猜
                  });
                  d.rewards = nm;
                }
              } catch(e){}
              return resp;
            });
          };
        }
        patchDraw('reqLiveBoBoPlayerMasterDrawFreeOrProp');   // 弹幕「抽N个」
        patchDraw('reqLiveBoBoPlayerMasterDrawGift');         // 礼物抽奖（同响应类型 Game_ResLiveBoBoPlayer）
        window.__draw20 = true;
        return JSON.stringify({ok:true});
      })()`);
      const j = JSON.parse(r);
      if (j && j.ok) {
        dungeonDraw20Done = true;
        if (!j.skipped) log('  [地下城·扭蛋] 已启用保底：抽奖必出 20 级装备（保留服务端原装备，不再限定手套/披风），本地库存全部装备 lv20');
      }
    } catch (e) { /* 页面未就绪，下轮重试 */ }
  }

  // ---------- 关卡无限循环（用户 2026-10-23：「不打100关能不能自动循环关卡自定义关卡做无限循环」） ----------
  // 语义：BUFF 投票屏/结算屏出现时，若 Mgr.lv >= endLv（实战关号）且循环开启 → 把 Mgr.lv 拨回 startLv，
  // 下一关即从 startLv+1 重新开打——即「自定义关卡段无限循环」。
  // 拨回点选这两个屏的实证依据：此刻 TaskSelectState 的 lv++ 尚未发生（M.lv=刚通关的关号），
  // 且 gameSetUp 只在新局报名后跑——直接改 M.lv 干净生效；配合选择记忆清零，新一段 BUFF 投票正常参与。
  let lastLoopLogAt = 0;
  async function dungeonLoopCheck() {
    if (!gLoopOn()) return;
    try {
      const r = await E(`(function(){
        try { return JSON.stringify({ lv: window.__require('LiveBoBoMasterMgr').default.lv }); }
        catch(e){ return JSON.stringify({ err: String(e).slice(0,80) }); }
      })()`);
      const j = JSON.parse(r);
      if (!j || typeof j.lv !== 'number') return;
      const endLv = gEndLv();
      if (j.lv < endLv) return;
      const maxR = gMaxRounds();
      if (maxR > 0 && dg.loopRounds >= maxR) {
        if (Date.now() - lastLoopLogAt > 60000) { lastLoopLogAt = Date.now(); log('  [地下城·循环] 已达轮次上限 ' + maxR + ' 轮，停止循环（助手可改大 maxRounds 或置 0 无限）'); }
        return;
      }
      const startLv = gStartLv();
      const r2 = await E(`(function(){
        try {
          var M = window.__require('LiveBoBoMasterMgr').default;
          M.lv = ${startLv};
          return JSON.stringify({ ok: true, lv: M.lv });
        } catch(e){ return JSON.stringify({ ok:false, err: String(e).slice(0,80) }); }
      })()`);
      const j2 = JSON.parse(r2);
      if (j2 && j2.ok) {
        dg.loopRounds++;
        dg.endRecorded = false;
        // 新循环段选择记忆清零（否则与上段相同的 BUFF 选项组会被防重逻辑吞掉）
        dungeonLastBuffPick = ''; dungeonLastTaskPick = '';
        firstTaskFixed = false;
        dg.gameStartAt = Date.now(); dg.maxLvThisGame = 0; dg.healsThisGame = 0; dg.rezesThisGame = 0;
        log('  🔁 [地下城·循环] 第 ' + dg.loopRounds + ' 轮：到达第 ' + j.lv + ' 关（endLv=' + endLv + '）→ 拨回 lv=' + j2.lv + '，从第 ' + (j2.lv + 1) + ' 关继续刷' + (maxR > 0 ? '（上限 ' + maxR + ' 轮）' : '（无限循环）'));
        postDungeon();
        try { dkb.data.rounds.push({ at: new Date().toISOString(), round: dg.loopRounds, fromLv: j.lv, toLv: j2.lv }); dkb.save(); } catch (e) {}
      }
    } catch (e) { /* Mgr 未就绪，下轮重试 */ }
  }

  // ---------- 读取观众评论（弹幕指令 + 情绪统计） ----------
  // 通道：导演早已向游戏页注入 window.__DMDATA（300 条环形缓冲，钩 ClientEventMgr.on('liveBaseData')）。
  // 支持的弹幕指令（忽略自己人/主播号，与狼人杀 pollDanmaku 同一口径）：
  //   策略 攻击|均衡|防御        → 切换选卡策略（RT 覆盖，重启回配置值）
  //   倍率 N                    → BUFF 倍率实时改（表重载/下一局生效）
  //   关卡 N                    → 起始关预置值实时改（用户口径「关卡 79」= 从第 79 关打 → 预置 78）
  //   循环 N-M / 循环 开 / 循环 关 → 关卡段循环（到达 M 关拨回、从 N 关重刷）
  //   地图 X                    → 切地图/玩法（地下城|狼人杀|颜色|放学|物理学|抢球|跨房|鼠王|舞台|航海|打捞|宠物|修仙|自动；RT 覆盖，重启回配置值）
  //   状态                      → 主播号代回复当前参数/战绩摘要（也写日志）
  // 同时统计观众情绪：加油/打不过/太难 → struggle；牛/厉害/通关 → cheer（供 autoTune 参考）
  let lastDmPollAt = 0, lastSentSaved = 0;
  async function dungeonPollDanmaku() {
    if (Date.now() - lastDmPollAt < 1200) return;   // 主循环 1.5s 一轮，这里双保险限流
    lastDmPollAt = Date.now();
    let data = [];
    try { data = await E('JSON.stringify(window.__DMDATA||[])'); data = JSON.parse(data); } catch (e) { return; }
    if (!Array.isArray(data) || !data.length) return;
    const now = Date.now();
    const fresh = data.filter(d => d && d.t && now - d.t < 60000);
    for (const d of fresh) {
      if (MY.has(d.u) || Number(d.u) === Number(STREAMER.uid)) continue;   // 忽略自己人
      const txt = (d.i || '').trim();
      if (!txt) continue;
      // —— 情绪统计（先于指令匹配：一句里可以同时带情绪和指令）——
      if (/加油|打不过|太难|虐|惨|刮痧|救命|帮忙/.test(txt)) dg.struggle++;
      if (/牛|厉害|通关|666|赢了|好强|大佬|崇拜|飞起/.test(txt)) dg.cheer++;
      // —— 指令解析 ——
      let m;
      if ((m = /^策略\s*(攻击|均衡|防御|平衡|resist|attack|balanced)\s*$/i.exec(txt))) {
        const mm = ({ '攻击': 'attack', '均衡': 'balanced', '平衡': 'balanced', '防御': 'resist', 'resist': 'resist', 'attack': 'attack', 'balanced': 'balanced' })[String(m[1]).toLowerCase()] || 'attack';
        RT.strategyMode = mm; RT.weights = null; RT.src.strategy = '弹幕:' + d.n;
        dg.lastCmd = '策略→' + mm; dg.lastCmdBy = d.n;
        log('  💬 [地下城·弹幕指令] ' + d.n + '：「' + txt + '」→ 选卡策略切换为「' + mm + '」（下一场 BUFF 投票生效；重启恢复配置值）');
      } else if ((m = /^倍率\s*[xX×]?\s*(\d{1,5})$/.exec(txt))) {
        const v = Math.max(1, Math.min(999999, Number(m[1])));
        RT.buffMultiplier = v; RT.src.buffMultiplier = '弹幕:' + d.n;
        dungeonBuffsDone = false;   // 倍率变了 → 下次 dungeonPatchBuffs 从原始快照重新应用
        dg.lastCmd = '倍率→×' + v; dg.lastCmdBy = d.n;
        log('  💬 [地下城·弹幕指令] ' + d.n + '：「' + txt + '」→ BUFF 倍率改为 ×' + v + '（表重载/下一局生效）');
      } else if ((m = /^关卡\s*(\d{1,3})$/.exec(txt))) {
        const v = Math.max(0, Math.min(99, Number(m[1]) - 1));   // 用户口径「关卡 79」= 从第 79 关打 → 预置 78
        RT.startLv = v; RT.src.startLv = '弹幕:' + d.n;
        firstTaskFixed = false;
        dg.lastCmd = '关卡→第' + (v + 1) + '关'; dg.lastCmdBy = d.n;
        log('  💬 [地下城·弹幕指令] ' + d.n + '：「' + txt + '」→ 起始关预置 ' + v + '（下一局从第 ' + (v + 1) + ' 关开打）');
      } else if ((m = /^循环\s*(\d{1,3})\s*[-~到至]\s*(\d{1,3})$/.exec(txt))) {
        let a = Number(m[1]), b = Number(m[2]);
        if (a > b) { const t = a; a = b; b = t; }
        RT.startLv = Math.max(0, a - 1); RT.endLv = b; RT.loopEnabled = true; RT.src.loop = '弹幕:' + d.n;
        firstTaskFixed = false;
        dg.lastCmd = '循环→' + a + '~' + b + '关'; dg.lastCmdBy = d.n;
        log('  💬 [地下城·弹幕指令] ' + d.n + '：「' + txt + '」→ 关卡循环 ' + a + '~' + b + ' 关已开启（到达 ' + b + ' 关拨回 ' + a + ' 关重刷）');
      } else if (/^循环\s*(开|开启|打开|on)$/i.test(txt)) {
        RT.loopEnabled = true; RT.src.loop = '弹幕:' + d.n;
        dg.lastCmd = '循环→开'; dg.lastCmdBy = d.n;
        log('  💬 [地下城·弹幕指令] ' + d.n + '：循环已开启（到达 ' + gEndLv() + ' 关拨回、从第 ' + (gStartLv() + 1) + ' 关重刷）');
      } else if (/^循环\s*(关|关闭|停止|off)$/i.test(txt)) {
        RT.loopEnabled = false; RT.src.loop = '弹幕:' + d.n;
        dg.lastCmd = '循环→关'; dg.lastCmdBy = d.n;
        log('  💬 [地下城·弹幕指令] ' + d.n + '：循环已关闭（打到 ' + gEndLv() + ' 关后停止）');
      } else if ((m = /^(?:地图|玩法|模式)\s*(?:到|去|切换成?|换)?\s*(地下城|gacha|狼人杀|弹幕狼人杀|狼人|颜色|放学|物理学|抢球|跨房|鼠王|舞台|航海|打捞|宠物|修仙|自动)\s*$/i.exec(txt))) {
        const MAP_ALIAS = { '地下城': 'gacha', 'gacha': 'gacha', '狼人杀': 'werewolf', '弹幕狼人杀': 'werewolf', '狼人': 'werewolf', '颜色': 'rouge', '放学': 'chump', '物理学': 'greatsword', '抢球': 'ball', '跨房': 'frameball', '鼠王': 'draw', '舞台': 'dj', '航海': 'hd', '打捞': 'jz', '宠物': 'pet', '修仙': 'xiuxian', '自动': 'auto' };
        const mm = MAP_ALIAS[String(m[1]).toLowerCase()] || MAP_ALIAS[m[1]] || 'gacha';
        RT.gameMode = mm; RT.src.gameMode = '弹幕:' + d.n;
        modeSceneReady = false;   // 目标变了 → 重新巡检就位（gacha 目标由地下城分支的场景保底切回）
        dg.lastCmd = '地图→' + mm; dg.lastCmdBy = d.n;
        const gname = mm === 'auto' ? '自动识别' : (GAME_MODES[mm] ? GAME_MODES[mm].name : mm);
        log('  💬 [地下城·弹幕指令] ' + d.n + '：「' + txt + '」→ 正在切换到「' + gname + '」（' + (mm === 'auto' ? '按当前场景自动识别' : (GAME_MODES[mm] && GAME_MODES[mm].autoDrive ? '导演自动驱动' : '仅切场景，手动玩')) + '；重启恢复配置值）');
      } else if (/^状态$/.test(txt)) {
        const st = dkb.data.stats;
        const msg = '状态：第' + dungeonLv + '关 策略=' + gStrategy().mode + ' 倍率=×' + gMult() + ' 加血=' + gHealPct() + '% 循环=' + (gLoopOn() ? ('开(' + (gStartLv() + 1) + '→' + gEndLv() + '关,已' + dg.loopRounds + '轮)') : '关') + ' 战绩=' + st.wins + '胜' + st.loses + '负(最佳' + st.bestLv + '关)';
        log('  💬 [地下城·弹幕指令] ' + d.n + ' 查询状态 → ' + msg);
        try { await dm(STREAMER, msg.slice(0, 55), false, true); } catch (e) {}   // 主播号代回复（弹幕可见；keep=true 被抢占时重排不丢）
      }
    }
    // 情绪计数落库（有变化才写盘）
    const sv = dkb.data.sentiment;
    if (dg.struggle !== sv.struggle || dg.cheer !== sv.cheer) {
      sv.struggle = dg.struggle; sv.cheer = dg.cheer;
      if (Date.now() - lastSentSaved > 30000) { lastSentSaved = Date.now(); dkb.save(); }
    }
    // 清空页面缓冲（已读完；gacha 模式不走狼人杀 pollDanmaku，不会丢狼人杀弹幕）
    try { await E('window.__DMDATA.length = 0'); } catch (e) {}
  }

  // ---------- 自主决策：知识库记录 + 规则反思 + 可选 LLM 思考 ----------
  // 「读取评论自己思考升级」落地为三层：
  //   ① 记录：每局胜负/关卡/参数快照写 dkb（rounds/stats/levelStats/sentiment）
  //   ② 规则反思（think.autoTune，默认开）：连败≥2 → 自动切均衡策略+提高加血阈值；连胜 → 记录维持
  //   ③ LLM 思考（think.llm.enabled，默认关）：每 everyLevels 关调 Brain 做一次 JSON 决策（失败静默回退规则层）
  function dungeonRecordEnd(info) {
    if (dg.endRecorded) return;
    dg.endRecorded = true;
    const lv = dungeonLv || 0;
    const win = /胜利|成功|通关|win/i.test(info && info.res || '') || (lv >= gEndLv());
    const rec = {
      at: new Date().toISOString(), win: win, lv: lv,
      strategy: gStrategy().mode, mult: gMult(), healPct: gHealPct(),
      heals: dg.healsThisGame, rezes: dg.rezesThisGame,
      durationMs: dg.gameStartAt ? Date.now() - dg.gameStartAt : 0,
    };
    try {
      dkb.data.rounds.push(rec);
      dkb.data.stats.games++;
      if (win) dkb.data.stats.wins++; else dkb.data.stats.loses++;
      dkb.data.stats.totalLevels += lv;
      if (lv > dkb.data.stats.bestLv) dkb.data.stats.bestLv = lv;
      const ls = dkb.data.levelStats[String(lv)] || { plays: 0, wins: 0 };
      ls.plays++; if (win) ls.wins++;
      dkb.data.levelStats[String(lv)] = ls;
      dkb.save();
    } catch (e) { /* 磁盘异常不致命 */ }
    log('  🧠 [地下城·知识库] 本局记录：' + (win ? '胜利' : '失败') + ' lv=' + lv + ' 参数(策略=' + rec.strategy + ' 倍率=×' + rec.mult + ' 加血=' + rec.healPct + '%) 累计 ' + dkb.data.stats.wins + '胜/' + dkb.data.stats.loses + '负 最佳=' + dkb.data.stats.bestLv + '关');
    if (gAutoTune()) dungeonAutoTune();
  }

  // 规则反思：根据近期战绩自主调参（只改 RT，不写盘；导演重启回配置值——助手表单永远是最终话语权）
  let lastAutoTuneAt = 0;
  function dungeonAutoTune() {
    const now = Date.now();
    if (now - lastAutoTuneAt < 60000) return;   // 1min 内不重复调
    lastAutoTuneAt = now;
    let recent = [];
    try { recent = (dkb.data.rounds || []).filter(r => r && typeof r.win === 'boolean').slice(-3); } catch (e) { return; }
    if (recent.length < 2) return;
    const loses = recent.filter(r => !r.win).length;
    const strat = gStrategy();
    if (loses >= 2 && strat.mode !== 'resist') {
      RT.strategyMode = 'balanced'; RT.weights = null;
      RT.healPct = 60;
      RT.src.strategy = 'autoTune'; RT.src.healPct = 'autoTune';
      try {
        dkb.data.learned = { strategy: 'balanced', healPct: 60, note: '连败' + loses + '局→切均衡+加血阈值提60%（' + new Date().toISOString() + '）' };
        dkb.save();
      } catch (e) {}
      log('  🧠 [地下城·自主调参] 近3局负' + loses + '局 → 策略切「均衡」、加血阈值提至 60%（活着才有输出；重启恢复配置值）');
    } else if (recent.length >= 2 && recent.every(r => r.win)) {
      try {
        dkb.data.learned = { strategy: strat.mode, healPct: gHealPct(), note: '连胜' + recent.length + '局→维持 ' + strat.mode + '（' + new Date().toISOString() + '）' };
        dkb.save();
      } catch (e) {}
      log('  🧠 [地下城·自主调参] 近' + recent.length + '局全胜 → 维持策略「' + strat.mode + '」不动');
    }
  }

  // LLM 思考（可选）：每 everyLevels 关让本地/远程 OpenAI 兼容模型基于当前局面做一次 JSON 决策。
  // 输出约定：{"strategy":"attack|balanced|resist","healPct":30~80,"note":"一句话理由"}；解析失败忽略。
  // 绝不阻塞主循环：health 探测 + 超时都由 Brain 内部控制，异常静默回退规则层。
  let dungeonBrain = null;
  async function dungeonThink() {
    const lc = gLlmCfg();
    if (!lc || !lc.enabled || !lc.model) return;
    const every = Math.max(1, Number(lc.everyLevels || 10));
    if (!(dungeonLv > 0 && (dungeonLv - dg.lastLlmLv >= every))) return;
    if (Date.now() - dg.lastLlmAt < 90000) return;   // 90s 节流（LLM 慢，别刷）
    dg.lastLlmAt = Date.now(); dg.lastLlmLv = dungeonLv;
    try {
      if (!dungeonBrain) {
        const { Brain } = require('./src/brain');
        dungeonBrain = new Brain(Object.assign({}, CFG.brain || {}, {
          baseUrl: lc.baseUrl, apiKey: lc.apiKey || 'ollama', model: lc.model,
          system: '你是弹幕关卡游戏「地下城」的AI导演，根据局面输出JSON决策，不要解释。',
          maxTokens: 160, temperature: 0.4, timeoutMs: 15000,
        }));
      }
      const st = dkb.data.stats;
      const prompt = '当前第' + dungeonLv + '关（目标' + gEndLv() + '关），近期' + st.games + '局' + st.wins + '胜' + st.loses + '负，' +
        '当前策略=' + gStrategy().mode + '，BUFF倍率=×' + gMult() + '，加血阈值=' + gHealPct() + '%，' +
        '观众情绪(加油/打不过类=' + dg.struggle + ',欢呼类=' + dg.cheer + ')。' +
        '只输出JSON：{"strategy":"attack|balanced|resist","healPct":30到80的整数,"note":"15字内理由"}';
      const txt = await dungeonBrain.chat(prompt);
      const j = JSON.parse(String(txt).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1'));
      if (j && STRATEGY_PRESETS[j.strategy]) {
        RT.strategyMode = j.strategy; RT.weights = null;
        if (j.healPct) RT.healPct = Math.max(5, Math.min(95, Number(j.healPct) || 40));
        RT.src.strategy = 'llm'; RT.src.healPct = 'llm';
        log('  🤖 [地下城·AI思考] 第' + dungeonLv + '关 LLM决策：策略→' + j.strategy + ' 加血→' + gHealPct() + '%（' + (j.note || '') + '）');
      }
    } catch (e) {
      if (dg.lastLlmLv === dungeonLv && Date.now() - dg.lastLlmAt < 5000) log('  🤖 [地下城·AI思考] LLM 不可用，回退规则层决策（' + String(e && e.message || e).slice(0, 60) + '）');
    }
  }

  async function handleGacha() {
    const dcfg = CFG.gacha || { enabled: true, commands: { join: '报名', heal: '加血' }, autoNext: true, pollMs: 1500, buffVoteOrder: ['A', 'B', 'C'] };
    await dungeonEnsureSceneAndLv();      // 场景保底 + 起始关预置（幂等，5s 节流）
    await dungeonEnsureFirstTask();       // 突变开局补选任务（治「79 关 BUFF 投票不弹」）
    await dungeonEnsureAccountsIn();      // 账号进场保障：先补发报名并等生效（治「只有主播号在动」）
    await dungeonClickStart();            // 人齐后再点「开始」键（早点会关报名窗口）
    const boost = await ensureRankBoost();
    if (boost && boost.hasSort) log('  🏆 排行榜锁定: ' + JSON.stringify(boost));
    await dungeonPatchBuffs();      // BUFF 数据倍率直改（倍率可配+原始快照，幂等；表未就绪时下轮重试）
    await dungeonPatchDraw20();     // 扭蛋保底：抽奖必出 20 级装备、保留原装备（幂等）
    await dungeonPollDanmaku();     // 读取观众评论：弹幕指令（策略/倍率/关卡/循环/状态）+ 情绪统计
    const ph = await dungeonPhaseUI();
    dgPhase = ph.phase;
    log('  [地下城] 阶段=' + ph.phase + (ph.txt ? ' | ' + ph.txt.slice(0, 80) : ''));
    if (ph.phase === 'join') {
      const clicked = await clickBtn(/加入|开始|进入|队伍/);
      if (!clicked) { for (const acc of PLAYING) { await dm(acc, dcfg.commands.join, true); await sleep(500); } }
    } else if (ph.phase === 'buff') {
      await dungeonPickBuff();
      await dungeonLoopCheck();          // 关卡循环：到达 endLv 且循环开 → 拨回 startLv 继续刷
    } else if (ph.phase === 'task') {
      await dungeonPickTaskOrDiff();
    } else if (ph.phase === 'end') {
      await dungeonHandleEnd();
      await dungeonLoopCheck();          // 结算屏也检查一次（通关/失败都走这里）
    } else if (ph.phase === 'combat') {
      await dungeonCombat();
      await dungeonThink();              // 定时自主思考（LLM 开时每 N 关一次；规则层 autoTune 在结算时兜底）
    } else if (ph.phase === 'next') {
      if (dcfg.autoNext) { const clicked = await clickBtn(/再来一局|下一关|继续|重开|通关/); if (clicked) { log('  🔁 [地下城] 下一关'); await sleep(1500); } }
    }
    postDungeon();   // 状态上报助手 UI（函数内节流）
  }

  // ---------- 主循环 ----------
  log('进入主循环（每 400ms 读状态，NPC 反应延迟 ' + REACT_MIN + '-' + REACT_MAX + 'ms）');
  // 新局重置：一局结束后清空阶段记录/开始标志/信念模型，让同一进程能连续开新局
  function resetForNewGame() {
    done.clear();
    started = false;
    lastDeadCount = 0; lastTop = ''; lastKill = 0; lastLife = 0;
    lastWelfare = 0; lastFiller = 0; lastPhaseSay = '';
    minds.clear();
    skillPrev = null;
    humanSeats.clear();   // 真人接管座位本局清零（新局由真人重新报名）
    lastAutoNextAt = 0;   // 自动下一局节流复位（结束屏出现即尽快尝试点击「再来一局」）
    log('  🔄 本局结束，导演状态已重置——等待新局（5 个账号将全部报名参赛）');
  }
  const loopStart = Date.now();
  let lastKey = '', lastWelfare = 0, lastFiller = 0, lastPhaseSay = '';
  let lastBeatAt = 0; // 心跳过期巡检计时
  let lastProgressAt = Date.now(); // 剧本心跳：最近一次阶段推进时间
  let scriptErrStreak = 0;         // 剧本心跳：连续阶段报错次数（达上限则安全重启导演）
  let endHandledKey = null;        // 本局结束只播报一次（避免停在 End 屏时反复重播）
  let lastAutoNextAt = 0;          // 自动下一局：上次尝试点击「再来一局」的时间（5s 节流；离开 End(8) 时复位）
  let autoNextClicks = 0;          // 自动下一局点击次数封顶（原无上限，避免结束屏卡住时无限点击）
  let mode = 'unknown', lastModeCheck = 0, lastGM = ''; // 'werewolf' | 'gacha' | 'lobby' | 'unknown'
  let gachaBuffIdx = -1;           // Gacha 增益投票轮转游标
  // 目标玩法固定（用户 2026-10-23 明确要求地下城）；UI「地图切换」卡片可改 CFG.gameMode 切到任意地图，弹幕「地图 X」可实时覆盖。
  // 页面全局仅作调试可见（detectMode 以 worker 侧 gMode() 为唯一真源，每次现取，防 RT 覆盖后页面全局 stale 造成拉锯）；
  // __directorWantGacha 为旧版兼容标志（auto 模式下按场景识别时的兜底）。
  try {
    await E('window.__directorWantMode = ' + JSON.stringify(gMode()) + '; window.__directorWantGacha = ' + (CFG.gacha && CFG.gacha.enabled !== false ? 'true' : 'false') + ';');
  } catch (e) {}
    while (true) {
      await checkEpoch();            // 若主进程已启动更新 epoch 的实例，本实例主动退出让位
    // 模式识别（每 2s 一次，避免每帧扫场景）：Gacha 怪兽模式自动适配
    // gMode() 变化（弹幕「地图 X」实时覆盖）时立即重判，防止用 stale mode 走错分支（与地图切换拉锯）
    const now0 = Date.now();
    if (now0 - lastModeCheck > 2000 || gMode() !== lastGM) {
      lastModeCheck = now0; lastGM = gMode();
      try { mode = await detectMode(); } catch (e) { mode = 'unknown'; }
    }
      // 阶段五：目标地图切换——UI「地图切换」卡片写 CFG.gameMode，热重启后由 ensureModeScene 落地切场景
      if (gMode() !== 'auto') {
        try { await ensureModeScene(); } catch (e) { log('  [地图切换] 出错: ' + (e && e.message || e)); }
        if (!modeSceneReady) { await sleep(1000); continue; }   // 场景切换中，等落地再走玩法逻辑
        // 无自动驾驶的地图（颜色/放学/物理学）：只做弹幕指令+状态轮询，不跑狼人杀状态机（避免刷读状态报错）
        if (!GAME_MODES[gMode()].autoDrive) {
          await dungeonPollDanmaku();   // 弹幕指令仍可用（可发「地图 地下城」切回）
          postDungeon();
          await sleep(CFG.gacha.pollMs || 1500);
          continue;
        }
      }
      if (mode === 'gacha' && CFG.gacha.enabled !== false) {
      try { await handleGacha(); } catch (e) { log('  [Gacha] 处理出错: ' + e.message); }
      await sleep(CFG.gacha.pollMs || 1500);
      continue;                    // Gacha 模式不走狼人杀状态机/福利调度
    }
    let st;
    try { st = await readState(); } catch (e) { log('  读状态失败: ' + e.message); await sleep(1000); continue; }
    if (st.state !== 8) { endHandledKey = null; lastAutoNextAt = 0; autoNextClicks = 0; } // 离开结束屏后复位，下一局结束可再次播报/自动开局
    // 心跳过期巡检（约 20s 一次）：画面出现「心跳过期」= 直播连接已断 → 退出，
    // 由 _supervise.sh 守护链自动跑 reload→身份码→进房→导演 完整重启
    if (Date.now() - lastBeatAt > CFG.chain.heartbeatCheckMs) {
      lastBeatAt = Date.now();
      try {
        const lab = await E(`(function(){ var out=[]; (function walk(n){ if(!n) return; try { var L=n.getComponent&&n.getComponent(cc.Label); if(L&&L.string&&n.active) out.push(String(L.string).slice(0,30)); } catch(e){} (n.children||[]).forEach(walk); })(cc.director.getScene()); return JSON.stringify(out.slice(0,60)); })()`);
        if (lab && lab.indexOf('心跳过期') !== -1) {
          log('  💔 画面显示「心跳过期」——直播连接中断，退出并重启游戏链路（reload→身份码→进房→导演）');
          process.exit(75);
        }
      } catch (e) { /* 巡检失败不打断主循环 */ }
      // 剧本心跳检测：脚本流程卡死（活跃阶段长时间无推进）或连续报错 → 安全重启导演（绝不关闭游戏窗口）
      const activeStates = [3, 4, 5, 6, 7];
      const stuckMs = CFG.chain.scriptStuckMs || 240000;
      if (activeStates.indexOf(st.state) !== -1 && Date.now() - lastProgressAt > stuckMs) {
        log('  💔 剧本心跳超时（' + Math.round((Date.now() - lastProgressAt) / 1000) + 's 无阶段推进，当前 state=' + st.state + '）——脚本流程疑似卡死，退出并重启导演（游戏窗口保留）');
        process.exit(75);
      }
      const errLimit = CFG.chain.scriptErrLimit || 3;
      if (scriptErrStreak >= errLimit) {
        log('  💔 剧本心跳异常（连续 ' + scriptErrStreak + ' 次阶段报错）——退出并重启导演（游戏窗口保留）');
        process.exit(75);
      }
    }
    const key = st.state + '@' + st.night;
    if (key !== lastKey) {
      lastKey = key;
      lastProgressAt = Date.now(); // 剧本心跳：阶段推进即刷新（卡死检测基准）
      gen++; myGen = gen;
      if (!done.has(key)) {
        done.add(key);
        try {
          if (st.state === 1) await onReady(st);
          else if (st.state === 3) onHide(st);
          else if (st.state === 4) onNight(st);
          else if (st.state === 5) onSelect(st);
          else if (st.state === 6) onVote(st);
          else if (st.state === 7) await onVoteResult(st);
          else if (st.state === 8) {
            if (endHandledKey !== key) { endHandledKey = key; await onEnd(st); resetForNewGame(); }
          }
          scriptErrStreak = 0; // 剧本心跳：仅当某阶段成功跑完才清零报错连击（连续报错才会累计到上限）
        } catch (e) { log('阶段处理出错: ' + e.message); scriptErrStreak++; }
      }
    }
    // 自动下一局（剧本模式）：停留在结束屏(state 8)时，每 5 秒尝试点击「再来一局」，直到离开结束屏。
    // 关键：不再只靠「状态刚变 8」那一轮——按钮出现晚也不会错过；重复点幂等（日志已验证无害）。
    if (st.state === 8 && AUTO_NEXT_GAME && autoNextClicks < 12 && Date.now() - lastAutoNextAt > 5000) {
      lastAutoNextAt = Date.now(); autoNextClicks++;
      try {
        const r = await clickBtn(/再来一局|重新开始|重开/); // 只认重启类按钮，避免结束屏过渡期误点「开始」
        if (r) { log('  🔁 自动开启下一局（点击「再来一局」第' + autoNextClicks + '次）'); await sleep(1200); }
        else log('  🔁 结束屏未找到「再来一局」按钮（' + autoNextClicks + '/12）');
      } catch (_) {}
    }
    // 夜间结果播报（夜→选人 时检测新死者）
    if (st.state === 5) {
      const deadNow = st.dead.length;
      if (deadNow > lastDeadCount) {
        const newDead = deadNow - lastDeadCount;
        lastDeadCount = deadNow;
        const line = commentator.onNightResult(newDead, st.players.length);
        if (line) { log(`  🎙️ ${line}`); await say(line); }
        await sleep(react());
      }
      // 选人领衔者播报
      let top = '', topV = 0;
      Object.entries(st.sel).forEach(([tgt, vs]) => { if (vs.length > topV) { topV = vs.length; top = tgt; } });
      const topNo = st.players.find(p => p.uid === top);
      if (topV >= 3 && top !== lastTop) {
        lastTop = top;
        const line = commentator.onSelectLeader(topNo ? topNo.no : '?', topV, st.players.length);
        if (line) { log(`  🎙️ ${line}`); await say(line); }
      }
      // 平淡期填充
      if (Date.now() - lastFiller > 18000) {
        lastFiller = Date.now();
        const wolvesMin = Math.max(1, Math.ceil(st.players.filter(p => !p.die && p.camp === 2).length));
        const line = commentator.filler(st.players.filter(p => !p.die).length, wolvesMin);
        if (line) { log(`  🎙️ ${line}`); await say(line); }
      }
    }
    // 投票摇摆播报
    if (st.state === 6) {
      if (st.kill.length !== lastKill || st.life.length !== lastLife) {
        const delta = Math.abs(st.kill.length - lastKill) + Math.abs(st.life.length - lastLife);
        lastKill = st.kill.length; lastLife = st.life.length;
        if (delta >= 2) {
          const line = commentator.onVoteSwing(st.kill.length, st.life.length);
          if (line) { log(`  🎙️ ${line}`); await say(line); }
        }
      }
    }
    // 弹幕监听 + 关联回复
    try { await pollDanmaku(st); } catch (e) {}
    // 福利调度（每 30s 检查一次）
    if (Date.now() - lastWelfare > 30000) { lastWelfare = Date.now(); try { await welfareTick(); } catch (e) {} }
    await sleep(400);
  }
})().catch(e => { log('FATAL ' + e.message); process.exit(1); });
