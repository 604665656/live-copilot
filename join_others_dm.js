'use strict';
// join_others_dm.js — 用「助手」里 bili-relation-manager 的已登录账号，
// 向直播间发送真实的「加入」弹幕，让这些真实账号作为队友进入地下城。
// （机制与真人观众发弹幕加入完全一致，非伪造 uid 注入）
//
// 用法:
//   node join_others_dm.js                 # 向全部可发账号发「加入」
//   node join_others_dm.js 加入             # 指定弹幕词（加入/报名/加入游戏）
//   node join_others_dm.js 加入 98679142    # 仅指定 uid 测试
const { loadAccounts } = require('./-/src/accounts.js');

const ROOM = process.env.ROOM || 5391172;
const MSG = process.argv[2] || '加入';
const ONLY = process.argv[3] || null;

function ckObj(raw) {
  const c = {};
  String(raw || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) { const k = p.slice(0, i).trim(); if (k) c[k] = p.slice(i + 1).trim(); }
  });
  return c;
}

async function sendOne(acc) {
  const c = ckObj(acc.cookie);
  const body = new URLSearchParams({
    bubble: '0', msg: MSG, roomid: String(ROOM), rnd: String(Date.now()),
    color: '16777215', mode: '1', jump: '0', fontsize: '25',
    csrf: c.bili_jct || '', csrf_token: c.bili_jct || '',
  });
  const cookie = Object.entries(c).map(([k, v]) => k + '=' + v).join('; ');
  try {
    const r = await fetch('https://api.live.bilibili.com/msg/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie, 'Referer': 'https://live.bilibili.com/' + ROOM, 'User-Agent': 'Mozilla/5.0' },
      body: body.toString(),
    });
    const j = await r.json().catch(() => null);
    return j;
  } catch (e) { return { error: e.message }; }
}

(async () => {
  const { usable } = loadAccounts();
  const targets = ONLY ? usable.filter(a => String(a.uid) === String(ONLY)) : usable;
  console.log(`房间=${ROOM} 弹幕词=${MSG} 目标账号=${targets.length}（共 ${usable.length} 个可发）`);
  for (const acc of targets) {
    const j = await sendOne(acc);
    const code = j && j.code !== undefined ? j.code : '?';
    const msg = j && j.message ? j.message : JSON.stringify(j);
    console.log(`  ${acc.uname} (uid=${acc.uid}) -> code=${code} ${msg}`);
    await new Promise(r => setTimeout(r, 800));
  }
})();
