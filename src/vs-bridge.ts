/**
 * Bridge between the Visual Studio extension (C#) and the shared review logic.
 *
 *   node vs-bridge.js <command>   (request JSON on stdin, one response JSON line on stdout)
 *
 * Visual Studio extensions run on .NET, but the review store, git parsing, review formatting and
 * agent setup must behave exactly as they do for the VS Code extension, the hooks and the MCP
 * server (they share the same files and locks). So Visual Studio calls this script instead of
 * re-implementing them. Every response is `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChangedFile, ensureLocalExclude, findRepoRoot, getChangedFiles, getChangedLineRanges, getHeadContent, removeLocalExclude } from './shared/git';
import { ReviewStore } from './shared/store';
import { stateLabel, threadState } from './shared/types';
import { formatReview, locateThread } from './shared/format';
import { extForMime, findAttachments, imageMarkdown, isImagePath, saveAttachment } from './shared/attachments';
import { htmlToMarkdown } from './shared/html';
import { AGENTS, AgentId, configureAgent, filesFor, installRuntime, isInstalled, resolveNodePath, runtimeDir, uninstallAll } from './shared/setup';

type Params = Record<string, unknown>;

class UserError extends Error {}

const home = () => os.homedir();
const binDir = () => path.join(runtimeDir(home()), 'bin');

function str(p: Params, key: string, optional = false): string {
  const v = p[key];
  if (typeof v === 'string') return v;
  if (optional && v === undefined) return '';
  throw new UserError(`Missing or invalid "${key}".`);
}

function int(p: Params, key: string): number {
  const v = p[key];
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  throw new UserError(`Missing or invalid "${key}".`);
}

/** Process IDs identify editor windows in `editor.json`. */
function pid(p: Params): number {
  const v = p.pid;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  throw new UserError('Missing or invalid "pid".');
}

/** The repository the request is about. Must be an existing absolute directory. */
function storeOf(p: Params): ReviewStore {
  const root = str(p, 'root');
  if (!path.isAbsolute(root) || !fs.existsSync(path.join(root, '.git'))) throw new UserError(`Not a git repository root: ${root}`);
  return new ReviewStore(root);
}

function ensureStore(store: ReviewStore): void {
  if (!store.exists()) {
    fs.mkdirSync(store.dir, { recursive: true });
    ensureLocalExclude(store.root);
  }
}

