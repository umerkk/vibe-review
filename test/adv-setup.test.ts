/**
 * Adversarial tests for agent setup / uninstall (src/shared/setup.ts) and the
 * `.git/info/exclude` helpers (src/shared/git.ts). Every test runs against a throwaway
 * home directory; the real `~` is never touched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configureAgent, isInstalled, uninstallAll, type AgentId, type SetupContext } from '../src/shared/setup';
import { ensureLocalExclude, removeLocalExclude } from '../src/shared/git';

const AGENT_IDS: AgentId[] = ['claude', 'codex', 'copilot'];
const SCRATCH = path.join(__dirname, '.adv-setup-tmp');
const ENV_KEYS = ['HOME', 'USERPROFILE', 'COPILOT_HOME'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const BEGIN = '# >>> vibe-review >>>';
const END = '# <<< vibe-review <<<';

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  fs.mkdirSync(SCRATCH, { recursive: true });
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const f of walk(SCRATCH)) if (f.type === 'file') fs.chmodSync(f.abs, 0o644);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// ---- helpers ------------------------------------------------------------------------

function mkHome(): string {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.COPILOT_HOME = path.join(home, '.copilot');
  return home;
}

function files(home: string) {
  const cp = process.env.COPILOT_HOME!;
  return {
    settings: path.join(home, '.claude', 'settings.json'),
    claudeJson: path.join(home, '.claude.json'),
    codexHooks: path.join(home, '.codex', 'hooks.json'),
    codexToml: path.join(home, '.codex', 'config.toml'),
    cpHooks: path.join(cp, 'hooks', 'vibe-review.json'),
    cpMcp: path.join(cp, 'mcp-config.json'),
    bin: path.join(home, '.vibe-review', 'bin'),
  };
}

function ctxFor(home: string, over: Partial<SetupContext> = {}): SetupContext {
  return { home, nodePath: '/usr/local/bin/node', binDir: path.join(home, '.vibe-review', 'bin'), ...over };
}

function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (f: string) => fs.readFileSync(f, 'utf8');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

interface Entry { rel: string; abs: string; type: 'file' | 'dir' | 'link'; content: string }

function walk(dir: string, base = dir): Entry[] {
  if (!fs.existsSync(dir)) return [];
  const out: Entry[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (e.isSymbolicLink()) out.push({ rel, abs, type: 'link', content: fs.readlinkSync(abs) });
    else if (e.isDirectory()) out.push({ rel, abs, type: 'dir', content: '' }, ...walk(abs, base));
    else out.push({ rel, abs, type: 'file', content: fs.readFileSync(abs, 'utf8') });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const snapshot = (dir: string) => walk(dir).map(({ rel, type, content }) => ({ rel, type, content }));

function installRuntimeStub(home: string): string {
  const bin = files(home).bin;
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'hook.js'), '');
  fs.writeFileSync(path.join(bin, 'mcp.js'), '');
  return bin;
}

/**
 * Minimal TOML validator for the subset found in Codex configs: table headers, `key = value`
 * with basic/literal strings, string arrays, integers, booleans and single-line inline tables.
 * Rejects duplicate tables, duplicate keys and keys that redefine a table.
 */
function parseToml(src: string): Map<string, Record<string, unknown>> {
  const tables = new Map<string, Record<string, unknown>>([['', {}]]);
  let cur = '';
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const header = /^\[\s*([^[\]]+?)\s*\]$/.exec(line);
    if (header) {
      const name = normKey(header[1]);
      if (tables.has(name)) throw new Error(`line ${i + 1}: duplicate table [${name}]`);
      tables.set(name, {});
      cur = name;
      return;
    }
    const kv = /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`line ${i + 1}: not valid TOML: ${JSON.stringify(raw)}`);
    const key = normKey(kv[1]);
    const t = tables.get(cur)!;
    if (key in t) throw new Error(`line ${i + 1}: duplicate key ${key}`);
    t[key] = parseValue(kv[2].trim(), i + 1);
  });
  for (const [name, t] of tables) {
    for (const key of Object.keys(t)) {
      const segs = key.split('.');
      for (let n = 1; n <= segs.length; n++) {
        const full = [name, ...segs.slice(0, n)].filter(Boolean).join('.');
        if (tables.has(full)) throw new Error(`key ${key} in [${name}] redefines table [${full}]`);
      }
    }
  }
  return tables;
}

