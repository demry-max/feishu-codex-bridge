import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import {
  cancelRun,
  EFFORT_LEVELS,
  getRuntimeConfig,
  isRunning,
  isModelQuery,
  modelInfo,
  MODEL_ALIASES,
  buildApprovalRecoveryPrompt,
  buildRuntimeIdentityRecoveryPrompt,
  isApprovalDeferral,
  isClaudeRuntimeLeak,
  runCodex,
  resetSession,
  setRuntimeConfig,
  sessionInfo,
  WORKSPACE_DIR, checkCliEnvironment, workspaceFor, GUEST_WORKSPACE_DIR, outboxDirFor, abortRetries, shouldRecycleSession, consumeMemoryNudge, sessionKeysWithPrefix, runningKeysWithPrefix } from './codex.js';
import { buildPrompt, cleanIncoming, describeError } from './messages.js';
import { recallHint } from './memory-recall.js';
import { loadOwner, saveOwner, DATA_DIR } from './store.js';
import { startScheduler } from './scheduler.js';
import { CronExpressionParser } from 'cron-parser';
import { createProgressChannel, flushOutbox, migrateLegacyOutbox, resolveSenderName, redact, sendVoice } from './outbound.js';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const ALLOW_NON_OWNER = /^(1|true|yes)$/i.test(process.env.ALLOW_NON_OWNER || 'false');
const ENABLE_PROGRESS_UPDATES = /^(1|true|yes)$/i.test(
  process.env.ENABLE_PROGRESS_UPDATES || 'false'
);
const AUTO_REDIRECT_WHEN_BUSY = !/^(0|false|no)$/i.test(
  process.env.AUTO_REDIRECT_WHEN_BUSY || 'true'
);

if (!APP_ID || !APP_SECRET) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请检查 .env');
  process.exit(1);
}

// FEISHU_DOMAIN=lark 时接入国际版 Lark（open.larksuite.com）
const DOMAIN = process.env.FEISHU_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, domain: DOMAIN });
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: DOMAIN,
  loggerLevel: lark.LoggerLevel.info,
});

// 退出前先给正在跑的子进程一点收尾时间，并对连环重启加阻尼：
// 裸 exit(1) 配 进程管理器的重启节流，遇到持续性故障就是每天 8640 次重启
// 外加 8640 条飞书推送——比原来的「静默失聪」更糟。
const BAIL_COUNT_FILE = path.join(DATA_DIR, 'bail-count.json');
const BACKOFF_LADDER = [15_000, 60_000, 300_000, 900_000]; // 15s → 1m → 5m → 15m
const startedAt = Date.now();

// 连续失败次数跨重启累积：固定阻尼挡不住持续性故障，
// 进程一起来就再死会形成稳定的高频重启 + 推送风暴
function readBailCount() {
  try {
    const d = JSON.parse(fs.readFileSync(BAIL_COUNT_FILE, 'utf8'));
    return Number(d?.n) || 0;
  } catch { return 0; }
}
function bumpBailCount() {
  const n = readBailCount() + 1;
  try { fs.writeFileSync(BAIL_COUNT_FILE, JSON.stringify({ n, at: Date.now() })); } catch {}
  return n;
}
// 稳定运行足够久即认为已恢复，清零阶梯
setTimeout(() => {
  try { fs.rmSync(BAIL_COUNT_FILE, { force: true }); } catch {}
}, 5 * 60 * 1000).unref();

let exiting = false;
function bailOut(reason, delayMs = 0) {
  if (exiting) return;
  exiting = true;
  // 起来没多久就又要死＝持续故障，按阶梯拉长等待
  const n = Date.now() - startedAt < 5 * 60 * 1000 ? bumpBailCount() : 1;
  const wait = Math.max(delayMs, BACKOFF_LADDER[Math.min(n - 1, BACKOFF_LADDER.length - 1)]);
  console.error(`[exit] ${reason}（第 ${n} 次连续失败，${Math.round(wait / 1000)}s 后退出）`);
  setTimeout(() => process.exit(1), wait).unref();
}

