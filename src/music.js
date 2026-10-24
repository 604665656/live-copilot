'use strict';
// 音乐引擎：搜索（QQ / 网易云）+ 播放（mpv / 内置 audio / 外链）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 说明：汽水音乐（字节/抖音）没有公开搜索/播放 API，无法直连。
// 这里用「网易云外链」作为可播放源（实测可用），QQ 仅作补充搜索；QQ 付费曲拿不到直链时自动回退网易云同名曲。
const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';

async function searchQQ(keyword, limit = 5) {
  const url = `${QQ_SEARCH}?w=${encodeURIComponent(keyword)}&n=${limit}&format=json&aggr=1&cr=1&new_json=1`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' } });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt.replace(/^callback\(/, '').replace(/\)$/, '')); } catch (e) { return []; }
  const list = (j.data && j.data.song && j.data.song.list) || [];
  return list.map(s => ({
    id: s.mid || s.songmid || String(s.id),
    name: s.name || s.title,
    artist: (s.singer || []).map(a => a.name).join('/'),
    album: s.album && s.album.name,
    source: 'qq',
    duration: s.interval,
  }));
}

async function searchNetease(keyword, limit = 5) {
  try {
    const r = await fetch(`https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}`, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
    });
    const j = await r.json();
    const songs = (j.result && j.result.songs) || [];
    return songs.map(s => ({
      id: String(s.id), name: s.name, artist: (s.ar || []).map(a => a.name).join('/'),
      album: s.al && s.al.name, source: 'netease', duration: Math.round((s.dt || 0) / 1000),
    }));
  } catch (e) { return []; }
}

// 解析 QQ 可播放直链（vkey）
async function getQQPlayUrl(songmid) {
  try {
    const guid = '1234567890abcdef1234567890abcdef';
    const data = { req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid, filename: [`C400${songmid}.m4a`], songmid: [songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20' } } };
    const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?-=getplaysong&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify(data))}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' } });
    const j = await r.json();
    const info = j.req_0 && j.req_0.data && j.req_0.data.midurlinfo && j.req_0.data.midurlinfo[0];
    const sip = (j.req_0.data.sip && j.req_0.data.sip[0]) || '';
    if (info && info.purl) return sip + info.purl;
  } catch (e) { /* 忽略 */ }
  return '';
}

const neteaseUrl = (id) => `https://music.163.com/song/media/outer/url?id=${id}.mp3`;

// 关键：网易云外链对「无版权 / 已下架」的歌会 302 到 music.163.com/404 并返回 HTML，
// <audio> 拿到 HTML 就会静默失败（表现就是"点了播放但没声音"）。所以出队前必须实测一次。
async function verifyPlayable(url, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/', Range: 'bytes=0-1024' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return false;                                   // 4xx/5xx
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (/text\/html/.test(ct)) return false;                    // 返回的是网页不是音频
    if (/music\.163\.com\/404/.test(r.url || '')) return false; // 无版权跳转页
    return true;
  } catch (e) {
    // 网络抖动 / 超时不误杀，交给播放器最终判断（失败会自动跳下一首）
    return true;
  }
}

// 在网易云同名结果里找第一首「实测能播」的
async function findPlayable(name, artist, excludeIds = [], limit = 5) {
  const list = await searchNetease(name, limit);
  if (!list.length) return null;
  const normA = String(artist || '').replace(/\s/g, '');
  const normN = String(name || '').replace(/\s/g, '');
  const scored = list.map(s => {
    let score = 0;
    const sa = String(s.artist || '').replace(/\s/g, '');
    const sn = String(s.name || '').replace(/\s/g, '');
    if (sn === normN) score += 3;                                        // 歌名完全一致
    if (normA && sa && (sa.includes(normA.slice(0, 2)) || normA.includes(sa.slice(0, 2)))) score += 2; // 歌手相近
    return { s, score };
  }).sort((a, b) => b.score - a.score);
  for (const { s } of scored) {
    if (excludeIds.includes(String(s.id))) continue;
    const url = neteaseUrl(s.id);
    if (await verifyPlayable(url)) return { ...s, url, fallback: true };
  }
  return null;
}

