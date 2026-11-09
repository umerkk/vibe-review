import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReviewStore } from '../src/shared/store';
import { threadState } from '../src/shared/types';
import { getChangedFiles, getChangedLineRanges, parseHunks } from '../src/shared/git';
import { formatReview, locateThread } from '../src/shared/format';
import { findAttachments, saveAttachment } from '../src/shared/attachments';
import { configureAgent, isInstalled, uninstallAll } from '../src/shared/setup';

const DIST = path.resolve(__dirname, '..', 'dist');

function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vr-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\nthree\nfour\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one\nTWO\nthree\nfour\nfive\n');
  fs.writeFileSync(path.join(dir, 'new.ts'), 'brand new\n');
  fs.mkdirSync(path.join(dir, '.vibe-review'));
  // Stand in for an open VS Code window: agents only wait while one is running.
  new ReviewStore(dir).markEditorOpen();
  return dir;
}

function runHook(args: string[], input: object): { promise: Promise<{ out: string; code: number | null }>; kill: () => void } {
  const child = spawn(process.execPath, [path.join(DIST, 'hook.js'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(JSON.stringify(input));
  const promise = new Promise<{ out: string; code: number | null }>((resolve) => child.on('close', (code) => resolve({ out, code })));
  return { promise, kill: () => child.kill('SIGTERM') };
}

/** Last non-progress JSON line, as agents parse it. */
function decision(out: string): any {
  const lines = out.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.type !== 'progress');
  assert.equal(lines.length, 1, `expected exactly one decision object, got: ${out}`);
  return lines[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(50);
  }
}

test('git: changed files and line ranges', () => {
  const root = makeRepo();
  const files = getChangedFiles(root);
  assert.deepEqual(files.map((f) => [f.path, f.kind]).sort(), [['a.ts', 'modified'], ['new.ts', 'untracked']]);
  assert.deepEqual(getChangedLineRanges(root, 'a.ts'), [[1, 1], [4, 4]]);
  assert.deepEqual(parseHunks('@@ -3,2 +2,0 @@\n'), [[1, 1]]);
});

test('locateThread follows moved code and falls back when gone', () => {
  const t = { startLine: 1, endLine: 2, anchor: 'b\nc' } as any;
  assert.deepEqual(locateThread(['a', 'b', 'c'], t), [1, 2]);
  assert.deepEqual(locateThread(['x', 'y', 'a', 'b', 'c'], t), [3, 4]);
  assert.deepEqual(locateThread(['a'], t), [0, 0]);
});

test('git: worktree-only rename (git add -N) consumes its source entry', () => {
  const root = makeRepo();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\nfour\n');
  git('mv', 'a.ts', 'moved.ts');
  git('reset', '-q');
  git('add', '-N', 'moved.ts');
  const files = getChangedFiles(root).filter((f) => f.path !== 'new.ts');
  assert.deepEqual(files, [{ path: 'moved.ts', oldPath: 'a.ts', kind: 'renamed' }]);
});

test('store: draft → submit → claim is exclusive; discard removes drafts', () => {
  const store = new ReviewStore(makeRepo());
  const t = store.createThread('a.ts', 1, 1, 'TWO', 'rename this');
  assert.equal(store.draftCommentCount(), 1);
  assert.equal(store.getUndeliveredReview(), undefined);
  const review = store.submitDraft('overall')!;
  assert.equal(review.status, 'submitted');
  assert.equal(store.getThread(t.id)!.comments[0].draft, false);
  assert.ok(store.claimForDelivery(review.id, 'claude'));
  assert.equal(store.claimForDelivery(review.id, 'codex'), undefined);
  assert.equal(store.getUndeliveredReview(), undefined);

  store.createThread('a.ts', 4, 4, 'five', 'drop me');
  store.addComment(t.id, 'user', 'follow-up draft');
  store.discardDraft();
  assert.equal(store.listThreads().length, 1);
  assert.equal(store.getThread(t.id)!.comments.length, 1);
});

for (const agent of ['claude', 'codex', 'copilot'] as const) {
  test(`hook stop (${agent}): waits, then delivers submitted review as a block decision`, async () => {
    const root = makeRepo();
    const store = new ReviewStore(root);
    store.setConfig({ mode: 'on' });
    const h = runHook(['stop', agent, '--timeout', '3600'], { cwd: root, session_id: 's1' });
    await until(() => store.getAgentState().waiting);
    assert.equal(store.getAgentState().agent, agent);

    store.createThread('a.ts', 1, 1, 'TWO', 'Why uppercase?');
    store.submitDraft();
    const { out, code } = await h.promise;
    assert.equal(code, 0);
    const d = decision(out);
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /Why uppercase\?/);
    assert.match(d.reason, /a\.ts:2/);
    assert.equal(store.getAgentState().waiting, false);
    assert.equal(store.listReviews()[0].status, 'delivered');
  });
}

test('thread states: pending → active → resolved; replying to a resolved thread reopens it as pending', () => {
  const store = new ReviewStore(makeRepo());
  const t = store.createThread('a.ts', 1, 1, 'TWO', 'rename');
  assert.equal(threadState(store.getThread(t.id)!), 'pending');
  store.submitDraft();
  assert.equal(threadState(store.getThread(t.id)!), 'pending');
  store.addComment(t.id, 'agent', 'done');
  assert.equal(threadState(store.getThread(t.id)!), 'active');
  store.setThreadStatus(t.id, 'resolved');
  assert.equal(threadState(store.getThread(t.id)!), 'resolved');
  store.addComment(t.id, 'user', 'actually, one more thing');
  assert.equal(threadState(store.getThread(t.id)!), 'pending');
});

test('hook stop: approve signal lets the agent stop', async () => {
  const root = makeRepo();
  const store = new ReviewStore(root);
  store.setConfig({ mode: 'on' });
  // A stale approval from before the hook started must be ignored.
  store.sendSignal('approve');
  await sleep(20);
  const h = runHook(['stop', 'claude'], { cwd: root });
  await until(() => store.getAgentState().waiting);
  await sleep(1000);
  assert.equal(store.getAgentState().waiting, true, 'stale signal released the hook');
  store.sendSignal('approve');
  assert.deepEqual(decision((await h.promise).out), {});
});

test('hook stop: turning mode off releases the agent; SIGTERM clears waiting state', async () => {
  const root = makeRepo();
  const store = new ReviewStore(root);
  store.setConfig({ mode: 'on' });
  const h1 = runHook(['stop', 'codex'], { cwd: root });
  await until(() => store.getAgentState().waiting);
  store.setConfig({ mode: 'off' });
  assert.deepEqual(decision((await h1.promise).out), {});

  store.setConfig({ mode: 'on' });
  const h2 = runHook(['stop', 'codex'], { cwd: root });
  await until(() => store.getAgentState().waiting);
  h2.kill();
  await h2.promise;
  // Check the raw file: getAgentState() would also report false for a missing/garbled file.
  const raw = JSON.parse(fs.readFileSync(path.join(store.dir, 'agent.json'), 'utf8'));
  assert.equal(raw.waiting, false);
});

test('hook stop: no wait when mode off, no changes, outside a repo, or store missing', async () => {
  const root = makeRepo();
  assert.deepEqual(decision((await runHook(['stop', 'claude'], { cwd: root }).promise).out), {});

  const store = new ReviewStore(root);
  store.setConfig({ mode: 'on' });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'all'], { cwd: root });
  assert.deepEqual(decision((await runHook(['stop', 'claude'], { cwd: root }).promise).out), {});

  assert.deepEqual(decision((await runHook(['stop', 'claude'], { cwd: os.tmpdir() }).promise).out), {});
});

