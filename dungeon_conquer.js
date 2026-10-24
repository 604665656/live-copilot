'use strict';
// ============================================================================
//  dungeon_conquer.js — 地下城（BoBo Master / Gacha 怪兽）导演 · 攻克 100 关
// ----------------------------------------------------------------------------
//  纯单机导演：连上已在跑的 cdyz 游戏页（Edge 9333 或 Electron 9222），
//  自动决策并驱动「地下城」玩法直到第 100 关。
//
//  决策点（全部来自 game-bundle 实测，非猜测）：
//   · 加入/开始  → 直接「加入」（1 人即可开局，无需报名）；--others 可让其他号一同加入队伍
//   · 起始关卡   → --start-lv N 可强制从第 N 关开始（best-effort，敌强可能回落）
//   · 选增益 BUFF → 按 bobo_buffs.json 品质表选「最高品质」（传说>史诗>稀有>普通），同档比数值量级与攻击倾向
//   · 选任务/BOSS → 选 taskIds[0]（默认最优；可按需改 heuristic）
//   · 战斗·加血  → HP<40% 发弹幕「加血」(耗3金,+30%HP)
//   · 战斗·复活  → 死亡发弹幕「复活」(耗10金,满血)
//   · 战斗·闪避  → 检测到 BOSS 技能预警时，点「闪避/躲避」按钮（运行时自动发现，无则降级）
//   · 战斗·大招  → 检测到技能就绪时，点「大招/技能/释放」按钮（运行时自动发现，无则降级）
//   · 通关/下一关 → 点「下一关/继续/重开」自动推进（无尽模式）
//
//  用法:
//    node dungeon_conquer.js            # 连上游戏，自动攻克到 100 关
//    node dungeon_conquer.js --target 100
//    node dungeon_conquer.js --selftest # 不连游戏，校验决策逻辑（本机可跑）
//    node dungeon_conquer.js --dry      # 连上但不真正点击（只打印探测结果）
// ============================================================================
const { CDP } = require('./_cdp');
const fs = require('fs');

// 「助手」(bili-relation-manager) 里的真实已登录 bilibili 账号：
// 用于向直播间发真实「加入」弹幕，让这些真实账号作为队友进入地下城（与真人观众发弹幕加入机制一致）。
let _brmMod = null;
function loadBrmAccounts() {
  if (!_brmMod) _brmMod = require('./-/src/accounts.js');
  try { return _brmMod.loadAccounts().usable; } catch (e) { return []; }
}

const TARGET_LEVEL = Number(process.argv.find(a => a.startsWith('--target'))?.split('=')[1] || 100);
// 兼容两种写法：--start-lv 80 与 --start-lv=80
function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith(name + '='));
  return eq ? eq.split('=')[1] : null;
}
const START_LV = Number(getArg('--start-lv') || 0);
const OTHERS_RAW = getArg('--others') || '';
// 其他号：--others uid1:名字1,uid2:名字2  （未给名字时默认「队友<uid>」）
const OTHERS = OTHERS_RAW.split(',').filter(Boolean).map(s => {
  const i = s.indexOf(':'); const uid = (i >= 0 ? s.slice(0, i) : s).trim();
  const name = (i >= 0 ? s.slice(i + 1) : '').trim() || ('队友' + uid);
  return { uid, name };
});
const SELFTEST = process.argv.includes('--selftest');
const DRY = process.argv.includes('--dry');
const POLL_MS = 1200;          // 主循环节奏
const REACT_MS = 600;          // 决策后小停顿，模拟人类反应

