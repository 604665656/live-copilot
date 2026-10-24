# 游戏内容全解 + 工具可控清单

> 生成时间：2026-10-22 23:05　对象：`https://ggsl-res.hortorgames.com/web-desktop/index.html?pla=bli`
> **前提已更新（用户 22:59 确认）：不在直播，游戏可随时关闭/启动，可换网页版** → 所有"怕影响观众"的约束全部解除，下面清单按"随便玩"展开。

---

## 0. 一句话结论：边界在哪

```
能 100% 改：客户端显示层（文字/分数/位置/显隐/层级/颜色）
能改但会被打回：游戏每帧重写的数值（真实伤害、血条）→ 必须 monkey-patch 源头函数才站得住
能动：弹幕指令（真实发 / 本地注入）、鼠标点击、场景切换、开关模式
能调：导演参数、游戏内 GM 面板、window.config 配置表、帧率
改不了：服务端权威（真实伤害结算、发牌、金币背包、战绩、其他真人玩家数据）
```

已实测的关键结论：**战斗是服务器权威（frame sync）**。强改攻速条让"攻击变快"，伤害速率反而从 8963/s 掉到 2025/s（0.2 倍）。所以"加 10000 倍攻击力"只能落在**伤害排行榜展示层**（已做成，见 §2.2）。

---

## 1. 游戏内容全解（解压整理）

### 1.1 包结构

| 项 | 内容 |
|---|---|
| 引擎 | Cocos Creator 2.x web-mobile，设计分辨率 1920×1080 |
| 逻辑包 | `assets/main/index.723e6.js` 3.6MB，**未压缩、带原始模块名** |
| 已拆模块 | `game-src/` **669 个单模块文件** |
| 本地副本 | `game-pkg/`（41 文件 / 10.54MB，从 CDP 网络日志全量抓取） |
| 抓取脚本 | `extract_texts.py`（本次新增）→ `game-texts.json` / `game-texts.txt` |

### 1.2 玩法模式清单（12 个玩法族，同一套框架）

| 族（模块前缀） | 玩法 | 备注 |
|---|---|---|
| **LiveWolf** | 狼人杀《我的粉丝里有鬼》 | 导演 v2 已适配，24 角色完整状态机 |
| **LiveBoBo / LiveBoBoMaster** | **Gacha 怪兽** | 当前轮换到的模式，主控节点 `game_bobo_master` |
| LiveRouge | 《这是什么颜色》RGB 辨色 | 含 `ComRougeRgbTest` |
| LiveGreatSword | 大剑玩法 | 疑似《物理学不存在》 |
| LiveChump | 小黑子/捣蛋玩法 | — |
| LiveHd | 活动玩法 | — |
| LiveJz | 四国争霸 / 海盗船 | 含 Boat/Island/Bullet |
| LiveFrameBall / LiveBall | 弹球 | — |
| LiveDraw | 你画我猜 | — |
| LivePet | 宠物养成 | 60 条语句 |
| LiveXiuXian | 修仙 | 灵根/炼丹/境界 |
| LiveWarTrade / LiveTemp / LiveDJ | 战争贸易 / 新玩法占位 / 音乐 | — |

> 菜单上的中文名（我的粉丝里有鬼 / 放学不许走 / 物理学不存在 等）**不在包里，由服务端下发**，所以包内 grep 不到。

### 1.3 弹幕指令语句全表

#### A. 狼人杀《我的粉丝里有鬼》（`LiveWolfOnMsg.js`，103 条语句）

