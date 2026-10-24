'use strict';
// 游戏宿主：内嵌游戏窗口 + 身份码自动填入 + 坐标点击 + 截屏识别
const { BrowserWindow } = require('electron');

const GAME_URL = 'https://ggsl-res.hortorgames.com/web-desktop/index.html?pla=bli';

// 基准坐标：全部由 Cocos 场景树标定（设计分辨率 1920x1080 → 画布 1344x781）
// 已用「已报名人数」真实变化验证：添加机器人 +1、x10 +10、主播报名 +1
const BASE = { w: 1344, h: 781 };
const ANCHORS = {
  codeInput: { x: 696, y: 347 },   // edit_pwd
  startBtn:  { x: 674, y: 473 },   // btn_login
  freeMode:  { x: 1198, y: 711 },  // 自由模式（节点名 btn_auto，名字具有误导性）
  foxNight:  { x: 1188, y: 586 },  // 妖狐之夜（节点名 btn_fox）—— 固定板子，无自定义
  auction:   { x: 998,  y: 711 },  // 靓长拍卖会（btn_auction）
  addBot:    { x: 829,  y: 716 },  // 添加机器人：+1 人
  addBot10:  { x: 902,  y: 716 },  // x10：一次 +10 人
  hostJoin:  { x: 850,  y: 671 },  // 主播报名：+1 人
  clearBtn:  { x: 848,  y: 436 },
  remember:  { x: 627,  y: 267 },
  autoMode:  { x: 46,   y: 765 },
  startGame: { x: 1209, y: 597 },
  backLobby: { x: 150,  y: 708 },
};

class GameHost {
  constructor(cfg = {}) {
    this.cfg = Object.assign({ width: 1360, height: 820 }, cfg);
    this.win = null;
    this.onEvent = cfg.onEvent || (() => {});
    this.absAnchors = {};   // 由场景树动态解析出的绝对坐标，优先于 ANCHORS
  }

  emit(type, data) { this.onEvent(type, data); }
  log(t) { this.emit('log', t); }