test('hook stop: timeout respects --timeout headroom and config', async () => {
  const root = makeRepo();
  const store = new ReviewStore(root);
  store.setConfig({ mode: 'on', waitTimeoutSec: 1 });
  const started = Date.now();
  assert.deepEqual(decision((await runHook(['stop', 'claude', '--timeout', '3600'], { cwd: root }).promise).out), {});
  assert.ok(Date.now() - started < 4000);

  // Config allows 30 s, but the agent kills the hook at 2 s: it must give up at 1 s (half the
  // timeout as headroom), not run into the kill.
  store.setConfig({ mode: 'on', waitTimeoutSec: 30 });
  const t0 = Date.now();
  assert.deepEqual(decision((await runHook(['stop', 'claude', '--timeout', '2'], { cwd: root }).promise).out), {});
  const took = Date.now() - t0;
  assert.ok(took >= 800 && took < 1900, `expected ~1s wait, took ${took}ms`);
});

test('hook stop: delivers a pending review immediately even when mode is off', async () => {
  const root = makeRepo();
  const store = new ReviewStore(root);
  store.createThread('a.ts', 1, 1, 'TWO', 'fix me');
  store.submitDraft();
  const d = decision((await runHook(['stop', 'claude'], { cwd: root }).promise).out);
  assert.equal(d.decision, 'block');
});