| 类别 | 语句 |
|---|---|
| **核心流程** | `报名`、`大厅`、`A/B/C/D`（躲门 1-4）、`1~100`（选人）、`444`/`雀食`（投杀）、`666`/`离谱`（投救） |
| **位置/外观** | `换位置`、`咸鱼翻身`、`变大`、`变小`、`变色`、`觉醒`、`进入预留席`/`预留席` |
| **查询** | `查询名片`、`查询碎片`、`查询鱼币`、`查询钓鱼`、`查询积分`、`查询仙丹`、`查询背包`、`查询套装`、`查询滤镜`、`查询糖果`、`查询蛋糕`、`查询金币` |
| **兑换/扭蛋** | `兑换R`、`兑换SR`、`兑换SSR`、`兑换UR`、`兑换经典盲盒`、`兑换轻奢盲盒`、`兑换豪华盲盒` |
| **社交/互动** | `赠送`、`领取`、`更换套装XX`、`检查部件`、`诅咒`、`献祭`、`钓鱼`、`滤镜`、`舰长`、`帮助`、`签到`、`核酸`、`丢便便`、`牛哇牛哇`、`i了i了`、`小花花` |
| **拍卖局(auction)** | `报名`、`加价`、数字出价 |
| **钓鱼局(fish)** | 弹幕即上座 |

#### B. Gacha 怪兽（`LiveBoBoMasterOnMsg.js`，43 条语句）

```
报名 / 加入                    → 加入队伍（营地阶段）
战士 / 弓箭手 / 法师            → 选职业（法师暂不支持）
抽 / 玩家装备抽奖               → 抽装备
更换 / 一键换装                 → 换装备（游戏中不能换）
加血 / 复活                     → 3 金币回 30% 血 / 10 金币满血复活
查询金币 / 查询名片 / 查询扭蛋  → 查询类
扭蛋 / 大扭蛋姬 / 碎片姬 / 钓鱼 / 互动铜币 / 冲金币 / 互动魔法书
```

> ⚠️ **导演目前只认狼人杀指令**——Gacha 模式下发的「钓鱼」「核酸」在本模式无效。这是待修项（见 §7）。

### 1.4 狼人杀角色与技能（24 角色，实测 roleName）

| 编号 | 真实 roleName | 阵营 | 技能 |
|---|---|---|---|
| 0 | 老鼠 | 狼 | 大厅杀人 |
| 1 | 平民 | 好 | 无 |
| 2 | 女鬼 | 狼 | 夜间刀人（**必须进房**） |
| 3 | 双面鬼 | 狼 | 双向识别 |
| 4 | 混血 | 好 | 验人结果不定 |
| 5 | 流浪汉 | 好 | — |
| 6 | 鬼格格 | 狼 | — |
| 7 | **花瓶妹** | 好 | **复活**（旧代码误判为 23 → 从未触发，已修） |
| 8 | 舔狗 | 好 | 挡刀 |
| 9 | 妈宝男 | 好 | 亡语爆料 |
| 10 | 狐狼 | 狼 | 其他鬼存活时不能开刀 |
| 11 | 孤魂 | 好 | 亡语骚扰 |
| 12 | 狸猫 | 好 | 换身份 |
| 13 | 单眼鬼 | 狼 | — |
| 14 | 蛊狼 | 狼 | 下毒/下蛊 |
| 15 | 酒鬼 | 好 | — |
| 16 | 狂人 | 好 | 搅局 |
| 17 | 武林高手 | 好 | 免疫/格挡 |
| 18 | 九尾妖狐 | 狼 | 满 9 尾觉醒 |
| 19 | **鳌大人** | 好 | **白天刀人** |
| 20 | 病原狼 | 狼 | 传染 |
| 21-23 | 比赛变体 | — | 比赛专属 |

### 1.5 Gacha 怪兽数值系统（`window.config` 实测枚举）

| 维度 | 枚举（真实值） |
|---|---|
| **属性 33 种** `BoboMonsterAttribute` | health 生命 / healthRe 回血 / energy / revive 复活 / **attack 攻击(7)** / **attackSpeed 攻速(8)** / armor 护甲 / armorPe 穿甲 / criticalChance 暴击 / criticalDamage 暴伤 / evade 闪避 / accuracy 命中 / **水火风土雷毒 攻/抗（18-33）** |
| **装备槽 10** `BoboMonsterEquipType` | weapon 武器 / cap 帽 / tops 上装 / bottoms 下装 / shoes 鞋 / gloves 手套 / cloak 披风 / wing 翅膀 / animalEars 兽耳 / tail 尾巴 |
| **武器 3** | swordSheld 剑盾 / bowArrow 弓箭 / stave 法杖 |
| **职业 4** | base / warrior 战士 / archer 弓箭手 / magician 法师（**法师暂不支持**） |
| **品质 4** | r / sr / ssr / ur |
| **技能 8** | addHealth / attackDamage / magicDamage / 水火风土雷 magicDamage |
| **动作 6** | idle / picked / seat / sing / dance / fly |
| **皮肤槽 27+** | body/eyes/mouth/cap/wing/tail/... + hairColor、eyesColor |

