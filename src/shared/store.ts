import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AgentState,
  DEFAULT_CONFIG,
  Review,
  ReviewComment,
  ReviewConfig,
  ReviewThread,
  Signal,
  SignalAction,
} from './types';

export const STORE_DIR = '.vibe-review';
/** The extension refreshes its heartbeat every 10s; a heartbeat older than this means the window is gone. */
export const EDITOR_HEARTBEAT_MS = 10_000;
const EDITOR_STALE_MS = 60_000;

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function now(): string {
  return new Date().toISOString();
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** IDs become file names, so only allow characters that can't form a path. */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new Error(`Invalid id: ${JSON.stringify(id)}`);
}

/** A repo-relative path that cannot point outside the repository. */
export function isSafeRelPath(file: unknown): file is string {
  if (typeof file !== 'string' || !file || file.includes('\0')) return false;
  if (file.startsWith('/') || file.includes('\\') || /^[A-Za-z]:/.test(file)) return false;
  return !file.split('/').some((seg) => seg === '..' || seg === '');
}

function isComment(c: unknown): c is ReviewComment {
  return (
    isObject(c) &&
    typeof c.id === 'string' &&
    (c.author === 'user' || c.author === 'agent') &&
    typeof c.body === 'string' &&
    typeof c.createdAt === 'string'
  );
}

function asThread(v: unknown): ReviewThread | undefined {
  if (
    !isObject(v) ||
    !isSafeId(v.id) ||
    !isSafeRelPath(v.file) ||
    !Number.isInteger(v.startLine) ||
    !Number.isInteger(v.endLine) ||
    (v.startLine as number) < 0 ||
    (v.endLine as number) < (v.startLine as number) ||
    !Array.isArray(v.comments) ||
    typeof v.createdAt !== 'string'
  ) {
    return undefined;
  }
  return {
    ...(v as unknown as ReviewThread),
    anchor: typeof v.anchor === 'string' ? v.anchor : '',
    status: v.status === 'resolved' ? 'resolved' : 'open',
    comments: v.comments.filter(isComment).map((c) => ({ ...c, draft: c.draft === true })),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : v.createdAt,
  };
}

const REVIEW_STATUSES = new Set(['draft', 'submitted', 'delivered', 'approved', 'discarded']);