// ---- 日志 ----
const LOG = fs.createWriteStream('dungeon_conquer.log', { flags: 'a' });
function log(...a) {
  const s = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + a.join(' ');
  console.log(s); LOG.write(s + '\n');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rnd(a) { return a[Math.floor(Math.random() * a.length)]; }

// ============================================================================
//  纯决策函数（可在 --selftest 中独立验证）
// ============================================================================

// 已实测的地下城弹幕指令词表（来自 bundle：t.info 比较）
const DANMU_CMDS = ['报名', '加血', '复活',
  '查询金币', '查询名片', '查询碎片', '查询鱼币', '查询钓鱼', '查询积分',
  '查询仙丹', '查询背包', '查询套装', '查询滤镜', '查询糖果', '查询蛋糕'];

// 增益打分：攻击系优先，其次生存，最后资源（文本兜底，用于表外 id）
function scoreBuff(names, descs) {
  let best = 0, bestScore = -1;
  (names || []).forEach((nm, i) => {
    const d = (descs && descs[i] ? descs[i] : '') + (nm || '');
    let s = 0;
    if (/攻击|伤害|攻速|暴击|穿透|倍率|强化|增伤/.test(d)) s += 10;
    else if (/生命|血量|防御|护盾|减伤|回血|吸血|格挡/.test(d)) s += 6;
    else if (/金币|能量|经验|暴击率|攻速加成/.test(d)) s += 3;
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return { best, bestScore };
}

// ============================================================================
//  BUFF 品质表（离线提取自游戏资产 mainScene/import/a3/a360c30c….json → bobo_buffs.json）
//  60 条 = 15 种类型 × 4 档；grade: 0=普通(灰#a1a1a1) 1=稀有(蓝) 2=史诗(紫) 3=传说(金#ffc924)
//  基础属性（防御9/攻击7/攻速8/血量1/魔抗12）用 addAttPercents：5%/10%/20%/50%
//  元素攻（水火风地雷 18/20/22/24/26）与元素抗（19/21/23/25/27）用 addAttValues：50/100/200/500
//  用户要求：「BUFF 改到能修改的最高」= 永远选当前可选卡片里品质最高（金边传说）的那张
// ============================================================================
let BUFF_TABLE = {};
try { BUFF_TABLE = require('./bobo_buffs.json'); } catch (e) { /* 表缺失时退化为文本打分 */ }
const GRADE_NAMES = ['普通', '稀有', '史诗', '传说'];
// 攻击类属性类型（直接提升输出）：攻击7/攻速8/五元素攻18-26
const BUFF_ATK_TYPES = new Set([7, 8, 18, 20, 22, 24, 26]);
// 生存类属性类型：血量1/防御9/魔抗12
const BUFF_DEF_TYPES = new Set([1, 9, 12]);

// 单条 BUFF 评分：① 品质(grade)绝对优先 ② 数值量级（%与 flat 折算同尺度）③ 攻击倾向加权
function buffScore(b) {
  if (!b) return -1;
  let s = (b.grade || 0) * 1000;
  const pct = (b.addAttPercents || []).reduce((a, x) => a + (Number(x) || 0), 0);
  const val = (b.addAttValues || []).reduce((a, x) => a + (Number(x) || 0), 0);
  s += Math.min(pct, 100) + Math.min(val / 10, 100);   // 同档元素500flat 与 基础50% 折算同分，交给③决胜
  const types = b.addAttTypes || [];
  if (types.some(t => BUFF_ATK_TYPES.has(t))) s += 20;  // 攻类优先（速通导向）
  else if (types.some(t => BUFF_DEF_TYPES.has(t))) s += 10;
  return s;
}

// 按现场 buffIds 选「最高品质」：返回 best 索引 + 各档位名（供日志）
function scoreBuffByIds(ids, names, descs) {
  let best = 0, bestScore = -1;
  (ids || []).forEach((id, i) => {
    const b = BUFF_TABLE[String(id)];
    const s = b ? buffScore(b) : scoreBuff([names && names[i]] || [], [descs && descs[i]] || []).bestScore;
    if (s > bestScore) { bestScore = s; best = i; }
  });
  const grades = (ids || []).map(id => {
    const b = BUFF_TABLE[String(id)];
    return b ? (GRADE_NAMES[b.grade] != null ? GRADE_NAMES[b.grade] : 'G' + b.grade) : '表外';
  });
  return { best, bestScore, grades };
}

// 阶段判定（输入为现场探测到的场景特征）
function classifyPhase(f) {
  const { hasBtnItems, hasBuffIds, isCanSelect, hasSelectTask, labels } = f;
  const txt = (labels || []).join(' ');
  if (/通关|胜利|胜利了|下一关|继续|结算|挑战成功|本关完成/.test(txt)) return 'next';
  if (hasBtnItems && (hasBuffIds || isCanSelect)) return 'buff';
  if (hasBtnItems && hasSelectTask) return 'task';
  if (/走位|躲避|加血|复活|\d+秒|血量|BOSS|boss/.test(txt)) return 'combat';
  if (/加入|开始|进入|队伍|报名/.test(txt)) return 'join';
  return 'unknown';
}

// ============================================================================
//  CDP 连接（自动探测游戏页：9333 Edge 优先，其次 9222 Electron）
// ============================================================================
async function connectGame() {
  for (const port of [9333, 9222]) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const cdp = await new CDP(v.webSocketDebuggerUrl).connect();
      const list = await cdp.send('Target.getTargets');
      const t = (list.targetInfos || []).find(t => t.type === 'page' && /ggsl-res\.hortorgames\.com/.test(t.url || ''));
      if (!t) { cdp.close(); continue; }
      const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, att.sessionId).catch(() => {});
      await cdp.send('Page.enable', {}, att.sessionId).catch(() => {});
      log(`已连上游戏页 @ :${port} (${t.url.slice(0, 60)}…)`);
      return { cdp, sessionId: att.sessionId, port };
    } catch (e) { /* try next */ }
  }
  return null;
}

// 带超时+重试的页面执行
async function makeEval(cdp, sessionId) {
  return async function ev(expr, awaitPromise = false, tries = 2) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await Promise.race([
          cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), 15000)),
        ]);
        if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result.value;
      } catch (e) {
        if (i === tries - 1) throw e;
        await sleep(300);
      }
    }
  };
}

// 按节点名点击（自动换算世界坐标 → 视口坐标，最稳）
async function clickNode(cdp, sessionId, name, nth = 0) {
  const pos = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      var found=[];
      (function walk(n){ if(!n) return; if(n.name===${(() => JSON.stringify(name))()}) found.push(n); (n.children||[]).forEach(walk); })(cc.director.getScene());
      var n=found[${nth}];
      if(!n) return {ok:false,count:found.length};
      var wp=n.convertToWorldSpaceAR(cc.v2(0,0));
      var c=document.querySelector('canvas'); if(!c) return {ok:false,msg:'no canvas'};
      var r=c.getBoundingClientRect();
      var dw=cc.view.getDesignResolutionSize().width, dh=cc.view.getDesignResolutionSize().height;
      var sx=r.left + wp.x*r.width/dw;
      var sy=r.top + (dh-wp.y)*r.height/dh;
      return {ok:true,sx:sx,sy:sy,w:n.width,h:n.height,active:n.activeInHierarchy!==false,label:(n.getComponent&&n.getComponent(cc.Label)&&n.getComponent(cc.Label).string)||''};
    })()`,
    returnByValue: true,
  }, sessionId).then(r => r.result.value).catch(() => ({ ok: false, msg: 'eval fail' }));
  if (!pos || !pos.ok) return { ok: false, reason: pos && pos.msg || 'node not found', count: pos && pos.count };
  if (!pos.active) return { ok: false, reason: 'inactive' };
  const x = Math.round(pos.sx), y = Math.round(pos.sy);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  return { ok: true, x, y, label: pos.label };
}

// 按正则匹配「可见按钮/标签」点击（用于 加入/下一关/闪避/大招 等无固定节点名的情况）
async function clickByLabel(cdp, sessionId, reSrc, limit = 1) {
  const re = reSrc;
  const hit = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      var want=${re}.source; var rx=new RegExp(want);
      var found=[];
      (function walk(n,d){ if(!n||d>10||found.length>=20) return;
        try{ var L=n.getComponent&&n.getComponent(cc.Label); if(L&&L.string&&rx.test(L.string)&&n.activeInHierarchy!==false){ found.push({name:n.name,label:L.string,depth:d}); } }catch(e){}
        (n.children||[]).forEach(function(c){walk(c,d+1);});
      })(cc.director.getScene(),0);
      return JSON.stringify(found.slice(0,${limit}));
    })()`,
    returnByValue: true,
  }, sessionId).then(r => r.result.value).catch(() => '[]');
  const arr = JSON.parse(hit || '[]');
  if (!arr.length) return { ok: false, reason: 'no label match ' + re };
  // 点击第一个匹配（通常是按钮）
  const tgt = arr[0];
  const res = await clickNode(cdp, sessionId, tgt.name);
  return res.ok ? { ok: true, label: tgt.label, x: res.x, y: res.y } : { ok: false, reason: 'click failed', detail: res };
}

