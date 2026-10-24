'use strict';
// _assistant_run.js — 用「助手本体」打开游戏（复用 src/gamehost.js 的 GameHost + enterGame）。
// 与直接点助手 UI 的「启动游戏 → 填码进入」完全等价，只是用脚本自动触发，便于无界面接管。
// 游戏窗口在该 Electron 进程内以 remote-debugging-port=9222 暴露，供 node _director2.js 接管。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { GameHost } = require('./src/gamehost.js');

// —— 与 main.js 完全一致的开关，确保游戏窗口挂在 9222 ——
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('remote-debugging-port', '9222');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const IDCODE = process.env.IDCODE || 'BJSPTSVR93B43';
const log = (...a) => console.log('[assistant]', ...a);

app.whenReady().then(async () => {
  log('助手进程就绪，开始打开游戏窗口…');

  // 打开游戏窗口（助手 GameHost，等价于 UI 的「启动游戏」）
  const gameHost = new GameHost({ onEvent: (t, d) => { if (t === 'log') log('[game] ' + d); } });
  const opened = await gameHost.open();
  log('游戏窗口打开: ' + JSON.stringify(opened));

  // 等 Cocos 初始化（open 内部已等 8s，这里再稳妥补等）
  await sleep(4000);

  // 填身份码进入大厅（助手 enterGame，等价于 UI 的「填码进入」）
  log('填入身份码并进入大厅: ' + IDCODE);
  const r = await gameHost.enterGame(IDCODE);
  log('enterGame 结果: ' + JSON.stringify(r));

  // 多等一会确认大厅就绪
  await sleep(3000);
  try {
    const shot = await gameHost.capture();
    if (shot) log('已截图确认游戏窗口渲染成功 (bytes=' + (shot.toPNG ? shot.toPNG().length : '?') + ')');
  } catch (e) { log('截图检查跳过: ' + e.message); }

  log('✅ 助手已打开游戏并进入大厅，保持进程存活。下一步可运行  node _director2.js  接管（真实弹幕发往直播间）。');

  // 保持进程存活
  setInterval(() => log('…游戏窗口存活中 (9222)'), 30000);
});

app.on('window-all-closed', () => { /* 不退出，保持游戏窗口 */ });
