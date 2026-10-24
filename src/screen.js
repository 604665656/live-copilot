'use strict';
// 屏幕读取：采集 → 区域裁剪 → OCR/模板匹配 → 阶段状态机
// 设计：无AI也能跑（OCR+模板），AI/VLM 仅作为兜底与解说层（可插拔）
const fs = require('fs');
const path = require('path');

// 游戏阶段定义（可按实际 UI 扩展）
const PHASES = {
  UNKNOWN: 'unknown',
  LOBBY: 'lobby',       // 准备/等待
  NIGHT: 'night',       // 天黑
  DAY: 'day',           // 白天讨论
  VOTE: 'vote',         // 投票
  RESULT: 'result',     // 结算
};

// 阶段识别关键词（OCR 文本命中即判定）
const PHASE_KEYWORDS = [
  { phase: PHASES.NIGHT, words: ['天黑请闭眼', '天黑', '狼人请', '请闭眼', '夜晚'] },
  { phase: PHASES.VOTE, words: ['投票', '请投票', '投出', '放逐'] },
  { phase: PHASES.RESULT, words: ['胜利', '失败', '游戏结束', '结算', '获胜'] },
  { phase: PHASES.DAY, words: ['白天', '讨论', '发言', '天亮了'] },
  { phase: PHASES.LOBBY, words: ['准备', '开始游戏', '等待', '房间'] },
];

class ScreenReader {
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      enabled: false,
      sourceName: '',      // 窗口标题关键字，空=全屏
      intervalMs: 1500,
      regions: {},         // { phase: {x,y,w,h}, votes: {...} }
      templateDir: '',
      ocrLang: 'zh-Hans',
      useVisionFallback: true,
    }, cfg);
    this.timer = null;
    this.lastPhase = PHASES.UNKNOWN;
    this.phaseSince = Date.now();
    this.history = [];
    this.onEvent = cfg.onEvent || (() => {});
  }

  // 用 Electron desktopCapturer 抓窗口
  static async listSources(desktopCapturer) {
    const srcs = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1, height: 1 } });
    return srcs.map(s => ({ id: s.id, name: s.name }));
  }

  // 从 nativeImage 裁剪区域并做简单灰度/二值化，提升 OCR 命中率
  static prepare(nativeImage, rect) {
    if (!rect) return nativeImage;
    const img = nativeImage.crop({
      x: Math.max(0, rect.x | 0), y: Math.max(0, rect.y | 0),
      width: Math.max(1, rect.w | 0), height: Math.max(1, rect.h | 0),
    });
    // 放大 2 倍有利于小字识别
    return img.resize({ width: img.getSize().width * 2, quality: 'good' });
  }

  // 纯文本判定阶段（无AI主路径）
  classify(ocrText) {
    const t = String(ocrText || '').replace(/\s/g, '');
    for (const rule of PHASE_KEYWORDS) {
      for (const w of rule.words) {
        if (t.includes(w)) return { phase: rule.phase, hit: w, confidence: 0.8 };
      }
    }
    return { phase: PHASES.UNKNOWN, hit: '', confidence: 0 };
  }

  // 加载模板（文件名 = 阶段名，如 night.png）
  loadTemplates() {
    this.templates = [];
    const dir = this.cfg.templateDir;
    if (!dir || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(png|jpg|jpeg)$/i.test(f)) continue;
      const name = path.parse(f).name.toLowerCase();
      if (PHASES[name.toUpperCase()] || Object.values(PHASES).includes(name)) {
        this.templates.push({ phase: name, file: path.join(dir, f) });
      }
    }
    this.onEvent('log', `已加载 ${this.templates.length} 个画面模板`);
  }

  // 阶段跃迁检测 → 触发事件（这是"自动播报"的钩子）
  updatePhase(phase, evidence) {
    if (phase === this.lastPhase) return;
    const prev = this.lastPhase;
    this.lastPhase = phase;
    this.phaseSince = Date.now();
    this.history.push({ from: prev, to: phase, at: Date.now(), evidence });
    if (this.history.length > 100) this.history.shift();
    this.onEvent('phase', { from: prev, to: phase, evidence, at: Date.now() });
  }

  start(desktopCapturer, nativeImage) {
    this.desktopCapturer = desktopCapturer;
    this.nativeImage = nativeImage;
    this.loadTemplates();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick().catch(e => this.onEvent('log', '抓屏失败: ' + e.message)), this.cfg.intervalMs);
    this.onEvent('log', `屏幕识别已启动，间隔 ${this.cfg.intervalMs}ms`);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async grab() {
    const srcs = await this.desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 1280, height: 720 },
    });
    let src = null;
    if (this.cfg.sourceName) {
      src = srcs.find(s => s.name.includes(this.cfg.sourceName));
    }
    if (!src) src = srcs.find(s => /screen/i.test(s.id)) || srcs[0];
    return src ? src.thumbnail : null;
  }

  async tick() {
    if (!this.cfg.enabled) return;
    const img = await this.grab();
    if (!img || img.isEmpty()) { this.onEvent('log', '未获取到画面'); return; }
    // 主路径：OCR 判定。具体 OCR 引擎在 platform 层注入（Windows 用 WinRT OCR）
    if (typeof this.ocrFn === 'function') {
      const region = this.cfg.regions.phase;
      const cropped = ScreenReader.prepare(img, region);
      const text = await this.ocrFn(cropped);
      const r = this.classify(text);
      this.onEvent('ocr', { text: text.slice(0, 200), phase: r.phase, confidence: r.confidence });
      if (r.confidence > 0) this.updatePhase(r.phase, { via: 'ocr', hit: r.hit });
    }
  }

  // VLM 兜底：仅在 OCR 判不出时调用
  async visionFallback(imgDataUrl, brain) {
    if (!this.cfg.useVisionFallback || !brain || !brain.enabled) return null;
    const prompt = `这是B站弹幕狼人杀的游戏画面。只回答当前处于哪个阶段，从这些里选一个词：准备、天黑、白天、投票、结算。不要解释。`;
    const out = await brain.chat(prompt, { maxTokens: 20, images: [imgDataUrl] });
    return out;
  }
}

module.exports = { ScreenReader, PHASES, PHASE_KEYWORDS };
