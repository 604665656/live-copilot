'use strict';
// src/roles.js — 《我的粉丝里有鬼》真实 24 角色 + 技能表（来源：拆包 LiveWolfRoleType 枚举 + 实测技能）
//
// 数据来源（真实可核验）：
//   - 角色枚举：game-src/LiveWolfConf.js -> LiveWolfRoleType（24 个，编号 0..23）
//   - 技能机制：game-src/LiveWolfOnState.js（"个花瓶妹复活了"/talkById("复活"+no)）、
//     ComLiveWolfVoteResult.js（knifeKilledAnim 刀人动画）、LiveBoBoMasterOnMsg.js（复活指令）、
//     用户实测：瓶子=复活、妈宝=亡语、大人=刀人。
// 说明：具体数值（冷却/次数）由服务端下发，这里只建「技能语义模型」供导演/演示灵活运用。
'use strict';

// 真实 24 角色（key 与 LiveWolfRoleType 顺序一致）
const ROLES = {
  Mouse:           { no: 0,  name: '老鼠',       camp: 'wolf', skill: 'hallKill',        desc: '夜晚在大厅随机杀人' },
  NomalMan:        { no: 1,  name: '平民',       camp: 'man',  skill: null,              desc: '无技能，纯好人' },
  NomalWolf:       { no: 2,  name: '普通狼',     camp: 'wolf', skill: 'nightKill',       desc: '夜晚与狼队一同刀人' },
  DoubleWolf:      { no: 3,  name: '双面狼',     camp: 'wolf', skill: 'doubleFace',      desc: '可被好人与狼队双向识别' },
  MixMan:          { no: 4,  name: '混血儿',     camp: 'man',  skill: 'mix',             desc: '阵营模糊，验人结果不定' },
  ProphetMan:      { no: 5,  name: '预言家',     camp: 'man',  skill: 'check',           desc: '每夜验一人阵营' },
  KingWolf:        { no: 6,  name: '狼王',       camp: 'wolf', skill: 'kingDeathRattle', desc: '亡语：被投出时刀死归票者' },
  WitchMan:        { no: 7,  name: '女巫',       camp: 'man',  skill: 'save_poison',    desc: '每局救一人 / 毒一人' },
  DogMan:          { no: 8,  name: '妈宝',       camp: 'man',  skill: 'deathRattle',     desc: '亡语：死亡时触发效果（爆料/反噬）' },
  AngryYoungMan:   { no: 9,  name: '暴怒青年',   camp: 'man',  skill: 'knife',           desc: '白天可额外刀一人' },
  FoxWolf:         { no: 10, name: '狐狸狼',     camp: 'wolf', skill: 'foxRestrict',     desc: '其他鬼存活时不能开刀' },
  GuhunziMan:     { no: 11, name: '孤魂子',     camp: 'man',  skill: 'haunt',           desc: '亡语：鬼魂骚扰，扰乱一人' },
  CivetCatMan:     { no: 12, name: '狸猫',       camp: 'man',  skill: 'swap',            desc: '换身份/混淆视线' },
  DYWolf:          { no: 13, name: '抖音狼',     camp: 'wolf', skill: 'nightKill',       desc: '夜晚刀人' },
  GuWolf:          { no: 14, name: '蛊狼',       camp: 'wolf', skill: 'poison',          desc: '下毒，延迟结算' },
  DrunkardMan:     { no: 15, name: '酒鬼(瓶子)', camp: 'man',  skill: 'revive',          desc: '可复活一名死者一次' },
  CrazyMan:        { no: 16, name: '疯子',       camp: 'man',  skill: 'chaos',           desc: '随机搅局，发言不可控' },
  MonkMan:         { no: 17, name: '和尚',       camp: 'man',  skill: 'pray',            desc: '净化/挡刀一次' },
  NineFoxWolf:     { no: 18, name: '九尾妖狐',   camp: 'wolf', skill: 'nineTail',        desc: '满 9 尾觉醒，操控局势' },
  AoBaiMan:        { no: 19, name: '鳌拜(大人)', camp: 'man',  skill: 'knife',           desc: '白天可刀一人（大人会刀人）' },
  PathogenWolf:    { no: 20, name: '病毒狼',     camp: 'wolf', skill: 'infect',          desc: '传染，使好人疑似狼' },
  MatchKingWolf:   { no: 21, name: '比赛狼王',   camp: 'wolf', skill: 'kingDeathRattle', desc: '亡语刀人' },
  MatchCivetCatMan:{ no: 22, name: '比赛狸猫',   camp: 'man',  skill: 'swap',            desc: '换身份' },
  MatchWitchMan:   { no: 23, name: '比赛女巫',   camp: 'man',  skill: 'save_poison',     desc: '救/毒' },
};

