'use strict';
// src/director-worker.js — 在 Worker 线程内运行 _director2.js（狼人杀导演 AI）
//
// 为什么用 Worker：打包后的 EXE 内没有独立 node 可执行文件，而 Electron 主进程本身
// 就是 Node 运行时。把导演跑在 Worker 里，既能复用 Electron 自带的 ws/fs/crypto，
// 又能与主进程/界面进程完全隔离，一键 terminate() 即可干净停止，不会拖垮助手。
//
// 主进程 (main.js) 以 workerData 传入：
//   configPath  —— 导演配置路径（userData/director.config.json，用户可改）
//   logPath     —— 导演日志文件路径
//   room / streamerUid —— 可选覆盖

const { parentPort, workerData } = require('worker_threads');

if (workerData) {
  if (workerData.configPath) process.env.WOLF_CONFIG = workerData.configPath;
  if (workerData.logPath) process.env.WOLF_LOG = workerData.logPath;
  if (workerData.room) process.env.ROOM = String(workerData.room);
  if (workerData.streamerUid) process.env.STREAMER_UID = String(workerData.streamerUid);
  // 知识库等持久化文件的默认落点（userData/dungeon-knowledge.json）
  if (workerData.userDataDir) process.env.USER_DATA_DIR = String(workerData.userDataDir);
  // epoch 令牌：导演启动后每 2s 校验该文件内容；若主进程写入了更新的 epoch（新一轮启动），旧实例主动退出让位
  if (workerData.epoch) process.env.DIRECTOR_EPOCH = String(workerData.epoch);
  if (workerData.epochFile) process.env.DIRECTOR_EPOCH_FILE = String(workerData.epochFile);
}

function post(ch, data) {
  if (!parentPort) return;
  try { parentPort.postMessage({ ch, data }); } catch (e) { /* 已断开 */ }
}

// 捕获导演的所有 console 输出，回传给主进程（再转发到界面日志框）
['log', 'error', 'warn', 'info', 'debug'].forEach((k) => {
  const orig = console[k] ? console[k].bind(console) : (...a) => {};
  console[k] = (...args) => {
    try {
      post('log', args.map((x) => (x && x.stack) ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
    } catch (e) { /* ignore */ }
    orig(...args);
  };
});

if (parentPort) {
  parentPort.on('message', (m) => {
    // 预留：主进程可发送控制消息（如 'stop'）。导演自身有心跳过期 process.exit，
    // 这里主要接收转发需求。
    if (m && m.cmd === 'stop') { try { process.exit(0); } catch (e) {} }
  });
}

// 运行导演本体（相对于本文件 ../_director2.js）
try {
  post('log', '[director-worker] 正在加载导演 _director2.js …');
  require('../_director2.js');
  post('log', '[director-worker] 导演已启动，开始接管游戏');
} catch (e) {
  post('log', '[director-worker] 启动失败: ' + (e && e.stack ? e.stack : e));
  post('exit', 1);
}
