import fs from 'node:fs';
import spawn from 'cross-spawn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions, saveSessions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace');

// 访客工作区：非 owner 一律在此运行。
//
// `--sandbox read-only` 挡住的是**写**，不是读——而 cwd 此前对所有人都是同一个
// WORKSPACE_DIR，于是访客只要开口问，就能读出 memory/ 里 owner 的长期记忆
// （实测：一句「读 memory/MEMORY.md」就把记忆标题全列了出来）。
// 沙箱级别与工作区隔离是两件事，必须都做。
export const GUEST_WORKSPACE_DIR =
  process.env.GUEST_WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace-guest');

export function workspaceFor(isOwner) {
  return isOwner ? WORKSPACE_DIR : GUEST_WORKSPACE_DIR;
}

// chatId 可能含 : . 等字符（如 sched:weekly-review.json）。
// 必须保留区分度：早先把 '.' 也折叠成 '_'，导致 a.json 与 a_json 撞进同一个 outbox 目录。
const safeKey = (chatId) => {
  const raw = String(chatId);
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
  // 追加短哈希，杜绝不同 chatId 折叠后碰撞
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${cleaned}-${h.toString(36)}`;
};

// 定时任务/自诊断用的伪会话：一次性上下文，不 resume 也不持久化
export const isEphemeral = (chatId) => typeof chatId === 'string' && chatId.startsWith('sched');

/**
 * 本轮专属的文件回传目录。共享一个 outbox 会导致跨会话错发：
 * 定时任务写的文件会被下一条任意消息顺手发走。
 */
export function outboxDirFor(chatId, isOwner = true) {
  return path.join(workspaceFor(isOwner), 'outbox', safeKey(chatId));
}



const GUEST_AGENTS_MD = `# 访客助手工作区

你是通过飞书对话的 AI 助手，正在回应**非 owner 的同事或群成员**。

## 边界

- 你只有联网检索能力，没有本机文件、长期记忆、技能、定时任务的访问权。
- 你**不掌握**机器人主人的任何个人信息、公司内部资料或历史对话。被问到这类问题时，
  如实说明你在访客模式下没有这些信息，请对方直接找本人，不要猜测或编造。
- 不要声称自己能记住本次对话之外的事——访客会话不写入长期记忆。

## 行为约定

- 回答简洁直接，中文优先。
- 回复经飞书 markdown 卡片展示，可用代码块、表格、加粗。
`;

// 首次运行自动建好访客工作区（幂等：已存在则不覆盖，允许自定义）
function ensureGuestWorkspace() {
  try {
    fs.mkdirSync(path.join(GUEST_WORKSPACE_DIR, 'incoming'), { recursive: true });
    fs.mkdirSync(path.join(GUEST_WORKSPACE_DIR, 'outbox'), { recursive: true });
    const md = path.join(GUEST_WORKSPACE_DIR, 'AGENTS.md');
    if (!fs.existsSync(md)) fs.writeFileSync(md, GUEST_AGENTS_MD);
  } catch (e) {
    console.error('[guest-workspace]', e?.message ?? e);
  }
}
ensureGuestWorkspace();

// 记忆索引：仓库里只存模板，运行时文件不入库——
// 否则机器人往记忆里写的任何东西都会随下次提交进入公开仓库。
function ensureMemoryIndex() {
  try {
    const dir = path.join(WORKSPACE_DIR, 'memory');
    fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
    // 画像层与事实层索引都只在仓库里存模板，运行时文件不入库
    for (const name of ['MEMORY.md', 'USER.md']) {
      const live = path.join(dir, name);
      const tpl = path.join(dir, `${name}.template`);
      if (!fs.existsSync(live) && fs.existsSync(tpl)) {
        fs.copyFileSync(tpl, live);
        console.log(`[memory] 已从模板创建 memory/${name}`);
      }
    }
  } catch (e) {
    console.error('[memory-index]', e?.message ?? e);
  }
}
ensureMemoryIndex();
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
const MEMORY_INDEX_MAX_CHARS = 16_000;

const sessions = loadSessions(); // { [chatId]: threadId }
const running = new Map(); // { [chatId]: ChildProcess }

export const MODEL_ALIASES = {
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
};
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 启动自检：确认桥接实际会调用的那个 codex 可用。
 *
 * 关键在于「实际会调用的那个」——本机可能装了多份 codex（nvm 一份、homebrew 一份，
 * 实测版本分别是 0.144.4 与 0.147.0），而子进程按 CODEX_BIN / PATH 顺序解析。
 * 升级了终端里那份、而进程管理器指向另一份时，模型请求会直接被服务端拒绝
 * （"requires a newer version of Codex"），而桥接自身看着一切正常。
 */
// 模型对 CLI 版本的最低要求。写在这里而不是靠试错，是因为版本不够时
// 报错发生在**用户发消息那一刻**（"requires a newer version of Codex"），
// 而不是启动时——桥接看着一切正常，人却收到 400。
const MODEL_MIN_CLI = [
  { re: /^gpt-6/, min: '0.150.0' },
];

const cmpVer = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};

export function checkCliEnvironment(model = CODEX_MODEL) {
  const res = { bin: CODEX_BIN, version: null, ok: false, problem: null };
  try {
    const out = spawn.sync(CODEX_BIN, ['--version'], { encoding: 'utf8', env: process.env });
    if (out.error) {
      res.problem = `找不到可执行的 codex（PATH=${process.env.PATH}）：${out.error.message}`;
      return res;
    }
    const which = spawn.sync(process.platform === 'win32' ? 'where' : 'which', [CODEX_BIN], {
      encoding: 'utf8',
      env: process.env,
    });
    if (which.stdout) res.bin = which.stdout.trim().split('\n')[0];
    res.version = (String(out.stdout ?? '').match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? null;
    if (!res.version) {
      res.problem = `无法解析 codex 版本：${String(out.stdout ?? out.stderr ?? '').slice(0, 120)}`;
      return res;
    }
    const need = MODEL_MIN_CLI.find((m) => m.re.test(model ?? ''));
    if (need && cmpVer(res.version, need.min) < 0) {
      res.problem =
        `模型 ${model} 需要 codex CLI ≥ ${need.min}，但 ${res.bin} 是 ${res.version}。` +
        `请升级该路径下的 codex（注意本机可能装了多份，CODEX_BIN 与 PATH 里靠前的那份才生效），或改用其他模型。`;
      return res;
    }
    res.ok = true;
    return res;
  } catch (e) {
    res.problem = `CLI 自检失败：${e?.message ?? e}`;
    return res;
  }
}

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

// 别名解析与校验：非法值回落到全局配置并告警，不把垃圾直接传给 CLI。
// 抽成函数是为了让 /model、set-model 定时动作、任务级 model 三条路径行为一致——
// 此前只有 setRuntimeConfig 内联做校验，任务里写的别名走不到这层。
export function normalizeModel(v) {
  if (v === undefined || v === null || v === '') return null;
  const resolved = MODEL_ALIASES[String(v).toLowerCase()] ?? String(v).trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(resolved)) {
    console.error(`[config] 忽略非法模型名「${v}」，回落到全局配置`);
    return null;
  }
  return resolved;
}
export function normalizeEffort(v) {
  if (v === undefined || v === null || v === '') return null;
  const e = String(v).toLowerCase().trim();
  if (!EFFORT_LEVELS.includes(e)) {
    console.error(`[config] 忽略非法思考档「${v}」，回落到全局配置`);
    return null;
  }
  return e;
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

// 上下文接近压缩点时提醒机器人先固化记忆的阈值（0 = 关闭）
const CONTEXT_NUDGE_TOKENS = Number(process.env.CONTEXT_NUDGE_TOKENS ?? 850_000);
const contextSize = new Map();  // chatId → 最近一轮喂入的上下文规模
const nudgePending = new Set(); // 待注入提醒的会话

export function getContextTokens(chatId) {
  return contextSize.get(chatId) ?? 0;
}
export function getNudgeThreshold() {
  return CONTEXT_NUDGE_TOKENS;
}
// 有待提醒则返回 true 并清位（取走即消费，保证只注入一次）
export function consumeMemoryNudge(chatId) {
  if (!nudgePending.has(chatId)) return false;
  nudgePending.delete(chatId);
  nudgeInFlight.add(chatId); // 只是「已注入」；真正跑成功后才允许回收会话
  return true;
}

// 注入了固化提醒、但还不知道那一轮成没成功
const nudgeInFlight = new Set();

// 记忆已固化、可以安全重开会话的标记
const memoryFlushed = new Set();

/**
 * 固化提醒已被执行过的会话，下一轮开始前重开——
 * 该留的已经落盘到 memory/，继续背着上百万 token 的历史只是在重复付钱。
 * 取走即消费，避免反复重置。
 */
export function shouldRecycleSession(chatId) {
  if (!memoryFlushed.has(chatId)) return false;
  memoryFlushed.delete(chatId);
  const ctx = contextSize.get(chatId) ?? 0;
  return ctx >= CONTEXT_NUDGE_TOKENS; // 仍然很大才回收；已经小了就不折腾
}

function noteContext(chatId, ctx) {
  contextSize.set(chatId, ctx);
  if (CONTEXT_NUDGE_TOKENS > 0 && ctx >= CONTEXT_NUDGE_TOKENS && !nudgePending.has(chatId)) {
    nudgePending.add(chatId);
    console.log(`[context] ${chatId} 上下文 ${ctx.toLocaleString()} ≥ 阈值，下一轮将提醒固化记忆`);
  }
}

// /new 的代际计数：任务运行期间被重置时，本轮的 session_id 不得回写
const resetGeneration = new Map();


// 可中止的退避等待：/cancel 在重试间隙也必须生效，
// 否则用户看到「已取消」而重试照常发生（或被告知「没有正在运行的任务」）
const retryWaiters = new Map(); // chatId → { cancel }
export function abortRetries(chatId) {
  const w = retryWaiters.get(chatId);
  if (!w) return false;
  w.cancel();
  return true;
}
const sleepAbortable = (chatId, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      retryWaiters.delete(chatId);
      resolve();
    }, ms);
    retryWaiters.set(chatId, {
      cancel: () => {
        clearTimeout(timer);
        retryWaiters.delete(chatId);
        const err = new Error('CANCELLED');
        err.cancelled = true;
        reject(err);
      },
    });
  });


export function isRunning(chatId) {
  return running.has(chatId) || retryWaiters.has(chatId);
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

// 群里 owner 需要清扫「该群下所有访客」的会话/运行，键里带 open_id 故按前缀枚举
export function sessionKeysWithPrefix(prefix) {
  return Object.keys(sessions).filter((k) => k.startsWith(prefix));
}
export function runningKeysWithPrefix(prefix) {
  return [...running.keys()].filter((k) => k.startsWith(prefix));
}

export function resetSession(chatId) {
  delete sessions[chatId];
  saveSessions(sessions);
  // 代际 +1：正在跑的那一轮结束时不得把旧 session 写回来（否则 /new 被静默撤销）
  resetGeneration.set(chatId, (resetGeneration.get(chatId) ?? 0) + 1);
  contextSize.delete(chatId);
  nudgePending.delete(chatId);
  memoryFlushed.delete(chatId);
}

const AUTONOMOUS_RUN_INSTRUCTIONS = [
  '[桥接运行约束]',
  '当前运行时是 Codex CLI，不是 Claude Code。不得声称正在使用 Claude，也不得要求用户运行 claude /login；Codex 认证只使用 codex login。',
  '这是无人值守的 codex exec 会话，用户无法响应终端审批。',
  '遇到某个命令不可用或被策略拒绝时，立即改用当前沙箱内的安全替代方案并继续完成任务。',
  '不要要求用户批准或代跑 python、unzip 等本机命令，不要引用或建议修改 ~/.claude/settings.json。',
  '只向用户返回最终结果；除非确实需要用户提供业务信息，否则不要把技术排障步骤交给用户。',
].join('\n');

/**
 * 加载注入上下文的记忆：画像层（USER.md）+ 事实层索引（MEMORY.md）。
 *
 * 三层结构里只有这两层随每次调用注入——流水层（journal/）体量大且时效性强，
 * 交给关键词召回按需提示，不占固定上下文。
 * Codex 不像 Claude Code 有 @import，所以由桥接显式拼装。
 */
export function loadMemoryIndex(workspaceDir = WORKSPACE_DIR) {
  const readOr = (...seg) => {
    try {
      return fs.readFileSync(path.join(workspaceDir, ...seg), 'utf8').replace(/\0/g, '').trim();
    } catch {
      return '';
    }
  };
  const profile = readOr('memory', 'USER.md');
  const index = readOr('memory', 'MEMORY.md');
  const parts = [];
  if (profile) parts.push(`## 用户画像（memory/USER.md）\n${profile}`);
  if (index) parts.push(`## 记忆索引（memory/MEMORY.md）\n${index}`);
  return parts.join('\n\n').slice(0, MEMORY_INDEX_MAX_CHARS);
}