// ============================================================================
//  地下城现场探测 + 动作
// ============================================================================

// 注入一次性的 BoBoMaster 访问器（幂等）
const HELPERS = `(function(){
  if(window.__DBM) return 'already';
  window.__DBM = {
    mgr: function(){ try{ return window.__require('LiveBoBoMasterMgr').default; }catch(e){ return null; } },
    player: function(){
      var sc=cc.director.getScene(); var me=null;
      (function walk(n,d){ if(!n||me||d>8) return; if(n.getComponent&&n.getComponent('LiveBoBoMasterPlayer')){ me=n.getComponent('LiveBoBoMasterPlayer'); } (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
      return me;
    },
    boss: function(){
      var sc=cc.director.getScene(); var b=null;
      (function walk(n,d){ if(!n||b||d>8) return; if(n.getComponent&&(n.getComponent('LiveBoBoMasterBossInfo')||n.getComponent('ComBoBoMasterBossSkin'))){ b=n; } (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
      return b;
    }
  };
  return 'ok';
})()`;

// 探测当前阶段 + 战斗状态 + 控制点发现
async function probe(ev) {
  return ev(`(function(){
    var sc=cc.director.getScene(); if(!sc) return JSON.stringify({phase:'none'});
    var labels=[], hasBtnItems=false, isCanSelect=false, hasBuffIds=false, hasSelectTask=false, hasStart=false, hasDifficulty=false;
    var startActive=false, hasNextBtn=false, bossWarn=false, mstate='?', dodgeBtns=[], skillBtns=[];
    (function walk(n,d){
      if(!n||d>10) return;
      if(n.name==='btn_start'){ hasStart=true; if(n.activeInHierarchy!==false) startActive=true; }
      if(n.btn_items&&n.btn_items.length) hasBtnItems=true;
      if(n.buffIds&&n.buffIds.length) hasBuffIds=true;
      if(typeof n.selectTask==='function') hasSelectTask=true;
      if(n.isCanSelect!==undefined) isCanSelect=n.isCanSelect;
      // 真实「下一关/继续」按钮：必须是可点的 cc.Label 节点（排除说明性 RichText 噪声）
      try{ var L=n.getComponent&&n.getComponent(cc.Label); if(L&&L.string&&n.activeInHierarchy!==false&&/下一关|继续|重开|再来|挑战成功|本关完成|胜利/.test(L.string)) hasNextBtn=true; }catch(e){}
      try{ var cs=n.getComponents(cc.Label); cs.forEach(function(L){ if(L.string){ var s=String(L.string); labels.push(s); } }); }catch(e){}
      // 仅把真正的 BOSS 预警词算作 bossWarn（避开说明性文案里的「走位躲避」）
      try{ var cs2=n.getComponents(cc.Label); cs2.forEach(function(L){ if(L.string&&/预警|蓄力|即将|释放技能|危险|注意/.test(L.string)) bossWarn=true; }); }catch(e){}
      // 捕获 RichText（难度名等以 RichText 渲染，普通 cc.Label 抓不到）
      try{ var rt=n.getComponent&&n.getComponent(cc.RichText); if(rt&&rt.string){ var rs=String(rt.string).replace(/<[^>]+>/g,''); labels.push(rs); if(/选择难度|选择增溢|普通|精英|困难|A,B,C/.test(rs)) hasDifficulty=true; } }catch(e){}
      // 收集可能的「闪避/大招/技能」按钮（按标签文本）
      var txt=''; try{ var Lx=n.getComponent&&n.getComponent(cc.Label); if(Lx&&Lx.string) txt=String(Lx.string);}catch(e){}
      if(txt){ if(/闪避|躲避|走位|闪/.test(txt)) dodgeBtns.push(txt); if(/大招|技能|释放|必杀|奥义/.test(txt)) skillBtns.push(txt); }
      (n.children||[]).forEach(function(c){walk(c,d+1);});
    })(sc,0);
    try{ var M=window.__require('LiveBoBoMasterMgr'); if(M&&M.default){ mstate=M.default.state; } }catch(e){}

    // 玩家状态（真实战斗单位组件）
    var st={hp:0,maxHp:1,dead:false,lv:0,skillReady:false};
    try{ var M2=window.__require('LiveBoBoMasterMgr'); if(M2&&M2.default){ st.lv=M2.default.lv||0; } }catch(e){}
    var me=null;
    (function walk(n,d){ if(!n||me||d>8) return; if(n.getComponent&&n.getComponent('LiveBoBoMasterPlayer')){ me=n.getComponent('LiveBoBoMasterPlayer'); } (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
    var hasMe=!!me;
    if(me){ try{ st.hp=me.hp||0; st.maxHp=me.maxHp||1;
      var DS=window.__require('LiveBoBoMasterPlayerState'); st.dead=(me.state!==undefined&&DS&&me.state===DS.Die);
      if(me.skillReady!==undefined) st.skillReady=!!me.skillReady;
      else if(me.cd!==undefined) st.skillReady=(me.cd<=0);
      else if(me.cooldown!==undefined) st.skillReady=(me.cooldown<=0);
    }catch(e){} }

    // ===== 阶段判定：结构化信号优先，避免说明性文案干扰 =====
    // 关键：btn_start 在「真正大厅(state=1)」与「战斗流程中的 st=4 等瞬态」都会出现且可点；
    // 只有 mstate===1 才是真正需要点「加入/开始」的大厅，其余瞬态一律不点（游戏会自动推进）。
    var phase='unknown';
    if(hasBtnItems&&(hasBuffIds||isCanSelect)) phase='buff';          // 增益选择（结构化字段）
    else if(hasBtnItems&&hasSelectTask) phase='task';                 // 任务/BOSS 选择（结构化字段）
    else if(hasNextBtn) phase='next';                                // 通关/下一关卡可点按钮
    else if(startActive && mstate===1) phase='join';                 // 仅真正大厅(state=1)：点 加入/开始
    else if(hasMe) phase='combat';                                   // 场景里真有玩家战斗单位 → 战斗
    else if(hasDifficulty) phase='difficulty';                       // 难度屏（底层自动推进）→ 只存活
    // 调试信息（不影响判定）
    return JSON.stringify({phase:phase,mstate:mstate,startActive:startActive,hasNextBtn:hasNextBtn,hasMe:hasMe,hasDifficulty:hasDifficulty,labels:labels.slice(0,40),bossWarn:bossWarn,dodgeBtns:dodgeBtns,skillBtns:skillBtns,st:st});
  })()`).then(JSON.parse).catch(e => ({ phase: 'error', err: String(e && e.message || e) }));
}

