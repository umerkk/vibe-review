import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReviewStore } from '../src/shared/store';
import { threadState } from '../src/shared/types';

const DIST = path.resolve(__dirname, '../dist');
const PAUSE = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, budget = 4000): Promise<void> {
  const deadline = Date.now() + budget;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not become true before the deadline');
    await PAUSE(10);
  }
}

function fixture(t: TestContext, withStore = true) {
  // Temporary fixtures stay under the project, never in the real HOME or system temp.
  const base = fs.realpathSync(fs.mkdtempSync(path.resolve('.vr-hook-mcp-')));
  const home = path.join(base, 'home');
  const root = path.join(base, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: base,
  };
  delete env.VIBE_REVIEW_ROOT;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Adversarial Test');
  fs.writeFileSync(path.join(root, 'a.ts'), 'before\n');
  git('add', 'a.ts');
  git('commit', '-qm', 'fixture');
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.vibe-review/\n');
  fs.writeFileSync(path.join(root, 'a.ts'), 'after\n');
  if (withStore) {
    fs.mkdirSync(path.join(root, '.vibe-review'));
    // Stand in for an open VS Code window: agents only wait while one is running.
    new ReviewStore(root).markEditorOpen();
  }
  fs.mkdirSync(path.join(root, 'nested'));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    try {
      for (const dispose of cleanup.reverse()) await dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  return { root, home, env, git, cleanup, store: new ReviewStore(root) };
}

type HookResult = { out: string; err: string; code: number | null; signal: NodeJS.Signals | null };

function hook(t: TestContext, f: ReturnType<typeof fixture>, args: string[], input: unknown = { cwd: f.root }, closeStdin = true) {
  const child = spawn(process.execPath, [path.join(DIST, 'hook.js'), ...args], {
    cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let finished = false;
  child.stdout.on('data', (data) => { out += data; });
  child.stderr.on('data', (data) => { err += data; });
  child.stdin.on('error', () => {});
  const done = new Promise<HookResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { finished = true; resolve({ out, err, code, signal }); });
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 7000);
  done.finally(() => clearTimeout(watchdog)).catch(() => {});
  f.cleanup.push(async () => {
    if (!finished) child.kill('SIGKILL');
    await done;
  });
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  if (closeStdin) child.stdin.end(raw);
  else child.stdin.write(raw);
  return { child, done, finished: () => finished };
}

function decision(result: HookResult): any {
  assert.equal(result.code, 0, `hook failed: ${result.signal ?? result.err}`);
  assert.equal(result.err, '', 'unexpected diagnostic on a successful hook');
  const lines = result.out.trim().split('\n');
  assert.equal(lines.length, 1, `expected exactly one JSON decision, got ${result.out}`);
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed;
}

function submit(store: ReviewStore, body = 'review body') {
  const thread = store.createThread('a.ts', 0, 0, 'after', body);
  const review = store.submitDraft()!;
  return { thread, review };
}

async function mcp(t: TestContext, f: ReturnType<typeof fixture>) {
  const client = new Client({ name: 'vibe-review-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(DIST, 'mcp.js')], cwd: f.root,
    env: Object.fromEntries(Object.entries(f.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: 'pipe',
  });
  f.cleanup.push(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, call };
}

function text(result: any): string {
  return result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
}

async function toolError(action: Promise<any>): Promise<void> {
  const result = await action.catch((error: unknown) => ({ isError: true, error }));
  assert.equal(result.isError, true, 'invalid input must be rejected, not reported as success');
}

for (const raw of ['', '{broken', 'null', '[]', '"string"', '42', JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) })]) {
  const label = raw.length > 100 ? '2 MiB object' : JSON.stringify(raw);
  test(`hook input ${label}: exits successfully with one allow decision`, async (t) => {
    const f = fixture(t);
    assert.deepEqual(decision(await hook(t, f, ['stop', 'claude', '--timeout', '1'], raw).done), {});
  });
}