function normKey(k: string): string {
  return (k.match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? []).map((s) => s.replace(/^["']|["']$/g, '')).join('.');
}

function parseValue(v: string, line: number): unknown {
  if (/^"/.test(v) || /^\[/.test(v)) {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(v)) throw new Error(`line ${line}: raw control character in string`);
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`line ${line}: bad string/array value ${v}`);
    }
  }
  if (/^'[^']*'$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^\{.*\}$/.test(v)) return v;
  throw new Error(`line ${line}: unsupported value ${v}`);
}

/** Runs a hook command the way agents do (through a shell) against a stub hook.js that echoes argv. */
function runViaShell(shell: string, command: string): string[] {
  return JSON.parse(execFileSync(shell, ['-c', command], { encoding: 'utf8', timeout: 10_000 }));
}

const ECHO_HOOK = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));';

/** Asserts `fn` either throws leaving `file` byte-identical, or succeeds while honouring `ok`. */
function failsSafelyOr(file: string, fn: () => void, ok: () => void): void {
  const before = fs.readFileSync(file);
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error);
  }
  if (threw) assert.deepEqual(fs.readFileSync(file), before, `${file} was modified despite a parse failure`);
  else ok();
}

function assertThrowsUnchanged(file: string, fn: () => void, msg: string): void {
  const before = fs.readFileSync(file);
  assert.throws(fn, Error, msg);
  assert.deepEqual(fs.readFileSync(file), before, `${file} must not be modified`);
}

const userClaudeSettings = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test:*)'], deny: [] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff', timeout: 5 }] }],
  },
  statusLine: { type: 'command', command: 'echo hi' },
  zzzUnknownKey: { nested: [1, 2, { deep: true }] },
};

// ---- byte-for-byte preservation ------------------------------------------------------

test('claude settings.json: configure → uninstall restores user file byte-for-byte; other hooks and key order kept', () => {
  const home = mkHome();
  const f = files(home);
  const original = json(userClaudeSettings);
  put(f.settings, original);
  configureAgent('claude', ctxFor(home));
  const mid = JSON.parse(read(f.settings));
  assert.deepEqual(Object.keys(mid), Object.keys(userClaudeSettings), 'top-level key order must be preserved');
  assert.deepEqual(mid.hooks.PreToolUse, userClaudeSettings.hooks.PreToolUse);
  assert.deepEqual(mid.hooks.Stop[0], userClaudeSettings.hooks.Stop[0]);
  assert.equal(mid.hooks.Stop.length, 2);
  configureAgent('claude', ctxFor(home), false);
  assert.equal(read(f.settings), original);
});

test('~/.claude.json (large, with projects state): configure → uninstall is byte-for-byte; project-scoped servers untouched', () => {
  const home = mkHome();
  const f = files(home);
  const projects: Record<string, unknown> = {};
  for (let i = 0; i < 3000; i++) {
    projects[`/Users/me/code/proj-${i} ünïcødé`] = {
      allowedTools: [],
      history: [{ display: `prompt ${i} with "quotes" and \\ and \u2028 line sep`, pastedContents: {} }],
      mcpServers: i === 7 ? { 'vibe-review': { command: 'node', args: ['/x/mcp.js'] } } : {},
      lastCost: 0.123456789,
      lastSessionId: `sess-${i}`,
    };
  }
  const state = { numStartups: 412, userID: 'abc', mcpServers: { github: { type: 'http', url: 'https://x' } }, projects, oauthAccount: { emailAddress: 'a@b.c' } };
  const original = json(state);
  assert.ok(original.length > 500_000);
  put(f.claudeJson, original);
  configureAgent('claude', ctxFor(home));
  const mid = JSON.parse(read(f.claudeJson));
  assert.ok(mid.mcpServers['vibe-review']);
  assert.ok(mid.mcpServers.github);
  configureAgent('claude', ctxFor(home), false);
  assert.equal(read(f.claudeJson), original);
});

test('[BUG] claude settings.json with tab indentation: configure → uninstall preserves the user\'s formatting', () => {
  const home = mkHome();
  const f = files(home);
  const original = JSON.stringify(userClaudeSettings, null, '\t') + '\n';
  put(f.settings, original);
  configureAgent('claude', ctxFor(home));
  configureAgent('claude', ctxFor(home), false);
  assert.equal(read(f.settings), original);
});

test('[BUG] empty containers the user already had (hooks: {}, mcpServers: {}) survive configure → uninstall', () => {
  const home = mkHome();
  const f = files(home);
  const s = json({ hooks: {}, model: 'x' });
  const c = json({ mcpServers: {}, projects: {} });
  put(f.settings, s);
  put(f.claudeJson, c);
  configureAgent('claude', ctxFor(home));
  configureAgent('claude', ctxFor(home), false);
  assert.equal(read(f.settings), s);
  assert.equal(read(f.claudeJson), c);
});

