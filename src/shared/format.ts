import * as fs from 'node:fs';
import * as path from 'node:path';
import { Review, ReviewThread } from './types';
import { ReviewStore } from './store';
import { findAttachments, rewriteAttachments } from './attachments';

/**
 * Finds where a thread's anchored code currently lives. Agents edit code after comments are
 * made, so the stored line numbers drift; we search for the original text nearest to the
 * original position and fall back to the stored (clamped) range.
 */
export function locateThread(lines: string[], thread: ReviewThread): [number, number] {
  const span = thread.endLine - thread.startLine;
  const clamp = (n: number) => Math.max(0, Math.min(n, Math.max(0, lines.length - 1)));
  const anchorLines = thread.anchor.split('\n');
  const a = clamp(thread.startLine);
  const b = clamp(thread.startLine + span);
  const fallback: [number, number] = [Math.min(a, b), Math.max(a, b)];
  if (!thread.anchor.trim() || anchorLines.length === 0) return fallback;

  const matchesAt = (i: number) => anchorLines.every((a, k) => lines[i + k]?.trimEnd() === a.trimEnd());
  if (matchesAt(thread.startLine)) return [thread.startLine, thread.startLine + anchorLines.length - 1];

  let best = -1;
  for (let i = 0; i + anchorLines.length <= lines.length; i++) {
    if (matchesAt(i) && (best < 0 || Math.abs(i - thread.startLine) < Math.abs(best - thread.startLine))) {
      best = i;
    }
  }
  return best >= 0 ? [best, best + anchorLines.length - 1] : fallback;
}

function readLines(root: string, file: string): string[] | undefined {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/**
 * Escapes lines in user text that would read as this prompt's own section headings, so a
 * comment can't fake an extra thread or section for the agent.
 */
function escapeHeadings(text: string): string {
  return text.replace(/^( {0,3})(#{1,6}[ \t]+(?:Thread|Threads|Overall comment|Attached images|Local code review)\b)/gim, '$1\\$2');
}

function fence(code: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  return '`'.repeat(longest + 1);
}

export function formatThread(root: string, thread: ReviewThread, reviewId?: string): string {
  const lines = readLines(root, thread.file);
  let location: string;
  let snippet = '';
  if (lines) {
    const [s, e] = locateThread(lines, thread);
    location = s === e ? `${thread.file}:${s + 1}` : `${thread.file}:${s + 1}-${e + 1}`;
    const code = lines.slice(s, e + 1).join('\n');
    const f = fence(code);
    snippet = `${f}\n${code}\n${f}\n`;
  } else {
    location = `${thread.file}:${thread.startLine + 1} (file no longer exists)`;
  }

  const conversation = thread.comments
    .filter((c) => !c.draft)
    .map((c) => {
      const isNew = reviewId !== undefined && c.reviewId === reviewId;
      const who = c.author === 'user' ? 'Reviewer' : 'You (agent)';
      const body = rewriteAttachments(root, escapeHeadings(c.body), (abs, alt) => `![${alt || 'image'}](<${abs}>)`);
      return `- **${who}${isNew ? ' (new)' : ''}:** ${body.replace(/\n/g, '\n  ')}`;
    })
    .join('\n');

  return `### Thread \`${thread.id}\` — ${location}\n${snippet}${conversation}\n`;
}

export function formatReview(store: ReviewStore, review: Review): string {
  const threads = store.threadsForReview(review.id).filter((t) => t.status === 'open');
  const parts: string[] = [
    `# Local code review \`${review.id}\``,
    '',
    'The user reviewed your uncommitted changes and left PR-style review comments. Treat them like pull request review feedback:',
    '1. Address every thread below by changing the code (or explain why no change is needed).',
    `2. For each thread, call the \`vibe-review\` MCP tool \`reply_to_thread\` (with \`repo_path: ${JSON.stringify(store.root)}\`) with a short summary of what you did, then \`resolve_thread\` once it is fully addressed (the reviewer then accepts it). If those tools are unavailable, summarize per thread ID in your final message.`,
    '3. Do not commit; the user will review again.',
    '',
  ];
  if (review.summary) {
    const summary = rewriteAttachments(store.root, escapeHeadings(review.summary), (abs, alt) => `![${alt || 'image'}](<${abs}>)`);
    parts.push(`## Overall comment\n${summary}\n`);
  }
  if (threads.length) {
    parts.push(`## Threads (${threads.length})\n`);
    for (const t of threads) parts.push(formatThread(store.root, t, review.id));
  }
  const images = [review.summary ?? '', ...threads.flatMap((t) => t.comments.filter((c) => !c.draft).map((c) => c.body))]
    .flatMap((body) => findAttachments(store.root, body))
    .filter((img, i, all) => all.findIndex((o) => o.abs === img.abs) === i && fs.existsSync(img.abs));
  if (images.length) {
    parts.push(
      `## Attached images (${images.length})\n`,
      'The reviewer pasted these screenshots into their comments. Open each one with your image/file viewing tool before addressing its thread (the `get_review` MCP tool also returns them as images):',
      ...images.map((img) => `- ${img.abs}`),
      '',
    );
  }
  return parts.join('\n');
}