// 给一首歌补全「实测可播」的 url；拿不到就找网易云同名曲，实在没有返回 null（由调用方跳过）
async function resolveTrack(track) {
  if (track.url) return track;

  if (track.source === 'netease') {
    const url = neteaseUrl(track.id);
    if (await verifyPlayable(url)) return { ...track, url };
    return await findPlayable(track.name, track.artist, [String(track.id)]);
  }

  if (track.source === 'qq') {
    const u = await getQQPlayUrl(track.id);
    if (u && await verifyPlayable(u)) return { ...track, url: u };
  }

  // 回退：网易云同名曲
  return await findPlayable(track.name, track.artist, []);
}

// 歌词（LRC 文本）
async function getLyric(track) {
  try {
    if (track.source === 'netease' || track.fallback) {
      const r = await fetch(`https://music.163.com/api/song/lyric?id=${track.id}&lv=-1&kv=-1&tv=-1`, { headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } });
      const j = await r.json();
      return (j.lrc && j.lrc.lyric) || '';
    }
  } catch (e) { /* */ }
  return '';
}

class Player {
  constructor(opts = {}) {
    this.mpvPath = opts.mpvPath || '';
    this.proc = null;
    this.current = null;
    this.state = 'idle';
    this.volume = opts.volume ?? 70;
    this.onEvent = opts.onEvent || (() => {});
  }

  detectMpv() {
    const cands = [
      this.mpvPath,
      path.join(process.resourcesPath || '', 'mpv', 'mpv.exe'),
      path.join(__dirname, '..', 'bin', 'mpv.exe'),
      path.join(__dirname, '..', 'bin', 'ffplay.exe'),
      'C:\\Program Files\\mpv\\mpv.exe',
      'C:\\mpv\\mpv.exe',
    ].filter(Boolean);
    for (const c of cands) {
      if (c === 'mpv') continue;
      if (fs.existsSync(c)) return c;
    }
    return '';
  }

  // 让 Electron 渲染进程用 <audio> 播放（打包后无需外部 mpv）
  useRendererPlayer(handler) { this.rendererPlay = handler; }

  async play(track) {
    await this.stop();
    if (!track) { this.current = null; return; }
    const resolved = track.url ? track : await resolveTrack(track);
    this.current = resolved || track;
    if (!resolved || !resolved.url) {
      this.state = 'error';
      this.onEvent('player', { state: 'error', track, reason: '无可用播放地址' });
      return;
    }
    const url = resolved.url;
    const mpv = this.detectMpv();
    if (!mpv) {
      // 无 mpv：交给渲染进程 <audio> 播放（Electron 自带解码）
      this.state = 'playing';
      if (typeof this.rendererPlay === 'function') {
        this.rendererPlay({ ...resolved, url });
        this.onEvent('player', { state: 'playing', track: { ...resolved, url }, player: 'audio' });
      } else {
        this.state = 'error';
        this.onEvent('player', { state: 'error', track, reason: '未找到播放器，且渲染层不可用' });
      }
      return;
    }
    this.proc = spawn(mpv, [
      '--no-video', '--really-quiet', '--idle=no',
      `--volume=${this.volume}`, url,
    ], { windowsHide: true });
    this.state = 'playing';
    this.onEvent('player', { state: 'playing', track: { ...resolved, url }, player: 'mpv' });
    this.proc.on('exit', () => {
      const wasPlaying = this.state === 'playing';
      this.proc = null;
      this.state = 'idle';
      if (wasPlaying) this.onEvent('player', { state: 'ended', track });
    });
    this.proc.on('error', (e) => {
      this.state = 'error';
      this.onEvent('player', { state: 'error', track, reason: e.message });
    });
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, v));
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.proc) { this.state = 'idle'; resolve(); return; }
      const p = this.proc;
      this.proc = null;
      this.state = 'idle';
      try { p.kill(); } catch (e) { /* */ }
      setTimeout(resolve, 150);
    });
  }
}

module.exports = { searchQQ, searchNetease, Player, resolveTrack, getLyric, verifyPlayable, neteaseUrl };