// 选增益
async function pickBuff(ev) {
  const info = await ev(`(function(){
    var sc=cc.director.getScene(); var comp=null;
    (function walk(n,d){ if(!n||comp||d>8) return; if(n.btn_items&&n.btn_items.length&&n.buffIds){comp=n;} (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
    if(!comp) return null;
    var CFGb=(window.__require('config')&&window.__require('config').BoboMonsterBuff);
    var ids=comp.buffIds.map(function(x){return x;});
    var names=ids.map(function(id){ try{ return CFGb.getById(id).name||('b'+id); }catch(e){ return 'b'+id; } });
    var descs=(comp.lab_decs||[]).map(function(L){ return (L&&L.string)?L.string:''; });
    return JSON.stringify({ids:ids,names:names,descs:descs,canSelect:comp.isCanSelect,n:comp.btn_items.length});
  })()`).then(JSON.parse).catch(() => null);
  if (!info || !info.canSelect) return;
  const { best, grades } = scoreBuffByIds(info.ids, info.names, info.descs);
  await ev(`(function(){
    var sc=cc.director.getScene(); var comp=null;
    (function walk(n,d){ if(!n||comp||d>8) return; if(n.btn_items&&n.btn_items.length&&n.buffIds){comp=n;} (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
    if(comp&&comp.isCanSelect) comp.selectBuff(${best});
  })()`).catch(() => {});
  const opts = (info.ids || []).map((id, i) => {
    const b = BUFF_TABLE[String(id)];
    return (b ? b.name : (info.names && info.names[i]) || ('b' + id)) + '·' + grades[i];
  });
  log('  [选增益·最高品质] 可选[' + opts.join(' | ') + '] → 选 #' + best + '「' + (opts[best] || '?') + '」');
}

// 选任务/BOSS
async function pickTask(ev) {
  const info = await ev(`(function(){
    var sc=cc.director.getScene(); var comp=null;
    (function walk(n,d){ if(!n||comp||d>8) return; if(n.btn_items&&n.btn_items.length&&typeof n.selectTask==='function'){comp=n;} (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
    if(!comp) return null;
    var ids=comp.taskIds?comp.taskIds.map(function(x){return x;}):[];
    return JSON.stringify({ids:ids,n:comp.btn_items.length,canSelect:comp.isCanSelect});
  })()`).then(JSON.parse).catch(() => null);
  if (!info) return;
  const pick = 0; // 默认首个任务（如需按难度/奖励择优，在此改 heuristic）
  await ev(`(function(){
    var sc=cc.director.getScene(); var comp=null;
    (function walk(n,d){ if(!n||comp||d>8) return; if(n.btn_items&&n.btn_items.length&&typeof n.selectTask==='function'){comp=n;} (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
    if(comp) comp.selectTask(${pick});
  })()`).catch(() => {});
  log('  [选任务/BOSS] 任务数=' + (info.ids ? info.ids.length : 0) + ' → 选 #' + pick);
}

// 发弹幕（本地 ClientEventMgr 注入，等价于服务端弹幕，作用于本机权威实例）
async function emitDanmaku(ev, info, roomId, uid, name) {
  await ev(`(function(){
    var C=window.__require('ClientEventMgr').default;
    C.emit('liveBaseData',{roomId:${JSON.stringify(String(roomId))},action:'Comment',uid:${JSON.stringify(String(uid))},name:${JSON.stringify(name)},info:${JSON.stringify(info)}});
  })()`).catch(() => {});
}

