# 《我的粉丝里有鬼》游戏包拆解报告

> 拆解对象：`https://ggsl-res.hortorgames.com/web-desktop/index.html?pla=bli`（B站弹幕狼人杀·主播端）
> 本地副本：`live-copilot/game-pkg/`（41 文件 / 10.54MB，2026-10-22 从 CDP 网络日志全量抓取）
> 拆分后的模块源码：`live-copilot/game-src/`（668 个单模块文件）

---

## 一、包结构：这个游戏是什么

Cocos Creator 2.x **web-mobile** 构建，设计分辨率 1920×1080。加载链：

```
index.html
  └─ src/settings.ec859.js      launchScene: db://assets/live.fire（启动场景=直播间）
       └─ main.935f4.js          boot：loadBundle(MAIN)
            ├─ cocos2d-js-min.ff388.js    引擎 1.8MB
            └─ assets/main/index.723e6.js ★ 游戏逻辑 3.6MB（658→668 模块）
```

### 文件清单（按职责）

| 文件 | 大小 | 作用 |
|---|---|---|
| `index.html` / `src/settings.*.js` / `main.*.js` | 小 | 启动引导 |
| `cocos2d-js-min.ff388.js` | 1.8MB | Cocos 引擎 |
| `assets/main/index.723e6.js` | **3.6MB** | **全部游戏逻辑**（webpack bundle，未压缩、带原始模块名） |
| `assets/main/config.723e6.json` | 3KB | 103 个 uuid → 资源映射 |
| `assets/main/import/**/*.json` | — | 序列化场景/预制体（node 树 + SpriteFrame） |
| `assets/main/native/**` | — | png/plist 图片资源 |
| `assets/mainScene/**` `assets/internal/**` | — | 场景与内置资源 |

### 3.6MB 逻辑包 = 668 个模块，按代码量 Top 15

| 模块 | 大小 | 职责 |
|---|---|---|
| `config` | 84K | 全配置表结构（WolfRoleInfo/WolfDraw/WolfFishLevel… **数据由服务端下发**，`decode()` 填充） |
| `cmd` | 51K | **平台协议命令表**（450+ 个 `game_req*` 命令名） |
| `data` | 44K | 数据层 |
| `GmMgr` | 43K | GM 调试面板（addBtn 注入各种调试功能） |
| `LiveWolfOnState` | 41K | **狼人杀状态机**（Ready→Start→Hide→Night→SelectPlayer→VotePlayer→VoteResult→End） |
| `LiveWolfActions` | 38K | **弹幕指令 → 游戏动作**（Join/SelectPlayer/VotePlayer/Hide…） |
| `VirtualList` | 37K | 虚拟列表组件 |
| `danmaku-websocket.min` | 34K | B站开放平台弹幕 WS 客户端 |
| `game-service` | 31K | **RPC 客户端**（245 个 `reqLive*` 方法） |
| `LiveWolfOnMsg` | 24K | **弹幕指令解析器**（`doDmMsg` 大 switch） |
| `LiveWolfCtl` | 20K | 控制器（UI 装配、事件绑定） |
| `LiveWolfPlayerInfo` | 19K | 玩家信息管理（addPlayer/movePlayerToPlace） |
| `LiveWolfRole` | 18K | 角色类（24 种角色及技能） |
| `UILiveWolfAdmin` | 21K | 管理后台（只读记录查询） |

> bundle 是多个小游戏共用一套框架（bobo/jz/draw/pet/frameball…），狼人杀只是 `LiveWolf*` 那一族。

---

## 二、运行逻辑：一局游戏怎么跑起来

### 1. 登录与连接

```
① 身份码登录   POST https://cdyz.hortorgames.com/login/authuser
               （网页版用 edit_pwd 输身份码 BJSPTSVR93B43）
② 弹幕 WS     ws://ks-sh-live-rtc-01.chat.bilibili.com:2244/sub
               （B站开放平台协议，16 字节定长头 + JSON body）
               OP_HANDSHARE(鉴权 auth_body) → OP_HEARTBEAT(心跳)
               → OP_SEND_SMS(发弹幕) → 收 LIVE_OPEN_PLATFORM_DM
③ 游戏 RPC    game-service 模块，cdyz.hortorgames.com（HTTP）
```

