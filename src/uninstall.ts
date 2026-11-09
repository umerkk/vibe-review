/**
 * Run by VS Code (`vscode:uninstall`) after the extension is uninstalled, in plain Node without
 * the VS Code API. Removes our hooks and MCP entries from every agent so no agent is left
 * pointing at a deleted script. Per-repo `.vibe-review/` data is left alone.
 */
import * as os from 'node:os';
import { uninstallAll } from './shared/setup';

try {
  const result = uninstallAll(os.homedir());
  for (const e of result.errors) console.error(`vibe-review uninstall: ${e}`);
} catch (err) {
  console.error(`vibe-review uninstall failed: ${(err as Error).message}`);
}
