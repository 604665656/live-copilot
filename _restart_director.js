'use strict';
// 热重启导演（在助手 UI 页面调用 window.api.directorRestart）——让 _director2.js 改动生效，游戏窗口不关
const { CDP } = require('./_cdp');
(async () => {
  try {
    const cdp = await CDP.attach(9222);
    const list = await cdp.send('Target.getTargets');
    const ui = (list.targetInfos || []).find(t => t.type === 'page' && /index\.html|localhost|127\.0\.0\.1/.test(t.url || '') && !/ggsl-res/.test(t.url || ''));
    if (!ui) { console.log('UI page not found; targets: ' + (list.targetInfos || []).map(t => t.url).join(' | ')); process.exit(1); }
    console.log('UI page:', ui.url);
    const att = await cdp.send('Target.attachToTarget', { targetId: ui.targetId, flatten: true });
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async function(){ try { var r = await window.api.directorRestart(); return JSON.stringify(r); } catch (e) { return 'ERR ' + e.message; } })()`,
      returnByValue: true, awaitPromise: true
    }, att.sessionId);
    console.log('restart:', r.result.value);
    cdp.close();
    process.exit(0);
  } catch (e) { console.log('ERR ' + e.message); process.exit(1); }
})();