test('codex hooks.json and copilot mcp-config.json: other entries preserved byte-for-byte across configure → uninstall', () => {
  const home = mkHome();
  const f = files(home);
  const codexHooks = json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }], PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'log' }] }] }, extra: 1 });
  const cpMcp = json({ mcpServers: { playwright: { type: 'local', command: 'npx', args: ['@playwright/mcp'], tools: ['*'] } }, other: true });
  put(f.codexHooks, codexHooks);
  put(f.cpMcp, cpMcp);
  configureAgent('codex', ctxFor(home));
  configureAgent('copilot', ctxFor(home));
  configureAgent('codex', ctxFor(home), false);
  configureAgent('copilot', ctxFor(home), false);
  assert.equal(read(f.codexHooks), codexHooks);
  assert.equal(read(f.cpMcp), cpMcp);
});

test('[BUG] user Stop hook with a similar-looking command (…/my-vibe-review/bin/hook.js) is never treated as ours', () => {
  const home = mkHome();
  const f = files(home);
  const userGroup = { hooks: [{ type: 'command', command: 'node /Users/me/tools/my-vibe-review/bin/hook.js stop' }] };
  const original = json({ hooks: { Stop: [userGroup] } });
  put(f.settings, original);
  configureAgent('claude', ctxFor(home));
  const mid = JSON.parse(read(f.settings));
  assert.deepEqual(mid.hooks.Stop[0], userGroup, 'configure removed the user\'s own hook');
  configureAgent('claude', ctxFor(home), false);
  assert.equal(read(f.settings), original);
});

test('[BUG] uninstall only removes our handler from a matcher group the user shares with it', () => {
  const home = mkHome();
  const f = files(home);
  configureAgent('claude', ctxFor(home));
  const doc = JSON.parse(read(f.settings));
  const ours = doc.hooks.Stop[0].hooks[0];
  const userHandler = { type: 'command', command: 'say done' };
  doc.hooks.Stop = [{ hooks: [userHandler, ours] }];
  put(f.settings, json(doc));
  configureAgent('claude', ctxFor(home), false);
  const after = JSON.parse(read(f.settings));
  assert.deepEqual(after.hooks?.Stop, [{ hooks: [userHandler] }]);
});

test('[BUG] uninstall does not delete a user-defined "vibe-review" MCP server that is not ours', () => {
  const home = mkHome();
  const f = files(home);
  installRuntimeStub(home);
  const foreign = { command: 'docker', args: ['run', '-i', 'acme/vibe-review'] };
  const claudeJson = json({ mcpServers: { 'vibe-review': foreign } });
  const cpMcp = json({ mcpServers: { 'vibe-review': { type: 'local', ...foreign, tools: ['*'] } } });
  put(f.claudeJson, claudeJson);
  put(f.cpMcp, cpMcp);
  const result = uninstallAll(home);
  assert.deepEqual(result.errors, []);
  assert.equal(read(f.claudeJson), claudeJson);
  assert.equal(read(f.cpMcp), cpMcp);
});

// ---- idempotency & backups -----------------------------------------------------------

test('configure twice: no duplicate entries anywhere, and the .bak still holds the original', () => {
  const home = mkHome();
  const f = files(home);
  const original = json(userClaudeSettings);
  put(f.settings, original);
  put(f.codexToml, 'model = "o3"\n');
  for (let i = 0; i < 3; i++) for (const a of AGENT_IDS) configureAgent(a, ctxFor(home));
  const s = JSON.parse(read(f.settings));
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  const ch = JSON.parse(read(f.codexHooks));
  assert.equal(ch.hooks.Stop.length, 1);
  assert.equal(ch.hooks.UserPromptSubmit.length, 1);
  const toml = read(f.codexToml);
  assert.equal(toml.split(BEGIN).length - 1, 1);
  parseToml(toml);
  assert.equal(read(`${f.settings}.vibe-review.bak`), original);
  assert.equal(read(`${f.codexToml}.vibe-review.bak`), 'model = "o3"\n');
});

test('[BUG] re-running setup after node moved (different nodePath) does not overwrite the original backup', () => {
  const home = mkHome();
  const f = files(home);
  const original = json(userClaudeSettings);
  put(f.settings, original);
  put(f.codexToml, 'model = "o3"\n');
  for (const a of AGENT_IDS) configureAgent(a, ctxFor(home, { nodePath: '/opt/node18/bin/node' }));
  for (const a of AGENT_IDS) configureAgent(a, ctxFor(home, { nodePath: '/opt/node22/bin/node' }));
  assert.match(read(f.settings), /node22/);
  assert.doesNotMatch(read(f.settings), /node18/);
  assert.equal(read(`${f.settings}.vibe-review.bak`), original, 'the pre-Vibe-Review backup was lost');
  assert.equal(read(`${f.codexToml}.vibe-review.bak`), 'model = "o3"\n', 'the pre-Vibe-Review backup was lost');
});

