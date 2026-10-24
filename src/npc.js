'use strict';
// src/npc.js — NPC 人格 / 信念 / 发言引擎（导演 v2）
// 纯逻辑模块：不碰网络和页面，只负责「像人一样思考、说话、投票」
const CFG = require('./config').load(); // 统一配置中心（config.json 可改难度）

// ---------- 性格类型 ----------
// speak: 发言频率(0-1)  influence: 言论影响力  openness: 被说服度
// aggr: 攻击性  noise: 投票噪声  faith: 对权威(归票)的服从
const PERSONALITIES = {
  leader:     { name: '领袖',   speak: 0.85, influence: 1.7, openness: 0.25, aggr: 0.8,  noise: 0.10, faith: 0.3,  desc: '喜欢归票带节奏' },
  aggressive: { name: '激进',   speak: 0.80, influence: 1.2, openness: 0.35, aggr: 1.0,  noise: 0.30, faith: 0.2,  desc: '头铁冲锋狼' },
  rational:   { name: '理性',   speak: 0.60, influence: 1.4, openness: 0.45, aggr: 0.4,  noise: 0.20, faith: 0.15, desc: '盘逻辑盘行为' },
  follower:   { name: '跟风',   speak: 0.45, influence: 0.5, openness: 0.90, aggr: 0.2,  noise: 0.40, faith: 0.8,  desc: '谁声音大跟谁' },
  contrarian: { name: '杠精',   speak: 0.70, influence: 0.7, openness: 0.08, aggr: 0.9,  noise: 0.60, faith: 0.0,  desc: '永远唱反调' },
  cautious:   { name: '谨慎',   speak: 0.30, influence: 1.0, openness: 0.40, aggr: 0.1,  noise: 0.12, faith: 0.1,  desc: '不见兔子不撒鹰' },
  emotional:  { name: '感性',   speak: 0.65, influence: 0.8, openness: 0.75, aggr: 0.5,  noise: 0.50, faith: 0.4,  desc: '全凭一口阳气' },
  quiet:      { name: '闷葫芦', speak: 0.10, influence: 0.6, openness: 0.50, aggr: 0.2,  noise: 0.30, faith: 0.3,  desc: '关键时刻才说话' },
};
const PKEYS = Object.keys(PERSONALITIES);

// uid -> 性格（稳定：同一机器人每局同一性格）
function personalityOf(uid) {
  let h = 0;
  const s = String(uid);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PKEYS[h % PKEYS.length];
}

// ---------- 信念模型 ----------
// 每个「好人视角」的玩家一份怀疑度表 suspect[pid] = 分数
// 分数 > 阈值 → 愿意投杀(444)；<= 阈值 → 投救(666)
class Mind {
  constructor(uid) {
    this.uid = uid;
    this.persona = personalityOf(uid);
    this.P = PERSONALITIES[this.persona];
    this.suspect = {};      // pid -> 怀疑分
    this.wrongPush = {};    // pid -> 推错好人的次数（公开信息，人人可算）
  }
  s(pid) { return this.suspect[pid] || 0; }
  add(pid, v) { this.suspect[pid] = (this.suspect[pid] || 0) + v; }
  // 阈值：性格基准 + 个人波动（基准可由 config.difficulty.killThresholdBase 调整）
  threshold() {
    const base = CFG.difficulty.killThresholdBase + (this.P.noise - 0.3) * 0.8;
    return base + (Math.random() - 0.5) * this.P.noise * 1.6;
  }
  // 听一段发言后的心理变化
  hear(speech, speakerInfluence) {
    const o = this.P.openness;
    const w = speakerInfluence * o;
    if (speech.type === 'accuse') {
      this.add(speech.target, speech.strength * w);
      // 指控者也被轻微怀疑（乱咬人）
      if (Math.random() < 0.25) this.add(speech.speaker, 0.15 * w);
    } else if (speech.type === 'call') {
      this.add(speech.target, speech.strength * 1.6 * w * (0.5 + this.P.faith));
    } else if (speech.type === 'defend') {
      this.add(speech.target, -speech.strength * 0.9 * w);
      // 保人者惹嫌疑
      this.add(speech.speaker, 0.25 * w);
    } else if (speech.type === 'analyze') {
      this.add(speech.target, speech.strength * 0.7 * w);
    }
  }
  // 处决揭示（公开）：staged 被处决，voters = 选他上台+投杀的人
  onReveal(stagedPid, stagedIsWolf, voters) {
    const o = this.P.openness;
    voters.forEach(v => {
      if (v === this.uid) return;
      if (stagedIsWolf) this.add(v, -0.4 * (1 - o));       // 投对狼=略加分
      else this.add(v, 1.6 * o);                            // 推死好人=重大嫌疑
    });
    if (!stagedIsWolf) this.wrongPush[stagedPid] = (this.wrongPush[stagedPid] || 0) + 1;
  }
  // 投票决策：返回 '444'(杀) 或 '666'(救)
  decide(stagedPid, stagedIsWolfTruth, isSelf) {
    if (isSelf) return '666'; // 救自己
    if (stagedIsWolfTruth) {
      // 真相是狼：多数想杀，但被言论带偏的会救（集中指控会把 pull 推高）
      const pull = this.s(stagedPid);
      const wolfCampNoise = Math.random() < CFG.difficulty.npcDeadHardRate ? 2 : 0; // 少数死硬派
      return (pull + wolfCampNoise) > this.threshold() + CFG.difficulty.killThresholdBias ? '444' : '666';
    }
    // 真相是好：被带偏的会杀
    const pull = this.s(stagedPid);
    return pull > this.threshold() ? '444' : '666';
  }
}

