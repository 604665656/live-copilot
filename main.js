'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { Copilot } = require('./src/copilot.js');
const { searchQQ, searchNetease, resolveTrack, getLyric } = require('./src/music.js');
const { GameHost } = require('./src/gamehost.js');
const { loadAccounts } = require('./src/accounts.js');
const { sendDanmaku } = require('./src/bili.js');

const USER_DIR = app.getPath('userData');
const CFG_PATH = path.join(USER_DIR, 'config.json');
const LOG_PATH = path.join(USER_DIR, 'copilot.log');

let win = null;
let copilot = null;
let gameHost = null;
let gameAutoTimer = null;

// ---------- 内嵌游戏本体（单文件 EXE 自解压后随包解压到 DanmuAICopilot.exe 同级的 game/ 目录） ----------
function embeddedGamePath() {
  try { return path.join(path.dirname(process.execPath), 'game', 'start.exe'); }
  catch (e) { return ''; }
}
function embeddedGameExists() {
  try { const p = embeddedGamePath(); return !!p && fs.existsSync(p); } catch (e) { return false; }
}

// ---------- 狼人杀导演（Worker 线程运行 _director2.js） ----------
// 用 Set 跟踪所有导演 Worker；启动前强制终止残留实例，配合 epoch 令牌确保全局唯一，避免多 Worker 并发抢戏/重复弹幕。
const directorWorkers = new Set();
let directorRestartCount = 0;            // 心跳/卡死(退出码75)自动重启次数（上限 3，避免死循环）
const DIRECTOR_EPOCH_FILE = path.join(USER_DIR, 'director.epoch');
const DIRECTOR_CFG = path.join(USER_DIR, 'director.config.json');
const DIRECTOR_LOG = path.join(USER_DIR, 'director2.log');

// AMD 核显等环境 GPU 进程易崩，工具型界面禁用硬件加速即可
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
// 开放 CDP 调试端口，使内嵌游戏窗口可被狼人杀导演(127.0.0.1:9222) 接管
app.commandLine.appendSwitch('remote-debugging-port', '9222');

function loadCfg() {
  const def = {
    roomId: '',
    identityCode: 'BJSPTSVR93B43',
    songCmd: '点歌',
    cutCmd: '切歌',
    aiCmd: '问',
    cooldownMs: 8000,
    maxQueue: 10,
    perUser: 2,
    aiOnDanmaku: true,
    aiChance: 0.25,
    sayPrefix: '【AI】',
    musicProvider: 'qq',
    volume: 70,
    gameExe: 'C:\\Users\\60466\\Desktop\\桌面\\弹狼直播\\我的粉丝里有鬼_0.0.7 (1)\\start.exe',
    embeddedGame: '', // 单文件 EXE 内嵌的游戏本体路径（运行时若存在则优先）
    ai: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: 'qwen2.5:7b',
      mpvPath: '',
      enabled: true,
    },
  };
  try {
    if (fs.existsSync(CFG_PATH)) {
      const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      const merged = { ...def, ...j, ai: { ...def.ai, ...(j.ai || {}) } };
      if (embeddedGameExists()) merged.embeddedGame = embeddedGamePath();
      return merged;
    }
  } catch (e) { /* 用默认 */ }
  const d = { ...def };
  if (embeddedGameExists()) d.embeddedGame = embeddedGamePath();
  return d;
}

function saveCfg(cfg) {
  try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { /* */ }
}

function log(line) {
  const s = `[${new Date().toLocaleTimeString('zh-CN')}] ${line}\n`;
  try { fs.appendFileSync(LOG_PATH, s, 'utf8'); } catch (e) { /* */ }
  if (win && !win.isDestroyed()) win.webContents.send('log', line);
}

