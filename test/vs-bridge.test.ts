import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ReviewStore } from '../src/shared/store';

const BRIDGE = path.resolve(__dirname, '..', 'dist', 'vs-bridge.js');

function fixture(t: TestContext) {
  // Temporary fixtures stay under the project, never in the real HOME or system temp.
  const base = fs.realpathSync(fs.mkdtempSync(path.resolve('.vr-vs-bridge-')));
  const home = path.join(base, 'home');
  const root = path.join(base, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: path.join(home, '.copilot'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    // Keep git from finding this project's own repository above the fixture.
    GIT_CEILING_DIRECTORIES: path.dirname(base),
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Bridge Test');
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\nfour\n');
  git('add', 'a.ts');
  git('commit', '-qm', 'fixture');
  fs.writeFileSync(path.join(root, 'a.ts'), 'one\nTWO\nthree\nfour\n');
  fs.writeFileSync(path.join(root, 'new.ts'), 'brand new\n');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  /** Runs one bridge command the way the Visual Studio extension does. */
  const call = (command: string, params: object = {}): { ok: boolean; result?: any; error?: string; code: number | null } => {
    const r = spawnSync(process.execPath, [BRIDGE, command], { input: JSON.stringify(params), env, encoding: 'utf8' });
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `expected one response line, got: ${r.stdout}${r.stderr}`);
    return { ...JSON.parse(lines[0]), code: r.status };
  };
  const ok = (command: string, params: object = {}) => {
    const r = call(command, { root, ...params });
    assert.equal(r.ok, true, `${command} failed: ${r.error}`);
    return r.result;
  };
  return { base, home, root, env, git, call, ok, store: new ReviewStore(root) };
}

test('vs-bridge: protocol errors are JSON with a non-zero exit code', (t) => {
  const { call } = fixture(t);
  assert.equal(call('ping').ok, true);
  const unknown = call('nope');
  assert.deepEqual([unknown.ok, unknown.code], [false, 2]);
  const r = spawnSync(process.execPath, [BRIDGE, 'state'], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).error, /not valid JSON/);
  const noRoot = call('state', { root: '/definitely/not/a/repo' });
  assert.deepEqual([noRoot.ok, noRoot.code], [false, 1]);
});

test('vs-bridge: root resolves the repository from a subfolder, null outside one', (t) => {
  const { base, root, call } = fixture(t);
  fs.mkdirSync(path.join(root, 'sub'));
  assert.equal(call('root', { path: path.join(root, 'sub') }).result, root);
  assert.equal(call('root', { path: base }).result, null);
});

test('vs-bridge: a symlinked subfolder does not reconstruct a root outside the repository', (t) => {
  const { base, root, call } = fixture(t);
  const sub = path.join(root, 'sub');
  const alias = path.join(base, 'alias');
  fs.mkdirSync(sub);
  fs.symlinkSync(sub, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(call('root', { path: alias }).result, root);
});

test('vs-bridge: Windows path casing stores the Git-reported path', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only case-insensitive path behavior');
  const { root, ok, store } = fixture(t);
  const id = ok('create-thread', { file: path.join(root, 'A.TS'), startLine: 1, endLine: 1, body: 'case-insensitive path' });
  assert.equal(store.getThread(id)!.file, 'a.ts');
});

test('vs-bridge: comments only on changed lines (any line of new files), like a PR', (t) => {
  const { root, call, ok, store } = fixture(t);
  const create = (file: string, startLine: number, endLine = startLine) =>
    call('create-thread', { root, file: path.join(root, file), startLine, endLine, body: 'hi' });

  assert.match(create('a.ts', 0).error!, /only comment on changed lines/);
  assert.match(create('a.ts', 2, 3).error!, /only comment on changed lines/);
  assert.match(call('create-thread', { root, file: path.join(root, '..', 'x.ts'), startLine: 0, endLine: 0, body: 'x' }).error!, /files in the repository/);
  assert.match(create('missing.ts', 0).error!, /no uncommitted changes/);
  assert.match(call('create-thread', { root, file: path.join(root, 'a.ts'), startLine: 1, endLine: 1, body: '  ' }).error!, /empty/);
  assert.equal(store.exists(), false, 'a rejected comment must not create the store');

  assert.deepEqual(ok('ranges', { file: path.join(root, 'a.ts') }), [[1, 1]]);
  assert.equal(ok('ranges', { file: path.join(root, 'new.ts') }), 'all');

  const id = create('a.ts', 0, 1).result;
  assert.ok(store.getThread(id));
  assert.equal(store.getThread(id)!.anchor, 'one\nTWO', 'anchor is read from the file when not given');
  assert.ok(create('new.ts', 0).ok);
  // The store is created on first use and hidden from git.
  assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.vibe-review\/$/m);
  assert.equal(store.draftCommentCount(), 2);
});

