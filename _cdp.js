// 零依赖 CDP 客户端（优先用 Node 22 全局 WebSocket；Electron 33 自带 Node 20 无全局 WebSocket，回退到 ws 包）
'use strict';
const WS = globalThis.WebSocket || require('ws');

async function httpJson(url) {
  const r = await fetch(url);
  return r.json();
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async attach(port = 9222) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    const page = list.find(t => t.type === 'page') || list[0];
    if (!page) throw new Error('no page target: ' + JSON.stringify(list));
    return new CDP(page.webSocketDebuggerUrl).connect();
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WS(this.wsUrl);
      this.ws.onopen = () => res(this);
      this.ws.onerror = e => rej(new Error('ws error ' + e.message || e));
      this.ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? j(new Error(m.error.message || JSON.stringify(m.error))) : r(m.result);
        } else if (m.method) {
          for (const fn of this.handlers.get(m.method) || []) fn(m.params);
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  // 浏览器级：建 target 并附加会话，返回 {targetId, sessionId}
  async createTarget(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return { targetId, sessionId };
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  // ---- 常用封装 ----
  async setCookies(cookieStr, domain = '.bilibili.com') {
    for (const part of cookieStr.split(';').map(s => s.trim()).filter(Boolean)) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const name = part.slice(0, i).trim(), value = part.slice(i + 1).trim();
      await this.send('Network.setCookie', { name, value, domain, path: '/', secure: true });
    }
  }
  async evaluate(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async navigate(url) {
    this.navDone = new Promise(res => {
      const h = p => { if (!p.frame.url.startsWith('chrome-error')) res(); };
      this.on('Page.loadEventFired', () => {});
      this.onceLoad = h;
    });
    // 简化：navigate 后轮询 URL 与 readyState
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const st = await this.evaluate('document.readyState').catch(() => null);
      if (st === 'complete' || st === 'interactive') break;
    }
  }
  async screenshot(path, fullPage = false) {
    await this.send('Page.enable');
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    require('fs').writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  close() { try { this.ws.close(); } catch {} }
}
module.exports = { CDP };