### 1.6 文案资产总表

- **1964 条去重中文文案**，分布在 **372 个模块**
- 完整清单：`game-texts.txt`（按模块分组）；结构化：`game-texts.json`
- 文案最多的模块：`GmMgr.js`(154) / `LiveWolfOnMsg.js`(103) / `LiveWolfActions.js`(95) / `LiveWolfOnState.js`(71) / `LivePetOnMsg.js`(60)

### 1.7 游戏自带 GM 调试面板（`GmMgr.js`，154 项）

游戏**自己**暴露了大量调试能力（`cc.admin()` 可开面板）：

```
资源类：加金币100亿 / 清空金币 / 加体力10000 / 加护盾 / 加星星 / 设置等级 / 加一等级
性能类：设置帧率 30/60/90/120 / 内存展示 / 打印内存资源
场景类：重新加载场景 / 打开我的直播场景 / 打开皮(肤)场景 / 地图界面 / 走图界面
测试类：生成用户 / 生成用户x100 / 随机获取装备 / 自动攻击 / 玩家说话 / 玩家送礼物
数据类：生成市场数据 / 清除市场数据 / 完成引导 / 每日签到 / admin角色列表
```
> 注：部分按钮属于同框架下其他游戏（蘑菇/卡牌/老虎机），狼人杀/Gacha 里点了可能无效。

---

## 2. 能「改」的（直接改内存 / 数据）

### 2.1 显示层 —— 100% 可改，纯客户端，零风险

| 对象 | 改法 | 备注 |
|---|---|---|
| 任意文字（Label） | `node.getComponent(cc.Label).string = 'xxx'` | 排行榜名字/分数/按钮/提示全都能改 |
| 节点位置 | `node.setPosition(x,y)` | 排方阵、挪玩家、挪 UI 面板 |
| 显隐 / 透明 | `node.active=false`、`node.opacity=0` | 隐藏血条、隐藏他人、隐藏 HUD |
| 缩放 / 旋转 | `node.scale=2`、`node.angle=30` | 放大角色、做特效 |
| 层级 / 顺序 | `node.zIndex`、`node.setSiblingIndex()` | 排行榜行序（**Gacha 里行不重叠，改 zIndex 无效，要改 y**） |
| 颜色 | `node.color = cc.Color.RED` | 血条/名字染色 |
| spine 动画 | 组件 `.animation='xxx'` | 换待机/攻击动作 |
| 按钮文字/可点 | Label + `interactable` | 把"开始"改成任意字 |

### 2.2 数据层 —— 可改，但要看游戏是否每帧重写

| 对象 | 状态 | 站稳的做法 |
|---|---|---|
| **Gacha 伤害排行榜分数** | ✅ **已做成** | 双钉 `rankArrs[].score` + `lab_score.string`（游戏只在数值变化时刷新标签，必须都钉） |
| **排行榜榜首** | ✅ 已破解 | monkey-patch `comTaskSort.addRand`：她的 uid 进来就把分数换成 30B，让**游戏自己的冒泡排序**把她拱顶，别人永远超不过 → 不用和游戏对打。脚本 `_rank_final.js` |
| 血条 / 攻速条 `cur/max` | ⚠️ 能改但**有害** | 实测强满攻速条 → 伤害降到 0.2 倍，别碰 |
| `window.config` 配置表 | ✅ 可写 | 客户端内存里的枚举/配置表（200+ 张），改了影响本地计算与显示 |
| 游戏内部方法 | ✅ 可 patch | 如 `addRand`/`bubbling`/`createRankInfo`，已验证可用 |
| 玩家昵称/头衔气泡 | ✅ | Label 直接改 |