/**
 * 运行配置随每次调用注入，而不是写共享的 runtime.md：
 * 定时任务与聊天是并发的两个 codex 进程、共享同一工作区，写文件必然互相覆盖，
 * 模型会读到别人的 chat_id（进而把排期发错会话）。逐次注入天然无竞态。
 */
export function buildRuntimeContext(chatId, runtime = {}) {
  const realChat = typeof chatId === 'string' && !chatId.startsWith('sched') ? chatId : null;
  return [
    '[当前运行配置（桥接注入，权威来源）]',
    `- 模型：${runtime.model ?? CODEX_MODEL ?? '（Codex CLI 默认）'}`,
    `- 推理强度：${runtime.reasoningEffort ?? CODEX_REASONING_EFFORT ?? '（Codex CLI 默认）'}`,
    `- 服务速度：${runtime.serviceTier ?? CODEX_SERVICE_TIER ?? '（Codex CLI 默认）'}`,
    `- 当前会话 chat_id：${realChat ?? '（本次为定时任务，无对应会话）'}`,
    '被问到「你用什么模型/什么档位」时以上面为准，不要凭自身记忆推测。',
    realChat
      ? '创建定时任务时，chat_id 直接用上面这个值，不要编造。'
      : '本次是定时任务，没有可用的 chat_id；不要创建需要 chat_id 的新任务。',
  ].join('\n');
}

