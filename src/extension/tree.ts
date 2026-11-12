import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangedFile, getChangedFiles } from '../shared/git';
import { ReviewStore } from '../shared/store';
import { ReviewThread, stateLabel, threadState } from '../shared/types';

export const HEAD_SCHEME = 'vibe-review-head';

export function headUri(root: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: HEAD_SCHEME, path: `/${relPath}`, query: root });
}

type Node =
  | { type: 'file'; file: ChangedFile; threads: ReviewThread[] }
  | { type: 'thread'; file: ChangedFile; thread: ReviewThread };

const KIND_LETTER: Record<ChangedFile['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

export class ChangesTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private files: ChangedFile[] = [];

  constructor(private readonly store: ReviewStore) {}

  refresh(): void {
    this.files = getChangedFiles(this.store.root);
    this.emitter.fire();
  }

  get changedFiles(): ChangedFile[] {
    return this.files;
  }

  getChildren(node?: Node): Node[] {
    const threads = this.store.listThreads();
    if (!node) {
      return this.files.map((file) => ({
        type: 'file' as const,
        file,
        threads: threads.filter((t) => t.file === file.path),
      }));
    }
    if (node.type === 'file') return node.threads.map((thread) => ({ type: 'thread' as const, file: node.file, thread }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const root = this.store.root;
    if (node.type === 'file') {
      const uri = vscode.Uri.file(path.join(root, node.file.path));
      const item = new vscode.TreeItem(
        uri,
        node.threads.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      const dir = path.posix.dirname(node.file.path);
      const pending = node.threads.filter((t) => threadState(t) === 'pending').length;
      const active = node.threads.filter((t) => threadState(t) === 'active').length;
      item.description = [dir === '.' ? '' : dir, pending ? `● ${pending}` : '', active ? `◐ ${active}` : ''].filter(Boolean).join('  ');
      item.tooltip = `${node.file.path} (${node.file.kind})`;
      item.contextValue = 'file';
      item.command = { command: 'vibeReview.openDiff', title: 'Open Diff', arguments: [node.file] };
      item.label = `${path.posix.basename(node.file.path)}`;
      item.description = `${KIND_LETTER[node.file.kind]}  ${item.description}`;
      return item;
    }
    const t = node.thread;
    const first = t.comments[0];
    const item = new vscode.TreeItem(first?.body.split('\n')[0] ?? '(empty)', vscode.TreeItemCollapsibleState.None);
    const draft = t.comments.some((c) => c.draft);
    const state = threadState(t);
    const word = state === 'pending' ? (draft ? 'pending · not submitted' : 'pending') : state;
    item.description = `L${t.startLine + 1} · ${word}`;
    item.tooltip = stateLabel(state, draft);
    item.iconPath =
      state === 'resolved'
        ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
        : state === 'active'
          ? new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.blue'))
          : new vscode.ThemeIcon(draft ? 'comment-draft' : 'comment', new vscode.ThemeColor('charts.yellow'));
    item.contextValue = 'thread';
    item.command = { command: 'vibeReview.revealThread', title: 'Reveal', arguments: [node.file, t.id] };
    return item;
  }
}
