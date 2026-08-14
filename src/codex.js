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
let CODEX_MODEL = process.env.CODEX_MODEL || '';
let CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || '';
const CODEX_SERVICE_TIER = process.env.CODEX_SERVICE_TIER || '';
const CODEX_NETWORK_ACCESS = !/^(0|false|no)$/i.test(
  process.env.CODEX_NETWORK_ACCESS || 'true'
);
const CODEX_APPROVAL_POLICY = process.env.CODEX_APPROVAL_POLICY || 'never';
const CODEX_IGNORE_EXEC_RULES = !/^(0|false|no)$/i.test(
  process.env.CODEX_IGNORE_EXEC_RULES || 'true'
);
const FEISHU_TOOLS = process.env.FEISHU_TOOLS !== 'false';

const sessions = loadSessions(); // { [chatId]: threadId }
const running = new Map(); // { [chatId]: ChildProcess }

export const MODEL_ALIASES = {
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
};
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function getRuntimeConfig() {
  return {
    model: CODEX_MODEL,
    effort: CODEX_REASONING_EFFORT,
    serviceTier: CODEX_SERVICE_TIER,
  };
}

function patchEnvFile(updates) {
  const envPath = path.resolve(__dirname, '..', '.env');
  try {
    const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    for (const [key, value] of Object.entries(updates)) {
      const index = lines.findIndex((line) => line.startsWith(`${key}=`));
      const comment = index >= 0 ? (lines[index].match(/\s+#.*$/)?.[0] ?? '') : '';
      const next = `${key}=${value}${comment}`;
      if (index >= 0) lines[index] = next;
      else lines.push(next);
    }
    fs.writeFileSync(envPath, lines.join('\n'));
  } catch (error) {
    console.error('[config] 回写 .env 失败:', error?.message ?? error);
  }
}

export function setRuntimeConfig({ model, effort } = {}, { persist = true } = {}) {
  const updates = {};
  if (model !== undefined && model !== null && model !== '') {
    const resolved = MODEL_ALIASES[String(model).toLowerCase()] ?? String(model).trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(resolved)) throw new Error(`模型名不合法：${model}`);
    CODEX_MODEL = resolved;
    updates.CODEX_MODEL = resolved;
  }
  if (effort !== undefined && effort !== null && effort !== '') {
    const resolved = String(effort).toLowerCase().trim();
    if (!EFFORT_LEVELS.includes(resolved)) {
      throw new Error(`思考档不合法：${effort}（可选 ${EFFORT_LEVELS.join('/')}）`);
    }
    CODEX_REASONING_EFFORT = resolved;
    updates.CODEX_REASONING_EFFORT = resolved;
  }
  if (persist && Object.keys(updates).length) patchEnvFile(updates);
  return getRuntimeConfig();
}

export function isRunning(chatId) {
  return running.has(chatId);
}

export function cancelRun(chatId) {
  const child = running.get(chatId);
  if (!child) return false;
  child.__cancelled = true;
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出。
      }
    }, 2_000);
  } catch {
    // 已退出。
  }
  running.delete(chatId);
  return true;
}

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
    `- 沙箱联网: ${isOwner && CODEX_NETWORK_ACCESS ? '已启用' : '未启用'}`,
    `- 命令审批: ${CODEX_APPROVAL_POLICY}`,
    `- owner 命令规则: ${isOwner && CODEX_IGNORE_EXEC_RULES ? '忽略本机交互式规则' : '使用本机规则'}`,
    `- 飞书 MCP: ${isOwner && FEISHU_TOOLS ? '已启用' : '未启用'}`,
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

function writeRuntimeInfo(chatId) {
  try {
    const realChat = typeof chatId === 'string' && !chatId.startsWith('sched:') ? chatId : null;
    fs.writeFileSync(
      path.join(WORKSPACE_DIR, 'runtime.md'),
      [
        '# 当前运行配置（桥接自动生成，权威来源）',
        '',
        `- 模型：${CODEX_MODEL || '（Codex CLI 默认）'}`,
        `- 推理强度：${CODEX_REASONING_EFFORT || '（Codex CLI 默认）'}`,
        `- 服务速度：${CODEX_SERVICE_TIER || '（Codex CLI 默认）'}`,
        `- 当前会话 chat_id：${realChat ?? '（定时任务）'}`,
        '',
        '用户询问当前模型或推理档位时，以本文件为准。',
      ].join('\n') + '\n'
    );
  } catch (error) {
    console.error('[runtime-info]', error?.message ?? error);
  }
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
  const networkAccess = runtime.networkAccess ?? CODEX_NETWORK_ACCESS;
  const approvalPolicy = runtime.approvalPolicy ?? CODEX_APPROVAL_POLICY;
  const ignoreExecRules = runtime.ignoreExecRules ?? CODEX_IGNORE_EXEC_RULES;
  const feishuTools = runtime.feishuTools ?? FEISHU_TOOLS;
  // --sandbox 属于 `codex exec` 而不是 `codex exec resume`，必须放在 resume 之前。
  const args = ['exec', '--sandbox', isOwner ? 'workspace-write' : 'read-only'];
  if (isOwner && ignoreExecRules) args.push('--ignore-rules');
  if (approvalPolicy) {
    args.push('--config', `approval_policy=${JSON.stringify(approvalPolicy)}`);
  }
  if (isOwner && networkAccess) {
    args.push('--config', 'sandbox_workspace_write.network_access=true');
  }
  if (isOwner && feishuTools) {
    args.push('--config', `mcp_servers.feishu.command=${JSON.stringify(process.execPath)}`);
    args.push(
      '--config',
      `mcp_servers.feishu.args=${JSON.stringify([path.join(__dirname, 'mcp-feishu.js')])}`
    );
    args.push(
      '--config',
      'mcp_servers.feishu.env_vars=["FEISHU_APP_ID","FEISHU_APP_SECRET","FEISHU_DOMAIN"]'
    );
  }
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
  writeRuntimeInfo(chatId);
  const sid = sessions[chatId];
  const args = buildCodexArgs(sid, isOwner, attachments);

  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { cwd: WORKSPACE_DIR, env: process.env });
    running.set(chatId, child);
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
      running.delete(chatId);
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
      running.delete(chatId);
      if (settled) return;
      if (child.__cancelled) {
        const error = new Error('CANCELLED');
        error.cancelled = true;
        return fail(error);
      }
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