### 2.3 改不了的（服务器权威，别浪费时间）

- 真实伤害数值与结算（frame sync，战斗服 `wss://cdyz.hortorgames.com/agent`）
- 发牌 / 角色分配（主播端 StartState）
- 金币 / 碎片 / 背包 / 皮肤（RPC `reqLive*`）
- 胜负结算与战绩记录
- 其他真人玩家的数据
- 报名有效性（fansLevel 限制）

---

## 3. 能「动」的（输入 / 交互）

| 动作 | 通道 | 备注 |
|---|---|---|
| **发真实弹幕指令** | 5 个账号 via `src/bili.js:sendDanmaku`（WBI 签名 REST） | 全局间隔 ≥3.2s、单账号 ≥9s 防风控 |
| **本地注入弹幕（不发到直播间）** | `cc.wolfAddDm(0, uid, name, '报名')` | **不直播后这条彻底可用**——自己刷指令玩，不打扰任何人 |
| 本地注入送礼 | `cc.wolfAddGift(...)` | 同上 |
| GM 发奖 | `cc.wolfAddReward(pwd, uid, [...])` | 需密码 |
| 开 GM 面板 | `cc.admin()` | §1.7 |
| **后台点击（不抢焦点）** | `_click_win.py`（PostMessage WM_LBUTTON）或 CDP `Input.dispatchMouseEvent` | 实测可点开始/再来一局/模式菜单 |
| 按名字点按钮 | `game:tap` IPC → 场景内找 Label 点击 | 比坐标稳 |
| **后台截图（不被遮挡）** | `_cap_pw.py`（PrintWindow）或 CDP `Page.captureScreenshot` | 窗口被盖住也能完整渲染 |
| 启动 / 关闭 / 重启游戏 | `game:launch` / `game:detect` / `game:open` | **不直播后可随时重启** |
| 填身份码 / 进房 | `game:fillcode` | 身份码 `BJSPTSVR93B43` |
| 切换玩法模式 | 点模式菜单（截图定位 + 点击） | 狼人杀 ⇄ Gacha ⇄ 其他 |
| **换网页版** | 浏览器打开同一 URL + `--remote-debugging-port` 接管 | 更轻、可多开、可并存多个玩法 |
| 刷新/重载游戏页 | `Page.reload` / `chain.reloadOnStart` | 不直播后无顾虑 |
| 音乐播控 | `song:search/play/next/stop` | 助手内置 |

---

## 4. 能「调」的（参数 / 配置）

### 4.1 导演配置 `%APPDATA%/Electron/director.config.json`（改完重启导演生效）

| 块 | 字段 | 作用 |
|---|---|---|
| **room** | roomId / streamerUid / identityCode / debugPort | 房间、主播号、身份码、CDP 端口 |
| **difficulty** | `npcReactMinMs/MaxMs` | NPC 反应延迟 2000-3000ms |
| | `botTarget` | 自动补机器人数 31 |
| | `accuseWolfRate` 0.7 | 好人 NPC 跟票抓狼概率（↑好人胜率） |
| | `killThresholdBase` 1.15 / `killThresholdBias` -1.25 | 投杀阈值（bias 越小越好杀狼） |
| | `npcDeadHardRate` 0.06 | 狼阵营死硬派比例 |
| | `wolfSaveMateRate` 0.15 / `wolfFakeGoodRate` 0.15 | 狼救队友 / 装好人概率 |
| | `speakRateScale` / `influenceScale` | NPC 发言频率 / 影响力缩放 |
| **script** | phases.{Hide,Night,SelectPlayer,VotePlayer,VoteResult,End} | **各阶段解说台词池**（每条 3 句随机抽） |
| | nightResult.{zero,heavy,normal} | 夜况播报（`{n}` 占位人数） |
| | execution.{wolf,good} | 处决播报（`{no}` 占位号码） |
| | chatter / welfare / fish | 水群弹幕 `["核酸","钓鱼"]`、福利指令、钓鱼文案 |
| **commands** | join / voteKill / voteSave / hideLetters | 指令文案可整体替换（如把 444 换成别的） |
| **chain** | heartbeatCheckMs 20000 / autoRestart / reloadOnStart | 心跳巡检、卡死自动重启、启动先刷新 |
| **livecast** | audience.{enabled,target,joinWindowMs,tickGapMs,sendToRoom} | 场外围观观众 NPC（默认关） |
| | evolve.enabled | 自主进化（跨局写 `wolf-knowledge.json`） |