export function buildAutonomousPrompt(prompt, { memoryIndex = '', runtimeContext = '' } = {}) {
  const memoryContext = memoryIndex
    ? [
        '[长期记忆（桥接自动加载）]',
        '以下是画像层（memory/USER.md）与事实层索引（memory/MEMORY.md）。',
        '把它作为跨会话背景；与当前用户指令冲突时以当前指令为准。',
        '仅在任务相关时读取索引链接的 memory/*.md；流水层在 memory/journal/ 里按需检索。',
        '不要在回复中复述整个记忆结构。',
        '--- 记忆开始 ---',
        memoryIndex,
        '--- 记忆结束 ---',
      ].join('\n')
    : '';
  return [AUTONOMOUS_RUN_INSTRUCTIONS, runtimeContext, memoryContext, String(prompt ?? '')]
    .filter(Boolean)
    .join('\n\n');
}

export function isApprovalDeferral(answer) {
  const text = String(answer ?? '');
  return [
    /this command requires approval/i,
    /~\/\.claude\/settings\.json/i,
    /(?:需要|请|必须).{0,24}(?:批准|审批|授权).{0,40}(?:python|unzip|textutil|命令|运行)/is,
    /(?:python|unzip|textutil|命令|运行).{0,40}(?:需要|请|必须).{0,24}(?:批准|审批|授权)/is,
    /(?:终端|terminal).{0,30}(?:批准|approve|approval)/is,
  ].some((pattern) => pattern.test(text));
}

