export type Author = 'user' | 'agent';

export interface ReviewComment {
  id: string;
  author: Author;
  body: string;
  createdAt: string;
  /** Draft comments belong to the in-progress review and are not visible to the agent yet. */
  draft: boolean;
  reviewId?: string;
}

export interface ReviewThread {
  id: string;
  /** Path relative to the repository root, using forward slashes. */
  file: string;
  /** 0-based inclusive line range. */
  startLine: number;
  endLine: number;
  /** Text of the commented lines when the thread was created; used to re-anchor after edits. */
  anchor: string;
  /** Only the reviewer resolves; see `threadState` for the Pending/Active split of open threads. */
  status: 'open' | 'resolved';
  comments: ReviewComment[];
  createdAt: string;
  updatedAt: string;
}

export type ReviewStatus = 'draft' | 'submitted' | 'delivered' | 'approved' | 'discarded';

export interface Review {
  id: string;
  status: ReviewStatus;
  summary?: string;
  createdAt: string;
  submittedAt?: string;
  deliveredAt?: string;
  deliveredTo?: string;
}

export type ReviewMode = 'on' | 'off';

export interface ReviewConfig {
  mode: ReviewMode;
  /** How long the stop hook waits for a review decision before letting the agent stop. */
  waitTimeoutSec: number;
}

export interface AgentState {
  waiting: boolean;
  agent?: string;
  sessionId?: string;
  pid?: number;
  since?: string;
  /** Lease end for waiters that poll in short calls (MCP `wait_for_review`). */
  expires?: string;
}

export type SignalAction = 'approve' | 'discard';

export interface Signal {
  action: SignalAction;
  at: string;
}

export const DEFAULT_CONFIG: ReviewConfig = { mode: 'off', waitTimeoutSec: 1800 };

/**
 * What the reviewer sees, like a GitHub review thread:
 * - pending: the reviewer has the last word (incl. drafts); the agent hasn't responded yet.
 * - active: the agent responded; waiting for the reviewer to accept (resolve) or reply.
 * - resolved: the reviewer accepted it.
 */
export type ThreadState = 'pending' | 'active' | 'resolved';

export function threadState(t: ReviewThread, viewer: 'user' | 'agent' = 'user'): ThreadState {
  // Draft comments are invisible to the agent. For the reviewer, an unsent reply already makes
  // the thread pending (even a resolved one), without changing the stored status, so discarding
  // the draft restores it.
  const comments = viewer === 'agent' ? t.comments.filter((c) => !c.draft) : t.comments;
  if (viewer === 'user' && t.comments.some((c) => c.draft)) return 'pending';
  if (t.status === 'resolved') return 'resolved';
  return comments.at(-1)?.author === 'agent' ? 'active' : 'pending';
}
