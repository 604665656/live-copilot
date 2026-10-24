'use strict';
// AI 解说/回复：OpenAI 兼容接口（Ollama / LM Studio / llama.cpp / DeepSeek / 任意中转）
const DEFAULT_SYSTEM = `你是B站直播间里的AI主持人，正在陪主播打"弹幕狼人杀"。
要求：
1. 用中文，1~2句，最多40字，像真人主播一样自然、有网感。
2. 只输出要说的话，不要加引号、不要解释、不要前缀。
3. 不要编造游戏结果，只基于给你的局面信息说话。
4. 语气轻松、带点毒舌和玩梗，但绝不骂人、不涉及政治与敏感话题。`;

class Brain {
  constructor(cfg = {}) {
    this.cfg = {
      baseUrl: cfg.baseUrl || 'http://127.0.0.1:11434/v1',
      apiKey: cfg.apiKey || 'ollama',
      model: cfg.model || 'qwen2.5:7b',
      system: cfg.system || DEFAULT_SYSTEM,
      maxTokens: cfg.maxTokens || 120,
      temperature: cfg.temperature ?? 0.85,
      timeoutMs: cfg.timeoutMs || 20000,
      enabled: cfg.enabled !== false,   // 可显式关闭，避免没跑本地模型时反复请求失败
    };
    this.history = [];
    // 真实调用统计：用来证明 AI 到底有没有被调用过
    this.stats = { attempts: 0, ok: 0, fail: 0, lastError: '', lastMs: 0, lastModel: '' };
  }

  get enabled() { return this.cfg.enabled !== false && !!(this.cfg.baseUrl && this.cfg.model); }

  update(cfg = {}) { Object.assign(this.cfg, cfg); }

  // 探测服务是否真的活着（GET /models），不产生 token，可安全高频调用
  async health(timeoutMs = 4000) {
    const base = String(this.cfg.baseUrl || '').replace(/\/$/, '');
    if (!this.enabled) return { ok: false, error: 'AI 未启用', baseUrl: base };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
        signal: ctrl.signal,
      });
      const ms = Date.now() - t0;
      clearTimeout(timer);
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, baseUrl: base, ms };
      const j = await r.json().catch(() => ({}));
      const models = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
      const hasModel = models.length === 0 || models.includes(this.cfg.model);
      return {
        ok: true,
        baseUrl: base,
        ms,
        models: models.slice(0, 20),
        model: this.cfg.model,
        modelFound: hasModel,
        warn: hasModel ? '' : `服务在线，但模型列表里没有 "${this.cfg.model}"，请确认模型名`,
      };
    } catch (e) {
      clearTimeout(timer);
      const msg = e && e.name === 'AbortError' ? '连接超时' : (e && e.message || String(e));
      return { ok: false, error: msg, baseUrl: base, ms: Date.now() - t0 };
    }
  }

  // 真实发一次极短请求，返回完整过程（用于自测/UI 诊断）
  async selfTest() {
    const h = await this.health();
    if (!h.ok) return { ...h, stage: 'health' };
    const t0 = Date.now();
    try {
      const text = await this.chat('只回复两个字：在线', { maxTokens: 16, temperature: 0 });
      return { ...h, stage: 'chat', ok: !!text, reply: text, ms: Date.now() - t0 };
    } catch (e) {
      return { ...h, stage: 'chat', ok: false, reply: '', error: (e && e.message || String(e)), ms: Date.now() - t0 };
    }
  }

  async chat(userText, opts = {}) {
    if (!this.enabled) return '';
    const userContent = opts.image
      ? [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: opts.image } },
        ]
      : userText;
    const messages = [
      { role: 'system', content: opts.system || this.cfg.system },
      ...this.history.slice(-6),
      { role: 'user', content: userContent },
    ];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    const t0 = Date.now();
    this.stats.attempts += 1;
    try {
      const r = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          max_tokens: opts.maxTokens || this.cfg.maxTokens,
          temperature: opts.temperature ?? this.cfg.temperature,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status} ${t.slice(0, 120)}`);
      }
      const j = await r.json();
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      const clean = text.replace(/^["'“”\s]+|["'“”\s]+$/g, '');
      this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: clean });
      if (this.history.length > 12) this.history = this.history.slice(-12);
      this.stats.ok += 1;
      this.stats.lastMs = Date.now() - t0;
      this.stats.lastModel = this.cfg.model;
      return clean;
    } catch (e) {
      clearTimeout(timer);
      this.stats.fail += 1;
      this.stats.lastError = (e && e.message || String(e)).slice(0, 200);
      this.stats.lastMs = Date.now() - t0;
      throw e;
    }
  }

  // 无 AI 时的兜底文案
  fallback(kind, data = {}) {
    const pools = {
      greet: ['欢迎新朋友进来看戏~', '来啦来啦，弹幕狼人杀继续开搞'],
      danmaku: ['这条弹幕我记下了', '你说得对，但我是AI', '主播看到了，正在思考'],
      start: ['天黑请闭眼，狼人开始行动', '准备开局，各位盯紧屏幕'],
      vote: ['投票开始，谁看着最可疑', '这一票投谁，弹幕刷起来'],
      night: ['夜里安静，狼人动手了', '天黑了，谁的呼吸声这么大'],
    };
    const arr = pools[kind] || pools.danmaku;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}

module.exports = { Brain, DEFAULT_SYSTEM };
