'use strict';
// _director.js — 弹幕狼人杀「导演」：按角色指挥 5 个真人账号 + 31 个机器人
//
// 机制（已从拆包代码验证）：
//   Hide(3)       躲门阶段：A/B/C/D 进房，大厅=不回。夜晚狼人按「同房间」自动刀人
//   Night(4)      自动结算（无需输入）
//   SelectPlayer(5) 白天选人上台：发号码，得票最高者上台(votePlayerId)
//   VotePlayer(6)   投票：444/雀食=杀  666/离谱=救
//   VoteResult(7)   处决或保存
//
// 指挥通道：
//   真人账号 → 真实弹幕（bili API）
//   机器人   → 本机直接调游戏 API（LiveWolfActions.Hide/SelectPlayer/VotePlayer）
//
// 用法: node _director.js [--no-start] [--dry]
const { gameSession } = require('./_game_cdp_lib');
const { loadAccounts } = require('./src/accounts');
const { sendDanmaku } = require('./src/bili');
const fs = require('fs');

const ROOM = Number(process.env.ROOM || 5391172);
const NO_START = process.argv.includes('--no-start');
const DRY = process.argv.includes('--dry');
const LOG = fs.createWriteStream('director.log', { flags: 'a' });
function log(...a) { const s = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + a.join(' '); console.log(s); LOG.write(s + '\n'); }

const ROLE = { 0: '老鼠', 1: '平民', 2: '狼人', 3: '双狼', 4: '混血', 5: '预言家', 6: '狮王', 7: '女巫', 8: '狗', 9: '愤青', 10: '狐狼', 11: '孤魂', 12: '狸猫', 13: '毒狼', 14: '蛊狼', 15: '酒鬼', 16: '狂人', 17: '武僧', 18: '九尾狐', 19: '傲白', 20: '病原狼', 21: '比赛狮王', 22: '比赛狸猫', 23: '比赛女巫' };
const CAMP = { 1: '好人', 2: '狼人' };
const DOOR = { 0: '大厅', 1: 'A门', 2: 'B门', 3: 'C门', 4: 'D门' };
const LETTER = { 0: '大厅', 1: 'A', 2: 'B', 3: 'C', 4: 'D' };

const { usable } = loadAccounts();
const MY = new Map(); // uid -> 账号对象
usable.forEach(a => MY.set(String(a.uid), a));
log('=== 导演启动 === 我方账号 ' + usable.length + ' 个: ' + usable.map(a => a.uname).join(' / '));

const HELPERS = `(function(){
  window.__D = {
    mgr: function(){ return window.__require('LiveWolfMgr').default; },
    ctl: function(){
      var c = null;
      (function walk(n){ if(!n||c) return; var k=n.getComponent('LiveWolfCtl'); if(k){c=k;return;} (n.children||[]).forEach(walk); })(cc.director.getScene());
      return c;
    },
    actions: function(){ return window.__require('LiveWolfActions').default; }
  };
  return 'ok';
})()`;

