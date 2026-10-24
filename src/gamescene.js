'use strict';
// 场景操作层：直接读 Cocos 场景树，按 Label 文字定位节点并触发点击
// 依赖页面里有全局 cc（Cocos Creator 2.x）。坐标/文字全部来自游戏真实节点，不做像素猜测。

// 注入到页面上下文的工具集（只装一次）
const PAGE_HELPERS = `
(function () {
  if (window.__GS) return 'already';
  var GS = {
    ready: function () {
      return !!(window.cc && cc.director && cc.director.getScene());
    },
    design: function () {
      try { var s = cc.view.getDesignResolutionSize(); return { w: s.width, h: s.height }; }
      catch (e) { return null; }
    },
    all: function () {
      var out = [];
      if (!this.ready()) return out;
      var scene = cc.director.getScene();
      var self = this;
      (function walk(n, d) {
        if (!n || out.length > 3000) return;
        var comps = [];
        try { comps = (n._components || []).map(function (c) { return c.__classname__ || '?'; }); } catch (e) {}
        var label = '';
        try {
          var l = (n.getComponent && cc.Label) ? n.getComponent(cc.Label) : null;
          if (l && typeof l.string === 'string') label = l.string;
        } catch (e) {}
        var ws = null;
        try { var p = n.convertToWorldSpaceAR(cc.v2(0, 0)); ws = { x: p.x, y: p.y }; } catch (e) {}
        var sz = null;
        try { if (n._contentSize) sz = { w: n._contentSize.width, h: n._contentSize.height }; } catch (e) {}
        out.push({
          i: out.length, d: d, name: n.name, label: label, comps: comps, ws: ws, sz: sz,
          active: n.activeInHierarchy !== false
        });
        var kids = n.children || [];
        for (var k = 0; k < kids.length; k++) walk(kids[k], d + 1);
      })(scene, 0);
      return out;
    },
    nodeList: function () {
      var out = [];
      if (!this.ready()) return out;
      var scene = cc.director.getScene();
      (function walk(n) {
        if (!n || out.length > 3000) return;
        out.push(n);
        var kids = n.children || [];
        for (var k = 0; k < kids.length; k++) walk(kids[k]);
      })(scene, 0);
      return out;
    },
    labels: function () {
      return this.all().filter(function (o) {
        return o.active && o.label && String(o.label).trim();
      }).map(function (o) {
        return { text: o.label, name: o.name, ws: o.ws };
      });
    },
    texts: function () {
      var seen = {}, out = [];
      this.labels().forEach(function (l) {
        var t = String(l.text).replace(/\\s+/g, ' ').trim();
        if (!t || seen[t]) return;
        seen[t] = 1; out.push(t);
      });
      return out;
    },
    buttons: function () {
      return this.all().filter(function (o) {
        return o.active && o.comps.indexOf('cc.Button') >= 0;
      });
    },
    // 按文字找节点（默认包含匹配）
    find: function (text, exact) {
      var t = String(text);
      var ns = this.nodeList();
      var res = [];
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        if (!n || n.activeInHierarchy === false) continue;
        var label = '';
        try {
          var l = (n.getComponent && cc.Label) ? n.getComponent(cc.Label) : null;
          if (l && typeof l.string === 'string') label = l.string;
        } catch (e) {}
        if (!label) continue;
        var hit = exact ? (label === t) : (label.indexOf(t) >= 0);
        if (hit) {
          var ws = null;
          try { var p = n.convertToWorldSpaceAR(cc.v2(0, 0)); ws = { x: p.x, y: p.y }; } catch (e) {}
          res.push({ node: n, label: label, ws: ws });
        }
      }
      return res;
    },
    // 触发点击：优先调用 Button 的 clickEvents，其次 node.emit
    clickText: function (text, exact) {
      var hits = this.find(text, exact);
      if (!hits.length) {
        return { ok: false, msg: '未找到文字: ' + text, visible: this.texts().slice(0, 60) };
      }
      var tried = [];
      for (var h = 0; h < hits.length; h++) {
        var node = hits[h].node;
        var cur = node;
        for (var up = 0; up < 5 && cur; up++) {
          var btn = null;
          try { btn = cur.getComponent ? cur.getComponent(cc.Button) : null; } catch (e) {}
          if (btn) {
            var evts = btn.clickEvents || [];
            if (evts.length) {
              var errs = [];
              for (var e = 0; e < evts.length; e++) {
                var ev = evts[e];
                try {
                  var comp = ev.component;
                  if (comp && typeof comp[ev.handler] === 'function') {
                    comp[ev.handler](ev.customEventData || '', cur);
                  } else {
                    errs.push('缺 handler ' + ev.handler);
                  }
                } catch (err) { errs.push(String(err && err.message || err)); }
              }
              return {
                ok: errs.length === 0, via: 'clickEvents', node: cur.name,
                label: hits[h].label, handlers: evts.length, errs: errs, ws: hits[h].ws
              };
            }
            // 没有 clickEvents，走事件派发
            try { cur.emit('click', cur); } catch (err) {}
            tried.push({ node: cur.name, via: 'emit' });
          }
          cur = cur.parent;
        }
      }
      var first = hits[0];
      return {
        ok: false, via: 'none', label: first.label,
        msg: '找到节点但无 Button 组件/未注册 clickEvents，需要按坐标点击',
        ws: first.ws, tried: tried
      };
    },
    // 枚举所有可点按钮：文字 + 世界坐标
    clickables: function () {
      var out = [];
      var ns = this.nodeList();
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        if (!n || n.activeInHierarchy === false) continue;
        var btn = null;
        try { btn = n.getComponent ? n.getComponent(cc.Button) : null; } catch (e) {}
        if (!btn) continue;
        var label = '';
        var self = n;
        var l = null;
        try { l = self.getComponent(cc.Label); } catch (e) {}
        if (l) label = l.string;
        if (!label) {
          var kids = self.children || [];
          for (var k = 0; k < kids.length && !label; k++) {
            try { var kl = kids[k].getComponent(cc.Label); if (kl && kl.string) label = kl.string; } catch (e) {}
          }
        }
        var ws = null;
        try { var p = n.convertToWorldSpaceAR(cc.v2(0, 0)); ws = { x: Math.round(p.x), y: Math.round(p.y) }; } catch (e) {}
        var sz = null;
        try { if (n._contentSize) sz = { w: Math.round(n._contentSize.width), h: Math.round(n._contentSize.height) }; } catch (e) {}
        out.push({ name: n.name, label: String(label || '').replace(/\\s+/g, ' ').trim(), ws: ws, sz: sz, handlers: (btn.clickEvents || []).length });
      }
      return out;
    }
  };
  window.__GS = GS;
  return 'installed';
})()
`;

