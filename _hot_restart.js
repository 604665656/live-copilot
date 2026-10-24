'use strict';
// 热更新导演：调 UI 页面的 window.api.directorRestart()（IPC director:restart）——只重启 Worker，不碰游戏窗口
const { CDP } = require('./_cdp');
(async () => {
  try {
    // 记录重启前游戏页面 targetId 与关卡
    const cdp = await CDP.attach(9222);
    const list = await cdp.send('Target.getTargets');
    const game = (list.targetInfos || []).find(t => t.type === 'page' && /ggsl-res/.test(t.url || ''));
    const ui = (list.targetInfos || []).find(t => t.type === 'page' && /ui\/index\.html/.test(t.url || ''));
    console.log('game target: ' + (game ? game.targetId.slice(0,8) : 'NONE'));
    if (game) {
      const att = await cdp.send('Target.attachToTarget', { targetId: game.targetId, flatten: true });
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){ try{ var M=window.__require('LiveBoBoMasterMgr').default; return 'lv='+M.lv+' state='+M.state; }catch(e){ return 'ERR '+e.message.slice(0,60); } })()`,
        returnByValue: true
      }, att.sessionId);
      console.log('BEFORE: ' + r.result.value);
    }
    if (!ui) { console.log('UI page not found'); process.exit(1); }
    const uatt = await cdp.send('Target.attachToTarget', { targetId: ui.targetId, flatten: true });
    const rr = await cdp.send('Runtime.evaluate', {
      expression: `(async function(){ try{ if(!window.api||!window.api.directorRestart) return 'no-api'; var r=await window.api.directorRestart(); return JSON.stringify(r); }catch(e){ return 'ERR '+e.message; } })()`,
      returnByValue: true, awaitPromise: true
    }, uatt.sessionId);
    console.log('RESTART: ' + rr.result.value);
    cdp.close();
    process.exit(0);
  } catch (e) { console.log('ERR ' + e.message); process.exit(1); }
})();
