# 故障排查 / Troubleshooting

## Codex 机器人却提示运行 `claude /login`

当前桥接只启动 Codex CLI，不会调用 Claude。最常见原因是本机仍运行旧的 `feishu-claude-bridge`，且两个飞书机器人使用了相同显示名称；消息实际发给了旧 Claude 机器人。请在飞书开放平台为两个机器人设置不同名称，或停止不再使用的旧 Claude 后台服务。

新版还会在每次 Codex 调用中注入明确的运行时身份约束。若 Codex 回复本身错误声称 Claude 登录过期或要求运行 `claude /login`，桥接不会把该回复发到飞书，而是重置旧 thread 并通过 Codex 新会话自动重试。真正的 Codex 登录失效只会提示运行 `codex login`。

## Codex bot asks you to run `claude /login`

This bridge only launches Codex CLI. Usually, a legacy `feishu-claude-bridge` is still running and both Feishu bots have the same display name, so the message was sent to the old Claude bot. Give the bots distinct names in the Feishu developer console or stop the unused legacy service.

The current bridge also pins the runtime identity in every prompt. If a Codex response itself incorrectly reports an expired Claude login or asks for `claude /login`, the response is suppressed, the stale thread is reset, and the task is retried through Codex in a fresh session. Real Codex authentication failures point to `codex login`.

## 机器人能列出 memory 文件，但新会话不一定使用记忆

上游 Claude 版通过 `CLAUDE.md` 的 `@memory/MEMORY.md` 自动导入索引；Codex 的 `AGENTS.md` 只保证加载指令文件，不能把 Claude 的 `@import` 当成等价机制。桥接现在会在每次 owner 调用前直接读取 `workspace/memory/MEMORY.md` 并注入提示词，再由 Codex 按任务需要读取链接的明细文件。`/status` 会显示已自动加载的索引条数。

普通成员不会收到 owner 的记忆索引；密码、密钥和 token 不应写入任何记忆文件。

## 长任务在 300 秒后报超时

旧版使用固定 300 秒总运行上限，创建飞书文档、扫描大量聊天记录等仍在正常执行的任务也会被误杀。新版改为 300 秒“无活动”超时：只要 Codex 持续产生输出，计时器就会重置。默认最长运行时间为 30 分钟。

```dotenv
CODEX_IDLE_TIMEOUT_MS=300000
CODEX_MAX_RUNTIME_MS=1800000
```

## Long tasks time out after 300 seconds

Older versions used a fixed five-minute total runtime limit. The current bridge resets the idle timer whenever Codex emits output and keeps a separate 30-minute hard safety limit. Configure these with `CODEX_IDLE_TIMEOUT_MS` and `CODEX_MAX_RUNTIME_MS`.

## 机器人回答的模型名称不准确

模型本身不一定知道桥接层传入 Codex CLI 的精确模型 ID，因此让模型自我介绍可能得到错误答案。发送 `/model` 或“what model are you using?”时，桥接现在会直接返回 `CODEX_MODEL` 的实际配置，不再让模型猜测。`/status` 也会显示该值。

## Incorrect model name in the bot's answer

The model may not know the exact model ID supplied by the bridge to Codex CLI. Use `/model`; the bridge returns the configured `CODEX_MODEL` directly. `/status` includes the same value.

## `open.feishu.cn` 或 `registry.npmjs.org` 无法解析

如果 Codex 报告飞书 OpenAPI 或 npm 域名无法解析，通常不是域名故障，而是 `workspace-write` 沙箱默认没有网络权限。桥接现在为 owner 的会话传入：

```bash
--config sandbox_workspace_write.network_access=true
```

并默认设置 `CODEX_NETWORK_ACCESS=true`。如需禁用 owner 的沙箱联网，可在 `.env` 中设为 `false`。该设置不会给非 owner 的 `read-only` 会话开放网络。

## Cannot resolve `open.feishu.cn` or `registry.npmjs.org`

