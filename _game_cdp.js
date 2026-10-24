'use strict';
// 用 Edge CDP 直接驱动《我的粉丝里有鬼》网页版（主机端）
// 浏览器级连接 + Target.createTarget + flatten session
// 子命令: open | enter | wait | dump | shot | eval <expr>
const { CDP } = require('./_cdp');
const { PAGE_HELPERS } = require('./src/gamescene');
const fs = require('fs');

const GAME_URL = 'https://ggsl-res.hortorgames.com/web-desktop/index.html?pla=bli';
const CODE = 'BJSPTSVR93B43';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function browserCdp() {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  return new CDP(v.webSocketDebuggerUrl).connect();
}

// 返回带 session 的求值器 { ev, cdp }
async function gameSession({ create = true } = {}) {
  const cdp = await browserCdp();
  let sessionId = null;
  // 复用已存在的游戏 target
  const list = await cdp.send('Target.getTargets');
  const exist = (list.targetInfos || []).find(t => t.type === 'page' && /ggsl-res\.hortorgames\.com/.test(t.url || ''));
  if (exist) {
    const att = await cdp.send('Target.attachToTarget', { targetId: exist.targetId, flatten: true });
    sessionId = att.sessionId;
    console.log('reuse game target:', (exist.url || '').slice(0, 70));
  } else if (create) {
    const t = await cdp.send('Target.createTarget', { url: GAME_URL });
    const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    sessionId = att.sessionId;
    console.log('created game target:', t.targetId);
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
  // 设计坐标(1920x1080, y 向上) → 视口坐标 → CDP 真实鼠标点击
  const clickDesign = async (dx, dy) => {
    const geo = await ev(`(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: c.clientWidth, h: c.clientHeight, dw: cc.view.getDesignResolutionSize().width, dh: cc.view.getDesignResolutionSize().height };
    })()`);
    if (!geo) throw new Error('no canvas');
    const vx = geo.left + dx * geo.w / geo.dw;
    const vy = geo.top + (geo.dh - dy) * geo.h / geo.dh;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vx, y: vy }, sessionId);
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vx, y: vy, button: 'left', clickCount: 1 }, sessionId);
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vx, y: vy, button: 'left', clickCount: 1 }, sessionId);
    return { vx: Math.round(vx), vy: Math.round(vy) };
  };
  return { ev, shot, cdp, sessionId, clickDesign };
}

