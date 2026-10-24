'use strict';
// 弹幕狼人杀（我的粉丝里有鬼）游戏引擎
// 依据 rules/弹狼规则库.json 实现 20 个角色、昼夜流程、技能交互与胜负判定。
// 这是一个"逻辑模拟器"：AI 策略 + 角色规则在此跑完整局，用于测试板子/难度/观众机制并复盘。
// 说明：与真实 Cocos 画面一致的逻辑层；真实游戏画面操作由 autoplay2.js 负责（建房/加机器人/开局）。

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 角色元数据（技能细节见规则库）
const ROLE = {
  '女鬼':   { camp: 'evil', kill: 1, needRoom: true },
  '双面鬼': { camp: 'evil', kill: 2, needRoom: true },
  '单眼鬼': { camp: 'evil', kill: 3, needRoom: true, evenOnly: true },
  '鬼格格': { camp: 'evil', kill: 1, needRoom: false, ignoreProtect: true },
  '草鬼婆': { camp: 'evil', poison: true, needRoom: true },
  '九尾狐仙': { camp: 'evil', nineTail: true, needRoom: true },
  '狐狸':   { camp: 'evil', fox: true, needRoom: true },
  '鬼娃':   { camp: 'good', ghostOnRoomKill: true }, // 房间被鬼杀→变鬼
  '学生':   { camp: 'good' },
  '流浪汉': { camp: 'good', seer: true, needRoom: true },
  '花瓶妹': { camp: 'good', lives: 2 },
  '舔狗':   { camp: 'good', protect: true, needRoom: true },
  '妈宝男': { camp: 'good', revengeOnDeath: true },
  '鳌大人': { camp: 'good', dayExecute: true },
  '武林高手': { camp: 'good', shield: 0.5 },
  '乌鸦哥': { camp: 'good', falseSeer: true, poisonImmune: true },
  '醉鬼':   { camp: 'good', chaotic: true },
  '疯子':   { camp: 'good', chaotic: true },
  '狸猫':   { camp: 'good', reflectOnVote: true },
};

const RAT_LEVEL = {
  cute:   { per: 0.10, base: 0.30 },
  normal: { per: 0.15, base: 0.33 },
  crazy:  { per: 0.20, base: 0.36 },
};

function roomsOpen(alive) {
  if (alive >= 28) return ['A', 'B', 'C', 'D'];
  if (alive >= 18) return ['A', 'B', 'D'];
  return ['A', 'D'];
}

class Player {
  constructor(id, role) {
    this.id = id;
    this.name = '#' + id;
    this.role = role;
    this.camp = ROLE[role].camp;
    this.alive = true;
    this.location = 'hall';
    this.ratMarks = 0;            // 大厅红点 0~3
    this.lives = ROLE[role].lives || 1;
    this.poisoned = false;
    this.protectedTonight = false;
    this.shieldedTonight = false;
    this.nineTail = role === '九尾狐仙' ? 0 : 0;
    this.nineAwake = false;
    this.isAI = false;            // 是否由 AI 接管决策
    this.isFan = false;           // 是否粉丝牌观众（观众机制）
    this.lastVote = null;         // 昨天投了谁（妈宝男追轮用）
    this.knownGood = new Set();   // AI 知识：确认好人
    this.knownEvil = new Set();   // AI 知识：确认鬼
    this.suspicion = {};          // AI 推断：玩家ID→可疑度（同房间出过好人的人更可疑）
  }
}

class Game {
  constructor(config) {
    this.seed = config.seed || 1;
    this.rng = mulberry32(this.seed);
    this.board = config.board.slice();           // 角色名数组（长度=人数）
    this.ratLevel = config.ratLevel || 'normal';  // cute/normal/crazy
    this.aiSeat = config.aiSeat ?? 0;             // 哪一号玩家由 AI 控制（host 视角）
    this.fanBadge = !!config.fanBadge;            // 是否要求粉丝牌才能算"真实玩家"
    this.log = [];
    this.day = 0;
    this.players = this.board.map((r, i) => {
      const p = new Player(i + 1, r);
      p.isAI = (i === this.aiSeat);
      p.isFan = config.fanList ? config.fanList[i] : (this.rng() < 0.6);
      return p;
    });
    // 角色数统计
    this.counts = {};
    this.board.forEach(r => this.counts[r] = (this.counts[r] || 0) + 1);
  }

  rnd(n) { return Math.floor(this.rng() * n); }
  pick(arr) { return arr[this.rnd(arr.length)]; }
  alive(filter) { return this.players.filter(p => p.alive && (!filter || filter(p))); }
  evilAlive() { return this.alive(p => p.camp === 'evil'); }
  goodAlive() { return this.alive(p => p.camp === 'good'); }

