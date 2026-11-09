import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export type AgentId = 'claude' | 'codex' | 'copilot';

export const AGENTS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  copilot: 'GitHub Copilot CLI',
};

/** Must exceed the review wait timeout; the hook exits on its own ~10s before this. */
export const STOP_HOOK_TIMEOUT_SEC = 3600;
const PROMPT_HOOK_TIMEOUT_SEC = 30;
/** Our runtime scripts, whatever the home directory or path separator (`\\` on Windows, doubled when escaped). */
const OUR_SCRIPT = (name: 'hook' | 'mcp') => new RegExp(`(^|[\\\\/'"\\s])\\.vibe-review[\\\\/]+bin[\\\\/]+${name}\\.js(?=$|[\\s'"])`);
const OUR_HOOK = OUR_SCRIPT('hook');
const OUR_MCP = OUR_SCRIPT('mcp');

export interface SetupContext {
  home: string;
  nodePath: string;
  binDir: string;
}

export interface SetupResult {
  agent: AgentId;
  files: string[];
  notes: string[];
}

/** Quotes a path for the shell the agent runs hook commands in. */
function quote(p: string): string {
  if (/^[\w\/.,:@%+=-]+$/.test(p)) return p;
  if (process.platform === 'win32') return `"${p}"`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function hookCommand(ctx: SetupContext, event: 'stop' | 'prompt', agent: AgentId): string {
  const base = `${quote(ctx.nodePath)} ${quote(path.join(ctx.binDir, 'hook.js'))} ${event} ${agent}`;
  return event === 'stop' ? `${base} --timeout ${STOP_HOOK_TIMEOUT_SEC}` : base;
}

const isPlainObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * File writes are collected first and applied only after every file for an agent was read and
 * validated, so a failure (e.g. one unparseable file) never leaves a half-configured agent.
 */
type Writes = Map<string, string | null>;

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function readJsonFile(file: string, raw: string | undefined): Record<string, any> {
  if (raw === undefined || !raw.trim()) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${file} (${(err as Error).message}). Fix or remove it, then try again; it was not modified.`);
  }
  if (!isPlainObject(doc)) throw new Error(`${file} is not a JSON object; it was not modified.`);
  return doc;
}

/** The container object `doc[key]`, created if missing. Refuses to touch a non-object value. */
function container(file: string, doc: Record<string, any>, key: string): Record<string, any> {
  if (doc[key] === undefined) doc[key] = {};
  if (!isPlainObject(doc[key])) throw new Error(`"${key}" in ${file} is not an object; it was not modified.`);
  return doc[key];
}

function detectIndent(raw: string): string | number {
  return raw.match(/^[ \t]+(?=["}\]])/m)?.[0] ?? 2;
}

/**
 * Applies `mutate` to a JSON file. Nothing is written when the document is semantically
 * unchanged, so uninstalling from an agent we never touched doesn't create or reformat files.
 * Containers that `mutate` creates and leaves empty are dropped; pre-existing ones are kept.
 */
function updateJsonFile(writes: Writes, file: string, mutate: (doc: Record<string, any>) => void): void {
  const raw = readText(file);
  const doc = readJsonFile(file, raw);
  const before = JSON.stringify(doc);
  const keys = new Set(Object.keys(doc));
  mutate(doc);
  for (const k of Object.keys(doc)) {
    if (!keys.has(k) && isPlainObject(doc[k]) && !Object.keys(doc[k]).length) delete doc[k];
  }
  if (JSON.stringify(doc) === before) return;
  const eol = raw?.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify(doc, null, raw ? detectIndent(raw) : 2).replace(/\n/g, eol) + eol;
  writes.set(file, text);
}

/** Writes or deletes files atomically, keeping a one-time backup of what was there before. */
function commit(writes: Writes): void {
  // Preflight: rename would silently replace a read-only file, so honour its permissions
  // ourselves, and check every file before touching any so a failure leaves nothing half-done.
  for (const [file, content] of writes) {
    let target: string;
    try {
      target = fs.realpathSync(file);
    } catch {
      continue;
    }
    if (readText(target) === (content ?? undefined)) continue;
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new Error(`${target} is not writable; fix its permissions and try again. Nothing was changed.`);
    }
  }
  for (const [file, content] of writes) {
    // Write through symlinks (dotfile managers) instead of replacing them with a regular file.
    let target = file;
    try {
      target = fs.realpathSync(file);
    } catch {
      // New file.
    }
    const current = readText(target);
    if (current === (content ?? undefined)) continue;
    const backup = `${target}.vibe-review.bak`;
    // Keep the oldest backup: it holds the user's config from before Vibe Review touched it.
    if (current !== undefined && !fs.existsSync(backup)) fs.writeFileSync(backup, current);
    if (content === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.vibe-review.tmp`;
    let mode: number | undefined;
    try {
      mode = fs.statSync(target).mode;
    } catch {
      // New file.
    }
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    // Rename is atomic, so an agent reading its config concurrently never sees a torn file.
    fs.renameSync(tmp, target);
  }
}

