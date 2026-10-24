'use strict';
// 验证「软件」主持端的登录链路：用软件自带的 GameHost 打开游戏 → 填身份码 → 登录 → 进大厅
// 运行：node_modules/.bin/electron verify-gamehost.js
// 不依赖你的直播推流；只用身份码 BJSPTSVR93B43 登录游戏会话，证明软件能开游戏+进大厅。
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');

const CODE = process.argv[2] || 'BJSPTSVR93B43';

app.whenReady().then(async () => {
  // 复用软件自带的 GameHost 模块
  const { GameHost } = require('./src/gamehost.js');
  const gh = new GameHost({
    onEvent: (type, data) => {
      if (type === 'log') console.log('[game]', data);
    },
  });

  console.log('=== 验证 GameHost 登录链路 ===');
  console.log('身份码:', CODE);
  console.log('① 打开游戏窗口...');
  const openRes = await gh.open();
  console.log('   打开结果:', JSON.stringify(openRes));

  console.log('② 填身份码 + 登录（最多 ~33s 等待进大厅）...');
  const enter = await gh.enterGame(CODE);
  console.log('   登录结果:', JSON.stringify(enter));

  if (enter && enter.ok) {
    console.log('✅ 已进大厅：软件能开游戏、填码、登录成功。主持端游戏链路打通。');
  } else {
    console.log('⚠️ 未进大厅：', (enter && enter.msg) || '未知');
    console.log('   （可能原因：该身份码对应的游戏会话需要与你的直播间推流绑定；或会话已失效）');
  }

  // 保留窗口供截图读取，约 90s 后自动退出；期间可外部截图
  console.log('窗口保持 90s 供截图…');
  setTimeout(() => { gh.close(); app.quit(); }, 90000);
}).catch((e) => {
  console.error('验证异常:', e);
  app.quit();
});
