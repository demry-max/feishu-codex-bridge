# feishu-codex-bridge

**English** | [中文](README.md)

Chat with the local Codex CLI from Feishu or Lark. The bridge uses Feishu's persistent WebSocket connection, so it needs no public server, domain, or callback URL.

## Features

- Persistent Codex thread per Feishu chat
- Text, image, file, voice, rich-post, and merged-forward messages
- QR-based Feishu app registration
- Durable workspace memory and project-scoped Codex skills
- Owner-only access by default
- macOS and Linux auto-start installation

## One-line install

Prerequisites: Git, Node.js 18+, and the Codex CLI.

```bash
curl -fsSL https://raw.githubusercontent.com/demry-max/feishu-codex-bridge/main/install.sh | bash
```

The installer checks your Codex login, clones the project, installs dependencies, guides you through Feishu QR registration, and installs a user-level background service.

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

## Security

Only the owner is allowed by default. Setting `ALLOW_NON_OWNER=true` opts into access for other users with Codex's `read-only` sandbox. A read-only sandbox prevents writes; it should not be treated as complete file-visibility isolation. Use a dedicated workspace without sensitive files.

Secrets in `.env`, owner/session data, incoming attachments, memories, and user-created skills are git-ignored.

## Credits

Based on the Feishu WebSocket, message parsing, and QR registration design of [demry-max/feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge), adapted to the Codex CLI.

MIT License