const isOurHandler = (h: unknown) => isPlainObject(h) && typeof h.command === 'string' && OUR_HOOK.test(h.command);
const isOurServer = (s: unknown) =>
  isPlainObject(s) && (Array.isArray(s.args) ? s.args : []).some((a: unknown) => typeof a === 'string' && OUR_MCP.test(a));

/**
 * Claude/Codex style: hooks[Event] = [{ matcher?, hooks: [{ type, command, timeout }] }].
 * Removes only our handlers (a group shared with the user's own handlers keeps theirs) and
 * drops a group or event only when removing ours left it empty.
 */
function setMatcherGroupHook(file: string, hooks: Record<string, any>, event: string, handler: Record<string, unknown> | undefined): void {
  if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
    throw new Error(`hooks.${event} in ${file} is not an array; it was not modified.`);
  }
  const existing: unknown[] = hooks[event] ?? [];
  const groups: unknown[] = [];
  for (const g of existing) {
    if (!isPlainObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurHandler)) {
      groups.push(g);
      continue;
    }
    const kept = g.hooks.filter((h: unknown) => !isOurHandler(h));
    if (kept.length) groups.push({ ...g, hooks: kept });
  }
  if (handler) groups.push({ hooks: [handler] });
  if (groups.length || (hooks[event] !== undefined && existing.length === 0)) hooks[event] = groups;
  else delete hooks[event];
}

function setMcpServer(file: string, doc: Record<string, any>, entry: Record<string, unknown> | undefined): void {
  const created = doc.mcpServers === undefined;
  const servers = container(file, doc, 'mcpServers');
  const current = servers['vibe-review'];
  if (current !== undefined && !isOurServer(current)) {
    // Someone else's server with our name: never overwrite or delete it.
    if (entry) throw new Error(`${file} already has an MCP server named "vibe-review" that isn't ours; rename or remove it first.`);
    return;
  }
  if (entry) servers['vibe-review'] = entry;
  else delete servers['vibe-review'];
  if (created && !Object.keys(servers).length) delete doc.mcpServers;
}

export function resolveNodePath(): string {
  const shell = process.env.SHELL || '/bin/zsh';
  if (process.platform !== 'win32') {
    try {
      const out = execFileSync(shell, ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000 }).trim();
      const line = out.split('\n').pop()?.trim();
      if (line && fs.existsSync(line)) return line;
    } catch {
      // fall through
    }
  }
  return 'node';
}

/** Copies the bundled hook and MCP server to a stable path that survives extension updates. */
export function installRuntime(distDir: string, binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  for (const f of ['hook.js', 'mcp.js']) {
    fs.copyFileSync(path.join(distDir, f), path.join(binDir, f));
  }
}

// ---- Claude Code --------------------------------------------------------------------