(async () => {
  const g = await gameSession({ create: false });
  if (!g) { log('连不上游戏页签（Edge 9222）'); process.exit(1); }
  await g.ev(HELPERS);

  async function readState() {
    const r = await g.ev(`(function(){
      var m = window.__D.mgr();
      var ps = [];
      m.players.forEach(function(p,uid){
        ps.push({uid:uid, no:p.no, name:p.name, robot:!!p.isRobot, die:!!p.isDie,
                 camp:p.role?p.role.campType:0, role:p.role?p.role.roleType:0});
      });
      var places = (m.places||[]).map(function(s){ return Array.from(s); });
      var sel = {};
      m.selectPlayer.forEach(function(v,k){ sel[k] = Array.from(v); });
      return JSON.stringify({state:m.state, night:m.curNightNum, players:ps, places:places,
        votePlayerId:m.votePlayerId||'', kill:Array.from(m.voteKillIds), life:Array.from(m.voteLifeIds),
        sel:sel, endTime:m.stateEndTime, model:m.model, watchers:m.watchers?m.watchers.size:0});
    })()`);
    return JSON.parse(r);
  }

  // 我方账号发真实弹幕
  async function dm(acc, text) {
    if (DRY) { log(`  [DRY] ${acc.uname} -> 「${text}」`); return { ok: true }; }
    const r = await sendDanmaku({ cookie: acc.cookie, roomId: ROOM, text, biliJct: acc.keys.bili_jct, uid: acc.uid });
    log(`  ${acc.uname}(uid=${acc.uid}) -> 「${text}」 ${r.ok ? '✅' : '❌ ' + r.code + ' ' + r.message}`);
    return r;
  }

  // 机器人本地动作（一次 eval 批量执行）
  async function robotAct(cmds, tag) {
    if (!cmds.length) return;
    if (DRY) { log(`  [DRY] 机器人 ${cmds.length} 个动作: ${cmds.map(c => c.uid + ':' + c.action + ':' + c.arg).join(' ')}`); return; }
    const r = await g.ev(`(function(){
      var ctl = window.__D.ctl(); if(!ctl) return 'no-ctl';
      var A = window.__D.actions();
      var cmds = ${JSON.stringify(cmds)};
      var done = [];
      cmds.forEach(function(c){
        try {
          if (c.action==='hide') A.Hide(ctl, {uid:c.uid, info:c.arg});
          else if (c.action==='sel') A.SelectPlayer(ctl, {uid:c.uid, info:String(c.arg)});
          else if (c.action==='vote') A.VotePlayer(ctl, {uid:c.uid, info:c.arg});
          done.push(c.uid);
        } catch(e){ done.push(c.uid+':ERR'); }
      });
      return done.join(',');
    })()`);
    log(`  🤖 机器人 ${tag} ${cmds.length} 个动作完成 (${r})`);
  }

  function findStartBtn() {
    return g.ev(`(function(){
      var hit = null;
      (function walk(n){ if(!n||hit) return;
        var B = n.getComponent && n.getComponent(cc.Button);
        if (B && n.active) {
          var lab = null;
          (n.children||[]).forEach(function(c){ var L=c.getComponent&&c.getComponent(cc.Label); if(L&&L.string) lab=L.string; });
          if (lab === '开始' || /start/i.test(n.name)) hit = n.name;
        }
        (n.children||[]).forEach(walk);
      })(cc.director.getScene());
      return hit || '';
    })()`);
  }

  // ---------- 阶段处理 ----------
  const done = new Set(); // 已处理的阶段键
  let started = false;

  async function onReady(st) {
    const mine = st.players.filter(p => MY.has(String(p.uid)));
    log(`[Ready] 房间 ${st.players.length} 人，我方在场 ${mine.length}/5`);
    if (started || NO_START) return;
    if (mine.length >= 5) {
      const btn = await findStartBtn();
      if (btn) {
        log('  ▶ 点击「开始」发牌');
        const r = await g.clickNode(btn);
        log('  点击结果: ' + JSON.stringify(r));
        started = true;
      } else log('  找不到开始按钮');
    }
  }

  async function onHide(st) {
    const alive = st.players.filter(p => !p.die);
    const wolves = alive.filter(p => p.camp === 2);
    const goods = alive.filter(p => p.camp === 1);
    log(`[Hide 第${st.night + 1}天躲门] 存活 ${alive.length}（狼 ${wolves.length} / 好人 ${goods.length}）`);
    if (wolves.length) log('  狼: ' + wolves.map(w => w.no + '号' + (MY.has(String(w.uid)) ? '(我方)' : '')).join(' '));

    const NROOM = 5; // 0=大厅 1=A 2=B 3=C 4=D
    const doors = [1, 2, 3, 4];
    // ① 虚拟好人布局：好人均匀铺满 5 间房（供狼人"狩猎"决策）
    const virtual = Array.from({ length: NROOM }, () => ({ wolves: 0, goods: 0 }));
    goods.forEach((p, i) => { virtual[i % NROOM].goods++; });
    // ② 狼机器人先选房：按虚拟好人数挑最多的房（真实狩猎，承诺后不再改）
    const vc = virtual.map(v => ({ ...v }));
    const wolfCmds = [];
    alive.filter(p => p.robot && p.camp === 2).forEach(p => {
      const best = doors.slice().sort((a, b) => (vc[b].goods - vc[b].wolves) - (vc[a].goods - vc[a].wolves))[0];
      vc[best].wolves++;
      wolfCmds.push({ uid: p.uid, action: 'hide', arg: LETTER[best] });
    });
    if (wolfCmds.length) log('  🐺 狼机器人狩猎: ' + wolfCmds.map(c => { const p = st.players.find(x => x.uid === c.uid); return p.no + '号→' + c.arg; }).join(' '));
    await robotAct(wolfCmds, '躲门');
    await sleep(600);
    st = await readState();
    // ③ 实际房间计数（狼已落位）
    const ac = Array.from({ length: NROOM }, () => ({ wolves: 0, goods: 0 }));
    (st.places || []).forEach((set, i) => set.forEach(u => {
      const p = st.players.find(x => String(x.uid) === String(u));
      if (p && !p.die) { if (p.camp === 2) ac[i].wolves++; else ac[i].goods++; }
    }));
    // ④ 好机器人后手躲：无狼房分散进；都无狼房不成立则进狼最少的
    const goodBotCmds = [];
    alive.filter(p => p.robot && p.camp === 1).forEach(p => {
      const zero = doors.filter(i => ac[i].wolves === 0).sort((a, b) => ac[a].goods - ac[b].goods);
      const room = zero.length ? zero[0] : (ac[0].wolves === 0 ? 0 : doors.slice().sort((a, b) => ac[a].wolves - ac[b].wolves)[0]);
      ac[room].goods++;
      goodBotCmds.push({ uid: p.uid, action: 'hide', arg: LETTER[room] });
    });
    if (goodBotCmds.length) log('  🤖 好机器人躲门: ' + goodBotCmds.map(c => { const p = st.players.find(x => x.uid === c.uid); return p.no + '号→' + c.arg; }).join(' '));
    await robotAct(goodBotCmds, '躲门');
    await sleep(600);
    st = await readState();
    (st.places || []).forEach((set, i) => set.forEach(u => {
      const p = st.players.find(x => String(x.uid) === String(u));
      if (p && !p.die) { if (p.camp === 2) ac[i].wolves++; else ac[i].goods++; }
    }));

    // ⑤ 好账号最后躲（弹幕有延迟，等狼账号落位——本局无狼账号也照等）
    const goodAccs = alive.filter(p => !p.robot && p.camp === 1 && MY.has(String(p.uid)));
    if (goodAccs.length) {
      await sleep(2000);
      for (const gp of goodAccs) {
        const zero = doors.filter(i => ac[i].wolves === 0).sort((a, b) => ac[a].goods - ac[b].goods);
        const room = zero.length ? zero[0] : (ac[0].wolves === 0 ? 0 : doors.slice().sort((a, b) => ac[a].wolves - ac[b].wolves)[0]);
        ac[room].goods++;
        log(`  😇 好账号 ${gp.no}号${gp.name} → ${LETTER[room]}${zero.length ? '(无狼房)' : '(狼最少)'}`);
        await dm(MY.get(String(gp.uid)), LETTER[room]);
        await sleep(500);
      }
    }
    // ⑥ 狼账号（本局没有也保留逻辑）
    const wolfAccs = alive.filter(p => !p.robot && p.camp === 2 && MY.has(String(p.uid)));
    for (const w of wolfAccs) {
      const best = doors.slice().sort((a, b) => (ac[b].goods - ac[b].wolves) - (ac[a].goods - ac[a].wolves))[0];
      ac[best].wolves++;
      log(`  🐺 狼账号 ${w.no}号${w.name} → ${LETTER[best]}(好人${ac[best].goods})`);
      await dm(MY.get(String(w.uid)), LETTER[best]);
      await sleep(500);
    }
  }

  async function onSelect(st) {
    const alive = st.players.filter(p => !p.die);
    const wolves = alive.filter(p => p.camp === 2);
    // 谁在选狼？（读 selectPlayer: targetUid -> [voterUids]）
    const selectingWolves = new Set();
    Object.entries(st.sel).forEach(([tgt, voters]) => {
      const t = st.players.find(p => p.uid === tgt);
      if (t && t.camp === 2) voters.forEach(v => selectingWolves.add(v));
    });
    log(`[SelectPlayer 第${st.night}天白天选人] 存活 ${alive.length}，狼 ${wolves.length}: ${wolves.map(w => w.no + '号' + (MY.has(String(w.uid)) ? '(我方)' : '')).join(' ') || '无'}`);

    // 好阵营目标：优先选「非我方」的狼（保护我方狼账号）；若我方无狼则选威胁最大的狼
    const myWolves = wolves.filter(w => MY.has(String(w.uid)));
    const pickForGood = () => {
      if (!wolves.length) return null;
      if (myWolves.length) { const other = wolves.filter(w => !MY.has(String(w.uid))); if (other.length) return other[0]; return myWolves[0]; }
      return wolves[0];
    };
    // 狼阵营目标：优先选「正在选狼的好账号」(威胁)，再选任意好账号，最后任意好人
    const pickForWolf = () => {
      const goods = alive.filter(p => p.camp === 1);
      const myGoods = goods.filter(x => MY.has(String(x.uid)));
      const threat = myGoods.find(x => selectingWolves.has(x.uid));
      if (threat) return threat;
      if (myGoods.length) return myGoods[0];
      return goods[0] || null;
    };

    // 机器人先选（瞬间）
    const botCmds = [];
    alive.filter(p => p.robot).forEach(p => {
      const t = p.camp === 2 ? pickForWolf() : pickForGood();
      if (t) botCmds.push({ uid: p.uid, action: 'sel', arg: t.no });
    });
    if (botCmds.length) log('  🤖 机器人选人: ' + botCmds.map(c => c.arg + '号').join(' '));
    await robotAct(botCmds, '选人');

    // 账号后选（弹幕有延迟，先发）
    for (const p of alive.filter(x => !x.robot && MY.has(String(x.uid)))) {
      const t = p.camp === 2 ? pickForWolf() : pickForGood();
      if (t) { log(`  ${p.camp === 2 ? '🐺' : '😇'} ${p.no}号${p.name} → 选 ${t.no}号`); await dm(MY.get(String(p.uid)), String(t.no)); await sleep(500); }
    }
  }

  async function onVote(st) {
    const alive = st.players.filter(p => !p.die);
    const staged = st.players.find(p => p.uid === st.votePlayerId);
    if (!staged) { log('[VotePlayer] 无人上台，跳过'); return; }
    const stagedIsWolf = staged.camp === 2;
    log(`[VotePlayer 第${st.night}天投票] 上台: ${staged.no}号${staged.name}(${ROLE[staged.role]||staged.role},${CAMP[staged.camp]}) ${stagedIsWolf ? '→ 好人投444处决 / 狼人投666救' : '→ 好人投666救 / 狼人投444杀'}`);
    const myVote = stagedIsWolf ? '444' : '666'; // 好人视角
    const wolfVote = stagedIsWolf ? '666' : '444';

    const botCmds = [];
    alive.filter(p => p.robot).forEach(p => botCmds.push({ uid: p.uid, action: 'vote', arg: p.camp === 2 ? wolfVote : myVote }));
    await robotAct(botCmds, '投票');

    for (const p of alive.filter(x => !x.robot && MY.has(String(x.uid)))) {
      const v = p.camp === 2 ? wolfVote : myVote;
      log(`  ${p.camp === 2 ? '🐺' : '😇'} ${p.no}号${p.name} → 「${v}」`);
      await dm(MY.get(String(p.uid)), v);
      await sleep(500);
    }
  }

  function onNight(st) {
    log(`[Night 第${st.night}天夜晚] 自动结算中… 当前存活 ${st.players.filter(p => !p.die).length}`);
  }
  function onVoteResult(st) {
    const staged = st.players.find(p => p.uid === st.votePlayerId);
    log(`[VoteResult] 杀票 ${st.kill.length} / 救票 ${st.life.length}${staged ? '，上台者 ' + staged.no + '号' + staged.name : ''}`);
  }
  function onEnd(st) {
    const alive = st.players.filter(p => !p.die);
    const w = alive.filter(p => p.camp === 2).length;
    log(`[End] 游戏结束！存活 ${alive.length} 人，剩余狼 ${w} → ${w === 0 ? '✅ 好人阵营胜利' : '🐺 狼人阵营胜利'}`);
    log('  我方结局: ' + st.players.filter(p => MY.has(String(p.uid))).map(p => `${p.no}号${p.name}(${ROLE[p.role]})${p.die ? '死亡' : '存活'}`).join(' '));
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- 主循环 ----------
  log('进入主循环（每 400ms 读一次状态）');
  let lastKey = '';
  while (true) {
    let st;
    try { st = await readState(); } catch (e) { await sleep(1000); continue; }
    const key = st.state + '@' + st.night;
    if (key !== lastKey) {
      lastKey = key;
      if (!done.has(key)) {
        done.add(key);
        try {
          if (st.state === 1) await onReady(st);
          else if (st.state === 3) await onHide(st);
          else if (st.state === 4) onNight(st);
          else if (st.state === 5) await onSelect(st);
          else if (st.state === 6) await onVote(st);
          else if (st.state === 7) onVoteResult(st);
          else if (st.state === 8) onEnd(st);
        } catch (e) { log('阶段处理出错: ' + e.message); }
      }
    }
    await sleep(400);
  }
})().catch(e => { log('FATAL ' + e.message); process.exit(1); });