test('uninstallAll on a pristine home creates no files or directories and reports nothing removed', () => {
  const home = mkHome();
  const before = snapshot(home);
  const result = uninstallAll(home);
  assert.deepEqual(result, { removedFrom: [], errors: [], runtimeRemoved: true });
  assert.deepEqual(snapshot(home), before);
  assert.equal(fs.existsSync(process.env.COPILOT_HOME!), false);
});

test('[BUG] uninstallAll on a home with unrelated agent config touches nothing (no rewrite, no .bak)', () => {
  const home = mkHome();
  const f = files(home);
  put(f.settings, '{"model":"x"}');
  put(f.claudeJson, '{ "projects": {} }');
  put(f.codexHooks, '{"hooks":{}}');
  put(f.codexToml, 'model = "o3"\n\n\n');
  put(f.cpMcp, '{"mcpServers":{"a":{}}}');
  const before = snapshot(home);
  uninstallAll(home);
  for (const a of AGENT_IDS) configureAgent(a, ctxFor(home), false);
  assert.deepEqual(snapshot(home), before);
});

test('uninstallAll twice: second run is a no-op on disk', () => {
  const home = mkHome();
  put(files(home).settings, json(userClaudeSettings));
  installRuntimeStub(home);
  for (const a of AGENT_IDS) configureAgent(a, ctxFor(home));
  const first = uninstallAll(home);
  assert.deepEqual(first, { removedFrom: AGENT_IDS, errors: [], runtimeRemoved: true });
  const before = snapshot(home);
  const second = uninstallAll(home);
  assert.deepEqual(second, { removedFrom: [], errors: [], runtimeRemoved: true });
  assert.deepEqual(snapshot(home), before);
  for (const a of AGENT_IDS) assert.equal(isInstalled(a, home), false);
});

test('COPILOT_HOME override: configure writes there and uninstallAll cleans it', () => {
  const home = mkHome();
  const alt = path.join(home, 'elsewhere', 'copilot');
  process.env.COPILOT_HOME = alt;
  installRuntimeStub(home);
  configureAgent('copilot', ctxFor(home));
  assert.ok(fs.existsSync(path.join(alt, 'hooks', 'vibe-review.json')));
  assert.equal(fs.existsSync(path.join(home, '.copilot')), false);
  assert.equal(isInstalled('copilot', home), true);
  const r = uninstallAll(home);
  assert.deepEqual(r.removedFrom, ['copilot']);
  assert.equal(fs.existsSync(path.join(alt, 'hooks', 'vibe-review.json')), false);
  assert.doesNotMatch(read(path.join(alt, 'mcp-config.json')), /vibe-review/);
});

// ---- malformed files -----------------------------------------------------------------

test('invalid JSON in any agent JSON file: configure throws and never rewrites the file', () => {
  const home = mkHome();
  const f = files(home);
  const cases: Array<[AgentId, string]> = [['claude', f.settings], ['claude', f.claudeJson], ['codex', f.codexHooks], ['copilot', f.cpMcp]];
  for (const [agent, file] of cases) {
    for (const p of Object.values(f)) if (p !== f.bin) fs.rmSync(p, { force: true });
    put(file, '{"model": "x", "hooks": {');
    assertThrowsUnchanged(file, () => configureAgent(agent, ctxFor(home)), `${agent} accepted broken ${file}`);
    assert.equal(fs.existsSync(`${file}.vibe-review.bak`), false);
  }
});

test('JSONC (comments, trailing commas): never loses the comments', () => {
  const home = mkHome();
  const f = files(home);
  const jsonc = '{\n  // my model\n  "model": "x",\n  "hooks": {},\n}\n';
  put(f.settings, jsonc);
  failsSafelyOr(f.settings, () => configureAgent('claude', ctxFor(home)), () => {
    assert.match(read(f.settings), /\/\/ my model/);
    assert.match(read(f.settings), /vibe-review\/bin\/hook\.js/);
  });
});

test('UTF-8 BOM: either refused without writing, or configured with user keys intact', () => {
  const home = mkHome();
  const f = files(home);
  put(f.settings, '\uFEFF' + json({ model: 'x' }));
  failsSafelyOr(f.settings, () => configureAgent('claude', ctxFor(home)), () => {
    const doc = JSON.parse(read(f.settings).replace(/^\uFEFF/, ''));
    assert.equal(doc.model, 'x');
    assert.equal(doc.hooks.Stop.length, 1);
  });
});

test('empty and whitespace-only files are treated as {} and configured', () => {
  const home = mkHome();
  const f = files(home);
  put(f.settings, '');
  put(f.claudeJson, '  \n\n');
  configureAgent('claude', ctxFor(home));
  assert.equal(JSON.parse(read(f.settings)).hooks.Stop.length, 1);
  assert.ok(JSON.parse(read(f.claudeJson)).mcpServers['vibe-review']);
});