### 2. 弹幕 → 游戏事件的转换（`LiveBliSdkMgr`）

WS 收到 `LIVE_OPEN_PLATFORM_DM` → 组装 `LiveBaseData{uid,name,info=弹幕文本,...}` → `ClientEventMgr.emit("liveBaseData")` → `LiveWolfCtl.onMsg` → **`LiveWolfOnMsg.doMsg`**。

送礼 `LIVE_OPEN_PLATFORM_SEND_GIFT` → 同样通道（action=GiftSend）。

### 3. 狼人杀弹幕指令表（`LiveWolfOnMsg.doDmMsg` 完整提取）

**nomal/fox 模式（普通局）：**

| 弹幕文本 | 动作 | 生效状态 |
|---|---|---|
| `报名` | Join 加入游戏 | Ready |
| `A`/`B`/`C`/`D`（大小写） | Hide 躲进 1-4 号门 | Hide |
| `大厅` | 回大厅 | Hide |
| `1`~`100`（纯数字） | SelectPlayer 选择该号码玩家 | SelectPlayer |
| `444` 或 `雀食` | VotePlayer 投杀票 | VotePlayer |
| `666` 或 `离谱` | VotePlayer 投救票 | VotePlayer |
| `换位置`/`咸鱼翻身` | ChangePlace | — |
| `锁定`+号码 | SelectNo 锁定 | — |
| `进入预留席`/`预留席` | 预留席 | — |
| `变大`/`变小`/`变色` | ChangeBig | — |
| `签到`/`核酸` | 签到 | — |
| `觉醒` | awaken | — |
| `查询名片/碎片/鱼币/钓鱼/积分/仙丹/背包/金币/套装/滤镜` | 查询面板 | — |
| `兑换R/SR/SSR/UR…` | 兑换 | — |
| `赠送`/`领取`/`更换套装XX`/`检查部件`/`诅咒`/`献祭`/`钓鱼`/`滤镜`/`舰长`/`帮助` | 各类互动 | — |

**auction 模式（拍卖局）：** `报名`/`加价`/数字出价
**fish 模式：** 弹幕即上座（addWatcher）

### 4. 状态机（`LiveWolfOnState.doState`）

```
Ready(1)     准备/报名，comLiveWolfReady 面板
  ↓ 点开始(clickStart，仅 Ready 可开始)
Start(2)     发牌：checkGetRoles() 本地抽角色 → 倒计时
  ↓
Hide(3)      躲藏阶段：A/B/C/D 选门（18人开B门，28人开C门）
  ↓
Night(4)     夜晚：按角色回合行动（night_witch 女巫/night_fox 妖狐/
             night_ghost 鬼/night_huxian 狐仙/night_tiangou 天狗/
             night_child 小皇帝/night_mouse 老鼠/night_king 狮王）
  ↓
SelectPlayer(5)  白天行动：发数字选人（刀/毒/验/守/猎/射…）
  ↓
VotePlayer(6)    投票：444 杀 / 666 救
  ↓
VoteResult(7)    票型公布（平安夜 night_normal）
  ↓
End(8)       结算（胜负/阵营 Man=1 / Wolf=2）
```

状态推进全部在客户端 `LiveWolfOnState` 内按定时器推进，`LiveWolfMgr.setState()` + `emit("LiveWolfChangeState")`。**各端独立演算同一局**（同一房间同一弹幕流），主播端权威。

### 5. 角色表（`LiveWolfRoleType` 24 种，数据服务端下发）

```
0 老鼠(Mouse)      1 平民(NomalMan)    2 狼人(NomalWolf)   3 双狼(DoubleWolf)
4 混血(MixMan)     5 预言家(ProphetMan)6 狮王(KingWolf)    7 女巫(WitchMan)
8 狗(DogMan)       9 愤青(AngryYoungMan) 10 狐狼(FoxWolf) 11 孤魂(GuhunziMan)
12 狸猫(CivetCatMan) 13 毒狼(DYWolf)   14 蛊狼(GuWolf)    15 酒鬼(DrunkardMan)
16 狂人(CrazyMan)  17 武僧(MonkMan)    18 九尾狐(NineFoxWolf) 19 傲白(AoBaiMan)
20 病原狼(PathogenWolf) 21-23 比赛变体  阵营: Man=1 / Wolf=2
```