  async open() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return { ok: true };
    }
    this.win = new BrowserWindow({
      width: this.cfg.width,
      height: this.cfg.height,
      title: '弹幕狼人杀 · 游戏窗口',
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:game',
        backgroundThrottling: false,
        contextIsolation: true,
      },
    });
    this.win.webContents.on('console-message', (e, lvl, msg) => {
      if (/身份|失败|error/i.test(String(msg))) this.log('[game] ' + String(msg).slice(0, 120));
    });
    await this.win.loadURL(GAME_URL);
    this.log('游戏窗口已打开');
    // 等 Cocos 初始化
    await new Promise(r => setTimeout(r, 8000));
    return { ok: true, size: this.win.getContentSize() };
  }

  get contents() { return this.win && !this.win.isDestroyed() ? this.win.webContents : null; }

  // 基准坐标 → 当前 canvas 坐标
  async scaled(name) {
    // 场景树解析出的绝对坐标优先（已经是当前画布坐标系）
    if (this.absAnchors && this.absAnchors[name]) return this.absAnchors[name];
    const a = ANCHORS[name];
    if (!a) return null;
    const geo = await this.contents.executeJavaScript(
      `(function(){const c=document.querySelector('canvas');return c?{w:c.clientWidth,h:c.clientHeight}:null})()`
    );
    if (!geo) return a;
    return { x: Math.round(a.x * geo.w / BASE.w), y: Math.round(a.y * geo.h / BASE.h) };
  }

  // 一键进游戏：优先填码；身份码已被记住时（预填且无 DOM input）直接提交
  async enterGame(code) {
    const wc = this.contents;
    if (!wc) return { ok: false, msg: '游戏窗口未打开' };

    // 用场景树/Cocos API 操作 EditBox，替代反复点击（反复点会把焦点抢走导致按钮被吞）
    let ei = null, lb = null;
    try {
      const { GameScene } = require('./gamescene.js');
      this.scene = this.scene || new GameScene(wc);
      await this.scene.install();
      ei = await this.scene.clickNode('edit_pwd');
      lb = await this.scene.clickNode('btn_login');
    } catch (e) {
      this.log('场景解析跳过: ' + (e && e.message || e));
    }
    const inLogin = async () => {
      try {
        const t = await this.scene.texts();
        return !!(t && t.some(s => /身份码/.test(s)));
      } catch (e) { return null; }
    };

    // 1. 只有输入框为空时才写入身份码（身份码通常已被"记住"）
    const cur = await wc.executeJavaScript(`(() => {
      let n = null;
      (function walk(x) { if (n || !x) return; if (x.name === 'edit_pwd') { n = x; return; } (x.children || []).forEach(walk); })(cc.director.getScene());
      if (!n) return null;
      const eb = n.getComponent(cc.EditBox);
      return eb ? eb.string : null;
    })()`).catch(() => null);
    this.log('当前已存身份码: ' + (cur === null ? '(读不到)' : JSON.stringify(cur)));

    if (cur !== code) {
      const set = await wc.executeJavaScript(`(() => {
        let n = null;
        (function walk(x) { if (n || !x) return; if (x.name === 'edit_pwd') { n = x; return; } (x.children || []).forEach(walk); })(cc.director.getScene());
        if (!n) return { ok: false, msg: 'no node' };
        const eb = n.getComponent(cc.EditBox);
        if (!eb) return { ok: false, msg: 'no EditBox' };
        eb.string = ${JSON.stringify(String(code))};
        const tl = n.getChildByName('TEXT_LABEL');
        if (tl) { const l = tl.getComponent(cc.Label); if (l) l.string = ${JSON.stringify(String(code))}; }
        return { ok: true, string: eb.string };
      })()`).catch(e => ({ ok: false, msg: e.message }));
      this.log('写入身份码: ' + JSON.stringify(set));
      await new Promise(r => setTimeout(r, 400));
    } else {
      this.log('身份码已一致，无需重填');
    }
    if (ei) this.log(`edit_pwd -> (${ei.x},${ei.y})`);

    // 2. 只点一次登录按钮，然后耐心等待（多次点击会打断 Cocos 的 UI 切换）
    //    注意：身份码常被"记住"并显示为掩码，此时 EditBox 有值但游戏内部变量为空，
    //    必须用真实键盘输入触发一次 input 事件，否则点登录无任何反应。
    const doLogin = async () => {
      if (lb) {
        this.log(`点击 btn_login (${lb.x},${lb.y})`);
        await this.click(lb.x, lb.y);
      } else {
        const p = await this.scaled('startBtn');
        await this.click(p.x, p.y);
      }
    };

    // 先用真实键盘重打一遍身份码（保证内部变量与显示一致）
    if (ei) {
      try {
        await this.click(ei.x, ei.y);          // 聚焦 → Cocos 生成 DOM input
        await new Promise(r => setTimeout(r, 700));
        wc.selectAll();
        await new Promise(r => setTimeout(r, 150));
        // 清空后逐字插入，确保每次都有 input 事件
        await wc.delete();
        await new Promise(r => setTimeout(r, 150));
        wc.insertText(String(code));
        this.log('已用键盘重新输入身份码');
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        this.log('键盘输入失败: ' + (e && e.message || e));
      }
    }

    await doLogin();
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1500));
      if (await inLogin() === false) { this.log('已进入游戏大厅'); return { ok: true }; }
    }

    // 第二次尝试：直接点击输入框中部再敲一次
    this.log('首次登录未成功，重试一次');
    if (ei) {
      await this.click(ei.x, ei.y);
      await new Promise(r => setTimeout(r, 600));
      try { wc.selectAll(); await wc.delete(); } catch (e) { /* */ }
      wc.insertText(String(code));
      await new Promise(r => setTimeout(r, 500));
    }
    await doLogin();
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1500));
      if (await inLogin() === false) { this.log('已进入游戏大厅（重试成功）'); return { ok: true }; }
    }

    const texts = await this.scene.texts().catch(() => []);
    return { ok: false, msg: '提交后仍停留在身份码弹窗', texts };
  }

  // 检测登录弹窗（大面积纯白矩形）是否还在
  async dialogGone(img) {
    if (!img) return false;
    const { width: w, height: h } = img.getSize();
    // 采样弹窗区域中心带
    const buf = img.toBitmap(); // BGRA
    let white = 0, total = 0;
    for (let y = Math.floor(h * 0.35); y < Math.floor(h * 0.55); y += 4) {
      for (let x = Math.floor(w * 0.36); x < Math.floor(w * 0.64); x += 4) {
        const o = (y * w + x) * 4;
        const r = buf[o + 2], g = buf[o + 1], b = buf[o];
        total++;
        if (r > 235 && g > 235 && b > 235) white++;
      }
    }
    return total > 0 && white / total < 0.5;
  }

  // 预设锚点点击（主播报名/添加机器人/自动模式等）
  async tap(name) {
    const p = await this.scaled(name);
    if (!p) return { ok: false, msg: '未知锚点: ' + name };
    const r = await this.click(p.x, p.y);
    if (r.ok) this.log(`点击 ${name} (${p.x},${p.y})`);
    return r;
  }

  // 坐标点击（CSS 像素，相对游戏窗口客户区）
  async click(x, y) {
    const wc = this.contents;
    if (!wc) return { ok: false, msg: '游戏窗口未打开' };
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    await new Promise(r => setTimeout(r, 60));
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    this.emit('gamedclick', { x, y });
    return { ok: true };
  }

  async keyText(text) {
    const wc = this.contents;
    if (!wc) return { ok: false };
    for (const ch of String(text)) {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
    }
    return { ok: true };
  }

  async capture(filePath) {
    const wc = this.contents;
    if (!wc) return null;
    const img = await wc.capturePage();
    if (filePath) require('fs').writeFileSync(filePath, img.toPNG());
    return img;
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
  }
}

module.exports = { GameHost, GAME_URL };
