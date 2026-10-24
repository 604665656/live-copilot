// 从 _game_cdp.js 抽出的可复用库：Edge CDP 连接游戏页面
const { CDP } = require('./_cdp');
const fs = require('fs');

const GAME_URL = 'https://ggsl-res.hortorgames.com/web-desktop/index.html?pla=bli';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function browserCdp() {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  return new CDP(v.webSocketDebuggerUrl).connect();
}

async function gameSession({ create = true } = {}) {
  const cdp = await browserCdp();
  let sessionId = null;
  const list = await cdp.send('Target.getTargets');
  const exist = (list.targetInfos || []).find(t => t.type === 'page' && /ggsl-res\.hortorgames\.com/.test(t.url || ''));
  if (exist) {
    const att = await cdp.send('Target.attachToTarget', { targetId: exist.targetId, flatten: true });
    sessionId = att.sessionId;
  } else if (create) {
    const t = await cdp.send('Target.createTarget', { url: GAME_URL });
    const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    sessionId = att.sessionId;
  } else {
    cdp.close();
    return null;
  }
  const ev = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const shot = async (path) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  };
  const clickDesign = async (dx, dy) => {
    // 设计坐标(相对画布中心, y 向上) → 视图坐标 → CDP 真实鼠标点击
    const geo = await ev(`(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: c.clientWidth, h: c.clientHeight, dw: cc.view.getDesignResolutionSize().width, dh: cc.view.getDesignResolutionSize().height };
    })()`);
    if (!geo) throw new Error('no canvas');
    const vx = geo.left + (geo.dw / 2 + dx) * geo.w / geo.dw;
    const vy = geo.top + (geo.dh / 2 - dy) * geo.h / geo.dh;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vx, y: vy }, sessionId);
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vx, y: vy, button: 'left', clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vx, y: vy, button: 'left', clickCount: 1 }, sessionId);
    return { vx: Math.round(vx), vy: Math.round(vy) };
  };
  // 按节点名点击（自动换算世界坐标，最可靠）
  const clickNode = async (name, nth = 0) => {
    const pos = await ev(`(function(){
      var found = [];
      (function walk(n){ if(!n) return; if(n.name===${JSON.stringify(name)}) found.push(n); (n.children||[]).forEach(walk); })(cc.director.getScene());
      var n = found[${nth}];
      if (!n) return { ok:false, msg:'node not found: ' + ${JSON.stringify(name)}, count: found.length };
      var wp = n.convertToWorldSpaceAR(cc.v2(0,0));
      var c = document.querySelector('canvas');
      var r = c.getBoundingClientRect();
      var dw = cc.view.getDesignResolutionSize().width, dh = cc.view.getDesignResolutionSize().height;
      // 世界坐标原点 = 设计分辨率左下角, y 向上 → 视口坐标
      var sx = r.left + wp.x * r.width / dw;
      var sy = r.top + (dh - wp.y) * r.height / dh;
      return { ok:true, sx: sx, sy: sy, w: n.width, h: n.height, active: n.active };
    })()`);
    if (!pos.ok) return pos;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.sx, y: pos.sy }, sessionId);
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.sx, y: pos.sy, button: 'left', clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.sx, y: pos.sy, button: 'left', clickCount: 1 }, sessionId);
    return { ok: true, sx: Math.round(pos.sx), sy: Math.round(pos.sy), w: pos.w, h: pos.h, active: pos.active };
  };
  return { ev, shot, cdp, sessionId, clickDesign, clickNode, reused: !!exist };
}

module.exports = { gameSession, browserCdp, GAME_URL, sleep };
