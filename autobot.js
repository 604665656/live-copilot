'use strict';
/**
 * 弹幕狼人杀《我的粉丝里有鬼》—— 真实弹幕自动玩（混合模式）
 *
 * 架构真相（实测）：
 *  - 游戏是 B站「弹幕互动玩法」，状态在云端、以视频流呈现；房间页面无 canvas/iframe。
 *  - 玩家唯一操作入口 = 真实直播弹幕：报名 / A·B·C·D / 玩家号码 / 444 / 666。
 *  - 阶段提示（"弹幕发送 A B C D 选择过夜!" 等）只显示在【视频画面】上，不下发为文字弹幕；
 *    因此纯靠弹幕流无法自动识别阶段（已实测：活房间弹幕流里没有任何游戏系统消息）。
 *  - 本机无法对视频做 OCR / 读图（环境限制）。
 *
 * 所以采用【混合模式】：
 *  - 你（能看直播画面）告诉我当前阶段 + 你的身份牌，我据此从 5 个账号发出最优指令；
 *  - 同时脚本持续记录所有弹幕，万一某天游戏把阶段下发成文字弹幕，可自动切到 --auto。
 *
 * 用法：
 *   node autobot.js <roomId>                 # 只读：记录全部弹幕（用于抓阶段提示/观察）
 *   node autobot.js <roomId> --auto          # 自动：用弹幕关键词识别阶段并出招（此游戏通常无效）
 *   node autobot.js <roomId> --manual        # 混合：从命令行喂阶段，自动出招
 *      --from=all | --from=0,1,2,3,4         # 用哪些账号出招（默认账号[1] 带粉丝牌）
 *      --role=未知|学生|女鬼|...              # 你的身份（影响策略）
 *      --me=<号码>                            # 你的玩家号码（影响投票/审判策略）
 *
 * 混合模式可喂的指令（实时输入，回车发送）：
 *   signup       -> 全部 from 账号发「报名」
 *   night A      -> 夜晚进 A 房（也可 B/C/D；不写默认 A）
 *   vote 12      -> 投票给 12 号
 *   trial 444    -> 审判处死（666 放过）
 *   info 学生 7  -> 设定身份=学生、号码=7
 *   status       -> 打印当前状态
 *   quit         -> 退出
 *
 * 不含任何付费投喂（不发礼物/SC）。
 */
const { loadAccounts, isSendable } = require('./src/accounts');
const { BiliLive, sendDanmaku } = require('./src/bili');
const fs = require('fs');
const readline = require('readline');

const args = process.argv.slice(2);
const roomId = Number(args.find((a) => /^\d+$/.test(a)) || 5391172);
const AUTO = args.includes('--auto');
const MANUAL = args.includes('--manual');
const fromArg = (args.find((a) => a.startsWith('--from=')) || '--from=1').split('=')[1];
const roleArg = (args.find((a) => a.startsWith('--role=')) || '--role=未知').split('=')[1];
const meArg = (args.find((a) => a.startsWith('--me=')) || '--me=').split('=')[1];

const { usable } = loadAccounts();
if (!usable.length) { console.error('无可用账号'); process.exit(1); }
const fromIdx = fromArg === 'all' ? usable.map((_, i) => i)
  : fromArg.split(',').map((x) => Number(x)).filter((i) => i >= 0 && i < usable.length);

const COOLDOWN = 3500;
let lastSent = 0;
const log = []; // 出招记录
const danmakuLog = []; // 全部弹幕（环形，最多 500）
const MAX_DAN = 500;

// 当前已知局势（混合模式由你喂入）
const state = {
  role: roleArg,
  me: meArg ? Number(meArg) : null,
  day: 1,
  alive: 36,
  rats: '普通的老鼠',
};

async function fire(text, reason, account) {
  const now = Date.now();
  if (now - lastSent < COOLDOWN) {
    await new Promise((r) => setTimeout(r, COOLDOWN - (now - lastSent) + 50));
  }
  lastSent = Date.now();
  const acc = account || usable[fromIdx[0]];
  const r = await sendDanmaku({ cookie: acc.cookie, roomId, text, biliJct: acc.keys.bili_jct });
  const line = `[出招] ${acc.uname}(uid=${acc.uid}) -> "${text}" (${reason}) => ${r.ok ? 'OK' : 'code=' + r.code + ' ' + r.message}`;
  console.log(line);
  log.push({ t: new Date().toISOString(), who: acc.uname, text, reason, ok: r.ok, code: r.code });
  return r;
}