This usually means the Codex `workspace-write` sandbox has no outbound network permission, rather than a Feishu or npm outage. Owner sessions now pass `sandbox_workspace_write.network_access=true`; set `CODEX_NETWORK_ACCESS=false` to disable it. Non-owner read-only sessions remain offline.

## 读取 `.docx` 时要求用户批准 `unzip`，随后一直显示“上一个任务还在跑”

`codex exec` 是无人值守运行，飞书里无法响应终端审批；本机 execpolicy 规则还可能拦截复合命令。桥接现在为 owner 使用 `approval_policy="never"` 和 `--ignore-rules`，命令仍受 `workspace-write` 沙箱约束，但不会等待交互式批准。默认的 `AUTO_REDIRECT_WHEN_BUSY=true` 还会让新消息自动取消并接管旧任务。

从当前版本起，`.docx` 正文会在 Node.js 桥接层预先抽取并随提示词送给 Codex，不再依赖模型调用 `python3` 或 `unzip`。若模型仍输出 “This command requires approval”、要求终端批准，或错误建议修改 `~/.claude/settings.json`，该回复不会发给用户；桥接会自动追加无人值守约束并重试一次。

如需恢复交互式规则或旧的等待行为：

```dotenv
CODEX_IGNORE_EXEC_RULES=false
AUTO_REDIRECT_WHEN_BUSY=false
```

桥接不会使用 `--dangerously-bypass-approvals-and-sandbox` / `--yolo`。

## DOCX parsing asks for `unzip` approval, then the bot says a task is still running

Feishu cannot answer an interactive terminal approval during a headless `codex exec` run, and local execpolicy rules may reject compound commands. Owner sessions now use `approval_policy="never"` and `--ignore-rules`; commands still run inside the `workspace-write` sandbox. With the default `AUTO_REDIRECT_WHEN_BUSY=true`, a new message also cancels and replaces the unfinished run automatically. The bridge never enables `--yolo`.

The bridge now extracts `.docx` text in its Node.js process before invoking Codex, so document analysis does not depend on model-initiated `python3` or `unzip` calls. If a model still emits an approval deferral or points to Claude settings, that response is suppressed and retried once with an autonomous recovery instruction.

## 续聊时报 `unexpected argument '--sandbox' found`

症状：机器人首条消息能正常回复，但第二条消息或已有会话会返回：

```text
Codex CLI 失败(code 2): error: unexpected argument '--sandbox' found
Usage: codex exec resume --json --skip-git-repo-check [SESSION_ID] [PROMPT]
```

原因：`--sandbox` 是 `codex exec` 的参数，不是 `resume` 子命令的参数。如果参数组装为：

```bash
codex exec resume --json --sandbox workspace-write <THREAD_ID> -
```

Codex 会将 `--sandbox` 当成 `resume` 的未知参数。正确顺序是：

```bash
codex exec --sandbox workspace-write resume --json <THREAD_ID> -
```

本仓库已在 `src/codex.js` 中修复，并有自动测试防止回归。已安装用户可重新运行一键脚本升级：

```bash
curl -fsSL https://raw.githubusercontent.com/demry-max/feishu-codex-bridge/main/install.sh | bash
```

如果服务仍使用旧进程，可手动重启：

macOS：

```bash
launchctl kickstart -k "gui/$(id -u)/com.demrycheng.feishu-codex-bridge"
```

Linux：

```bash
systemctl --user restart feishu-codex-bridge.service
```

## Resume fails with `unexpected argument '--sandbox' found`

The first message succeeds, but the second message or any existing thread fails because `--sandbox` was placed after the `resume` subcommand. `--sandbox` belongs to `codex exec`, so it must appear before `resume`:

```bash
# Incorrect
codex exec resume --json --sandbox workspace-write <THREAD_ID> -

# Correct
codex exec --sandbox workspace-write resume --json <THREAD_ID> -
```

The fix is included in `src/codex.js` and covered by an automated regression test. Re-run the one-line installer above to update an existing installation and restart its background service.
