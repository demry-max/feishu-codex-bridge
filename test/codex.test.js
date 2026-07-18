import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgs, isModelQuery, parseJsonl } from '../src/codex.js';

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