test('[BUG] top-level JSON array: configure must fail loudly, not report success while installing nothing', () => {
  const home = mkHome();
  const f = files(home);
  put(f.settings, '[1, 2]\n');
  assertThrowsUnchanged(f.settings, () => configureAgent('claude', ctxFor(home)), 'array top-level silently accepted');
});

test('top-level JSON null / string: configure throws and leaves the file alone', () => {
  for (const body of ['null\n', '"str"\n', '42\n']) {
    const home = mkHome();
    const f = files(home);
    put(f.settings, body);
    assertThrowsUnchanged(f.settings, () => configureAgent('claude', ctxFor(home)), `top-level ${body.trim()} accepted`);
  }
});

test('`hooks` of the wrong type (string, object-valued event): throws and leaves the file alone', () => {
  for (const hooks of ['oops', { Stop: { not: 'an array' } }, { Stop: 'x' }]) {
    const home = mkHome();
    const f = files(home);
    put(f.settings, json({ model: 'x', hooks }));
    assertThrowsUnchanged(f.settings, () => configureAgent('claude', ctxFor(home)), `hooks=${JSON.stringify(hooks)} accepted`);
  }
});

test('[BUG] `hooks` / `mcpServers` that are arrays: configure must fail loudly, not silently install nothing', () => {
  const home = mkHome();
  const f = files(home);
  put(f.settings, json({ hooks: [] }));
  assertThrowsUnchanged(f.settings, () => configureAgent('claude', ctxFor(home)), 'hooks: [] silently accepted');
  const home2 = mkHome();
  const f2 = files(home2);
  put(f2.cpMcp, json({ mcpServers: [] }));
  assertThrowsUnchanged(f2.cpMcp, () => configureAgent('copilot', ctxFor(home2)), 'mcpServers: [] silently accepted');
});

test('[BUG] claude configure is all-or-nothing: unparseable ~/.claude.json leaves settings.json untouched', () => {
  const home = mkHome();
  const f = files(home);
  const s = json({ model: 'x' });
  put(f.settings, s);
  put(f.claudeJson, '{"projects": {');
  assert.throws(() => configureAgent('claude', ctxFor(home)));
  assert.equal(read(f.settings), s, 'hooks were installed even though setup failed');
});

// ---- Codex TOML ----------------------------------------------------------------------

test('[BUG] codex config.toml: configure → uninstall restores the file byte-for-byte (LF, trailing newline)', () => {
  const home = mkHome();
  const f = files(home);
  const original = 'model = "o3"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n';
  put(f.codexToml, original);
  configureAgent('codex', ctxFor(home));
  parseToml(read(f.codexToml));
  configureAgent('codex', ctxFor(home), false);
  assert.equal(read(f.codexToml), original);
});

test('[BUG] codex config.toml without trailing newline: configure → uninstall restores it byte-for-byte', () => {
  const home = mkHome();
  const f = files(home);
  const original = 'model = "o3"';
  put(f.codexToml, original);
  configureAgent('codex', ctxFor(home));
  parseToml(read(f.codexToml));
  configureAgent('codex', ctxFor(home), false);
  assert.equal(read(f.codexToml), original);
});

test('[BUG] codex config.toml with CRLF: valid TOML after configure, byte-for-byte after uninstall', () => {
  const home = mkHome();
  const f = files(home);
  const original = 'model = "o3"\r\n\r\n[profiles.fast]\r\nmodel = "o4-mini"\r\n';
  put(f.codexToml, original);
  configureAgent('codex', ctxFor(home));
  const t = parseToml(read(f.codexToml));
  assert.equal(t.get('profiles.fast')!.model, 'o4-mini');
  assert.ok(t.get('mcp_servers.vibe-review'));
  configureAgent('codex', ctxFor(home), false);
  assert.equal(read(f.codexToml), original);
});

test('codex: a user table directly after our block survives reconfigure and uninstall', () => {
  const home = mkHome();
  const f = files(home);
  put(f.codexToml, 'model = "o3"\n');
  configureAgent('codex', ctxFor(home));
  fs.appendFileSync(f.codexToml, '[profiles.fast]\nmodel = "o4-mini"\n');
  configureAgent('codex', ctxFor(home, { nodePath: '/opt/other/node' }));
  let t = parseToml(read(f.codexToml));
  assert.equal(t.get('profiles.fast')!.model, 'o4-mini');
  assert.equal(t.get('mcp_servers.vibe-review')!.command, '/opt/other/node');
  configureAgent('codex', ctxFor(home), false);
  t = parseToml(read(f.codexToml));
  assert.equal(t.get('profiles.fast')!.model, 'o4-mini');
  assert.equal(t.get('')!.model, 'o3');
  assert.equal(t.has('mcp_servers.vibe-review'), false);
});

