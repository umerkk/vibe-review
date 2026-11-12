import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangedFile, getChangedLineRanges } from '../shared/git';
import { locateThread } from '../shared/format';
import { rewriteAttachments } from '../shared/attachments';
import { ReviewStore } from '../shared/store';
import { ReviewComment, ReviewThread, ThreadState, stateLabel, threadState } from '../shared/types';

/** Avatar images for each author, so consecutive comments are easy to tell apart. */
let avatars: { user?: vscode.Uri; agent?: vscode.Uri } = {};

function authorOf(data: ReviewComment): vscode.CommentAuthorInformation {
  return data.author === 'user' ? { name: 'You', iconPath: avatars.user } : { name: 'Agent', iconPath: avatars.agent };
}

export class LocalComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue: string;
  timestamp: Date;
  /** Body before an edit started, restored on cancel. */
  savedBody?: string;

  constructor(
    readonly data: ReviewComment,
    readonly threadId: string,
    public body: string | vscode.MarkdownString,
  ) {
    this.author = authorOf(data);
    this.label = data.draft ? 'Pending' : data.author === 'agent' ? 'AI reply' : undefined;
    this.contextValue = data.author === 'user' ? (data.draft ? 'draft' : 'user') : 'agent';
    this.timestamp = new Date(data.createdAt);
  }
}

/** Renders a comment body, pointing pasted-image references at their files so they display inline. */
export function commentMarkdown(root: string, body: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(rewriteAttachments(root, body, (abs, alt) => `![${alt}](${vscode.Uri.file(abs).toString()})`));
  md.isTrusted = false;
  return md;
}

