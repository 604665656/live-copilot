'use strict';
// 弹幕狼人杀「自动玩家」：用 bili-relation-manager 里的账号，通过真实直播弹幕玩
// 用法：
//   node play.js <roomId> [--account=0] [--act] [--name=玩家名]
// 说明：
//   - 默认只读：连接房间、打印所有弹幕与游戏系统消息（用来观察游戏阶段/指令格式）
//   - --act：开启自动出招（报名 / A·B·C·D / 投票号码 / 444·666）
//   - 不含任何付费投喂（不发礼物、不发 SC）
const { loadAccounts, isSendable } = require('./src/accounts');
const { BiliLive, sendDanmaku } = require('./src/bili');

const args = process.argv.slice(2);
const roomId = Number(args.find((a) => /^\d+$/.test(a)) || 298813);
const ACT = args.includes('--act');
const ACC_ARG = (args.find((a) => a.startsWith('--account=')) || '--account=0').split('=')[1];
const IDX = Number(ACC_ARG) || 0;

const { usable } = loadAccounts();
if (!usable.length) { console.error('没有可用账号'); process.exit(1); }
const me = usable[Math.min(IDX, usable.length - 1)];
if (!isSendable(me)) { console.error('该账号不可发弹幕'); process.exit(1); }

let lastSent = 0;
let sentLog = [];
const COOLDOWN = 3500; // 两次出招最小间隔，防刷屏

async function act(text, reason) {
  if (!ACT) return;
  const now = Date.now();
  if (now - lastSent < COOLDOWN) return;
  lastSent = now;
  const r = await sendDanmaku({ cookie: me.cookie, roomId, text, biliJct: me.keys.bili_jct });
  const line = `[出招] ${me.uname} -> "${text}" (${reason}) => ${r.ok ? 'OK' : 'code=' + r.code + ' ' + r.message}`;
  console.log(line);
  sentLog.push({ t: new Date().toISOString(), text, reason, ok: r.ok, code: r.code });
}

// 阶段识别（依据游戏系统弹幕关键词；可在真实直播中观察后调整）
const done = { signup: false, room: false, vote: false, trial: false };
let phase = 'idle';

function onDanmaku(d) {
  const t = (d.text || '').trim();
  if (!t) return;
  const isSystem = /系统|提示|开始|结束|阶段|玩家|存活|报名|投票|审判|过夜|大厅|房间|处死|放过/.test(t);

  // 阶段推进（宽松匹配，真实直播时可据日志收紧）
  if (/报名|开始游戏|加入/.test(t)) {
    phase = 'signup';
    if (!done.signup) { done.signup = true; act('报名', '看到报名提示'); }
  }
  if (/选择|过夜|房间|躲|安全/.test(t)) {
    phase = 'choose';
    // 优先进房间避难（房间不会被老鼠攻击）。人数多时 A~D 都开
    if (!done.room) { done.room = true; act(pickRoom(), '进入过夜房间'); }
  }
  if (/投票|票选|最高票|上台/.test(t)) {
    phase = 'vote';
    if (!done.vote) { done.vote = true; act(String(pickVoteNumber()), '投票阶段'); }
  }
  if (/审判|处死|放过|444|666/.test(t)) {
    phase = 'trial';
    if (!done.trial) { done.trial = true; act(pickTrial(), '审判阶段'); }
  }

  if (isSystem) console.log(`  [系统] ${t}`);
}

// 每轮（新的一天）重置出招状态
function resetRound() { done.signup = done.signup; done.room = done.room; }

function pickRoom() {
  // 简单策略：随机选 A/D（17 人以下只开 A、D，保证合法）
  const rooms = ['A', 'D'];
  return rooms[Math.floor(Math.random() * rooms.length)];
}
function pickVoteNumber() {
  // 没有真实身份信息时，先随机投 1~15；接入身份牌/局势后改成推理
  return 1 + Math.floor(Math.random() * 15);
}
function pickTrial() {
  // 好人视角默认放过（666）；若判定台上是鬼则 444
  return '666';
}

const live = new BiliLive(roomId, {
  onEvent: (type, data) => {
    if (type === 'roominfo') console.log(`[房间] ${data.title} owner=${data.owner} live=${data.liveStatus}${data.liveStatus === 1 ? ' ✅在播' : ' ⚠️未开播'}`);
    else if (type === 'status') console.log(`[连接] ${JSON.stringify(data)}`);
    else if (type === 'danmaku') { console.log(`[弹幕] ${data.user}: ${data.text}`); onDanmaku(data); }
    else if (type === 'log') console.log(`[WS] ${data}`);
  },
});

console.log(`=== 弹幕狼人杀自动玩家 ===`);
console.log(`房间: ${roomId}  出招账号: ${me.uname} (uid=${me.uid})  模式: ${ACT ? '自动出招(--act)' : '只读观察'}`);
console.log(`提示：房间必须处于开播状态，且游戏在运行，弹幕才会被游戏读取。`);
live.start();

process.on('SIGINT', () => {
  console.log('\n=== 本次出招记录 ===');
  sentLog.forEach((s) => console.log(`  ${s.t} "${s.text}" (${s.reason}) ${s.ok ? 'OK' : 'fail ' + s.code}`));
  live.stop();
  process.exit(0);
});