test('codex: [mcp_servers.vibe-review] defined outside our markers → throws, config.toml unchanged', () => {
  const home = mkHome();
  const f = files(home);
  put(f.codexToml, '[mcp_servers.vibe-review]\ncommand = "mine"\n');
  assertThrowsUnchanged(f.codexToml, () => configureAgent('codex', ctxFor(home)), 'conflict not detected');
});

test('[BUG] codex: conflicting table written in other valid TOML spellings is detected (no duplicate table emitted)', () => {
  const spellings = [
    "[mcp_servers.'vibe-review']\ncommand = \"mine\"\n",
    '[ mcp_servers . "vibe-review" ]\ncommand = "mine"\n',
    '[mcp_servers]\nvibe-review = { command = "mine" }\n',
    '[mcp_servers]\nvibe-review.command = "mine"\n',
  ];
  for (const original of spellings) {
    const home = mkHome();
    const f = files(home);
    put(f.codexToml, original);
    parseToml(original);
    assertThrowsUnchanged(f.codexToml, () => configureAgent('codex', ctxFor(home)), `not detected: ${JSON.stringify(original)}`);
  }
});

test('[BUG] codex configure is all-or-nothing: a TOML conflict leaves hooks.json untouched', () => {
  const home = mkHome();
  const f = files(home);
  put(f.codexToml, '[mcp_servers.vibe-review]\ncommand = "mine"\n');
  assert.throws(() => configureAgent('codex', ctxFor(home)));
  assert.equal(fs.existsSync(f.codexHooks), false, 'hooks.json was written even though setup failed');
});

test('codex: duplicated managed blocks collapse to one; user content between them is kept', () => {
  const home = mkHome();
  const f = files(home);
  const block = `${BEGIN}\n[mcp_servers.vibe-review]\ncommand = "old"\nargs = ["/old/mcp.js"]\n${END}`;
  put(f.codexToml, `model = "o3"\n\n${block}\n\n[profiles.mid]\nmodel = "x"\n\n${block}\n`);
  configureAgent('codex', ctxFor(home));
  const toml = read(f.codexToml);
  assert.equal(toml.split(BEGIN).length - 1, 1);
  const t = parseToml(toml);
  assert.equal(t.get('profiles.mid')!.model, 'x');
  assert.equal(t.get('mcp_servers.vibe-review')!.command, '/usr/local/bin/node');
});

test('codex: missing end marker — configure refuses and leaves the file intact', () => {
  const home = mkHome();
  const f = files(home);
  const original = `model = "o3"\n\n${BEGIN}\n[mcp_servers.vibe-review]\ncommand = "old"\n\n[profiles.fast]\nmodel = "o4-mini"\n`;
  put(f.codexToml, original);
  assertThrowsUnchanged(f.codexToml, () => configureAgent('codex', ctxFor(home)), 'configure ran on a half-marked file');
});

test('[BUG] codex: missing end marker — uninstallAll keeps user content and does not claim success while leaving a dangling server', () => {
  const home = mkHome();
  const f = files(home);
  installRuntimeStub(home);
  put(f.codexToml, `model = "o3"\n\n${BEGIN}\n[mcp_servers.vibe-review]\ncommand = "node"\nargs = ["${f.bin}/mcp.js"]\n\n[profiles.fast]\nmodel = "o4-mini"\n`);
  const r = uninstallAll(home);
  const t = parseToml(read(f.codexToml));
  assert.equal(t.get('')!.model, 'o3');
  assert.equal(t.get('profiles.fast')!.model, 'o4-mini');
  const dangling = t.has('mcp_servers.vibe-review');
  if (dangling) {
    assert.ok(r.errors.length > 0, 'reported success but Codex still points at the deleted runtime');
    assert.equal(r.runtimeRemoved, false);
  }
});

test('[BUG] codex: orphan begin marker followed later by a full block — user tables in between are not deleted', () => {
  const home = mkHome();
  const f = files(home);
  installRuntimeStub(home);
  put(f.codexToml, `model = "o3"\n${BEGIN}\n\n[profiles.precious]\nmodel = "keep-me"\n\n${BEGIN}\n[mcp_servers.vibe-review]\ncommand = "node"\n${END}\n`);
  configureAgent('codex', ctxFor(home), false);
  assert.match(read(f.codexToml), /\[profiles\.precious\]\nmodel = "keep-me"/);
});

// ---- paths & escaping ----------------------------------------------------------------

