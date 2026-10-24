'use strict';
// src/evolve.js — 归类收集信息 + 自主进化引擎
//
// 干的事：
//  1) 每局结束把场上信息「归类」：每个玩家的角色、性格、票数、被指控次数、指控命中率、服装、
//     存活/出局；每条观众弹幕归入「归票/狡辩/提问/闲聊」类别并计数。
//  2) 把这些信息写进一个持久化知识库（JSON），跨对局、跨重启保留。
//  3) 「自主进化」：根据累积统计调整可调参数（性格信任度、服装偏好、归票/狡辩倾向），
//     下次对局导演/NPC/观众的行为就被「学」过的经验影响——比如某个性格的归票历史上准，
//     观众就更愿意跟它的票；某套服装出镜率高就多穿。
//  4) 对外暴露 advice()，导演每局开始前读取，把进化结果注入行为。
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = process.env.WOLF_KB
  || (process.env.USER_DATA_DIR ? path.join(process.env.USER_DATA_DIR, 'wolf-knowledge.json')
     : path.join(__dirname, '..', 'wolf-knowledge.json'));

class EvolutionEngine {
  constructor(opts = {}) {
    this.path = opts.path || DEFAULT_PATH;
    this.enabled = opts.enabled !== false;
    this.rounds = [];                                  // 历史对局原始数据
    this.kb = this._defaultKB();
    if (this.enabled) this.load();
  }

  _defaultKB() {
    return {
      version: 2,
      personaTrust: {},      // personaKey -> 信任度(初始1.0)；归票命中高 → 升，反之降
      personaAccuseCount: {}, // personaKey -> 发起归票次数
      personaDefendCount: {}, // personaKey -> 发起狡辩次数
      suitPopularity: {},    // suitName -> 出镜计数（用于服装偏好进化）
      keywordHits: { accuse: 0, defend: 0, question: 0, chatter: 0, reactWolf: 0, reactGood: 0 },
      stats: { rounds: 0, totalPlayers: 0, totalDeaths: 0, goodWin: 0, wolfWin: 0, audienceMsgs: 0, skillsUsed: 0 },
      learningRate: 0.18,
      lastEvolvedAt: 0,
    };
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        this.kb = Object.assign(this._defaultKB(), raw);
        this.rounds = Array.isArray(raw.__rounds) ? raw.__rounds : [];
      }
    } catch (e) { /* 损坏则重置 */ this.kb = this._defaultKB(); }
  }

  save() {
    if (!this.enabled) return;
    try {
      const out = Object.assign({}, this.kb, { __rounds: this.rounds.slice(-50) });
      fs.writeFileSync(this.path, JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {}
  }

  // ---------- 归类收集：单局记录 ----------
  // data = {
  //   result: 'good' | 'wolf',
  //   players: [{ no, role:'wolf'|'good', persona, votedNo, accusedBy:[no], accusations:[{no,isWolf}], costume }],
  //   audience: [{ kind, personaKey }],   // 本局观众弹幕
  //   costumeChanges: [{ no, suitName }],
  // }
  recordRound(data) {
    if (!this.enabled || !data) return;
    const kb = this.kb;
    kb.stats.rounds++;
    kb.stats.totalPlayers += (data.players || []).length;
    kb.stats[data.result === 'wolf' ? 'wolfWin' : 'goodWin']++;
    kb.stats.skillsUsed = (kb.stats.skillsUsed || 0) + (Array.isArray(data.skills) ? data.skills.length : 0);
    // 观众弹幕归类
    (data.audience || []).forEach((m) => {
      kb.stats.audienceMsgs++;
      if (m.kind && kb.keywordHits[m.kind] != null) kb.keywordHits[m.kind]++;
      if (m.personaKey) {
        if (m.kind === 'accuse') kb.personaAccuseCount[m.personaKey] = (kb.personaAccuseCount[m.personaKey] || 0) + 1;
        if (m.kind === 'defend') kb.personaDefendCount[m.personaKey] = (kb.personaDefendCount[m.personaKey] || 0) + 1;
      }
    });
    // 玩家信息归类
    (data.players || []).forEach((p) => {
      if (p.die) kb.stats.totalDeaths++;
      (p.accusations || []).forEach((a) => {
        if (a.isWolf) kb.personaTrust[p.persona] = (kb.personaTrust[p.persona] || 1) + this._lr() * 0.5; // 指控到真狼 → 信任+
        else kb.personaTrust[p.persona] = (kb.personaTrust[p.persona] || 1) - this._lr() * 0.3;          // 冤枉好人 → 信任-
      });
    });
    // 服装出镜归类
    (data.costumeChanges || []).forEach((c) => {
      if (c.suitName) kb.suitPopularity[c.suitName] = (kb.suitPopularity[c.suitName] || 0) + 1;
    });
    this.rounds.push({
      t: Date.now(), result: data.result,
      players: (data.players || []).map((p) => ({ no: p.no, role: p.role, persona: p.persona, die: !!p.die })),
      audienceKinds: (data.audience || []).map((m) => m.kind),
      costumes: (data.costumeChanges || []).map((c) => c.suitName),
    });
    this.evolve();
    this.save();
  }

  _lr() { return this.kb.learningRate; }

  // ---------- 自主进化：依据累积统计调整参数 ----------
  evolve() {
    const kb = this.kb;
    // 信任度做软归一（围绕1.0波动，避免发散）
    Object.keys(kb.personaTrust).forEach((k) => {
      let v = kb.personaTrust[k];
      v = Math.max(0.4, Math.min(1.8, v));
      // 向历史均值缓慢回归一点，防止单一局极端扰动
      kb.personaTrust[k] = v * (1 - this._lr() * 0.2) + 1.0 * (this._lr() * 0.2);
    });
    kb.lastEvolvedAt = Date.now();
    return this.advice();
  }

  // ---------- 给导演的建议（下局注入） ----------
  advice() {
    const kb = this.kb;
    // 信任度最高的性格 → 观众更倾向跟它的归票
    const trustEntries = Object.entries(kb.personaTrust).sort((a, b) => b[1] - a[1]);
    const topPersona = trustEntries.length ? trustEntries[0][0] : 'leader';
    // 出镜最高的服装 → 下局优先
    const suitEntries = Object.entries(kb.suitPopularity).sort((a, b) => b[1] - a[1]);
    const topSuit = suitEntries.length ? suitEntries[0][0] : null;
    // 归票 vs 狡辩 占比 → 影响观众发言倾向
    const acc = kb.keywordHits.accuse, def = kb.keywordHits.defend;
    const accuseRatio = acc + def > 0 ? acc / (acc + def) : 0.5;
    return {
      topPersona,
      topTrust: trustEntries.length ? trustEntries[0][1] : 1,
      topSuit,
      accuseRatio,                                   // 0~1，越高观众越爱归票
      personaTrust: Object.assign({}, kb.personaTrust),
      stats: Object.assign({}, kb.stats),
    };
  }

  summary() {
    return {
      path: this.path,
      enabled: this.enabled,
      rounds: this.kb.stats.rounds,
      goodWin: this.kb.stats.goodWin,
      wolfWin: this.kb.stats.wolfWin,
      audienceMsgs: this.kb.stats.audienceMsgs,
      topPersona: this.advice().topPersona,
      topSuit: this.advice().topSuit,
      skillsUsed: this.kb.stats.skillsUsed,
      personaTrust: this.kb.personaTrust,
      suitPopularity: this.kb.suitPopularity,
    };
  }
}

module.exports = { EvolutionEngine };