function configureClaude(ctx: SetupContext, install: boolean, writes: Writes): SetupResult {
  const settingsFile = path.join(ctx.home, '.claude', 'settings.json');
  updateJsonFile(writes, settingsFile, (settings) => {
    const hooks = container(settingsFile, settings, 'hooks');
    setMatcherGroupHook(settingsFile, hooks, 'Stop', install
      ? { type: 'command', command: hookCommand(ctx, 'stop', 'claude'), timeout: STOP_HOOK_TIMEOUT_SEC }
      : undefined);
    setMatcherGroupHook(settingsFile, hooks, 'UserPromptSubmit', install
      ? { type: 'command', command: hookCommand(ctx, 'prompt', 'claude'), timeout: PROMPT_HOOK_TIMEOUT_SEC }
      : undefined);
  });

  // User-scoped MCP servers live in ~/.claude.json.
  const stateFile = path.join(ctx.home, '.claude.json');
  updateJsonFile(writes, stateFile, (state) =>
    setMcpServer(stateFile, state, install
      ? { type: 'stdio', command: ctx.nodePath, args: [path.join(ctx.binDir, 'mcp.js')], env: {} }
      : undefined),
  );

  return {
    agent: 'claude',
    files: [settingsFile, stateFile],
    notes: install ? ['Restart running Claude Code sessions to load the hooks and MCP server.'] : [],
  };
}

// ---- Codex CLI ----------------------------------------------------------------------

const TOML_BEGIN = '# >>> vibe-review >>>';
const TOML_END = '# <<< vibe-review <<<';
/** Added to the begin marker when we had to end the user's last line, so removal can undo it. */
const TOML_ADDED_EOL = ' (added final newline)';

const TOML_KEY = `(?:vibe-review|"vibe-review"|'vibe-review')`;

