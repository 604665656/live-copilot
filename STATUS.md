# 弹幕狼人杀《我的粉丝里有鬼》自动作战 —— 进度与卡点（实测）

> 最后更新：2026-10-21 深夜（第2局僵持后回到大厅，30/36 人报名）

> ⛔ **项目状态：已于 2026-10-22 00:53 由用户叫停，定时自动化已删除，执行器进程已终止。MVP 未达成（一局好人阵营胜利未完成）。** 身份读取能力已逆向就绪，详见下方「六、本次新增」。若重启，按记忆文件 recovery 步骤。

## 一、已验证可用的能力（实测通过）

| 能力 | 状态 | 实现 |
|---|---|---|
| 读 5 账号 Cookie / 发文字弹幕（无付费投喂） | ✅ | `src/bili.js:sendDanmaku`；`register.js` 群发；`_send_each.js` 分账号发不同指令 |
| **后台截图**（不抢焦点、不被遮挡） | ✅ | `_cap_pw.py`（PrintWindow/WM_PRINT，窗口右半被 WorkBuddy 盖住也能完整渲染） |
| **非侵入点击**（不抢焦点、不改层级） | ✅ | `_click_win.py`（PostMessage WM_LBUTTONDOWN/UP，实测可点开始/再来一局） |
| 完整对局 | ✅ | 第1局打到「鬼获胜」；第2局僵持（无人死亡）后回到大厅 |
| 常驻夜间自动执行器 | ✅ | `_auto_night.js`（后台，每12秒按 `plan.json` 发送，改文件即改战术） |
| 账号网页版玩家面板 | ✅ | `_player_view.js` / `_panels_all.js`（Edge+CDP，注入cookie打开 activity-pLTBKExnJ6.html） |
| 直播间内游戏面板 | ✅ | `_room_panel.js`（房间页点 #game-id 手柄图标） |

坐标换算：窗口坐标 `-（8,31)` = 客户区 = Cocos 画布坐标。客户区 1344x781，窗口 1360x820 @ (32,139)。

## 二、账号与直播间

- 主播/房主：**许许许许许丶若辰 uid=298813**（主播身份码 `BJSPTSVR93B43`，由「弹幕AI主播助手」内嵌 Cocos 窗口运行游戏）。
- 5 个可控账号（顺序即索引 0-4，发弹幕/看身份牌用，绝不投喂）：
  - 0 若辰-弹幕游戏 1542633399
  - 1 许许许许许丶若辰 298813
  - 2 Venus殇 98679142
  - 3 皛皛皛皛皛丶 3546882420771732
  - 4 皛晶晶皛 1207903548
- 直播间 5391172；玩家端面板 URL：`https://www.bilibili.com/blackboard/activity-pLTBKExnJ6.html?uid=<uid>&name=<名>&anchorId=298813&anchorUserName=许许许许许丶若辰&roomId=5391172&gameId=562c1de2-bbc0-4ba5-82cf-51ec3ef4b488&gameCode=1650229721834`

## 三、规则与战术要点（实测）

- 流程：报名 → 选房 A/B/C/D（~60s，不可更改）→ 夜晚结算 → 白天投票（号码，~60s）→ 审判 444处死/666放过（人数占优，**死者也可投票**）→ 循环。
- 老鼠咬**大厅**里的好人；**女鬼必须进房才能刀**；狐狸在其他鬼存活时不能开刀；满9尾觉醒。
- 胜利：好人票死所有鬼 / 鬼刀完所有好人。
- **教训1**：每夜必须给所有存活账号发进房指令，否则滞留大厅被老鼠咬（第1局因此输）。
- **战术A（僵持）**：把存活玩家分到不同房间 → 鬼身边没有好人 → 无人死亡，可无限拖时间换身份信息。
- **战术B（推理）**：分房后早上死亡发生在哪个房，即女鬼所在半边（二分定位）。
- 审判由多数方控制：好人侧 3 票 > 鬼侧 2 票（学生+已死学生都能投）。

## 四、MVP 阶段目标

1. ✅ 5 账号自动报名 + 自动选房（`_auto_night.js`）
2. ⬜ **对局中拿到 5 账号身份**（优先：玩家面板身份牌；备选：主播吊牌 `btn_copy` 读剪贴板）
3. ⬜ 按身份指挥（好人集中/分散、鬼进房刀人、白天集票+审判）
4. ⬜ 达成一局「好人阵营胜利」= MVP 完成

## 五、当前卡点