function asReview(v: unknown): Review | undefined {
  if (!isObject(v) || !isSafeId(v.id) || !REVIEW_STATUSES.has(v.status as string) || typeof v.createdAt !== 'string') {
    return undefined;
  }
  return v as unknown as Review;
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/** Locks older than this are from a crashed process; every critical section takes milliseconds. */
const STALE_LOCK_MS = 10_000;

/**
 * Cross-process mutex around a read-modify-write of `file`, so the extension, hooks and MCP
 * server never overwrite each other's changes. Uses an exclusive `mkdir`, which is atomic on
 * every platform, and takes over locks left behind by crashed processes.
 */
const held = new Set<string>();

function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  // Re-entrant within a process (e.g. createThread → ensureDraftReview both take the draft lock).
  if (held.has(lock)) return fn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 30_000;
  for (let delay = 1; ; delay = Math.min(delay * 2, 25)) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock on ${path.basename(file)}`);
      sleepSync(delay + Math.random() * delay);
    }
  }
  held.add(lock);
  try {
    return fn();
  } finally {
    held.delete(lock);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * File-based store shared by the VS Code extension, the agent hooks and the MCP server.
 * Every record is its own JSON file written atomically, so independent processes can
 * read and write without a daemon.
 */
export class ReviewStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, STORE_DIR);
  }

  exists(): boolean {
    return fs.existsSync(this.dir);
  }

  private p(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  // ---- config / agent / signal ------------------------------------------------

  getConfig(): ReviewConfig {
    const raw = readJson(this.p('config.json'));
    const c = isObject(raw) ? raw : {};
    return {
      mode: c.mode === 'on' || c.mode === 'off' ? c.mode : DEFAULT_CONFIG.mode,
      waitTimeoutSec:
        typeof c.waitTimeoutSec === 'number' && Number.isFinite(c.waitTimeoutSec) && c.waitTimeoutSec > 0
          ? c.waitTimeoutSec
          : DEFAULT_CONFIG.waitTimeoutSec,
    };
  }

  setConfig(patch: Partial<ReviewConfig>): ReviewConfig {
    const file = this.p('config.json');
    return withLock(file, () => {
      const next = { ...this.getConfig(), ...patch };
      writeJsonAtomic(file, next);
      return next;
    });
  }

  getAgentState(): AgentState {
    const raw = readJson(this.p('agent.json'));
    if (!isObject(raw) || raw.waiting !== true) return { waiting: false };
    // A hook killed by Esc/Ctrl+C never clears its state; treat dead PIDs as not waiting.
    const pid = typeof raw.pid === 'number' ? raw.pid : undefined;
    if (!isAlive(pid)) return { waiting: false };
    const expires = typeof raw.expires === 'string' ? raw.expires : undefined;
    if (expires !== undefined && !(Date.parse(expires) > Date.now())) return { waiting: false };
    return {
      waiting: true,
      pid,
      agent: typeof raw.agent === 'string' ? raw.agent : undefined,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
      since: typeof raw.since === 'string' ? raw.since : undefined,
      expires,
    };
  }

  setAgentState(state: AgentState): void {
    writeJsonAtomic(this.p('agent.json'), state);
  }

  // ---- open editors (heartbeat) --------------------------------------------------

  /** Live VS Code windows on this repo, keyed by extension-host PID, with their last heartbeat. */
  private readEditors(): Record<string, string> {
    const raw = readJson(this.p('editor.json'));
    const editors = isObject(raw) && isObject(raw.editors) ? raw.editors : {};
    const out: Record<string, string> = {};
    for (const [pid, at] of Object.entries(editors)) {
      if (/^\d+$/.test(pid) && typeof at === 'string') out[pid] = at;
    }
    return out;
  }

  private writeEditors(update: (editors: Record<string, string>) => void): void {
    const file = this.p('editor.json');
    withLock(file, () => {
      const editors = this.readEditors();
      update(editors);
      // Prune windows that crashed without saying goodbye.
      for (const pid of Object.keys(editors)) if (!isAlive(Number(pid))) delete editors[pid];
      writeJsonAtomic(file, { editors });
    });
  }

  /** Called periodically by the extension so agents only wait while someone can submit a review. */
  markEditorOpen(pid = process.pid): void {
    this.writeEditors((e) => {
      e[String(pid)] = now();
    });
  }

  markEditorClosed(pid = process.pid): void {
    if (!fs.existsSync(this.p('editor.json'))) return;
    this.writeEditors((e) => {
      delete e[String(pid)];
    });
  }

  /** True if a VS Code window with Vibe Review is open on this repo (live PID, recent heartbeat). */
  isEditorOpen(): boolean {
    return Object.entries(this.readEditors()).some(
      ([pid, at]) => isAlive(Number(pid)) && Date.now() - Date.parse(at) < EDITOR_STALE_MS,
    );
  }

  sendSignal(action: SignalAction): Signal {
    const signal = { action, at: now() };
    writeJsonAtomic(this.p('signal.json'), signal);
    return signal;
  }

  getSignal(): Signal | undefined {
    const raw = readJson(this.p('signal.json'));
    if (!isObject(raw) || (raw.action !== 'approve' && raw.action !== 'discard') || typeof raw.at !== 'string') return undefined;
    return { action: raw.action, at: raw.at };
  }

  // ---- stop-hook continuations ---------------------------------------------------

  private continuationsFile(): string {
    return this.p('continuations.json');
  }

  /** Consecutive stop-hook blocks in this agent session since the user last sent a prompt. */
  getContinuations(sessionId = '_'): number {
    const raw = readJson(this.continuationsFile());
    const n = isObject(raw) ? raw[sessionId] : undefined;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  }

  bumpContinuations(sessionId = '_'): void {
    this.updateContinuations((m) => {
      m[sessionId] = this.getContinuations(sessionId) + 1;
    });
  }

  resetContinuations(sessionId = '_'): void {
    if (this.getContinuations(sessionId) === 0) return;
    this.updateContinuations((m) => {
      delete m[sessionId];
    });
  }

  private updateContinuations(fn: (m: Record<string, unknown>) => void): void {
    const file = this.continuationsFile();
    withLock(file, () => {
      const raw = readJson(file);
      const m: Record<string, unknown> = isObject(raw) ? raw : {};
      fn(m);
      writeJsonAtomic(file, m);
    });
  }

  // ---- reviews -----------------------------------------------------------------

  listReviews(): Review[] {
    const dir = this.p('reviews');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const r = asReview(readJson(path.join(dir, f)));
        return r && `${r.id}.json` === f ? r : undefined;
      })
      .filter((r): r is Review => !!r)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  getReview(id: string): Review | undefined {
    if (!isSafeId(id)) return undefined;
    const review = asReview(readJson(this.p('reviews', `${id}.json`)));
    return review?.id === id ? review : undefined;
  }

  saveReview(review: Review): void {
    assertSafeId(review.id);
    writeJsonAtomic(this.p('reviews', `${review.id}.json`), review);
  }

  private reviewFile(id: string): string {
    assertSafeId(id);
    return this.p('reviews', `${id}.json`);
  }

  getDraftReview(): Review | undefined {
    return this.listReviews().find((r) => r.status === 'draft');
  }

  ensureDraftReview(): Review {
    const existing = this.getDraftReview();
    if (existing) return existing;
    // Serialized so two processes adding their first comment at once don't create two drafts.
    return withLock(this.p('draft'), () => {
      const again = this.getDraftReview();
      if (again) return again;
      const review: Review = { id: newId('rev'), status: 'draft', createdAt: now() };
      this.saveReview(review);
      return review;
    });
  }

  /** Oldest submitted review that no agent has received yet. */
  getUndeliveredReview(): Review | undefined {
    return this.listReviews().find((r) => r.status === 'submitted');
  }

  /** Most recent review that was sent to the agent (submitted or delivered). */
  getLatestSentReview(): Review | undefined {
    return this.listReviews()
      .filter((r) => r.status === 'submitted' || r.status === 'delivered')
      .pop();
  }

  /**
   * Atomically claims a submitted review for delivery so that two agents (or a stop hook and
   * a prompt hook) never both receive it. Returns the review if this caller won the claim.
   */
  claimForDelivery(reviewId: string, deliveredTo: string): Review | undefined {
    if (!isSafeId(reviewId)) return undefined;
    // The status check and update happen under one lock, so exactly one caller wins, and a
    // crash part-way leaves the review either untouched (still deliverable) or delivered.
    return withLock(this.reviewFile(reviewId), () => {
      const review = this.getReview(reviewId);
      if (!review || review.status !== 'submitted') return undefined;
      review.status = 'delivered';
      review.deliveredAt = now();
      review.deliveredTo = deliveredTo;
      this.saveReview(review);
      return review;
    });
  }

  /** Applies `fn` to a review under its lock. Returns undefined if it doesn't exist. */
  private mutateReview(id: string, fn: (r: Review) => boolean | void): Review | undefined {
    return withLock(this.reviewFile(id), () => {
      const review = this.getReview(id);
      if (!review) return undefined;
      if (fn(review) !== false) this.saveReview(review);
      return review;
    });
  }

  submitDraft(summary?: string): Review | undefined {
    const draft = this.getDraftReview();
    if (!draft) return undefined;
    // Hold the draft lock so no new draft comment can join this review mid-submit.
    return withLock(this.p('draft'), () => {
      let count = 0;
      for (const { id } of this.listThreads()) {
        this.mutateThread(id, (t) => {
          let changed = false;
          for (const c of t.comments) {
            if (c.draft && c.reviewId === draft.id) {
              c.draft = false;
              changed = true;
              count++;
            }
          }
          if (!changed) return false;
          // A new user comment on a resolved thread re-opens it.
          t.status = 'open';
          t.updatedAt = now();
        });
      }
      if (count === 0 && !summary?.trim()) return undefined;
      return this.mutateReview(draft.id, (r) => {
        if (r.status !== 'draft') return false;
        r.status = 'submitted';
        r.summary = summary?.trim() || undefined;
        r.submittedAt = now();
      });
    });
  }

  /** Removes all draft comments and closes the draft review. */
  discardDraft(): void {
    const draft = this.getDraftReview();
    if (!draft) return;
    withLock(this.p('draft'), () => {
      for (const { id } of this.listThreads()) {
        this.mutateThread(id, (t) => {
          const kept = t.comments.filter((c) => !(c.draft && c.reviewId === draft.id));
          if (kept.length === t.comments.length) return false;
          t.comments = kept;
          t.updatedAt = now();
        });
      }
      this.mutateReview(draft.id, (r) => {
        if (r.status !== 'draft') return false;
        r.status = 'discarded';
      });
    });
  }

  /** Closes the draft review as approved. Any draft comments are kept but never sent. */
  approveDraft(): void {
    const draft = this.getDraftReview();
    if (!draft || this.draftCommentCount() > 0) return;
    this.mutateReview(draft.id, (r) => {
      if (r.status !== 'draft') return false;
      r.status = 'approved';
    });
  }

  // ---- threads -----------------------------------------------------------------

  listThreads(): ReviewThread[] {
    const dir = this.p('threads');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const t = asThread(readJson(path.join(dir, f)));
        // A file whose name doesn't match its id would be updated under the wrong name.
        return t && `${t.id}.json` === f ? t : undefined;
      })
      .filter((t): t is ReviewThread => !!t)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  getThread(id: string): ReviewThread | undefined {
    if (!isSafeId(id)) return undefined;
    const thread = asThread(readJson(this.p('threads', `${id}.json`)));
    return thread?.id === id ? thread : undefined;
  }

  private threadFile(id: string): string {
    assertSafeId(id);
    return this.p('threads', `${id}.json`);
  }

  saveThread(thread: ReviewThread): void {
    if (!isSafeRelPath(thread.file)) throw new Error(`Invalid thread file: ${JSON.stringify(thread.file)}`);
    writeJsonAtomic(this.threadFile(thread.id), thread);
  }

  deleteThread(id: string): void {
    const file = this.threadFile(id);
    withLock(file, () => fs.rmSync(file, { force: true }));
  }

  /**
   * Applies `fn` to a thread under its lock (return false to skip the write). A thread left with
   * no comments is deleted. Returns the updated thread, or undefined if it doesn't exist.
   */
  private mutateThread(id: string, fn: (t: ReviewThread) => boolean | void): ReviewThread | undefined {
    const file = this.threadFile(id);
    return withLock(file, () => {
      const thread = this.getThread(id);
      if (!thread) return undefined;
      if (fn(thread) === false) return thread;
      if (thread.comments.length === 0) fs.rmSync(file, { force: true });
      else this.saveThread(thread);
      return thread;
    });
  }

  createThread(file: string, startLine: number, endLine: number, anchor: string, body: string): ReviewThread {
    if (!isSafeRelPath(file)) throw new Error(`Invalid thread file: ${JSON.stringify(file)}`);
    return withLock(this.p('draft'), () => {
      const review = this.ensureDraftReview();
      const ts = now();
      const thread: ReviewThread = {
        id: newId('thr'),
        file,
        startLine,
        endLine,
        anchor,
        status: 'open',
        comments: [{ id: newId('cmt'), author: 'user', body, createdAt: ts, draft: true, reviewId: review.id }],
        createdAt: ts,
        updatedAt: ts,
      };
      this.saveThread(thread);
      return thread;
    });
  }

  addComment(threadId: string, author: 'user' | 'agent', body: string): ReviewThread {
    const add = (reviewId?: string) =>
      this.mutateThread(threadId, (thread) => {
        const comment: ReviewComment = { id: newId('cmt'), author, body, createdAt: now(), draft: false };
        if (reviewId) {
          // The reply stays a draft. `threadState` shows the thread as pending while it exists,
          // and submitting re-opens a resolved thread (discarding leaves it resolved).
          comment.draft = true;
          comment.reviewId = reviewId;
        }
        thread.comments.push(comment);
        thread.updatedAt = now();
      });
    if (!this.getThread(threadId)) throw new Error(`Thread ${threadId} not found`);
    const thread =
      author === 'user' ? withLock(this.p('draft'), () => add(this.ensureDraftReview().id)) : add();
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    return thread;
  }

  editComment(threadId: string, commentId: string, body: string): void {
    if (!isSafeId(threadId)) return;
    this.mutateThread(threadId, (thread) => {
      const comment = thread.comments.find((c) => c.id === commentId);
      if (!comment) return false;
      comment.body = body;
      thread.updatedAt = now();
    });
  }

  deleteComment(threadId: string, commentId: string): void {
    if (!isSafeId(threadId)) return;
    this.mutateThread(threadId, (thread) => {
      const before = thread.comments.length;
      thread.comments = thread.comments.filter((c) => c.id !== commentId);
      if (thread.comments.length === before) return false;
      thread.updatedAt = now();
    });
  }

  setThreadStatus(threadId: string, status: 'open' | 'resolved'): ReviewThread {
    const thread = isSafeId(threadId)
      ? this.mutateThread(threadId, (t) => {
          if (t.status === status) return false;
          t.status = status;
          t.updatedAt = now();
        })
      : undefined;
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    return thread;
  }

  updateThreadLocation(threadId: string, startLine: number, endLine: number): void {
    if (!isSafeId(threadId)) return;
    this.mutateThread(threadId, (thread) => {
      if (thread.startLine === startLine && thread.endLine === endLine) return false;
      thread.startLine = startLine;
      thread.endLine = endLine;
    });
  }

  /** Threads containing comments that were part of the given review. */
  threadsForReview(reviewId: string): ReviewThread[] {
    return this.listThreads().filter((t) => t.comments.some((c) => c.reviewId === reviewId));
  }

  draftCommentCount(): number {
    const draft = this.getDraftReview();
    if (!draft) return 0;
    return this.listThreads().reduce(
      (n, t) => n + t.comments.filter((c) => c.draft && c.reviewId === draft.id).length,
      0,
    );
  }
}
