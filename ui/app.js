'use strict';
const $ = (id) => document.getElementById(id);
let cfg = {};
let running = false;
let stats = { danmaku: 0, songs: 0, ai: 0, miss: 0 };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

function pushFeed(html, cls = '') {
  const box = $('feed');
  const div = document.createElement('div');
  div.className = cls || 'dm';
  div.innerHTML = html;
  box.appendChild(div);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function pushLog(text, isErr) {
  const box = $('logBox');
  const d = document.createElement('div');
  d.className = 'log' + (isErr ? ' err' : '');
  d.textContent = text;
  box.appendChild(d);
  while (box.childElementCount > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function setConn(on, text) {
  $('dotConn').className = 'dot' + (on ? ' on' : '');
  $('connTxt').textContent = text;
}

function refreshStats() {
  $('sDm').textContent = stats.danmaku;
  $('sSong').textContent = stats.songs;
  $('sAi').textContent = stats.ai;
  $('sMiss').textContent = stats.miss;
  $('dmCount').textContent = stats.danmaku + ' 条';
}

// ---------- 配置 ----------
async function loadCfg() {
  cfg = await window.api.loadCfg();
  $('roomId').value = cfg.roomId || '';
  $('songCmd').value = cfg.songCmd || '点歌';
  $('aiOnDanmaku').checked = !!cfg.aiOnDanmaku;
  $('aiEnabled').checked = !!(cfg.ai && cfg.ai.enabled !== false);
  $('aiBase').value = (cfg.ai && cfg.ai.baseUrl) || '';
  $('aiModel').value = (cfg.ai && cfg.ai.model) || '';
  $('aiKey').value = (cfg.ai && cfg.ai.apiKey) || '';
  $('gameExe').value = cfg.gameExe || '';
  $('gameCode').value = cfg.identityCode || '';
  if (cfg.embeddedGame) {
    $('gameExe').value = cfg.embeddedGame;
    pushLog('已检测到内嵌游戏本体，将优先使用：' + cfg.embeddedGame);
  }
}

function readCfg() {
  cfg.roomId = $('roomId').value.trim();
  cfg.songCmd = $('songCmd').value.trim() || '点歌';
  cfg.aiOnDanmaku = $('aiOnDanmaku').checked;
  cfg.ai = cfg.ai || {};
  cfg.ai.enabled = $('aiEnabled').checked;
  cfg.ai.baseUrl = $('aiBase').value.trim();
  cfg.ai.model = $('aiModel').value.trim();
  cfg.ai.apiKey = $('aiKey').value.trim();
  cfg.gameExe = $('gameExe').value.trim();
  cfg.identityCode = $('gameCode').value.trim();
  return cfg;
}

// ---------- 按钮 ----------
$('btnStart').onclick = async () => {
  const c = readCfg();
  if (!c.roomId) { toast('先填直播间房间号'); return; }
  const r = await window.api.start(c);
  if (!r.ok) { toast('启动失败：' + r.msg); return; }
  running = true;
  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  pushLog('已启动，连接房间 ' + c.roomId);
};

$('btnStop').onclick = async () => {
  await window.api.stop();
  running = false;
  $('btnStart').disabled = false;
  $('btnStop').disabled = true;
  setConn(false, '已停止');
  pushLog('已停止');
};

$('btnSave').onclick = async () => {
  await window.api.saveCfg(readCfg());
  toast('配置已保存');
};

$('btnSay').onclick = async () => {
  const v = $('sayInput').value.trim();
  if (!v) return;
  await window.api.say(v);
  $('sayInput').value = '';
};

$('sayInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnSay').click();
});

$('btnSearch').onclick = doSearch;
$('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

async function doSearch() {
  const kw = $('searchInput').value.trim();
  if (!kw) return;
  const box = $('searchResult');
  box.innerHTML = '<div class="empty">搜索中…</div>';
  const r = await window.api.search(kw, $('provider').value);
  if (!r.ok) { box.innerHTML = `<div class="empty">搜索失败：${esc(r.msg)}</div>`; return; }
  if (!r.list.length) { box.innerHTML = '<div class="empty">曲库没有这首歌</div>'; return; }
  box.innerHTML = r.list.map((t, i) => `
    <div class="track">
      <button class="sm btn" data-i="${i}">播放</button>
      <span class="n">${esc(t.name)}</span><span class="a">${esc(t.artist)}</span>
    </div>`).join('');
  box.querySelectorAll('button[data-i]').forEach(b => {
    b.onclick = async () => {
      const pr = await window.api.play(r.list[+b.dataset.i]);
      if (!pr.ok) toast('播放失败：' + pr.msg);
      else toast('已开始播放');
    };
  });
}

$('btnNext').onclick = () => window.api.next();
$('btnStopSong').onclick = () => window.api.stopSong();

$('btnGame').onclick = async () => {
  const r = await window.api.launchGame($('gameExe').value.trim());
  if (!r.ok) { toast(r.msg); return; }
  if (r.auto) { $('gameExe').value = r.exe; toast('已自动定位游戏，正在启动'); }
  else toast('正在启动游戏');
};

$('btnGameDetect').onclick = async () => {
  const r = await window.api.gameDetect($('gameExe').value.trim());
  if (!r.ok) { toast(r.msg); return; }
  $('gameExe').value = r.exe;
  await window.api.saveCfg(readCfg());
  toast('已检测到：' + r.exe.split('\\').slice(-2).join('\\'));
};

// ---------- 游戏操作 ----------
$('btnGameOpen').onclick = async () => {
  $('btnGameOpen').disabled = true;
  const r = await window.api.gameOpen();
  $('btnGameOpen').disabled = false;
  if (!r.ok) toast(r.msg); else toast('游戏窗口已打开');
};

$('btnGameFill').onclick = async () => {
  const code = $('gameCode').value.trim();
  if (!code) { toast('先填身份码'); return; }
  toast('正在进游戏…');
  const r = await window.api.gameFillCode(code);
  if (!r.ok) toast(r.msg); else { toast('已提交身份码'); setTimeout(doGameShot, 4000); }
};

async function tap(name) {
  const r = await window.api.gameTap(name);
  if (r.ok) setTimeout(doGameShot, 700);
}
$('btnTapHost').onclick = () => tap('hostJoin');
$('btnTapBot10').onclick = () => tap('addBot10');
$('btnTapStart').onclick = () => tap('startGame');
$('btnTapFree').onclick = () => tap('freeMode');
$('btnTapBack').onclick = () => tap('backLobby');

let gameShotSize = { w: 1344, h: 781 };
$('btnGameShot').onclick = doGameShot;
async function doGameShot() {
  const r = await window.api.gameShot();
  if (!r.ok) { toast(r.msg); return; }
  if (r.size) gameShotSize = { w: r.size.width, h: r.size.height };
  $('gameView').src = r.dataUrl;
  $('gameEmpty').style.display = 'none';
}

$('gameView').addEventListener('click', async (e) => {
  const rect = e.target.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * gameShotSize.w;
  const y = (e.clientY - rect.top) / rect.height * gameShotSize.h;
  const r = await window.api.gameClick(x, y);
  if (r.ok) {
    pushLog(`点击游戏 (${Math.round(x)}, ${Math.round(y)})`);
    setTimeout(doGameShot, 800);
  }
});

$('gameAutoSw').addEventListener('change', async (e) => {
  const r = await window.api.gameAuto(e.target.checked);
  if (!r.ok) { toast(r.msg); e.target.checked = false; }
});

window.api.on('gameai', (j) => {
  $('gameAiSay').textContent = j.say ? 'AI: ' + j.say : '';
  if (j.click && j.click.why) pushLog('AI点击 ' + Math.round(j.click.x) + ',' + Math.round(j.click.y) + ' — ' + j.click.why);
});

$('btnLog').onclick = () => window.api.openLog();

// ---------- 手动指令台（以各账号直接发游戏弹幕指令） ----------
let cmdAccounts = [];
async function loadCmdAccounts() {
  const r = await window.api.manualAccounts();
  const box = $('cmdAccList');
  if (!r.ok) {
    $('cmdAccStatus').textContent = '读取失败';
    box.innerHTML = `<span class="empty">${esc(r.msg)}</span>`;
    return;
  }
  cmdAccounts = r.accounts || [];
  $('cmdAccStatus').textContent = `可用 ${r.usableCount}/${cmdAccounts.length}`;
  if (!($('roomId').value || '').trim()) {
    pushCmd('提示：请在「配置」填写直播间房间号后再发送', true);
  }
  box.innerHTML = cmdAccounts.length
    ? cmdAccounts.map((a) => `
      <label class="acc-pill ${a.sendable ? '' : 'disabled'}">
        <input type="checkbox" value="${esc(a.id)}" ${a.sendable ? 'checked' : 'disabled'} />
        <span>${esc(a.uname)}</span>
      </label>`).join('')
    : '<span class="empty">未读取到账号</span>';
}
function pushCmd(text, isErr) {
  const box = $('cmdBox');
  const d = document.createElement('div');
  d.className = 'log' + (isErr ? ' err' : '');
  d.textContent = text;
  box.appendChild(d);
  while (box.childElementCount > 100) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
// 快捷指令按钮：点击把对应指令填入输入框
document.querySelectorAll('#cmdCard [data-cmd]').forEach((b) => {
  b.onclick = () => { $('cmdInput').value = b.dataset.cmd; };
});
$('btnCmdAll').onclick = () => {
  const boxes = [...$('cmdAccList').querySelectorAll('input:not([disabled])')];
  const allChecked = boxes.length > 0 && boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !allChecked; });
};
$('btnCmdSend').onclick = async () => {
  const text = $('cmdInput').value.trim();
  if (!text) { toast('请输入指令内容'); return; }
  if (!($('roomId').value || '').trim()) { toast('请先在「配置」填写房间号'); return; }
  const ids = [...$('cmdAccList').querySelectorAll('input:checked')].map((cb) => cb.value);
  if (!ids.length) { toast('请勾选至少一个账号'); return; }
  $('btnCmdSend').disabled = true;
  pushCmd(`发送「${text}」→ ${ids.length} 个账号…`);
  const r = await window.api.manualSend({ text, accountIds: ids });
  $('btnCmdSend').disabled = false;
  if (!r.ok) { pushCmd('失败：' + r.msg, true); return; }
  r.results.forEach((res) => {
    pushCmd(`${res.uname}: ${res.ok ? '✓ 已发送' : '✗ (' + (res.code || '') + ' ' + (res.message || '') + ')'}`,
      !res.ok);
  });
};

// 当前勾选的账号 id 列表
function selectedCmdIds() {
  return [...$('cmdAccList').querySelectorAll('input:checked')].map((cb) => cb.value);
}

// 一键开始：启动内嵌游戏（最佳努力）+ 自动报名 + 选房，组合指令一步到位
$('btnCmdStart').onclick = async () => {
  const ids = selectedCmdIds();
  if (!ids.length) { toast('请先勾选至少一个账号'); return; }
  if (!($('roomId').value || '').trim()) { toast('请先在「配置」填写房间号'); return; }
  const room = $('cmdRoom').value;
  $('btnCmdStart').disabled = true;
  // 0) 最佳努力：启动并打开内嵌游戏本体、填身份码、点主播报名/开始
  try {
    const lr = await window.api.launchGame();
    if (lr.ok) {
      pushCmd('已启动游戏本体' + (lr.embedded ? '（内嵌）' : '') + '：' + lr.exe);
      await window.api.gameOpen();
      const code = ($('gameCode').value || '').trim();
      if (code) await window.api.gameFillCode(code);
      setTimeout(() => window.api.gameTap('hostJoin').catch(() => {}), 1500);
      setTimeout(() => window.api.gameTap('startGame').catch(() => {}), 3500);
    } else {
      pushCmd('启动游戏本体失败：' + lr.msg, true);
    }
  } catch (e) { pushCmd('启动游戏环节异常：' + e.message, true); }
  // 1) 组合指令①：报名
  pushCmd(`一键开始：发送「报名」→ ${ids.length} 个账号…`);
  const r1 = await window.api.manualSend({ text: '报名', accountIds: ids });
  (r1.results || []).forEach((res) => pushCmd(`${res.uname}: ${res.ok ? '✓ 已发送' : '✗ (' + (res.code || '') + ' ' + (res.message || '') + ')'}` , !res.ok));
  // 2) 组合指令②：选房（默认 A-D）
  await new Promise((res) => setTimeout(res, 1200));
  pushCmd(`一键开始：发送选房「${room}」→ ${ids.length} 个账号…`);
  const r2 = await window.api.manualSend({ text: room, accountIds: ids });
  (r2.results || []).forEach((res) => pushCmd(`${res.uname}: ${res.ok ? '✓ 已发送' : '✗ (' + (res.code || '') + ' ' + (res.message || '') + ')'}` , !res.ok));
  $('btnCmdStart').disabled = false;
};

// ---------- 事件 ----------
window.api.on('danmaku', (d) => {
  stats.danmaku++;
  refreshStats();
  pushFeed(`<span class="u">${esc(d.user)}</span><span class="t">${esc(d.text)}</span>`, d.type === 'superchat' ? 'dm sc' : 'dm');
});

window.api.on('say', (d) => {
  pushFeed(esc(d.text), 'say');
});

window.api.on('ai', () => { stats.ai++; refreshStats(); });
window.api.on('songmiss', () => { stats.miss++; refreshStats(); });
window.api.on('queue', (q) => {
  $('qCount').textContent = '队列 ' + q.length;
  $('queueList').innerHTML = q.length
    ? q.map((t, i) => `<div class="track"><span class="n">${i + 1}. ${esc(t.name)}</span><span class="a">${esc(t.artist)}</span></div>`).join('')
    : '<div class="empty">队列为空</div>';
});

// ---------- 正在播放 / 歌词 / 下一首 ----------
function setPlaying(t) {
  if (!t) return;
  stats.songs++;
  refreshStats();
  $('nowPlaying').textContent = '♪ ' + t.name + ' - ' + (t.artist || '');
  $('npName').textContent = t.name || '';
  $('npArtist').textContent = t.artist || '';
  $('npSrc').textContent = t.source === 'netease' ? '网易云' : (t.fallback ? 'QQ→网易云' : 'QQ');
  $('lyricBox').innerHTML = t.lyric
    ? t.lyric.split('\n').map(l => `<div>${esc(l)}</div>`).join('')
    : '<div class="empty">这首歌暂无歌词</div>';
}

window.api.on('playing', (t) => setPlaying(t));

window.api.on('next', (t) => {
  $('nextUp').textContent = t ? `下一首：${t.name} - ${t.artist || ''}` : '下一首：队列已空';
});

window.api.on('player', (d) => {
  if (d.state === 'error' && d.track) {
    pushLog('播放失败《' + d.track.name + '》：' + (d.reason || '未知原因'), true);
  }
  if (d.state === 'idle') {
    $('nowPlaying').textContent = '';
    $('npName').textContent = '—';
    $('npArtist').textContent = '';
    $('npSrc').textContent = '';
    $('lyricBox').innerHTML = '<div class="empty">暂无播放</div>';
  }
});

window.api.on('status', (d) => {
  setConn(!!d.connected, d.connected ? '已连接' : '重连中');
});

window.api.on('roominfo', (d) => {
  const tag = $('roomTag');
  tag.style.display = 'flex';
  tag.textContent = `${d.title || ''}${d.liveStatus === 1 ? ' · 直播中' : ' · 未开播'}`;
});

window.api.on('popularity', (p) => {
  const tag = $('roomTag');
  if (tag) tag.textContent = tag.textContent.replace(/ · 人气\d+/, '') + ' · 人气' + p;
});

window.api.on('log', (t) => pushLog(t, /失败|错误|异常|error/i.test(t)));

// ---------- 狼人杀导演 ----------
function pushDirLog(text) {
  const box = $('dirLog');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'log' + (/失败|错误|异常|error|过期/.test(text) ? ' err' : '');
  d.textContent = text;
  box.appendChild(d);
  while (box.childElementCount > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function setDirStatus(isRunning) {
  const tag = $('dirStatus');
  tag.textContent = isRunning ? '运行中' : '空闲';
  tag.style.color = isRunning ? 'var(--acc2)' : '';
  $('btnDirStart').disabled = isRunning;
  $('btnDirStop').disabled = !isRunning;
}
$('btnDirStart').onclick = async () => {
  const r = await window.api.directorStart();
  if (!r.ok) { toast('启动失败：' + r.msg); return; }
  setDirStatus(true);
  pushDirLog('导演已启动，正在接管游戏…');
};
$('btnDirStop').onclick = async () => {
  await window.api.directorStop();
  setDirStatus(false);
  pushDirLog('导演已停止');
};
$('btnDirRestart').onclick = async () => {
  const sr = await window.api.directorCfgSave($('dirCfg').value);
  if (!sr.ok) { toast('配置保存失败：' + sr.msg); return; }
  const r = await window.api.directorRestart();
  if (!r.ok) { toast('重启失败：' + r.msg); return; }
  setDirStatus(true);
  pushDirLog('配置已保存，导演重启中…');
};
$('btnDirCfgLoad').onclick = async () => {
  const r = await window.api.directorCfgLoad();
  if (!r.ok) { toast('加载失败：' + r.msg); return; }
  $('dirCfg').value = r.text;
  toast('配置已加载');
};
$('btnDirCfgSave').onclick = async () => {
  const r = await window.api.directorCfgSave($('dirCfg').value);
  toast(r.ok ? '配置已保存（点「保存并重启」生效）' : '保存失败：' + r.msg);
};
$('btnDirOpen').onclick = () => window.api.directorOpenConfig();

window.api.on('director:log', (t) => pushDirLog(t));
window.api.on('director:status', (s) => { setDirStatus(!!s.running); const t = $('dgRunTag'); if (t) t.textContent = s.running ? '运行中' : '未运行'; });

// 启动后自动把导演配置载入编辑框
window.api.directorCfgLoad().then((r) => { if (r && r.ok) { $('dirCfg').value = r.text; dgFillForm(); } }).catch(() => {});

// ---------- 地下城（BoBo Master）参数面板 ----------
// 表单与上方「导演配置」JSON 文本框双向同步：表单改 → 写回 JSON 文本；保存走既有 directorCfgSave 通道。
// 预设权重镜像（与 _director2.js STRATEGY_PRESETS 保持一致，改这里要同步改那边）：
var DG_PRESETS = {
  attack:   { spd: 4, atk: 3, hp: 2, def: 1, ele: 0, res: 0 },   // 攻速>攻击>生命>防御，属性攻击/抗性降权
  balanced: { spd: 2, atk: 2, hp: 2, def: 2, ele: 1, res: 1 },
  resist:   { spd: 1, atk: 1, hp: 2, def: 2, ele: 1, res: 4 },
};
function dgGetCfg() { try { return JSON.parse($('dirCfg').value || '{}'); } catch (e) { return {}; } }
function dgSetCfg(cfg) { $('dirCfg').value = JSON.stringify(cfg, null, 2); }
function dgFillForm() {
  const cfg = dgGetCfg();
  const g = cfg.gacha || {};
  const bs = g.buffStrategy || {};
  const th = g.think || {};
  const llm = th.llm || {};
  const lp = g.loop || {};
  $('dgInStartLv').value = Number(g.startLv || 0);
  $('dgInEndLv').value = Number(g.endLv || 100);
  $('dgInLoopOn').checked = !!lp.enabled;
  $('dgInMaxRounds').value = Number(lp.maxRounds || 0);
  $('dgInMult').value = Number(g.buffMultiplier || 999);
  const mode = bs.mode || 'attack';
  $('dgInStrat').value = mode;
  $('dgInHeal').value = Number(g.healPct || 40);
  // 预设模式显示「生效权重」（预设镜像），custom/auto 显示配置里的 weights
  const w = DG_PRESETS[mode] || bs.weights || DG_PRESETS.attack;
  $('dgInWSpd').value = Number(w.spd != null ? w.spd : 0);
  $('dgInWAtk').value = Number(w.atk != null ? w.atk : 0);
  $('dgInWHp').value = Number(w.hp != null ? w.hp : 0);
  $('dgInWDef').value = Number(w.def != null ? w.def : 0);
  $('dgInWEle').value = Number(w.ele != null ? w.ele : 0);
  $('dgInWRes').value = Number(w.res != null ? w.res : 0);
  $('dgInPreferPct').checked = bs.preferPercent !== false;
  $('dgInDmOn').checked = th.enabled !== false;
  $('dgInAutoTune').checked = !!th.autoTune;
  $('dgInLlmOn').checked = !!llm.enabled;
  $('dgInLlmBase').value = llm.baseUrl || 'http://127.0.0.1:8080/v1';
  $('dgInLlmModel').value = llm.model || '';
  $('dgInLlmEvery').value = Number(llm.everyLevels || 10);
  $('dgLlmRow').style.display = $('dgInLlmOn').checked ? '' : 'none';
  if (typeof mapRefresh === 'function') mapRefresh();   // 地图切换卡片状态跟随配置
}
// 切换预设模式时，把权重框刷成该预设的生效值，避免「选了 attack 却显示旧 custom 值」的错觉
$('dgInStrat').onchange = () => {
  const p = DG_PRESETS[$('dgInStrat').value];
  if (!p) return;
  $('dgInWSpd').value = p.spd; $('dgInWAtk').value = p.atk; $('dgInWHp').value = p.hp;
  $('dgInWDef').value = p.def; $('dgInWEle').value = p.ele; $('dgInWRes').value = p.res;
};
function dgClamp(v, lo, hi, dflt) { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; }
function dgApplyToCfg() {
  const cfg = dgGetCfg();
  cfg.gacha = cfg.gacha || {};
  const g = cfg.gacha;
  g.startLv = dgClamp($('dgInStartLv').value, 0, 99, 0);
  g.endLv = dgClamp($('dgInEndLv').value, 1, 100, 100);
  g.loop = g.loop || {};
  g.loop.enabled = $('dgInLoopOn').checked;
  g.loop.maxRounds = dgClamp($('dgInMaxRounds').value, 0, 9999, 0);
  g.buffMultiplier = dgClamp($('dgInMult').value, 1, 999999, 999);
  g.buffStrategy = g.buffStrategy || {};
  g.buffStrategy.mode = $('dgInStrat').value;
  const weights = {
    spd: dgClamp($('dgInWSpd').value, 0, 9, 0),
    atk: dgClamp($('dgInWAtk').value, 0, 9, 0),
    hp: dgClamp($('dgInWHp').value, 0, 9, 0),
    def: dgClamp($('dgInWDef').value, 0, 9, 0),
    ele: dgClamp($('dgInWEle').value, 0, 9, 0),
    res: dgClamp($('dgInWRes').value, 0, 9, 0),
  };
  // 权重与所选预设不一致 → 自动切 custom（用户动了权重就是想让自定义生效）
  const preset = DG_PRESETS[g.buffStrategy.mode];
  if (preset) {
    const same = ['spd', 'atk', 'hp', 'def', 'ele', 'res'].every(k => Number(preset[k]) === Number(weights[k]));
    if (!same) g.buffStrategy.mode = 'custom';
  }
  g.buffStrategy.weights = weights;
  g.buffStrategy.preferPercent = $('dgInPreferPct').checked;
  g.healPct = dgClamp($('dgInHeal').value, 5, 95, 40);
  g.think = g.think || {};
  g.think.enabled = $('dgInDmOn').checked;
  g.think.autoTune = $('dgInAutoTune').checked;
  g.think.llm = g.think.llm || {};
  g.think.llm.enabled = $('dgInLlmOn').checked;
  g.think.llm.baseUrl = ($('dgInLlmBase').value || '').trim() || 'http://127.0.0.1:8080/v1';
  g.think.llm.model = ($('dgInLlmModel').value || '').trim();
  g.think.llm.everyLevels = dgClamp($('dgInLlmEvery').value, 1, 100, 10);
  dgSetCfg(cfg);
  return cfg;
}
$('btnDgApply').onclick = async () => {
  dgApplyToCfg();
  const r = await window.api.directorCfgSave($('dirCfg').value);
  toast(r.ok ? '地下城参数已写入配置（点「保存并重启导演」生效）' : '保存失败：' + r.msg);
};
$('btnDgSaveRestart').onclick = async () => {
  dgApplyToCfg();
  const sr = await window.api.directorCfgSave($('dirCfg').value);
  if (!sr.ok) { toast('配置保存失败：' + sr.msg); return; }
  const r = await window.api.directorRestart();
  if (!r.ok) { toast('重启失败：' + r.msg); return; }
  setDirStatus(true);
  pushDirLog('地下城参数已保存，导演重启中…');
  toast('已保存并重启导演');
};
$('btnDgReload').onclick = async () => {
  const r = await window.api.directorCfgLoad();
  if (!r.ok) { toast('加载失败：' + r.msg); return; }
  $('dirCfg').value = r.text;
  dgFillForm();
  toast('已从磁盘重置表单');
};
$('dgInLlmOn').onchange = () => { $('dgLlmRow').style.display = $('dgInLlmOn').checked ? '' : 'none'; };

// ---------- 地图/玩法切换（阶段五：游戏内全部地图一键切 + 导演热重启接管） ----------
// 与 _director2.js 的 GAME_MODES 对应；点击 → 写 config.gameMode → directorCfgSave → directorRestart
// （热重启只重建导演 Worker，约 2s，游戏窗口不关）。弹幕「地图 X」可实时切（不写盘）。
var MAP_NAMES = { gacha: '地下城', werewolf: '弹幕狼人杀', rouge: '这是什么颜色', chump: '放学不许走', greatsword: '物理学不存在', ball: '抢球对战', frameball: '跨房抢球', draw: '鼠王争夺战', dj: '弹幕舞台', hd: '航海探索', jz: '航海打捞', pet: '宠物互动', xiuxian: '修仙擂台', auto: '自动识别' };
function mapRefresh() {
  const m = dgGetCfg().gameMode || 'gacha';
  const tag = $('mapTag'); if (tag) tag.textContent = MAP_NAMES[m] || m;
  const st = $('mapStatus');
  if (st && !st.dataset.live) st.textContent = '当前目标：' + (MAP_NAMES[m] || m) + (m === 'auto' ? '（按场景自动识别）' : '');
  document.querySelectorAll('[data-map]').forEach(function (b) {
    const k = b.getAttribute('data-map');
    const on = k === m;
    b.classList.toggle('primary', on);
    b.classList.toggle('ghost', k === 'auto' && !on);
  });
}
document.querySelectorAll('[data-map]').forEach(function (b) {
  b.onclick = async () => {
    const m = b.getAttribute('data-map');
    const cfg = dgGetCfg();
    if ((cfg.gameMode || 'gacha') === m) { toast('当前已是「' + (MAP_NAMES[m] || m) + '」'); return; }
    cfg.gameMode = m;
    dgSetCfg(cfg);
    const sr = await window.api.directorCfgSave($('dirCfg').value);
    if (!sr.ok) { toast('配置保存失败：' + sr.msg); return; }
    const r = await window.api.directorRestart();
    if (!r.ok) { toast('导演重启失败：' + r.msg); return; }
    mapRefresh();
    setDirStatus(true);
    pushDirLog('地图切换：目标「' + (MAP_NAMES[m] || m) + '」，导演重启中…');
    toast('正在切换到「' + (MAP_NAMES[m] || m) + '」…（约 2 秒）');
  };
});
mapRefresh();

// 地下城实时状态（导演 worker → main → 这里）
window.api.on('director:dungeon', (d) => {
  if (!d) return;
  const tag = $('dgRunTag'); if (tag) tag.textContent = '运行中';
  $('dgStLv').textContent = d.lv || '—';
  $('dgStPhase').textContent = d.phase || '—';
  $('dgStStrat').textContent = d.strategy || '—';
  $('dgStMult').textContent = '×' + (d.mult != null ? d.mult : '—');
  $('dgStHeal').textContent = (d.healPct != null ? d.healPct + '%' : '—');
  $('dgStLoop').textContent = d.loop ? ('开→' + d.endLv + '关') : '关';
  $('dgStRounds').textContent = d.rounds != null ? d.rounds : '—';
  $('dgStKb').textContent = d.kb ? (d.kb.wins + '胜' + d.kb.loses + '负') : '—';
  if (d.lastCmd) $('dgStCmd').textContent = '最后弹幕指令：' + d.lastCmd + '（by ' + (d.lastCmdBy || '?') + '）';
  // 地图切换实时状态（新导演 worker 广播 mode/modeName/sceneReady；旧代码无此字段时保持配置态）
  if (d.modeName) {
    const ms = $('mapStatus');
    if (ms) { ms.textContent = '当前目标：' + d.modeName + ' — ' + (d.sceneReady ? '场景已就位' : '切换中…'); ms.dataset.live = '1'; }
    const tg = $('mapTag'); if (tg) tg.textContent = d.modeName;
    const kb = MAP_NAMES[d.mode] || d.mode;
    document.querySelectorAll('[data-map]').forEach(function (b) {
      const on = b.getAttribute('data-map') === d.mode;
      b.classList.toggle('primary', on);
      b.classList.toggle('ghost', b.getAttribute('data-map') === 'auto' && !on);
    });
    if (kb && tg && tg.textContent !== kb) tg.textContent = kb;
  }
});

// ---------- 音频播放（无 mpv 时的内置播放器）----------
let audio = null;
let pendingTrack = null;
function ensureAudio() {
  if (!audio) {
    audio = new Audio();
    audio.volume = 0.7;
    audio.onended = () => { window.api.next(); };
    audio.onerror = () => { pushLog('音频播放失败: ' + (audio.src || '').slice(0, 80), true); window.api.next(); };
  }
  return audio;
}
window.api.on('play-audio', (t) => {
  const a = ensureAudio();
  pendingTrack = t;
  a.src = t.url;
  a.play().then(() => {
    $('nowPlaying').textContent = '♪ ' + t.name + ' - ' + (t.artist || '');
  }).catch(e => {
    pushLog('播放被拒绝: ' + e.message, true);
    setTimeout(() => a.play().catch(() => {}), 800);
  });
});
window.api.on('stop-audio', () => {
  if (audio) { audio.pause(); audio.src = ''; }
});

loadCfg().then(() => { pushLog('配置已加载'); loadCmdAccounts(); }).catch(() => loadCmdAccounts());
refreshStats();