test('hook: open stdin cannot defeat the hook timeout', async (t) => {
  const f = fixture(t);
  const h = hook(t, f, ['stop', 'claude', '--timeout', '1'], '{}', false);
  const deadline = Date.now() + 2000;
  await until(() => h.finished() || Date.now() >= deadline, 2500);
  assert.equal(h.finished(), true, 'hook must terminate even when its stdin producer never closes');
  assert.deepEqual(decision(await h.done), {});
});

test('hook: unknown subcommand, non-repo cwd and missing store are harmless', async (t) => {
  const f = fixture(t, false);
  for (const [args, cwd] of [
    [['mystery', 'claude'], f.root],
    [['stop', 'claude'], f.home],
    [['prompt', 'codex'], f.root],
  ] as const) {
    assert.deepEqual(decision(await hook(t, f, [...args], { cwd }).done), {});
  }
  assert.equal(f.store.exists(), false, 'disabled hooks must not initialize review storage');
});

test('hook: unknown agent must not consume a submitted review as Claude', async (t) => {
  const f = fixture(t);
  const { review } = submit(f.store);
  assert.deepEqual(decision(await hook(t, f, ['prompt', 'not-an-agent']).done), {});
  assert.equal(f.store.getReview(review.id)!.status, 'submitted');
});

test('hook: repo subdirectory resolves to the root and delivers the queued review', async (t) => {
  const f = fixture(t);
  submit(f.store, 'nested cwd feedback');
  const d = decision(await hook(t, f, ['stop', 'codex'], { cwd: path.join(f.root, 'nested') }).done);
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /nested cwd feedback/);
});

test('hook: a clean worktree never waits even with Review Mode enabled', async (t) => {
  const f = fixture(t);
  f.git('checkout', '--', 'a.ts');
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 2 });
  const h = hook(t, f, ['stop', 'claude', '--timeout', '2']);
  await until(() => h.finished() || f.store.getAgentState().waiting);
  assert.equal(f.store.getAgentState().waiting, false);
  assert.deepEqual(decision(await h.done), {});
});

for (const agent of ['claude', 'codex', 'copilot']) {
  test(`hook ${agent}: waiting stdout is exactly one decision`, async (t) => {
    const f = fixture(t);
    f.store.setConfig({ mode: 'on', waitTimeoutSec: 2 });
    const h = hook(t, f, ['stop', agent, '--timeout', '2']);
    await until(() => f.store.getAgentState().waiting);
    submit(f.store, 'single stdout decision');
    const d = decision(await h.done);
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /single stdout decision/);
    assert.equal(f.store.getAgentState().waiting, false);
  });

  test(`hook ${agent}: prompt shape, exactly-once delivery and no replay after stop`, async (t) => {
    const f = fixture(t);
    const { review } = submit(f.store, 'unique prompt feedback');
    const input = { cwd: f.root, transformedPrompt: 'original prompt', prompt: 'fallback' };
    const d = decision(await hook(t, f, ['prompt', agent], input).done);
    if (agent === 'copilot') {
      assert.deepEqual(Object.keys(d), ['modifiedTransformedPrompt']);
      assert.match(d.modifiedTransformedPrompt, /^original prompt\n\n# Local code review/);
      assert.match(d.modifiedTransformedPrompt, /unique prompt feedback/);
    } else {
      assert.deepEqual(Object.keys(d), ['hookSpecificOutput']);
      assert.equal(d.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(d.hookSpecificOutput.additionalContext, /unique prompt feedback/);
    }
    assert.equal(f.store.getReview(review.id)!.deliveredTo, agent);
    assert.deepEqual(decision(await hook(t, f, ['prompt', agent], input).done), {});
    submit(f.store, 'stop-only feedback');
    assert.equal(decision(await hook(t, f, ['stop', agent], input).done).decision, 'block');
    assert.deepEqual(decision(await hook(t, f, ['prompt', agent], input).done), {});
  });
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGKILL'] as const) {
  test(`hook ${signal}: waiting state clears or dead pid is ignored`, async (t) => {
    const f = fixture(t);
    f.store.setConfig({ mode: 'on', waitTimeoutSec: 3 });
    const h = hook(t, f, ['stop', 'claude', '--timeout', '3']);
    await until(() => f.store.getAgentState().pid === h.child.pid);
    h.child.kill(signal);
    const result = await h.done;
    assert.equal(f.store.getAgentState().waiting, false);
    if (signal === 'SIGKILL') {
      assert.equal(result.signal, signal);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.store.dir, 'agent.json'), 'utf8')).waiting, true);
    } else {
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.store.dir, 'agent.json'), 'utf8')).waiting, false);
    }
    assert.equal(result.out, '', 'signal cancellation permits no decision but not stray stdout');
  });
}