  L(s) { this.log.push(s); }

  // 判定公开阵营（用于展示）：未觉醒九尾/狐狸=显示好人（金水）
  publicCamp(p) {
    if (p.role === '狐狸' && this.foxActive()) return 'evil';
    if (p.role === '九尾狐仙' && p.nineAwake) return 'evil';
    return p.camp;
  }

  foxActive() {
    // 场上除草鬼婆外还有其他鬼 → 狐狸不现身
    const others = this.alive(p => p.camp === 'evil' && p.role !== '狐狸' && p.role !== '草鬼婆');
    return others.length === 0;
  }

  checkWin() {
    const g = this.goodAlive().length, e = this.evilAlive().length;
    if (e === 0) return 'good';
    if (g === 0) return 'evil';
    return null;
  }

  // ---------- 选房阶段 ----------
  chooseLocations() {
    const open = roomsOpen(this.alive().length);
    for (const p of this.alive()) {
      if (p.camp === 'evil') {
        // 鬼一定进房开刀（鬼格格大厅也能刀，但默认进房）
        p.location = this.pick(open);
      } else {
        // 好人：多数进房躲老鼠，部分留大厅（测试老鼠机制）
        p.location = (this.rng() < 0.78) ? this.pick(open) : 'hall';
      }
      if (p.location !== 'hall') p.ratMarks = 0; // 进房清红点
    }
  }

  // ---------- 夜晚结算 ----------
  night() {
    this.day += 1;
    const open = roomsOpen(this.alive().length);
    const night = this.day;
    this.nightDeaths = [];
    this.L(`\n【第${this.day}天 夜晚】 存活 ${this.alive().length} 人，开门 ${open.join('/')}`);

    // 1) 草鬼婆下蛊（先手）
    for (const p of this.alive(p => p.role === '草鬼婆')) {
      const room = this.alive(q => q !== p && q.location === p.location && !(ROLE[q.role].poisonImmune));
      if (room.length && p.location !== 'hall') {
        const t = this.pick(room);
        t.poisoned = true;
        this.L(`  草鬼婆 给 ${t.name}(${t.role}) 下蛊`);
      }
    }

    // 2) 流浪汉查验
    for (const p of this.alive(p => p.role === '流浪汉')) {
      if (p.location === 'hall') continue;
      const room = this.alive(q => q !== p && q.location === p.location);
      if (!room.length) continue;
      const t = this.pick(room);
      let res = (this.publicCamp(t) === 'evil') ? '查杀' : '金水';
      if (t.role === '乌鸦哥') res = '查杀(误)';
      p.knownGood.add(t.id); p.knownEvil.delete(t.id);
      if (res.startsWith('查杀')) { p.knownEvil.add(t.id); p.knownGood.delete(t.id); }
      if (t.poisoned && p.role === '流浪汉') { t.poisoned = false; this.L(`  流浪汉 查验解掉 ${t.name} 的蛊`); }
      this.L(`  流浪汉 查验 ${t.name}(${t.role}) → ${res}`);
    }

    // 3) 舔狗保护
    for (const p of this.alive(p => p.role === '舔狗')) {
      if (p.location === 'hall') continue;
      const cand = this.alive(q => q.camp === 'good' && q !== p && q.location === p.location);
      if (cand.length) { const t = this.pick(cand); t.protectedTonight = true; }
    }

    // 4) 武林高手金钟罩
    for (const p of this.alive(p => p.role === '武林高手')) {
      if (p.poisoned) continue;
      const threatened = this.alive(q => q.camp === 'evil' && q.location === p.location).length > 0;
      if (threatened && this.rng() < ROLE['武林高手'].shield) p.shieldedTonight = true;
    }

    // 5) 鬼刀
    const deaths = []; // {target, by, kind}
    const killIn = (ghost, n) => {
      const pool = this.alive(q => q.camp === 'good' && q.location === ghost.location && q !== ghost);
      for (let k = 0; k < n && pool.length; k++) {
        const idx = this.rnd(pool.length);
        const t = pool.splice(idx, 1)[0];
        // 保护/金钟罩（鬼格格无视）
        if (!ROLE[ghost.role].ignoreProtect && (t.protectedTonight || t.shieldedTonight)) {
          this.L(`  ${t.name}(${t.role}) 被保护/金钟罩挡下 ${ghost.role} 的刀`);
          continue;
        }
        deaths.push({ target: t, by: ghost, kind: 'knife' });
        this.nightDeaths.push({ camp: t.camp, loc: ghost.location, by: ghost.role });
      }
    };
    for (const g of this.alive(p => p.camp === 'evil')) {
      if (g.role === '草鬼婆') continue;
      if (g.role === '狐狸' && !this.foxActive()) continue;
      if (g.role === '单眼鬼' && night % 2 === 1) continue; // 单数夜不开刀
      if (g.role === '九尾狐仙' && !g.nineAwake) continue;
      if (g.location === 'hall' && ROLE[g.role].needRoom) continue;
      const n = ROLE[g.role].kill || 1;
      killIn(g, n);
    }

    // 6) 结算夜间死亡（含角色交互）
    this.resolveDeaths(deaths, 'night');

    // 7) 老鼠（大厅）
    const rl = RAT_LEVEL[this.ratLevel];
    const hallGood = this.alive(p => p.camp === 'good' && p.location === 'hall');
    for (const p of hallGood) {
      const chance = Math.min(0.9, rl.base + p.ratMarks * rl.per);
      if (this.rng() < chance) {
        this.L(`  老鼠 咬死 ${p.name}(${p.role}) [红点${p.ratMarks}]`);
        this.killPlayer(p, 'rat');
        this.nightDeaths.push({ camp: 'good', loc: 'hall', by: 'rat' });
      } else {
        p.ratMarks = Math.min(3, p.ratMarks + 1);
      }
    }

    // 8) 九尾成长
    for (const p of this.alive(p => p.role === '九尾狐仙')) {
      p.nineTail += 1;
      if (p.nineTail >= 9 && !p.nineAwake) {
        p.nineAwake = true;
        this.L(`  【九尾狐仙 觉醒】${p.name} 集满9尾，觉醒！`);
      }
    }

    // 9) 中蛊者次日判定（简化：本局内每晚 50% 毒发）
    for (const p of this.alive(q => q.poisoned)) {
      if (this.rng() < 0.5) { this.L(`  ${p.name}(${p.role}) 蛊毒发作死亡`); this.killPlayer(p, 'poison'); }
    }

    // 怀疑度推断（所有存活玩家共用）：从"好人夜间死亡"反推同房间幸存者为可疑
    for (const ai of this.alive()) {
      for (const d of this.nightDeaths) {
        if (d.camp !== 'good') continue;
        for (const q of this.alive(x => x !== ai && !ai.knownGood.has(x.id) && x.location === d.loc)) {
          ai.suspicion[q.id] = (ai.suspicion[q.id] || 0) + 1;
        }
      }
    }

    const w = this.checkWin();
    if (w) this.L(`  ★ 夜晚结束即分胜负：${w === 'good' ? '好人' : '鬼'} 胜`);
    return w;
  }

