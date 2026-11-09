import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangedFile, ensureLocalExclude, findRepoRoot, getHeadContent, removeLocalExclude } from '../shared/git';
import { ReviewStore } from '../shared/store';
import { threadState } from '../shared/types';
import { formatReview } from '../shared/format';
import { AGENTS, AgentId, configureAgent, filesFor, installRuntime, isInstalled, resolveNodePath, runtimeDir, uninstallAll } from '../shared/setup';
import { ChangesTree, HEAD_SCHEME, headUri } from './tree';
import { CommentsManager, LocalComment, commentMarkdown } from './comments';
import { registerPasteSupport } from './paste';

const RUNTIME_DIR = path.join(os.homedir(), '.vibe-review', 'bin');

/**
 * Repo root expressed in the same form as the workspace folder path. git returns the
 * symlink-resolved path, but VS Code document URIs keep the path the folder was opened with.
 */
function findRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const gitRoot = findRepoRoot(folder.uri.fsPath);
    if (!gitRoot) continue;
    try {
      const realFolder = fs.realpathSync(folder.uri.fsPath);
      const up = path.relative(realFolder, fs.realpathSync(gitRoot));
      if (!path.isAbsolute(up)) return path.resolve(folder.uri.fsPath, up);
    } catch {
      // fall back to git's path
    }
    return gitRoot;
  }
  return undefined;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const distDir = path.join(context.extensionPath, 'dist');
  // Keep the installed hook/MCP runtime in sync with this extension version.
  if (fs.existsSync(path.join(RUNTIME_DIR, 'hook.js'))) {
    try {
      installRuntime(distDir, RUNTIME_DIR);
    } catch {
      // Non-fatal: the previously installed runtime keeps working.
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vibeReview.setupAgents', () => setupAgents(distDir)),
    vscode.commands.registerCommand('vibeReview.uninstall', () => uninstallEverything(context)),
  );

  const root = findRoot();
  vscode.commands.executeCommand('setContext', 'vibeReview.active', !!root);
  if (!root) return;

  const store = new ReviewStore(root);
  const ensureStore = () => {
    if (!store.exists()) {
      fs.mkdirSync(store.dir, { recursive: true });
      ensureLocalExclude(root);
    }
  };

  const tree = new ChangesTree(store);
  const comments = new CommentsManager(store, ensureStore, context.extensionUri);
  const view = vscode.window.createTreeView('vibeReview.changes', { treeDataProvider: tree, showCollapseAll: true });
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'vibeReview.actions';
  context.subscriptions.push(comments, view, statusItem, registerPasteSupport(root, ensureStore));

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, {
      provideTextDocumentContent: (uri) => getHeadContent(uri.query, uri.path.replace(/^\//, '')),
    }),
  );

  let wasWaiting = false;
  const updateStatus = () => {
    const config = store.getConfig();
    const agent = store.getAgentState();
    const drafts = store.draftCommentCount();
    const pending = store.getUndeliveredReview();
    let waitingOnAgent = 0;
    let active = 0;
    for (const t of store.listThreads()) {
      const st = threadState(t);
      if (st === 'active') active++;
      else if (st === 'pending' && !t.comments.some((c) => c.draft)) waitingOnAgent++;
    }
    vscode.commands.executeCommand('setContext', 'vibeReview.mode', config.mode);
    vscode.commands.executeCommand('setContext', 'vibeReview.agentWaiting', agent.waiting);

    const parts: string[] = [];
    if (agent.waiting) {
      parts.push(`$(bell-dot) ${AGENTS[agent.agent as AgentId] ?? 'Agent'} waiting for review`);
      statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      parts.push(config.mode === 'on' ? '$(eye) Review: On' : '$(eye-closed) Review: Off');
      statusItem.backgroundColor = undefined;
    }
    if (drafts) parts.push(`$(comment-draft) ${drafts}`);
    if (waitingOnAgent) parts.push(`● ${waitingOnAgent}`);
    if (active) parts.push(`◐ ${active}`);
    if (pending) parts.push('$(mail) not yet picked up');
    statusItem.text = parts.join('  ');
    statusItem.tooltip = new vscode.MarkdownString(
      [
        `**Vibe Review** — mode **${config.mode}**`,
        agent.waiting ? `Agent is paused until you Submit, Approve or Discard.` : '',
        drafts ? `$(comment-draft) ${drafts} draft comment(s), not submitted yet.` : '',
        waitingOnAgent ? `● ${waitingOnAgent} pending thread(s) submitted and waiting for the agent.` : '',
        active ? `◐ ${active} active thread(s): the agent replied. Resolve to accept, or reply.` : '',
        pending ? `A submitted review hasn't been picked up yet. Send any message in the agent's terminal (e.g. \`review\`).` : '',
        'Click for actions.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    statusItem.show();
    view.badge = drafts ? { value: drafts, tooltip: `${drafts} pending comment(s)` } : undefined;

    if (agent.waiting && !wasWaiting) {
      vscode.window
        .showInformationMessage(
          `${AGENTS[agent.agent as AgentId] ?? 'Your agent'} finished and is waiting for your review.`,
          'Open Changes',
          'Approve',
        )
        .then((choice) => {
          if (choice === 'Open Changes') vscode.commands.executeCommand('vibeReview.changes.focus');
          if (choice === 'Approve') vscode.commands.executeCommand('vibeReview.approve');
        });
    }
    wasWaiting = agent.waiting;
  };

  const refreshAll = () => {
    tree.refresh();
    comments.refreshRanges(tree.changedFiles);
    comments.sync();
    updateStatus();
  };
  const refreshSoon = debounce(refreshAll, 300);
  const storeChanged = debounce(() => {
    comments.sync();
    tree.refresh();
    updateStatus();
  }, 150);

  const storeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.vibe-review/**'));
  const workWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  // Ignore git internals (git itself touches .git/ on every status call) and our own store.
  const ignored = [`${path.sep}.git${path.sep}`, `${path.sep}.vibe-review${path.sep}`, `${path.sep}node_modules${path.sep}`];
  const onWork = (uri: vscode.Uri) => {
    const p = uri.fsPath;
    if (ignored.some((seg) => p.includes(seg)) || p.endsWith(`${path.sep}.git`)) return;
    refreshSoon();
  };
  context.subscriptions.push(
    storeWatcher,
    workWatcher,
    storeWatcher.onDidCreate(storeChanged),
    storeWatcher.onDidChange(storeChanged),
    storeWatcher.onDidDelete(storeChanged),
    workWatcher.onDidCreate(onWork),
    workWatcher.onDidChange(onWork),
    workWatcher.onDidDelete(onWork),
    vscode.workspace.onDidSaveTextDocument(refreshSoon),
  );
  // Fallback poll: watchers can miss changes made by other processes (and dead hook PIDs).
  const poll = setInterval(updateStatus, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });

  const syncSettings = () => {
    if (!store.exists()) return;
    const minutes = vscode.workspace.getConfiguration('vibeReview').get<number>('waitTimeoutMinutes', 30);
    store.setConfig({ waitTimeoutSec: Math.max(1, Math.round(minutes * 60)) });
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vibeReview')) syncSettings();
      if (e.affectsConfiguration('vibeReview.useGitHubAvatar')) void comments.refreshUserAvatar();
    }),
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github') void comments.refreshUserAvatar();
    }),
  );
  void comments.refreshUserAvatar();

  const openDiff = async (file: ChangedFile) => {
    const right = vscode.Uri.file(path.join(root, file.path));
    const title = `${path.basename(file.path)} (HEAD ↔ Working Tree)`;
    if (file.kind === 'deleted') {
      await vscode.commands.executeCommand('vscode.open', headUri(root, file.path));
      return;
    }
    const left = headUri(root, file.kind === 'renamed' && file.oldPath ? file.oldPath : file.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  };

  const commentFromArgs = (arg: unknown): LocalComment | undefined => (arg instanceof LocalComment ? arg : undefined);

  const submit = async () => {
    ensureStore();
    const drafts = store.draftCommentCount();
    const summary = await vscode.window.showInputBox({
      title: `Submit review${drafts ? ` (${drafts} comment${drafts === 1 ? '' : 's'})` : ''}`,
      prompt: drafts ? 'Optional overall comment for the agent' : 'No line comments yet — write an overall comment for the agent',
      placeHolder: 'e.g. Looks close. Please also add tests.',
      ignoreFocusOut: true,
    });
    if (summary === undefined) return;
    if (!drafts && !summary.trim()) {
      vscode.window.showWarningMessage('Nothing to submit. Add a comment or use Approve.');
      return;
    }
    store.ensureDraftReview();
    const review = store.submitDraft(summary.trim());
    if (!review) return;
    refreshAll();
    if (!store.getAgentState().waiting) {
      const choice = await vscode.window.showInformationMessage(
        'Review submitted. No agent is waiting right now: it will be picked up when the agent next finishes a turn, or send any message (e.g. "review") in the agent\'s terminal.',
        'Copy Review',
      );
      if (choice === 'Copy Review') await vscode.env.clipboard.writeText(formatReview(store, review));
    } else {
      vscode.window.setStatusBarMessage('$(check) Review sent to the agent', 4000);
    }
  };

  const approve = async () => {
    const drafts = store.draftCommentCount();
    if (drafts) {
      const choice = await vscode.window.showWarningMessage(
        `You have ${drafts} pending comment(s). Approving won't send them.`,
        { modal: true },
        'Approve Anyway',
      );
      if (choice !== 'Approve Anyway') return;
    }
    ensureStore();
    store.approveDraft();
    store.sendSignal('approve');
    refreshAll();
    vscode.window.setStatusBarMessage('$(pass) Approved — the agent can stop', 4000);
  };

  const discard = async () => {
    const drafts = store.draftCommentCount();
    if (drafts) {
      const choice = await vscode.window.showWarningMessage(
        `Discard ${drafts} pending comment(s)?`,
        { modal: true },
        'Discard',
      );
      if (choice !== 'Discard') return;
    }
    ensureStore();
    store.discardDraft();
    store.sendSignal('discard');
    refreshAll();
  };

  const setMode = (mode: 'on' | 'off') => {
    ensureStore();
    syncSettings();
    store.setConfig({ mode });
    updateStatus();
    if (mode === 'on' && !fs.existsSync(path.join(RUNTIME_DIR, 'hook.js'))) {
      vscode.window
        .showInformationMessage('Review Mode is on, but no agent hooks are installed yet.', 'Set Up Agents')
        .then((c) => c && vscode.commands.executeCommand('vibeReview.setupAgents'));
    }
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('vibeReview.refresh', refreshAll);
  reg('vibeReview.openDiff', openDiff);
  reg('vibeReview.revealThread', async (file: ChangedFile, threadId: string) => {
    await openDiff(file);
    const t = comments.get(threadId);
    const editor = vscode.window.activeTextEditor;
    if (t?.range && editor) {
      editor.revealRange(t.range, vscode.TextEditorRevealType.InCenter);
      t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  });
  reg('vibeReview.submit', submit);
  reg('vibeReview.approve', approve);
  reg('vibeReview.discard', discard);
  reg('vibeReview.modeOn', () => setMode('on'));
  reg('vibeReview.modeOff', () => setMode('off'));
  reg('vibeReview.toggleMode', () => setMode(store.getConfig().mode === 'on' ? 'off' : 'on'));
  reg('vibeReview.actions', async () => {
    const mode = store.getConfig().mode;
    const items: Array<vscode.QuickPickItem & { cmd: string }> = [
      { label: '$(send) Submit Review', description: `${store.draftCommentCount()} pending comment(s)`, cmd: 'vibeReview.submit' },
      { label: '$(pass) Approve', description: 'Let the agent stop', cmd: 'vibeReview.approve' },
      { label: '$(trash) Discard Review', cmd: 'vibeReview.discard' },
      {
        label: mode === 'on' ? '$(eye-closed) Turn Review Mode Off' : '$(eye) Turn Review Mode On',
        description: mode === 'on' ? 'Agents stop normally' : 'Agents wait for your review after each turn',
        cmd: 'vibeReview.toggleMode',
      },
      { label: '$(list-tree) Show Changes', cmd: 'vibeReview.changes.focus' },
      { label: '$(gear) Set Up Agents…', cmd: 'vibeReview.setupAgents' },
      { label: '$(trash) Uninstall Vibe Review…', cmd: 'vibeReview.uninstall' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Vibe Review' });
    if (pick) vscode.commands.executeCommand(pick.cmd);
  });

  reg('vibeReview.createComment', (reply: vscode.CommentReply) => comments.createFromReply(reply));
  reg('vibeReview.replyComment', (reply: vscode.CommentReply) => comments.reply(reply));
  reg('vibeReview.resolveThread', (thread: vscode.CommentThread) => {
    const id = comments.idOf(thread);
    if (id) store.setThreadStatus(id, 'resolved');
    comments.sync();
    tree.refresh();
  });
  reg('vibeReview.reopenThread', (thread: vscode.CommentThread) => {
    const id = comments.idOf(thread);
    if (id) store.setThreadStatus(id, 'open');
    comments.sync();
    tree.refresh();
  });
  reg('vibeReview.deleteThread', (thread: vscode.CommentThread) => {
    const id = comments.idOf(thread);
    if (id) store.deleteThread(id);
    refreshAll();
  });
  reg('vibeReview.editComment', (arg: unknown) => {
    const c = commentFromArgs(arg);
    const thread = c && comments.get(c.threadId);
    if (!c || !thread) return;
    c.savedBody = c.data.body;
    c.body = c.data.body;
    c.mode = vscode.CommentMode.Editing;
    thread.comments = [...thread.comments];
  });
  reg('vibeReview.saveComment', (arg: unknown) => {
    const c = commentFromArgs(arg);
    if (!c) return;
    const body = typeof c.body === 'string' ? c.body : c.body.value;
    c.mode = vscode.CommentMode.Preview;
    store.editComment(c.threadId, c.data.id, body);
    c.data.body = '\0'; // force re-render on next sync
    comments.sync();
  });
  reg('vibeReview.cancelEditComment', (arg: unknown) => {
    const c = commentFromArgs(arg);
    const thread = c && comments.get(c.threadId);
    if (!c || !thread) return;
    c.mode = vscode.CommentMode.Preview;
    c.body = commentMarkdown(root, c.savedBody ?? c.data.body);
    thread.comments = [...thread.comments];
  });
  reg('vibeReview.deleteComment', (arg: unknown) => {
    const c = commentFromArgs(arg);
    if (!c) return;
    store.deleteComment(c.threadId, c.data.id);
    refreshAll();
  });

  refreshAll();
}

async function setupAgents(distDir: string): Promise<void> {
  const picks = await vscode.window.showQuickPick(
    (Object.keys(AGENTS) as AgentId[]).map((id) => ({ label: AGENTS[id], id, picked: true })),
    {
      canPickMany: true,
      title: 'Vibe Review: install hooks + MCP server for which agents?',
      placeHolder: 'Hooks are user-level and do nothing unless a repo has Review Mode on.',
    },
  );
  if (!picks?.length) return;

  const home = os.homedir();
  const files = picks.flatMap((p) => filesFor(p.id, home));
  const confirm = await vscode.window.showWarningMessage(
    'Vibe Review will modify these files (a .vibe-review.bak backup is kept):',
    { modal: true, detail: files.join('\n') },
    'Install',
    'Uninstall',
  );
  if (!confirm) return;
  const install = confirm === 'Install';

  try {
    if (install) installRuntime(distDir, RUNTIME_DIR);
    const ctx = { home, nodePath: resolveNodePath(), binDir: RUNTIME_DIR };
    const notes = picks.flatMap((p) => configureAgent(p.id, ctx, install).notes);
    const msg = install
      ? `Vibe Review set up for ${picks.map((p) => p.label).join(', ')}. ${notes.join(' ')}`
      : `Vibe Review removed from ${picks.map((p) => p.label).join(', ')}.`;
    vscode.window.showInformationMessage(msg);
  } catch (err) {
    vscode.window.showErrorMessage(`Vibe Review setup failed: ${(err as Error).message}`);
  }
}

/** One-click cleanup: agent hooks + MCP, the shared runtime, this repo's review data, and the extension. */
async function uninstallEverything(context: vscode.ExtensionContext): Promise<void> {
  const home = os.homedir();
  const installed = (Object.keys(AGENTS) as AgentId[]).filter((a) => isInstalled(a, home));
  const root = findRoot();
  const repoData = root ? path.join(root, '.vibe-review') : undefined;
  const detail = [
    installed.length
      ? `Removes the Vibe Review hooks and MCP server from ${installed.map((a) => AGENTS[a]).join(', ')}:\n${installed.flatMap((a) => filesFor(a, home)).map((f) => `  • ${f}`).join('\n')}`
      : 'No agent is set up for Vibe Review.',
    `Deletes ${runtimeDir(home)}`,
    'Your other agent settings are kept, and a .vibe-review.bak backup of each file is saved.',
    repoData && fs.existsSync(repoData) ? `"Uninstall Everything" also deletes this project's review data (${repoData}) and uninstalls the extension.` : '"Uninstall Everything" also uninstalls the extension.',
  ].join('\n\n');
  const choice = await vscode.window.showWarningMessage('Uninstall Vibe Review?', { modal: true, detail }, 'Uninstall Everything', 'Only Remove Agent Setup');
  if (!choice) return;

  const result = uninstallAll(home);
  if (result.errors.length) {
    vscode.window.showErrorMessage(
      `Vibe Review couldn't clean up: ${result.errors.join('; ')}. Fix or remove those entries by hand, then try again. Nothing else was deleted.`,
    );
    return;
  }
  const restart = result.removedFrom.length ? ` Restart running ${result.removedFrom.map((a) => AGENTS[a]).join(', ')} sessions.` : '';

  if (choice === 'Only Remove Agent Setup') {
    vscode.window.showInformationMessage(`Vibe Review removed from your agents.${restart} Run "Vibe Review: Set Up Agents" to add it back.`);
    return;
  }
  if (repoData) {
    fs.rmSync(repoData, { recursive: true, force: true });
    removeLocalExclude(root!);
  }
  await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', context.extension.id);
  const reload = await vscode.window.showInformationMessage(
    `Vibe Review is uninstalled.${restart} Reload VS Code to finish.`,
    'Reload Window',
  );
  if (reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

export function deactivate(): void {}