/** True if the TOML (outside our block) configures an MCP server called vibe-review. */
function tomlDefinesServer(toml: string): boolean {
  let table = '';
  for (const line of toml.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*([^\]]*?)\s*\]/);
    if (header) {
      const name = header[1].replace(/\s*\.\s*/g, '.');
      if (new RegExp(`^mcp_servers\\.${TOML_KEY}(\\.|$)`).test(name)) return true;
      table = name;
      continue;
    }
    if (table === '' && new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${TOML_KEY}\\s*[.=]`).test(line)) return true;
    if (table === 'mcp_servers' && new RegExp(`^\\s*${TOML_KEY}\\s*[.=]`).test(line)) return true;
  }
  return false;
}

/**
 * Removes our managed block(s) exactly as `addTomlBlock` added them. Duplicates (e.g. from an
 * older buggy install) all go; each BEGIN pairs with the nearest END after it. A stray marker
 * line left over is dropped only if no vibe-review server remains outside the blocks;
 * otherwise we can't tell what's ours, so we refuse rather than corrupt the file.
 */
function removeTomlBlock(file: string, toml: string): string {
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  const isBegin = (l: string) => /^# >>> vibe-review >>>/.test(l);
  const isEnd = (l: string) => /^# <<< vibe-review <<<\r?$/.test(l);
  const hadFinalEol = toml.endsWith('\n');
  const lines = (hadFinalEol ? toml.slice(0, -1) : toml).split('\n').map((l) => l.replace(/\r$/, ''));
  if (!lines.some((l) => isBegin(l) || isEnd(l))) return toml;

  const drop = new Set<number>();
  let addedEol = false;
  for (let i = 0; i < lines.length; i++) {
    if (!isEnd(lines[i])) continue;
    let j = i - 1;
    while (j >= 0 && !isBegin(lines[j]) && !isEnd(lines[j])) j--;
    if (j < 0 || !isBegin(lines[j])) continue;
    if (lines[j].includes(TOML_ADDED_EOL)) addedEol = true;
    for (let k = j; k <= i; k++) drop.add(k);
    // Drop the blank line we put before the block.
    if (j > 0 && lines[j - 1] === '' && !drop.has(j - 1)) drop.add(j - 1);
  }
  const strays = lines.map((l, i) => (!drop.has(i) && (isBegin(l) || isEnd(l)) ? i : -1)).filter((i) => i >= 0);
  const keptWithoutStrays = lines.filter((_, i) => !drop.has(i) && !strays.includes(i));
  if (strays.length && tomlDefinesServer(keptWithoutStrays.join('\n'))) {
    throw new Error(`The Vibe Review block in ${file} is damaged (markers "${TOML_BEGIN}" / "${TOML_END}"). Remove it by hand; the file was not modified.`);
  }
  for (const i of strays) drop.add(i);

  const kept = lines.filter((_, i) => !drop.has(i));
  if (!kept.length) return '';
  const removedTail = drop.has(lines.length - 1);
  const finalEol = removedTail ? !addedEol : hadFinalEol;
  return kept.join(eol) + (finalEol ? eol : '');
}

function addTomlBlock(toml: string, lines: string[]): string {
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  if (!toml) return [TOML_BEGIN, ...lines, TOML_END].join(eol) + eol;
  const addEol = !toml.endsWith('\n');
  const block = [TOML_BEGIN + (addEol ? TOML_ADDED_EOL : ''), ...lines, TOML_END].join(eol);
  return `${toml}${addEol ? eol : ''}${eol}${block}${eol}`;
}

function configureCodex(ctx: SetupContext, install: boolean, writes: Writes): SetupResult {
  const dir = path.join(ctx.home, '.codex');
  const hooksFile = path.join(dir, 'hooks.json');
  updateJsonFile(writes, hooksFile, (hooksDoc) => {
    const hooks = container(hooksFile, hooksDoc, 'hooks');
    setMatcherGroupHook(hooksFile, hooks, 'Stop', install
      ? {
          type: 'command',
          command: hookCommand(ctx, 'stop', 'codex'),
          timeout: STOP_HOOK_TIMEOUT_SEC,
          statusMessage: 'Waiting for your review in VS Code (Vibe Review)',
        }
      : undefined);
    setMatcherGroupHook(hooksFile, hooks, 'UserPromptSubmit', install
      ? { type: 'command', command: hookCommand(ctx, 'prompt', 'codex'), timeout: PROMPT_HOOK_TIMEOUT_SEC, additionalContextLimit: 0 }
      : undefined);
  });

  const configFile = path.join(dir, 'config.toml');
  const original = readText(configFile);
  let toml = removeTomlBlock(configFile, original ?? '');
  if (install) {
    if (tomlDefinesServer(toml)) {
      throw new Error(`${configFile} already defines an MCP server named vibe-review outside the managed block; remove it first.`);
    }
    toml = addTomlBlock(toml, [
      '[mcp_servers.vibe-review]',
      `command = ${JSON.stringify(ctx.nodePath)}`,
      `args = [${JSON.stringify(path.join(ctx.binDir, 'mcp.js'))}]`,
      'tool_timeout_sec = 60',
    ]);
  }
  if (toml !== (original ?? '')) writes.set(configFile, toml);

  return {
    agent: 'codex',
    files: [hooksFile, configFile],
    notes: install ? ['In Codex, run /hooks and trust the two vibe-review hooks (Codex skips untrusted hooks).'] : [],
  };
}

// ---- GitHub Copilot CLI -------------------------------------------------------------

function configureCopilot(ctx: SetupContext, install: boolean, writes: Writes): SetupResult {
  const copilotHome = process.env.COPILOT_HOME || path.join(ctx.home, '.copilot');
  const hooksFile = path.join(copilotHome, 'hooks', 'vibe-review.json');
  if (install) {
    const doc = {
      version: 1,
      hooks: {
        agentStop: [{ type: 'command', command: hookCommand(ctx, 'stop', 'copilot'), timeoutSec: STOP_HOOK_TIMEOUT_SEC }],
        userPromptTransformed: [{ type: 'command', command: hookCommand(ctx, 'prompt', 'copilot'), timeoutSec: PROMPT_HOOK_TIMEOUT_SEC }],
      },
    };
    writes.set(hooksFile, JSON.stringify(doc, null, 2) + '\n');
  } else if (readText(hooksFile) !== undefined) {
    writes.set(hooksFile, null);
  }

  const mcpFile = path.join(copilotHome, 'mcp-config.json');
  updateJsonFile(writes, mcpFile, (mcp) =>
    setMcpServer(mcpFile, mcp, install
      ? { type: 'local', command: ctx.nodePath, args: [path.join(ctx.binDir, 'mcp.js')], tools: ['*'] }
      : undefined),
  );

  return {
    agent: 'copilot',
    files: [hooksFile, mcpFile],
    notes: install ? ['Restart running Copilot CLI sessions to load the hooks and MCP server.'] : [],
  };
}

const CONFIGURERS: Record<AgentId, (ctx: SetupContext, install: boolean, writes: Writes) => SetupResult> = {
  claude: configureClaude,
  codex: configureCodex,
  copilot: configureCopilot,
};

export function configureAgent(agent: AgentId, ctx: SetupContext, install = true): SetupResult {
  const writes: Writes = new Map();
  const result = CONFIGURERS[agent](ctx, install, writes);
  commit(writes);
  return result;
}

/** Paths of files `configureAgent` would modify, for showing the user before confirming. */
export function filesFor(agent: AgentId, home: string): string[] {
  const copilotHome = process.env.COPILOT_HOME || path.join(home, '.copilot');
  switch (agent) {
    case 'claude':
      return [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude.json')];
    case 'codex':
      return [path.join(home, '.codex', 'hooks.json'), path.join(home, '.codex', 'config.toml')];
    case 'copilot':
      return [path.join(copilotHome, 'hooks', 'vibe-review.json'), path.join(copilotHome, 'mcp-config.json')];
  }
}

export const runtimeDir = (home: string) => path.join(home, '.vibe-review');

/** Whether any Vibe Review hook or MCP entry is present in this agent's config. */
export function isInstalled(agent: AgentId, home: string): boolean {
  return filesFor(agent, home).some((file) => {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return OUR_HOOK.test(raw) || OUR_MCP.test(raw) || raw.includes(TOML_BEGIN) || file.endsWith(`${path.sep}vibe-review.json`);
    } catch {
      return false;
    }
  });
}

export interface UninstallResult {
  removedFrom: AgentId[];
  errors: string[];
  runtimeRemoved: boolean;
}

/**
 * Removes Vibe Review from every agent, then deletes `~/.vibe-review`. The runtime is kept if
 * any agent couldn't be cleaned, since its config would otherwise point at a missing script.
 */
export function uninstallAll(home: string): UninstallResult {
  const ctx: SetupContext = { home, nodePath: 'node', binDir: path.join(runtimeDir(home), 'bin') };
  const result: UninstallResult = { removedFrom: [], errors: [], runtimeRemoved: false };
  for (const agent of Object.keys(AGENTS) as AgentId[]) {
    if (!isInstalled(agent, home)) continue;
    try {
      configureAgent(agent, ctx, false);
      result.removedFrom.push(agent);
    } catch (err) {
      result.errors.push(`${AGENTS[agent]}: ${(err as Error).message}`);
    }
  }
  if (!result.errors.length) {
    // Only remove what we installed. If the home folder is itself a git repo, ~/.vibe-review
    // also holds that repo's review data, which must survive.
    fs.rmSync(path.join(runtimeDir(home), 'bin'), { recursive: true, force: true });
    try {
      fs.rmdirSync(runtimeDir(home));
    } catch {
      // Not empty or already gone.
    }
    result.runtimeRemoved = true;
  }
  return result;
}
