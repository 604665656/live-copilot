'use strict';
// AI 连通性自检：确认本地模型服务是否真的在线、能否真的出话
// 用法: node_modules/electron/dist/electron.exe ai-selftest.js [baseUrl] [model]
const { Brain } = require('./src/brain.js');

const args = process.argv.slice(2);
const cfg = {
  baseUrl: args[0] || process.env.AI_BASE_URL || 'http://127.0.0.1:11434/v1',
  model: args[1] || process.env.AI_MODEL || 'qwen2.5:7b',
  apiKey: process.env.AI_API_KEY || 'ollama',
};

// 顺带扫一遍常见端口，看看有没有活着的 OpenAI 兼容服务
const COMMON = [
  'http://127.0.0.1:11434/v1',   // Ollama
  'http://127.0.0.1:1234/v1',    // LM Studio
  'http://127.0.0.1:8080/v1',    // llama.cpp 常见
  'http://127.0.0.1:8000/v1',    // vLLM / 自建
  'http://127.0.0.1:18789/v1',   // QClaw 网关（如暴露 OpenAI 接口）
  'http://127.0.0.1:4891/v1',    // 其他常见本地端口
];

(async () => {
  console.log('目标: ' + cfg.baseUrl + '  模型: ' + cfg.model);
  console.log('');

  const brain = new Brain(cfg);
  const h = await brain.health();
  if (!h.ok) {
    console.log('[未连通] ' + (h.error || '') + '  (' + h.ms + 'ms)');
    console.log('');
    console.log('正在扫描本地常见推理服务端口...');
    let found = null;
    for (const url of COMMON) {
      if (url === cfg.baseUrl) continue;
      const b = new Brain({ ...cfg, baseUrl: url });
      const r = await b.health(1500);
      const mark = r.ok ? '✅ 在线' : '✖';
      const extra = r.ok ? `  模型数=${r.models.length}  ${r.warn || ''}` : `  ${r.error}`;
      console.log(`  ${mark}  ${url}${extra}`);
      if (r.ok && !found) found = { url, r };
    }
    if (!found) {
      console.log('');
      console.log('结论: 本机没有任何可用的本地推理服务，因此 AI 从未被真正调用过。');
      console.log('修复办法（任选其一，然后重跑本自检）:');
      console.log('  · Ollama:      ollama serve      然后  ollama pull qwen2.5:7b');
      console.log('  · LM Studio:   开启本地服务器后，把 baseUrl 改成 http://127.0.0.1:1234/v1');
      console.log('  · llama.cpp:   llama-server -m <模型.gguf> --port 8080');
      console.log('  · QClaw:       确认其 llama-server 已在运行，并把端口填进 config');
      console.log('  · 在线中转:    把 baseUrl / model / apiKey 换成你的中转地址');
      process.exit(2);
    }
    console.log('');
    console.log('发现可用服务，建议把配置改成: baseUrl=' + found.url);
    process.exit(1);
  }

  console.log('[在线] ' + h.ms + 'ms  服务模型数=' + h.models.length);
  console.log('  可用模型: ' + h.models.join(', '));
  if (h.warn) console.log('  ⚠ ' + h.warn);

  const st = await brain.selfTest();
  console.log('');
  if (st.stage === 'chat' && st.ok) {
    console.log('[真实对话成功] ' + st.ms + 'ms');
    console.log('  模型回复: ' + st.reply);
    console.log('  统计: attempts=' + brain.stats.attempts + ' ok=' + brain.stats.ok + ' fail=' + brain.stats.fail);
    process.exit(0);
  }
  console.log('[对话失败] ' + st.stage + ': ' + (st.error || '无返回'));
  console.log('  统计: attempts=' + brain.stats.attempts + ' ok=' + brain.stats.ok + ' fail=' + brain.stats.fail);
  process.exit(3);
})();