test('hook: two waiting processes deliver a review to exactly one consumer', async (t) => {
  const f = fixture(t);
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 2 });
  const first = hook(t, f, ['stop', 'claude', '--timeout', '2']);
  await until(() => f.store.getAgentState().pid === first.child.pid);
  const second = hook(t, f, ['stop', 'codex', '--timeout', '2']);
  await until(() => f.store.getAgentState().pid === second.child.pid);
  const { review } = submit(f.store, 'race-token');
  const results = (await Promise.all([first.done, second.done])).map(decision);
  assert.equal(results.filter((d) => d.decision === 'block' && /race-token/.test(d.reason)).length, 1);
  assert.equal(results.filter((d) => Object.keys(d).length === 0).length, 1);
  assert.equal(f.store.getReview(review.id)!.status, 'delivered');
  assert.equal(f.store.getAgentState().waiting, false);
});

test('hook: submission during process startup is not lost', async (t) => {
  const f = fixture(t);
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 2 });
  const h = hook(t, f, ['stop', 'claude', '--timeout', '2']);
  submit(f.store, 'startup-token');
  assert.match(decision(await h.done).reason, /startup-token/);
});

// With --timeout N the agent kills the hook at N s, so the hook deliberately stops at
// waitBudgetSec(config, N) (here 4 -> 2 s). A submission just before *that* deadline, after the
// last regular poll, must still be caught by the final check rather than abandoned.
test('hook: submission before deadline but after final poll is still delivered', async (t) => {
  const f = fixture(t);
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 30 });
  const h = hook(t, f, ['stop', 'claude', '--timeout', '4']);
  await until(() => f.store.getAgentState().waiting);
  const since = Date.parse(f.store.getAgentState().since!);
  await until(() => Date.now() >= since + 1850, 3000);
  assert.ok(!h.finished(), 'fixture must submit before the hook gives up');
  submit(f.store, 'deadline-token');
  const d = decision(await h.done);
  assert.equal(d.decision, 'block', 'a review submitted within the budget must not be abandoned');
  assert.match(d.reason, /deadline-token/);
});

for (const action of ['approve', 'discard', 'off'] as const) {
  test(`hook: ${action} releases waiting without delivering drafts`, async (t) => {
    const f = fixture(t);
    f.store.setConfig({ mode: 'on', waitTimeoutSec: 2 });
    f.store.createThread('a.ts', 0, 0, 'after', 'unsent draft');
    fs.writeFileSync(path.join(f.store.dir, 'signal.json'), JSON.stringify({ action: 'approve', at: '2000-01-01T00:00:00.000Z' }));
    const h = hook(t, f, ['stop', 'claude', '--timeout', '2']);
    await until(() => f.store.getAgentState().waiting);
    if (action === 'off') f.store.setConfig({ mode: 'off' });
    else f.store.sendSignal(action);
    assert.deepEqual(decision(await h.done), {});
    assert.equal(f.store.getAgentState().waiting, false);
    assert.equal(f.store.listReviews()[0].status, 'draft');
  });
}

test('hook: off exits without waiting; enabling affects only the next invocation', async (t) => {
  const f = fixture(t);
  assert.deepEqual(decision(await hook(t, f, ['stop', 'claude', '--timeout', '1']).done), {});
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 1 });
  const h = hook(t, f, ['stop', 'claude', '--timeout', '1']);
  await until(() => f.store.getAgentState().waiting);
  assert.deepEqual(decision(await h.done), {});
  assert.equal(f.store.getAgentState().waiting, false);
});

