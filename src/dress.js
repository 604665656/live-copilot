'use strict';
// src/dress.js — NPC 换装 + 观众可见的弹幕播报
//
// 游戏内换装本来就走机器人本地 API（p.skin.setSkinOrSoulBySuitId），观众在游戏画面里能看到。
// 这里补上「弹幕播报」：NPC 一换衣服，就发一条公屏弹幕，让直播间所有观众（不只看游戏画面的）
// 也能看到「几号换了什么皮肤」，把换装变成可围观的直播事件。
'use strict';

const npc = require('./npc');
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

// 选一套付费套装（与导演 dressNPC 完全一致，便于复用）
function pickSuit(uid, reshuffle) {
  const suit = npc.paidOutfitFor(uid, reshuffle);
  return {
    grade: suit.grade,
    suitId: suit.suitId,
    name: suit.name,
    // 给 robotAct 用的指令对象（action:'suit'）
    cmd: { uid: String(uid), action: 'suit', grade: suit.grade, suitId: suit.suitId, fallback: npc.outfitFor(uid) },
  };
}

// 观众可见的换装播报文案
const ANNOUNCE = [
  (no, name, suit) => `🎽 ${no}号${name} 换上了「${suit}」，全场最靓的崽！`,
  (no, name, suit) => `💅 ${no}号 新皮肤「${suit}」上线，这波颜值营业了`,
  (no, name, suit) => `✨ ${no}号换装「${suit}」完毕，观众老爷们觉得咋样？`,
  (no, name, suit) => `👗 ${no}号${name} 今天穿的是「${suit}」，狼味还是人味自己品`,
];

function announceText(no, name, suitName) {
  return rnd(ANNOUNCE)(no, name, suitName);
}

module.exports = { pickSuit, announceText, ANNOUNCE };