export function isClaudeRuntimeLeak(answer) {
  const text = String(answer ?? '');
  return [
    /Claude\s*(?:CLI|Code)?\s*(?:登录|认证|身份验证).{0,24}(?:过期|失效|失败|重新)/is,
    /(?:运行|执行|run|try).{0,30}`?claude\s+\/?login`?/is,
    /Not logged in.{0,40}(?:claude\s+)?\/?login/is,
  ].some((pattern) => pattern.test(text));
}

export function buildRuntimeIdentityRecoveryPrompt(originalPrompt) {
  return [
    '[运行时身份自动恢复]',
    '上一条回复无效：它把本服务错误识别成了 Claude。',
    '本服务只通过 Codex CLI 执行，当前助手身份是 Codex；不得声称使用 Claude，不得要求运行 claude /login。',
    '现在从头完成原始任务，只返回最终结果。若 Codex 认证确实失败，应报告需要 codex login。',
    '',
    '原始任务：',
    String(originalPrompt ?? ''),
  ].join('\n');
}

export function buildApprovalRecoveryPrompt(originalPrompt) {
  return [
    '[自动恢复]',
    '上一条回复无效：它把无人值守环境中的工具限制错误地变成了用户审批请求。',
    '现在直接继续原任务。不得要求用户批准、打开终端、代跑命令或修改任何 Claude 配置。',
    '如果首选工具不可用，使用安全替代方案；如果附件正文已由桥接层提供，直接使用正文。',
    '仅在所有安全替代方案都失败时，用一句话说明客观限制，不要给用户技术操作步骤。',
    '',
    '原始任务：',
    String(originalPrompt ?? ''),
  ].join('\n');
}

