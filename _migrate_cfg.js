'use strict';
// 一次性迁移：把 userData/director.config.json 升级为「生效配置」（内置默认 ⊕ 原文件）。
// 合并结果与导演启动时的 deepMerge(DEFAULTS, 原文件) 完全一致 → 导演行为零变化，
// 但 UI 表单/JSON 框从此能看到全部真实参数（老文件没有 gacha 段，表单会全是 0）。
const fs = require('fs');
const path = require('path');
const { DEFAULTS, deepMerge } = require('./src/config');
const CFG = path.join(process.env.APPDATA, 'danmu-ai-copilot', 'director.config.json');
const raw = fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, '');
const user = JSON.parse(raw);
const merged = deepMerge(DEFAULTS, user);
const bak = CFG + '.bak-' + new Date().toISOString().slice(0, 10);
fs.writeFileSync(bak, raw, 'utf8');
fs.writeFileSync(CFG, JSON.stringify(merged, null, 2), 'utf8');
console.log('migrated -> ' + CFG);
console.log('backup  -> ' + bak);
console.log('gacha.startLv=' + merged.gacha.startLv + ' endLv=' + merged.gacha.endLv + ' mult=' + merged.gacha.buffMultiplier + ' strat=' + merged.gacha.buffStrategy.mode + ' healPct=' + merged.gacha.healPct);
