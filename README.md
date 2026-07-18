# feishu-codex-bridge

[English](README.en.md) | **中文**

把本机 Codex CLI 接入飞书：私聊或在群里 @机器人即可与 Codex 对话。飞书事件通过 WebSocket 长连接到达，无需公网服务器、域名或回调地址。

## 功能

- 每个飞书会话映射一个 Codex thread，支持跨天续聊
- 支持文本、图片、文件、语音、富文本和合并转发
- 首个私聊者自动成为 owner：owner 使用 `workspace-write`，其他成员使用 `read-only`
- `/new` 重开会话，`/status` 查看 thread 和权限
- 直接使用本机 Codex 登录态，不需要额外 API Key

## 安装

需要 Git、Node.js 18+ 和 Codex CLI。macOS / Linux 一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/demry-max/feishu-codex-bridge/main/install.sh | bash
```

脚本会检查 Codex 登录、下载项目、安装依赖、引导飞书扫码建应用，并配置开机自启。

如需手动安装：

```bash
npm install -g @openai/codex
codex login
git clone https://github.com/demry-max/feishu-codex-bridge.git
cd feishu-codex-bridge
npm install
npm run register
npm start
```

`npm run register` 会显示飞书授权二维码，扫码后自动创建应用，并将凭据写入被 Git 忽略的 `.env`。日志出现 `[ws] ws client ready` 后，到飞书私聊机器人发送“你好”即可。

## 可选配置

```dotenv
CODEX_BIN=codex
CODEX_MODEL=
CODEX_TIMEOUT_MS=300000
WORKSPACE_DIR=/absolute/path/to/workspace
FEISHU_DOMAIN=feishu
ALLOW_NON_OWNER=false
```

`FEISHU_DOMAIN=lark` 可切换到 Lark 国际版。语音识别兜底需要 `ffmpeg` 以及飞书 `speech_to_text:speech` 权限。

## 架构

```text
飞书私聊 / 群聊 @机器人
        ↓ WebSocket
Node.js 桥接服务（去重、串行队列、owner 鉴权、附件下载）
        ↓ codex exec --json / codex exec resume
Codex CLI
        ↓
飞书 Markdown 卡片
```

## 安全

- `.env`、`data/` 和运行时 workspace 内容均被 Git 忽略
- 默认只允许 owner 使用机器人；可用 `ALLOW_NON_OWNER=true` 显式开放
- 开放后，非 owner 进程使用 `read-only` 沙箱，但这不代表主机上的所有文件都不可见
- owner 使用 `workspace-write`；建议为机器人使用独立 workspace，不要指向含敏感数据的目录

## 记忆与 Skills

- `workspace/memory/MEMORY.md` 是长期记忆索引
- 对机器人说“记住……”，Codex 会在 `workspace/memory/` 添加记忆
- 说“存成技能”，技能会保存到 `workspace/skills/`
- 桥接会在每次调用前同步技能到 `workspace/.agents/skills/`

## 致谢

本项目基于 [demry-max/feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge) 的飞书长连接、消息解析和扫码注册设计改造，并将 Agent 运行时替换为 Codex CLI。

MIT License
