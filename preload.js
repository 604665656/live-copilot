'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadCfg: () => ipcRenderer.invoke('cfg:load'),
  saveCfg: (cfg) => ipcRenderer.invoke('cfg:save', cfg),
  start: (cfg) => ipcRenderer.invoke('copilot:start', cfg),
  stop: () => ipcRenderer.invoke('copilot:stop'),
  say: (t) => ipcRenderer.invoke('copilot:say', t),
  search: (keyword, provider) => ipcRenderer.invoke('song:search', { keyword, provider }),
  play: (track) => ipcRenderer.invoke('song:play', track),
  next: () => ipcRenderer.invoke('song:next'),
  stopSong: () => ipcRenderer.invoke('song:stop'),
  launchGame: (exe) => ipcRenderer.invoke('game:launch', exe),
  gameDetect: (exe) => ipcRenderer.invoke('game:detect', exe),
  gameOpen: () => ipcRenderer.invoke('game:open'),
  gameFillCode: (code) => ipcRenderer.invoke('game:fillcode', code),
  gameTap: (name) => ipcRenderer.invoke('game:tap', name),
  gameClick: (x, y) => ipcRenderer.invoke('game:click', { x, y }),
  gameShot: () => ipcRenderer.invoke('game:shot'),
  gameAuto: (on, prompt) => ipcRenderer.invoke('game:auto', { on, prompt }),
  openLog: () => ipcRenderer.invoke('open:log'),
  // 狼人杀导演
  directorStart: () => ipcRenderer.invoke('director:start'),
  directorStop: () => ipcRenderer.invoke('director:stop'),
  directorRestart: () => ipcRenderer.invoke('director:restart'),
  directorCfgLoad: () => ipcRenderer.invoke('director:cfg:load'),
  directorCfgSave: (text) => ipcRenderer.invoke('director:cfg:save', text),
  directorOpenConfig: () => ipcRenderer.invoke('director:openConfig'),
  // 手动指令台
  manualAccounts: () => ipcRenderer.invoke('cmd:accounts'),
  manualSend: (payload) => ipcRenderer.invoke('cmd:send', payload),
  on: (ch, cb) => ipcRenderer.on(ch, (e, data) => cb(data)),
});
