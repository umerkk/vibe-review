/**
 * Agent hook entry point.
 *
 *   node hook.js stop   <claude|codex|copilot> [--timeout <sec>]
 *   node hook.js prompt <claude|codex|copilot>
 *
 * stop:   runs when the agent finishes a turn. If Review Mode is on (or a submitted review is
 *         already pending) it blocks the agent until the user submits, approves or discards a
 *         review in VS Code, then either continues the agent with the review or lets it stop.
 * prompt: runs when the user sends a prompt. Attaches any submitted-but-undelivered review.
 */
import { findRepoRoot, getChangedFiles, isStoreTracked } from './shared/git';
import { ReviewStore } from './shared/store';
import { formatReview } from './shared/format';

type Agent = 'claude' | 'codex' | 'copilot';

const AGENTS: readonly Agent[] = ['claude', 'codex', 'copilot'];
const POLL_MS = 750;
/**
 * Copilot CLI ends the turn anyway after 8 consecutive Stop-hook blocks, so a 9th review sent
 * that way would be marked delivered but silently dropped. At the cap we leave the review for
 * the prompt hook instead. Counts reset whenever the user sends a prompt.
 */
const MAX_CONTINUATIONS = 8;
/** Agents always close stdin; don't hang forever if one doesn't. */
const STDIN_TIMEOUT_MS = 5000;
/** Budgets are measured from process start so slow stdin can't push us past the agent's kill. */
const PROCESS_START = Date.now();

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => {
      clearTimeout(timer);
      // destroy (not pause) so a never-closing producer can't keep the event loop alive.
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deliver(store: ReviewStore, agent: Agent): string | undefined {
  const pending = store.getUndeliveredReview();
  if (!pending) return undefined;
  const claimed = store.claimForDelivery(pending.id, agent);
  return claimed ? formatReview(store, claimed) : undefined;
}

function sessionOf(input: Record<string, unknown>): string | undefined {
  const id = input.session_id ?? input.sessionId;
  return typeof id === 'string' && id ? id : undefined;
}

/** Seconds the stop hook may wait, leaving headroom to exit before the agent kills it. */
export function waitBudgetSec(configSec: number, hookTimeoutSec?: number): number {
  if (!hookTimeoutSec || !Number.isFinite(hookTimeoutSec) || hookTimeoutSec <= 0) return configSec;
  const headroom = hookTimeoutSec > 15 ? 10 : hookTimeoutSec / 2;
  return Math.max(0, Math.min(configSec, hookTimeoutSec - headroom));
}

async function runStop(store: ReviewStore, agent: Agent, input: Record<string, unknown>, hookTimeoutSec?: number): Promise<void> {
  const sessionId = sessionOf(input);
  const allow = () => emit({});
  const block = (reason: string) => {
    store.bumpContinuations(sessionId);
    emit({ decision: 'block', reason });
  };
  // The agent would ignore another block, so don't claim (and lose) a review; the next prompt
  // delivers it.
  if (store.getContinuations(sessionId) >= MAX_CONTINUATIONS) return allow();

  const immediate = deliver(store, agent);
  if (immediate) return block(immediate);

  const config = store.getConfig();
  if (config.mode !== 'on') return allow();
  // Review Mode left on with VS Code closed: nobody can submit a review, so don't hold the agent.
  if (!store.isEditorOpen()) return allow();
  if (getChangedFiles(store.root).length === 0) return allow();

  const budgetSec = waitBudgetSec(config.waitTimeoutSec, hookTimeoutSec);
  const startedAt = new Date();
  const deadline = PROCESS_START + budgetSec * 1000;
  // If the agent dies without signalling us we get re-parented. An orphaned hook must not keep
  // "waiting" or claim a review that nobody will read.
  const parent = process.ppid;
  const orphaned = () => process.ppid !== parent;

  store.setAgentState({ waiting: true, agent, sessionId, pid: process.pid, since: startedAt.toISOString() });
  const clear = () => {
    if (store.getAgentState().pid === process.pid) store.setAgentState({ waiting: false });
  };
  const onExit = () => {
    clear();
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  process.on('SIGHUP', onExit);

  try {
    for (;;) {
      if (orphaned()) return allow();
      const review = deliver(store, agent);
      if (review) return block(review);

      const signal = store.getSignal();
      if (signal && new Date(signal.at).getTime() >= startedAt.getTime()) return allow();
      if (store.getConfig().mode !== 'on') return allow();
      if (!store.isEditorOpen()) return allow();

      const left = deadline - Date.now();
      if (left <= 0) return allow();
      await sleep(Math.min(POLL_MS, left));
    }
  } finally {
    clear();
  }
}

function runPrompt(store: ReviewStore, agent: Agent, input: Record<string, unknown>): void {
  store.resetContinuations(sessionOf(input));
  const review = deliver(store, agent);
  if (!review) return emit({});
  if (agent === 'copilot') {
    const base = String(input.transformedPrompt ?? input.transformed_prompt ?? input.prompt ?? '');
    return emit({ modifiedTransformedPrompt: `${base}\n\n${review}` });
  }
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: review } });
}

async function main(): Promise<void> {
  const [event, agentArg, ...rest] = process.argv.slice(2);
  const timeoutIdx = rest.indexOf('--timeout');
  const hookTimeoutSec = timeoutIdx >= 0 ? Number(rest[timeoutIdx + 1]) : undefined;
  const stdinMs =
    hookTimeoutSec && Number.isFinite(hookTimeoutSec) && hookTimeoutSec > 0
      ? Math.min(STDIN_TIMEOUT_MS, (hookTimeoutSec * 1000) / 4)
      : STDIN_TIMEOUT_MS;
  const raw = await readStdin(stdinMs);
  // Unknown agents get a no-op rather than a guess: a review delivered in the wrong format is lost.
  if (!AGENTS.includes(agentArg as Agent) || (event !== 'stop' && event !== 'prompt')) return emit({});
  const agent = agentArg as Agent;

  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    // Ignore malformed input; we only need cwd.
  }

  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const root = findRepoRoot(cwd);
  const store = root ? new ReviewStore(root) : undefined;
  if (!store || !store.exists()) return emit({});
  // Review data committed to the repo could come from anyone who can push to it. Only trust a
  // local, git-excluded store, so a cloned repo can't inject a fake review into the agent.
  if (isStoreTracked(store.root)) return emit({});

  if (event === 'stop') await runStop(store, agent, input, hookTimeoutSec);
  else if (event === 'prompt') runPrompt(store, agent, input);
  else emit({});
}

main().catch((err) => {
  // Never break the agent because of a review-hook failure.
  process.stderr.write(`vibe-review hook error: ${err instanceof Error ? err.message : String(err)}\n`);
  emit({});
  process.exit(0);
});
