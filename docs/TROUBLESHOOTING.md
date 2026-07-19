# 故障排查 / Troubleshooting

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