class GameScene {
  constructor(wc) { this.wc = wc; }

  async install() {
    return this.wc.executeJavaScript(PAGE_HELPERS + ';window.__GS ? "ok" : "fail"');
  }

  async ensure() {
    const ok = await this.wc.executeJavaScript('!!(window.__GS && window.__GS.ready())');
    if (!ok) { await this.install(); return this.wc.executeJavaScript('!!(window.__GS && window.__GS.ready())'); }
    return true;
  }

  async dump() {
    await this.ensure();
    return this.wc.executeJavaScript(`(() => {
      const g = window.__GS;
      if (!g || !g.ready()) return { error: 'engine not ready' };
      return { design: g.design(), nodes: g.all(), clickables: g.clickables(), texts: g.texts() };
    })()`);
  }

  async clickables() {
    await this.ensure();
    return this.wc.executeJavaScript('window.__GS ? window.__GS.clickables() : []');
  }

  async texts() {
    await this.ensure();
    return this.wc.executeJavaScript('window.__GS ? window.__GS.texts() : []');
  }

  async clickText(text, exact = false) {
    await this.ensure();
    return this.wc.executeJavaScript(
      `window.__GS.clickText(${JSON.stringify(String(text))}, ${exact ? 'true' : 'false'})`
    );
  }

  // 按节点名解析出画布点击坐标（世界坐标 → 画布坐标）
  async resolve(name) {
    await this.ensure();
    const raw = await this.wc.executeJavaScript(`(() => {
      if (!window.__GS || !window.__GS.ready()) return null;
      let target = null;
      (function walk(n) {
        if (target || !n) return;
        if (n.name === ${JSON.stringify(String(name))}) { target = n; return; }
        var kids = n.children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
      })(cc.director.getScene());
      if (!target) return null;
      var p = null;
      try { p = target.convertToWorldSpaceAR(cc.v2(0, 0)); } catch (e) { return null; }
      var dr = cc.view.getDesignResolutionSize();
      var c = document.querySelector('canvas');
      return {
        ws: { x: p.x, y: p.y },
        design: { w: dr.width, h: dr.height },
        canvas: { w: c.clientWidth, h: c.clientHeight },
        sz: target._contentSize ? { w: target._contentSize.width, h: target._contentSize.height } : null,
        active: target.activeInHierarchy !== false,
      };
    })()`);
    if (!raw || !raw.canvas || !raw.design) return null;
    // Cocos 世界坐标原点在左下，画布原点在左上
    const x = raw.ws.x * raw.canvas.w / raw.design.w;
    const y = (raw.design.h - raw.ws.y) * raw.canvas.h / raw.design.h;
    return { x: Math.round(x), y: Math.round(y), raw };
  }