test('hook prompt: attaches undelivered review in each agent format, once', async () => {
  for (const agent of ['claude', 'codex', 'copilot'] as const) {
    const root = makeRepo();
    const store = new ReviewStore(root);
    store.createThread('a.ts', 1, 1, 'TWO', 'please fix');
    store.submitDraft('overall note');
    const input = { cwd: root, prompt: 'review', transformedPrompt: 'review' };
    const d = decision((await runHook(['prompt', agent], input).promise).out);
    if (agent === 'copilot') {
      assert.match(d.modifiedTransformedPrompt, /^review\n\n# Local code review/);
      assert.match(d.modifiedTransformedPrompt, /overall note/);
    } else {
      assert.equal(d.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(d.hookSpecificOutput.additionalContext, /please fix/);
    }
    assert.deepEqual(decision((await runHook(['prompt', agent], input).promise).out), {});
  }
});

test('mcp server: get_review, reply_to_thread, resolve_thread, wait_for_review', async () => {
  const root = makeRepo();
  const store = new ReviewStore(root);
  const t = store.createThread('a.ts', 1, 1, 'TWO', 'rename');
  const t2 = store.createThread('a.ts', 4, 4, 'five', 'and this');
  store.submitDraft();

  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(DIST, 'mcp.js')], cwd: root }));
  try {
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(tools, ['get_review', 'list_threads', 'reply_to_thread', 'resolve_thread', 'wait_for_review']);

    const text = (r: any) => r.content[0].text as string;
    assert.match(text(await client.callTool({ name: 'get_review', arguments: {} })), new RegExp(t.id));
    assert.equal(store.listReviews()[0].status, 'delivered');

    await client.callTool({ name: 'reply_to_thread', arguments: { thread_id: t.id, body: 'Renamed.' } });
    await client.callTool({ name: 'resolve_thread', arguments: { thread_id: t.id } });
    const after = store.getThread(t.id)!;
    assert.equal(threadState(after), 'active', 'the agent cannot resolve; the reviewer accepts');
    assert.equal(after.comments.length, 2, 'no duplicate note after reply_to_thread');
    await client.callTool({ name: 'resolve_thread', arguments: { thread_id: t2.id } });
    assert.equal(threadState(store.getThread(t2.id)!), 'active');
    assert.match(store.getThread(t2.id)!.comments.at(-1)!.body, /Addressed/);

    const bad = await client.callTool({ name: 'reply_to_thread', arguments: { thread_id: 'thr_nope', body: 'x' } });
    assert.equal(bad.isError, true);

    const waiting = client.callTool({ name: 'wait_for_review', arguments: { timeout_sec: 10, repo_path: root } });
    await sleep(300);
    store.addComment(t.id, 'user', 'one more thing');
    store.submitDraft();
    const got = text(await waiting);
    assert.match(got, /one more thing/);
    assert.match(got, /\(new\)/);
  } finally {
    await client.close();
  }
});

