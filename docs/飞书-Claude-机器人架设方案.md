# 飞书 ⇆ Claude 机器人部署手册

> **给 Claude 的指令**：按步骤 1→11 顺序执行，源码原样写入不要改动。全程自动，唯一人工动作是步骤 9 用户扫码。
>
> **效果**：飞书私聊/群 @机器人 → 本机 Claude Code 回答（文本/图片/文件/语音/富文本/转发均可），会话持久续聊。无需公网服务器，飞书事件走长连接。前置：macOS 或 Windows、Node ≥ 18；可选 ffmpeg（语音兜底转写，`brew install ffmpeg` / `winget install ffmpeg`）。

## 步骤 0：安装/更新 Claude Code CLI 并登录

先把 claude CLI 装到/更新到最新版：

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

然后**必须执行**登录引导：运行 `claude /login`，终端会自动弹出登录链接/二维码——**把登录链接原样呈现给用户，让用户在浏览器完成授权**（用 Claude 订阅账号登录，机器人之后就用这个登录态，不消耗 API Key）。用户确认登录完成后再继续下一步；若机器此前已登录，向用户确认是否沿用当前账号即可。

## 步骤 1：初始化项目

```bash
mkdir -p ~/feishu-claude-bridge/src ~/feishu-claude-bridge/scripts/windows ~/feishu-claude-bridge/workspace
cd ~/feishu-claude-bridge
npm init -y
npm pkg set type=module scripts.start="node src/index.js" scripts.register="node scripts/register.js"
npm install @larksuiteoapi/node-sdk dotenv qrcode-terminal cross-spawn
```

## 步骤 2：写入 `.env` 与 `.gitignore`

`.env`（前两项由步骤 9 自动填写）：

```bash
FEISHU_APP_ID=
FEISHU_APP_SECRET=

ALLOWED_TOOLS=Read,Grep,Glob,WebSearch,WebFetch   # owner 可用工具
NON_OWNER_TOOLS=WebSearch,WebFetch                # 其他成员可用工具
CLAUDE_MODEL=                                     # 留空=默认；可填 haiku/sonnet/opus
CLAUDE_TIMEOUT_MS=300000
```

`.gitignore`：

```
node_modules/
.env
data/
workspace/
bridge.log
.DS_Store
```

## 步骤 3：写入 `src/store.js`

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const OWNER_FILE = path.join(DATA_DIR, 'owner.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadOwner() {
  return readJson(OWNER_FILE, {}).open_id ?? null;
}

export function saveOwner(openId) {
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ open_id: openId }, null, 2));
}

export function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

export function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}
```

## 步骤 4：写入 `src/claude.js`

```js
import spawn from 'cross-spawn'; // Windows 下 claude 是 .cmd，原生 spawn 会 EINVAL
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions, saveSessions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace');
const ALLOWED_TOOLS =
  process.env.ALLOWED_TOOLS ?? 'Read,Grep,Glob,WebSearch,WebFetch';
// 非 owner（同事/群成员）不给本机文件工具，只允许联网检索
const NON_OWNER_TOOLS = process.env.NON_OWNER_TOOLS ?? 'WebSearch,WebFetch';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 300_000);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';

const sessions = loadSessions(); // { [chatId]: sessionId }

export function resetSession(chatId) {
  delete sessions[chatId];
  saveSessions(sessions);
}

export function sessionInfo(chatId, isOwner = false) {
  const sid = sessions[chatId];
  const tools = isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS;
  return [
    `**会话状态**`,
    `- Claude session: ${sid ? `\`${sid}\`` : '（无，下一条消息将新建）'}`,
    `- 工作目录: \`${WORKSPACE_DIR}\``,
    `- 你的身份: ${isOwner ? 'owner' : '普通成员'}`,
    `- 允许工具: ${tools || '（无）'}`,
  ].join('\n');
}