// 让「其他号」加入当前队伍（注入 gamePlayers + playerMems（游戏真正读取的入队表）+ 各号发「加入」弹幕）
async function injectOthers(ev, roomId, uid, name, others) {
  const ins = others.map(o =>
    `M.gamePlayers.set(String(${JSON.stringify(String(o.uid))}), {suid:String(${JSON.stringify(String(o.uid))}), name:${JSON.stringify(o.name)}});` +
    `if(M.playerMems) M.playerMems.set(String(${JSON.stringify(String(o.uid))}), {suid:String(${JSON.stringify(String(o.uid))}), name:${JSON.stringify(o.name)}});`
  ).join('\n  ');
  await ev(`(function(){
    var M=window.__require('LiveBoBoMasterMgr').default;
    M.gamePlayers.set(String(${JSON.stringify(String(uid))}), {suid:String(${JSON.stringify(String(uid))}), name:${JSON.stringify(name)}});
    if(M.playerMems) M.playerMems.set(String(${JSON.stringify(String(uid))}), {suid:String(${JSON.stringify(String(uid))}), name:${JSON.stringify(name)}});
    ${ins}
    return M.gamePlayers.size;
  })()`).catch(() => {});
  await emitDanmaku(ev, '加入', roomId, uid, name);
  for (const o of others) await emitDanmaku(ev, '加入', roomId, o.uid, o.name);
}

// 用「助手」里 bili-relation-manager 的真实已登录账号，向直播间发「加入」弹幕，
// 让这些真实账号作为队友进入地下城（与真人观众发弹幕加入机制完全一致，非伪造 uid）。
async function joinOthersViaDanmaku(roomId, msg = '加入', accsOverride = null) {
  const accs = accsOverride || loadBrmAccounts();
  if (!accs.length) { log('  [加入] 助手里没有可发弹幕的真实账号'); return 0; }
  let ok = 0;
  for (const acc of accs) {
    try {
      const c = {};
      String(acc.cookie || '').split(';').forEach(p => {
        const i = p.indexOf('=');
        if (i > 0) { const k = p.slice(0, i).trim(); if (k) c[k] = p.slice(i + 1).trim(); }
      });
      const body = new URLSearchParams({
        bubble: '0', msg, roomid: String(roomId), rnd: String(Date.now()),
        color: '16777215', mode: '1', jump: '0', fontsize: '25',
        csrf: c.bili_jct || '', csrf_token: c.bili_jct || '',
      });
      const cookie = Object.entries(c).map(([k, v]) => k + '=' + v).join('; ');
      const r = await fetch('https://api.live.bilibili.com/msg/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie, 'Referer': 'https://live.bilibili.com/' + roomId, 'User-Agent': 'Mozilla/5.0' },
        body: body.toString(),
      });
      const j = await r.json().catch(() => null);
      if (j && j.code === 0) ok++;
      else log('  [加入] ' + (acc.uname || acc.uid) + ' 失败: ' + JSON.stringify(j && (j.message || j.code)));
    } catch (e) { log('  [加入] ' + (acc.uname || acc.uid) + ' 异常: ' + e.message); }
    await sleep(700);
  }
  log('  [加入] 助手真实号已发「' + msg + '」弹幕：成功 ' + ok + '/' + accs.length + ' 个');
  return ok;
}

// 自愈：读取当前 gamePlayers，若有助手真实号掉线（回合重置/被踢），只补发缺失的「加入」，不重复轰炸
async function joinMissingViaDanmaku(ev, roomId, msg = '加入') {
  const accs = loadBrmAccounts();
  if (!accs.length) return 0;
  let gpKeys = [];
  try {
    gpKeys = await ev(`(function(){try{var M=window.__require('LiveBoBoMasterMgr').default;return M.gamePlayers?Array.from(M.gamePlayers.keys()):[];}catch(e){return [];}})()`) || [];
  } catch (e) {}
  const gpSet = new Set((gpKeys || []).map(String));
  const missing = accs.filter(a => !gpSet.has(String(a.uid)));
  if (!missing.length) return 0;
  log('  [加入] 自愈：' + missing.length + '/' + accs.length + ' 个助手号不在场 → ' + missing.map(a => a.uname || a.uid).join('、'));
  return await joinOthersViaDanmaku(roomId, msg, missing);
}

// 准备开局：预置起始关（best-effort）。真正开局交给主循环点 btn_start；
// 5 个真实号由主循环 join 阶段发「加入」弹幕入驻（不再伪造 gamePlayers）。
async function setupMatch(ev, cdp, sessionId, startLv, others, roomId, uid, name) {
  const brmN = loadBrmAccounts().length;
  log('▶ 准备开局：起始关卡=' + (startLv || '默认(1)') + (brmN ? '，助手真实号=' + brmN + ' 个（将在 join 阶段发「加入」弹幕入队）' : ''));
  // 预置起始关：在干净的 state1 上设 M.lv，开局时由游戏推导对应 conf（而非 gameSetUp 重置，后者会带歪状态机）
  if (startLv) {
    await ev(`(function(){ var M=window.__require('LiveBoBoMasterMgr').default; M.lv=${startLv}; })()`).catch(() => {});
    log('  [起始关] 已预置 M.lv=' + startLv + '（开局后由游戏推导对应关卡配置；若游戏忽略则仍从 1 开始）');
  }
  // 立即让 5 个助手真实号发「加入」入队（防止游戏在导演进入 join 阶段前就已自动开局而漏掉）
  await sleep(1500);
  await joinMissingViaDanmaku(ev, roomId, '加入');
  // 后续由主循环 join 阶段点击 btn_start 自然开局；主循环也会周期性自愈补号
}