- **身份读取**：单独打开的玩家面板只显示商店 UI（数据靠直播间父页面推送）；直播间内面板可加载但需每账号一个浏览器 profile（cookie 隔离）。
- **主播吊牌**（`ComLiveWolfEnum`/`2c1dcyo2D1CKKBnUEKYd8qZ`，含 `btn_copy` 一键拷贝全场身份）位置未定位；预制体 `scene-json/ae2cf82b.json` 为 Cocos 压缩格式未解码。
- B站 API 偶发 `-352`/`fetch failed`（瞬时，重试即好）。

## 六、文件清单（新增）

- `_cap_pw.py` 后台截图；`_click_win.py` 非侵入点击
- `_send_each.js` 分账号发指令；`_auto_night.js` + `plan.json` 常驻执行器
- `_cdp.js` 零依赖 CDP 客户端；`_player_view.js`/`_panels_all.js`/`_room_panel.js`/`_panel_join.js`/`_panel_net.js`
- `game-bundle.js`/`game-bundle-dec.js` 游戏主包逆向；`scene-json/` 场景预制体
- `register.js` 群发报名；`autobot.js` 早期混合模式（已被上面工具取代）

## 七、单文件 EXE 打包（已完成）

> 最后更新：2026-10-22 下午 —— 狼人杀导演 AI + 手动指令台均已打包进助手 EXE；手动指令台即用户「昨天网页直接指令操作」的等价入口。

- **产物**：`dist/弹幕AI主播助手.exe`（7z 自解压单文件）。双击即自解压到临时目录并启动 `DanmuAICopilot.exe`。
- **内容**：内含已注入导演的 `app.asar`（含 `_director2.js`、`src/director-worker.js`、`config.json`、`ui` 面板）。导演在 Worker 线程运行，经 CDP `127.0.0.1:9222` 接管游戏窗口。
- **新增：手动指令台（游戏指令）面板** —— 解决「游戏操作没内置、昨天用网页直发指令」的问题：
  - 位置：助手右侧「手动指令台（游戏指令）」卡片。启动时自动从 `bili-relation-manager/data.json` 读取 5 个账号，已自动勾选具备发送权限者（需 `SESSDATA` + `bili_jct`）。
  - 用法：勾选要用的账号（或点「全选/全不选」）→ 输入指令（或点快捷按钮 报名/选1/444/666/躲门A-D/大厅）→ 点「发送（选中账号）」即按账号逐一发弹幕。账号间留 400ms 间隔防 B 站风控。
  - 底层复用 `src/bili.js:sendDanmaku`（WBI 签名 + REST `msg/send`）与 `src/accounts.js:loadAccounts`，与导演共用同一套账号。
  - 命令链路：`ui/app.js` → `preload.js:manualSend/manualAccounts` → `main.js` 新增 `cmd:send` / `cmd:accounts` IPC。
  - **「一键开始」组合指令按钮**：手动指令台新增「默认选房」下拉（A/B/C/D，默认 A）+「一键开始（报名+选房）」按钮。点击后：① 最佳努力启动内嵌游戏本体并打开窗口、填身份码、点「主播报名」「开始游戏」；② 组合发送「报名」给全部选中账号；③ 间隔 1.2s 再组合发送选房指令（默认 A）。账号间留 400ms 间隔防风控。
- **完全自包含（内嵌游戏本体）**：
  - 把实际游戏《我的粉丝里有鬼》整个目录（start.exe 88MB + dll/pak/locales/resources 共 133MB）复制进 `dist/win-unpacked/game/`，随 7z 包一起封进 EXE。单文件 EXE 自解压后，游戏本体就在 `DanmuAICopilot.exe` 同级的 `game/start.exe`。
  - `main.js` 新增 `embeddedGamePath()` / `embeddedGameExists()`；`loadCfg` 返回 `embeddedGame` 字段，`game:launch` / `game:detect` 优先使用内嵌游戏（运行时若存在）。UI「配置」的「游戏 exe 路径」会自动显示内嵌路径，点「启动游戏本体」即启动内嵌版，无需外部游戏文件。
  - 代价：EXE 体积从 ~69MiB 增至 ~160MiB（含游戏 133MiB）。逻辑上与导演共用的 5 账号体系、CDP 接管游戏窗口不变。