function broadcast(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

// ---------- 狼人杀导演（在 Worker 线程内运行 _director2.js） ----------
// 首次运行把内置默认 config.json 拷到 userData/director.config.json，供用户随时修改
function ensureDirectorConfig() {
  if (!fs.existsSync(DIRECTOR_CFG)) {
    try {
      const def = path.join(__dirname, 'config.json');
      if (fs.existsSync(def)) {
        fs.copyFileSync(def, DIRECTOR_CFG);
        log('已生成导演配置文件: ' + DIRECTOR_CFG);
      } else {
        fs.writeFileSync(DIRECTOR_CFG, JSON.stringify(require('./src/config').DEFAULTS, null, 2), 'utf8');
      }
    } catch (e) { log('导演配置初始化失败: ' + e.message); }
  }
}

function startDirector() {
  // 启动前强制终止所有残留 Worker（旧实例可能在 75 自退前的窗口期残留），保证全局唯一
  for (const w of directorWorkers) { try { w.terminate(); } catch (e) {} }
  directorWorkers.clear();
  ensureDirectorConfig();
  ensureGameWindow();
  // 生成新 epoch 令牌并落盘；Worker 启动后每 2s 校验，若文件被更新（新一轮启动）则主动退出让位
  const epoch = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try { fs.writeFileSync(DIRECTOR_EPOCH_FILE, epoch, 'utf8'); } catch (e) {}
  try {
    const w = new Worker(path.join(__dirname, 'src', 'director-worker.js'), {
      workerData: { configPath: DIRECTOR_CFG, logPath: DIRECTOR_LOG, epoch, epochFile: DIRECTOR_EPOCH_FILE, userDataDir: USER_DIR },
    });
    directorWorkers.add(w);
    w.on('message', (m) => {
      if (!m) return;
      if (m.ch === 'log') { log('[导演] ' + m.data); broadcast('director:log', m.data); }
      if (m.ch === 'exit') { directorWorkers.delete(w); broadcast('director:status', { running: false }); }
      if (m.ch === 'dungeon') { broadcast('director:dungeon', m.data); }   // 地下城实时状态（关卡/阶段/策略/倍率/循环/战绩）→ 助手界面
    });
    w.on('exit', (code) => {
      directorWorkers.delete(w);
      broadcast('director:status', { running: false, code });
      // 心跳过期 / 剧本卡死 → 导演自退(75)，自动拉起一次（限 3 次，避免死循环）
      if (code === 75 && directorRestartCount < 3) {
        directorRestartCount++;
        log('导演以 75 退出（心跳/卡死），第 ' + directorRestartCount + ' 次自动重启');
        setTimeout(() => startDirector(), 1500);
      }
    });
    broadcast('director:status', { running: true });
    return { ok: true, running: true };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

function stopDirector() {
  for (const w of directorWorkers) {
    try { w.postMessage({ cmd: 'stop' }); } catch (e) {}
    try { w.terminate(); } catch (e) {}
  }
  directorWorkers.clear();
  directorRestartCount = 0; // 手动停止不触发自动重启
  broadcast('director:status', { running: false });
  return { ok: true };
}

function restartDirector() {
  stopDirector();
  return startDirector();
}

// 导演启动前确保游戏窗口已打开（可见），否则导演会attach到一个看不见的后台target
function ensureGameWindow() {
  try {
    if (!gameHost) gameHost = new GameHost({ onEvent: (t, d) => { if (t === 'log') log('[game] ' + d); } });
    if (!gameHost.win || gameHost.win.isDestroyed()) {
      gameHost.open().catch(e => log('自动打开游戏窗口失败: ' + e.message));
    }
  } catch (e) { log('自动打开游戏窗口失败: ' + e.message); }
}

// 定位游戏 start.exe（自动搜索逻辑独立在 src/gamepath.js，便于单测）
const { findGameExe } = require('./src/gamepath.js');
const detectGameExe = (configured) => findGameExe(configured, app.getPath('desktop'));

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0f1115',
    title: '弹幕狼人杀 · AI 主播助手',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // 自检模式：node main.js --selftest 时截图并退出，用于自动化验证
  if (process.argv.includes('--selftest')) {
    win.webContents.on('console-message', (e, lvl, msg) => {
      if (lvl >= 2) console.log('[CONSOLE-ERR]', msg);
    });
    win.webContents.on('did-fail-load', (e, code, desc) => console.log('[LOAD-FAIL]', code, desc));
    win.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 1800));
      try {
        const info = await win.webContents.executeJavaScript(`({
          title: document.title,
          hasApi: typeof window.api === 'object',
          aiBaseVal: document.getElementById('aiBase').value,
          logCount: document.getElementById('logBox').childElementCount,
          btnStart: !!document.getElementById('btnStart'),
          statsRendered: document.getElementById('sDm').textContent,
          npName: document.getElementById('npName') ? document.getElementById('npName').textContent : null,
          lyricBox: !!document.getElementById('lyricBox'),
          nextUp: document.getElementById('nextUp') ? document.getElementById('nextUp').textContent : null,
          aiEnabledSw: !!document.getElementById('aiEnabled'),
          provider: document.getElementById('provider').value
        })`);
        console.log('[UI-CHECK]', JSON.stringify(info));
      } catch (err) { console.log('[SELFTEST-ERR]', err.message); }

      // 模拟一首歌正在播放，验证正在播放/歌词/下一首/队列渲染
      try {
        win.webContents.send('playing', {
          name: '晴天', artist: '周杰伦', source: 'netease',
          lyric: '[00:00.00]故事的小黄花\n[00:04.20]从出生那年就飘着\n[00:08.60]童年的荡秋千\n[00:12.80]随记忆一直晃到现在',
        });
        win.webContents.send('next', { name: '稻香', artist: '周杰伦' });
        win.webContents.send('queue', [{ name: '孤勇者', artist: '陈奕迅' }, { name: '起风了', artist: '买辣椒也用券' }]);
        await new Promise(r => setTimeout(r, 700));
        const p = await win.webContents.executeJavaScript(`({
          nowPlaying: document.getElementById('nowPlaying').textContent,
          npName: document.getElementById('npName').textContent,
          npArtist: document.getElementById('npArtist').textContent,
          npSrc: document.getElementById('npSrc').textContent,
          nextUp: document.getElementById('nextUp').textContent,
          lyricChars: document.getElementById('lyricBox').textContent.length,
          queue: document.getElementById('queueList').textContent.replace(/\\s+/g,' ').trim()
        })`);
        console.log('[UI-PLAYING]', JSON.stringify(p));

        const wrongGame = 'C:\\Users\\60466\\Desktop\\桌面\\弹狼直播\\我的粉丝里有鬼_0.0.7 (1)\\start-win32-x64\\start.exe';
        const det = await win.webContents.executeJavaScript(`window.api.gameDetect(${JSON.stringify(wrongGame)})`);
        console.log('[GAME-DETECT]', JSON.stringify(det));
        const hasBtn = await win.webContents.executeJavaScript(`!!document.getElementById('btnGameDetect')`);
        console.log('[GAME-BTN]', hasBtn);

        // ---------- 手动指令台闭环验证 ----------
        try {
          const cmdAcc = await win.webContents.executeJavaScript(`window.api.manualAccounts()`);
          console.log('[MANUAL-ACC]', JSON.stringify(cmdAcc));
        } catch (e) { console.log('[MANUAL-ACC-ERR]', e.message); }
        try {
          const cmdUi = await win.webContents.executeJavaScript(`({
            accCount: document.querySelectorAll('#cmdAccList input[type=checkbox]').length,
            accStatus: (document.getElementById('cmdAccStatus')||{}).textContent,
            hasRoom: !!document.getElementById('cmdRoom'),
            hasStart: !!document.getElementById('btnCmdStart'),
            hasSend: !!document.getElementById('btnCmdSend'),
            hasAll: !!document.getElementById('btnCmdAll')
          })`);
          console.log('[MANUAL-UI]', JSON.stringify(cmdUi));
        } catch (e) { console.log('[MANUAL-UI-ERR]', e.message); }
        try {
          const cmdEmpty = await win.webContents.executeJavaScript(`(async()=>{ try { return await window.api.manualSend({text:'',accountIds:[]}); } catch(e){ return {err:e.message}; } })()`);
          console.log('[MANUAL-SEND-EMPTY]', JSON.stringify(cmdEmpty));
        } catch (e) { console.log('[MANUAL-SEND-EMPTY-ERR]', e.message); }
        try {
          // 真实发弹幕会命中直播间，仅在 SELFTEST_REAL_SEND=1 时执行，避免重复自测刷屏
          if (process.env.SELFTEST_REAL_SEND === '1') {
            const cmdNoRoom = await win.webContents.executeJavaScript(`(async()=>{ try { return await window.api.manualSend({text:'报名',accountIds:[]}); } catch(e){ return {err:e.message}; } })()`);
            console.log('[MANUAL-SEND-OK]', JSON.stringify(cmdNoRoom));
          } else {
            console.log('[MANUAL-SEND-SKIP] 未设 SELFTEST_REAL_SEND=1，跳过真实发弹幕（仅验证入参校验分支）');
          }
        } catch (e) { console.log('[MANUAL-SEND-OK-ERR]', e.message); }

        // ---------- 导演配置 / 配置存取 闭环验证 ----------
        try {
          const dcfg = await win.webContents.executeJavaScript(`window.api.directorCfgLoad()`);
          console.log('[DIRECTOR-CFG]', JSON.stringify(dcfg && dcfg.ok));
        } catch (e) { console.log('[DIRECTOR-CFG-ERR]', e.message); }
        try {
          const before = await win.webContents.executeJavaScript(`window.api.loadCfg()`);
          const probe = '___selftest_probe_' + Date.now();
          const saved = await win.webContents.executeJavaScript(`window.api.saveCfg(Object.assign({}, ${JSON.stringify(before)}, { identityCode: ${JSON.stringify('PROBE')} }))`);
          const after = await win.webContents.executeJavaScript(`window.api.loadCfg()`);
          await win.webContents.executeJavaScript(`window.api.saveCfg(${JSON.stringify(before)})`);
          console.log('[CFG-ROUNDTRIP]', JSON.stringify({ saved, afterId: after.identityCode, restored: (await win.webContents.executeJavaScript(`window.api.loadCfg()`)).identityCode }));
        } catch (e) { console.log('[CFG-ROUNDTRIP-ERR]', e.message); }

        const img = await win.capturePage();
        fs.writeFileSync(path.join(__dirname, 'ui-preview.png'), img.toPNG());
        console.log('[SHOT] ui-preview.png');
      } catch (err) { console.log('[SELFTEST-ERR]', err.message); }
      app.quit();
    });
  }
}

