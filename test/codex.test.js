import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexArgs,
  createJsonlProgressParser,
  isModelQuery,
  parseJsonl,
  resolveTimeouts,
} from '../src/codex.js';

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

test('places exec-level sandbox before resume', () => {
  assert.deepEqual(buildCodexArgs('thread-123', true), [
    'exec',
    '--sandbox',
    'workspace-write',
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
  });
  assert.deepEqual(args.slice(0, 12), [
    'exec',
    '--sandbox',
    'workspace-write',
    '--config',
    'model_reasoning_effort="xhigh"',
    '--config',
    'service_tier="fast"',
    '--config',
    'features.fast_mode=true',
    'resume',
    '--json',
    '--skip-git-repo-check',
  ]);
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