function weirdHomeSetup(dirName: string) {
  const home = mkHome();
  const base = path.join(home, dirName);
  const binDir = path.join(base, '.vibe-review', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'hook.js'), ECHO_HOOK);
  const nodeDir = path.join(base, 'node dir');
  fs.mkdirSync(nodeDir);
  const nodePath = path.join(nodeDir, 'node');
  fs.symlinkSync(process.execPath, nodePath);
  return { home, ctx: ctxFor(home, { nodePath, binDir }), hookPath: path.join(binDir, 'hook.js') };
}

function assertCommandsRunnable(dirName: string) {
  const { home, ctx, hookPath } = weirdHomeSetup(dirName);
  const f = files(home);
  for (const a of AGENT_IDS) configureAgent(a, ctx);
  const claude = JSON.parse(read(f.settings));
  const copilot = JSON.parse(read(f.cpHooks));
  const codex = JSON.parse(read(f.codexHooks));
  const commands: Array<[string, string, string[]]> = [
    [claude.hooks.Stop[0].hooks[0].command, 'claude', ['stop', 'claude', '--timeout', '3600']],
    [claude.hooks.UserPromptSubmit[0].hooks[0].command, 'claude', ['prompt', 'claude']],
    [codex.hooks.Stop[0].hooks[0].command, 'codex', ['stop', 'codex', '--timeout', '3600']],
    [copilot.hooks.agentStop[0].command, 'copilot', ['stop', 'copilot', '--timeout', '3600']],
  ];
  for (const [cmd, , args] of commands) {
    for (const shell of ['/bin/sh', '/bin/bash']) {
      let argv: string[];
      try {
        argv = runViaShell(shell, cmd);
      } catch (err) {
        assert.fail(`${shell} could not run ${cmd}: ${(err as Error).message.split('\n')[0]}`);
      }
      assert.deepEqual(argv, args, `${shell}: wrong argv for ${cmd}`);
    }
  }
  // Correct script actually ran: our echo hook only exists at hookPath.
  assert.ok(fs.existsSync(hookPath));
  const t = parseToml(read(f.codexToml)).get('mcp_servers.vibe-review')!;
  assert.equal(t.command, ctx.nodePath);
  assert.deepEqual(t.args, [path.join(ctx.binDir, 'mcp.js')]);
  const mcp = JSON.parse(read(f.claudeJson)).mcpServers['vibe-review'];
  assert.equal(mcp.command, ctx.nodePath);
  assert.deepEqual(mcp.args, [path.join(ctx.binDir, 'mcp.js')]);
  // Uninstall still recognises entries with escaped paths.
  for (const a of AGENT_IDS) configureAgent(a, ctx, false);
  for (const a of AGENT_IDS) assert.equal(isInstalled(a, home), false, `${a} still installed after uninstall`);
}

test('paths with spaces, quotes, backslashes and unicode: hook commands run in sh/bash, TOML/JSON values exact', { skip: process.platform === 'win32' }, () => {
  assertCommandsRunnable(`Jo "Q" O'Neil back\\slash ünï 日本`);
});

test('[BUG] paths with shell metacharacters but no spaces (e.g. "R&D(1)"): hook commands still run', { skip: process.platform === 'win32' }, () => {
  assertCommandsRunnable('R&D(1);x|y');
});

test('[BUG] paths with $ and backticks: no shell expansion in hook commands', { skip: process.platform === 'win32' }, () => {
  assertCommandsRunnable('cost$HOME`echo`x');
});

// ---- symlinks & permissions ----------------------------------------------------------

test('symlinked settings.json (dotfiles repo): link is preserved and target updated in place', () => {
  const home = mkHome();
  const f = files(home);
  const target = path.join(home, 'dotfiles', 'claude-settings.json');
  const original = json(userClaudeSettings);
  put(target, original);
  fs.mkdirSync(path.dirname(f.settings), { recursive: true });
  fs.symlinkSync(target, f.settings);
  configureAgent('claude', ctxFor(home));
  assert.ok(fs.lstatSync(f.settings).isSymbolicLink(), 'symlink replaced by a regular file');
  assert.match(read(target), /vibe-review\/bin\/hook\.js/);
  configureAgent('claude', ctxFor(home), false);
  assert.ok(fs.lstatSync(f.settings).isSymbolicLink());
  assert.equal(read(target), original);
});

test('read-only settings.json: configure throws a regular Error and leaves content unchanged', { skip: process.getuid?.() === 0 }, () => {
  const home = mkHome();
  const f = files(home);
  put(f.settings, json({ model: 'x' }));
  fs.chmodSync(f.settings, 0o444);
  assertThrowsUnchanged(f.settings, () => configureAgent('claude', ctxFor(home)), 'wrote to a read-only file');
});

// ---- uninstallAll partial failure ----------------------------------------------------