  // 结算一批死亡（处理花瓶复活甲 / 鬼娃变节 / 妈宝男追轮）
  resolveDeaths(deaths, phase) {
    for (const d of deaths) {
      const t = d.target;
      if (!t.alive) continue;
      // 鬼娃：房间被非鬼格格鬼杀 → 变鬼（不死）
      if (t.role === '鬼娃' && d.kind === 'knife' && d.by.role !== '鬼格格' && t.location !== 'hall') {
        t.camp = 'evil';
        this.L(`  【鬼娃变节】${t.name} 在房间被 ${d.by.role} 杀死 → 加入鬼阵营！`);
        continue;
      }
      // 花瓶妹复活甲
      if (t.role === '花瓶妹' && t.lives > 1 && d.by.role !== '鬼格格' && d.by.role !== '鳌大人' && d.by.role !== '狐狸') {
        t.lives -= 1;
        this.L(`  【花瓶复活甲】${t.name} 抵挡一次死亡（剩 ${t.lives} 命）`);
        continue;
      }
      this.killPlayer(t, d.kind, d.by);
      // 妈宝男追轮
      if (t.role === '妈宝男' && t.lastVote) {
        const v = this.players.find(x => x.id === t.lastVote && x.alive);
        if (v) { this.L(`  【妈宝男追轮】带走 ${v.name}(${v.role})`); this.killPlayer(v, 'revenge'); }
      }
    }
  }

  killPlayer(p, kind, by) {
    if (!p.alive) return;
    p.alive = false;
    this.L(`  ✖ ${p.name}(${p.role}) 死亡 [${kind}]`);
  }