// 是否为地下城场景（BoBo Master）
async function isDungeonScene(ev) {
  return ev(`(function(){
    try { if (!(window.__require && window.__require('LiveBoBoMasterMgr'))) return false; } catch(e){ return false; }
    var sc=cc.director.getScene(); if(!sc) return false;
    var hit=false;
    (function walk(n,d){ if(!n||hit||d>8) return; if(/bobo|BoBo|地下城/i.test(n.name||'')) hit=true; (n.children||[]).forEach(function(c){walk(c,d+1);}); })(sc,0);
    return hit; // mgr 存在 + 场景含 bobo/地下城 节点才视为地下城
  })()`).then(v => !!v).catch(() => false);
}

// 确保当前页处于地下城场景：若非地下城，则贴上凭据并本地 loadGame('res/livegames/game_bobo_master')
async function ensureDungeonScene(ctx) {
  const ok = await isDungeonScene(ctx.ev);
  if (ok) { log('✔ 当前已是地下城场景'); return true; }
  log('当前非地下城场景，尝试本地加载 game_bobo_master …');
  let creds = null;
  try { creds = JSON.parse(fs.readFileSync('win0_creds.json', 'utf8')); } catch (e) {}
  const r = await ctx.ev(`(function(){
    try {
      var req = (n) => { try { var m = window.__require(n); return m && (m.default || m); } catch(e){ return null; } };
      var M = req('LiveBliSdkMgr');
      if (M && ${JSON.stringify(creds || null)}) {
        M.GameId=${JSON.stringify(creds ? creds.GameId : '')}; M.RoomId=${JSON.stringify(creds ? creds.RoomId : '')};
        M.AppId=${JSON.stringify(creds ? creds.AppId : '')}; M.Version=${JSON.stringify(creds ? creds.Version : '')};
        M.Code=${JSON.stringify(creds ? creds.Code : '')}; M.auth_body=${JSON.stringify(creds ? creds.auth_body : '')};
        M.WSS=${JSON.stringify(creds ? creds.WSS : '')}; M.IsHttps=${JSON.stringify(creds ? creds.IsHttps : '')}; M.isRun=true;
        var LS = req('LoginService'); if (LS && LS.authUser) LS.authUser=function(){return Promise.resolve({code:0});};
      }
      var L=req('LiveCtl'); var ins=L&&(L.default||L).ins;
      if(ins&&ins.loadGame){ ins.loadGame('res/livegames/game_bobo_master'); return 'loading'; }
      return 'no_loadGame';
    } catch(e){ return 'err:'+e.message; }
  })()`).catch(e => 'exc:' + e.message);
  log('  loadGame 结果: ' + JSON.stringify(r));
  await sleep(3000);
  const ok2 = await isDungeonScene(ctx.ev);
  if (!ok2) log('  ⚠️ 未能切换到地下城场景，请先运行 win0_enter.js 完成认证，再重跑本脚本');
  return ok2;
}

// ============================================================================
//  主循环
// ============================================================================
let dungeonLv = 0;
let joined = false;
let joinStarted = false;   // 已发起「加入/开始」点击，避免后续轮次重复点 btn_start
let discovered = { dodge: null, skill: null };
let lastDodgeAt = 0, lastSkillAt = 0;

async function combatTick(ctx, roomId, uid, name) {
  const ev = ctx.ev;
  const p = await probe(ev);
  if (!p || p.phase === 'error') return p;
  if (p.st && p.st.lv) dungeonLv = p.st.lv;
  if (dungeonLv % 10 === 0 && dungeonLv !== 0) log('  🏯 进度：第 ' + dungeonLv + ' 关（目标 ' + TARGET_LEVEL + '）');

  // 死亡 → 复活
  if (p.st && p.st.dead) {
    await emitDanmaku(ev, '复活', roomId, uid, name);
    log('  [战斗] 死亡 → 复活(耗10金)');
    return p;
  }
  // 低血 → 加血
  const pct = p.st ? p.st.hp / p.st.maxHp : 1;
  if (pct < 0.4) {
    await emitDanmaku(ev, '加血', roomId, uid, name);
    log('  [战斗] HP=' + (pct * 100).toFixed(0) + '% → 加血(耗3金)');
  }

  // ---- 闪避：BOSS 技能预警时 ----
  if (p.bossWarn && Date.now() - lastDodgeAt > 1500) {
    let done = null;
    if (discovered.dodge) done = await clickNode(ctx.cdp, ctx.sessionId, discovered.dodge).catch(() => null);
    if (!done || !done.ok) {
      // 降级：按标签点「闪避/躲避」
      const r = await clickByLabel(ctx.cdp, ctx.sessionId, /闪避|躲避|走位|闪/).catch(() => ({ ok: false }));
      if (r.ok) { discovered.dodge = r.label ? null : discovered.dodge; done = r; }
    }
    if (done && done.ok) { lastDodgeAt = Date.now(); log('  [闪避] 触发（BOSS 预警）→ 点击 @' + (done.x + ',' + done.y) + (done.label ? ' ' + done.label : '')); }
    else { lastDodgeAt = Date.now(); log('  [闪避] 检测到预警，但未发现可点击的闪避控件（已降级跳过，请回报 UI 文字以校准）'); }
  }

  // ---- 大招：技能就绪时 ----
  if (p.st && p.st.skillReady && Date.now() - lastSkillAt > 3000) {
    let done = null;
    if (discovered.skill) done = await clickNode(ctx.cdp, ctx.sessionId, discovered.skill).catch(() => null);
    if (!done || !done.ok) {
      const r = await clickByLabel(ctx.cdp, ctx.sessionId, /大招|技能|释放|必杀|奥义/).catch(() => ({ ok: false }));
      if (r.ok) done = r;
    }
    if (done && done.ok) { lastSkillAt = Date.now(); log('  [大招] 技能就绪 → 释放 @' + (done.x + ',' + done.y) + (done.label ? ' ' + done.label : '')); }
    else { lastSkillAt = Date.now(); log('  [大招] 技能就绪，但未发现可点击的技能控件（已降级跳过，请回报 UI 文字以校准）'); }
  }
  return p;
}