function startCopilot(cfg) {
  if (copilot) { copilot.stop(); copilot = null; }
  copilot = new Copilot(cfg);
  copilot.on('log', (t) => log(t));
  copilot.on('danmaku', (d) => broadcast('danmaku', d));
  copilot.on('say', (d) => { log('发言: ' + d.text); broadcast('say', d); });
  copilot.on('player', (d) => {
    broadcast('player', d);
    // play-audio 统一由 useRendererPlayer 发出，这里不再重复广播，避免双次触发播放
    if (d.state === 'idle' || d.state === 'ended') broadcast('stop-audio', null);
  });
  copilot.player.useRendererPlayer((t) => broadcast('play-audio', t));
  copilot.on('playing', (d) => broadcast('playing', d));   // 正在播放（含歌词）
  copilot.on('next', (d) => broadcast('next', d));         // 下一首预告
  copilot.on('queue', (q) => broadcast('queue', q));
  copilot.on('ai', (d) => broadcast('ai', d));
  copilot.on('songmiss', (d) => broadcast('songmiss', d));
  copilot.on('status', (d) => broadcast('status', d));
  copilot.on('roominfo', (d) => broadcast('roominfo', d));
  copilot.on('popularity', (d) => broadcast('popularity', d));
  copilot.start();
}

