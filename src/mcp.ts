/**
 * Vibe Review MCP server (stdio). Lets coding agents read review comments made in VS Code,
 * reply on threads and resolve them. The repository is resolved from VIBE_REVIEW_ROOT, the
 * `repo_path` tool argument, or the server's working directory.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findRepoRoot, isStoreTracked } from './shared/git';
import { ReviewStore } from './shared/store';
import * as fs from 'node:fs';
import { formatReview, formatThread } from './shared/format';
import { findAttachments } from './shared/attachments';
import { Review, threadState } from './shared/types';

const VERSION = '0.1.0';

function resolveStore(repoPath?: string): ReviewStore {
  const start = repoPath || process.env.VIBE_REVIEW_ROOT || process.cwd();
  const root = findRepoRoot(start);
  if (!root) throw new Error(`Not inside a git repository: ${start}. Pass repo_path.`);
  if (isStoreTracked(root)) {
    throw new Error('.vibe-review is committed to this repository, so its contents are untrusted. Remove it from git (git rm -r --cached .vibe-review) to use Vibe Review here.');
  }
  return new ReviewStore(root);
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The formatted review plus any pasted screenshots as MCP image content. */
function reviewContent(store: ReviewStore, review: Review) {
  const bodies = [review.summary ?? '', ...store.threadsForReview(review.id).flatMap((t) => t.comments.filter((c) => !c.draft).map((c) => c.body))];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  const all = bodies.flatMap((b) => findAttachments(store.root, b)).filter((img, i, a) => a.findIndex((o) => o.abs === img.abs) === i);
  for (const img of all) {
    if (images.length >= MAX_IMAGES) break;
    try {
      if (fs.statSync(img.abs).size > MAX_IMAGE_BYTES) continue;
      images.push({ type: 'image', data: fs.readFileSync(img.abs).toString('base64'), mimeType: img.mimeType });
    } catch {
      // Missing attachment: the text still lists its path.
    }
  }
  return { content: [{ type: 'text' as const, text: formatReview(store, review) }, ...images] };
}

const repoPath = z.string().optional().describe('Absolute path to the repository. Defaults to the current working directory.');

const server = new McpServer({ name: 'vibe-review', version: VERSION });

server.registerTool(
  'get_review',
  {
    title: 'Get local code review',
    description:
      'Returns the code review the user submitted in VS Code for your uncommitted changes (PR-style comment threads with file/line and code). Call this when told a review was submitted.',
    inputSchema: { repo_path: repoPath },
  },
  async ({ repo_path }) => {
    const store = resolveStore(repo_path);
    const pending = store.getUndeliveredReview();
    // Losing the claim race means a hook just delivered it; reading it back is still fine.
    const review = (pending && store.claimForDelivery(pending.id, 'mcp')) || store.getLatestSentReview();
    if (!review) return text('No review has been submitted yet.');
    return reviewContent(store, review);
  },
);

server.registerTool(
  'list_threads',
  {
    title: 'List review threads',
    description: 'Lists review comment threads (excluding unsubmitted drafts).',
    inputSchema: {
      repo_path: repoPath,
      status: z
        .enum(['open', 'pending', 'active', 'resolved', 'all'])
        .default('open')
        .describe('open = pending + active. pending: reviewer is waiting on you. active: you responded, reviewer has not accepted yet.'),
    },
  },
  async ({ repo_path, status }) => {
    const store = resolveStore(repo_path);
    const threads = store
      .listThreads()
      .filter((t) => t.comments.some((c) => !c.draft))
      .filter((t) => status === 'all' || (status === 'open' ? t.status === 'open' : threadState(t, 'agent') === status));
    if (!threads.length) return text(`No ${status === 'all' ? '' : status + ' '}threads.`);
    return text(threads.map((t) => `${formatThread(store.root, t)}State: ${threadState(t, 'agent')}\n`).join('\n'));
  },
);

server.registerTool(
  'reply_to_thread',
  {
    title: 'Reply to review thread',
    description: 'Posts a reply on a review thread, visible to the user in VS Code. Use it to explain what you changed.',
    inputSchema: {
      repo_path: repoPath,
      thread_id: z.string().describe('Thread ID, e.g. thr_abc123'),
      body: z.string().min(1).describe('Markdown reply'),
    },
  },
  async ({ repo_path, thread_id, body }) => {
    const store = resolveStore(repo_path);
    if (!store.getThread(thread_id)) return fail(`Thread ${thread_id} not found.`);
    store.addComment(thread_id, 'agent', body);
    return text(`Replied to ${thread_id}.`);
  },
);

server.registerTool(
  'resolve_thread',
  {
    title: 'Mark review thread addressed',
    description:
      'Marks a review thread as addressed once you have fully handled it, with a reply summarising what you did. The thread becomes Active until the reviewer accepts (resolves) it in VS Code; only the reviewer can fully resolve.',
    inputSchema: {
      repo_path: repoPath,
      thread_id: z.string(),
      body: z.string().optional().describe('Reply summarising what you changed (recommended)'),
    },
  },
  async ({ repo_path, thread_id, body }) => {
    const store = resolveStore(repo_path);
    const thread = store.getThread(thread_id);
    if (!thread) return fail(`Thread ${thread_id} not found.`);
    const last = thread.comments.filter((c) => !c.draft).at(-1);
    const note = body?.trim() || 'Addressed. Please review and resolve.';
    // Skip a duplicate note if the agent's own reply is already the last word (e.g. it called
    // reply_to_thread first, or retried this call).
    const alreadyAnswered = last?.author === 'agent' && (!body?.trim() || last.body.trim() === note);
    if (!alreadyAnswered) store.addComment(thread_id, 'agent', note);
    return text(`Marked ${thread_id} as addressed. It is now Active, waiting for the reviewer to accept (resolve) it or reply.`);
  },
);

server.registerTool(
  'wait_for_review',
  {
    title: 'Wait for a local code review',
    description:
      'Blocks until the user submits a review in VS Code or the timeout elapses. If it returns "No review yet", call it again to keep waiting. Prefer the stop hook when installed.',
    inputSchema: {
      repo_path: repoPath,
      timeout_sec: z.number().int().min(1).max(55).default(50),
    },
  },
  async ({ repo_path, timeout_sec }, extra) => {
    const store = resolveStore(repo_path);
    const deadline = Date.now() + timeout_sec * 1000;
    // Stop polling when the client cancels, so a cancelled wait can't claim a review later.
    while (!extra.signal.aborted) {
      const pending = store.getUndeliveredReview();
      if (pending) {
        const review = store.claimForDelivery(pending.id, 'mcp');
        if (review) return reviewContent(store, review);
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>((r) => {
        const timer = setTimeout(done, Math.min(1000, left));
        function done() {
          clearTimeout(timer);
          extra.signal.removeEventListener('abort', done);
          r();
        }
        extra.signal.addEventListener('abort', done);
      });
    }
    return text('No review yet. Call wait_for_review again to keep waiting.');
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`vibe-review MCP server failed: ${err}\n`);
  process.exit(1);
});
