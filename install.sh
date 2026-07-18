#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/demry-max/feishu-codex-bridge.git"
INSTALL_DIR="${FEISHU_CODEX_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/feishu-codex-bridge}"

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "请先安装 Git"
command -v node >/dev/null || die "请先安装 Node.js 18+"
command -v npm >/dev/null || die "请先安装 npm"
command -v codex >/dev/null || die "请先安装 Codex CLI：npm install -g @openai/codex"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 18 )) || die "Node.js 需要 18 或更高版本"

if ! codex login status >/dev/null 2>&1; then
  say "请先完成 Codex 登录"
  codex login
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  say "更新现有安装：$INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  die "安装路径已存在且不是 Git 仓库：$INSTALL_DIR"
else
  say "下载 feishu-codex-bridge"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
say "安装 Node.js 依赖"
npm ci

if [[ ! -f .env ]]; then
  say "创建飞书应用（请扫描终端二维码）"
  npm run register
else
  say "已存在 .env，跳过飞书注册"
fi

case "$(uname -s)" in
  Darwin)
    LABEL="com.demrycheng.feishu-codex-bridge"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    LOG="$HOME/Library/Logs/feishu-codex-bridge.log"
    NODE_BIN="$(command -v node)"
    CODEX_BIN="$(command -v codex)"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    sed \
      -e "s|__LABEL__|$LABEL|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__CODEX_BIN__|$CODEX_BIN|g" \
      -e "s|__WORKDIR__|$INSTALL_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__LOG__|$LOG|g" \
      examples/launchd.template.plist > "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    ;;
  Linux)
    mkdir -p "$HOME/.config/systemd/user"
    sed \
      -e "s|__NODE_BIN__|$(command -v node)|g" \
      -e "s|__CODEX_BIN__|$(command -v codex)|g" \
      -e "s|__WORKDIR__|$INSTALL_DIR|g" \
      examples/feishu-codex-bridge.service > "$HOME/.config/systemd/user/feishu-codex-bridge.service"
    systemctl --user daemon-reload
    systemctl --user enable --now feishu-codex-bridge.service
    ;;
  *)
    die "该脚本支持 macOS/Linux；Windows 请按 README 操作"
    ;;
esac

say "安装完成！现在到飞书私聊机器人发送“你好”。"
