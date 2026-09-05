import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const MAX_RESULT_STRING_LENGTH = 50_000;
const SENSITIVE_KEY = /(access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|authorization|password)/i;

export class LarkCliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LarkCliError";
    this.details = details;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function appendBounded(chunks, chunk, state, limit) {
  if (state.bytes >= limit) return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = limit - state.bytes;
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) state.truncated = true;
}

export function parseLarkJson(stdout, stderr = "", exitCode = 0) {
  const raw = (exitCode === 0 ? stdout : stderr || stdout).trim();
  if (!raw) {
    throw new LarkCliError("lark-cli returned no JSON output", { exitCode });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LarkCliError("lark-cli returned invalid JSON", {
      exitCode,
      outputPreview: raw.slice(0, 1_000),
    });
  }

  if (exitCode !== 0 || parsed?.ok !== true) {
    const message = parsed?.error?.message || parsed?.message || `lark-cli failed with exit code ${exitCode}`;
    throw new LarkCliError(message, {
      exitCode,
      error: redactAndLimit(parsed?.error ?? parsed),
    });
  }

  return parsed;
}

export function redactAndLimit(value, depth = 0) {
  if (depth > 12) return "[maximum depth reached]";
  if (typeof value === "string") {
    const normalized = value.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return normalized.length > MAX_RESULT_STRING_LENGTH
      ? `${normalized.slice(0, MAX_RESULT_STRING_LENGTH)}\n[truncated]`
      : normalized;
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactAndLimit(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, item]) => [key, redactAndLimit(item, depth + 1)]),
    );
  }
  return value;
}

export function runLarkCli(args, options = {}) {
  const bin = options.bin || process.env.LARK_CLI_BIN || "lark-cli";
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? process.env.LARK_MAIL_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? process.env.LARK_MAIL_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      settled = true;
      reject(new LarkCliError(`lark-cli timed out after ${timeoutMs}ms`, { timeoutMs }));
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => appendBounded(stdout, chunk, stdoutState, maxOutputBytes));
    child.stderr.on("data", (chunk) => appendBounded(stderr, chunk, stderrState, maxOutputBytes));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = error.code === "ENOENT"
        ? `Cannot find ${bin}. Install Lark CLI or set LARK_CLI_BIN to its absolute path.`
        : `Unable to start ${bin}: ${error.message}`;
      reject(new LarkCliError(message, { code: error.code }));
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed = parseLarkJson(
          Buffer.concat(stdout).toString("utf8"),
          Buffer.concat(stderr).toString("utf8"),
          exitCode ?? 1,
        );
        resolve(redactAndLimit(parsed));
      } catch (error) {
        if (error instanceof LarkCliError) {
          error.details.stdoutTruncated = stdoutState.truncated;
          error.details.stderrTruncated = stderrState.truncated;
        }
        reject(error);
      }
    });
  });
}

function baseMailArgs(command) {
  return ["mail", command, "--as", "user", "--format", "json"];
}

export function buildSearchArgs({
  query,
  folder,
  unread = false,
  max = 20,
  pageToken,
  mailbox = "me",
} = {}) {
  const args = baseMailArgs("+triage");
  args.push("--mailbox", mailbox, "--max", String(max));
  if (query) args.push("--query", query);
  if (folder) args.push("--folder", folder);
  if (unread) args.push("--is-unread");
  if (pageToken) args.push("--page-token", pageToken);
  return args;
}

export function buildReadArgs({ messageId, mailbox = "me", includeHtml = false }) {
  return [
    ...baseMailArgs("+message"),
    "--mailbox",
    mailbox,
    "--message-id",
    messageId,
    `--html=${includeHtml ? "true" : "false"}`,
  ];
}

export function buildDraftArgs({
  to,
  cc = [],
  bcc = [],
  subject,
  body,
  plainText = false,
  mailbox = "me",
}) {
  const args = [
    ...baseMailArgs("+send"),
    "--mailbox",
    mailbox,
    "--to",
    to.join(","),
    "--subject",
    subject,
    "--body",
    body,
  ];
  if (cc.length) args.push("--cc", cc.join(","));
  if (bcc.length) args.push("--bcc", bcc.join(","));
  if (plainText) args.push("--plain-text");
  return args;
}

export function buildReplyDraftArgs({
  messageId,
  body,
  replyAll = false,
  plainText = false,
  mailbox = "me",
}) {
  const args = [
    ...baseMailArgs(replyAll ? "+reply-all" : "+reply"),
    "--mailbox",
    mailbox,
    "--message-id",
    messageId,
    "--body",
    body,
  ];
  if (plainText) args.push("--plain-text");
  return args;
}

export async function getMailStatus() {
  const auth = await runLarkCli(["auth", "status", "--json", "--verify"]);
  const mailbox = await runLarkCli([
    "mail",
    "user_mailboxes",
    "profile",
    "--params",
    JSON.stringify({ user_mailbox_id: "me" }),
    "--as",
    "user",
    "--format",
    "json",
  ]);
  return { auth, mailbox };
}

export async function searchMail(input) {
  return runLarkCli(buildSearchArgs(input));
}

export async function readMail(input) {
  return runLarkCli(buildReadArgs(input));
}

export async function createDraft(input) {
  return runLarkCli(buildDraftArgs(input));
}

export async function createReplyDraft(input) {
  return runLarkCli(buildReplyDraftArgs(input));
}
