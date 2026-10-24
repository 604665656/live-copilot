'use strict';
// 定位游戏 start.exe：配置路径失效时在常见目录自动搜索
// （游戏更新后目录名会变，如 _0.0.7 (1) → _0.0.8，硬编码路径就会失效）
const fs = require('fs');
const path = require('path');

function findGameExe(configured, desktopDir) {
  if (configured && fs.existsSync(configured)) return configured;

  const roots = [];
  // 1) 配置路径的上级目录（最多上溯 3 层，覆盖 "多一层 start-win32-x64" 这类情况）
  if (configured) {
    let d = path.dirname(configured);
    for (let i = 0; i < 3 && d && d.length > 3; i++) { roots.push(d); d = path.dirname(d); }
  }
  // 2) 常见游戏目录
  const desk = desktopDir || '';
  if (desk) {
    roots.push(path.join(desk, '桌面', '弹狼直播'));
    roots.push(path.join(desk, '弹狼直播'));
  }
  if (process.env.USERNAME) {
    roots.push(path.join('C:\\Users', process.env.USERNAME, 'Desktop', '桌面', '弹狼直播'));
  }

  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root) || !fs.existsSync(root)) continue;
    seen.add(root);
    const hits = [];
    (function walk(dir, depth) {
      if (depth > 3) return;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        if (en.name === '__MACOSX') continue;
        const p = path.join(dir, en.name);
        if (en.isDirectory()) { walk(p, depth + 1); }
        else if (/^start\.exe$/i.test(en.name)) {
          try { hits.push({ p, m: fs.statSync(p).mtimeMs }); } catch (e) { /* */ }
        }
      }
    })(root, 0);
    if (hits.length) { hits.sort((a, b) => b.m - a.m); return hits[0].p; }
  }
  return '';
}

module.exports = { findGameExe };