test('hook: --timeout 1 bounds waiting even if config allows thirty minutes', async (t) => {
  const f = fixture(t);
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 1800 });
  const start = Date.now();
  const h = hook(t, f, ['stop', 'claude', '--timeout', '1']);
  await until(() => h.finished() || Date.now() >= start + 2200, 3000);
  assert.equal(h.finished(), true, '--timeout must bound the wait for short agent deadlines too');
  assert.deepEqual(decision(await h.done), {});
});

// Product intent: the agent waits for review after *every* turn, including turns that were
// themselves continuations of a review. Recursion is bounded by MAX_CONTINUATIONS (tested
// below), not by stop_hook_active.
test('hook: stop_hook_active still waits for the next review round', async (t) => {
  const f = fixture(t);
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 2 });
  const h = hook(t, f, ['stop', 'claude', '--timeout', '30'], { cwd: f.root, stop_hook_active: true });
  await until(() => h.finished() || f.store.getAgentState().waiting);
  assert.equal(f.store.getAgentState().waiting, true, 'continuation turns are reviewed too');
  f.store.sendSignal('approve');
  assert.deepEqual(decision(await h.done), {});
});

for (const agent of ['claude', 'copilot']) {
  test(`hook ${agent}: eight continuations cap and prompt reset`, async (t) => {
    const f = fixture(t);
    const input = { cwd: f.root, session_id: 'same-session', stop_hook_active: true };
    for (let round = 0; round < 8; round++) {
      submit(f.store, `round-${round}`);
      assert.equal(decision(await hook(t, f, ['stop', agent, '--timeout', '1'], input).done).decision, 'block');
    }
    const { review } = submit(f.store, 'round-capped');
    assert.deepEqual(decision(await hook(t, f, ['stop', agent, '--timeout', '1'], input).done), {});
    assert.equal(f.store.getReview(review.id)!.status, 'submitted', 'capped feedback remains queued');
    const prompt = decision(await hook(t, f, ['prompt', agent], { cwd: f.root, session_id: 'same-session', prompt: 'resume' }).done);
    assert.match(JSON.stringify(prompt), /round-capped/);
    submit(f.store, 'round-after-reset');
    assert.match(decision(await hook(t, f, ['stop', agent, '--timeout', '1'], input).done).reason, /round-after-reset/);
  });
}

test('MCP: missing/invalid arguments and nonexistent threads are rejected without mutations', async (t) => {
  const f = fixture(t);
  const { thread } = submit(f.store);
  const { client, call } = await mcp(t, f);
  const before = fs.readFileSync(path.join(f.store.dir, 'threads', `${thread.id}.json`), 'utf8');
  for (const [name, args] of [
    ['reply_to_thread', {}], ['reply_to_thread', { thread_id: thread.id, body: '' }],
    ['reply_to_thread', { thread_id: 17, body: 'x' }],
    ['resolve_thread', {}], ['resolve_thread', { thread_id: 'thr_nonexistent' }],
    ['reply_to_thread', { thread_id: 'thr_nonexistent', body: 'x' }],
    ['list_threads', { status: 'bogus' }], ['get_review', { repo_path: 17 }],
    ['wait_for_review', { timeout_sec: 0 }], ['wait_for_review', { timeout_sec: 56 }],
    ['wait_for_review', { timeout_sec: 1.5 }],
  ] as Array<[string, Record<string, unknown>]>) await toolError(call(name, args));
  assert.equal(fs.readFileSync(path.join(f.store.dir, 'threads', `${thread.id}.json`), 'utf8'), before);
  assert.equal(f.store.listReviews()[0].status, 'submitted');
  await client.ping();
});

test('MCP: subdirectory and normalized repo path work; nonexistent/non-repo paths fail', async (t) => {
  const f = fixture(t);
  const { thread } = submit(f.store);
  const { call } = await mcp(t, f);
  for (const repo_path of [path.join(f.root, 'nested'), `${f.root}/nested/..`]) {
    assert.match(text(await call('list_threads', { repo_path })), new RegExp(thread.id));
  }
  for (const repo_path of [path.join(f.home, 'missing'), f.home, '../../not-a-repo']) {
    await toolError(call('get_review', { repo_path }));
  }
  assert.equal(f.store.listReviews()[0].status, 'submitted');
});