export function runClaude(chatId, prompt, isOwner = false, extraTools = []) {
  // 提示词走 stdin：--allowedTools 等可变参数选项会吞掉后置的位置参数
  const args = ['-p', '--output-format', 'json'];
  if (sessions[chatId]) args.push('--resume', sessions[chatId]);
  const tools = [isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS, ...extraTools]
    .filter(Boolean)
    .join(',');
  if (tools) args.push('--allowedTools', tools);
  if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI 超时（${CLAUDE_TIMEOUT_MS / 1000}s）`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI 启动失败: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(
          new Error(`claude CLI 失败(code ${code}): ${stderr.slice(0, 500)}`)
        );
      }
      try {
        const out = JSON.parse(stdout);
        if (out.session_id) {
          sessions[chatId] = out.session_id;
          saveSessions(sessions);
        }
        if (out.is_error) {
          return reject(new Error(String(out.result ?? 'unknown error').slice(0, 500)));
        }
        resolve(out.result ?? '');
      } catch {
        // 非 JSON 输出时原样返回
        resolve(String(stdout).trim());
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
```

## 步骤 5：写入 `src/messages.js`

```js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

function toPcm16k(src) {
  const dest = src.replace(/\.\w+$/, '') + '.pcm';
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ['-y', '-i', src, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', dest],
      (err, _out, stderr) =>
        err ? reject(new Error(`ffmpeg 转码失败: ${String(stderr).slice(-200)}`)) : resolve(dest)
    );
  });
}

// 飞书语音文件识别（仅收 16k PCM，≤60s）
async function feishuAsr(client, audioPath) {
  const pcm = await toPcm16k(audioPath);
  const b64 = fs.readFileSync(pcm).toString('base64');
  const res = await client.request({
    method: 'POST',
    url: '/open-apis/speech_to_text/v1/speech/file_recognize',
    data: {
      speech: { speech: b64 },
      config: {
        engine_type: '16k_auto',
        format: 'pcm',
        // file_id 必须是恰好 16 位字母数字下划线
        file_id: (path.basename(audioPath).replace(/\W/g, '') + '_padding_0000000').slice(0, 16),
      },
    },
  });
  return String(res?.recognition_text ?? res?.data?.recognition_text ?? '').trim();
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function stripMentions(text) {
  return (text ?? '').replace(/@_user_\d+/g, '').trim();
}

async function download(client, messageId, fileKey, type, incomingDir, fileName) {
  fs.mkdirSync(incomingDir, { recursive: true });
  const dest = path.join(incomingDir, path.basename(fileName));
  const res = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  await res.writeFile(dest);
  return dest;
}

// 从 post 富文本节点树提取文字与图片 key
function walkPost(content) {
  const texts = [];
  const imageKeys = [];
  const rows = Array.isArray(content?.content) ? content.content : [];
  for (const row of rows) {
    const line = [];
    for (const node of row ?? []) {
      if (node.tag === 'text') line.push(node.text ?? '');
      else if (node.tag === 'a') line.push(`${node.text ?? ''}(${node.href ?? ''})`);
      else if (node.tag === 'img') imageKeys.push(node.image_key);
      else if (node.tag === 'at') line.push('');
    }
    if (line.length) texts.push(line.join(''));
  }
  return { text: texts.join('\n'), imageKeys };
}

/**
 * 把一条飞书消息转成给 Claude 的提示词。
 * 返回 { prompt, attachments }；attachments 非空时需要给 Claude 开 Read(./incoming/**) 权限。
 */
export async function buildPrompt(client, message, workspaceDir) {
  const type = message.message_type;
  const content = safeParse(message.content);
  const incomingDir = path.join(workspaceDir, 'incoming', message.message_id);
  const rel = (p) => `./${path.relative(workspaceDir, p)}`;

  switch (type) {
    case 'text':
      return { prompt: stripMentions(content.text), attachments: [] };

    case 'image': {
      const p = await download(
        client, message.message_id, content.image_key, 'image', incomingDir, `${content.image_key}.png`
      );
      return {
        prompt: `用户发来一张图片，已保存为 ${rel(p)}。请用 Read 工具查看图片内容，然后回应用户。`,
        attachments: [p],
      };
    }

    case 'file': {
      const name = content.file_name || `${content.file_key}.bin`;
      const p = await download(
        client, message.message_id, content.file_key, 'file', incomingDir, name
      );
      return {
        prompt: `用户发来一个文件「${name}」，已保存为 ${rel(p)}。请用 Read 工具查看文件内容，然后回应用户。`,
        attachments: [p],
      };
    }

    case 'post': {
      const { text, imageKeys } = walkPost(content);
      const attachments = [];
      for (const key of imageKeys) {
        try {
          attachments.push(
            await download(client, message.message_id, key, 'image', incomingDir, `${key}.png`)
          );
        } catch (e) {
          console.error('[post-img]', e?.message ?? e);
        }
      }
      const title = content.title ? `【${content.title}】\n` : '';
      let prompt = `${title}${stripMentions(text)}`;
      if (attachments.length) {
        prompt += `\n\n（消息附带 ${attachments.length} 张图片，已保存为：${attachments
          .map(rel)
          .join('、')}。请用 Read 工具查看后一并回应。）`;
      }
      return { prompt, attachments };
    }

    case 'merge_forward': {
      // 合并转发：拉取子消息逐条拼接
      const res = await client.im.v1.message.get({ path: { message_id: message.message_id } });
      const items = res?.data?.items ?? [];
      const lines = [];
      for (const item of items) {
        if (item.message_id === message.message_id) continue;
        const body = safeParse(item.body?.content);
        if (item.msg_type === 'text') lines.push(stripMentions(body.text));
        else if (item.msg_type === 'post') lines.push(walkPost(body).text);
        else lines.push(`[${item.msg_type} 消息]`);
      }
      return {
        prompt: `用户转发了一组聊天记录，内容如下：\n---\n${lines.join('\n')}\n---\n请理解后回应用户。`,
        attachments: [],
      };
    }

    case 'audio': {
      // ① 飞书自动语音转文字（租户开启后 content 自带该字段）
      const stt = typeof content.speech_to_text === 'string' ? content.speech_to_text.trim() : '';
      if (stt) {
        return { prompt: `（用户发来一条语音，转写内容如下）\n${stt}`, attachments: [] };
      }
      if (Number(content.duration ?? 0) > 60_000) {
        return { prompt: null, attachments: [], unsupported: '这条语音超过 60 秒，自动转写不支持，请分段发送或改发文字。' };
      }
      // ② 兜底：下载 opus → ffmpeg 转 16k PCM → 飞书语音识别 API
      try {
        const p = await download(
          client, message.message_id, content.file_key, 'file', incomingDir, `${content.file_key}.opus`
        );
        const text = await feishuAsr(client, p);
        if (text) {
          return { prompt: `（用户发来一条语音，识别内容如下）\n${text}`, attachments: [] };
        }
        return { prompt: null, attachments: [], unsupported: '语音已收到，但没有识别出内容，请重试或改发文字。' };
      } catch (e) {
        return {
          prompt: null,
          attachments: [],
          unsupported: `语音转写失败：${e?.message ?? e}\n（若是权限问题，请在开发者后台开通 speech_to_text:speech 并发布版本）`,
        };
      }
    }

    case 'media':
    case 'sticker':
      return { prompt: null, attachments: [], unsupported: `暂不支持${type === 'media' ? '视频' : '表情包'}消息。` };

    default:
      // 分享卡片/邮件卡片等：把原始 JSON 交给 Claude 理解
      return {
        prompt: `用户发来一条「${type}」类型的飞书消息，原始内容 JSON 如下：\n\`\`\`json\n${String(
          message.content
        ).slice(0, 6000)}\n\`\`\`\n请从中提取有用信息，理解后回应用户。`,
        attachments: [],
      };
  }
}
```

## 步骤 6：写入 `src/index.js`

```js
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { runClaude, resetSession, sessionInfo, WORKSPACE_DIR } from './claude.js';
import { buildPrompt } from './messages.js';
import { loadOwner, saveOwner } from './store.js';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请先运行 npm run register');
  process.exit(1);
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

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
  const chunks = [];
  for (let i = 0; i < text.length; i += 20000) chunks.push(text.slice(i, i + 20000));
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

  // ---- owner：首个私聊者自动认领，owner 享有本机工具，其他人仅联网工具 ----
  let owner = loadOwner();
  if (!owner && message.chat_type === 'p2p') {
    owner = senderOpenId;
    saveOwner(owner);
    console.log(`[owner] 已锁定 owner open_id = ${owner}`);
    await reply(
      message.message_id,
      `✅ 已将你登记为本机器人 owner（open_id: \`${owner}\`）。\n直接发消息即可对话；发送 **/new** 开启新会话，**/status** 查看会话状态。`
    );
    return;
  }
  const isOwner = senderOpenId === owner;

  // ---- 消息 → 提示词（文本/图片/文件/语音/富文本/合并转发/卡片） ----
  let built;
  try {
    built = await buildPrompt(client, message, WORKSPACE_DIR);
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

  // ---- 内置命令 ----
  if (text === '/new') {
    resetSession(message.chat_id);
    await reply(message.message_id, '🆕 已重置，下一条消息将开启全新 Claude 会话。');
    return;
  }
  if (text === '/status') {
    await reply(message.message_id, sessionInfo(message.chat_id, isOwner));
    return;
  }

  // 附件存放于 workspace/incoming/，即使非 owner 也放行该目录的只读访问
  const extraTools = built.attachments.length ? ['Read(./incoming/**)'] : [];

  enqueue(message.chat_id, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : senderOpenId} @ ${message.chat_type} [${message.message_type}]: ${text.slice(0, 80)}`);
    await react(message.message_id, 'OnIt');
    try {
      const answer = await runClaude(message.chat_id, text, isOwner, extraTools);
      await reply(message.message_id, answer || '（Claude 返回了空回复）');
      await react(message.message_id, 'DONE');
    } catch (e) {
      console.error('[claude]', e);
      const msg = String(e.message ?? e);
      if (msg.includes('401') || /re-?authenticate/i.test(msg)) {
        await reply(
          message.message_id,
          '⚠️ 主机上的 Claude 登录已过期。请在主机终端运行 `claude /login` 重新登录后再试。'
        );
      } else {
        await reply(message.message_id, `⚠️ Claude 调用失败：${msg}`);
      }
    }
  });
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': handleMessage,
});

console.log('启动飞书长连接…');
wsClient.start({ eventDispatcher });
```

## 步骤 7：写入 `scripts/register.js`

```js
// 一键注册飞书应用（设备码扫码流程）：
// 扫码授权后，飞书官方接口直接返回 appId + appSecret + 用户 open_id，
// 自动写入 .env 与 data/owner.json —— 无需进开发者后台建应用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REG_URL = 'https://accounts.feishu.cn/oauth/v1/app/registration';

async function post(body) {
  const res = await fetch(REG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return res.json(); // pending/error 状态也带 JSON body
}

function upsertEnv(appId, appSecret) {
  const envPath = path.join(ROOT, '.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const set = (key, val) => {
    const line = `${key}=${val}`;
    env = new RegExp(`^${key}=`, 'm').test(env)
      ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : env + (env.endsWith('\n') || env === '' ? '' : '\n') + line + '\n';
  };
  set('FEISHU_APP_ID', appId);
  set('FEISHU_APP_SECRET', appSecret);
  fs.writeFileSync(envPath, env);
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const init = await post({ action: 'init' });
if (!init.supported_auth_methods?.includes('client_secret')) {
  console.error('当前环境不支持 client_secret 注册方式:', JSON.stringify(init).slice(0, 200));
  process.exit(1);
}

const begin = await post({
  action: 'begin',
  archetype: 'PersonalAgent',
  auth_method: 'client_secret',
  request_user_info: 'open_id',
});
if (!begin.device_code) {
  console.error('注册启动失败:', JSON.stringify(begin).slice(0, 300));
  process.exit(1);
}

const qrUrl = begin.verification_uri_complete;
try {
  const qr = await import('qrcode-terminal');
  qr.default.generate(qrUrl, { small: true });
} catch {
  /* 未安装 qrcode-terminal 时仅打印链接 */
}
console.log('\n请用飞书 App 扫上方二维码，或在手机浏览器打开：\n' + qrUrl + '\n');
console.log(`等待授权（${begin.expire_in || 600} 秒内有效）…`);

let interval = begin.interval || 5;
const deadline = Date.now() + (begin.expire_in || 600) * 1000;

while (Date.now() < deadline) {
  await sleep(interval);
  let p;
  try {
    p = await post({ action: 'poll', device_code: begin.device_code, tp: 'ob_cli_app' });
  } catch {
    continue; // 网络抖动继续轮询
  }
  if (p.client_id && p.client_secret) {
    upsertEnv(p.client_id, p.client_secret);
    const openId = p.user_info?.open_id;
    if (openId) {
      const ownerPath = path.join(ROOT, 'data', 'owner.json');
      if (!fs.existsSync(ownerPath)) {
        fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
        fs.writeFileSync(ownerPath, JSON.stringify({ open_id: openId }, null, 2));
        console.log(`✅ 已将扫码人设为 owner（${openId}）`);
      }
    }
    console.log(`✅ 应用创建成功：${p.client_id}，凭据已写入 .env`);
    console.log('下一步：npm start 启动机器人，到飞书私聊它发「你好」。');
    process.exit(0);
  }
  if (p.error === 'authorization_pending') continue;
  if (p.error === 'slow_down') { interval += 2; continue; }
  if (p.error) {
    console.error(`注册失败: ${p.error} ${p.error_description ?? ''}`);
    process.exit(1);
  }
}
console.error('授权超时，请重新运行 npm run register');
process.exit(1);
```

## 步骤 8：验证 claude CLI

```bash
cd ~/feishu-claude-bridge/workspace && claude -p --output-format json --model haiku "只回复两个字：正常"
```

预期 JSON 中 `result` 为「正常」。若报 401，让用户运行 `claude /login` 后重试。

## 步骤 9：注册飞书应用（唯一人工动作：扫码）

```bash
cd ~/feishu-claude-bridge && npm run register
```

把终端输出的二维码/链接呈现给用户，用飞书 App 扫码授权。成功后凭据自动写入 `.env`、扫码人自动登记为 owner。若注册失败，按附录 A 手动配置。

## 步骤 10：启动并验证

```bash
cd ~/feishu-claude-bridge && npm start
```

日志出现 `[ws] ws client ready` 即长连接成功。让用户在飞书私聊机器人发「你好」，收到回复即部署完成。

## 步骤 11：常驻自启

**macOS**（launchd）：写入 `~/Library/LaunchAgents/com.<用户名>.feishu-claude-bridge.plist`（node 绝对路径用 `which node` 取；`PATH` 必须含 `claude` 所在目录，nvm 用户即 node 同目录）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.USERNAME.feishu-claude-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/TO/node</string>
    <string>src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/TO/feishu-claude-bridge</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/ABSOLUTE/PATH/TO/node-bin-dir:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>/Users/USERNAME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/USERNAME/Library/Logs/feishu-claude-bridge.log</string>
  <key>StandardErrorPath</key><string>/Users/USERNAME/Library/Logs/feishu-claude-bridge.log</string>
</dict>
</plist>
```

```bash
# 先停掉步骤 10 的前台进程，再：
launchctl load -w ~/Library/LaunchAgents/com.USERNAME.feishu-claude-bridge.plist   # 安装并启动
launchctl kickstart -k gui/$(id -u)/com.USERNAME.feishu-claude-bridge              # 改配置后重启
```

**Windows**：写入 `scripts/windows/start-hidden.vbs`：

```vbs
' 隐藏窗口启动桥接服务（登录自启用；日志写到项目根目录 bridge.log）
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c npm start >> """ & root & "\bridge.log"" 2>&1", 0, False
```

写入 `scripts/windows/install-startup.ps1`：

```powershell
# 注册登录自启（当前用户启动文件夹快捷方式，无需管理员）
$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$startup = [IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startup 'feishu-claude-bridge.lnk'))
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + $vbs + '"'
$lnk.WorkingDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$lnk.Save()
Write-Host "已注册登录自启。立即启动：wscript `"$vbs`"（日志见项目根目录 bridge.log）"
```

然后执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1
```

---

## 附录 A：手动配置飞书应用（仅当扫码注册失败）

1. [open.feishu.cn/app](https://open.feishu.cn/app) 创建企业自建应用，把 App ID / App Secret 填入 `.env`
2. `open.feishu.cn/app/<APP_ID>/feature`：应用能力 → 添加「机器人」
3. `open.feishu.cn/app/<APP_ID>/auth`：权限管理 → 批量导入：

   ```json
   {"scopes":{"tenant":["im:message","im:message.p2p_msg:readonly","im:message.group_at_msg:readonly","im:resource","im:message.reactions:write","speech_to_text:speech"],"user":[]}}
   ```

4. `open.feishu.cn/app/<APP_ID>/event`：订阅方式选「**使用长连接接收事件**」；添加事件 `im.message.receive_v1`
5. `open.feishu.cn/app/<APP_ID>/version`：创建版本并发布（可用范围选「全体员工」即全员可私聊）

## 附录 B：使用与排查

| 项目 | 说明 |
|------|------|
| 用法 | 私聊直接对话；群里 @机器人；发图片/文件/语音均可；`/new` 开新会话；`/status` 查状态 |
| 权限分级 | 首个私聊者 = owner（本机只读工具 + 联网）；其他人仅 WebSearch/WebFetch；改 `.env` 调整 |
| 无响应 | 查日志（macOS `~/Library/Logs/feishu-claude-bridge.log` / Windows `bridge.log`）；确认出现 `ws client ready` |
| 提示登录过期 | 主机终端 `claude /login`；根治：`claude setup-token` 生成长期令牌写入 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN=` |
| 图片/语音报权限错 | 按附录 A 第 3 步补权限后重新发布版本 |
| 电脑关机/休眠 | 机器人离线（物理限制）；7×24 需部署到常开主机 |
| 安全红线 | `.env` 不入库不外发；不给无人值守机器人开 Write/Bash；不用 `--dangerously-skip-permissions` |