---

## 三、怎么更改：四条可控通道（按推荐度）

### ★ 通道 1：本地弹幕注入 `cc.wolfAddDm`（零风险，立即可用）

游戏自己暴露的调试接口（`LiveWofOnCmd` 模块，随场景加载）：

```js
cc.wolfAddDm(0, '<uid>', '<名字>', '报名')   // 注入一条弹幕
cc.wolfAddGift(...)                          // 注入送礼
cc.admin()                                   // 开管理面板
cc.wolfAddReward(pwd, uid, [reward,sub,count]) // GM 发奖（需密码）
```

等价于真的发了弹幕，但**只在本地生效**——用来测试指令解析、验证状态门控，不用打扰真实直播间。

### ★ 通道 2：直接调游戏 API（CDP `Runtime.evaluate`）

```js
// 场景里拿控制器（LiveWolfCtl 挂的场景组件）
const ctl = cc.director.getScene().getComponentInChildren('LiveWolfCtl');
// 直接做动作（参数 = LiveWolfActions 的 (ctl, data)）
LiveWolfActions.Join(ctl, {uid:'123', name:'测试', fansLevel:0})
LiveWolfActions.SelectPlayer(ctl, {uid:'123', info:'7'})   // info=号码
LiveWolfActions.VotePlayer(ctl, {uid:'123', info:'444'})
// 读实时情报
LiveWolfMgr.state            // 当前状态(1-8)
LiveWolfMgr.curNightNum      // 第几天
LiveWolfMgr.players          // Map<uid, LiveWolfPlayerInfo> 存活玩家
LiveWolfMgr.diePlayers       // Map 死亡玩家
LiveWolfMgr.hasUids          // Set 本局uid
```

### ★ 通道 3：改坐标/场景树（排方阵、点名）

`node.setPosition(cc.v3(x,y,0))` 直接改场景树节点位置（设计坐标，原点在画布中心，1920×1080）。CDP `Runtime.evaluate` 执行，完全后台、像素级精确。

### 通道 4：替换静态资源（皮肤/音效）

`game-pkg/native/**` 的 png 同名替换 + 本地起 HTTP 服务托管整个 game-pkg，游戏 URL 指向本地即可（settings.js 里改 bundleVers 或直接本地 file 服务）。适合换肤，不适合改逻辑。

---

## 四、权威边界：什么能本地改，什么必须服务端

| 可客户端改 | 服务端/主播端权威 |
|---|---|
| 场景树坐标/显隐/动画 | 角色抽取结果（发牌在主播端 StartState） |
| 本地状态门控（测试用） | 玩家金币/碎片/背包（RPC `reqLive*`） |
| UI 布局、面板显隐 | 报名有效性（ fansLevel 限制在主播端配） |
| 本地注入假弹幕 | 输赢结算、战绩记录（`reqLivePlayerRecords*`） |
| 机器人数量（btn_robot） | 房间人数同步 |

**实战结论：5 个号要"玩"胜利，指令必须发真实弹幕**（`报名`/号码/`444`），因为主播端和其他 36 个玩家都要收到同一份弹幕流；本地注入只用于自测。情报读取则完全可以用通道 2/3 本地完成。

---

## 五、附：关键 uuid 索引（config.723e6.json 可对回资源）

| 模块 | uuid |
|---|---|
| cmd | `813e0ixdVJCmKO2QIBKr/h1` |
| config | `cebecNLLBJIiYQtRrOlGr4g` |
| game-service | `6d545dc5/1HCbDBefUBD2Lz` |
| LiveBliSdkMgr | `c495cByLOxN7KXSYFkGckk7` |
| LiveWolfOnState | `21fd9uiSVBGbYRKN90XAWG9` |
| LiveWolfActions | `83854ifEBRF/JRlgHaS+NdB` |
| LiveWolfOnMsg | `afe1bm1v2FFeoDnp+1pvYUF` |
| LiveWolfCtl | `b0cf0oV3eBHFZrZlqC1OM5c` |
| LiveWolfMgr | `c5f85XDZH5EO5OEyCFiJ1ua` |
| LiveWolfConf | —（含全部枚举：State/PlaceType/Camp/RoleType/Counts） |

（完整 668 模块清单见 `game-src/_manifest.json`）
