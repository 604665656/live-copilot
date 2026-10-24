'use strict';
// supervisor.js — 弹幕狼人杀助手守护进程
//
// 职责：
//   1. 托管启动助手主进程（electron . --autorun），进程退出后自动拉起（限频 + 连重上限，避免死循环）。
//   2. 每 15s 探活 CDP 127.0.0.1:9222 的游戏页（Cocos Creator）；若丢失 > 90s，强杀助手进程树并重建。
//   3. 存在 .supervisor_stop 文件即优雅退出（删除该文件可恢复守护）。
//
// 启动方式：
//   node supervisor.js            # 后台运行（建议：nohup node supervisor.js > supervisor.out 2>&1 &）
//   SUPERVISE_EXE="C:\\path\\弹幕AI主播助手.exe" node supervisor.js   # 指定打包后的单文件 EXE
//   SUPERVISE_BIN=electron SUPERVISE_ARGS=". --autorun" node supervisor.js
//
// 停止：touch .supervisor_stop   （守护进程下一轮巡检时退出；助手子进程一并结束）

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CWD = __dirname;
const STOP_FILE = path.join(CWD, '.supervisor_stop');
const LOG_PATH = path.join(CWD, 'supervisor.log');
const CDP_URL = 'http://127.0.0.1:9222/json';
const PROBE_MS = 15000;            // CDP 探活间隔
const CDP_LOST_LIMIT = 90000;      // 游戏页丢失超过该时长 → 强杀重建
const RESTART_MIN_GAP = 60000;     // 两次重启最小间隔（限频）
const MAX_CONSECUTIVE = 20;        // 连续重启上限（超过则放弃并退出）
const HEALTHY_UPTIME = 300000;     // 子进程存活超过此时长 → 重置连重计数

function log(...a) {
  const s = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, s, 'utf8'); } catch (e) {}
  process.stdout.write(s);
}

// ---------- 启动命令解析 ----------
function resolveLaunch() {
  const exe = process.env.SUPERVISE_EXE;
  if (exe && fs.existsSync(exe)) return { bin: exe, args: ['--autorun'], label: exe };
  // 单文件 EXE 产物（build 命名）
  const distExe = path.join(CWD, 'dist', '弹幕AI主播助手.exe');
  if (fs.existsSync(distExe)) return { bin: distExe, args: ['--autorun'], label: distExe };
  const bin = process.env.SUPERVISE_BIN || 'electron';
  const args = (process.env.SUPERVISE_ARGS || '. --autorun').split(/\s+/).filter(Boolean);
  return { bin, args, label: `${bin} ${args.join(' ')}` };
}

// ---------- CDP 探活 ----------
async function gamePageAlive() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(CDP_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const list = await res.json();
    return Array.isArray(list) && list.some((p) => p.type === 'page' && /Cocos Creator/.test(p.title || ''));
  } catch (e) { return false; }
}

// ---------- 杀进程树（Windows 用 taskkill /T，其他用 SIGKILL） ----------
function killTree(pid) {
  if (!pid) return;
  if (os.platform() === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', detached: false }); } catch (e) {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} }
  }
}

// ---------- 主守护循环 ----------
(async () => {
  if (fs.existsSync(STOP_FILE)) { log('发现 .supervisor_stop，直接退出（未启动助手）'); return; }
  const launch = resolveLaunch();
  log(`=== supervisor 启动 === 启动命令: ${launch.label} | CWD=${CWD}`);
  log(`参数: 探活${PROBE_MS}ms / 丢失上限${CDP_LOST_LIMIT}ms / 重启限频${RESTART_MIN_GAP}ms / 连重上限${MAX_CONSECUTIVE}`);

  let child = null;
  let lastSpawnAt = 0;
  let consecutive = 0;
  let cdpMissingSince = null;

  function spawnChild() {
    log(`[spawn] 启动助手: ${launch.label}`);
    child = spawn(launch.bin, launch.args, { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'], detached: os.platform() !== 'win32' });
    child.stdout && child.stdout.on('data', (d) => { const s = String(d).trim(); if (s) log('[assistant] ' + s); });
    child.stderr && child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log('[assistant!] ' + s); });
    child.on('exit', (code, signal) => {
      log(`[assistant] 子进程退出 code=${code} signal=${signal}`);
      child = null;
      if (fs.existsSync(STOP_FILE)) { log('发现 .supervisor_stop，停止自动重启'); process.exit(0); }
      const now = Date.now();
      // 限频：距上次启动不足 RESTART_MIN_GAP 则等待补齐
      const wait = Math.max(0, RESTART_MIN_GAP - (now - lastSpawnAt));
      consecutive++;
      if (consecutive > MAX_CONSECUTIVE) {
        log(`⚠️ 连续重启 ${consecutive} 次超过上限 ${MAX_CONSECUTIVE}，放弃并退出（请检查助手启动命令/日志）`);
        process.exit(2);
      }
      if (wait > 0) { log(`[restart] ${Math.round(wait / 1000)}s 后第 ${consecutive} 次重启…`); setTimeout(spawnChild, wait); }
      else { log(`[restart] 立即第 ${consecutive} 次重启…`); spawnChild(); }
    });
    lastSpawnAt = Date.now();
    consecutive = 0; // 成功启动后，若稳定存活会由健康检查复位；这里先清，避免单次崩溃误累计（见下方存活复位）
  }

  // 成功存活超过 HEALTHY_UPTIME 则复位连重计数（放在探活循环里做）
  spawnChild();

  const timer = setInterval(async () => {
    if (fs.existsSync(STOP_FILE)) {
      log('发现 .supervisor_stop，停止守护');
      if (child) killTree(child.pid);
      clearInterval(timer);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    const alive = await gamePageAlive();
    if (alive) {
      cdpMissingSince = null;
      // 健康检查：子进程已稳定存活足够久 → 复位连重计数
      if (child && lastSpawnAt && Date.now() - lastSpawnAt > HEALTHY_UPTIME) {
        if (consecutive !== 0) { log(`[health] 助手已稳定运行 > ${HEALTHY_UPTIME / 1000}s，复位连重计数`); consecutive = 0; }
      }
    } else {
      if (cdpMissingSince === null) { cdpMissingSince = Date.now(); log('[cdp] 游戏页丢失，开始计时…'); }
      const lost = Date.now() - cdpMissingSince;
      if (lost > CDP_LOST_LIMIT) {
        log(`[cdp] 游戏页丢失 ${Math.round(lost / 1000)}s > ${CDP_LOST_LIMIT / 1000}s，强杀助手进程树并重建`);
        if (child) killTree(child.pid);
        child = null;
        cdpMissingSince = null;
        // 立即重启（受连重上限约束）
        consecutive++;
        if (consecutive > MAX_CONSECUTIVE) { log(`⚠️ 连续重建 ${consecutive} 次超过上限，放弃`); clearInterval(timer); process.exit(2); }
        spawnChild();
      } else {
        log(`[cdp] 游戏页丢失中（${Math.round(lost / 1000)}s / ${CDP_LOST_LIMIT / 1000}s）…`);
      }
    }
  }, PROBE_MS);

  process.on('SIGINT', () => { log('收到 SIGINT，停止守护'); if (child) killTree(child.pid); process.exit(0); });
  process.on('SIGTERM', () => { log('收到 SIGTERM，停止守护'); if (child) killTree(child.pid); process.exit(0); });
})();
