import fs from 'node:fs';
import spawn from 'cross-spawn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions, saveSessions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace');
export function resolveTimeouts(env = process.env) {
  const positiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    idleTimeoutMs: positiveNumber(
      env.CODEX_IDLE_TIMEOUT_MS || env.CODEX_TIMEOUT_MS,
      300_000
    ),
    maxRuntimeMs: positiveNumber(env.CODEX_MAX_RUNTIME_MS, 1_800_000),
  };
}

const { idleTimeoutMs: CODEX_IDLE_TIMEOUT_MS, maxRuntimeMs: CODEX_MAX_RUNTIME_MS } =
  resolveTimeouts();
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || '';
const CODEX_SERVICE_TIER = process.env.CODEX_SERVICE_TIER || '';

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
    `- 推理强度: ${CODEX_REASONING_EFFORT ? `\`${CODEX_REASONING_EFFORT}\`` : 'Codex CLI 默认值'}`,
    `- 服务速度: ${CODEX_SERVICE_TIER ? `\`${CODEX_SERVICE_TIER}\`` : 'Codex CLI 默认值'}`,
    `- 无活动超时: ${CODEX_IDLE_TIMEOUT_MS / 1000}s`,
    `- 最长运行: ${CODEX_MAX_RUNTIME_MS / 1000}s`,
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

export function createJsonlProgressParser(onProgress) {
  let buffer = '';
  let pendingAgentMessage = '';

  const emitPending = () => {
    const text = pendingAgentMessage.trim();
    pendingAgentMessage = '';
    if (text) onProgress(text);
  };

  const processLine = (line) => {
    if (!line.trim().startsWith('{')) return;
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        // 新的 agent message 证明前一条不是最终答案。
        emitPending();
        pendingAgentMessage = event.item.text || '';
        return;
      }
      if (event.type === 'turn.completed') {
        // 紧贴 turn.completed 的 agent message 是最终答案，由调用方统一回复。
        pendingAgentMessage = '';
        return;
      }
      if (
        pendingAgentMessage &&
        (event.type === 'item.started' ||
          (event.type === 'item.completed' && event.item?.type !== 'agent_message'))
      ) {
        // agent message 之后仍有工具活动，因此该消息是中间进度。
        emitPending();
      }
    } catch {
      // 忽略非 JSONL 日志。
    }
  };

  return {
    push(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    },
    finish() {
      if (buffer) processLine(buffer);
      buffer = '';
      // 结束时未发送的最后一条保留给最终回复。
      pendingAgentMessage = '';
    },
  };
}

export function buildCodexArgs(sid, isOwner = false, attachments = [], runtime = {}) {
  const model = runtime.model ?? CODEX_MODEL;
  const reasoningEffort = runtime.reasoningEffort ?? CODEX_REASONING_EFFORT;
  const serviceTier = runtime.serviceTier ?? CODEX_SERVICE_TIER;
  // --sandbox 属于 `codex exec` 而不是 `codex exec resume`，必须放在 resume 之前。
  const args = ['exec', '--sandbox', isOwner ? 'workspace-write' : 'read-only'];
  if (reasoningEffort) {
    args.push('--config', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  if (serviceTier) {
    args.push('--config', `service_tier=${JSON.stringify(serviceTier)}`);
    if (serviceTier === 'fast') args.push('--config', 'features.fast_mode=true');
  }
  if (sid) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (model) args.push('--model', model);
  for (const file of attachments) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(file)) args.push('--image', file);
  }
  if (sid) args.push(sid);
  args.push('-');
  return args;
}

export function runCodex(
  chatId,
  prompt,
  isOwner = false,
  attachments = [],
  onProgress = null
) {
  syncSkills();
  const sid = sessions[chatId];
  const args = buildCodexArgs(sid, isOwner, attachments);

  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { cwd: WORKSPACE_DIR, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let progressQueue = Promise.resolve();
    const progressParser = createJsonlProgressParser((text) => {
      if (!onProgress) return;
      progressQueue = progressQueue
        .then(() => onProgress(text))
        .catch((error) => console.error('[progress-reply]', error?.message ?? error));
    });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let idleTimer;
    const clearTimers = () => {
      clearTimeout(idleTimer);
      clearTimeout(maxRuntimeTimer);
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        clearTimers();
        child.kill('SIGKILL');
        fail(new Error(`Codex CLI 无活动超时（${CODEX_IDLE_TIMEOUT_MS / 1000}s）`));
      }, CODEX_IDLE_TIMEOUT_MS);
    };
    const maxRuntimeTimer = setTimeout(() => {
      clearTimers();
      child.kill('SIGKILL');
      fail(new Error(`Codex CLI 超过最长运行时间（${CODEX_MAX_RUNTIME_MS / 1000}s）`));
    }, CODEX_MAX_RUNTIME_MS);
    armIdleTimer();

    child.stdout.on('data', (d) => {
      stdout += d;
      progressParser.push(d);
      armIdleTimer();
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      armIdleTimer();
    });
    child.on('error', (e) => {
      clearTimers();
      fail(new Error(`Codex CLI 启动失败: ${e.message}`));
    });
    child.on('close', async (code) => {
      clearTimers();
      if (settled) return;
      progressParser.finish();
      await progressQueue;
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
