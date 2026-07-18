import fs from 'node:fs';
import spawn from 'cross-spawn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions, saveSessions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace');
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 300_000);
const CODEX_MODEL = process.env.CODEX_MODEL || '';

const sessions = loadSessions(); // { [chatId]: threadId }

function syncSkills() {
  const source = path.join(WORKSPACE_DIR, 'skills');
  const target = path.join(WORKSPACE_DIR, '.agents', 'skills');
  try {
    fs.mkdirSync(target, { recursive: true });
    if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true });
  } catch (error) {
    console.error('[skills-sync]', error?.message ?? error);
  }
}

export function resetSession(chatId) {
  delete sessions[chatId];
  saveSessions(sessions);
}

export function sessionInfo(chatId, isOwner = false) {
  const sid = sessions[chatId];
  return [
    '**会话状态**',
    `- Codex thread: ${sid ? `\`${sid}\`` : '（无，下一条消息将新建）'}`,
    `- 配置模型: ${CODEX_MODEL ? `\`${CODEX_MODEL}\`` : 'Codex CLI 默认模型（未显式指定）'}`,
    `- 工作目录: \`${WORKSPACE_DIR}\``,
    `- 你的身份: ${isOwner ? 'owner' : '普通成员'}`,
    `- 沙箱权限: ${isOwner ? 'workspace-write' : 'read-only'}`,
  ].join('\n');
}

export function isModelQuery(text) {
  const normalized = String(text)
    .trim()
    .toLowerCase()
    .replace(/[?？。！!]+$/g, '')
    .replace(/\s+/g, ' ');
  return (
    normalized === '/model' ||
    /^(what|which) model (are you using|do you use)$/.test(normalized) ||
    /^(你)?(现在|当前)?(在)?(用|使用)(的)?(是)?(什么|哪个)模型$/.test(normalized) ||
    /^(现在|当前)?(是)?(什么|哪个)模型$/.test(normalized)
  );
}

export function modelInfo() {
  return CODEX_MODEL
    ? `**当前模型**：\`${CODEX_MODEL}\`\n\n该值由桥接服务的 \`CODEX_MODEL\` 配置传入 Codex CLI。`
    : '**当前模型**：Codex CLI 默认模型（未设置 `CODEX_MODEL`）。';
}

export function parseJsonl(stdout) {
  let threadId = '';
  let answer = '';
  let error = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started') threadId = event.thread_id || threadId;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        answer = event.item.text || answer;
      }
      if (event.type === 'turn.failed') error = event.error?.message || 'Codex turn failed';
    } catch {
      // stderr 日志偶尔会混入输出；忽略非 JSONL 行。
    }
  }
  return { threadId, answer, error };
}

export function buildCodexArgs(sid, isOwner = false, attachments = []) {
  // --sandbox 属于 `codex exec` 而不是 `codex exec resume`，必须放在 resume 之前。
  const args = ['exec', '--sandbox', isOwner ? 'workspace-write' : 'read-only'];
  if (sid) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (CODEX_MODEL) args.push('--model', CODEX_MODEL);
  for (const file of attachments) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(file)) args.push('--image', file);
  }
  if (sid) args.push(sid);
  args.push('-');
  return args;
}

export function runCodex(chatId, prompt, isOwner = false, attachments = []) {
  syncSkills();
  const sid = sessions[chatId];
  const args = buildCodexArgs(sid, isOwner, attachments);

  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { cwd: WORKSPACE_DIR, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`Codex CLI 超时（${CODEX_TIMEOUT_MS / 1000}s）`));
    }, CODEX_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(new Error(`Codex CLI 启动失败: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      const out = parseJsonl(stdout);
      if (out.threadId) {
        sessions[chatId] = out.threadId;
        saveSessions(sessions);
      }
      if (out.error) return fail(new Error(out.error.slice(0, 500)));
      if (code !== 0 && !out.answer) {
        return fail(new Error(`Codex CLI 失败(code ${code}): ${stderr.slice(-500)}`));
      }
      settled = true;
      resolve(out.answer || String(stdout).trim());
    });

    child.stdin.end(prompt);
  });
}