async function main() {
  const g = await connectGame();
  if (!g) {
    log('❌ 连不上游戏页。请先：');
    log('   1) 打开 Edge 并进入身份码 BJSPTSVR93B43 的直播间游戏（远程调试端口 9333 或 9222 需开启）');
    log('   2) 确认游戏页 url 含 ggsl-res.hortorgames.com');
    log('   然后重跑：node dungeon_conquer.js');
    process.exit(1);
  }
  const ev = await makeEval(g.cdp, g.sessionId);
  const ctx = { ev, cdp: g.cdp, sessionId: g.sessionId };
  await ev(HELPERS);

  // 确保处于地下城场景（必要时自动 loadGame）
  const sceneOk = await ensureDungeonScene(ctx);
  if (!sceneOk) { log('❌ 无法进入地下城场景，退出'); process.exit(1); }

  // 取房间/主播信息（用于发弹幕）
  const meta = await ev(`(function(){
    try{ var M=window.__require('LiveBliSdkMgr').default; return JSON.stringify({roomId:M.RoomId, uid:M.uid||M.Uid||0, name:M.uname||M.Uname||'导演'}); }catch(e){ return JSON.stringify({roomId:0,uid:0,name:'导演'}); }
  })()`).then(JSON.parse).catch(() => ({ roomId: 0, uid: 0, name: '导演' }));
  const roomId = meta.roomId || (require('./win0_creds.json').RoomId);
  const uid = meta.uid || 4313119220966037;
  const name = meta.name || '导演';
  const brmCount = loadBrmAccounts().length;
  log('房间=' + roomId + ' 主播uid=' + uid + ' 目标关卡=' + TARGET_LEVEL + (START_LV ? ' 起始关=' + START_LV : '') + ' 助手真实号=' + brmCount + ' 个');

  // 若指定起始关，则预先写入 M.lv 并注入其他号；真正的「加入/开始」仍由主循环在首次进入大厅(mstate=1)时统一处理
  if (START_LV && START_LV > 0) {
    await setupMatch(ev, g.cdp, g.sessionId, START_LV, OTHERS, roomId, uid, name);
  }

  let lastPhase = '';
  let loops = 0;
  while (true) {
    const p = await probe(ev);
    if (!p || p.phase === 'error') { log('  ⚠️ 探测异常: ' + (p && p.err)); await sleep(POLL_MS); continue; }
    if (p.st && p.st.lv) dungeonLv = Math.max(dungeonLv, p.st.lv);
    if (dungeonLv >= TARGET_LEVEL) { log('  🎉 已攻克第 ' + TARGET_LEVEL + ' 关（当前第 ' + dungeonLv + ' 关），导演收工'); break; }
    if (p.phase !== lastPhase) {
      const dbg = (p.mstate !== undefined ? ' state=' + p.mstate : '') + (p.startActive ? ' start✓' : '') + (p.hasMe ? ' me✓' : '') + (p.hasNextBtn ? ' nextBtn✓' : '');
      log('  ▶ 阶段=' + p.phase + dbg + (p.labels && p.labels.length ? ' | ' + p.labels.slice(0, 6).join('/') : ''));
      lastPhase = p.phase;
    }

    if (DRY) { await sleep(POLL_MS); continue; }

    try {
      if (p.phase === 'join') {
        // 真正大厅(mstate===1)才到这里。处理「首次开局」与「回合重置后续爬」两种情况。
        if (!joined) {
          if (START_LV > 0) {
            await ev(`(function(){ var M=window.__require('LiveBoBoMasterMgr').default; M.lv=${START_LV}; })()`).catch(() => {});
            log('  [加入] 首次开局，起始关=' + START_LV);
          } else {
            log('  [加入] 首次开局（未指定起始关，按游戏当前关）');
          }
          joined = true;
        } else {
          const resumeLv = Math.max(START_LV, dungeonLv);
          await ev(`(function(){ var M=window.__require('LiveBoBoMasterMgr').default; M.lv=${resumeLv}; })()`).catch(() => {});
          log('  [加入] 回合重置后续爬 @ 第' + resumeLv + '关（已到达第' + dungeonLv + '关）');
        }
        // btn_start 无文字标签，按节点名点（#0=加入/开始，可点；#1 多数情况下 inactive）。#0 每轮可重复按（幂等），#1 仅首次按一次。
        const c0 = await clickNode(g.cdp, g.sessionId, 'btn_start', 0);
        if (c0.ok) log('  [加入] btn_start#0 @' + c0.x + ',' + c0.y);
        await sleep(1000);
        // 关键：用「助手」里 5 个真实账号向直播间发「加入」弹幕，让它们作为队友真正入驻（与真人观众一致，非伪造 uid）
        await joinOthersViaDanmaku(roomId, '加入');
        if (!joinStarted) {
          const c1 = await clickNode(g.cdp, g.sessionId, 'btn_start', 1);
          if (c1.ok) log('  [加入] btn_start#1 @' + c1.x + ',' + c1.y);
          joinStarted = true;
        }
        await sleep(1200);
      } else if (p.phase === 'difficulty') {
        // 难度选择屏（普通/精英/困难 A/B/C）：底层会自动清关推进，导演只存活、不瞎点（实测 emit A/B/C 无效）
        await sleep(POLL_MS);
      } else if (p.phase === 'unknown') {
        await sleep(POLL_MS);
      } else if (p.phase === 'buff') {
        await pickBuff(ev);
      } else if (p.phase === 'task') {
        await pickTask(ev);
      } else if (p.phase === 'combat') {
        await combatTick(ctx, roomId, uid, name);
      } else if (p.phase === 'next') {
        const r = await clickByLabel(g.cdp, g.sessionId, /下一关|继续|重开|再来|通关|挑战/).catch(() => ({ ok: false }));
        if (r.ok) log('  🔁 进入下一关' + (r.label ? '（' + r.label + '）' : ''));
        else log('  🔁 通关屏未识别到按钮，重试中…');
        await sleep(1500);
        if (dungeonLv >= TARGET_LEVEL) { log('  🎉 已达目标关卡 ' + TARGET_LEVEL + '，导演收工'); break; }
      }
    } catch (e) {
      log('  ⚠️ 本回合出错: ' + e.message);
    }
    // 自愈：每隔 ~20 轮（约24s）检查 5 个助手真实号是否仍在场，掉线则补发「加入」
    if (++loops % 20 === 0) await joinMissingViaDanmaku(ev, roomId).catch(() => {});
    await sleep(REACT_MS);
    await sleep(POLL_MS - REACT_MS > 0 ? POLL_MS - REACT_MS : 400);
  }
  g.cdp.close();
}

