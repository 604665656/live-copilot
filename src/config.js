'use strict';
// src/config.js — 统一配置中心（导演/助手共用）
// 优先级：环境变量 WOLF_CONFIG 指定文件 > 进程工作目录 config.json > 项目根 config.json > 内置默认
// 人工改动：直接编辑 config.json（助手界面也提供表单），保存后重启导演即生效。
// 任何字段缺失/留空/格式错误 → 自动回退内置默认，绝不因配置问题崩溃。

const fs = require('fs');
const path = require('path');

// ---------- 内置默认（与 config.json 保持一致；config 里删掉字段时用这里兜底） ----------
const DEFAULTS = {
  room: {
    roomId: 5391172,
    streamerUid: 298813,
    identityCode: 'BJSPTSVR93B43',
    debugPort: 9222,
  },
  difficulty: {
    npcReactMinMs: 2000,
    npcReactMaxMs: 3000,
    botTarget: 31,
    accuseWolfRate: 0.7,
    killThresholdBase: 1.15,
    killThresholdBias: -1.25,
    npcDeadHardRate: 0.06,
    wolfSaveMateRate: 0.15,
    wolfFakeGoodRate: 0.15,
    speakRateScale: 1.0,
    influenceScale: 1.0,
  },
  script: {
    phases: {}, // 空 = 用 commentator.js 内置台词；config 里填了就用 config 的
    nightResult: {},
    execution: {},
    chatter: ['核酸', '钓鱼'],
    welfare: ['核酸', '签到'],
    fish: '钓鱼',
  },
  commands: {
    join: '报名',
    voteKill: '444',
    voteSave: '666',
    hideLetters: { 1: 'A', 2: 'B', 3: 'C', 4: 'D' },
  },
  chain: {
    heartbeatCheckMs: 20000,
    autoRestart: true,
    reloadOnStart: true,
  },
  // 【目标玩法/地图】助手 UI「地图切换」卡片写这里；导演热重启后按目标切场景并自动驱动。
  // 取值见下方 GAME_MODES：gacha=Gacha怪兽(地下城) | werewolf=我的粉丝里有鬼(弹幕狼人杀) |
  // rouge=这是什么颜色 | chump=放学不许走 | greatsword=物理学不存在 |
  // ball=抢球对战 | frameball=抢球·跨房 | draw=鼠王争夺战 | dj=弹幕舞台 | hd=航海探索 | jz=航海打捞 | pet=宠物互动 | xiuxian=修仙擂台 |
  // auto=自动识别当前场景
  gameMode: 'gacha',
  // 直播增强子系统：场外围观观众 NPC + 自主进化引擎。默认全部关闭 → 不改既有导演行为。
  livecast: {
    audience: {
      enabled: false,        // 是否启用场外围观观众（陆续进场 / 按关键字归票·狡辩·闲聊）
      target: 14,            // 同时在场观众上限
      joinWindowMs: 30000,   // 观众陆续进场的时间窗（错峰进场）
      tickGapMs: 2500,       // 观众发言最小间隔（控制密度）
      sendToRoom: false,     // false=仅记日志；true=由主播号代发真实弹幕到直播间
    },
    evolve: {
      enabled: false,        // 是否启用「归类收集 + 自主进化」知识库（跨局持久化到 wolf-knowledge.json）
    },
  },
  // Gacha 怪兽模式自动适配：导演自动识别场景后接管（营地报名 / 抽装备 / 增益投票轮转 / 战斗加血 / 结束自动再来一局），
  // 并持续钉死「10000 倍攻击力」排行榜榜首（许许许许许丶若辰）。默认开启；仅在识别到 Gacha 场景时生效，不影响狼人杀。
  gacha: {
    enabled: true,                       // 是否启用 Gacha 怪兽模式自动适配
    autoNext: true,                      // 结束屏自动点击「再来一局」
    startLv: 78,                         // 起始关预置：Mgr.lv 低于此值时自动拉起。语义实证：TaskSelectState 首行 lv++（选任务界面把关卡+1），故预置 78 → lv++ 后打第 79 关、通关后进 80——即「从第 79 关开始打」（用户 2026-10-23 要求，旧值 79 会变成实际从 80 关开局）；0 = 不预置
    endLv: 100,                          // 【关卡循环上限】循环开启时：通关到这一关（实战关号）就把 lv 拨回 startLv 继续刷；<100 可免去 60 秒结算倒计时，循环更紧凑。循环关闭时本项无效（游戏自然打到 100 关结算）
    loop: {
      enabled: false,                    // 【自定义关卡无限循环】true = 打到 endLv 后拨回 startLv 反复刷（弹幕「循环 开/关」可临时改）
      maxRounds: 0,                      // 循环轮次上限：0 = 无限循环；>0 = 刷够 N 轮后交还游戏自然结算（防刷太久）
    },
    buffMultiplier: 999,                 // 【BUFF 数据倍率】选卡界面与效果应用都读 BoboMonsterEndlessBuff 表；改这张表 = 所有 BUFF 数值 ×N（界面 x999 倍率语义）。1 = 不修改；弹幕「倍率 N」可临时改（会按原始值快照重新应用，不会重复乘）
    buffStrategy: {                      // 【选卡策略】增益投票 A/B/C 怎么选（用户 2026-10-23：属性攻击降权，优先攻速>攻击>生命>防御）
      mode: 'attack',                    // attack=攻速/攻击/生命/防御优先，属性攻击与抗性降权 | balanced=均衡 | resist=抗性/防御优先 | custom=用下面 weights 自定义 | auto=交给自主决策（依据历史胜负自动选）
      weights: { spd: 4, atk: 3, hp: 2, def: 1, ele: 0, res: 0 },   // 各分类权重（越大越优先）：spd=攻速/暴击 atk=纯攻击 hp=生命 def=防御 ele=属性攻击 res=抗性
      preferPercent: true,               // 同类里百分比加成优先（addAttPercents 非零）
    },
    healPct: 40,                         // 【加血阈值】战斗 HP 低于该百分比发「加血」（耗3金）；连续无效升级「复活」（耗10金）
    think: {                             // 【读取弹幕 + 自主决策升级】
      enabled: true,                     // 解析观众弹幕指令：「策略 攻击|均衡|防御」「倍率 N」「关卡 N」「循环 N-M」「循环 开|关」「状态」
      autoTune: true,                    // 依据历史胜负/耗时/弹幕情绪自动调策略与加血阈值（写入 dungeon-knowledge.json 跨局保留）
      kbPath: '',                        // 知识库路径（默认 userData/dungeon-knowledge.json）
      llm: {                             // 【可选】AI 思考：把局面摘要交给本地 OpenAI 兼容模型，返回 JSON 决策（失败自动回退规则决策）
        enabled: false,
        baseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: '',
        model: '',
        everyLevels: 10,                 // 每通关多少关问一次（0 = 只在胜负结算时问）
      },
    },
    rankBoostUid: 298813,                // 排行榜锁定为榜首的 uid（10000 倍攻击力显示）
    rankBoostScore: 30215180000,         // 钉死的榜首分数（服务器权威，仅显示层生效）
    buffVoteOrder: ['A', 'B', 'C'],      // 增益投票轮转顺序（每轮点下一个）
    commands: {
      join: '报名',                      // 营地报名（优先点按钮，失败回退发弹幕）
      draw: '抽',                        // 抽装备
      voteBuff: { A: 'A', B: 'B', C: 'C' }, // 增益投票选项
      heal: '加血',                      // 战斗加血指令
      revive: '复活',                    // 复活指令
    },
    pollMs: 1500,                        // Gacha 模式主循环轮询间隔
  },
};