// ---------- 发言生成 ----------
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const NUM = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' };

// 归票/指控发言（好人真视角：指控已知狼）
function accuseWolf(me, t) {
  return rnd([
    `${t}号铁狼，没什么好辩的，这轮全票打飞${t}！`,
    `我盘过了，${t}号昨晚的票型绝对有问题，今天归${t}号`,
    `${t}号别演了，你的演技比我的期末考还假`,
    `听我说，${t}号这轮必须出，错了我买单`,
    `${t}号全程划水还带节奏，不是狼是什么？`,
    `我把话放这：${t}号不出，这局好人直接交牌`,
    `${t}号的票型我复盘了三遍，每步都在垫飞，飞！`,
  ]);
}
// 狼人冲票发言（构陷好人）
function frameGood(me, t) {
  return rnd([
    `${t}号才像狼吧？一直躲在后面不敢说话，典型的狼刀`,
    `我觉得${t}号有问题，昨天他就盯上我了，心虚`,
    `${t}号上一轮的发言全是废话，狼人找存在感呢`,
    `盘一下，${t}号保的那个人刚才翻了好，${t}号不解释一下？`,
    `${t}号这么急着归票，怕自己夜里作业写不完？`,
    `我盲猜${t}号，敢跟我对跳的都不是好东西`,
  ]);
}
// 辩护（被指控/上台时）
function defend(me, accuser) {
  return rnd([
    `我是全场最冤的好人，投我的你们晚上睡得着吗`,
    `${accuser}号你少血口喷人，我这身份亮出来吓死你`,
    `我要是狼，我直接把在座各位全刀了，还跟这陪你们演？`,
    `你们动动脑子，我这时候跳出来送人头，图什么？`,
    `行行行，我是狼，我今晚就刀我自己，行了吧`,
    `冤枉啊！我比窦娥还冤，比六月飞雪还凉`,
  ]);
}
// 分析发言
function analyze(me, a, b) {
  return rnd([
    `复盘一下：${a}号上一轮投了${b}号，${b}号翻好，${a}号这票怎么洗？`,
    `你们发现没有，${a}号和${b}号永远同进同退，不是队友我吃键盘`,
    `${a}号昨晚死得蹊跷，他前面那个房间可热闹了`,
    `我统计了下票型，${a}号每次都能精准避开狼队，这不巧了吗`,
    `${b}号倒牌之后，${a}号接管带节奏，剧本都不敢这么写`,
  ]);
}
// 站边/闲聊
function banter(me, t) {
  return rnd([
    `局势还早，先看${t}号表演，我瓜子汽水都备好了`,
    `这局质量局，比上局那把狼人屠杀爽多了`,
    `我宣布个事，我是预言家，昨晚查了我自己，是好人`,
    `在座的各位都是垃圾……哦我是好人阵营的啊，那没事了`,
    `狼人现在估计在开会，我们正好团建一下`,
    `别问我身份，问就是我是一朵无辜的小白花`,
  ]);
}
// 调戏（对弹幕观众）
function flirt(me, viewer) {
  return rnd([
    `${viewer}小姐姐这么关注我，是不是暗恋我啊`,
    `${viewer}哥哥别凶凶，人家害怕嘛，晚上刀你的时候轻点叫`,
    `${viewer}宝，你这票投得我心都碎了，得亏你是观众不用上桌`,
    `感谢${viewer}老铁的关注，比心，么么哒`,
    `${viewer}你要是上桌我保证不刀你，骗人是小狗`,
  ]);
}
// 反击（被观众点名怼）
function retort(me, viewer) {
  return rnd([
    `你才是狼！你全家都是狼！`,
    `说我狼？你先撒泡尿照照自己，你配吗`,
    `哥们你行你上啊，别躲在弹幕里指点江山`,
    `就你这理解能力，狼人杀幼儿园大班都毕业不了`,
    `我狼？我今晚就刀你，你等着`,
    `急了急了，戳你痛处了？`,
  ]);
}
// 中性回应
function ack(me, viewer) {
  return rnd([
    `说我？说我怎么了，来打我呀`,
    `${viewer}你说得对，但我不改`,
    `收到收到，下次还这样`,
    `谢谢夸奖，我会继续加油的`,
    `？我怀疑你在搞事情，但我没有证据`,
  ]);
}

