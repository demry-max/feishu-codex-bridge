# feishu-codex-bridge

[![version](https://img.shields.io/badge/version-1.4.0-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**中文** | [English](README.en.md)

把本机 Codex CLI 接入飞书：私聊或在群里 @机器人即可与 Codex 对话。飞书事件通过 WebSocket 长连接到达，无需公网服务器、域名或回调地址。

## 功能

- 每个飞书会话映射一个 Codex thread，支持跨天续聊
- 支持文本、图片、文件、语音、富文本和合并转发
- 首个私聊者自动成为 owner：owner 使用 `workspace-write`，其他成员使用 `read-only`
- `/new` 重开会话，`/status` 查看 thread、模型和权限
- `/model sol high` 即时切换模型与推理档，无需重启；支持定时 `set-model`
- `/cancel` 取消任务，`/redirect` 中断并改道，`/voice` 切换语音回复
- 支持定时任务、出站脱敏、文件回传、访问白名单及飞书文档/多维表格 MCP 工具
- 直接使用本机 Codex 登录态，不需要额外 API Key
- 可通过私有 MCP 和安全隧道把本机 Lark Mail 接入 ChatGPT（仅搜索、读取和创建草稿）

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

遇到续聊失败、后台服务未更新等问题，请查看 [故障排查](docs/TROUBLESHOOTING.md)。

如需在 ChatGPT 中像连接 Gmail 一样调用 Lark Mail，请按 [Lark Mail 私有连接指南](docs/CHATGPT_LARK_MAIL.md) 配置。

## 可选配置

```dotenv
CODEX_BIN=codex
CODEX_MODEL=
CODEX_REASONING_EFFORT=xhigh
CODEX_SERVICE_TIER=fast
CODEX_NETWORK_ACCESS=true
CODEX_APPROVAL_POLICY=never
CODEX_IGNORE_EXEC_RULES=true
CODEX_IDLE_TIMEOUT_MS=300000
CODEX_MAX_RUNTIME_MS=1800000
WORKSPACE_DIR=/absolute/path/to/workspace
FEISHU_DOMAIN=feishu
ALLOW_NON_OWNER=false
ENABLE_PROGRESS_UPDATES=false
AUTO_REDIRECT_WHEN_BUSY=true
```

`FEISHU_DOMAIN=lark` 可切换到 Lark 国际版。语音识别兜底需要 `ffmpeg` 以及飞书 `speech_to_text:speech` 权限。

`CODEX_REASONING_EFFORT=xhigh` 启用 Extra high 推理。`CODEX_SERVICE_TIER=fast` 启用 Codex Fast mode，速度更快但会消耗更多 credits。

`CODEX_NETWORK_ACCESS=true` 允许 owner 的 `workspace-write` 沙箱访问网络，供 `lark-cli`、npm 和飞书 OpenAPI 使用；非 owner 的 `read-only` 沙箱不会因此获得网络权限。可设为 `false` 关闭。

桥接默认使用 `CODEX_APPROVAL_POLICY=never`，避免无头任务等待无法完成的交互式审批；owner 同时设置 `CODEX_IGNORE_EXEC_RULES=true`，让 `unzip`、文档解析等命令在 `workspace-write` 沙箱内直接执行。沙箱仍然生效，并未使用危险的 `--yolo`。

DOCX 文件会先由 Node.js 桥接层安全抽取正文，再交给 Codex 分析，因此不会依赖模型临时调用 `python3`、`unzip` 或要求用户批准命令。如果模型仍返回审批话术或错误引用 `~/.claude/settings.json`，桥接会隐藏该回复并自动改用安全方案重试一次。

长任务不会因总运行超过 300 秒就失败。`CODEX_IDLE_TIMEOUT_MS` 只在 Codex 持续无任何输出时触发；`CODEX_MAX_RUNTIME_MS` 是防止失控任务的最终上限。旧的 `CODEX_TIMEOUT_MS` 仍可作为无活动超时兼容项。

默认 `ENABLE_PROGRESS_UPDATES=false`，只向飞书发送最终结果。如果需要在长任务中查看阶段性进度，可显式设为 `true`。

默认 `AUTO_REDIRECT_WHEN_BUSY=true`：同一会话的新消息会自动取消尚未完成的旧任务并接管，不再要求手动发送 `/cancel` 或 `/redirect`。设为 `false` 可恢复 v1.4.0 的等待提示。

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
- 默认只给 owner 的 `workspace-write` 沙箱开放网络；可用 `CODEX_NETWORK_ACCESS=false` 关闭
- 开放后，非 owner 进程使用 `read-only` 沙箱，但这不代表主机上的所有文件都不可见
- owner 使用 `workspace-write`；建议为机器人使用独立 workspace，不要指向含敏感数据的目录

## 记忆与 Skills

- `workspace/memory/MEMORY.md` 是长期记忆索引
- 桥接会在每次 owner 调用前显式读取并注入该索引，不依赖模型临时调用工具；索引中的明细文件仅在相关任务中按需读取
- 对机器人说“记住……”，Codex 会在 `workspace/memory/` 添加记忆
- 说“存成技能”，技能会保存到 `workspace/skills/`
- 桥接会在每次调用前同步技能到 `workspace/.agents/skills/`

## 致谢

本项目基于 [demry-max/feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge) 的飞书长连接、消息解析和扫码注册设计改造，并将 Agent 运行时替换为 Codex CLI。

MIT License
