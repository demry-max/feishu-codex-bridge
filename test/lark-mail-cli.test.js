import test from "node:test";
import assert from "node:assert/strict";
import {
  LarkCliError,
  buildDraftArgs,
  buildReadArgs,
  buildReplyDraftArgs,
  buildSearchArgs,
  parseLarkJson,
  redactAndLimit,
} from "../src/lark-mail-cli.js";

test("search arguments use user identity", () => {
  assert.deepEqual(
    buildSearchArgs({ query: "invoice", folder: "inbox", unread: true, max: 10 }),
    [
      "mail", "+triage", "--as", "user", "--format", "json",
      "--mailbox", "me", "--max", "10", "--query", "invoice",
      "--folder", "inbox", "--is-unread",
    ],
  );
});

test("read arguments exclude HTML by default", () => {
  const args = buildReadArgs({ messageId: "message-1" });
  assert.ok(args.includes("--html=false"));
  assert.equal(args.includes("--html=true"), false);
});

test("draft builders cannot send mail", () => {
  const draft = buildDraftArgs({ to: ["a@example.com"], subject: "Hello", body: "Body" });
  const reply = buildReplyDraftArgs({ messageId: "message-1", body: "Thanks" });
  assert.equal(draft.includes("--confirm-send"), false);
  assert.equal(reply.includes("--confirm-send"), false);
});

test("successful CLI output is parsed by ok=true", () => {
  assert.deepEqual(parseLarkJson('{"ok":true,"data":{"count":1}}'), {
    ok: true,
    data: { count: 1 },
  });
});

test("failed CLI output becomes a typed error", () => {
  assert.throws(
    () => parseLarkJson("", '{"ok":false,"error":{"message":"missing scope"}}', 1),
    (error) => error instanceof LarkCliError && error.message === "missing scope",
  );
});

test("sensitive fields are removed from tool results", () => {
  assert.deepEqual(
    redactAndLimit({ access_token: "secret", nested: { appSecret: "secret", safe: "yes" } }),
    { nested: { safe: "yes" } },
  );
});