// ---------- 性格换装 ----------
// 服装池（WolfDefaultSkin）: face[1-7] head[10001-10007] shangyi[20001-20002] kuzi[30001-30003] toushi[40000] mask[50000] daoju[60000]
const FACE = [1, 2, 3, 4, 5, 6, 7], HEAD = [10001, 10002, 10003, 10004, 10005, 10006, 10007];
const TOP = [20001, 20002], PANTS = [30001, 30002, 30003];
const THEMES = {
  leader:     { face: [3, 4], head: [10001, 10002], top: [20001], pants: [30001], mask: 0, daoju: 0 }, // 正装领队
  aggressive: { face: [1, 2], head: [10003, 10004], top: [20002], pants: [30002], mask: 0, daoju: 1 }, // 凶神恶煞带道具
  rational:   { face: [4, 5], head: [10002, 10003], top: [20001], pants: [30001], mask: 0, daoju: 0 }, // 斯文分析
  follower:   { face: [5, 6], head: [10004, 10005], top: [20001], pants: [30002], mask: 0, daoju: 0 }, // 大众脸
  contrarian: { face: [6, 7], head: [10006, 10007], top: [20002], pants: [30003], mask: 1, daoju: 1 }, // 不伦不类
  cautious:   { face: [3, 4], head: [10005, 10006], top: [20001], pants: [30003], mask: 0, daoju: 0 }, // 保守
  emotional:  { face: [5, 6], head: [10004, 10006], top: [20002], pants: [30001], mask: 0, daoju: 0 }, // 花哨
  quiet:      { face: [7],     head: [10007],       top: [20001], pants: [30003], mask: 1, daoju: 1 }, // 全副武装蒙面
};
// 按性格生成一套衣服（同一 uid 稳定，可加扰动重新随机）——免费池兜底
function outfitFor(uid, reshuffle) {
  const p = personalityOf(uid);
  const t = THEMES[p];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const items = [pick(t.face), pick(t.head), pick(t.top), pick(t.pants), 40000, t.mask ? 50000 : 0, t.daoju ? 60000 : 0];
  if (reshuffle) { items[0] = pick(FACE); items[1] = pick(HEAD); }
  return items;
}

