'use strict';
// 从「B站关注管理后台」(bili-relation-manager) 读取已登录账号的 Cookie
// 用于：进入直播间 / 发送弹幕 / 查看身份牌（不含任何付费投喂）
const fs = require('fs');

const DATA_PATH = process.env.BRM_DATA ||
  'C:/Users/60466/AppData/Roaming/bili-relation-manager/data.json';

function parseCookie(raw) {
  // raw 可能是 "k1=v1; k2=v2" 或对象
  const out = {};
  const str = typeof raw === 'string' ? raw : '';
  str.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) {
      const k = p.slice(0, i).trim();
      const v = p.slice(i + 1).trim();
      if (k) out[k] = v;
    }
  });
  return out;
}

function loadAccounts() {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    throw new Error('读取 bili-relation-manager/data.json 失败: ' + e.message);
  }
  const list = (d.accounts || []).map((a) => {
    const c = parseCookie(a.cookie);
    return {
      id: a.id,
      uid: a.uid,
      uname: a.uname,
      cookie: a.cookie,             // 完整 cookie 字符串（发送弹幕用）
      keys: {
        SESSDATA: c.SESSDATA || '',
        bili_jct: c.bili_jct || '',
        DedeUserID: c.DedeUserID || '',
        buvid3: c.buvid3 || '',
      },
    };
  });
  // 仅保留具备发送弹幕所需字段的账号
  const usable = list.filter((a) => a.keys.SESSDATA && a.keys.bili_jct);
  return { all: list, usable, raw: d };
}

// 判断账号是否具备「发送弹幕」能力（SESSDATA + bili_jct）
function isSendable(acc) {
  return !!(acc && acc.keys && acc.keys.SESSDATA && acc.keys.bili_jct);
}

module.exports = { loadAccounts, isSendable, parseCookie, DATA_PATH };
