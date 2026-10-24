'use strict';
// 全自动闭环：点歌闭环(模拟弹幕) + 游戏闭环(进大厅→报名→加机器人→开局→自动玩N盘)
const { app } = require('electron');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');

const path = require('path');
const fs = require('fs');
const { GameHost } = require('./src/gamehost.js');
const { Copilot } = require('./src/copilot.js');

const CODE = 'BJSPTSVR93B43';
const ROUNDS = 3;          // 打几盘
const ITER = 5;            // 每盘自动点击轮数
const OUT = path.join(__dirname, 'autoplay');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let shotNo = 0;
function shotName(tag) { return path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${tag}.png`); }

// 从截图里找"按钮"：高饱和色块聚类（不依赖 AI）
function findButtons(img, topN = 6) {
  const { width: w, height: h } = img.getSize();
  const buf = img.toBitmap(); // BGRA
  const cells = new Map();
  const step = 6, cell = 44;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      const b = buf[o], g = buf[o + 1], r = buf[o + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 130 || mx - mn < 55) continue; // 不够亮或不够饱和，跳过背景
      const key = Math.floor(x / cell) + ',' + Math.floor(y / cell);
      let c = cells.get(key);
      if (!c) { c = { sx: 0, sy: 0, n: 0 }; cells.set(key, c); }
      c.sx += x; c.sy += y; c.n++;
    }
  }
  const list = [...cells.values()]
    .filter(c => c.n >= 6)
    .map(c => ({ x: Math.round(c.sx / c.n), y: Math.round(c.sy / c.n), n: c.n }))
    .sort((a, b) => b.n - a.n);
  return list.slice(0, topN);
}

async function musicLoop() {
  console.log('\n########## A. 点歌闭环 ##########');
  const copilot = new Copilot({
    roomId: '0', musicProvider: 'qq', maxQueue: 10, perUser: 5, cooldownMs: 0,
    ai: { baseUrl: '', apiKey: '', model: '', enabled: false },
  });
  const played = [];
  copilot.player.useRendererPlayer((t) => played.push(t));
  copilot.on('playing', (t) => console.log(`  [播放] ${t.name} - ${t.artist} | 歌词 ${(t.lyric || '').length} 字 | ${t.url.slice(0, 52)}...`));
  copilot.on('next', (t) => console.log(`  [下一首] ${t ? t.name + ' - ' + t.artist : '队列已空'}`));
  copilot.on('songmiss', (d) => console.log(`  [没找到] ${d.keyword}`));
  copilot.on('say', (d) => console.log(`  [播报] ${d.text}`));

  // 模拟弹幕点歌（不走网络）
  await copilot.requestSong({ user: '观众A', uid: 1, text: '点歌 晴天' }, '晴天');
  await copilot.requestSong({ user: '观众B', uid: 2, text: '点歌 孤勇者' }, '孤勇者');
  await copilot.requestSong({ user: '观众C', uid: 3, text: '点歌 乱七八糟zzz' }, '乱七八糟zzz');
  await sleep(1500);
  await copilot.player.stop(); await copilot.playNext(); // 切歌
  await sleep(1500);
  console.log(`  实际送入播放器: ${played.length} 首`);
  return { played: played.length, stats: copilot.stats };
}

async function gameLoop() {
  console.log('\n########## B. 游戏闭环 ##########');
  const host = new GameHost({ onEvent: (t, d) => console.log('  [game]' , d) });

  console.log('--- 1. 打开游戏 ---');
  await host.open();
  await sleep(3000);
  await host.capture(shotName('open'));
  console.log('  已截图: open');

  console.log('--- 2. 身份码进大厅 ---');
  const r1 = await host.enterGame(CODE);
  console.log('  结果:', JSON.stringify(r1));
  await host.capture(shotName('lobby'));

  console.log('--- 3. 加机器人 x10 ---');
  await host.tap('addBot10');
  await sleep(2500);
  await host.capture(shotName('bots'));

  console.log('--- 4. 主播报名 ---');
  await host.tap('hostJoin');
  await sleep(3500);
  await host.capture(shotName('join'));

  const rounds = [];
  for (let rd = 1; rd <= ROUNDS; rd++) {
    console.log(`--- 5.${rd} 开始游戏 ---`);
    await host.tap('startGame');
    await sleep(4500);
    await host.capture(shotName(`r${rd}-start`));

    console.log(`--- 5.${rd} 自动游玩（像素找按钮）---`);
    let clicked = 0;
    for (let it = 1; it <= ITER; it++) {
      const img = await host.capture(shotName(`r${rd}-play${it}`));
      if (!img) continue;
      const btns = findButtons(img, 4);
      console.log(`  轮${it} 发现按钮 ${btns.length} 个: ${btns.map(b => `(${b.x},${b.y})`).join(' ')}`);
      for (const b of btns) {
        await host.click(b.x, b.y);
        clicked++;
        await sleep(1200);
      }
      await sleep(2500);
    }

    console.log(`--- 5.${rd} 返回大厅 ---`);
    await host.tap('backLobby');
    await sleep(3000);
    await host.capture(shotName(`r${rd}-end`));
    rounds.push({ round: rd, clicks: clicked });
    console.log(`  第${rd}盘完成，共点击 ${clicked} 次`);
  }
  return rounds;
}

app.whenReady().then(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  let music = null, rounds = null, err = null;
  try {
    music = await musicLoop();
    rounds = await gameLoop();
  } catch (e) {
    err = e.message;
    console.log('[ERROR]', err);
  }
  console.log('\n########## 汇总 ##########');
  console.log('点歌闭环:', JSON.stringify(music));
  console.log('游戏闭环:', JSON.stringify(rounds));
  console.log('截图目录:', OUT);
  console.log('[AUTOPLAY-DONE]');
  setTimeout(() => app.quit(), 500);
});