async function ensureGS(ev) {
  await ev(PAGE_HELPERS);
  for (let i = 0; i < 60; i++) {
    const ok = await ev('!!(window.__GS && window.__GS.ready())').catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'open') {
    const g = await gameSession();
    await sleep(4000);
    const ok = await ensureGS(g.ev);
    console.log('GS ready:', ok);
    if (ok) console.log('texts:', JSON.stringify((await g.ev('window.__GS.texts()')).slice(0, 40)));
    g.cdp.close();
  } else if (cmd === 'enter') {
    const g = await gameSession();
    const ok = await ensureGS(g.ev);
    if (!ok) { console.log('GS not ready'); g.cdp.close(); return; }
    const setR = await g.ev(`(() => {
      let n = null;
      (function walk(x){ if (n||!x) return; if (x.name==='edit_pwd'){n=x;return;} (x.children||[]).forEach(walk); })(cc.director.getScene());
      if (!n) return { ok:false, msg:'no edit_pwd node' };
      const eb = n.getComponent(cc.EditBox);
      if (!eb) return { ok:false, msg:'no EditBox' };
      eb.string = ${JSON.stringify(CODE)};
      const tl = n.getChildByName('TEXT_LABEL');
      if (tl) { const l = tl.getComponent(cc.Label); if (l) l.string = ${JSON.stringify(CODE)}; }
      return { ok:true, string: eb.string };
    })()`);
    console.log('set code:', JSON.stringify(setR));
    await sleep(400);
    const clickR = await g.ev(`(() => {
      let n = null;
      (function walk(x){ if (n||!x) return; if (x.name==='btn_login'){n=x;return;} (x.children||[]).forEach(walk); })(cc.director.getScene());
      if (!n) return { ok:false, msg:'no btn_login' };
      const btn = n.getComponent(cc.Button);
      if (!btn) return { ok:false, msg:'no Button comp' };
      const evts = btn.clickEvents || [];
      let errs = [];
      for (const ev of evts) {
        try {
          const comp = ev.component;
          if (comp && typeof comp[ev.handler] === 'function') comp[ev.handler](ev.customEventData || '', n);
          else errs.push('no handler ' + ev.handler);
        } catch (e) { errs.push(String(e && e.message || e)); }
      }
      if (!evts.length) { try { n.emit('click', n); } catch (e) { errs.push('emit:' + e.message); } }
      return { ok: !errs.length, handlers: evts.length, errs };
    })()`);
    console.log('click login:', JSON.stringify(clickR));
    g.cdp.close();
  } else if (cmd === 'wait') {
    const g = await gameSession();
    for (let i = 0; i < 90; i++) {
      let joined = '';
      try {
        const ok = await g.ev('!!(window.__GS && window.__GS.ready())');
        if (ok) joined = (await g.ev('window.__GS.texts()')).join(' | ');
      } catch (e) { /* 页面加载中 */ }
      if (/已?报名\s*\d+\s*[\/／]\s*\d+/.test(joined)) {
        console.log('IN LOBBY:', joined.match(/已?报名[^|]{0,14}/)[0]);
        g.cdp.close();
        return;
      }
      if (i % 5 === 0) console.log(`  waiting(${i}s): ${joined.slice(0, 110)}`);
      await sleep(1000);
    }
    console.log('timeout waiting lobby');
    g.cdp.close();
  } else if (cmd === 'dump') {
    const g = await gameSession();
    const ok = await ensureGS(g.ev);
    if (!ok) { console.log('GS not ready'); g.cdp.close(); return; }
    const d = await g.ev('window.__GS.all()');
    fs.writeFileSync('game-tree.json', JSON.stringify(d));
    console.log('nodes:', d.length, '-> game-tree.json');
    const cl = await g.ev('window.__GS.clickables()');
    fs.writeFileSync('game-clickables.json', JSON.stringify(cl));
    console.log('clickables:', cl.length);
    g.cdp.close();
  } else if (cmd === 'shot') {
    const g = await gameSession();
    await sleep(1500);
    await g.shot(process.argv[3] || 'game-cdp.png');
    console.log('saved');
    g.cdp.close();
  } else if (cmd === 'tapnode') {
    const g = await gameSession();
    const ok = await ensureGS(g.ev);
    if (!ok) { console.log('GS not ready'); g.cdp.close(); return; }
    const name = process.argv[3];
    const times = Number(process.argv[4] || 1);
    for (let i = 0; i < times; i++) {
      const r = await g.ev(`(() => {
        let n = null;
        (function walk(x){ if (n||!x) return; if (x.name==='${name}'){n=x;return;} (x.children||[]).forEach(walk); })(cc.director.getScene());
        if (!n) return { ok:false, msg:'no node ${name}' };
        const btn = n.getComponent(cc.Button);
        if (btn) {
          const evts = btn.clickEvents || [];
          let errs = [];
          for (const ev of evts) {
            try {
              const comp = ev.component;
              if (comp && typeof comp[ev.handler] === 'function') comp[ev.handler](ev.customEventData || '', n);
              else errs.push('no handler ' + ev.handler);
            } catch (e) { errs.push(String(e && e.message || e)); }
          }
          if (!evts.length) { try { n.emit('click', n); } catch (e) { errs.push('emit:' + e.message); } }
          return { ok: !errs.length, handlers: evts.length, errs };
        }
        try { n.emit('click', n); return { ok:true, via:'emit-noBtn' }; } catch (e) { return { ok:false, msg:e.message }; }
      })()`);
      const cnt = await g.ev(`(() => { const j = window.__GS.texts().join('|'); const m = j.match(/已报名\\s*(\\d+)\\s*[\\/／]\\s*(\\d+)/); return m ? m[1] + '/' + m[2] : '?'; })()`);
      console.log(`tap ${name} #${i + 1}: ${JSON.stringify(r)} -> ${cnt}`);
      await sleep(300);
    }
    g.cdp.close();
  } else if (cmd === 'clickws') {
    // clickws <设计x> <设计y> [次数]
    const g = await gameSession();
    const ok = await ensureGS(g.ev);
    if (!ok) { console.log('GS not ready'); g.cdp.close(); return; }
    const dx = Number(process.argv[3]), dy = Number(process.argv[4]), times = Number(process.argv[5] || 1);
    for (let i = 0; i < times; i++) {
      const pos = await g.clickDesign(dx, dy);
      const cnt = await g.ev(`(() => { const j = window.__GS.texts().join('|'); const m = j.match(/已报名\\s*(\\d+)\\s*[\\/／]\\s*(\\d+)/); return m ? m[1] + '/' + m[2] : '?'; })()`);
      console.log(`clickws (${dx},${dy}) #${i + 1} -> viewport (${pos.vx},${pos.vy}) 人数 ${cnt}`);
      await sleep(400);
    }
    g.cdp.close();
  } else if (cmd === 'eval') {
    const g = await gameSession();
    const ok = await ensureGS(g.ev);
    if (!ok) { console.log('GS not ready'); g.cdp.close(); return; }
    const r = await g.ev(process.argv[3]);
    console.log(typeof r === 'string' ? r : JSON.stringify(r).slice(0, 6000));
    g.cdp.close();
  } else {
    console.log('usage: node _game_cdp.js open|enter|wait|dump|shot|eval <expr>');
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