test('vs-bridge: state reports files, threads and counts, and re-anchors moved threads', (t) => {
  const { root, ok, store } = fixture(t);
  const id = ok('create-thread', { file: path.join(root, 'a.ts'), startLine: 1, endLine: 1, anchor: 'TWO', body: 'Why uppercase?' });
  fs.writeFileSync(path.join(root, 'a.ts'), 'zero\none\nTWO\nthree\nfour\n');

  const s = ok('state');
  assert.equal(s.root, root);
  assert.equal(s.storeExists, true);
  assert.equal(s.draftCount, 1);
  assert.equal(s.undelivered, false);
  assert.deepEqual(s.config, { mode: 'off', waitTimeoutSec: 1800 });
  assert.deepEqual(s.agent, { waiting: false, name: 'Agent' });
  assert.deepEqual(s.files.map((f: any) => [f.path, f.kind]).sort(), [['a.ts', 'modified'], ['new.ts', 'untracked']]);
  assert.equal(s.threads.length, 1);
  const thread = s.threads[0];
  assert.equal(thread.id, id);
  assert.deepEqual([thread.startLine, thread.endLine], [2, 2]);
  assert.deepEqual([thread.state, thread.hasDraft, thread.label], ['pending', true, '● Pending: not submitted yet']);
  assert.equal(thread.comments[0].body, 'Why uppercase?');
  assert.equal(store.getThread(id)!.startLine, 2, 'the new location is saved, as in VS Code');
});

