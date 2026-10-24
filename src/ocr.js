'use strict';
// Windows 内置 OCR 封装（无需安装任何依赖，中文可用）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OCR_PS = path.join(__dirname, '..', 'tools', 'ocr.ps1');

// 返回 { img:{w,h}, lang, lines:[{text,x,y,w,h,cx,cy}] }
function ocrImage(pngPath, lang = 'zh-Hans-CN', timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const outFile = path.join(os.tmpdir(), `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    // -Sta：WinRT 异步必须在单线程公寓里跑，否则 Task.Wait 会抛 AggregateException
    const p = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', OCR_PS,
      '-Path', pngPath, '-Lang', lang, '-OutFile', outFile,
    ], { windowsHide: true });

    let err = '';
    const finish = (payload) => {
      if (done) return;
      done = true;
      try { fs.unlinkSync(outFile); } catch (e) { /* */ }
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { p.kill(); } catch (e) { /* */ }
      finish({ error: 'ocr timeout', lines: [] });
    }, timeoutMs);

    p.stdout.on('data', () => { /* 结果走文件 */ });
    p.stderr.on('data', d => { err += d; });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const txt = fs.readFileSync(outFile, 'utf8');
        finish(JSON.parse(txt));
      } catch (e) {
        finish({ error: (err || e.message || 'ocr fail').slice(0, 300), lines: [] });
      }
    });
  });
}

const norm = (s) => String(s || '').replace(/\s/g, '');
// 在 OCR 行里按关键字找（忽略空格），返回整行（含 cx,cy）
function findLine(lines, kw) {
  if (!Array.isArray(lines)) return null;
  const k = norm(kw);
  return lines.find(l => norm(l.text).includes(k)) || null;
}
// 找所有匹配
function findLines(lines, kw) {
  if (!Array.isArray(lines)) return [];
  const k = norm(kw);
  return lines.filter(l => norm(l.text).includes(k));
}

module.exports = { ocrImage, findLine, findLines, norm };
