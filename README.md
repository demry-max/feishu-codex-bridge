# feishu-claude-bridge

**把 Claude Code 接进飞书** —— 私聊或群里 @机器人，让 Claude 回答问题、看图片、读文件、听语音，并保持上下文连续。无需公网服务器、域名、回调地址：飞书事件走长连接（WebSocket），跑在一台装有 Claude Code 的电脑上即可。

**Chat with Claude Code from Feishu/Lark** — DM the bot or @mention it in groups. Handles text, images, files, voice messages, and rich posts with persistent per-chat sessions. No public server needed: events arrive over Feishu's persistent WebSocket connection, so it runs on any machine with Claude Code installed.

姊妹项目：[dingtalk-claude-bridge](https://github.com/demry-max/dingtalk-claude-bridge)（钉钉版，免公网）· [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge)（企业微信版）

## 特性 Features

- 🔌 **零公网依赖**：长连接收事件，家用电脑即可部署
- 📲 **扫码即建应用**：`npm run register` 走飞书官方应用注册接口，扫一次码自动创建应用、写入凭据、登记 owner
- 🧠 **会话记忆**：每个飞书会话映射一个 Claude session（`--resume` 续聊），跨天跨周有效；`/new` 重开，`/status` 查看
- 🗂️ **Agent 工作区**：workspace 内置 CLAUDE.md 人格 + `memory/` 长期记忆（说「记住…」自动落盘、跨会话生效）+ `skills/` 技能沉淀（说「存成技能」自动生成 SKILL.md 并在后续会话自动加载）
- 🖼️ **多消息类型**：文本 / 图片（Claude 直接看图）/ 文件 / 语音（飞书转写字段 → ffmpeg + 语音识别 API 兜底）/ 富文本 / 合并转发 / 分享卡片
- 🔐 **权限分级**：首个私聊者自动成为 owner（本机只读工具 + 联网）；其他成员仅联网检索，碰不到主机文件
- 💰 **用订阅不用 API Key**：通过 `claude -p` 无头模式调用本机 Claude Code 登录态
- 🖥️ **macOS + Windows**：launchd / 启动项自启脚本齐备（Linux systemd 同理）

## 🗂️ Agent 工作区（Hermes 式记忆与技能）

机器人不只是问答机——`workspace/` 是它的常驻工作区，自带长期记忆与技能沉淀：

```
workspace/
├── CLAUDE.md          # 人格与行为协议（每次调用自动加载）
├── memory/            # 长期记忆：一条记忆 = 一个 md 文件
│   └── MEMORY.md      # 记忆索引，经 @import 每次对话自动注入
└── skills/            # 沉淀的技能，桥接自动同步到 .claude/skills 生效
```

- 对它说「**记住**：下周三去马尼拉出差」→ 自动写入 `memory/` 并更新索引，**跨会话、跨聊天窗口**持续生效（新会话即时可见，进行中的老会话 `/new` 后加载）
- 教它一个流程后说「**存成技能**」→ 自动生成 `skills/<name>/SKILL.md`，之后所有会话自动加载、匹配场景自动遵循
- 问「**你会哪些技能**」→ 随时盘点技能清单
- 安全边界：写权限**仅限** `memory/` 与 `skills/` 两个目录（Claude Code 本身禁止 agent 自写 `.claude` 配置目录，技能由桥接代码复制同步），且协议明确禁止把密码/密钥写入记忆


## 快速开始 Quick Start

```bash
npm install -g @anthropic-ai/claude-code   # 安装/更新 Claude Code CLI
claude /login                              # 弹出登录选项，浏览器完成授权

git clone https://github.com/demry-max/feishu-claude-bridge.git
cd feishu-claude-bridge
npm install
npm run register   # 飞书 App 扫码 → 应用自动创建，凭据自动写入 .env
npm start          # 日志出现 [ws] ws client ready 即成功
```

然后在飞书里私聊机器人发「你好」。前置条件：Node ≥ 18；可选 ffmpeg（语音兜底转写）。

- 开机自启（macOS）：参考 [examples/launchd.example.plist](examples/launchd.example.plist)
- 开机自启（Windows）：`powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1`
- 完整部署手册（可直接丢给 Claude Code 执行）：[docs/飞书-Claude-机器人架设方案.md](docs/飞书-Claude-机器人架设方案.md)
- 扫码注册失败时的手动配置：见手册附录 A

## 架构 Architecture

```
飞书私聊 / 群聊 @机器人
        │  长连接（WebSocket，im.message.receive_v1）
        ▼
桥接服务（Node.js 常驻：去重、串行队列、owner 鉴权、消息解析）
        │  spawn: claude -p --resume <会话ID> --allowedTools …（提示词走 stdin）
        ▼
Claude Code CLI（无头模式）
        │
        ▼
Markdown 卡片回复（失败自动降级纯文本）+ 表情回执
```

## 安全 Security

- `.env`（App Secret）与运行数据均被 `.gitignore` 排除
- 非 owner 无任何本机文件访问权限；附件目录仅只读放行
- 默认只授予 Claude 只读工具；请勿给无人值守机器人开 Write/Bash

## License

[MIT](LICENSE)