test('vs-bridge: submit, approve and discard drive the same store transitions as VS Code', (t) => {
  const { root, call, ok, store } = fixture(t);
  assert.match(call('submit', { root, summary: '  ' }).error!, /Nothing to submit/);

  const id = ok('create-thread', { file: path.join(root, 'a.ts'), startLine: 1, endLine: 1, body: 'rename' });
  const submitted = ok('submit', { summary: ' Looks close ' });
  assert.equal(submitted.agentWaiting, false);
  assert.match(submitted.text, /# Local code review/);
  assert.match(submitted.text, /## Overall comment\nLooks close/);
  assert.match(submitted.text, new RegExp(`Thread \`${id}\``));
  assert.equal(store.getUndeliveredReview()?.id, submitted.reviewId);
  assert.equal(store.getThread(id)!.comments[0].draft, false);

  // A summary alone is a valid review.
  assert.ok(ok('submit', { summary: 'just this' }).reviewId);

  ok('create-thread', { file: path.join(root, 'new.ts'), startLine: 0, endLine: 0, body: 'drop me' });
  ok('reply', { threadId: id, body: 'and this' });
  assert.equal(store.draftCommentCount(), 2);
  ok('discard');
  assert.equal(store.draftCommentCount(), 0);
  assert.equal(store.listThreads().length, 1);
  assert.equal(store.getSignal()?.action, 'discard');

  ok('approve');
  assert.equal(store.getSignal()?.action, 'approve');
});

test('vs-bridge: thread and comment actions', (t) => {
  const { root, ok, store } = fixture(t);
  const id = ok('create-thread', { file: path.join(root, 'a.ts'), startLine: 1, endLine: 1, body: 'first' });
  const commentId = store.getThread(id)!.comments[0].id;
  ok('edit-comment', { threadId: id, commentId, body: 'edited' });
  assert.equal(store.getThread(id)!.comments[0].body, 'edited');

  ok('submit');
  store.addComment(id, 'agent', 'Fixed.');
  assert.equal(ok('state').threads[0].state, 'active');
  ok('set-status', { threadId: id, status: 'resolved' });
  assert.equal(ok('state').threads[0].state, 'resolved');
  ok('set-status', { threadId: id, status: 'open' });
  assert.equal(store.getThread(id)!.status, 'open');

  ok('reply', { threadId: id, body: 'one more thing' });
  const draft = store.getThread(id)!.comments.at(-1)!;
  assert.equal(draft.draft, true);
  ok('delete-comment', { threadId: id, commentId: draft.id });
  assert.equal(store.getThread(id)!.comments.length, 2);

  ok('delete-thread', { threadId: id });
  assert.equal(store.listThreads().length, 0);
});

test('vs-bridge: heartbeat marks Visual Studio open so agents wait; editor-closed releases them', (t) => {
  const { ok, store } = fixture(t);
  ok('heartbeat', { pid: process.pid });
  assert.equal(store.exists(), false, 'a heartbeat never creates the store');
  ok('set-mode', { mode: 'on', waitTimeoutMinutes: 5 });
  assert.deepEqual(store.getConfig(), { mode: 'on', waitTimeoutSec: 300 });
  ok('heartbeat', { pid: process.pid });
  assert.equal(store.isEditorOpen(), true);
  ok('editor-closed', { pid: process.pid });
  assert.equal(store.isEditorOpen(), false);
  ok('state', { pid: process.pid });
  assert.equal(store.isEditorOpen(), true, 'state with a pid doubles as the heartbeat');
  ok('editor-closed', { pid: process.pid });

  ok('set-timeout', { waitTimeoutMinutes: 2 });
  assert.equal(store.getConfig().waitTimeoutSec, 120);
  ok('set-mode', { mode: 'off' });
  assert.deepEqual(store.getConfig(), { mode: 'off', waitTimeoutSec: 120 });
});

test('vs-bridge: pasted screenshots and image files become attachments; rich text becomes Markdown', (t) => {
  const { base, root, call, ok } = fixture(t);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const md = ok('attach', { mime: 'image/png', data: png.toString('base64') });
  const m = /^!\[screenshot\]\((\.vibe-review\/attachments\/img_[\w-]+\.png)\)$/.exec(md);
  assert.ok(m, md);
  assert.deepEqual(fs.readFileSync(path.join(root, m[1])), png);

  const file = path.join(base, 'shot [1].jpg');
  fs.writeFileSync(file, 'jpeg');
  assert.match(ok('attach', { path: file }), /^!\[shot 1\]\(\.vibe-review\/attachments\/img_[\w-]+\.jpg\)$/);
  assert.match(call('attach', { root, path: path.join(root, 'a.ts') }).error!, /Only PNG/);
  assert.match(call('attach', { root, mime: 'text/plain', data: '' }).error!, /Only PNG/);

  ok('create-thread', { file: path.join(root, 'new.ts'), startLine: 0, endLine: 0, body: `See ${md}` });
  const [attachment] = ok('state').threads[0].comments[0].attachments;
  assert.equal(attachment.path, path.join(root, m[1]));

  assert.equal(ok('html-to-markdown', { html: '<p>Use <b>bold</b> and <code>x()</code></p><ul><li>a</li></ul>' }), 'Use **bold** and `x()`\n\n-   a');
});

test('vs-bridge: head returns the committed file for the diff view', (t) => {
  const { root, ok } = fixture(t);
  assert.equal(ok('head', { file: path.join(root, 'a.ts') }), 'one\ntwo\nthree\nfour\n');
  assert.equal(ok('head', { file: path.join(root, 'new.ts') }), '');
});

test('vs-bridge: setup, agents and uninstall manage the same agent config as VS Code', (t) => {
  const { home, root, call, ok, store } = fixture(t);
  assert.match(call('setup', { agents: [] }).error!, /at least one agent/);
  assert.match(call('setup', { agents: ['nope'] }).error!, /at least one agent/);
  assert.equal(call('sync-runtime').result, false, 'nothing to sync before setup');

  const res = ok('setup', { agents: ['claude', 'copilot'], install: true });
  assert.deepEqual(res.agents, ['Claude Code', 'GitHub Copilot CLI']);
  const bin = path.join(home, '.vibe-review', 'bin');
  assert.ok(fs.existsSync(path.join(bin, 'hook.js')) && fs.existsSync(path.join(bin, 'mcp.js')));
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /hook\.js"? stop claude --timeout 3600$/);
  assert.equal(call('sync-runtime').result, true);

  const agents = ok('agents');
  assert.deepEqual(agents.map((a: any) => [a.id, a.installed]), [['claude', true], ['codex', false], ['copilot', true]]);
  assert.ok(agents[0].files.includes(path.join(home, '.claude', 'settings.json')));

  ok('set-mode', { mode: 'on' });
  assert.equal(ok('state').runtimeInstalled, true);
  const removed = ok('uninstall', { everything: true });
  assert.deepEqual(removed.removedFrom, ['Claude Code', 'GitHub Copilot CLI']);
  assert.deepEqual(removed.errors, []);
  assert.equal(removed.repoDataRemoved, true);
  assert.equal(store.exists(), false);
  assert.equal(fs.existsSync(bin), false);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /vibe-review/);
  assert.equal(ok('agents').some((a: any) => a.installed), false);
});
