# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-08-10

### 新增
- **`/model` 指令**：在聊天里直接查看/切换模型与思考档，如 `/model sol high`、`/model terra xhigh`、
  `/model high`（只改档位）。**立即生效、无需重启**，并同步回写 `.env` 让重启后保持。仅 owner 可用，
  取值走白名单校验（模型名格式 + `low/medium/high/xhigh/max`）。
- **定时切换模型**：定时任务支持 `"action": "set-model"`，配 `model` / `effort` 字段即可按 cron 或
  一次性时间自动切档，例如工作日早八点自动切回便宜档位。

### 修复
- **模型配置此前必须重启才能生效**：`CODEX_MODEL` / `CODEX_REASONING_EFFORT` 从模块加载时的常量改为运行时变量。
- **弃用外部定时脚本**：原先靠 macOS launchd 拉起 shell 脚本改配置，在外置卷（exFAT）上会被系统拦下
  （`Operation not permitted`，TCC 层面），定时切换静默失败。现由桥接自身的调度器执行，不再依赖 launchd。
- **无头命令等待审批**：owner 任务改为 `approval_policy="never"` 并忽略交互式 execpolicy 规则，`unzip` 等命令可在 `workspace-write` 沙箱内直接执行，不启用 `--yolo`。
- **旧任务阻塞新消息**：默认自动取消并接管同一会话中未完成的旧任务，可用 `AUTO_REDIRECT_WHEN_BUSY=false` 恢复手动控制。

## [1.3.1] - 2026-07-31

### 修复
- **升级后旧配置导致长任务被误杀**：v1.3.0 把超时策略从固定硬上限改为活动式超时，
  但老 `.env` 里常见的 `300000`（5 分钟）会让上限反而变得比空闲超时还短，长任务必然被杀
  （实测：一个需要串行拉日程、审批、会话记录的周报任务每次都在 5 分钟被终止）。
  现在启动时自检：若绝对上限小于空闲超时，打印明确告警并自动提升到合理值。
  **升级建议**：使用 `CODEX_IDLE_TIMEOUT_MS` 与 `CODEX_MAX_RUNTIME_MS` 分别配置空闲和绝对上限。

## [1.3.0] - 2026-07-26

对照 GitHub 同类项目（ofoxai/lark-claude-bot、Kirafy123/feishu-claude-bot、yangwhale/CloseCrab）补齐的能力。

### 新增
- **活动式超时**：只要 Codex 还在输出就不计时，静默超过 `CODEX_IDLE_TIMEOUT_MS` 才判定卡死，
  另设 `CODEX_MAX_RUNTIME_MS` 作为绝对上限。此前是 5 分钟硬超时，长任务会被误杀。
- **`/cancel` 取消任务**：随时终止正在运行的任务，解除会话队列阻塞。
- **`/redirect <新要求>`**：中断当前任务并按新要求重来，会话上下文保留。
- **任务进行中提示**：跑任务时收到新消息会提示可 `/cancel` 或 `/redirect`，不再默默排队。
- **出站脱敏**：所有回复送出前抹掉 API key、token、JWT、`Bearer`/`password` 字面量与内网 IP，
  运行时凭据（App Secret 等）也一并过滤。
- **结构化进度**：进度卡片以 ✅/🔄 标记各步骤状态，完成后整体转为 ✅。
- **定时任务失败自诊断**：任务失败时自动触发一次诊断，给出失败类别、根因判断与建议动作，随报错一起推送。
- **`/voice` 语音回复**：开启后回答附带一条语音消息（macOS `say` + ffmpeg/libopus 合成）。
- **飞书电子表格工具**：MCP 新增 `sheet_read` / `sheet_write`（工具总数 9 个）。

### 说明
- 飞书邮件工具未做：企业邮箱 API 走用户身份授权，与本项目「只用应用租户凭据」的安全模型不符。

## [1.2.0] - 2026-07-26

对齐 OpenClaw 飞书扩展的能力缺口。

### 新增
- **飞书文档 / 多维表格读写**：内置 MCP 工具服务（`src/mcp-feishu.js`）暴露 7 个动作——读文档、追加段落、
  列数据表、列字段、读记录、新增记录、更新记录。用**机器人应用自己的租户凭据**，能碰什么由飞书后台 scope
  精确控制；**仅 owner 可用**，同事与群成员无法访问。可直接把飞书链接（`/docx/`、`/base/`、`/wiki/`）发给机器人。
- **回传图片与文件**：机器人写入 `workspace/outbox/` 的文件会在本轮回复后自动上传发送并清空；
  图片以图片消息发送、可直接预览。
- **进度卡片原地更新**：长任务的阶段说明改为更新同一张卡片（此前每段发一条新消息），完成后折叠为一行。
- **访问控制**：`ALLOW_USERS` / `ALLOW_CHATS` 白名单，留空保持原行为（不限制）。
- **群内发言人识别**：群消息带上发送者姓名，机器人知道是谁在说话（无通讯录权限时静默降级）。
- **`/help`**：列出指令与能力说明。

### 需要的新权限
开发者后台按需增开并发布版本：`docx:document:readonly`、`docx:document`、`bitable:app:readonly`、
`bitable:app`、`wiki:wiki:readonly`、`contact:user.base:readonly`。

## [1.1.0] - 2026-07-26

首次公开发布（1.0.0）之后累积的功能与修复。

### 新增
- **定时任务**：机器人可自行排期——对它说「每天八点提醒我…」，它会把任务定义写进 `workspace/schedules/*.json`，
  桥接到点执行并把结果主动推送到会话。支持 cron 表达式与一次性时间；cron 任务首次登记不补跑历史时间点，
  一次性任务执行后自动停用。**机器人不获得 Bash/命令执行权限**，只能写受限目录里的任务定义。
- **Agent 工作区**：`workspace/AGENTS.md` 人格协议 + `memory/` 长期记忆（说「记住…」自动落盘、跨会话生效）
  + `skills/` 技能沉淀（说「存成技能」自动生成 SKILL.md，桥接同步到 `.agents/skills` 后自动加载）。
- **中间进度实时推送**：长任务的阶段性说明即时发到会话（`⏳` 前缀），最终答案仍只发一次（基于 stream-json 解析与去重）。
- **思考深度可配**：`CODEX_REASONING_EFFORT`（low/medium/high/xhigh/max）。
- **`runtime.md` 运行配置**：桥接每次调用前写入真实模型、思考档位与当前 `chat_id`，
  机器人据此如实回答「你用什么模型」并自助填写定时任务的 `chat_id`。
- `/status` 增加模型与思考深度两项。

### 修复
- **语音转写在常驻模式下静默失败**：launchd 不继承终端 PATH，homebrew 的 ffmpeg（`/opt/homebrew/bin`）不可达；
  自启模板补上该目录，并新增 `FFMPEG_BIN` 绝对路径配置。
- **机器人误报自身模型**：无头模式下模型无从得知自己跑在哪个模型上，会凭记忆猜测；改由桥接写入 `runtime.md` 提供权威来源。
- 跳过 exFAT 外置盘产生的 `._*` 影子文件，避免被当成任务/技能解析。

## [1.0.0]

首次公开发布：长连接免公网接入、扫码自动创建应用、多消息类型（文本/图片/文件/语音/富文本/转发/卡片）、
会话持久续聊、owner 权限分级、macOS launchd 与 Windows 启动项自启。