export class CommentsManager implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  /** VS Code thread objects keyed back to store thread IDs. */
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private ranges = new Map<string, Array<[number, number]> | 'all'>();

  constructor(
    private readonly store: ReviewStore,
    private readonly ensureStore: () => void,
    private readonly extensionUri: vscode.Uri,
  ) {
    avatars = {
      user: vscode.Uri.joinPath(extensionUri, 'media', 'avatar-user.svg'),
      agent: vscode.Uri.joinPath(extensionUri, 'media', 'avatar-agent.svg'),
    };
    this.controller = vscode.comments.createCommentController('vibe-review', 'Vibe Review');
    this.controller.options = {
      prompt: 'Add a review comment for the agent…',
      placeHolder:
        'Markdown comment for the agent. Paste screenshots/images (⌘V/Ctrl+V), drag in image files (hold Shift), or paste rich text from a browser/docs and it becomes Markdown. Stays pending until you submit the review.',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRanges(document),
    };
  }

  dispose(): void {
    this.controller.dispose();
  }

  /**
   * Uses the avatar of the GitHub account signed in to VS Code for your comments, falling back to
   * the bundled placeholder. `getAccounts` never prompts, so users who aren't signed in see nothing.
   */
  async refreshUserAvatar(): Promise<void> {
    let user = vscode.Uri.joinPath(this.extensionUri, 'media', 'avatar-user.svg');
    if (vscode.workspace.getConfiguration('vibeReview').get<boolean>('useGitHubAvatar', true)) {
      try {
        const [account] = await vscode.authentication.getAccounts('github');
        if (account && /^\d+$/.test(account.id)) {
          user = vscode.Uri.parse(`https://avatars.githubusercontent.com/u/${account.id}?s=64`);
        }
      } catch {
        // GitHub authentication unavailable (e.g. disabled or offline); keep the placeholder.
      }
    }
    if (avatars.user?.toString() === user.toString()) return;
    avatars = { ...avatars, user };
    for (const vt of this.threads.values()) {
      const comments = vt.comments as readonly LocalComment[];
      if (!comments.some((c) => c.data?.author === 'user')) continue;
      for (const c of comments) if (c instanceof LocalComment) c.author = authorOf(c.data);
      vt.comments = [...comments];
    }
  }

  idOf(thread: vscode.CommentThread): string | undefined {
    return this.ids.get(thread);
  }

  get(id: string): vscode.CommentThread | undefined {
    return this.threads.get(id);
  }

  private relPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const rel = path.relative(this.store.root, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join('/');
  }

  /**
   * Recomputes which lines are commentable. Called from the debounced refresh rather than from
   * the provider, which VS Code invokes on every edit and must not block on git.
   */
  refreshRanges(changed: ChangedFile[]): void {
    const next = new Map<string, Array<[number, number]> | 'all'>();
    for (const f of changed) {
      if (f.kind === 'deleted') continue;
      next.set(f.path, f.kind === 'untracked' || f.kind === 'added' ? 'all' : getChangedLineRanges(this.store.root, f.path));
    }
    const same =
      next.size === this.ranges.size &&
      [...next].every(([k, v]) => JSON.stringify(v) === JSON.stringify(this.ranges.get(k)));
    if (same) return;
    this.ranges = next;
    // Re-assigning the provider makes VS Code ask for ranges again. That redraws open comment
    // widgets, which steals focus from the comment box, so only do it when ranges really changed.
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRanges(document),
    };
  }

  private commentingRanges(document: vscode.TextDocument): vscode.Range[] {
    const rel = this.relPath(document.uri);
    if (!rel || rel.startsWith('.vibe-review/')) return [];
    const ranges = this.ranges.get(rel);
    if (!ranges) return [];
    const last = Math.max(0, document.lineCount - 1);
    if (ranges === 'all') return [new vscode.Range(0, 0, last, 0)];
    return ranges.map(([s, e]) => new vscode.Range(Math.min(s, last), 0, Math.min(e, last), 0));
  }

  /** Creates a store thread from a new VS Code thread the user started typing in. */
  createFromReply(reply: vscode.CommentReply): void {
    const rel = this.relPath(reply.thread.uri);
    const range = reply.thread.range;
    if (!rel || !range) {
      vscode.window.showWarningMessage('Vibe Review: comments can only be added to files in the repository.');
      return;
    }
    this.ensureStore();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === reply.thread.uri.toString());
    const anchor = doc
      ? Array.from({ length: range.end.line - range.start.line + 1 }, (_, k) => doc.lineAt(range.start.line + k).text).join('\n')
      : '';
    const created = this.store.createThread(rel, range.start.line, range.end.line, anchor, reply.text);
    // Adopt VS Code's thread instead of disposing and recreating it, so the editor doesn't jump.
    this.threads.set(created.id, reply.thread);
    this.ids.set(reply.thread, created.id);
    this.sync();
  }

  reply(reply: vscode.CommentReply): void {
    const id = this.idOf(reply.thread);
    if (!id) return this.createFromReply(reply);
    this.ensureStore();
    this.store.addComment(id, 'user', reply.text);
    this.sync();
  }

  /** Reconciles VS Code comment threads with the files in `.vibe-review/threads`. */
  sync(): void {
    const stored = this.store.listThreads();
    const seen = new Set<string>();
    const fileCache = new Map<string, string[] | undefined>();
    const linesOf = (rel: string) => {
      if (!fileCache.has(rel)) {
        const open = vscode.workspace.textDocuments.find(
          (d) => d.uri.scheme === 'file' && d.uri.fsPath === path.join(this.store.root, rel),
        );
        let lines: string[] | undefined;
        if (open) lines = open.getText().split(/\r?\n/);
        else {
          try {
            lines = fs.readFileSync(path.join(this.store.root, rel), 'utf8').split(/\r?\n/);
          } catch {
            lines = undefined;
          }
        }
        fileCache.set(rel, lines);
      }
      return fileCache.get(rel);
    };

    for (const t of stored) {
      seen.add(t.id);
      const lines = linesOf(t.file);
      let [start, end] = [t.startLine, t.endLine];
      if (lines) {
        [start, end] = locateThread(lines, t);
        if (start !== t.startLine || end !== t.endLine) this.store.updateThreadLocation(t.id, start, end);
      }
      const range = new vscode.Range(start, 0, end, 0);
      const uri = vscode.Uri.file(path.join(this.store.root, t.file));
      let vt = this.threads.get(t.id);
      if (vt && vt.uri.toString() !== uri.toString()) {
        vt.dispose();
        vt = undefined;
      }
      if (!vt) {
        vt = this.controller.createCommentThread(uri, range, []);
        vt.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.threads.set(t.id, vt);
        this.ids.set(vt, t.id);
      }
      this.apply(vt, t, range);
    }

    for (const [id, vt] of this.threads) {
      if (!seen.has(id)) {
        vt.dispose();
        this.threads.delete(id);
      }
    }
  }

  private apply(vt: vscode.CommentThread, t: ReviewThread, range: vscode.Range): void {
    if (!vt.range || !vt.range.isEqual(range)) vt.range = range;
    const editing = new Map(
      vt.comments
        .filter((c): c is LocalComment => c instanceof LocalComment && c.mode === vscode.CommentMode.Editing)
        .map((c) => [c.data.id, c]),
    );
    const prev = vt.comments as readonly LocalComment[];
    const next = t.comments.map((c) => editing.get(c.id) ?? new LocalComment(c, t.id, commentMarkdown(this.store.root, c.body)));
    const changed =
      prev.length !== next.length ||
      prev.some((p, i) => p.data?.id !== next[i].data.id || p.data.body !== next[i].data.body || p.data.draft !== next[i].data.draft);
    if (changed) vt.comments = next;

    const threadSt = threadState(t);
    const hasDraft = t.comments.some((c) => c.draft);
    // Each property set re-renders the thread widget (and can steal focus), so only set changes.
    const contextValue: ThreadState = threadSt;
    const label = stateLabel(threadSt, hasDraft);
    const state = threadSt === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    if (vt.contextValue !== contextValue) vt.contextValue = contextValue;
    if (vt.label !== label) vt.label = label;
    if (vt.state !== state) {
      // Collapse on resolve and expand on reopen, but only on the transition so the user can still
      // expand a resolved thread to read it without it snapping shut on the next refresh.
      vt.collapsibleState =
        state === vscode.CommentThreadState.Resolved
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
      vt.state = state;
    }
    if (vt.canReply !== true) vt.canReply = true;
  }
}