// ============================================================================
//  Self-test（不连游戏，验证决策逻辑）
// ============================================================================
function selftest() {
  log('=== SELFTEST：决策逻辑校验 ===');
  let ok = true;
  const assert = (c, m) => { if (!c) { ok = false; log('  ❌ ' + m); } else log('  ✅ ' + m); };

  // 1) BUFF 打分：攻击系应胜过防御系，防御系胜过资源系
  const s1 = scoreBuff(['烈焰斩', '铁壁护甲', '金币加成'], ['提升攻击伤害', '增加生命防御', '获得额外金币']);
  assert(s1.best === 0, '攻击增益优先 (best=' + s1.best + ')');
  const s2 = scoreBuff(['生命护盾', '急速移动'], ['提升生命上限', '增加移速']);
  assert(s2.best === 0, '生存增益优先于移速 (best=' + s2.best + ')');

  // 1b) BUFF 品质选择（用户要求：改到能修改的最高）：grade 绝对优先，同档比数值与攻击倾向
  const g1 = scoreBuffByIds([10042, 10013]);   // [加火攻·普通(值50), 加攻速·史诗(20%)]
  assert(g1.best === 1 && g1.grades[1] === '史诗', '品质优先：史诗加攻速 > 普通加火攻 (best=' + g1.best + ')');
  const g2 = scoreBuffByIds([10020, 10052]);   // [加魔抗·传说(50%), 加火攻·史诗(值200)]
  assert(g2.best === 0 && g2.grades[0] === '传说', '品质优先：传说加魔抗 > 史诗加火攻 (best=' + g2.best + ')');
  const g3 = scoreBuffByIds([10016, 10057]);   // [加防御·传说(50%), 加火攻·传说(值500)] 同档 → 攻类优先
  assert(g3.best === 1, '同档攻击倾向：传说加火攻 > 传说加防御 (best=' + g3.best + ')');
  const g4 = scoreBuffByIds([10001, 10006, 10011, 10016]); // 同类型四档：普通→稀有→史诗→传说
  assert(g4.best === 3 && g4.grades[3] === '传说', '同类型选最高档：传说 (best=' + g4.best + ')');
  const g5 = scoreBuffByIds([99999], ['未知攻击'], ['提升攻击伤害']);
  assert(g5.best === 0 && g5.grades[0] === '表外', '表外 id 不崩溃');
  assert(Object.keys(BUFF_TABLE).length === 60, 'BUFF 品质表共 60 条 (实际 ' + Object.keys(BUFF_TABLE).length + ')');

  // 2) 阶段判定
  assert(classifyPhase({ hasBtnItems: true, hasBuffIds: true, isCanSelect: true, hasSelectTask: false, labels: [] }) === 'buff', 'buff 阶段判定');
  assert(classifyPhase({ hasBtnItems: true, hasBuffIds: false, isCanSelect: false, hasSelectTask: true, labels: [] }) === 'task', 'task 阶段判定');
  assert(classifyPhase({ hasBtnItems: false, hasBuffIds: false, isCanSelect: false, hasSelectTask: false, labels: ['通关啦', '下一关'] }) === 'next', 'next 阶段判定');
  assert(classifyPhase({ hasBtnItems: false, hasBuffIds: false, isCanSelect: false, hasSelectTask: false, labels: ['加入队伍', '开始'] }) === 'join', 'join 阶段判定');

  // 3) 弹幕指令词表完整性
  ['报名', '加血', '复活'].forEach(c => assert(DANMU_CMDS.includes(c), '弹幕指令含「' + c + '」'));
  assert(!DANMU_CMDS.includes('闪避'), '确认「闪避」非弹幕指令（应为 UI 按钮）');
  assert(!DANMU_CMDS.includes('大招'), '确认「大招」非弹幕指令（应为 UI 按钮）');

  log(ok ? '=== SELFTEST 全部通过 ✅ ===' : '=== SELFTEST 存在失败 ❌ ===');
  process.exit(ok ? 0 : 1);
}

if (SELFTEST) selftest();
else main().catch(e => { log('FATAL ' + e.message); process.exit(1); });

// 优雅退出
process.on('SIGINT', () => { log('🛑 收到中断，导演退出'); process.exit(0); });