// 点击「自由模式」接入直播间玩法。
// 实测：游戏按钮节点不带 cc.Label 子节点，按标签扫描必然失败；节点名才是可靠依据。
// 自由模式节点名 = btn_auto（名字有误导性）。优先用实时场景树解析真实坐标（与登录 btn_login 同源），
// 解析不到再退回标定锚点 freeMode(1198,711)——两者都是已验证可用的坐标点击。
async function clickFreeModeBtn() {
  try {
    const wc = gameHost && gameHost.contents;
    if (wc) {
      const { GameScene } = require('./src/gamescene.js');
      gameHost.scene = gameHost.scene || new GameScene(wc);
      await gameHost.scene.install();
      const p = await gameHost.scene.clickNode('btn_auto');
      if (p && p.ok) {
        await gameHost.click(p.x, p.y);
        return { ok: true, x: p.x, y: p.y, via: 'clickNode(btn_auto)' };
      }
      log('场景里未解析到 btn_auto，改用锚点坐标');
    }
  } catch (e) { log('解析 btn_auto 失败: ' + (e && e.message)); }
  try {
    const p = await gameHost.scaled('freeMode');
    if (p) { await gameHost.click(p.x, p.y); return { ok: true, x: p.x, y: p.y, via: 'anchor(freeMode)' }; }
  } catch (e) { log('锚点点击 freeMode 失败: ' + (e && e.message)); }
  return { ok: false };
}