function findConfigPath() {
  const env = process.env.WOLF_CONFIG || process.env.CONFIG_PATH;
  if (env) return path.resolve(env);
  const cwdCfg = path.join(process.cwd(), 'config.json');
  const rootCfg = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(cwdCfg)) return cwdCfg;
  if (fs.existsSync(rootCfg)) return rootCfg;
  return rootCfg; // 默认读写项目根
}

function isPlainObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// 深度合并：用户值覆盖默认值；数组整体替换；忽略以 _ 开头的说明字段
function deepMerge(base, over) {
  if (!isPlainObj(over)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  Object.keys(over).forEach(k => {
    if (k.indexOf('_') === 0) return; // _说明/_readme 等注释字段不参与合并
    const v = over[k];
    if (isPlainObj(v) && isPlainObj(base[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined && v !== null && v !== '') out[k] = v;
  });
  return out;
}

let cache = null;
let cachePath = '';

function load(force) {
  const p = findConfigPath();
  if (!force && cache && cachePath === p) return cache;
  let user = {};
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      user = JSON.parse(raw);
    }
  } catch (e) {
    console.error('[config] config.json 解析失败，使用内置默认：' + e.message);
    user = {};
  }
  cache = deepMerge(DEFAULTS, user);
  cachePath = p;
  // 归一化数值（防手改成字符串）
  const d = cache.difficulty;
  Object.keys(DEFAULTS.difficulty).forEach(k => {
    if (typeof DEFAULTS.difficulty[k] === 'number') {
      const n = Number(d[k]);
      d[k] = isNaN(n) ? DEFAULTS.difficulty[k] : n;
    }
  });
  cache.chain.heartbeatCheckMs = Math.max(5000, Number(cache.chain.heartbeatCheckMs) || 20000);
  return cache;
}

function save(obj) {
  const p = findConfigPath();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  cache = null;
  return p;
}

// ---------- 地图/玩法模式表（游戏内「玩法菜单」的权威清单，2026-10-24 从 bundle 实证） ----------
// path = LiveCtl.loadGame 的预制体路径；gameRoot = 该地图游戏内根节点名（loadGame 后预制体根节点=路径末段，
// 精确匹配防大厅按钮名误命中）；sig = 兜底特征（组件名等）；
// entry = 到达该地图的方式：direct=直接 loadGame(path)；select=先加载选择屏(path 即选择屏)再点 selectBtn（btn_auto=自动/自由模式）。
// autoDrive = 导演是否有自动驱动（gacha/werewolf 有；其余仅切场景，主播手动玩）。
const GAME_MODES = {
  gacha:      { name: 'Gacha 怪兽（地下城）',   short: '地下城',     path: 'res/livegames/game_bobo_master',  gameRoot: 'game_bobo_master', sig: /bobo_master|comBoBoMaster/i, entry: 'direct',  autoDrive: true },
  werewolf:   { name: '我的粉丝里有鬼（弹幕狼人杀）', short: '弹幕狼人杀', path: 'res/livegames/game_select_wolf', gameRoot: 'game_wolf',         sig: /game_wolf|ComLiveWolf/i,     entry: 'select',  autoDrive: true, selectBtn: 'btn_auto' },
  rouge:      { name: '这是什么颜色',            short: '颜色',       path: 'res/livegames/game_rouge',        gameRoot: 'game_rouge',        sig: /rouge/i,                   entry: 'direct',  autoDrive: false },
  chump:      { name: '放学不许走',              short: '放学',       path: 'res/livegames/game_chump',        gameRoot: 'game_chump',        sig: /chump/i,                   entry: 'direct',  autoDrive: false },
  greatsword: { name: '物理学不存在',            short: '物理学',     path: 'res/livegames/game_greatsword',   gameRoot: 'game_greatsword',   sig: /greatsword/i,              entry: 'direct',  autoDrive: false },
  // ---------- 2026-10-24 地图考古补全：以下 8 个是 bundle 内已存在、但未上官方「玩法菜单」的模块 ----------
  // 【命名声明·重要】这 8 款在客户端（贴图/Label/bundle 目录/Fun 面板/运行时房间名/proto/API 层）、
  // B站互动玩法商店（496 款全量，按「色号/鼠王/紫金之轮/海神/秦楚/摸鱼/划水/元婴」等独有短语检索零命中）、
  // 厂商官网与全网检索中均查无官方中文名——系未上架的内部 SDK 模块。
  // 故按「模块 ID + 贴图/文本实证的玩法主题」命名（ev 字段=证据出处），仅供识别，禁止当作官方名对外使用。
  ball:       { name: '抢球对战（秦楚赵齐）',    short: '抢球',       path: 'res/livegames/game_ball',        gameRoot: 'game_ball',        sig: /LiveBall/i,                entry: 'direct',  autoDrive: false, ev: '贴图实证：秦/楚/赵/齐四阵营 + 60s 倒计时 + 英雄 + 100 分（wartrade 城市战预制体；LiveBallSelect「单人游戏」入口直载本模块）' },
  frameball:  { name: '抢球对战·跨房（德法英苏）', short: '跨房抢球', path: 'res/livegames/game_frameball',  gameRoot: 'game_frameball',    sig: /LiveFrameBall/i,           entry: 'direct',  autoDrive: false, ev: '贴图实证：德/法/英/苏四阵营；官方选择屏入口「匹配其他主播」（room-mgr 跨房匹配，无对面主播时提示未匹配到）' },
  draw:       { name: '鼠王争夺战（四色阵营）',    short: '鼠王',       path: 'res/livegames/game_select_draw', gameRoot: 'game_draw',       sig: /LiveDraw/i,                entry: 'select',  autoDrive: false, selectBtn: 'btn_draw', ev: '贴图实证：「本场鼠王」+ 木箱仓房老鼠；LiveDrawColors 紫(230,87,215)/绿(148,220,78)/蓝(57,139,241)/橙(239,117,64) 四色阵营；LiveDrawMode.Draw=鼠王模式（Ball 模式为默认抢球）' },
  dj:         { name: '弹幕舞台（换装蹦迪）',      short: '舞台',       path: 'res/livegames/game_dj',         gameRoot: 'game_dj',           sig: /LiveDJ/i,                  entry: 'direct',  autoDrive: false, ev: '文本实证：创建角色/换装/换动作 + 小花花打赏；music/dj 曲库 12 首（LiveDJMusic/UILiveDJFun）' },
  hd:         { name: '航海探索',                 short: '航海探索',   path: 'res/livegames/game_hd',         gameRoot: 'game_hd',           sig: /LiveHd/i,                  entry: 'direct',  autoDrive: false, ev: '文本实证：星数/船员/当前所在地/赢得金币；UILiveHdMaps 地图选择 + 转盘抽奖（ComLiveHdTurntable）' },
  jz:         { name: '航海打捞',                 short: '打捞',       path: 'res/livegames/game_jz',         gameRoot: 'game_jz',           sig: /LiveJz/i,                  entry: 'direct',  autoDrive: false, ev: '文本实证：紫金之轮/摸鱼/划水拉船/海神石像/铜银金箱；UILiveJzTaskAcceptList 任务接取 + UILiveJzBag 背包' },
  pet:        { name: '宠物互动',                 short: '宠物',       path: 'res/livegames/game_pet',        gameRoot: 'game_pet',          sig: /LivePet/i,                 entry: 'direct',  autoDrive: false, ev: '文本实证：kiss/shi/fondle/flower 互动指令 + 皮肤（ComPetSkin/LivePetGm）' },
  xiuxian:    { name: '修仙擂台',                 short: '修仙',       path: 'res/livegames/game_xiuxian',    gameRoot: 'game_xiuxian',      sig: /XiuXian/i,                 entry: 'direct',  autoDrive: false, ev: '文本实证：元婴初期/任务 1-10/小擂台×15/中心擂台 PK；宗门家族（LiveXiuXianFamily）' },
};

module.exports = { load, save, DEFAULTS, deepMerge, configPath: findConfigPath, GAME_MODES };