test('MCP: traversal thread_id cannot read or mutate a record outside threads/', async (t) => {
  const f = fixture(t);
  const { thread } = submit(f.store);
  const victim = path.join(f.store.dir, 'victim.json');
  fs.writeFileSync(victim, JSON.stringify(thread));
  const before = fs.readFileSync(victim, 'utf8');
  const { call } = await mcp(t, f);
  await toolError(call('reply_to_thread', { thread_id: '../victim', body: 'injected reply' }));
  await toolError(call('resolve_thread', { thread_id: '../victim' }));
  assert.equal(fs.readFileSync(victim, 'utf8'), before);
  assert.equal(f.store.getThread(thread.id)!.comments.length, 1);
});

test('MCP: agent reply preserves reviewer-resolved state; user reply reopens as Pending', async (t) => {
  const f = fixture(t);
  const { thread } = submit(f.store);
  f.store.setThreadStatus(thread.id, 'resolved');
  const { call } = await mcp(t, f);
  const result = await call('reply_to_thread', { thread_id: thread.id, body: 'additional explanation' });
  assert.notEqual(result.isError, true);
  assert.equal(threadState(f.store.getThread(thread.id)!), 'resolved', 'agent must not revoke reviewer acceptance');
  assert.match(text(await call('list_threads', { status: 'resolved' })), /additional explanation/);
  assert.doesNotMatch(text(await call('list_threads', { status: 'active' })), new RegExp(thread.id));
  f.store.addComment(thread.id, 'user', 'new concern');
  assert.equal(threadState(f.store.getThread(thread.id)!), 'pending');
});

test('MCP: resolve_thread without body is idempotent and only marks Active', async (t) => {
  const f = fixture(t);
  const { thread } = submit(f.store);
  const { call } = await mcp(t, f);
  await call('resolve_thread', { thread_id: thread.id });
  const after = f.store.getThread(thread.id)!;
  assert.equal(after.status, 'open');
  assert.equal(threadState(after), 'active');
  await call('resolve_thread', { thread_id: thread.id });
  assert.deepEqual(f.store.getThread(thread.id), after);
});

test('MCP: retrying resolve_thread with the same body adds no duplicate note', async (t) => {
  const f = fixture(t);
  const { thread } = submit(f.store);
  const { call } = await mcp(t, f);
  const args = { thread_id: thread.id, body: 'Fixed the issue.' };
  await call('resolve_thread', args);
  const after = f.store.getThread(thread.id)!;
  await call('resolve_thread', args);
  assert.deepEqual(f.store.getThread(thread.id), after);
});

test('MCP: wait timeout leaves drafts intact and server responsive', async (t) => {
  const f = fixture(t);
  f.store.createThread('a.ts', 0, 0, 'after', 'not submitted');
  const { client, call } = await mcp(t, f);
  const start = Date.now();
  assert.match(text(await call('wait_for_review', { timeout_sec: 1 })), /No review yet/);
  assert.ok(Date.now() - start >= 900 && Date.now() - start < 3000);
  assert.equal(f.store.listReviews()[0].status, 'draft');
  await client.ping();
});