// ---------- 自动运行模式（--autorun）：等同依次点击「启动游戏 → 填码进入 → 进入模式 → 启动导演」----------
// 仅当命令行带 --autorun 时生效，正常启动不受影响（演示/手动模式完全不变）。
async function autoRun() {
  const cfg = loadCfg();
  log('=== 自动运行模式 (--autorun) ===');
  ensureGameWindow();                                  // 打开助手游戏窗口（等价「启动游戏」）
  await new Promise(r => setTimeout(r, 12000));        // 等游戏窗口 + Cocos 初始化
  const code = cfg.identityCode || 'BJSPTSVR93B43';
  let entered = false;
  if (gameHost && gameHost.win && !gameHost.win.isDestroyed()) {
    // 登录偶发失败（坐标/弹窗态），最多重试 3 次再放弃，避免向直播间空发弹幕
    for (let attempt = 1; attempt <= 3 && !entered; attempt++) {
      const r = await gameHost.enterGame(code);        // 等价「填码进入」
      log(`自动填码进入(第${attempt}次): ` + JSON.stringify(r));
      if (r && r.ok) { entered = true; break; }
      log('登录未成功，2 秒后重试');
      await new Promise(r => setTimeout(r, 2000));
    }
  } else {
    log('游戏窗口未就绪，跳过填码');
  }
  if (!entered) {
    log('⚠️ 多次尝试仍未能进入游戏大厅：为避免向直播间空发弹幕，已停止启动导演。请检查身份码/网络后重试。');
    return;                                            // 不启动导演 → 不会空刷弹幕
  }
  // 登录成功后必须点「自由模式」(btn_auto) 接入直播间玩法，否则游戏实例停在空 lobby（房间 0/36），读不到玩家
  await new Promise(r => setTimeout(r, 2000));
  const mode = await clickFreeModeBtn();
  log('点击「自由模式」接入直播间: ' + (mode.ok ? `已点击 ${mode.via} (${mode.x},${mode.y})` : '失败：场景里未找到 btn_auto'));
  await new Promise(r => setTimeout(r, 12000));        // 等狼人杀加载并连上直播间弹幕流
  const dr = startDirector();                           // 等价「启动导演」
  log('启动导演: ' + JSON.stringify(dr));
}

