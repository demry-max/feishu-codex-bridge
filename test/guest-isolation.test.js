// 访客隔离回归测试（2026-09-05）
//
// 实测过的真实缺陷：`--sandbox read-only` 只挡写不挡读，而 cwd 对所有人都是同一个
// WORKSPACE_DIR，于是访客一句「读 memory/MEMORY.md」就把 owner 的记忆标题全列了出来。
// 沙箱级别与工作区隔离是两件事，必须都做。
//
// 断言一律基于真实返回值：对源码做正则匹配的测试，在隔离被整体改回去时依然全绿。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { buildCodexArgs, workspaceFor, WORKSPACE_DIR, GUEST_WORKSPACE_DIR, checkCliEnvironment } =
  await import('../src/codex.js');

describe('访客隔离', () => {
  test('访客与 owner 跑在不同工作区', () => {
    assert.equal(workspaceFor(false), GUEST_WORKSPACE_DIR);
    assert.equal(workspaceFor(true), WORKSPACE_DIR);
    assert.notEqual(GUEST_WORKSPACE_DIR, WORKSPACE_DIR);
  });

  test('buildCodexArgs 带出的 cwd 按身份分叉', () => {
    assert.equal(buildCodexArgs(null, false, []).cwd, GUEST_WORKSPACE_DIR);
    assert.equal(buildCodexArgs(null, true, []).cwd, WORKSPACE_DIR);
  });

  test('访客工作区不含 owner 的长期记忆', () => {
    assert.ok(!fs.existsSync(path.join(GUEST_WORKSPACE_DIR, 'memory')),
      '访客工作区不该有 memory 目录——read-only 沙箱照样读得到里面的东西');
    const md = path.join(GUEST_WORKSPACE_DIR, 'AGENTS.md');
    assert.ok(fs.existsSync(md), '访客工作区应在启动时自动创建');
    const body = fs.readFileSync(md, 'utf8');
    assert.ok(!body.includes('memory/MEMORY.md'), '访客的 AGENTS.md 不得指向 owner 记忆');
    assert.match(body, /访客|guest/i);
  });

  test('访客沙箱只读，owner 才可写工作区', () => {
    const g = buildCodexArgs(null, false, []);
    const o = buildCodexArgs(null, true, []);
    assert.equal(g[g.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(o[o.indexOf('--sandbox') + 1], 'workspace-write');
  });

  test('访客拿不到飞书 MCP 与联网放行，owner 才有', () => {
    const g = buildCodexArgs(null, false, []).join(' ');
    const o = buildCodexArgs(null, true, []).join(' ');
    assert.ok(!g.includes('mcp_servers.feishu'));
    assert.ok(o.includes('mcp_servers.feishu'));
    assert.ok(!g.includes('network_access=true'), '访客不该被放开网络');
  });
});

describe('CLI 自检', () => {
  // 本机装了两份 codex（nvm 0.144.4 / homebrew 0.147.0），子进程按 CODEX_BIN 与 PATH 解析。
  // 升级了终端那份而进程管理器指向另一份时，模型请求会被服务端拒绝，桥接却看着正常。
  test('报出实际会调用的可执行文件与版本', () => {
    const r = checkCliEnvironment();
    assert.ok(r.bin, '必须指明实际解析到的可执行文件');
    if (r.ok) assert.match(r.version, /^\d+\.\d+\.\d+$/);
    else assert.ok(r.problem && r.problem.length > 0, '失败时必须给出可读原因');
  });

  test('codex 不存在时报问题而不是崩溃', async () => {
    const prev = process.env.CODEX_BIN;
    process.env.CODEX_BIN = '/tmp/definitely-not-a-real-codex-binary';
    const mod = await import(`../src/codex.js?cli=${Date.now()}`);
    const r = mod.checkCliEnvironment();
    assert.equal(r.ok, false);
    assert.ok(r.problem);
    if (prev === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = prev;
  });
});