// ---------- 付费服装池 ----------
// setSkinOrSoulBySuitId(grade, suitId)
// grade: 0=R(WolfCommonSkin 22套) 1=SR(WolfAdvanceSkin 36套) 2=SSR(WolfSpecialSkin 126套) 3=UR(WolfUltraSkin 126套) 4=Captain(舰长2套)
// R/SR/SSR 走 items 路径（本地稳）；UR 走 spines/URALL/UR{id} 远程骨骼（已实测可加载）
const PAID_SUITS = {
  leader: [ // 领袖：正装/统帅气质
    { grade: 0, suitId: 5,  name: '蓝制服' }, { grade: 2, suitId: 1,  name: '女战士' },
    { grade: 3, suitId: 2,  name: '梵天' },   { grade: 0, suitId: 4,  name: '白水手' },
    { grade: 2, suitId: 23, name: '锡克战士' }, { grade: 2, suitId: 42, name: '安全员' },
  ],
  aggressive: [ // 激进：凶神恶煞
    { grade: 0, suitId: 6,  name: '黑运动' }, { grade: 2, suitId: 5,  name: '电锯' },
    { grade: 3, suitId: 3,  name: '恶魔' },   { grade: 3, suitId: 44, name: '诅咒真狼形态' },
    { grade: 2, suitId: 10, name: '杀人魔' }, { grade: 3, suitId: 43, name: '真狼形态' },
    { grade: 2, suitId: 7,  name: '变态熊' },
  ],
  rational: [ // 理性：斯文/技术流
    { grade: 0, suitId: 3,  name: '乖巧学生' }, { grade: 2, suitId: 40, name: '机械师' },
    { grade: 0, suitId: 8,  name: '白学生' },   { grade: 2, suitId: 46, name: '医疗队长' },
    { grade: 0, suitId: 1,  name: '蓝运动' },   { grade: 3, suitId: 6,  name: '哆啦A猛' },
  ],
  follower: [ // 跟风：大众运动/萌系
    { grade: 0, suitId: 10, name: '绿运动' }, { grade: 3, suitId: 56, name: '塞内加尔小熊' },
    { grade: 0, suitId: 18, name: '运动男孩' }, { grade: 3, suitId: 64, name: '德国小熊' },
    { grade: 0, suitId: 13, name: '黄色雨鞋' },
  ],
  contrarian: [ // 杠精：不伦不类/猎奇
    { grade: 0, suitId: 16, name: '原谅青蛙' }, { grade: 2, suitId: 6,  name: '人皮面具' },
    { grade: 3, suitId: 12, name: '鬼火辣椒' }, { grade: 2, suitId: 36, name: '小丑' },
    { grade: 0, suitId: 11, name: '告白选手' }, { grade: 2, suitId: 8,  name: '变态兔' },
  ],
  cautious: [ // 谨慎：保守/遮蔽
    { grade: 0, suitId: 15, name: '小黄帽' }, { grade: 2, suitId: 28, name: '苦行僧' },
    { grade: 0, suitId: 9,  name: '绿休闲' }, { grade: 2, suitId: 12, name: '浣熊' },
    { grade: 0, suitId: 21, name: '淑女蓝' }, { grade: 3, suitId: 20, name: '白玉兔' },
  ],
  emotional: [ // 感性：花哨/甜系
    { grade: 0, suitId: 14, name: '粉兔兔' }, { grade: 2, suitId: 56, name: '天使爱人' },
    { grade: 3, suitId: 76, name: '梦幻兔兔' }, { grade: 0, suitId: 20, name: '小兔露西' },
    { grade: 2, suitId: 30, name: '粉梦游症' }, { grade: 3, suitId: 100, name: '女仆九尾' },
  ],
  quiet: [ // 闷葫芦：蒙面/神秘
    { grade: 0, suitId: 12, name: '见习忍者' }, { grade: 2, suitId: 16, name: '天狗' },
    { grade: 3, suitId: 32, name: '妖狐达摩' }, { grade: 2, suitId: 2,  name: '南瓜头' },
    { grade: 2, suitId: 17, name: '伞怪' },     { grade: 3, suitId: 37, name: '诅咒黑玉兔' },
  ],
};
// 主播（场外）展示柜：视觉冲击力优先，UR 为主
const STREAMER_SUITS = [
  { grade: 3, suitId: 1,   name: '达摩' },     { grade: 3, suitId: 2,   name: '梵天' },
  { grade: 3, suitId: 3,   name: '恶魔' },     { grade: 3, suitId: 31,  name: '觉醒九尾' },
  { grade: 3, suitId: 43,  name: '真狼形态' }, { grade: 3, suitId: 100, name: '女仆九尾' },
  { grade: 2, suitId: 1,   name: '女战士' },   { grade: 2, suitId: 5,   name: '电锯' },
  { grade: 2, suitId: 4,   name: '富江' },     { grade: 3, suitId: 124, name: '死神鲨鱼' },
  { grade: 2, suitId: 3,   name: '八尺夫人' }, { grade: 3, suitId: 81,  name: '国王兔兔' },
  { grade: 2, suitId: 95,  name: '狼人' },     { grade: 3, suitId: 95,  name: '红九尾' },
  { grade: 3, suitId: 18,  name: '猎鹰可汗' }, { grade: 2, suitId: 26,  name: '湿婆' },
];
const _lastSuit = new Map();
// 按性格选一套付费套装（reshuffle=换一套不重复的）
function paidOutfitFor(uid, reshuffle) {
  const p = personalityOf(uid);
  const pool = PAID_SUITS[p] || PAID_SUITS.follower;
  const key = String(uid);
  const last = _lastSuit.get(key);
  let suit = pool[Math.floor(Math.random() * pool.length)];
  if (reshuffle && last && pool.length > 1) {
    let guard = 0;
    while (suit.grade === last.grade && suit.suitId === last.suitId && guard++ < 10) {
      suit = pool[Math.floor(Math.random() * pool.length)];
    }
  }
  _lastSuit.set(key, suit);
  return suit;
}

module.exports = {
  PERSONALITIES, personalityOf, Mind,
  accuseWolf, frameGood, defend, analyze, banter, flirt, retort, ack,
  outfitFor,
  PAID_SUITS, STREAMER_SUITS, paidOutfitFor,
  speakProb, influenceOf,
};

// ---------- 配置化：发言概率 / 影响力（受 config.difficulty.speakRateScale / influenceScale 控制） ----------
// speakProb 接收「性格 key」（机器人用 personalityOf(uid)，账号用 ACCOUNT_PERSONA），返回缩放后的发言概率(0-1)
function speakProb(personaKey) {
  const p = PERSONALITIES[personaKey] || PERSONALITIES.follower;
  return Math.max(0, Math.min(1, p.speak * CFG.difficulty.speakRateScale));
}
// influenceOf 接收 uid（与 Mind.persona = personalityOf(uid) 一致），返回缩放后的影响力
function influenceOf(uid) {
  const p = PERSONALITIES[personalityOf(uid)];
  return p.influence * CFG.difficulty.influenceScale;
}
