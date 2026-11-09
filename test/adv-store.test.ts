import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ReviewStore } from '../src/shared/store';
import { threadState, ReviewThread } from '../src/shared/types';

const STORE_TS = path.resolve(__dirname, '..', 'src', 'shared', 'store.ts');

function tmpRoot(name = 'lr-adv-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
}

function withRoot(fn: (root: string, store: ReviewStore) => void | Promise<void>, name?: string) {
  return async () => {
    const root = tmpRoot(name);
    try {
      fs.mkdirSync(path.join(root, '.vibe-review'));
      await fn(root, new ReviewStore(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** Runs `body` in a real child process with `store` (ReviewStore for argv[1]) and `arg` (argv[2..]) in scope. */
function worker(root: string, body: string, ...args: string[]): Promise<{ out: string; err: string; code: number | null }> {
  const code = `const {ReviewStore}=require(${JSON.stringify(STORE_TS)});const store=new ReviewStore(process.argv[1]);const args=process.argv.slice(2);${body}`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', 'tsx', '-e', code, root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ out, err, code }));
  });
}

function writeRaw(store: ReviewStore, rel: string, content: string) {
  const f = path.join(store.dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

// ---------------------------------------------------------------- lifecycle

test('lifecycle: draft -> submit -> claim -> agent reply -> resolve -> user reply reopens', withRoot((_r, s) => {
  const t = s.createThread('a.ts', 1, 1, 'x', 'fix this');
  assert.equal(threadState(s.getThread(t.id)!), 'pending');
  assert.equal(s.draftCommentCount(), 1);
  assert.equal(s.getUndeliveredReview(), undefined, 'drafts must not be visible as submitted');

  const rev = s.submitDraft('summary')!;
  assert.equal(rev.status, 'submitted');
  assert.equal(s.draftCommentCount(), 0);
  assert.equal(s.getThread(t.id)!.comments[0].draft, false);
  assert.equal(threadState(s.getThread(t.id)!), 'pending');
  assert.equal(s.getUndeliveredReview()!.id, rev.id);

  const claimed = s.claimForDelivery(rev.id, 'agentA')!;
  assert.equal(claimed.status, 'delivered');
  assert.equal(claimed.deliveredTo, 'agentA');
  assert.equal(s.getUndeliveredReview(), undefined);
  assert.equal(s.getLatestSentReview()!.id, rev.id);
  assert.equal(s.claimForDelivery(rev.id, 'agentB'), undefined);
  assert.equal(s.getReview(rev.id)!.deliveredTo, 'agentA');

  s.addComment(t.id, 'agent', 'done');
  assert.equal(threadState(s.getThread(t.id)!), 'active');
  assert.equal(s.getThread(t.id)!.comments[1].draft, false);
  assert.equal(s.draftCommentCount(), 0, 'agent comments never create drafts');

  s.setThreadStatus(t.id, 'resolved');
  assert.equal(threadState(s.getThread(t.id)!), 'resolved');

  s.addComment(t.id, 'agent', 'late agent note');
  assert.equal(threadState(s.getThread(t.id)!), 'resolved', 'agent reply must not reopen a resolved thread');

  s.addComment(t.id, 'user', 'not fixed');
  const th = s.getThread(t.id)!;
  // A draft reply shows as pending immediately, but the stored status only flips on submit so
  // discarding the draft restores Resolved.
  assert.equal(th.status, 'resolved');
  assert.equal(threadState(th), 'pending');
  assert.equal(th.comments.at(-1)!.draft, true);
  assert.equal(s.draftCommentCount(), 1);
  s.discardDraft();
  assert.equal(threadState(s.getThread(t.id)!), 'resolved');
  s.addComment(t.id, 'user', 'not fixed');
  s.submitDraft();
  assert.equal(s.getThread(t.id)!.status, 'open');
}));

test('submitDraft reopens resolved thread only when it has a draft in this review', withRoot((_r, s) => {
  const a = s.createThread('a.ts', 0, 0, '', 'a');
  const b = s.createThread('b.ts', 0, 0, '', 'b');
  s.submitDraft();
  s.claimForDelivery(s.getLatestSentReview()!.id, 'x');
  s.setThreadStatus(a.id, 'resolved');
  s.setThreadStatus(b.id, 'resolved');
  s.addComment(a.id, 'user', 'again');
  s.submitDraft();
  assert.equal(s.getThread(a.id)!.status, 'open');
  assert.equal(s.getThread(b.id)!.status, 'resolved', 'untouched resolved thread must stay resolved');
}));

test('threadState: empty comments is pending, resolved wins over agent last', () => {
  const base = { id: 't', file: 'f', startLine: 0, endLine: 0, anchor: '', createdAt: '', updatedAt: '' };
  assert.equal(threadState({ ...base, status: 'open', comments: [] }), 'pending');
  const agent = { id: 'c', author: 'agent' as const, body: '', createdAt: '', draft: false };
  assert.equal(threadState({ ...base, status: 'resolved', comments: [agent] }), 'resolved');
  assert.equal(threadState({ ...base, status: 'open', comments: [agent] }), 'active');
});

test('draft edit and delete', withRoot((_r, s) => {
  const t = s.createThread('a.ts', 0, 0, '', 'one');
  s.addComment(t.id, 'user', 'two');
  const [c1, c2] = s.getThread(t.id)!.comments;
  s.editComment(t.id, c1.id, 'ONE');
  assert.equal(s.getThread(t.id)!.comments[0].body, 'ONE');
  assert.equal(s.getThread(t.id)!.comments[0].draft, true);
  s.deleteComment(t.id, c2.id);
  assert.deepEqual(s.getThread(t.id)!.comments.map((c) => c.id), [c1.id]);
  assert.equal(s.draftCommentCount(), 1);
  s.editComment(t.id, 'nope', 'x');
  s.editComment('thr_missing', c1.id, 'x');
  s.deleteComment('thr_missing', c1.id);
  assert.equal(s.getThread(t.id)!.comments[0].body, 'ONE');
}));

test('deleting the last comment deletes the thread and draft count drops to zero', withRoot((_r, s) => {
  const t = s.createThread('a.ts', 0, 0, '', 'only');
  s.deleteComment(t.id, t.comments[0].id);
  assert.equal(s.getThread(t.id), undefined);
  assert.deepEqual(s.listThreads(), []);
  assert.equal(s.draftCommentCount(), 0);
}));

test('submit with zero drafts: no summary -> undefined and draft stays; summary only -> submitted', withRoot((_r, s) => {
  assert.equal(s.submitDraft(), undefined);
  const d = s.ensureDraftReview();
  assert.equal(s.submitDraft(), undefined);
  assert.equal(s.getReview(d.id)!.status, 'draft');
  assert.equal(s.submitDraft(''), undefined, 'empty summary is not a summary');
  const r = s.submitDraft('LGTM overall')!;
  assert.equal(r.id, d.id);
  assert.equal(r.status, 'submitted');
  assert.equal(s.getReview(d.id)!.summary, 'LGTM overall');
  assert.equal(s.getDraftReview(), undefined);
}));

test('submit does not touch another review\'s drafts or agent-side state', withRoot((_r, s) => {
  const t = s.createThread('a.ts', 0, 0, '', 'x');
  const r1 = s.submitDraft()!;
  s.claimForDelivery(r1.id, 'a');
  s.addComment(t.id, 'user', 'second round');
  const r2 = s.getDraftReview()!;
  assert.notEqual(r1.id, r2.id);
  const c = s.getThread(t.id)!.comments;
  assert.equal(c[0].reviewId, r1.id);
  assert.equal(c[0].draft, false);
  assert.equal(c[1].reviewId, r2.id);
  s.submitDraft();
  assert.equal(s.getThread(t.id)!.comments[0].reviewId, r1.id, 'earlier comments keep their review id');
  assert.deepEqual(s.threadsForReview(r1.id).map((x) => x.id), [t.id]);
}));

test('discardDraft removes only drafts, deletes emptied threads, keeps sent comments', withRoot((_r, s) => {
  const keep = s.createThread('a.ts', 0, 0, '', 'sent');
  const sent = s.submitDraft()!;
  s.claimForDelivery(sent.id, 'a');
  s.addComment(keep.id, 'user', 'draft reply');
  const only = s.createThread('b.ts', 0, 0, '', 'draft only');
  const draftId = s.getDraftReview()!.id;
  s.discardDraft();
  assert.equal(s.getThread(only.id), undefined);
  assert.deepEqual(s.getThread(keep.id)!.comments.map((c) => c.body), ['sent']);
  assert.equal(s.getReview(draftId)!.status, 'discarded');
  assert.equal(s.getDraftReview(), undefined);
  assert.equal(s.getReview(sent.id)!.status, 'delivered');
  assert.equal(s.draftCommentCount(), 0);
  s.discardDraft();
}));

test('approveDraft only closes a draft with no draft comments; with drafts it stays a draft', withRoot((_r, s) => {
  s.ensureDraftReview();
  s.approveDraft();
  assert.equal(s.listReviews()[0].status, 'approved');
  assert.equal(s.getUndeliveredReview(), undefined, 'approved review is never delivered');
  s.createThread('a.ts', 0, 0, '', 'x');
  s.approveDraft();
  assert.equal(s.getDraftReview()!.status, 'draft');
  assert.equal(s.draftCommentCount(), 1);
}));

test('getUndeliveredReview returns oldest; getLatestSentReview returns newest', withRoot((_r, s) => {
  const t = s.createThread('a.ts', 0, 0, '', 'x');
  const r1 = s.submitDraft()!;
  s.saveReview({ ...r1, createdAt: '2020-01-01T00:00:00.000Z' });
  s.addComment(t.id, 'user', 'y');
  const r2 = s.submitDraft()!;
  s.saveReview({ ...r2, createdAt: '2021-01-01T00:00:00.000Z' });
  assert.equal(s.getUndeliveredReview()!.id, r1.id);
  assert.equal(s.getLatestSentReview()!.id, r2.id);
  s.claimForDelivery(r1.id, 'a');
  assert.equal(s.getUndeliveredReview()!.id, r2.id);
}));

test('[BUG] claimForDelivery refuses non-submitted reviews', withRoot((_r, s) => {
  const d = s.ensureDraftReview();
  assert.equal(s.claimForDelivery(d.id, 'a'), undefined);
  assert.equal(s.getReview(d.id)!.status, 'draft', 'a draft must not become delivered');
}));

test('[BUG] claim for a nonexistent review must not leave a permanent claim', withRoot((_r, s) => {
  assert.equal(s.claimForDelivery('rev_ghost', 'a'), undefined);
  const claimFile = path.join(s.dir, 'claims', 'rev_ghost');
  assert.equal(fs.existsSync(claimFile), false);
}));

test('[BUG] claim whose review file is not yet written/corrupt does not poison the review forever', withRoot((_r, s) => {
  const t = s.createThread('a.ts', 0, 0, '', 'x');
  const r = s.submitDraft()!;
  const f = path.join(s.dir, 'reviews', `${r.id}.json`);
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '{trunc');
  assert.equal(s.claimForDelivery(r.id, 'a'), undefined);
  fs.writeFileSync(f, good);
  assert.ok(s.claimForDelivery(r.id, 'b'), 'review is still submitted and undelivered; a later claim must succeed');
  void t;
}));

// ---------------------------------------------------------------- concurrency

test('exactly-once delivery: 12 processes race to claim the same review', async () => {
  const root = tmpRoot();
  try {
    const s = new ReviewStore(root);
    s.createThread('a.ts', 0, 0, '', 'x');
    const rev = s.submitDraft()!;
    const body = `const r=store.claimForDelivery(args[0],args[1]);console.log(r?'WON:'+r.deliveredTo:'LOST');`;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => worker(root, body, rev.id, `p${i}`)));
    for (const r of results) assert.equal(r.code, 0, r.err);
    const winners = results.filter((r) => r.out.startsWith('WON:'));
    assert.equal(winners.length, 1, results.map((r) => r.out.trim()).join(','));
    const after = s.getReview(rev.id)!;
    assert.equal(after.status, 'delivered');
    assert.equal(`WON:${after.deliveredTo}`, winners[0].out.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[BUG] lost update: concurrent processes adding comments to the same thread', async () => {
  const root = tmpRoot();
  try {
    const s = new ReviewStore(root);
    const t = s.createThread('a.ts', 0, 0, '', 'root');
    const N = 8;
    const PER = 15;
    const body = `for(let i=0;i<${PER};i++)store.addComment(args[0],args[1],args[2]+i);`;
    const res = await Promise.all(
      Array.from({ length: N }, (_, i) => worker(root, body, t.id, i % 2 ? 'agent' : 'user', `w${i}-`)),
    );
    for (const r of res) assert.equal(r.code, 0, r.err);
    const bodies = new Set(s.getThread(t.id)!.comments.map((c) => c.body));
    assert.equal(bodies.size, 1 + N * PER, `lost ${1 + N * PER - bodies.size} comments`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[BUG] lost update: extension adds user comment while MCP agent replies and resolves', async () => {
  const root = tmpRoot();
  try {
    const s = new ReviewStore(root);
    const t = s.createThread('a.ts', 0, 0, '', 'root');
    const user = worker(root, `for(let i=0;i<40;i++)store.addComment(args[0],'user','u'+i);`, t.id);
    const agent = worker(root, `for(let i=0;i<40;i++)store.addComment(args[0],'agent','a'+i);`, t.id);
    const loc = worker(root, `for(let i=0;i<40;i++)store.updateThreadLocation(args[0],i,i);`, t.id);
    await Promise.all([user, agent, loc]);
    const bodies = new Set(s.getThread(t.id)!.comments.map((c) => c.body));
    assert.equal(bodies.size, 81, `lost ${81 - bodies.size} comments`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent creates and submit: no draft comment is silently lost or left orphaned', async () => {
  const root = tmpRoot();
  try {
    const s = new ReviewStore(root);
    s.ensureDraftReview();
    // Many processes each create a thread; each calls ensureDraftReview concurrently.
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) => worker(root, `store.createThread('f${i}.ts',0,0,'','c'+args[0]);`, String(i))),
    );
    for (const r of res) assert.equal(r.code, 0, r.err);
    assert.equal(s.listThreads().length, 8);
    assert.equal(s.listReviews().filter((r) => r.status === 'draft').length, 1);
    assert.equal(s.draftCommentCount(), 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent first-use: parallel createThread without existing draft yields a single draft review', async () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, '.vibe-review'));
    const s = new ReviewStore(root);
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) => worker(root, `store.createThread('f${i}.ts',0,0,'','c');`, String(i))),
    );
    for (const r of res) assert.equal(r.code, 0, r.err);
    assert.equal(s.listReviews().filter((r) => r.status === 'draft').length, 1, 'multiple draft reviews were created');
    assert.equal(s.draftCommentCount(), 8, 'draft comments attached to a non-current draft review are stranded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('torn reads: readers never throw or see partial data while a writer rewrites', async () => {
  const root = tmpRoot();
  try {
    const s = new ReviewStore(root);
    const t = s.createThread('a.ts', 0, 0, '', 'x'.repeat(200_000));
    const writer = worker(
      root,
      `for(let i=0;i<150;i++){store.updateThreadLocation(args[0],i+1,i+1);store.setConfig({waitTimeoutSec:i+1});}`,
      t.id,
    );
    const reader = worker(
      root,
      `let bad=0;for(let i=0;i<600;i++){const th=store.getThread(args[0]);if(!th||th.comments[0].body.length!==200000)bad++;
       const l=store.listThreads();if(l.length!==1)bad++;const c=store.getConfig();if(typeof c.waitTimeoutSec!=='number')bad++;}
       console.log('bad='+bad);`,
      t.id,
    );
    const [, r] = await Promise.all([writer, reader]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'bad=0');
    assert.deepEqual(fs.readdirSync(path.join(s.dir, 'threads')).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no tmp files remain and writes leave valid JSON after many writes', withRoot((_r, s) => {
  const t = s.createThread('a.ts', 0, 0, '', 'x');
  for (let i = 0; i < 50; i++) s.updateThreadLocation(t.id, i + 1, i + 1);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'threads')), [`${t.id}.json`]);
}));

// ---------------------------------------------------------------- corruption

const GARBAGE = ['', '{"id":"thr_x","comments":[', 'null', '[]', '"str"', '42', '{}', '\u0000\u0000\u0000', '{"id":'];

test('[BUG] listThreads/listReviews/getConfig/getAgentState/getSignal survive garbage files', withRoot((_r, s) => {
  const good = s.createThread('a.ts', 0, 0, '', 'ok');
  s.submitDraft();
  GARBAGE.forEach((g, i) => {
    writeRaw(s, `threads/bad${i}.json`, g);
    writeRaw(s, `reviews/bad${i}.json`, g);
  });
  writeRaw(s, 'threads/notjson.txt', 'zzz');
  fs.mkdirSync(path.join(s.dir, 'threads', 'dir.json'));
  const threads = s.listThreads();
  assert.ok(threads.some((t) => t.id === good.id));
  for (const t of threads) assert.ok(Array.isArray(t.comments), `thread without comments array leaked: ${JSON.stringify(t)}`);
  const reviews = s.listReviews();
  for (const r of reviews) assert.equal(typeof r.id, 'string', `non-review leaked: ${JSON.stringify(r)}`);
  assert.ok(s.getUndeliveredReview());
  assert.equal(s.draftCommentCount(), 0);
}));

test('[BUG] submit/discard/approve/threadsForReview/draftCommentCount do not crash on thread missing comments', withRoot((_r, s) => {
  s.createThread('a.ts', 0, 0, '', 'ok');
  writeRaw(s, 'threads/weird.json', JSON.stringify({ id: 'weird', createdAt: '2020', status: 'open' }));
  assert.doesNotThrow(() => s.draftCommentCount());
  assert.doesNotThrow(() => s.threadsForReview('x'));
  assert.doesNotThrow(() => s.approveDraft());
  const r = s.submitDraft();
  assert.ok(r, 'good thread still submitted');
  s.addComment(s.listThreads()[0].id, 'user', 'again');
  assert.doesNotThrow(() => s.discardDraft());
}));

test('[BUG] valid-JSON review/thread without createdAt does not crash listing', withRoot((_r, s) => {
  s.createThread('a.ts', 0, 0, '', 'ok');
  writeRaw(s, 'threads/nodate2.json', JSON.stringify({ id: 'nodate2', comments: [], status: 'open' }));
  writeRaw(s, 'reviews/nodate2.json', JSON.stringify({ id: 'nodate2', status: 'submitted' }));
  writeRaw(s, 'threads/nodate.json', JSON.stringify({ id: 'nodate', comments: [], status: 'open' }));
  writeRaw(s, 'reviews/nodate.json', JSON.stringify({ id: 'nodate', status: 'submitted' }));
  assert.doesNotThrow(() => s.listThreads());
  assert.doesNotThrow(() => s.listReviews());
  assert.doesNotThrow(() => s.getUndeliveredReview());
}));

test('a corrupt draft-review file does not make createThread throw or fork drafts', withRoot((_r, s) => {
  writeRaw(s, 'reviews/rev_bad.json', '{"id":"rev_bad"');
  assert.doesNotThrow(() => s.createThread('a.ts', 0, 0, '', 'x'));
  assert.equal(s.draftCommentCount(), 1);
}));

test('[BUG] corrupt config.json falls back to defaults; setConfig repairs it', withRoot((_r, s) => {
  for (const g of ['', '{"mode":', 'null', '[]', '"x"', '7']) {
    writeRaw(s, 'config.json', g);
    const c = s.getConfig();
    assert.equal(c.mode, 'off', `garbage ${JSON.stringify(g)}`);
    assert.equal(c.waitTimeoutSec, 1800);
    assert.deepEqual(Object.keys(c).sort(), ['mode', 'waitTimeoutSec']);
  }
  assert.equal(s.setConfig({ mode: 'on' }).mode, 'on');
  assert.equal(s.getConfig().mode, 'on');
}));

test('[BUG] config with wrong-typed fields falls back to defaults', withRoot((_r, s) => {
  writeRaw(s, 'config.json', JSON.stringify({ mode: 'banana', waitTimeoutSec: 'soon' }));
  const c = s.getConfig();
  assert.equal(c.mode, 'off');
  assert.equal(c.waitTimeoutSec, 1800);
}));

test('[BUG] corrupt agent.json / signal.json do not throw and read as idle/none', withRoot((_r, s) => {
  for (const g of ['', '{"waiting":', 'null', '[]', '"x"', '5']) {
    writeRaw(s, 'agent.json', g);
    writeRaw(s, 'signal.json', g);
    assert.equal(s.getAgentState().waiting, false, g);
    assert.doesNotThrow(() => s.getSignal());
  }
}));

test('agent waiting with dead pid is not waiting; with live pid is', withRoot((_r, s) => {
  s.setAgentState({ waiting: true, pid: process.pid, agent: 'x' });
  assert.equal(s.getAgentState().waiting, true);
  s.setAgentState({ waiting: true, pid: 2 ** 22 + 12345 });
  assert.deepEqual(s.getAgentState(), { waiting: false });
  s.setAgentState({ waiting: true });
  assert.equal(s.getAgentState().waiting, false, 'waiting without pid cannot be verified alive');
}));

test('[BUG] agent.json {"waiting":"yes","pid":"abc"} (wrong types) is not treated as waiting', withRoot((_r, s) => {
  writeRaw(s, 'agent.json', JSON.stringify({ waiting: 'yes', pid: process.pid }));
  assert.notEqual(s.getAgentState().waiting, 'yes' as any);
}));

test('signal roundtrip', withRoot((_r, s) => {
  assert.equal(s.getSignal(), undefined);
  s.sendSignal('approve');
  assert.equal(s.getSignal()!.action, 'approve');
  s.sendSignal('discard');
  assert.equal(s.getSignal()!.action, 'discard');
}));

// ---------------------------------------------------------------- hostile ids

test('hostile thread ids cannot read or write outside .vibe-review', withRoot((root, s) => {
  const secret = path.join(root, 'secret.json');
  fs.writeFileSync(secret, JSON.stringify({ id: 'secret', file: 'x', comments: [{ id: 'c', author: 'user', body: 'S', createdAt: '', draft: false }], status: 'open', createdAt: '', updatedAt: '' }));
  // <dir>/threads/../../secret.json == <root>/secret.json
  assert.equal(s.getThread('../../secret'), undefined, 'read escaped the store');
  assert.throws(() => s.addComment('../../secret', 'agent', 'pwn'));
  assert.equal(JSON.parse(fs.readFileSync(secret, 'utf8')).comments.length, 1, 'write escaped the store');
  try { s.deleteThread('../../secret'); } catch { /* rejecting is fine */ }
  assert.ok(fs.existsSync(secret), 'delete escaped the store');
}));

test('[BUG] hostile ids: saveThread/saveReview/claim cannot create files outside .vibe-review', withRoot((root, s) => {
  const mk = (id: string): ReviewThread => ({ id, file: 'f', startLine: 0, endLine: 0, anchor: '', status: 'open', comments: [], createdAt: '', updatedAt: '' });
  try { s.saveThread(mk('../../evil-thread')); } catch { /* rejecting is fine */ }
  try { s.saveReview({ id: '../../evil-review', status: 'draft', createdAt: '' }); } catch { /* fine */ }
  s.claimForDelivery('../../evil-claim', 'x');
  const abs = path.join(root, 'evil-abs');
  try { s.saveThread(mk(abs)); } catch { /* fine */ }
  s.claimForDelivery(path.join(root, 'evil-claim-abs'), 'x');
  const outside = fs.readdirSync(root).filter((f) => f !== '.vibe-review');
  assert.deepEqual(outside, [], `files created outside store: ${outside.join(', ')}`);
  const inStore = fs.readdirSync(s.dir);
  assert.ok(!inStore.some((f) => f.includes('evil')), `escaped to store root: ${inStore.join(',')}`);
}));

test('[BUG] claim ids with slashes cannot create nested paths or throw', withRoot((_r, s) => {
  assert.doesNotThrow(() => s.claimForDelivery('a/b', 'x'));
  assert.equal(fs.existsSync(path.join(s.dir, 'claims', 'a')), false);
}));

// ---------------------------------------------------------------- content

test('unicode, CRLF, huge bodies and JSON-hostile strings roundtrip exactly', withRoot((_r, s) => {
  const bodies = [
    'héllo 世界 🚀 \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
    'line1\r\nline2\r\n\r\nline4\r',
    'x'.repeat(5 * 1024 * 1024),
    '"quotes" \\ back\\slash \u2028\u2029 \u0000 nul',
    '   leading and trailing   \n\n',
    '',
  ];
  const t = s.createThread('dir with space/ü.ts', 3, 4, 'anc\r\nhor', bodies[0]);
  for (const b of bodies.slice(1)) s.addComment(t.id, 'user', b);
  const got = s.getThread(t.id)!;
  assert.deepEqual(got.comments.map((c) => c.body), bodies);
  assert.equal(got.file, 'dir with space/ü.ts');
  assert.equal(got.anchor, 'anc\r\nhor');
  const c = got.comments[1];
  s.editComment(t.id, c.id, bodies[1] + '!');
  assert.equal(s.getThread(t.id)!.comments[1].body, bodies[1] + '!');
}));

test('store root with spaces and unicode in its path works, including a missing .vibe-review', async () => {
  const base = tmpRoot();
  try {
    const root = path.join(base, 'my repo ü 世界 #1 %20');
    fs.mkdirSync(root);
    const s = new ReviewStore(root);
    assert.equal(s.exists(), false);
    assert.deepEqual(s.listThreads(), []);
    assert.deepEqual(s.listReviews(), []);
    assert.equal(s.getConfig().mode, 'off');
    assert.equal(s.getAgentState().waiting, false);
    assert.equal(s.getSignal(), undefined);
    assert.equal(s.getUndeliveredReview(), undefined);
    assert.equal(s.getLatestSentReview(), undefined);
    assert.equal(s.draftCommentCount(), 0);
    assert.equal(s.submitDraft(), undefined);
    assert.doesNotThrow(() => s.discardDraft());
    assert.doesNotThrow(() => s.approveDraft());
    assert.equal(s.exists(), false, 'readers must not create the store dir');
    const t = s.createThread('a.ts', 0, 0, '', 'hi');
    assert.equal(s.exists(), true);
    const r = await worker(root, `console.log(store.getThread(args[0]).comments[0].body);`, t.id);
    assert.equal(r.out.trim(), 'hi', r.err);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('missing thread: addComment/setThreadStatus throw; updateThreadLocation is a no-op', withRoot((_r, s) => {
  assert.throws(() => s.addComment('thr_nope', 'user', 'x'), /not found/);
  assert.throws(() => s.setThreadStatus('thr_nope', 'resolved'), /not found/);
  assert.doesNotThrow(() => s.updateThreadLocation('thr_nope', 1, 2));
  assert.equal(s.listThreads().length, 0);
  assert.equal(s.getDraftReview(), undefined, 'failed addComment must not create a draft review');
}));