export function sessionInfo(chatId, isOwner = false) {
  const sid = sessions[chatId];
  const memoryIndex = isOwner ? loadMemoryIndex() : '';
  const memoryCount = (memoryIndex.match(/^\s*-\s+\[[^\]]+\]\([^)]+\.md\)/gm) ?? []).length;
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
    `- 长期记忆: ${isOwner ? `已自动加载索引（${memoryCount} 条）` : '未向普通成员加载'}`,
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
  const cwd = workspaceFor(isOwner);
  const model = normalizeModel(runtime.model) ?? CODEX_MODEL;
  const reasoningEffort = normalizeEffort(runtime.reasoningEffort) ?? CODEX_REASONING_EFFORT;
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
  // 仍返回数组以保持既有调用方式；附带 cwd 供测试与调用方断言身份分叉
  Object.defineProperty(args, 'cwd', { value: cwd, enumerable: false });
  return args;
}

function runCodexOnce(
  chatId,
  prompt,
  isOwner = false,
  attachments = [],
  onProgress = null
) {
  if (isOwner) syncSkills(); // 访客工作区没有技能目录，也不该有
  const sid = sessions[chatId];
  const args = buildCodexArgs(sid, isOwner, attachments);

  return new Promise((resolve, reject) => {
    // cwd 必须按身份分叉：read-only 沙箱允许读 cwd 下的一切，
    // 共用工作区等于把 owner 的 memory/ 直接摊给访客
    const child = spawn(CODEX_BIN, args, { cwd: workspaceFor(isOwner), env: process.env });
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

    child.stdin.end(
      buildAutonomousPrompt(prompt, {
        memoryIndex: isOwner ? loadMemoryIndex() : '',
        runtimeContext: buildRuntimeContext(chatId),
      })
    );
  });
}

// ---- 断连自动重试 ----
const CODEX_MAX_RETRIES = Number(process.env.CODEX_MAX_RETRIES ?? 2);
const RETRY_DELAYS_MS = [3_000, 15_000];

const RETRYABLE =
  /Connection (lost|error|closed|reset)|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error|stream (error|disconnected)|Internal server error|overloaded|\b(502|503|529)\b/i;
// 这些即便字面上像网络问题也不该重试
const NEVER_RETRY = /Not logged in|OAuth|authenticate|Invalid API|超时|CANCELLED|启动失败/i;


/**
 * 运行 codex，网络类失败自动重试（默认最多 2 次，退避 3s / 15s）。
 * 次数用 CODEX_MAX_RETRIES 调整，设 0 关闭。
 *
 * 只重试「还没动过手」的早期失败：一旦模型开始输出，就可能已经写过文件、
 * 发过消息、改过记忆——整段重放会造成双写，比不重试更糟。
 */
export async function runCodex(chatId, prompt, isOwner = false, attachments = [], onProgress = null) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runCodexOnce(chatId, prompt, isOwner, attachments, onProgress);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (e?.producedOutput && !e?.cancelled && RETRYABLE.test(msg)) {
        console.log(`[retry] ${chatId} 已产生输出，断连后不自动重放（避免重复写入/重复发送）`);
        e.message = `${msg}\n（任务已执行到一半，为避免重复写入未自动重试——请确认副作用后手动重发）`;
        throw e;
      }
      const retryable =
        !e?.cancelled && !NEVER_RETRY.test(msg) && RETRYABLE.test(msg) && attempt < CODEX_MAX_RETRIES;
      if (!retryable) throw e;
      const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      console.log(
        `[retry] ${chatId} 网络类失败，${delay / 1000}s 后重试（${attempt + 1}/${CODEX_MAX_RETRIES}）：${msg.slice(0, 120)}`
      );
      if (onProgress) {
        try {
          await onProgress(`⚠️ 连接中断，${delay / 1000} 秒后自动重试（第 ${attempt + 1}/${CODEX_MAX_RETRIES} 次）`);
        } catch {}
      }
      await sleepAbortable(chatId, delay);
    }
  }
}