test('MCP: cancelled wait must never consume a subsequently submitted review', async (t) => {
  const f = fixture(t);
  const { client } = await mcp(t, f);
  const controller = new AbortController();
  const waiting = client.callTool({ name: 'wait_for_review', arguments: { timeout_sec: 3 } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(waiting, /cancel|abort/i);
  await client.ping();
  controller.abort(new Error('client cancellation'));
  await rejected;
  await client.ping();
  const { review } = submit(f.store, 'cancelled-wait-token');
  const observationEnd = Date.now() + 1250;
  await until(() => f.store.getReview(review.id)!.status !== 'submitted' || Date.now() >= observationEnd, 2000);
  assert.equal(f.store.getReview(review.id)!.status, 'submitted', 'cancelled handler continued polling and stole the review');
});

test('MCP: wait_for_review reports the agent as waiting, keeps a lease across re-calls, and clears on delivery', async (t) => {
  const f = fixture(t);
  const { client, call } = await mcp(t, f);
  assert.match(text(await call('wait_for_review', { timeout_sec: 1 })), /No review yet/);
  const lease = f.store.getAgentState();
  assert.equal(lease.waiting, true, 'gap between wait_for_review calls must not read as "not waiting"');
  assert.ok(Date.parse(lease.expires!) > Date.now());

  const waiting = call('wait_for_review', { timeout_sec: 5 });
  await client.ping();
  assert.equal(f.store.getAgentState().since, lease.since, 're-call must keep the original wait start');
  const { review } = submit(f.store, 'lease-token');
  assert.match(text(await waiting), /lease-token/);
  assert.equal(f.store.getReview(review.id)!.status, 'delivered');
  assert.equal(f.store.getAgentState().waiting, false);

  f.store.setAgentState({ waiting: true, pid: process.pid, expires: new Date(Date.now() - 1).toISOString() });
  assert.equal(f.store.getAgentState().waiting, false, 'expired lease');
  f.store.setAgentState({ waiting: true, pid: process.pid, expires: 'garbage' });
  assert.equal(f.store.getAgentState().waiting, false, 'unparseable lease');
});

test('MCP: wait_for_review does not take over a waiting stop hook', async (t) => {
  const f = fixture(t);
  f.store.setAgentState({ waiting: true, agent: 'codex', pid: process.pid, since: 'hook-start' });
  const { call } = await mcp(t, f);
  await call('wait_for_review', { timeout_sec: 1 });
  assert.deepEqual(f.store.getAgentState(), { waiting: true, agent: 'codex', pid: process.pid, sessionId: undefined, since: 'hook-start', expires: undefined });
});

test('MCP + stop hook: concurrent waits have exactly one delivery winner', async (t) => {
  const f = fixture(t);
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 2 });
  const { client, call } = await mcp(t, f);
  const waiting = call('wait_for_review', { timeout_sec: 2 });
  await client.ping();
  const h = hook(t, f, ['stop', 'claude', '--timeout', '2']);
  await until(() => f.store.getAgentState().agent === 'claude');
  const { review } = submit(f.store, 'exclusive-mcp-stop-token');
  const [response, result] = await Promise.all([waiting, h.done]);
  const d = decision(result);
  const winners = Number(text(response).includes('exclusive-mcp-stop-token')) +
    Number(d.decision === 'block' && d.reason.includes('exclusive-mcp-stop-token'));
  assert.equal(winners, 1);
  assert.equal(f.store.getReview(review.id)!.status, 'delivered');
});

test('MCP images: ten-image cap, 5 MiB boundary, missing and traversal files', async (t) => {
  const f = fixture(t);
  const dir = path.join(f.store.dir, 'attachments');
  fs.mkdirSync(dir);
  const exact = Buffer.alloc(5 * 1024 * 1024, 65);
  fs.writeFileSync(path.join(dir, 'exact.png'), exact);
  fs.writeFileSync(path.join(dir, 'oversized.png'), Buffer.alloc(exact.length + 1, 66));
  fs.writeFileSync(path.join(f.store.dir, 'outside.png'), 'private fixture image');
  const markdown = [
    '![too-big](.vibe-review/attachments/oversized.png)',
    '![missing](.vibe-review/attachments/missing.png)',
    '![traversal](.vibe-review/attachments/../outside.png)',
    '![nested-traversal](.vibe-review/attachments/nested/../../outside.png)',
    '![exact](.vibe-review/attachments/exact.png)',
  ];
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(dir, `${i}.png`), `image-${i}`);
    markdown.push(`![${i}](.vibe-review/attachments/${i}.png)`);
  }
  submit(f.store, markdown.join('\n'));
  const { call } = await mcp(t, f);
  const result: any = await call('get_review');
  const images = result.content.filter((item: any) => item.type === 'image');
  assert.equal(images.length, 10);
  assert.equal(images[0].data, exact.toString('base64'));
  assert.deepEqual(images.slice(1).map((item: any) => Buffer.from(item.data, 'base64').toString()), Array.from({ length: 9 }, (_, i) => `image-${i}`));
  assert.ok(images.every((item: any) => item.mimeType === 'image/png'));
  assert.ok(!text(result).includes(`<${path.join(f.store.dir, 'outside.png')}>`));
});