app.whenReady().then(() => {
  createWindow();

  if (process.argv.includes('--autorun')) {
    setTimeout(() => autoRun().catch(e => log('autorun 失败: ' + e.message)), 1500);
  }

  ipcMain.handle('cfg:load', () => loadCfg());
  ipcMain.handle('cfg:save', (e, cfg) => { saveCfg(cfg); return true; });

  ipcMain.handle('copilot:start', (e, cfg) => {
    saveCfg(cfg);
    try { startCopilot(cfg); return { ok: true }; }
    catch (err) { return { ok: false, msg: err.message }; }
  });

  ipcMain.handle('copilot:stop', () => { if (copilot) { copilot.stop(); copilot = null; } return true; });

  ipcMain.handle('copilot:say', (e, text) => {
    if (copilot) copilot.say(text);
    return true;
  });

  ipcMain.handle('song:search', async (e, { keyword, provider }) => {
    try {
      const r = provider === 'netease' ? await searchNetease(keyword, 8) : await searchQQ(keyword, 8);
      return { ok: true, list: r };
    } catch (err) { return { ok: false, msg: err.message }; }
  });

  ipcMain.handle('song:play', async (e, track) => {
    if (!copilot) return { ok: false, msg: '请先点击「启动」' };
    const resolved = await resolveTrack(track);
    if (!resolved || !resolved.url) return { ok: false, msg: '这首歌没有可用音源（QQ 付费曲已尝试回退网易云）' };
    resolved.lyric = (await getLyric(resolved)) || '';
    copilot._playing = true;
    copilot.emit('playing', resolved);
    copilot.emit('next', copilot.queue[0] || null);
    await copilot.player.play(resolved);
    return { ok: true };
  });

  ipcMain.handle('song:next', async () => {
    if (copilot) { await copilot.player.stop(); await copilot.playNext(); }
    return true;
  });

  ipcMain.handle('song:stop', async () => {
    if (copilot) await copilot.player.stop();
    return true;
  });

  ipcMain.handle('game:launch', (e, exeFromUI) => {
    const cfg = loadCfg();
    // 内嵌游戏本体优先（单文件 EXE 自解压后随包存在）
    const emb = embeddedGameExists() ? embeddedGamePath() : '';
    const exe = (exeFromUI || '').trim() || emb || cfg.gameExe;
    if (exe && fs.existsSync(exe)) {
      shell.openPath(exe);
      log('启动游戏: ' + exe);
      return { ok: true, exe, embedded: !!emb && exe === emb };
    }
    // 路径失效：自动搜索
    const found = detectGameExe(exe);
    if (found) {
      saveCfg({ ...cfg, gameExe: found });
      shell.openPath(found);
      log('已自动定位并启动游戏: ' + found);
      return { ok: true, exe: found, auto: true };
    }
    return { ok: false, msg: '找不到游戏 exe，请点「自动检测」或手动填写 start.exe 路径。\n当前: ' + (exe || '(空)') };
  });

  ipcMain.handle('game:detect', (e, exeFromUI) => {
    const cfg = loadCfg();
    const emb = embeddedGameExists() ? embeddedGamePath() : '';
    const base = (exeFromUI || '').trim() || emb || cfg.gameExe;
    if (base && fs.existsSync(base)) return { ok: true, exe: base, embedded: !!emb && base === emb };
    const found = detectGameExe(base);
    if (found) { saveCfg({ ...cfg, gameExe: found }); return { ok: true, exe: found }; }
    return { ok: false, msg: '未找到 start.exe，请确认游戏已解压到 桌面\\桌面\\弹狼直播 下' };
  });

  // ---- 内嵌游戏 ----
  ipcMain.handle('game:open', async () => {
    if (!gameHost) {
      gameHost = new GameHost({ onEvent: (t, d) => { if (t === 'log') log('[game] ' + d); } });
    }
    try { return await gameHost.open(); }
    catch (e) { return { ok: false, msg: e.message }; }
  });

  ipcMain.handle('game:fillcode', async (e, code) => {
    if (!gameHost) return { ok: false, msg: '游戏窗口未打开' };
    return gameHost.enterGame(code);
  });

  ipcMain.handle('game:tap', async (e, name) => {
    if (!gameHost) return { ok: false, msg: '游戏窗口未打开' };
    return gameHost.tap(name);
  });

  ipcMain.handle('game:click', async (e, { x, y }) => {
    if (!gameHost) return { ok: false, msg: '游戏窗口未打开' };
    return gameHost.click(x, y);
  });

  ipcMain.handle('game:shot', async () => {
    if (!gameHost) return { ok: false, msg: '游戏窗口未打开' };
    const img = await gameHost.capture();
    if (!img) return { ok: false, msg: '截图失败' };
    return { ok: true, dataUrl: 'data:image/png;base64,' + img.toPNG().toString('base64'), size: img.getSize() };
  });

  // 自动循环：截图 -> AI 决策 -> 点击
  ipcMain.handle('game:auto', (e, { on, prompt }) => {
    if (!on) {
      clearInterval(gameAutoTimer);
      gameAutoTimer = null;
      log('游戏自动模式已关闭');
      return { ok: true };
    }
    if (!gameHost) return { ok: false, msg: '游戏窗口未打开' };
    if (gameAutoTimer) return { ok: true };
    const cfg = loadCfg();
    const { Brain } = require('./src/brain.js');
    const brain = new Brain(cfg.ai || {});
    gameAutoTimer = setInterval(async () => {
      try {
        const img = await gameHost.capture();
        if (!img) return;
        const b64 = 'data:image/png;base64,' + img.toPNG().toString('base64');
        const question = prompt || '这是弹幕狼人杀游戏画面。描述当前局面并给出下一步该点击的位置，JSON格式：{"say":"解说一句话","click":{"x":数字,"y":数字,"why":"原因"}}。坐标以画面左上角为原点、宽1344高755。只输出JSON。';
        const out = await brain.chat(question, { maxTokens: 300, image: b64 });
        // 解析 JSON
        const m = /\{[\s\S]*\}/.exec(out);
        if (m) {
          const j = JSON.parse(m[0]);
          broadcast('gameai', j);
          if (j.say) copilot ? copilot.say(String(j.say)) : log('[AI] ' + j.say);
          if (j.click && typeof j.click.x === 'number') {
            await gameHost.click(j.click.x, j.click.y);
          }
        }
      } catch (err) { log('自动循环异常: ' + err.message); }
    }, 10000);
    log('游戏自动模式已开启（每10秒一次）');
    return { ok: true };
  });

  ipcMain.handle('open:log', () => { shell.showItemInFolder(LOG_PATH); return true; });

  // ---- 狼人杀导演（_director2.js，运行于 Worker 线程） ----
  ipcMain.handle('director:start', () => startDirector());
  ipcMain.handle('director:stop', () => stopDirector());
  ipcMain.handle('director:restart', () => restartDirector());
  ipcMain.handle('director:cfg:load', () => {
    ensureDirectorConfig();
    try {
      const raw = fs.readFileSync(DIRECTOR_CFG, 'utf8');
      let user = {};
      try { user = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { /* 文件损坏时回退纯默认 */ }
      // 返回「生效配置」= 内置默认 ⊕ 用户文件：表单与 JSON 框看到的都是导演真正在用的值
      // （老用户的 director.config.json 没有 gacha 段，直接显示原文件会让地下城表单全是 0）
      const merged = require('./src/config').deepMerge(require('./src/config').DEFAULTS, user);
      return { ok: true, text: JSON.stringify(merged, null, 2) };
    }
    catch (e) { return { ok: false, msg: e.message }; }
  });
  ipcMain.handle('director:cfg:save', (e, text) => {
    try {
      JSON.parse(text); // 校验合法性
      ensureDirectorConfig();
      fs.writeFileSync(DIRECTOR_CFG, text, 'utf8');
      return { ok: true };
    } catch (err) { return { ok: false, msg: '配置不是合法 JSON: ' + err.message }; }
  });
  ipcMain.handle('director:openConfig', () => {
    ensureDirectorConfig();
    shell.showItemInFolder(DIRECTOR_CFG);
    return true;
  });

  // ---- 手动指令台：以各账号身份直接发送游戏弹幕指令 ----
  // 列表（读取自 bili-relation-manager/data.json，标注是否具备发送权限）
  ipcMain.handle('cmd:accounts', () => {
    try {
      const { all, usable } = loadAccounts();
      const roomId = loadCfg().roomId;
      const accounts = all.map((a) => ({
        id: a.id,
        uname: a.uname,
        sendable: !!(a.keys && a.keys.SESSDATA && a.keys.bili_jct),
      }));
      return { ok: true, accounts, usableCount: usable.length, roomId };
    } catch (e) { return { ok: false, msg: e.message }; }
  });

  // 发送：text=指令文本，accountIds=选中的账号 id 数组（空/未传则发给全部可用账号）
  ipcMain.handle('cmd:send', async (e, { text, accountIds }) => {
    text = (text || '').toString().trim();
    if (!text) return { ok: false, msg: '指令内容为空' };
    const cfg = loadCfg();
    const roomId = cfg.roomId;
    if (!roomId) return { ok: false, msg: '请先在「配置」填写直播间房间号' };
    let all;
    try { all = loadAccounts().all; } catch (e) { return { ok: false, msg: e.message }; }
    const sendable = all.filter((a) => a.keys && a.keys.SESSDATA && a.keys.bili_jct);
    let targets = sendable;
    if (Array.isArray(accountIds) && accountIds.length) {
      targets = sendable.filter((a) => accountIds.indexOf(a.id) >= 0);
    }
    if (!targets.length) return { ok: false, msg: '没有可选的可发送账号（需 SESSDATA + bili_jct）' };
    const results = [];
    for (const a of targets) {
      const r = await sendDanmaku({
        cookie: a.cookie,
        roomId,
        text,
        biliJct: a.keys.bili_jct,
        uid: a.uid,
      });
      results.push({ uname: a.uname, ok: r.ok, code: r.code, message: r.message });
      await new Promise((res) => setTimeout(res, 400)); // 账号间留间隔，避免触发 B 站风控
    }
    return { ok: true, results, total: targets.length };
  });

  log('程序启动，配置目录 ' + USER_DIR);
});

app.on('window-all-closed', () => {
  if (copilot) copilot.stop();
  for (const w of directorWorkers) { try { w.terminate(); } catch (e) {} }
  directorWorkers.clear();
  app.quit();
});