// 技能语义（导演/演示据此灵活运用）
const SKILLS = {
  nightKill:      { name: '夜晚刀人', phase: 'night',  who: 'wolf' },
  hallKill:       { name: '大厅随机杀', phase: 'night', who: 'wolf' },
  check:          { name: '预言查验', phase: 'night',  who: 'man' },
  save_poison:    { name: '女巫救/毒', phase: 'night', who: 'man' },
  doubleFace:     { name: '双面',     phase: 'any',    who: 'wolf' },
  mix:            { name: '混血模糊', phase: 'any',    who: 'man' },
  kingDeathRattle:{ name: '狼王亡语', phase: 'death',  who: 'wolf' },
  deathRattle:    { name: '妈宝亡语', phase: 'death',  who: 'man' },
  haunt:          { name: '孤魂骚扰', phase: 'death',  who: 'man' },
  knife:          { name: '白天刀人', phase: 'day',    who: 'man' },
  foxRestrict:    { name: '狐狸限制', phase: 'night',  who: 'wolf' },
  poison:         { name: '下毒',     phase: 'night',  who: 'wolf' },
  revive:         { name: '复活',     phase: 'death',  who: 'man' },
  chaos:          { name: '搅局',     phase: 'any',    who: 'man' },
  pray:           { name: '挡刀/净化', phase: 'night',  who: 'man' },
  nineTail:       { name: '九尾觉醒', phase: 'any',    who: 'wolf' },
  swap:           { name: '换身份',   phase: 'any',    who: 'man' },
  infect:         { name: '传染',     phase: 'night',  who: 'wolf' },
};

const DOORS = ['A', 'B', 'C', 'D', '大厅'];

// 角色池（用于随机分配，保证好/狼数量合理）
function rolePool() { return Object.keys(ROLES); }

// 分配一局角色：total 个座位，wolfCount 个狼；其余好人，尽量覆盖有技能的好人角色
function assignRoles(total, wolfCount) {
  const wolves = ['NomalWolf', 'DoubleWolf', 'FoxWolf', 'DYWolf', 'GuWolf', 'KingWolf', 'NineFoxWolf', 'PathogenWolf', 'MatchKingWolf'];
  const goods = ['NomalMan', 'ProphetMan', 'WitchMan', 'DogMan', 'AngryYoungMan', 'GuhunziMan', 'CivetCatMan', 'DrunkardMan', 'CrazyMan', 'MonkMan', 'AoBaiMan', 'MixMan', 'Mouse'];
  const out = [];
  const wolfPicks = [];
  for (let i = 0; i < wolfCount; i++) wolfPicks.push(wolves[i % wolves.length]);
  const goodPicks = [];
  for (let i = 0; i < total - wolfCount; i++) goodPicks.push(goods[i % goods.length]);
  // 打乱并保证狼分布
  const all = shuffle([...wolfPicks, ...goodPicks]);
  return all.map((k) => ({ key: k, name: ROLES[k].name, camp: ROLES[k].camp, skill: ROLES[k].skill, skillName: SKILLS[ROLES[k].skill] ? SKILLS[ROLES[k].skill].name : '无' }));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function describeSkills() {
  return Object.values(ROLES).map((r) => `${r.name}(${r.camp === 'wolf' ? '狼' : '好'}${r.skill ? '·' + SKILLS[r.skill].name : ''})`).join(' ');
}

module.exports = { ROLES, SKILLS, DOORS, assignRoles, describeSkills, rolePool };