// 进程级兜底：宁可重启，也不要带病静默运行（事件回调里的异常会直冲 uncaughtException）
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e?.stack ?? e);
  bailOut('uncaughtException', 2000);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection:', e?.stack ?? e);
});

// ---- 访问控制：留空=保持原行为（全员可私聊）；配置后仅名单内可用 ----
const parseList = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_USERS = parseList(process.env.ALLOW_USERS); // open_id 白名单
const ALLOW_CHATS = parseList(process.env.ALLOW_CHATS); // chat_id 白名单（群）
// owner 身份的权威来源：配了它，owner.json 丢失/损坏也能直接恢复，无需认领流程
const OWNER_OPEN_ID = (process.env.OWNER_OPEN_ID ?? '').trim();
const voiceChats = new Set(); // 开启语音回复的会话

function isAllowed(openId, chatId, isP2p) {
  if (isP2p) return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
  if (ALLOW_CHATS.length && !ALLOW_CHATS.includes(chatId)) return false;
  return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
}

const HELP_TEXT = [
  '**可用指令**',
  '- `/new` 开启全新会话（忘掉此前上下文）',
  '- `/status` 查看会话、模型、思考深度、可用工具',
  '- `/help` 显示本说明',
  '- `/cancel` 取消正在跑的任务',
  '- `/redirect <新要求>` 中断当前任务并按新要求重来',
  '- `/voice` 切换语音回复（回答附带一条语音）',
  '- `/tasks` 查看定时任务：上次/下次触发时间（仅 owner）',
  '- `/model [模型] [思考档]` 查看或切换模型，如 `/model sol high`（仅 owner）',
  '',
  '**能做什么**',
  '- 直接对话；群里 @我 即可',
  '- 发图片 / 文件 / 语音，我会读内容后回答',
  '- 说「记住…」我会写进长期记忆，跨会话生效',
  '- 说「存成技能」我会把流程固化下来，以后自动遵循',
  '- 说「每天八点提醒我…」我会自己排定时任务',
].join('\n');

// ---- 消息去重（飞书事件可能重投） ----
const seen = new Set();
function isDuplicate(messageId) {
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  if (seen.size > 1000) {
    for (const id of seen) {
      seen.delete(id);
      if (seen.size <= 500) break;
    }
  }
  return false;
}

// ---- 每个会话串行处理，避免并发 resume 冲突 ----
const chatQueues = new Map();
function enqueue(chatId, task) {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(task).catch((e) => console.error('[queue]', e));
  chatQueues.set(chatId, next);
  return next;
}

async function reply(messageId, text) {
  const safe = redact(text);
  const chunks = [];
  for (let i = 0; i < safe.length; i += 20000) chunks.push(safe.slice(i, i + 20000));
  for (const chunk of chunks) {
    try {
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            elements: [{ tag: 'markdown', content: chunk }],
          }),
        },
      });
    } catch (e) {
      // markdown 卡片失败时降级纯文本
      console.error('[reply] card failed, fallback to text:', e?.message ?? e);
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
      });
    }
  }
}

async function react(messageId, emoji) {
  try {
    await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
  } catch {
    // 无 reaction 权限时静默跳过
  }
}

// ---- 机器人自身 open_id（用于识别群聊 @提及） ----
let botOpenId = null;
async function getBotOpenId() {
  if (botOpenId) return botOpenId;
  try {
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = res?.bot?.open_id ?? null;
    if (botOpenId) console.log(`[bot] open_id = ${botOpenId}`);
  } catch (e) {
    console.error('[bot] 获取机器人信息失败:', e?.message ?? e);
  }
  return botOpenId;
}

