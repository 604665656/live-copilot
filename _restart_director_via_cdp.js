'use strict';
// 通过 CDP 连接到「弹幕狼人杀 · AI 主播助手」控制面板，调用 window.api.directorRestart()
// 触发 IPC director:restart（stopDirector + startDirector）。仅重启导演 Worker，不关闭游戏窗口。
const WS = globalThis.WebSocket;
const httpGet = (url) => fetch(url).then((r) => r.json());

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close: () => ws.close(),
      })
    );
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
        else p.res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e && e.message))));
  });
}

(async () => {
  const targets = await httpGet('http://127.0.0.1:9222/json');
  const panel = targets.find((t) => t.type === 'page' && /AI 主播助手/.test(t.title));
  if (!panel) { console.error('控制面板 target 未找到（当前 CDP targets: ' + targets.map((t) => t.title).join(' | ') + '）'); process.exit(2); }
  console.log('[ok] 找到控制面板 target:', panel.id, '|', panel.title);
  const cdp = await cdpConnect(panel.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const result = await cdp.send('Runtime.evaluate', {
    expression: 'window.api.directorRestart()',
    returnByValue: true,
    awaitPromise: true,
  });
  console.log('[ok] directorRestart 调用结果:', JSON.stringify(result && result.result));
  await cdp.close();
  process.exit(0);
})().catch((e) => { console.error('[ERR]', e && e.message); process.exit(1); });