- **人工调参接口（满足「随时改难度/剧本/指令」）**：
  - 助手界面「狼人杀导演 AI」面板：启动/停止/重启 + 配置 load/save/打开文件 + 实时日志。
  - 配置落盘：`%APPDATA%/<助手userData>/director.config.json`（首次运行从内置 `config.json` 自动生成，每字段带 `_说明` 注释，改完存盘重启导演即生效）。
  - 亦可改 `config.json` 后重打包（见下）。
- **重打包**：`build/make_exe.bat`（依赖 `build/7za.exe` + `build/7z.sfx` + `build/config.txt`）。因 electron-builder portable 需 GitHub 下载 app-builder 5.x（被墙 502），改用 7z 自解压方案离线完成。注意 `make_exe.bat` 已从 `dist/win-unpacked` 目录内执行 `7za a`，避免归档路径带 `dist\win-unpacked\` 前缀导致 `RunProgram="DanmuAICopilot.exe"` 失效。
- **验证**：`app.asar` 内 main/preload/ui 三个改后文件 `node --check` 全通过；手动指令台 UI 与 `cmd:send`/`cmd:accounts` 链路已就位。
- **闭环自测（2026-10-22 下午，`electron . --selftest`）全绿**：
  - UI 加载 / API 暴露 / 音乐播放面板渲染 ✅
  - 游戏检测（`game:detect`）返回真实 exe 路径 ✅
  - **手动指令台**：`cmd:accounts` 返回 5 账号且全部 `sendable:true`；UI 渲染 5 个账号 pill、状态「可用 5/5」、所有按钮（`cmdRoom`/`btnCmdStart`/`btnCmdSend`/`btnCmdAll`）在位 ✅
  - **空指令校验**：`cmd:send({text:''})` 正确返回「指令内容为空」✅
  - **真实发弹幕（开 `SELFTEST_REAL_SEND=1` 时）**：5 账号全部返回 `OK`（code:0），证明 IPC→loadAccounts→WBI 签名→REST 全链路打通 ✅（默认关闭，避免重复自测刷屏直播间）
  - **导演配置** `director:cfg:load` 返回 ok ✅；**配置存取样板** `cfg:save→load→restore` 往返一致 ✅
  - 修复一个问题：独立测试脚本因缺 `no-sandbox`/`use-angle swiftshader` 开关导致 GPU 进程崩溃、且未注册 IPC handler；已把手动指令台/导演/配置的全部校验并入 `main.js` 的 `--selftest` 流程，统一用真实 handler 闭环验证。
- **运行前提**：主播需先在游戏内点「开启玩法」接入直播间（这是游戏自带按钮），再在助手点「启动导演」；手动发指令前需在「配置」填好房间号（默认 5391172）。

## 直播增强子系统 livecast（2026-10-22 晚）
- **独立无头演示 `_demo_round.js`（已验证全绿）**：真实跑完「导演完整一局」——真人账号先报名→加31 NPC→NPC按性格弹幕换装(观众可见)→场外围观观众错峰进场→NPC按关键字归票/狡辩/闲聊→真实24角色技能(瓶子复活/妈宝亡语/大人刀人/女巫救毒/预言查验/老鼠大厅杀)→天亮盘点复盘(按A/B/C/D/大厅门分组标死活狼好)→投票处决→自动循环/重开/归类收集/自主进化。配套 `src/{audience,evolve,dress,roles}.js`。`ROUNDS=3` 跑通，对局数累计7、好胜4/狼胜3、观众弹幕10343、技能65。
- **接入导演 `_director2.js`（默认关闭、零回归）**：新增 `livecast` 子系统，在 `onHide/onSelect/onVoteResult/onEnd` 挂安全钩子，分别驱动 `AudienceManager.tick`(场外围观观众陆续进场+按关键字归票/狡辩) 与 `EvolutionEngine.recordRound`(归类收集+自主进化持久化)。全部由 `config.livecast.{audience,evolve}.enabled` 控制，`try/catch` 全吞错；模块懒加载。`node --check` 通过，隔离验证等效路径 OK。
- **开关方式**：编辑 `config.json` 把 `livecast.audience.enabled` 与 `livecast.evolve.enabled` 改成 `true` 即生效；`audience.sendToRoom=true` 时由主播号代发真实弹幕(默认仅记日志)。
- **模拟日志已固化**：`sim-logs/2026-10-22-demo-ROUNDS2.log`、`ROUNDS3.log`（原在 /tmp 易丢，已备份）。知识库 `wolf-knowledge.json` 为跨局持久化文件。
- **说明**：10/21 无整局模拟（`_demo_round.js` 10/22 才创建），所有整局模拟均在 10/22。
