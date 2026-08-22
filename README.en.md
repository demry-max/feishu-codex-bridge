# feishu-codex-bridge

[![version](https://img.shields.io/badge/version-1.4.0-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[中文](README.md) | **English**

Chat with the local Codex CLI from Feishu or Lark. The bridge uses Feishu's persistent WebSocket connection, so it needs no public server, domain, or callback URL.

## Features

- Persistent Codex thread per Feishu chat
- Live model switching with `/model sol high`, including scheduled `set-model` actions
- Text, image, file, voice, rich-post, and merged-forward messages
- QR-based Feishu app registration
- Durable workspace memory and project-scoped Codex skills
- Scheduled tasks, cancellation/redirect controls, outbound redaction, outbox uploads, and Feishu MCP tools
- Owner-only access by default
- macOS and Linux auto-start installation
- Optional private MCP connection for ChatGPT to search, read, and draft Lark Mail

## One-line install

Prerequisites: Git, Node.js 18+, and the Codex CLI.

```bash
curl -fsSL https://raw.githubusercontent.com/demry-max/feishu-codex-bridge/main/install.sh | bash
```

The installer checks your Codex login, clones the project, installs dependencies, guides you through Feishu QR registration, and installs a user-level background service.

For resume errors and service-update instructions, see [Troubleshooting](docs/TROUBLESHOOTING.md).

To use Lark Mail from ChatGPT through a private app, follow the [Lark Mail connection guide](docs/CHATGPT_LARK_MAIL.md).

Manual setup:

```bash
npm install -g @openai/codex
codex login
git clone https://github.com/demry-max/feishu-codex-bridge.git
cd feishu-codex-bridge
npm install
npm run register
npm start
```

Set `FEISHU_DOMAIN=lark` in `.env` before registration for international Lark.

Set `CODEX_REASONING_EFFORT=xhigh` for Extra high reasoning and `CODEX_SERVICE_TIER=fast` for Codex Fast mode. Fast mode uses more credits.

Owner sessions enable outbound access in the `workspace-write` sandbox by default so `lark-cli`, npm, and Feishu OpenAPI can work. Set `CODEX_NETWORK_ACCESS=false` to disable it. Non-owner `read-only` sessions do not receive network access from this setting.

Headless bridge runs use `CODEX_APPROVAL_POLICY=never` so they never wait for an approval that cannot be answered from Feishu. Owner runs also default to `CODEX_IGNORE_EXEC_RULES=true`, allowing document tools such as `unzip` to run inside the existing `workspace-write` sandbox. The bridge does not use `--yolo`, so sandbox restrictions remain enforced.

Long-running active tasks are not stopped merely because they exceed five minutes. `CODEX_IDLE_TIMEOUT_MS` resets whenever Codex produces output, while `CODEX_MAX_RUNTIME_MS` remains a final safety cap. The legacy `CODEX_TIMEOUT_MS` is still accepted as an idle-timeout fallback.

`ENABLE_PROGRESS_UPDATES=false` is the default, so Feishu receives only the final result. Set it to `true` to opt into intermediate status messages for long tasks.

`AUTO_REDIRECT_WHEN_BUSY=true` is the default. A new message in the same chat cancels and replaces an unfinished task instead of requiring a manual `/cancel` or `/redirect`. Set it to `false` to restore the v1.4.0 waiting prompt.

## Security

Only the owner is allowed by default. Setting `ALLOW_NON_OWNER=true` opts into access for other users with Codex's `read-only` sandbox. Owner network access can be disabled with `CODEX_NETWORK_ACCESS=false`. A read-only sandbox prevents writes; it should not be treated as complete file-visibility isolation. Use a dedicated workspace without sensitive files.

Secrets in `.env`, owner/session data, incoming attachments, memories, and user-created skills are git-ignored.

## Credits

Based on the Feishu WebSocket, message parsing, and QR registration design of [demry-max/feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge), adapted to the Codex CLI.

MIT License