test('MCP images: attachment symlink cannot expose a file outside attachments/', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.store.dir, 'attachments'));
  const privateFile = path.join(f.home, 'private.png');
  fs.writeFileSync(privateFile, 'private fixture bytes');
  fs.symlinkSync(privateFile, path.join(f.store.dir, 'attachments', 'link.png'));
  submit(f.store, '![linked](.vibe-review/attachments/link.png)');
  const { call } = await mcp(t, f);
  const result: any = await call('get_review');
  assert.equal(result.content.filter((item: any) => item.type === 'image').length, 0);
});

test('hook: Review Mode on but VS Code closed never waits', async (t) => {
  const f = fixture(t);
  f.store.markEditorClosed();
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 30 });
  const start = Date.now();
  const h = hook(t, f, ['stop', 'claude', '--timeout', '3600']);
  assert.deepEqual(decision(await h.done), {});
  assert.ok(Date.now() - start < 3000, 'hook held the agent with no editor open');
  assert.equal(f.store.getAgentState().waiting, false);
});

test('hook: a review submitted before VS Code closed is still delivered', async (t) => {
  const f = fixture(t);
  f.store.setConfig({ mode: 'on', waitTimeoutSec: 30 });
  submit(f.store, 'submitted-then-closed');
  f.store.markEditorClosed();
  const d = decision(await hook(t, f, ['stop', 'copilot', '--timeout', '3600']).done);
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /submitted-then-closed/);
});

for (const how of ['closed', 'crashed'] as const) {
  test(`hook: a waiting stop hook lets the agent go when VS Code is ${how}`, async (t) => {
    const f = fixture(t);
    f.store.markEditorClosed();
    const editor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    t.after(() => { editor.kill('SIGKILL'); });
    f.store.markEditorOpen(editor.pid!);
    f.store.setConfig({ mode: 'on', waitTimeoutSec: 30 });
    const h = hook(t, f, ['stop', 'codex', '--timeout', '3600']);
    await until(() => f.store.getAgentState().waiting);
    const start = Date.now();
    if (how === 'closed') f.store.markEditorClosed(editor.pid!);
    else editor.kill('SIGKILL');
    assert.deepEqual(decision(await h.done), {});
    assert.ok(Date.now() - start < 3000, 'hook kept waiting after VS Code went away');
    assert.equal(f.store.getAgentState().waiting, false);
  });
}

test('MCP: wait_for_review returns at once without an open editor and claims no waiting state', async (t) => {
  const f = fixture(t);
  f.store.markEditorClosed();
  const { call } = await mcp(t, f);
  const start = Date.now();
  assert.match(text(await call('wait_for_review', { timeout_sec: 30 })), /No editor \(VS Code or Visual Studio\) is open/);
  assert.ok(Date.now() - start < 3000);
  assert.equal(f.store.getAgentState().waiting, false);
});

test('MCP: wait_for_review still delivers a pending review when VS Code is closed', async (t) => {
  const f = fixture(t);
  const { review } = submit(f.store, 'delivered-without-editor');
  f.store.markEditorClosed();
  const { call } = await mcp(t, f);
  assert.match(text(await call('wait_for_review', { timeout_sec: 30 })), /delivered-without-editor/);
  assert.equal(f.store.getReview(review.id)!.status, 'delivered');
});

test('MCP: wait_for_review stops waiting and clears its lease when VS Code closes mid-wait', async (t) => {
  const f = fixture(t);
  const { client, call } = await mcp(t, f);
  const waiting = call('wait_for_review', { timeout_sec: 30 });
  await client.ping();
  await until(() => f.store.getAgentState().waiting);
  const start = Date.now();
  f.store.markEditorClosed();
  assert.match(text(await waiting), /No editor \(VS Code or Visual Studio\) is open/);
  assert.ok(Date.now() - start < 3000);
  assert.equal(f.store.getAgentState().waiting, false);
});