### 4.2 导演代码常量（`_director2.js`）

```
AUTO_NEXT_GAME / HUMAN_TAKEOVER / HUMAN_RANDOM_SEAT  行为开关（硬编码默认值，防配置被回写清空）
DM_GAP=3200  DM_ACC_GAP=9000  DM_BACKOFF=22000        弹幕节流
ROLE 24 角色名表 / CAMP / LETTER 躲门字母             硬编码映射
ACCOUNT_PERSONA 5 账号性格（leader/aggressive/rational/emotional/cautious）
state 8 自动下一局节流 5s
```

### 4.3 游戏内可调（GM / config）

- 帧率 30/60/90/120（GM 面板）
- 金币 / 体力 / 护盾 / 星星 / 等级（GM 面板，**本地显示，服务器不同步**）
- `window.config` 200+ 张配置表（本地枚举/数值表）
- 自动攻击开关（GM 面板）

### 4.4 换肤 / 换资源

`game-pkg/native/**` 的 png 同名替换 + 本地起 HTTP 服务托管整个 `game-pkg`，把游戏 URL 指向本地即可。**不直播后可放心做**（改的是自己本地加载的资源）。

---

## 5. 不直播后新解锁的玩法（原来不敢做的）

1. **随便重启 / 重载页面** —— 不用怕打断观众；`chain.reloadOnStart` 可开
2. **换网页版** —— 浏览器直接开同一 URL + CDP 接管，可多开并存（一个玩狼人杀、一个玩 Gacha）
3. **本地弹幕注入刷着玩** —— `cc.wolfAddDm` 随便灌指令，验证状态机/技能，不惊动任何人
4. **GM 面板随便点** —— 加金币 100 亿、改帧率、生成 100 个假用户
5. **改资源换肤** —— 本地托管替换 png
6. **改 config 配置表** —— 改本地枚举/数值看效果
7. **自动化测试整局** —— `_demo_round.js` 跑 N 局验证导演逻辑（`ROUNDS=3` 已跑通过）

---

## 6. 速查：常用命令

```bash
# 抽全量文案（已跑，产物 game-texts.json/txt）
python extract_texts.py

# 连 CDP 看游戏（9222 端口）
node _dump_all.js          # config 枚举 + 场景文本 + 全局接口
node _diag_rank.js         # Gacha 排行榜状态
node _diag_bubbling.js     # 排序方法源码

# 10000 倍攻击力（Gacha 排行榜置顶，patch 版）
node _rank_final.js        # 输出 patched/applied/labelSet/fixed 计数

# 后台截图 / 非侵入点击
python _cap_pw.py  <out.png>
python _click_win.py <x> <y>

# 本地注入弹幕（不发直播间，游戏页 console 执行）
cc.wolfAddDm(0, '298813', '许许许许许丶若辰', '报名')
cc.admin()                 # 开 GM 面板

# 重启 Electron 栈
cd live-copilot && env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe main.js --autorun
```

---

## 7. 待办（按你之前的需求排队）

| # | 事项 | 状态 |
|---|---|---|
| 1 | Gacha 模式适配导演指令（现在发「钓鱼」无效，应发 加入/加血/复活/1-9） | ⬜ 待做 |
| 2 | 导演三处修复：Worker 单例（多导演并发总根因）/ epoch 令牌 / onReady 提速 | ⬜ 待做 |
| 3 | Electron 栈加 supervisor 守护（22:49 静默退出过一次，5h10m） | ⬜ 待做 |
| 4 | 真人玩家占座 + 自动下一局验证 | ✅ 已落地，待观察 |