  // ---------- 白天 ----------
  day_phase() {
    // 鳌大人白天处决
    for (const p of this.alive(q => q.role === '鳌大人')) {
      const suspect = this.suspectFor(p);
      if (suspect) { this.L(`  【鳌大人】处决 ${suspect.name}(${suspect.role})`); this.killPlayer(suspect, 'execute'); }
    }
    let w = this.checkWin(); if (w) return w;

    // 投票
    const tally = {};
    for (const p of this.alive()) {
      const v = this.voteFor(p);
      if (v) { p.lastVote = v.id; tally[v.id] = (tally[v.id] || 0) + 1; }
    }
    let top = null, max = 0, tie = false;
    for (const id in tally) { if (tally[id] > max) { max = tally[id]; top = +id; tie = false; } else if (tally[id] === max) tie = true; }
    this.L(`  【投票】${JSON.stringify(tally)}`);
    if (!top || tie) { this.L(`  平票/无人上台，直接进入夜晚`); return null; }

    const stage = this.players.find(x => x.id === top);
    this.L(`  ${stage.name}(${stage.role}) 以 ${max} 票上台`);

    // 狸猫反射：上台被处决 → 反杀所有投他的人
    if (stage.role === '狸猫') {
      const voters = this.alive(x => x.lastVote === stage.id);
      this.L(`  【狸猫反伤】${stage.name} 亮明身份，反杀 ${voters.length} 名投票者`);
      voters.forEach(v => this.killPlayer(v, 'reflect'));
      stage.alive = false;
      this.L(`  ✖ ${stage.name}(狸猫) 亮明身份`);
      return this.checkWin();
    }

    // 审判 444 vs 666（观众弹幕，这里用 AI 策略模拟：已知鬼→444，否则看 suspicion）
    const verdict = this.trialVerdict(stage);
    this.L(`  【审判】${verdict === 'kill' ? '444 处死' : '666 放过'} ${stage.name}(${stage.role})`);
    if (verdict === 'kill') {
      this.resolveDeaths([{ target: stage, by: { role: 'trial' }, kind: 'trial' }], 'trial');
      // 花瓶妹投票复活
      for (const hp of this.alive(q => q.role === '花瓶妹' && q.lives > 1)) {
        const deadGood = this.players.find(x => !x.alive && x.camp === 'good' && x.role !== '花瓶妹' && hp.lastVote === x.id);
        if (deadGood) { deadGood.alive = true; hp.lives -= 1; this.L(`  【花瓶复活】${deadGood.name}(${deadGood.role}) 被复活（剩 ${hp.lives} 命）`); }
      }
    }
    return this.checkWin();
  }

  // ---- AI 策略（知识驱动）----
  suspectFor(p) {
    // 返回最可疑的（疑似鬼）玩家：先投已知鬼，否则投怀疑度最高的非已知好人
    const enemies = this.alive(q => q !== p && p.knownEvil.has(q.id));
    if (enemies.length) return this.pick(enemies);
    const cand = this.alive(q => q !== p && !p.knownGood.has(q.id));
    if (!cand.length) return null;
    const top = Math.max(...cand.map(q => p.suspicion[q.id] || 0));
    const topCand = cand.filter(q => (p.suspicion[q.id] || 0) >= top);
    return this.pick(topCand);
  }
  voteFor(p) {
    const enemies = this.alive(q => q !== p && p.knownEvil.has(q.id));
    if (enemies.length) return this.pick(enemies);
    const cand = this.alive(q => q !== p && !p.knownGood.has(q.id));
    if (!cand.length) return null;
    const top = Math.max(...cand.map(q => p.suspicion[q.id] || 0));
    const topCand = cand.filter(q => (p.suspicion[q.id] || 0) >= top);
    return this.pick(topCand);
  }
  trialVerdict(stage) {
    // 若某活人确认其为鬼 → 处死
    for (const p of this.alive()) if (p.knownEvil.has(stage.id)) return 'kill';
    return 'spare';
  }

  run(maxDays = 30) {
    this.L(`==== 开局：板子=${this.board.join('/')} 老鼠=${this.ratLevel} 粉丝牌门槛=${this.fanBadge} ====`);
    this.L(`角色分布：${JSON.stringify(this.counts)}`);
    let winner = null;
    while (this.day < maxDays) {
      const w1 = this.night();
      if (w1) { winner = w1; break; }
      const w2 = this.day_phase();
      if (w2) { winner = w2; break; }
      if (this.alive().length <= 1) break;
    }
    if (!winner) winner = this.checkWin() || (this.goodAlive().length >= this.evilAlive().length ? 'good' : 'evil');
    this.L(`\n==== 本局结束：胜利方 = ${winner === 'good' ? '好人阵营' : '鬼阵营'}（第${this.day}天，存活 ${this.alive().length}）====`);
    const ai = this.players[this.aiSeat];
    return {
      winner,
      days: this.day,
      survivors: this.alive().length,
      aiRole: ai.role,
      aiAlive: ai.alive,
      aiCamp: ai.camp,
      log: this.log,
    };
  }
}

module.exports = { Game, ROLE, roomsOpen, RAT_LEVEL };