test('attachments: pasted images reach the agent as absolute paths and MCP image content', async () => {
  const root = makeRepo();
  const store = new ReviewStore(root);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const rel = saveAttachment(root, png, 'png');
  const t = store.createThread('a.ts', 1, 1, 'TWO', `looks off, see ![shot](${rel}) and ![x](.vibe-review/attachments/../config.json)`);
  const review = store.submitDraft()!;

  assert.deepEqual(findAttachments(root, store.getThread(t.id)!.comments[0].body).map((a) => a.rel), [rel]);
  const formatted = formatReview(store, review);
  assert.ok(formatted.includes(`![shot](<${path.join(root, rel)}>)`));
  assert.match(formatted, /## Attached images \(1\)/);
  assert.ok(!formatted.includes(path.join(root, '.vibe-review/config.json')), 'paths escaping attachments/ are ignored');

  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(DIST, 'mcp.js')], cwd: root }));
  try {
    const res: any = await client.callTool({ name: 'get_review', arguments: {} });
    assert.equal(res.content.length, 2);
    assert.deepEqual(res.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  } finally {
    await client.close();
  }
});

test('setup: installs and uninstalls idempotently, preserving existing config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-home-'));
  const prevCopilotHome = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME;
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }),
    );
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt"\n');
    const ctx = { home, nodePath: '/usr/local/bin/node', binDir: '/Users/x y/.vibe-review/bin' };

    for (let i = 0; i < 2; i++) for (const a of ['claude', 'codex', 'copilot'] as const) configureAgent(a, ctx, true);

    const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(claude.model, 'x');
    assert.equal(claude.hooks.Stop.length, 2);
    assert.equal(claude.hooks.UserPromptSubmit.length, 1);
    assert.match(claude.hooks.Stop[1].hooks[0].command, /'\/Users\/x y\/.vibe-review\/bin\/hook.js' stop claude --timeout 3600/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers['vibe-review']);

    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.equal(toml.match(/\[mcp_servers\.vibe-review\]/g)?.length, 1);
    assert.match(toml, /^model = "gpt"/);
    const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codexHooks.hooks.Stop.length, 1);

    const cp = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'hooks', 'vibe-review.json'), 'utf8'));
    assert.equal(cp.hooks.agentStop[0].timeoutSec, 3600);
    assert.ok(cp.hooks.userPromptTransformed);

    for (const a of ['claude', 'codex', 'copilot'] as const) configureAgent(a, ctx, false);
    const claudeAfter = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(claudeAfter.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
    assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').trim(), 'model = "gpt"');
    assert.equal(fs.existsSync(path.join(home, '.copilot', 'hooks', 'vibe-review.json')), false);
  } finally {
    if (prevCopilotHome !== undefined) process.env.COPILOT_HOME = prevCopilotHome;
  }
});

test('uninstall: no-op for untouched agents; uninstallAll removes entries and runtime', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-home-'));
  const prevCopilotHome = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME;
  const listFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  try {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt"\n');
    const binDir = path.join(home, '.vibe-review', 'bin');

    // Never set up: uninstalling must not create, rewrite or back up anything.
    const before = listFiles(home);
    for (const a of ['claude', 'codex', 'copilot'] as const) configureAgent(a, { home, nodePath: 'node', binDir }, false);
    assert.deepEqual(listFiles(home), before);
    assert.equal(isInstalled('claude', home), false);

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'hook.js'), '');
    for (const a of ['claude', 'codex', 'copilot'] as const) configureAgent(a, { home, nodePath: '/n', binDir }, true);
    assert.ok((['claude', 'codex', 'copilot'] as const).every((a) => isInstalled(a, home)));

    const result = uninstallAll(home);
    assert.deepEqual(result, { removedFrom: ['claude', 'codex', 'copilot'], errors: [], runtimeRemoved: true });
    assert.ok((['claude', 'codex', 'copilot'] as const).every((a) => !isInstalled(a, home)));
    assert.equal(fs.existsSync(path.join(home, '.vibe-review')), false);
    assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').trim(), 'model = "gpt"');

    // A broken config keeps the runtime, so the agent isn't left pointing at a missing script.
    fs.mkdirSync(binDir, { recursive: true });
    configureAgent('claude', { home, nodePath: '/n', binDir }, true);
    fs.appendFileSync(path.join(home, '.claude', 'settings.json'), '{oops');
    const broken = uninstallAll(home);
    assert.equal(broken.errors.length, 1);
    assert.equal(broken.runtimeRemoved, false);
    assert.ok(fs.existsSync(binDir));
  } finally {
    if (prevCopilotHome !== undefined) process.env.COPILOT_HOME = prevCopilotHome;
  }
});
