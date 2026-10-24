'use strict';
// 重载助手 UI 页面（renderer）：让新的 ui/index.html + ui/app.js 生效。不影响主进程/导演 Worker/游戏窗口。
const { CDP } = require('./_cdp');
(async () => {
  try {
    const cdp = await CDP.attach(9222);
    const list = await cdp.send('Target.getTargets');
    const ui = (list.targetInfos || []).find(t => t.type === 'page' && /ui\/index\.html/.test(t.url || ''));
    if (!ui) { console.log('UI page not found'); process.exit(1); }
    const att = await cdp.send('Target.attachToTarget', { targetId: ui.targetId, flatten: true });
    await cdp.send('Page.enable', {}, att.sessionId);
    await cdp.send('Page.reload', { ignoreCache: true }, att.sessionId);
    console.log('UI reloaded: ' + ui.url);
    cdp.close();
    process.exit(0);
  } catch (e) { console.log('ERR ' + e.message); process.exit(1); }
})();
