# 故障排查 / Troubleshooting

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