/** Repo-relative, forward-slash path for an absolute file inside the repository. */
function relPath(root: string, file: string): string {
  const rel = path.relative(root, path.resolve(root, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new UserError('Comments can only be added to files in the repository.');
  return rel.split(path.sep).join('/');
}

/** Lines that may be commented on, as in the VS Code extension: changed lines only, any line of new files. */
function commentableRanges(root: string, rel: string): Array<[number, number]> | 'all' | undefined {
  if (rel.startsWith('.vibe-review/')) return undefined;
  const file = getChangedFiles(root).find((f) => f.path === rel);
  if (!file || file.kind === 'deleted') return undefined;
  return file.kind === 'untracked' || file.kind === 'added' ? 'all' : getChangedLineRanges(root, rel);
}

function readLines(root: string, rel: string): string[] | undefined {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

function agentName(agent: string | undefined): string {
  return (agent && AGENTS[agent as AgentId]) || 'Agent';
}

function agentIds(p: Params): AgentId[] {
  const ids = p.agents;
  if (!Array.isArray(ids) || !ids.length || !ids.every((a) => typeof a === 'string' && a in AGENTS)) {
    throw new UserError('Choose at least one agent.');
  }
  return ids as AgentId[];
}

const commands: Record<string, (p: Params) => unknown> = {
  ping: () => ({ node: process.version, bridge: __filename }),

  /** The git repository root for a solution or folder, in the form the editor opened it with. */
  root: (p) => {
    const folder = path.resolve(str(p, 'path'));
    const gitRoot = findRepoRoot(folder);
    if (!gitRoot) return null;
    try {
      const up = path.relative(fs.realpathSync(folder), fs.realpathSync(gitRoot));
      if (!path.isAbsolute(up)) return path.resolve(folder, up);
    } catch {
      // fall back to git's path
    }
    return path.resolve(gitRoot);
  },

  /**
   * Everything the Visual Studio UI shows, in one call. Also re-anchors threads that moved, and
   * with `pid` doubles as the editor heartbeat so polling needs a single process per tick.
   */
  state: (p) => {
    const store = storeOf(p);
    const root = store.root;
    if (p.pid !== undefined && store.exists()) store.markEditorOpen(pid(p));
    const files: ChangedFile[] = getChangedFiles(root);
    const lineCache = new Map<string, string[] | undefined>();
    const threads = store.listThreads().map((t) => {
      if (!lineCache.has(t.file)) lineCache.set(t.file, readLines(root, t.file));
      const lines = lineCache.get(t.file);
      let [startLine, endLine] = [t.startLine, t.endLine];
      if (lines) {
        [startLine, endLine] = locateThread(lines, t);
        if (startLine !== t.startLine || endLine !== t.endLine) store.updateThreadLocation(t.id, startLine, endLine);
      }
      const state = threadState(t);
      const hasDraft = t.comments.some((c) => c.draft);
      return {
        id: t.id,
        file: t.file,
        startLine,
        endLine,
        status: t.status,
        state,
        hasDraft,
        label: stateLabel(state, hasDraft),
        comments: t.comments.map((c) => ({
          id: c.id,
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
          draft: c.draft,
          attachments: findAttachments(root, c.body).map((a) => ({ alt: a.alt, path: a.abs })),
        })),
      };
    });
    const agent = store.getAgentState();
    return {
      root,
      storeExists: store.exists(),
      config: store.getConfig(),
      agent: { waiting: agent.waiting, agent: agent.agent, name: agentName(agent.agent) },
      draftCount: store.draftCommentCount(),
      undelivered: !!store.getUndeliveredReview(),
      runtimeInstalled: fs.existsSync(path.join(binDir(), 'hook.js')),
      files,
      threads,
    };
  },

  /** Line ranges (0-based, inclusive) that can be commented on, or "all" for new files. */
  ranges: (p) => {
    const store = storeOf(p);
    return commentableRanges(store.root, relPath(store.root, str(p, 'file'))) ?? [];
  },

  heartbeat: (p) => {
    const store = storeOf(p);
    if (store.exists()) store.markEditorOpen(pid(p));
    return null;
  },

  'editor-closed': (p) => {
    storeOf(p).markEditorClosed(pid(p));
    return null;
  },

  head: (p) => {
    const store = storeOf(p);
    return getHeadContent(store.root, relPath(store.root, str(p, 'file')));
  },

  'create-thread': (p) => {
    const store = storeOf(p);
    const rel = relPath(store.root, str(p, 'file'));
    const startLine = int(p, 'startLine');
    const endLine = int(p, 'endLine');
    const body = str(p, 'body');
    if (endLine < startLine) throw new UserError('Invalid line range.');
    if (!body.trim()) throw new UserError('The comment is empty.');
    const ranges = commentableRanges(store.root, rel);
    if (!ranges) throw new UserError(`${rel} has no uncommitted changes. You can only comment on changed files, as in a pull request.`);
    if (ranges !== 'all' && !ranges.some(([s, e]) => startLine <= e && endLine >= s)) {
      throw new UserError('You can only comment on changed lines, as in a pull request. Select a changed line and try again.');
    }
    let anchor = str(p, 'anchor', true);
    if (!anchor) anchor = readLines(store.root, rel)?.slice(startLine, endLine + 1).join('\n') ?? '';
    ensureStore(store);
    return store.createThread(rel, startLine, endLine, anchor, body).id;
  },

  reply: (p) => {
    const store = storeOf(p);
    const body = str(p, 'body');
    if (!body.trim()) throw new UserError('The reply is empty.');
    ensureStore(store);
    store.addComment(str(p, 'threadId'), 'user', body);
    return null;
  },

  'set-status': (p) => {
    const status = str(p, 'status');
    if (status !== 'open' && status !== 'resolved') throw new UserError('Invalid status.');
    storeOf(p).setThreadStatus(str(p, 'threadId'), status);
    return null;
  },

  'delete-thread': (p) => {
    storeOf(p).deleteThread(str(p, 'threadId'));
    return null;
  },

  'edit-comment': (p) => {
    const body = str(p, 'body');
    if (!body.trim()) throw new UserError('The comment is empty.');
    storeOf(p).editComment(str(p, 'threadId'), str(p, 'commentId'), body);
    return null;
  },

  'delete-comment': (p) => {
    storeOf(p).deleteComment(str(p, 'threadId'), str(p, 'commentId'));
    return null;
  },

  submit: (p) => {
    const store = storeOf(p);
    const summary = str(p, 'summary', true).trim();
    ensureStore(store);
    if (!store.draftCommentCount() && !summary) throw new UserError('Nothing to submit. Add a comment or use Approve.');
    store.ensureDraftReview();
    const review = store.submitDraft(summary);
    if (!review) throw new UserError('Nothing to submit. Add a comment or use Approve.');
    return { reviewId: review.id, agentWaiting: store.getAgentState().waiting, text: formatReview(store, review) };
  },

  approve: (p) => {
    const store = storeOf(p);
    ensureStore(store);
    store.approveDraft();
    store.sendSignal('approve');
    return null;
  },

  discard: (p) => {
    const store = storeOf(p);
    ensureStore(store);
    store.discardDraft();
    store.sendSignal('discard');
    return null;
  },

  'set-mode': (p) => {
    const store = storeOf(p);
    const mode = str(p, 'mode');
    if (mode !== 'on' && mode !== 'off') throw new UserError('Invalid mode.');
    ensureStore(store);
    const minutes = p.waitTimeoutMinutes;
    const patch = typeof minutes === 'number' && Number.isFinite(minutes) ? { waitTimeoutSec: Math.max(1, Math.round(minutes * 60)) } : {};
    store.setConfig({ ...patch, mode });
    return { runtimeInstalled: fs.existsSync(path.join(binDir(), 'hook.js')) };
  },

  /** Applies the wait-timeout setting to a repository that already uses Vibe Review. */
  'set-timeout': (p) => {
    const store = storeOf(p);
    const minutes = p.waitTimeoutMinutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) throw new UserError('Invalid "waitTimeoutMinutes".');
    if (store.exists()) store.setConfig({ waitTimeoutSec: Math.max(1, Math.round(minutes * 60)) });
    return null;
  },

  /** Saves a pasted image (base64 `data` + `ext`) or a copied image file (`path`) as an attachment. */
  attach: (p) => {
    const store = storeOf(p);
    let bytes: Buffer;
    let ext: string;
    let name: string;
    if (typeof p.path === 'string') {
      if (!isImagePath(p.path)) throw new UserError('Only PNG, JPEG, GIF and WebP images can be attached.');
      bytes = fs.readFileSync(p.path);
      ext = path.extname(p.path).slice(1).toLowerCase();
      name = path.parse(p.path).name;
    } else {
      const fromMime = extForMime(str(p, 'mime'));
      if (!fromMime) throw new UserError('Only PNG, JPEG, GIF and WebP images can be attached.');
      bytes = Buffer.from(str(p, 'data'), 'base64');
      ext = fromMime;
      name = 'screenshot';
    }
    ensureStore(store);
    return imageMarkdown(saveAttachment(store.root, bytes, ext), name);
  },

  'html-to-markdown': (p) => htmlToMarkdown(str(p, 'html')),

  agents: () =>
    (Object.keys(AGENTS) as AgentId[]).map((id) => ({ id, name: AGENTS[id], installed: isInstalled(id, home()), files: filesFor(id, home()) })),

  setup: (p) => {
    const ids = agentIds(p);
    const install = p.install !== false;
    if (install) installRuntime(__dirname, binDir());
    const ctx = { home: home(), nodePath: resolveNodePath(), binDir: binDir() };
    const notes = ids.flatMap((id) => configureAgent(id, ctx, install).notes);
    return { agents: ids.map((id) => AGENTS[id]), notes };
  },

  /** Keeps an installed hook/MCP runtime in sync with this extension version. */
  'sync-runtime': () => {
    if (!fs.existsSync(path.join(binDir(), 'hook.js'))) return false;
    installRuntime(__dirname, binDir());
    return true;
  },

  /**
   * Removes the hooks and MCP server from every agent and deletes the shared runtime. With
   * `everything`, also deletes this repository's review data (the extension itself is removed
   * through Visual Studio's Extension Manager).
   */
  uninstall: (p) => {
    const result = uninstallAll(home());
    let repoDataRemoved = false;
    if (!result.errors.length && p.everything === true && typeof p.root === 'string' && p.root) {
      const store = storeOf(p);
      if (store.exists()) {
        fs.rmSync(store.dir, { recursive: true, force: true });
        repoDataRemoved = true;
      }
      removeLocalExclude(store.root);
    }
    return {
      removedFrom: result.removedFrom.map((a) => AGENTS[a]),
      errors: result.errors,
      runtimeRemoved: result.runtimeRemoved,
      runtimeDir: runtimeDir(home()),
      repoDataRemoved,
    };
  },
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function respond(body: object, code: number): void {
  process.stdout.write(JSON.stringify(body) + '\n', () => process.exit(code));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  const handler = Object.prototype.hasOwnProperty.call(commands, command) ? commands[command] : undefined;
  if (!handler) return respond({ ok: false, error: `Unknown command: ${command}` }, 2);
  const raw = await readStdin();
  let params: unknown = {};
  try {
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return respond({ ok: false, error: 'Request is not valid JSON.' }, 2);
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return respond({ ok: false, error: 'Request must be a JSON object.' }, 2);
  }
  try {
    respond({ ok: true, result: handler(params as Params) ?? null }, 0);
  } catch (err) {
    respond({ ok: false, error: err instanceof Error ? err.message : String(err), user: err instanceof UserError }, 1);
  }
}

void main();