test('uninstallAll: one unparseable agent file → others cleaned, error reported, runtime kept', () => {
  const home = mkHome();
  const f = files(home);
  installRuntimeStub(home);
  put(f.settings, json(userClaudeSettings));
  for (const a of AGENT_IDS) configureAgent(a, ctxFor(home));
  const broken = read(f.codexHooks) + '\n{garbage';
  put(f.codexHooks, broken);
  const r = uninstallAll(home);
  assert.deepEqual(r.removedFrom, ['claude', 'copilot']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^Codex CLI: /);
  assert.equal(r.runtimeRemoved, false);
  assert.ok(fs.existsSync(path.join(f.bin, 'hook.js')));
  assert.equal(read(f.codexHooks), broken, 'unparseable file was rewritten');
  assert.equal(isInstalled('claude', home), false);
  assert.equal(isInstalled('copilot', home), false);
  assert.deepEqual(JSON.parse(read(f.settings)), userClaudeSettings);
});

test('uninstallAll: read-only config → error reported, runtime kept, other agents cleaned', { skip: process.getuid?.() === 0 }, () => {
  const home = mkHome();
  const f = files(home);
  installRuntimeStub(home);
  for (const a of AGENT_IDS) configureAgent(a, ctxFor(home));
  fs.chmodSync(f.cpMcp, 0o444);
  const r = uninstallAll(home);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^GitHub Copilot CLI: /);
  assert.equal(r.runtimeRemoved, false);
  assert.ok(r.removedFrom.includes('claude') && r.removedFrom.includes('codex'));
  assert.equal(isInstalled('claude', home), false);
  assert.equal(isInstalled('codex', home), false);
});

// ---- .git/info/exclude ---------------------------------------------------------------

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const excludeOf = (repo: string) => path.join(repo, '.git', 'info', 'exclude');

test('exclude: ensure is idempotent, keeps user lines, and remove restores the file byte-for-byte', () => {
  const repo = mkRepo();
  const ex = excludeOf(repo);
  const original = '# user\n*.log\n.vibe-review\n/.vibe-review/foo\n';
  put(ex, original);
  ensureLocalExclude(repo);
  ensureLocalExclude(repo);
  const mid = read(ex);
  assert.equal(mid.split('\n').filter((l) => l === '.vibe-review/').length, 1);
  assert.ok(mid.startsWith(original));
  removeLocalExclude(repo);
  assert.equal(read(ex), original);
  removeLocalExclude(repo);
  assert.equal(read(ex), original);
});

test('[BUG] exclude: file without trailing newline is restored exactly after ensure → remove', () => {
  const repo = mkRepo();
  const ex = excludeOf(repo);
  put(ex, '*.log');
  ensureLocalExclude(repo);
  assert.equal(read(ex).split(/\r?\n/).filter((l) => l === '*.log').length, 1, 'user line corrupted');
  removeLocalExclude(repo);
  assert.equal(read(ex), '*.log');
});

test('exclude: CRLF file — existing CRLF entry detected, and ensure → remove restores bytes', () => {
  const repo = mkRepo();
  const ex = excludeOf(repo);
  put(ex, '*.log\r\n.vibe-review/\r\n');
  ensureLocalExclude(repo);
  assert.equal(read(ex), '*.log\r\n.vibe-review/\r\n');
  put(ex, '*.log\r\nbuild/\r\n');
  ensureLocalExclude(repo);
  removeLocalExclude(repo);
  assert.equal(read(ex), '*.log\r\nbuild/\r\n');
});

test('exclude: remove on a missing exclude file creates nothing', () => {
  const repo = mkRepo();
  fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });
  removeLocalExclude(repo);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'info')), false);
});

test('exclude: ensure in a missing info/ dir creates it and git then ignores .vibe-review/', () => {
  const repo = mkRepo();
  fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });
  ensureLocalExclude(repo);
  assert.equal(read(excludeOf(repo)), '.vibe-review/\n');
  fs.mkdirSync(path.join(repo, '.vibe-review'));
  fs.writeFileSync(path.join(repo, '.vibe-review', 'x.json'), '{}');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
  assert.equal(status, '');
});

test('[BUG] exclude: in a linked git worktree, .vibe-review/ is actually ignored by git', () => {
  const repo = mkRepo();
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(path.dirname(repo), path.basename(repo) + '-wt');
  g(repo, 'worktree', 'add', '-q', wt);
  ensureLocalExclude(wt);
  fs.mkdirSync(path.join(wt, '.vibe-review'));
  fs.writeFileSync(path.join(wt, '.vibe-review', 'x.json'), '{}');
  const status = g(wt, 'status', '--porcelain', '--untracked-files=all');
  assert.equal(status, '', `.vibe-review/ shows up in the worktree's git status:\n${status}`);
});
