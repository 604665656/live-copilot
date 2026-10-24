const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

app.on('ready', function () {
  // 打开本地界面
  // let win = new BrowserWindow({ width: 1960, height: 1080, webPreferences: { zoomFactor: 1.0 } });
  // win.loadURL("file://" + __dirname + "/index.html");;
  // return
  // 是否覆盖内置模块
  console.log("内置模块", require.resolve('electron'));
  // 参数获取
  console.log("argv0", process.argv)
  console.log("argv1", process.argv[1])
  console.log("argv2", process.argv[2])
  console.log("argv3", process.argv[3])
  let argvs = ""
  for (const arg of process.argv) {
    if (arg && arg.indexOf("=") != -1) {
      argvs += ("&" + arg)
    }
  }
  // let argv = (process.argv[1] == "." ? process.argv[2] : process.argv[1])
  let url = ("https://ggsl-res.hortorgames.com/web-desktop/index.html?pla=bli" + argvs)
  console.log("url", url)
  // 加载分辨率窗口
  let win_select = new BrowserWindow({ width: 686, height: 720 })
  win_select.loadURL(`file://${__dirname}/index.html`)
  // 主进程接受消息
  let ipcMain = electron.ipcMain
  ipcMain.on('sbl', function (event, arg) {
    console.log("sbl", arg);
    // 加载游戏窗口
    let bl = 1 - arg * 0.1
    let width = 1920 * bl + 30
    let height = 1080 * bl + 65
    let zoomFactor = bl
    console.log("width", width, "height", height, "zoomFactor", zoomFactor)
    let win_geme = new BrowserWindow({ width, height, webPreferences: { zoomFactor }, frame: true });
    win_geme.loadURL(url);
    win_geme.on('closed', function () {
      console.log("closed game")
    });
    // 关闭分辨率窗口
    win_select.close()
  });
  // 加载游戏窗口

  app.on('window-all-closed', () => {
    console.log("window-all-closed")
    app.quit()
  })

}); 