  // 多镜头：返回点击坐标，由调用方执行 click
  async clickNode(name) {
    const r = await this.resolve(name);
    if (!r) return { ok: false, msg: '未找到节点: ' + name };
    return { ok: true, x: r.x, y: r.y };
  }

  // 按文字点击：先试 clickEvents，失败自动降级为坐标点击
  // clickFn: async (x, y) => void，由调用方（GameHost）真正下发鼠标事件
  async tapText(text, clickFn, exact = false) {
    const r = await this.clickText(text, exact);
    if (r.ok) return r;

    await this.ensure();
    const cand = await this.wc.executeJavaScript(`(() => {
      const hits = window.__GS.find(${JSON.stringify(String(text))}, ${exact ? 'true' : 'false'});
      if (!hits.length) return null;
      for (const h of hits) {
        let n = h.node;
        for (let up = 0; up < 5 && n; up++) {
          let isBtn = false;
          try { isBtn = !!(n.getComponent && n.getComponent(cc.Button)); } catch (e) {}
          if (isBtn) break;
          n = n.parent;
        }
        if (!n) n = h.node;
        let p = null;
        try { p = n.convertToWorldSpaceAR(cc.v2(0, 0)); } catch (e) { continue; }
        const dr = cc.view.getDesignResolutionSize();
        const c = document.querySelector('canvas');
        return { name: n.name, label: h.label, ws: { x: p.x, y: p.y },
                 design: { w: dr.width, h: dr.height }, canvas: { w: c.clientWidth, h: c.clientHeight } };
      }
      return null;
    })()`);
    if (!cand) return r;

    const x = Math.round(cand.ws.x * cand.canvas.w / cand.design.w);
    const y = Math.round((cand.design.h - cand.ws.y) * cand.canvas.h / cand.design.h);
    if (typeof clickFn === 'function') await clickFn(x, y);
    return { ok: true, via: 'coords', x, y, node: cand.name, label: cand.label,
             note: '按钮未注册 clickEvents，改用坐标点击' };
  }

  // 多个候选依次尝试，返回第一个成功的
  async tapAny(list, clickFn, exact = false) {
    const tried = [];
    for (const t of list) {
      const r = await this.tapText(t, clickFn, exact);
      tried.push({ text: t, ok: r.ok, via: r.via || '-', msg: r.msg || '' });
      if (r.ok) return { ...r, text: t, tried };
    }
    return { ok: false, tried, visible: await this.texts() };
  }

  // 多个候选依次尝试，返回第一个成功的
  async clickAny(list, exact = false) {
    const tried = [];
    for (const t of list) {
      const r = await this.clickText(t, exact);
      tried.push({ text: t, ok: r.ok, via: r.via, msg: r.msg });
      if (r.ok) return { ...r, text: t, tried };
    }
    return { ok: false, tried, visible: await this.texts() };
  }

  // 读取房间人数等状态（匹配「已报名 X/Y」这类文本）
  async state() {
    const texts = await this.texts();
    const joined = texts.join(' | ');
    let registered = null, total = null;
    const m = joined.match(/已?报名[^0-9]{0,6}(\d{1,3})\s*[\/／]\s*(\d{1,3})/);
    if (m) { registered = +m[1]; total = +m[2]; }
    return { registered, total, texts };
  }
}

module.exports = { GameScene, PAGE_HELPERS };
