# 弹幕狼人杀 · AI 主播助手

本地可跑的 EXE 工具：接 B 站直播间弹幕 → 自动点歌（汽水/QQ 源、网易云源）+ AI 解说 + 游戏画面识别播报。

## 快速开始

```bash
npm install
npm start
```

打包单文件 EXE：

```bash
npm run build
# 产物在 dist/ 下，portable 模式免安装
```

## 已实现

| 模块 | 说明 |
|---|---|
| `src/bili.js` | B 站直播 WS 弹幕协议（WBI 签名、brotli/zlib 解包、心跳、自动重连） |
| `src/music.js` | 点歌搜索（QQ/汽水源、网易云源）+ 播放（mpv 优先，回落内置 `<audio>`） |
| `src/brain.js` | OpenAI 兼容 AI 接口（Ollama / LM Studio / llama.cpp / DeepSeek 等） |
| `src/screen.js` | 屏幕采集 + OCR 阶段判定 + 模板匹配 + VLM 兜底（预留） |
| `src/copilot.js` | 编排：弹幕 → 点歌 / AI 回复 / 播报 |
| `ui/` | 控制台界面（弹幕流、点歌台、配置、日志） |

## 弹幕指令

| 指令 | 作用 |
|---|---|
| `点歌 歌名` | 搜索并加入播放队列（含冷却、每人限额、队列上限） |
| `切歌` | 切到下一首 |
| `问 内容` | 强制 AI 回复一条 |

搜不到的歌会自动弹幕回应（AI 生成或模板兜底），不会静默失败。

## 配置项

界面右侧「配置」里填，存在 `%APPDATA%/danmu-ai-copilot/config.json`：

- **直播间房间号**：B 站短号或真实房间号均可
- **AI 接口**：默认 `http://127.0.0.1:11434/v1`（Ollama），模型默认 `qwen2.5:7b`
  - 本地模型：启动 Ollama 后填 `http://127.0.0.1:11434/v1`，Key 任意
  - 云端：填对应中转地址 + Key
- **游戏 exe 路径**：留空则不启用，点「启动游戏本体」会报错提示

AI 不通时整套仍可运行：点歌、搜歌、弹幕回应走模板兜底。

## 屏幕识别（游戏画面 → 自动播报）

设计为**无 AI 也能跑**：OCR + 模板匹配做阶段判定，VLM 仅兜底。

```js
// src/screen.js
const PHASES = { UNKNOWN, LOBBY, NIGHT, DAY, VOTE, RESULT };
// 阶段关键词命中即触发 phase 事件 → 自动播报
```

启用需要两步：
1. 把游戏各阶段截图存到模板目录，文件名即阶段（`night.png` / `vote.png` / `result.png`）
2. 配置 `regions.phase` 指定 OCR 采样区域（一般是画面中央文字区）

局限：游戏本体是远程网页壳（`ggsl-res.hortorgames.com`），本地拿不到游戏状态，只能靠画面。界面元素一变需重截模板。

## 已知限制

- 汽水音乐无公开 API，这里用 QQ 音乐搜索层检索同名曲库；播放直链走网易云外链（`outer/url`），部分版权歌会返回 404，此时自动跳下一首。
- 游戏本体缺 `start.exe`（原压缩包只解出 Electron 运行时散文件），需重新下载完整包才能用「启动游戏本体」。
- 发言只显示在工具内的「AI 播报区」，不直接发到直播间（B 站发弹幕需登录态，属可加功能）。