// 用所有 from 账号发同一条（如报名）
async function fireAll(text, reason) {
  for (const i of fromIdx) {
    const r = await fire(text, reason, usable[i]);
    if (!r.ok) console.log(`  ⚠️ ${usable[i].uname} 失败：${r.message}（可能因粉丝牌门槛/冷却）`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---------- 策略引擎 ----------
function openRooms() {
  // 按存活人数决定开放的门
  if (state.alive >= 28) return ['A', 'B', 'C', 'D'];
  if (state.alive >= 18) return ['A', 'B', 'D'];
  return ['A', 'D'];
}
function pickNightRoom() {
  const rooms = openRooms();
  // 鬼必须进房开刀；好人也进房躲老鼠。默认进第一个开的门（A）。
  return rooms[0];
}
function pickVote() {
  // 无身份推理信息时：好人随机投一个非自己号码；鬼可投好人号码制造混乱（此处保守随机）
  const n = state.me ? state.me : 1 + Math.floor(Math.random() * 20);
  return n;
}
function pickTrial() {
  // 默认放过（666）。若为鬼且台上是好人 -> 666 放过无意义，应 444 处死好人；
  // 若台上是鬼友 -> 666 放过。无台上身份信息时默认 666。
  return '666';
}

// ---------- 阶段处理 ----------
async function handlePhase(phase, extra) {
  if (phase === 'signup') {
    await fireAll('报名', '报名加入');
    state.day = 1;
  } else if (phase === 'night') {
    const room = (extra && /^[ABCD]$/i.test(extra)) ? extra.toUpperCase() : pickNightRoom();
    await fireAll(room, `夜晚进${room}房过夜（开放:${openRooms().join('')}）`);
  } else if (phase === 'vote') {
    const num = extra ? Number(extra) : pickVote();
    await fireAll(String(num), `投票给 ${num} 号`);
  } else if (phase === 'trial') {
    const act = (extra && /^(444|666)$/.test(extra)) ? extra : pickTrial();
    await fireAll(act, `审判 ${act === '444' ? '处死' : '放过'}`);
  } else if (phase === 'day') {
    state.day++;
    console.log(`  [状态] 进入第 ${state.day} 天`);
  }
}

// ---------- 自动模式（关键词，通常对此游戏无效，仅作兜底）----------
const AUTO_KW = [
  { re: /报名|开始游戏|加入游戏/, phase: 'signup' },
  { re: /选择|过夜|房间|躲|安全|闭眼/, phase: 'night' },
  { re: /投票|票选|上台|最高票/, phase: 'vote' },
  { re: /审判|处死|放过/, phase: 'trial' },
];
const autoDone = {};
function autoDetect(text) {
  if (!AUTO) return;
  for (const k of AUTO_KW) {
    if (k.re.test(text) && !autoDone[k.phase]) {
      autoDone[k.phase] = true;
      console.log(`  [自动] 识别到阶段=${k.phase} -> 出招`);
      handlePhase(k.phase);
    }
  }
}

// ---------- 只读 + 记录 ----------
const live = new BiliLive(roomId, {
  onEvent: (type, data) => {
    if (type === 'roominfo') console.log(`[房间] ${data.title} owner=${data.owner} live=${data.liveStatus}`);
    else if (type === 'status') console.log(`[连接] ${JSON.stringify(data)}`);
    else if (type === 'danmaku') {
      danmakuLog.push({ t: Date.now(), user: data.user, uid: data.uid, text: data.text });
      if (danmakuLog.length > MAX_DAN) danmakuLog.shift();
      console.log(`[弹幕] ${data.user || '匿名'}: ${data.text}`);
      autoDetect(data.text);
    }
    else if (type === 'log') console.log(`[WS] ${data}`);
  },
});

console.log(`=== 弹幕狼人杀自动玩（${AUTO ? '自动' : MANUAL ? '混合' : '只读'}）===`);
console.log(`房间: ${roomId}`);
console.log(`出招账号: ${fromIdx.map((i) => usable[i].uname).join(', ')}`);
console.log(`已知身份: ${state.role}  号码: ${state.me || '未知'}`);
console.log(`提示：阶段提示只在视频画面显示，不下发文字弹幕；混合模式请实时喂阶段。`);

function saveLog() {
  fs.writeFileSync('autobot.log.json', JSON.stringify({ log, danmaku: danmakuLog.slice(-200), state }, null, 2));
}
live.start();

if (MANUAL) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.question('阶段> ', async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    if (cmd === 'quit' || cmd === 'exit') { saveLog(); live.stop(); process.exit(0); }
    else if (cmd === 'status') console.log('状态:', JSON.stringify(state));
    else if (cmd === 'info') { state.role = parts[1] || state.role; state.me = parts[2] ? Number(parts[2]) : state.me; console.log('更新:', JSON.stringify(state)); }
    else if (['signup', 'night', 'vote', 'trial', 'day'].includes(cmd)) { await handlePhase(cmd, parts[1]); }
    else console.log('未知指令。可用: signup / night [A-D] / vote [号码] / trial [444|666] / day / info [身份] [号码] / status / quit');
    prompt();
  });
  prompt();
}

process.on('SIGINT', () => { saveLog(); live.stop(); process.exit(0); });
