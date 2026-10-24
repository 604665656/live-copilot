'use strict';
// 从全部可用账号向直播间发「报名」，把 5 个账号注册进当前这一局《我的粉丝里有鬼》
const { loadAccounts } = require('./src/accounts');
const { sendDanmaku } = require('./src/bili');
const ROOM = Number(process.argv[2] || 5391172);
const TEXT = process.argv[3] || '报名';

(async () => {
  const { usable } = loadAccounts();
  console.log(`=== 向 ${ROOM} 发送「${TEXT}」（${usable.length} 个账号）===`);
  let ok = 0;
  for (const acc of usable) {
    const r = await sendDanmaku({ cookie: acc.cookie, roomId: ROOM, text: TEXT, biliJct: acc.keys.bili_jct });
    console.log(`  ${acc.uname} (uid=${acc.uid}): ${r.ok ? '✅ OK' : '❌ code=' + r.code + ' ' + r.message}`);
    if (r.ok) ok++;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`=== 成功 ${ok}/${usable.length} ===`);
})();
