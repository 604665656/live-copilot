'use strict';
// B站直播弹幕网关：WS 协议（参考 xfgryujk/blivedm 的协议实现）
const WebSocket = require('ws');
const zlib = require('zlib');

const OP = {
  HANDSHAKE: 0, HANDSHAKE_REPLY: 1, HEARTBEAT: 2, HEARTBEAT_REPLY: 3,
  SEND_MSG: 4, SEND_MSG_REPLY: 5, DISCONNECT_REPLY: 6, AUTH: 7, AUTH_REPLY: 8,
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function makePacket(payload, op) {
  const body = Buffer.isBuffer(payload) ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + body.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);
  return Buffer.concat([head, body]);
}

class BiliLive {
  constructor(roomId, handlers = {}) {
    this.roomId = Number(roomId);
    this.handlers = handlers;
    this.ws = null;
    this.wsHosts = [];
    this.token = '';
    this.uid = 0;
    this.buvid = '';
    this.retry = 0;
    this.alive = false;
    this.heartTimer = null;
    this.reconnectTimer = null;
    this.popularity = 0;
  }

  log(...a) { this.emit('log', a.join(' ')); }
  emit(type, data) { if (typeof this.handlers.onEvent === 'function') this.handlers.onEvent(type, data); }

  // WBI 签名（getDanmuInfo 无签名会返回 -352）
  async ensureWbi() {
    const now = Date.now();
    if (this.wbiKey && now - this.wbiAt < 11 * 3600 * 1000) return this.wbiKey;
    try {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      });
      const cookieHdr = r.headers.getSetCookie ? r.headers.getSetCookie().join('; ') : '';
      for (const c of cookieHdr.split(';')) {
        const [k, v] = c.split('=');
        if (k && k.trim() === 'buvid3') this.buvid = (v || '').trim();
      }
      const j = await r.json();
      const img = j.data && j.data.wbi_img;
      if (!img) return '';
      const imgKey = img.img_url.split('/').pop().split('.')[0];
      const subKey = img.sub_url.split('/').pop().split('.')[0];
      const shuffled = imgKey + subKey;
      const table = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
        27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
      this.wbiKey = table.map(i => shuffled[i]).join('');
      this.wbiAt = now;
      return this.wbiKey;
    } catch (e) {
      return '';
    }
  }

  signWbi(params) {
    const key = this.wbiKey;
    if (!key) return params;
    const wts = String(Math.floor(Date.now() / 1000));
    const all = { ...params, wts };
    const sorted = Object.keys(all).sort().reduce((o, k) => {
      o[k] = String(all[k]).replace(/[!'()*]/g, '');
      return o;
    }, {});
    const query = Object.entries(sorted).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const wRid = require('crypto').createHash('md5').update(query + key).digest('hex');
    return { ...params, wts, w_rid: wRid };
  }

  async cookie() {
    // 拿 buvid3，提高连接成功率
    try {
      const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA } });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const c of sc) {
        const m = /^(buvid3)=([^;]+)/.exec(c);
        if (m) this.buvid = m[2];
        const m4 = /^(buvid4)=([^;]+)/.exec(c);
        if (m4 && !this.buvid4) this.buvid4 = m4[2];
      }
    } catch (e) { /* 忽略 */ }
  }

  async start() {
    this.alive = true;
    this.retry = 0;
    await this.connect();
  }

  async connect() {
    if (!this.alive) return;
    try {
      if (!this.buvid) await this.cookie();

      // 1. 真实房间号
      const infoR = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.roomId}`, {
        headers: { 'User-Agent': UA },
      }).then(r => r.json());
      if (infoR && infoR.code === 0 && infoR.data) {
        this.realRoomId = infoR.data.room_id;
        this.emit('roominfo', {
          roomId: infoR.data.room_id,
          title: infoR.data.title,
          owner: infoR.data.uid,
          liveStatus: infoR.data.live_status,
        });
      } else {
        this.realRoomId = this.roomId;
      }

      // 2. 弹幕服务器
      await this.ensureWbi();
      const signed = this.signWbi({ id: this.realRoomId, type: 0 });
      const qs = Object.entries(signed).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const confR = await fetch(
        `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${qs}`,
        { headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/', Cookie: this.buvid ? `buvid3=${this.buvid}` : '' } }
      ).then(r => r.json());
      let hostList;
      if (confR && confR.code === 0 && confR.data && confR.data.host_list && confR.data.host_list.length) {
        hostList = confR.data.host_list;
        this.token = confR.data.token || '';
      } else {
        this.log(`getDanmuInfo 失败(${confR && confR.code} ${confR && confR.message})，使用默认节点`);
        hostList = [{ host: 'broadcastlv.chat.bilibili.com', wss_port: 443 }];
        this.token = '';
      }
      this.wsHosts = hostList;

      const host = hostList[this.retry % hostList.length];
      const url = `wss://${host.host}:${host.wss_port || 443}/sub`;
      this.log(`连接弹幕服务器 ${url}`);
      this.openWs(url);
    } catch (e) {
      this.log('连接异常: ' + e.message);
      this.scheduleReconnect();
    }
  }

  openWs(url) {
    const ws = new WebSocket(url, {
      headers: { 'User-Agent': UA, Origin: 'https://live.bilibili.com' },
      handshakeTimeout: 12000,
    });
    this.ws = ws;

    ws.on('open', () => {
      const auth = {
        uid: this.uid,
        roomid: this.realRoomId,
        protover: 3,
        platform: 'web',
        type: 2,
        buvid: this.buvid,
      };
      if (this.token) auth.key = this.token;
      if (this.buvid4) auth.buvid4 = this.buvid4;
      ws.send(makePacket(auth, OP.AUTH));
      this.heartTimer = setInterval(() => {
        try { ws.send(makePacket({}, OP.HEARTBEAT)); } catch (e) { /* */ }
      }, 25000);
      this.emit('status', { connected: true, roomId: this.realRoomId });
    });

    ws.on('message', (data) => {
      try { this.parse(Buffer.from(data)); } catch (e) { this.log('解析失败: ' + e.message); }
    });

    ws.on('close', (code) => {
      clearInterval(this.heartTimer);
      this.heartTimer = null;
      if (!this.alive) return;
      this.emit('status', { connected: false });
      this.log(`连接关闭 code=${code}，准备重连`);
      this.scheduleReconnect();
    });

    ws.on('error', (e) => { this.log('WS错误: ' + e.message); });
  }

  scheduleReconnect() {
    if (!this.alive) return;
    clearTimeout(this.reconnectTimer);
    this.retry += 1;
    const delay = Math.min(30000, 2000 * this.retry);
    this.log(`${Math.round(delay / 1000)}s 后重连（第 ${this.retry} 次）`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  parse(buf) {
    let offset = 0;
    while (offset + 16 <= buf.length) {
      const packLen = buf.readUInt32BE(offset);
      const headLen = buf.readUInt16BE(offset + 4);
      const ver = buf.readUInt16BE(offset + 6);
      const op = buf.readUInt32BE(offset + 8);
      if (packLen < 16 || offset + packLen > buf.length) break;
      const body = buf.subarray(offset + headLen, offset + packLen);

      if (op === OP.SEND_MSG_REPLY || op === OP.AUTH_REPLY) {
        if (ver === 2) {
          try { this.parse(zlib.inflateSync(body)); } catch (e) { this.log('zlib解包失败'); }
        } else if (ver === 3) {
          try {
            const out = zlib.brotliDecompressSync(body);
            this.parse(out);
          } catch (e) { this.log('brotli解包失败: ' + e.message); }
        } else if (body.length) {
          try { this.onCommand(JSON.parse(body.toString('utf8'))); } catch (e) { /* 非JSON */ }
        }
      } else if (op === OP.HEARTBEAT_REPLY) {
        if (body.length >= 4) {
          this.popularity = body.readUInt32BE(0);
          this.emit('popularity', this.popularity);
        }
      } else if (op === OP.AUTH_REPLY) {
        const j = JSON.parse(body.toString('utf8'));
        if (j.code !== 0) this.log('认证失败 code=' + j.code);
      }
      offset += packLen;
    }
  }

  onCommand(cmd) {
    const c = String(cmd.cmd || '');
    if (c.startsWith('DANMU_MSG')) {
      const info = cmd.info || [];
      const meta = info[0] || [];
      const text = info[1];
      const user = info[2] || [];
      // meta[9]=0 正常弹幕；meta[12]=0 表情
      if (meta[12] !== 0 && meta[12] !== undefined) return;
      this.emit('danmaku', {
        type: 'danmaku',
        uid: user[0],
        user: user[1],
        text: String(text || ''),
        medal: user[3] ? { name: user[3], level: user[4] } : null,
        guard: user[7] || 0,
        time: Date.now(),
      });
    } else if (c === 'SUPER_CHAT_MESSAGE') {
      const d = cmd.data || {};
      this.emit('danmaku', {
        type: 'superchat',
        uid: d.uid,
        user: d.user_info && d.user_info.uname,
        text: d.message || '',
        price: d.price || 0,
        time: Date.now(),
      });
    } else if (c === 'SEND_GIFT') {
      const d = cmd.data || {};
      this.emit('gift', { type: 'gift', uid: d.uid, user: d.uname, gift: d.giftName, num: d.num, price: (d.price || 0) * (d.num || 1) });
    } else if (c === 'INTERACT_WORD') {
      const d = cmd.data || {};
      if (d.msg_type === 1) this.emit('enter', { type: 'enter', uid: d.uid, user: d.uname });
    } else if (c === 'LIVE') {
      this.emit('liveon', { type: 'liveon' });
    }
  }

  stop() {
    this.alive = false;
    clearInterval(this.heartTimer);
    clearTimeout(this.reconnectTimer);
    try { this.ws && this.ws.close(); } catch (e) { /* */ }
  }
}

// ============ 发送弹幕（不需要 WS，走 REST 接口，使用账号 Cookie）============
// 注意：仅发送文字弹幕，不涉及任何付费投喂（礼物/SC）。
const SEND_URL = 'https://api.live.bilibili.com/msg/send';
const crypto = require('crypto');

// WBI 签名（B站 2024+ 多数写接口要求 w_rid / wts）
let _wbiKey = '', _wbiAt = 0;
async function getWbiKey() {
  const now = Date.now();
  if (_wbiKey && now - _wbiAt < 11 * 3600 * 1000) return _wbiKey;
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
  }).then((x) => x.json());
  const img = r && r.data && r.data.wbi_img;
  if (!img) return '';
  const imgKey = img.img_url.split('/').pop().split('.')[0];
  const subKey = img.sub_url.split('/').pop().split('.')[0];
  const shuf = imgKey + subKey;
  const table = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
  _wbiKey = table.map((i) => shuf[i]).join('');
  _wbiAt = now;
  return _wbiKey;
}
function wbiSign(params, key) {
  const wts = String(Math.floor(Date.now() / 1000));
  const all = { ...params, wts };
  const sorted = Object.keys(all).sort().reduce((o, k) => {
    o[k] = String(all[k]).replace(/[!'()*]/g, '');
    return o;
  }, {});
  const query = Object.entries(sorted).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const wRid = crypto.createHash('md5').update(query + key).digest('hex');
  return { ...params, wts, w_rid: wRid };
}

async function sendDanmaku({ cookie, roomId, text, biliJct, uid = 0 }) {
  if (!cookie || !roomId || !text) {
    return { ok: false, code: -1, message: '缺少 cookie / roomId / text' };
  }
  const csrf = biliJct || (() => {
    const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(cookie);
    return m ? m[1] : '';
  })();
  if (!csrf) return { ok: false, code: -1, message: '缺少 bili_jct(CSRF)' };

  let base = {
    roomid: String(roomId),             // 注意：B站 msg/send 用的参数名是 roomid（不是 room_id）
    msg: String(text).slice(0, 30),     // B站单条弹幕上限 20~30 字
    bubble: '0',
    mode: '1',
    fontsize: '25',
    color: '16777215',
    rnd: String(Math.floor(Date.now() / 1000)),
    reply_mid: '0',
    csrf_token: csrf,
    csrf: csrf,
    web_location: '444.8',
  };
  try {
    const key = await getWbiKey();
    if (key) base = wbiSign(base, key);
  } catch (e) { /* 签名失败则不带，按旧接口尝试 */ }

  const body = new URLSearchParams(base);
  try {
    const r = await fetch(SEND_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': 'https://live.bilibili.com/' + roomId,
        'Origin': 'https://live.bilibili.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
      },
      body: body.toString(),
    });
    const j = await r.json();
    return {
      ok: j && j.code === 0,
      code: j && j.code,
      message: (j && j.message) || r.statusText,
      data: j && j.data,
    };
  } catch (e) {
    return { ok: false, code: -2, message: '网络异常: ' + e.message };
  }
}

// 给 BiliLive 实例增加「以某账号身份发送弹幕」的能力
BiliLive.prototype.sendAs = function (text, account) {
  // account: { cookie, keys:{bili_jct} }
  return sendDanmaku({
    cookie: account.cookie,
    roomId: this.realRoomId || this.roomId,
    text,
    biliJct: account.keys && account.keys.bili_jct,
  });
};

module.exports = { BiliLive, makePacket, OP, sendDanmaku };
