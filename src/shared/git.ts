import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function git(cwd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Stop `git status` rewriting .git/index, which would re-trigger our file watcher.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

export function findRepoRoot(cwd: string): string | undefined {
  const out = git(cwd, ['rev-parse', '--show-toplevel'], true).trim();
  return out || undefined;
}

export function hasHead(root: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true).trim().length > 0;
}

/** True if any review-store file is committed or staged, i.e. it came from (or will go to) the repo. */
export function isStoreTracked(root: string): boolean {
  return git(root, ['ls-files', '-z', '--', '.vibe-review'], true).length > 0;
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
}

/** Uncommitted changes (staged + unstaged + untracked) relative to HEAD. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function getChangedFiles(root: string): ChangedFile[] {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], true);
  const entries = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);
    if (x === '?' && y === '?') {
      files.push({ path: p, kind: 'untracked' });
    } else if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // In -z mode the source path follows as the next entry (index or worktree rename, the
      // latter e.g. after `git add -N`).
      const oldPath = entries[++i];
      files.push({ path: p, oldPath, kind: 'renamed' });
    } else if (x === 'D' || y === 'D') {
      files.push({ path: p, kind: 'deleted' });
    } else if (x === 'A' || y === 'A') {
      // ` A` is an intent-to-add file (`git add -N`): new, just not staged yet.
      files.push({ path: p, kind: 'added' });
    } else {
      files.push({ path: p, kind: 'modified' });
    }
  }
  return files.filter((f) => !f.path.startsWith('.vibe-review/'));
}

export function getHeadContent(root: string, relPath: string): string {
  if (!hasHead(root)) return '';
  return git(root, ['show', `HEAD:${relPath}`], true);
}

/** 0-based inclusive line ranges in the working-tree file that differ from HEAD. */
export function getChangedLineRanges(root: string, relPath: string): Array<[number, number]> {
  const args = hasHead(root)
    ? ['diff', 'HEAD', '-U0', '--no-color', '--', relPath]
    : // No commits yet: compare the working tree with the empty tree, so unstaged lines count too.
      ['diff', EMPTY_TREE, '-U0', '--no-color', '--', relPath];
  return parseHunks(git(root, args, true));
}

export function parseHunks(diff: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff))) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      // Pure deletion: allow commenting on the line where content was removed.
      const line = Math.max(0, start - 1);
      ranges.push([line, line]);
    } else {
      ranges.push([start - 1, start - 1 + count - 1]);
    }
  }
  return ranges;
}

/** Ensures `.vibe-review/` is ignored locally without touching the committed .gitignore. */
/**
 * The exclude file git actually reads. In a linked worktree that's the main repository's
 * `info/exclude`, not the one under `.git/worktrees/<name>`.
 */
function excludeFile(root: string): string | undefined {
  const p = git(root, ['rev-parse', '--git-path', 'info/exclude'], true).trim();
  return p ? path.resolve(root, p) : undefined;
}

// Both forms exclude the store at the repo root. The anchored one records that we also had to
// end the user's last line, so removing it restores the file byte for byte.
const EXCLUDE_LINE = '.vibe-review/';
const EXCLUDE_LINE_ADDED_EOL = '/.vibe-review/';

export function ensureLocalExclude(root: string): void {
  const file = excludeFile(root);
  if (!file) return;
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(EXCLUDE_LINE) || lines.includes(EXCLUDE_LINE_ADDED_EOL)) return;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const addEol = current.length > 0 && !current.endsWith('\n');
  fs.appendFileSync(file, addEol ? `${eol}${EXCLUDE_LINE_ADDED_EOL}${eol}` : `${EXCLUDE_LINE}${eol}`);
}

/** Undoes `ensureLocalExclude`. */
export function removeLocalExclude(root: string): void {
  const file = excludeFile(root);
  if (!file) return;
  let current: string;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const re = /^[ \t]*(\/?)\.vibe-review\/[ \t]*(\r?\n|$)/gm;
  let next = current;
  for (const m of [...current.matchAll(re)].reverse()) {
    const start = m.index!;
    const end = start + m[0].length;
    next = next.slice(0, start) + next.slice(end);
    // We ended the user's last line to append ours; take that newline back off.
    if (m[1] && end === current.length) next = next.replace(/\r?\n$/, '');
  }
  if (next !== current) fs.writeFileSync(file, next);
}
