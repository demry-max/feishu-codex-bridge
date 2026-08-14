import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildApprovalRecoveryPrompt,
  buildAutonomousPrompt,
  buildCodexArgs,
  createJsonlProgressParser,
  getRuntimeConfig,
  isModelQuery,
  isApprovalDeferral,
  loadMemoryIndex,
  MODEL_ALIASES,
  parseJsonl,
  resolveTimeouts,
  setRuntimeConfig,
} from '../src/codex.js';

test('adds non-interactive autonomy instructions to every prompt', () => {
  const prompt = buildAutonomousPrompt('读取合同并给结论', {
    memoryIndex: '- [回复偏好](reply-style.md) — 只输出结果',
  });
  assert.match(prompt, /无人值守/);
  assert.match(prompt, /不要要求用户批准/);
  assert.match(prompt, /长期记忆索引（桥接自动加载）/);
  assert.match(prompt, /reply-style\.md/);
  assert.match(prompt, /读取合同并给结论/);
});

test('loads the workspace memory index without requiring model tool use', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-codex-memory-'));
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(
    path.join(root, 'memory', 'MEMORY.md'),
    '# 长期记忆索引\n- [语言偏好](language.md) — 中文回答\n'
  );
  try {
    assert.match(loadMemoryIndex(root), /语言偏好/);
    assert.equal(loadMemoryIndex(path.join(root, 'missing')), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects approval deferrals and builds a safe recovery prompt', () => {
  assert.equal(isApprovalDeferral('This command requires approval'), true);
  assert.equal(isApprovalDeferral('请在 ~/.claude/settings.json 给 python3 加白名单'), true);
  assert.equal(isApprovalDeferral('需要你批准运行 python3 来读取文档'), true);
  assert.equal(isApprovalDeferral('合同存在三处高风险条款。'), false);
  const recovery = buildApprovalRecoveryPrompt('可以签吗？');
  assert.match(recovery, /上一条回复无效/);
  assert.match(recovery, /可以签吗/);
});

test('parses Codex JSONL thread id and last agent message', () => {
  const output = [
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    'not json',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
  ].join('\n');
  assert.deepEqual(parseJsonl(output), {
    threadId: 'thread-123',
    answer: 'final',
    error: '',
  });
});

test('parses failed turns', () => {
  const output = '{"type":"turn.failed","error":{"message":"boom"}}';
  assert.equal(parseJsonl(output).error, 'boom');
});

test('places exec-level sandbox and non-interactive controls before resume', () => {
  assert.deepEqual(buildCodexArgs('thread-123', true, [], { feishuTools: false }), [
    'exec',
    '--sandbox',
    'workspace-write',
    '--ignore-rules',
    '--config',
    'approval_policy="never"',
    '--config',
    'sandbox_workspace_write.network_access=true',
    'resume',
    '--json',
    '--skip-git-repo-check',
    'thread-123',
    '-',
  ]);
});

test('detects direct model identity questions', () => {
  assert.equal(isModelQuery('/model'), true);
  assert.equal(isModelQuery('what model are you using?'), true);
  assert.equal(isModelQuery('你现在用的是什么模型？'), true);
  assert.equal(isModelQuery('what model should I use?'), false);
});

test('applies explicit reasoning effort and fast service tier before resume', () => {
  const args = buildCodexArgs('thread-123', true, [], {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    serviceTier: 'fast',
    feishuTools: false,
  });
  assert.deepEqual(args.slice(0, 14), [
    'exec',
    '--sandbox',
    'workspace-write',
    '--ignore-rules',
    '--config',
    'approval_policy="never"',
    '--config',
    'sandbox_workspace_write.network_access=true',
    '--config',
    'model_reasoning_effort="xhigh"',
    '--config',
    'service_tier="fast"',
    '--config',
    'features.fast_mode=true',
  ]);
});

test('keeps sandboxing while disabling interactive approvals for bridge runs', () => {
  const args = buildCodexArgs('', true, [], {
    feishuTools: false,
    networkAccess: false,
  });
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args.includes('--ignore-rules'), true);
  assert.equal(args.includes('approval_policy="never"'), true);
  const nonOwnerArgs = buildCodexArgs('', false, [], { feishuTools: false });
  assert.equal(nonOwnerArgs.includes('--ignore-rules'), false);
  assert.equal(nonOwnerArgs.includes('read-only'), true);
});

test('can disable owner network access and never enables it for non-owners', () => {
  assert.equal(
    buildCodexArgs('', true, [], { networkAccess: false }).includes(
      'sandbox_workspace_write.network_access=true'
    ),
    false
  );
  assert.equal(
    buildCodexArgs('', false, [], { networkAccess: true }).includes(
      'sandbox_workspace_write.network_access=true'
    ),
    false
  );
});

test('maps runtime model aliases and effort without requiring a restart', () => {
  const next = setRuntimeConfig({ model: 'sol', effort: 'high' }, { persist: false });
  assert.equal(MODEL_ALIASES.sol, 'gpt-5.6-sol');
  assert.equal(next.model, 'gpt-5.6-sol');
  assert.equal(next.effort, 'high');
  assert.deepEqual(getRuntimeConfig(), next);
});

test('enables the built-in Feishu MCP only for owner sessions', () => {
  const ownerArgs = buildCodexArgs('', true, [], { feishuTools: true });
  assert.equal(ownerArgs.some((arg) => arg.startsWith('mcp_servers.feishu.command=')), true);
  const nonOwnerArgs = buildCodexArgs('', false, [], { feishuTools: true });
  assert.equal(nonOwnerArgs.some((arg) => arg.startsWith('mcp_servers.feishu.command=')), false);
});

test('uses an idle timeout with a separate hard runtime limit', () => {
  assert.deepEqual(resolveTimeouts({}), {
    idleTimeoutMs: 300_000,
    maxRuntimeMs: 1_800_000,
  });
  assert.deepEqual(
    resolveTimeouts({ CODEX_IDLE_TIMEOUT_MS: '60000', CODEX_MAX_RUNTIME_MS: '900000' }),
    { idleTimeoutMs: 60_000, maxRuntimeMs: 900_000 }
  );
  assert.equal(resolveTimeouts({ CODEX_TIMEOUT_MS: '120000' }).idleTimeoutMs, 120_000);
});

test('streams intermediate agent messages but keeps the final answer pending', () => {
  const progress = [];
  const parser = createJsonlProgressParser((text) => progress.push(text));
  parser.push('{"type":"item.completed","item":{"type":"agent_message","text":"正在查询"}}\n');
  parser.push('{"type":"item.star');
  parser.push('ted","item":{"type":"command_execution"}}\n');
  parser.push('{"type":"item.completed","item":{"type":"agent_message","text":"完成"}}\n');
  parser.push('{"type":"turn.completed"}\n');
  parser.finish();
  assert.deepEqual(progress, ['正在查询']);
});

test('streams an earlier agent message when a later agent message follows', () => {
  const progress = [];
  const parser = createJsonlProgressParser((text) => progress.push(text));
  parser.push(
    '{"type":"item.completed","item":{"type":"agent_message","text":"第一阶段"}}\n' +
      '{"type":"item.completed","item":{"type":"agent_message","text":"最终答案"}}\n' +
      '{"type":"turn.completed"}\n'
  );
  parser.finish();
  assert.deepEqual(progress, ['第一阶段']);
});