async function handleMessage(data) {
  const message = data.message;
  const senderOpenId = data.sender?.sender_id?.open_id;
  if (!message || !senderOpenId) return;
  if (isDuplicate(message.message_id)) return;

  // 群聊仅在 @机器人 时响应
  if (message.chat_type !== 'p2p') {
    const bot = await getBotOpenId();
    const mentioned = (message.mentions ?? []).some(
      (m) => m?.id?.open_id && m.id.open_id === bot
    );
    if (!mentioned) return;
  }

  if (!isAllowed(senderOpenId, message.chat_id, message.chat_type === 'p2p')) {
    console.log(`[deny] ${senderOpenId} @ ${message.chat_id} 不在白名单`);
    return;
  }

  // ---- owner：首个私聊者自动认领，owner 享有本机工具，其他人仅联网工具 ----
  let owner = OWNER_OPEN_ID || loadOwner();
  if (!owner && message.chat_type === 'p2p') {
    // 收紧自动认领：owner 记录一旦丢失，下一个私聊的人就会继承全部权限
    if (!OWNER_OPEN_ID && process.env.ALLOW_OWNER_CLAIM !== 'true') {
      console.error(`[owner] owner 记录缺失且未开放认领。确需重新认领请在 .env 设 ALLOW_OWNER_CLAIM=true 后重启。请求者：${senderOpenId}`);
      await reply(message.message_id, '⚠️ 机器人的 owner 记录缺失，出于安全未自动认领。请在主机上恢复 data/owner.json 或按日志提示配置后重启。');
      return;
    }
    owner = senderOpenId;
    if (!saveOwner(owner)) {
      await reply(message.message_id, '⚠️ owner 记录写入失败（磁盘不可写），未完成登记。请检查主机磁盘后重试。');
      return;
    }
    console.log(`[owner] 已锁定 owner open_id = ${owner}`);
    await reply(
      message.message_id,
      `✅ 已将你登记为本机器人 owner（open_id: \`${owner}\`）。\n直接发消息即可对话；发送 **/new** 开启新会话，**/status** 查看会话状态。`
    );
    return;
  }
  const isOwner = senderOpenId === owner;

  // 会话键区分身份：群里 owner 与访客共用 chat_id，若共用 session，
  // 访客一次 resume 就能续到 owner 那条带记忆的会话，工作区隔离会被绕过。
  // 访客再按发言人细分，避免同群访客互相看到历史或被单人植入长效指令。
  const sessionKey = isOwner ? message.chat_id : `guest:${message.chat_id}:${senderOpenId}`;
  if (!isOwner && !ALLOW_NON_OWNER) {
    await reply(message.message_id, '⛔ 该机器人默认仅限 owner 使用。');
    return;
  }

  // ---- 消息 → 提示词（文本/图片/文件/富文本/合并转发/卡片） ----
  let built;
  try {
    built = await buildPrompt(client, message, workspaceFor(isOwner), senderOpenId);
  } catch (e) {
    console.error('[buildPrompt]', e);
    await reply(
      message.message_id,
      `⚠️ 处理该消息失败：${e?.message ?? e}\n（若是图片/文件，请确认应用已开通 im:resource 权限并发布版本）`
    );
    return;
  }
  if (built.unsupported) {
    await reply(message.message_id, built.unsupported);
    return;
  }
  const text = built.prompt?.trim();
  if (!text) return;
  let prompt = text;

  // ---- 内置命令 ----
  // 会话生命周期类命令会影响整个会话（群里是大家共用的），限 owner 使用
  const LIFECYCLE_CMDS = ['/new', '/cancel', '取消', '/voice', '/voice on', '/voice off', '/tasks'];
  const isLifecycle = LIFECYCLE_CMDS.includes(text) || text.startsWith('/redirect');
  if (isLifecycle && !isOwner && message.chat_type !== 'p2p') {
    await reply(message.message_id, '群会话里只有 owner 能使用会话控制指令（可以私聊我使用）。');
    return;
  }

  if (text === '/new') {
    resetSession(sessionKey);
    if (isRunning(sessionKey)) { cancelRun(sessionKey); abortRetries(sessionKey); }
    if (isOwner && message.chat_type !== 'p2p') {
      for (const k of sessionKeysWithPrefix(`guest:${message.chat_id}:`)) {
        resetSession(k);
        if (isRunning(k)) cancelRun(k);
      }
    }
    await reply(message.message_id, '🆕 已重置，下一条消息将开启全新 Codex 会话。');
    return;
  }
  if (text === '/tasks') {
    if (!isOwner) {
      await reply(message.message_id, '只有 owner 可以查看定时任务。');
      return;
    }
    await reply(message.message_id, describeTasks());
    return;
  }
  if (text === '/status') {
    await reply(message.message_id, sessionInfo(sessionKey, isOwner));
    return;
  }
  if (text === '/help' || text === '帮助') {
    await reply(message.message_id, HELP_TEXT);
    return;
  }
  if (text === '/model' || text.startsWith('/model ')) {
    if (!isOwner) {
      await reply(message.message_id, '只有 owner 可以切换模型。');
      return;
    }
    const args = text.slice('/model'.length).trim().split(/\s+/).filter(Boolean);
    const cur = getRuntimeConfig();
    if (!args.length) {
      await reply(
        message.message_id,
        [
          `**当前模型**：\`${cur.model || '（CLI 默认）'}\``,
          `**思考深度**：\`${cur.effort || '（CLI 默认）'}\``,
          '',
          `用法：\`/model <模型> [思考档]\`，例如 \`/model sol high\``,
          `可用简称：${Object.keys(MODEL_ALIASES).join(' / ')}（也可写完整模型名）`,
          `思考档：${EFFORT_LEVELS.join(' / ')}`,
        ].join('\n')
      );
      return;
    }
    try {
      // 第一个参数若是思考档，则只改档位
      const first = args[0].toLowerCase();
      const next = EFFORT_LEVELS.includes(first)
        ? setRuntimeConfig({ effort: first })
        : setRuntimeConfig({ model: args[0], effort: args[1] });
      await reply(
        message.message_id,
        `✅ 已切换：模型 \`${next.model || 'CLI 默认'}\`，思考深度 \`${next.effort || 'CLI 默认'}\`\n下一条消息即生效（无需重启）。`
      );
    } catch (e) {
      await reply(message.message_id, `⚠️ ${e?.message ?? e}`);
    }
    return;
  }
  if (text === '/cancel' || text === '取消') {
    let killed = cancelRun(sessionKey);
    if (abortRetries(sessionKey)) killed = true;
    if (isOwner && message.chat_type !== 'p2p') {
      for (const k of runningKeysWithPrefix(`guest:${message.chat_id}:`)) killed = cancelRun(k) || killed;
    }
    await reply(message.message_id, killed ? '🛑 已取消当前任务。' : '当前没有正在运行的任务。');
    return;
  }
  if (text === '/voice' || text === '/voice on' || text === '/voice off') {
    const on =
      text === '/voice on' ? true
      : text === '/voice off' ? false
      : !voiceChats.has(message.chat_id);
    if (on) voiceChats.add(message.chat_id); else voiceChats.delete(message.chat_id);
    await reply(message.message_id, on ? '🔊 已开启语音回复（回答会附一条语音）。再发 /voice 关闭。' : '🔇 已关闭语音回复。');
    return;
  }
  // 任务进行中收到新指令：提示可取消/重定向
  if (isRunning(sessionKey) && !text.startsWith('/redirect')) {
    if (!AUTO_REDIRECT_WHEN_BUSY) {
      await reply(message.message_id, '⏳ 上一个任务还在跑。发 **/cancel** 取消，或 **/redirect 你的新要求** 取消并按新要求重来（会话上下文保留）。');
      return;
    }
    cancelRun(sessionKey);
    abortRetries(sessionKey);
  }
  if (text.startsWith('/redirect')) {
    const extra = text.replace(/^\/redirect\s*/, '').trim();
    if (!extra) {
      await reply(message.message_id, '用法：/redirect 你的新要求');
      return;
    }
    cancelRun(sessionKey);
    prompt = extra; // 会话通过 --resume 保留，直接以新要求继续
  }

  // 群聊带上发言人姓名，机器人才知道是谁在说话
  if (message.chat_type !== 'p2p') {
    const name = await resolveSenderName(client, senderOpenId);
    if (name) prompt = `[群成员 ${name}]：${prompt}`;
  }
  if (isModelQuery(text)) {
    await reply(message.message_id, modelInfo());
    return;
  }

  // 记忆自动召回：把可能相关的记忆文件提示给模型（只有 owner 有 memory/）

  if (isOwner) {

    const hint = recallHint(WORKSPACE_DIR, text);

    if (hint) prompt += `\n${hint}`;

  }

  if (isOwner && shouldRecycleSession(sessionKey)) {

    resetSession(sessionKey);

    console.log(`[context] ${sessionKey} 记忆已固化，重开会话以回收上下文`);

  }

  if (isOwner && consumeMemoryNudge(sessionKey)) {

    prompt +=

      '\n\n（系统提示：本会话上下文接近上限，即将被自动压缩。压缩只影响对话历史，不影响 memory/ 文件。' +

      '请先检查这段对话里有哪些值得长期保留的事实、决定、偏好还没写进 memory/——稳定偏好就地合入 USER.md，长期事实建独立文件并更新 MEMORY.md 索引，过程细节追加进 memory/journal/ 当日文件；' +

      '没有就忽略本提示，正常回答用户的问题。不要因为这条提示改变回答的语气或结构。）';

  }

  enqueue(sessionKey, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : senderOpenId} @ ${message.chat_type} [${message.message_type}]: ${text.slice(0, 80)}`);
    await react(message.message_id, 'OnIt');
    const progress = createProgressChannel(client, message.message_id);
    try {
      let answer = await runCodex(sessionKey,
        prompt,
        isOwner,
        built.attachments ?? [],
        ENABLE_PROGRESS_UPDATES
          ? progress.update
          : null
      );
      if (isApprovalDeferral(answer)) {
        console.warn('[approval-deferral] 自动隐藏审批请求并改道重试');
        answer = await runCodex(sessionKey,
          buildApprovalRecoveryPrompt(prompt),
          isOwner,
          built.attachments ?? []
        );
        if (isApprovalDeferral(answer)) {
          console.error('[approval-deferral] 自动重试后仍返回审批请求');
          answer = '当前任务未能在安全执行环境内完成。';
        }
      }
      if (isClaudeRuntimeLeak(answer)) {
        console.warn('[runtime-identity] 隐藏 Claude 身份串线回复，重置会话并用 Codex 重试');
        resetSession(sessionKey);
        answer = await runCodex(sessionKey,
          buildRuntimeIdentityRecoveryPrompt(prompt),
          isOwner,
          built.attachments ?? []
        );
        if (isClaudeRuntimeLeak(answer)) {
          console.error('[runtime-identity] 新会话重试后仍返回 Claude 身份串线回复');
          answer = '当前任务未能由 Codex 正确完成，会话已重置，请重试。';
        }
      }
      await progress.finish();
      await reply(message.message_id, answer || '（Codex 返回了空回复）');
      // 机器人写进 outbox 的图片/文件随本轮一起回传
      await flushOutbox(client, outboxDirFor(sessionKey, isOwner), (data) =>
        client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
      );
      if (voiceChats.has(message.chat_id) && answer) {
        await sendVoice(client, answer, (data) =>
          client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
        );
      }
      await react(message.message_id, 'DONE');
    } catch (e) {
      if (e?.cancelled) return; // /cancel 主动终止，不报错
      console.error('[codex]', e);
      const msg = String(e.message ?? e);
      if (msg.includes('401') || /re-?authenticate/i.test(msg)) {
        await reply(
          message.message_id,
          '⚠️ Mac 上的 Codex 登录已过期。请在 Mac 终端运行 `codex login` 重新登录后再试。'
        );
      } else {
        await reply(message.message_id, `⚠️ Codex 调用失败：${msg}`);
      }
    }
  });
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': handleMessage,
});

// ---- 定时任务：到点跑 Codex，把结果主动发到指定会话 ----
async function sendToChat(chatId, text) {
  const body = (data) =>
    client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } });
  const chunk = redact(text).slice(0, 20000);
  try {
    await body({
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: chunk }],
      }),
    });
  } catch (e) {
    console.error('[sched] 卡片发送失败，降级纯文本:', e?.message ?? e);
    await body({ msg_type: 'text', content: JSON.stringify({ text: chunk }) });
  }
}

const SCHEDULES_DIR = path.join(WORKSPACE_DIR, 'schedules');
const SCHED_STATE_FILE = path.join(DATA_DIR, 'schedule-state.json');

// 下次触发时间：/help 承诺了「上次/下次」，此前只实现了上次
function nextFireAt(job) {
  if (job.enabled === false) return null;
  const when = String(job.when ?? '').trim();
  if (!when) return null;
  try {
    if (!when.startsWith('@') && !when.includes(' ')) {
      // 纯日期（2026-09-01）会被按 UTC 解析，补上时间部分强制走本地时区
      const norm = /^\d{4}-\d{2}-\d{2}$/.test(when) ? `${when}T00:00` : when;
      const t = new Date(norm); // 一次性任务，本地时区
      return !isNaN(t) && t > new Date() ? t : null;
    }
    return CronExpressionParser.parse(when, { currentDate: new Date() }).next().toDate();
  } catch {
    return null;
  }
}

// /tasks：直读任务定义与触发状态，让 owner 随时能确认「它到底还在不在替我干活」
function describeTasks() {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(SCHED_STATE_FILE, 'utf8')); } catch { /* 尚未产生状态 */ }
  try {
    const files = fs.existsSync(SCHEDULES_DIR)
      ? fs.readdirSync(SCHEDULES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
      : [];
    if (!files.length) return '当前没有定时任务。';
    const lines = ['**定时任务**', ''];
    for (const f of files.sort()) {
      let job;
      try {
        job = JSON.parse(fs.readFileSync(path.join(SCHEDULES_DIR, f), 'utf8'));
      } catch {
        lines.push(`- ⚠️ \`${f}\` 解析失败`);
        continue;
      }
      const rec = state[f];
      const at = typeof rec === 'string' ? rec : rec?.at;
      const st = typeof rec === 'string' ? '' : rec?.status;
      const stLabel = { baseline: '已登记', running: '执行中', done: '已完成', failed: '失败', 'skipped-late': '迟到跳过' }[st] ?? '';
      const last = at ? `${new Date(at).toLocaleString('zh-CN')}${stLabel ? `（${stLabel}）` : ''}` : '（尚未触发）';
      const status = job.enabled === false ? '⏸ 已停用' : '▶️ 启用';
      lines.push(`- ${status} **${job.name ?? f}** — \`${job.when}\``);
      lines.push(`  上次：${last}${job.action ? ` ｜ 动作：${job.action}` : ''}`);
      const next = nextFireAt(job);
      if (next) lines.push(`  下次：${next.toLocaleString('zh-CN')}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `读取定时任务失败：${e?.message ?? e}`;
  }
}

// 启动通知：进程崩溃/重启此前完全静默，owner 无从知道自己发的消息其实没人接
const STARTUP_STAMP = path.join(DATA_DIR, 'last-startup-notice');
let cliProblem = null; // 启动自检发现的 CLI 问题，随启动通知发给 owner

async function announceStartup() {
  const owner = OWNER_OPEN_ID || loadOwner();
  if (!owner || process.env.STARTUP_NOTICE === 'false') return;
  // 连环重启时不要每次都推送：30 分钟内只通知一次
  try {
    const last = Number(fs.readFileSync(STARTUP_STAMP, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < 30 * 60 * 1000) {
      console.log('[startup-notice] 距上次通知不足 30 分钟，跳过');
      return;
    }
  } catch { /* 首次运行没有该文件 */ }
  try { fs.writeFileSync(STARTUP_STAMP, String(Date.now())); } catch {}
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: owner,
        msg_type: 'text',
        content: JSON.stringify({
          text:
            `🤖 桥接已启动（${new Date().toLocaleString('zh-CN')}）。若此前发过消息没收到回复，请重发一次。` +
            (cliProblem ? `\n\n⚠️ 启动自检发现问题，现在发消息会失败：\n${cliProblem}` : ''),
        }),
      },
    });
  } catch (e) {
    console.error('[startup-notice]', e?.message ?? e);
  }
}

startScheduler({
  schedulesDir: SCHEDULES_DIR,
  stateFile: SCHED_STATE_FILE,
  onFire: async (job) => {
    const chatId = job.chat_id;
    // 动作型任务：切换模型/思考档，不走 Codex 调用
    if (job.action === 'set-model') {
      try {
        const next = setRuntimeConfig({ model: job.model, effort: job.effort });
        console.log(`[sched] 已切换模型 → ${next.model} / ${next.effort}`);
        if (chatId) {
          await sendToChat(chatId, `🔀 **${job.name ?? '定时切换'}**：模型 \`${next.model || 'CLI 默认'}\`，思考深度 \`${next.effort || 'CLI 默认'}\``);
        }
      } catch (e) {
        console.error('[sched] 切换模型失败:', e?.message ?? e);
        if (chatId) await sendToChat(chatId, `⚠️ 定时切换模型失败：${e?.message ?? e}`);
      }
      return;
    }
    if (!chatId) {
      console.error(`[sched] 任务「${job.name ?? job._file}」缺 chat_id，跳过`);
      return;
    }
    // 定时任务用独立会话上下文，避免污染用户正在进行的对话
    try {
      const schedChatId = `sched:${job._file}`;
      const answer = await runCodex(
        schedChatId,
        job.prompt,
        true,
        [],
        ENABLE_PROGRESS_UPDATES ? (p) => sendToChat(chatId, `⏳ ${p}`) : null
      );
      const late = job._late ? `（迟到补跑 ${Math.round(job._late / 60000)} 分钟）` : '';
      // 无事不报：巡检类任务返回 HEARTBEAT_OK 时静默跳过
      const body = (answer ?? '').trim();
      if (!body || /^HEARTBEAT_OK[.。!！]?$/i.test(body)) {
        console.log(`[sched] 「${job.name ?? job._file}」无需汇报，静默跳过`);
      } else {
        await sendToChat(chatId, `⏰ **${job.name ?? '定时任务'}**${late}

${body}`);
      }
      await flushOutbox(client, outboxDirFor(schedChatId, true), (data) =>
        client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } })
      ).catch(() => {});
    } catch (e) {
      // 失败自诊断：让 Codex 判断是什么原因、能否自行修复
      const err = String(e?.message ?? e).slice(0, 800);
      console.error(`[sched] 任务失败，启动自诊断: ${err}`);
      let diag = '';
      try {
        diag = await runCodex(
          `sched-diag:${job._file}`,
          [
            '你是定时任务的诊断助手。以下任务执行失败，请判断原因并给出结论。',
            `任务名：${job.name ?? job._file}`,
            `任务指令：${job.prompt}`,
            `报错：${err}`,
            '',
            '请用三行回答：1) 失败类别（权限/网络/额度/任务本身写错/其他）；2) 根因判断；3) 建议动作（能自行修复就说明怎么改任务定义，需要人工就明确说要做什么）。不要重试该任务。',
          ].join('\n'),
          true
        );
      } catch (e2) {
        diag = `（诊断也失败了：${String(e2?.message ?? e2).slice(0, 200)}）`;
      }
      await sendToChat(
        chatId,
        `⚠️ **定时任务失败**：${job.name ?? job._file}\n\n报错：\`${err.slice(0, 300)}\`\n\n**自诊断**\n${diag}`
      );
    }
  },
});

// 桥接实际会调用哪个 codex——本机可能装了多份，版本不同会让模型请求被服务端拒绝，
// 而桥接自身看着一切正常
{
  const cli = checkCliEnvironment();
  console.log(`[config] codex CLI：${cli.bin} (${cli.version ?? '版本未知'})`);
  if (cli.problem) console.error(`[config] ⚠️ ${cli.problem}`);
}

// v1.x 遗留在 outbox 根目录的文件：归拢待处理，不会误发给任何人
migrateLegacyOutbox(path.join(WORKSPACE_DIR, 'outbox'));
migrateLegacyOutbox(path.join(GUEST_WORKSPACE_DIR, 'outbox'));

// 附件目录只进不出会一直涨，启动时与每天各清一次
cleanIncoming(WORKSPACE_DIR);
cleanIncoming(GUEST_WORKSPACE_DIR);
setInterval(() => {
  cleanIncoming(WORKSPACE_DIR);
  cleanIncoming(GUEST_WORKSPACE_DIR);
}, 24 * 3600 * 1000).unref();

console.log('启动飞书长连接…');
wsClient.start({ eventDispatcher });
announceStartup();
