# Vibe Review for Visual Studio

The Visual Studio (2022 and later, Windows) version of Vibe Review. It has the same capabilities as the VS Code extension: comment on your AI agent's uncommitted changes like a PR review, **Submit**, and Claude Code, Codex CLI or GitHub Copilot CLI fixes the code, replies on each thread and waits for your next round. **Approve** to let it stop.

Both editors share the same review data (`.vibe-review/` in your repository), the same agent hooks and MCP server (`~/.vibe-review/bin`), and the same review engine. You can have both installed, and even switch between them on the same project.

## Requirements

| You need | Check it with |
|---|---|
| **Visual Studio 2022** (17.0) or newer, any edition, x64 or Arm64 | **Help → About Microsoft Visual Studio** |
| **Node.js** 18 or newer | `node --version` in a terminal |
| **Git**, and your solution or folder must be inside a git repository | `git status` in your project folder |
| At least one agent CLI: **Claude Code**, **Codex CLI** or **GitHub Copilot CLI** | `claude --version`, `codex --version` or `copilot --version` |

Vibe Review finds `node.exe` on your `PATH` and in the usual install locations (Node.js installer, nvm-windows, Volta, Scoop). If it can't, set **Tools → Options → Vibe Review → General → Node.js executable**.

## Install

1. Get the `.vsix`: download the **vibe-review-visualstudio** artifact from the latest successful run of the [**Visual Studio extension** workflow](../.github/workflows/visualstudio.yml) (Actions tab), or [build it yourself](#build-from-source).
2. Close Visual Studio, double-click `VibeReview.VisualStudio.vsix`, and click **Install**.

## Quick start

1. **Connect your agent** (once): **Tools → Vibe Review → Set Up Agents (Hooks + MCP)…**, keep the agents you use ticked, click **Install**. Then restart your agent sessions. **Codex CLI:** run `/hooks` once and trust the Vibe Review hooks.
2. **Open your project** (a solution, or **File → Open → Folder**) inside a git repository, and open the tool window: **Tools → Vibe Review → Show Changes & Comments** (also under **View → Other Windows**).
3. **Turn on Review Mode** (once per project): click **Review Mode: Off** in the tool window so it says **On**.
4. Ask your agent for a change. When it finishes, an info bar says **"… is waiting for your review"**.
5. In the tool window, double-click a changed file to open its diff. Select changed lines in the right (working tree) side, right-click → **Vibe Review: Add Comment…**.
6. Click **Submit Review**. The agent fixes the code and replies on each thread. Read the replies in the tool window, then **Resolve**, or reply and submit again. When you're happy, click **Approve**.

## Where things are

| VS Code | Visual Studio |
|---|---|
| **Vibe Review** view in Source Control | **Vibe Review** tool window (**View → Other Windows**) |
| `+` on a changed line, inline comment threads | Select lines → right-click → **Vibe Review: Add Comment…**; threads open in the tool window. Colored dots in the editor margin mark threads (yellow pending, hollow = not submitted yet, blue active, green resolved); click one to open it. |
| Status bar item | Status banner at the top of the tool window, plus an info bar when an agent is waiting |
| Command Palette **Vibe Review: …** | **Tools → Vibe Review** menu (and the tool window buttons). All commands are also in **Tools → Options → Keyboard** as `VibeReview.*`. |
| Settings `vibeReview.waitTimeoutMinutes` | **Tools → Options → Vibe Review → General → Wait timeout (minutes)** |
| Setting `vibeReview.useGitHubAvatar` | Not applicable: Visual Studio shows "You" / "Agent" labels and loads nothing from the network. |

Comments are Markdown. Paste (Ctrl+V) or drop screenshots and image files into any comment box to attach them; rich text copied from a browser or document is pasted as Markdown. **Ctrl+Shift+V** pastes plain text. **Ctrl+Enter** sends a comment or reply.

## Uninstall

Run **Tools → Vibe Review → Uninstall (Remove Hooks, MCP Server & Data)…** *before* removing the extension:

- **Uninstall Everything** removes the hooks and MCP server from every agent, deletes `~/.vibe-review/`, deletes this project's `.vibe-review/` data, and opens **Extensions → Manage Extensions** so you can uninstall Vibe Review.
- **Only Remove Agent Setup** removes the hooks and MCP server from every agent and deletes `~/.vibe-review/`, but keeps the extension.

Unlike VS Code, Visual Studio doesn't let extensions run cleanup when they're uninstalled. If you removed the extension first, reinstall it and run the command, or remove the `vibe-review` entries from your agent configs by hand (each changed file has a `.vibe-review.bak` backup). If the VS Code extension is still installed, the hooks keep working for it, so only remove them if you use neither editor.

## How it works

The extension is a thin native UI. All review logic (the `.vibe-review/` store and its locks, git parsing, thread re-anchoring, review formatting, attachments, agent setup) runs in Node.js: Visual Studio calls `dist/vs-bridge.js` (built from [`src/vs-bridge.ts`](../src/vs-bridge.ts)) with a JSON request on stdin and reads one JSON response from stdout. That is the same code the VS Code extension, the agent hooks and the MCP server use, so all of them always agree. The VSIX also contains `hook.js` and `mcp.js`, which **Set Up Agents** copies to `~/.vibe-review/bin`.

While a solution or folder in a git repository is open, the extension polls the review state (every 3 seconds with Review Mode on or an agent waiting, every 10 seconds otherwise, and immediately on file changes) and records a heartbeat for the `devenv.exe` process in `.vibe-review/editor.json`. Agents only wait for a review while a VS Code or Visual Studio window is alive on the project. Closing the solution or Visual Studio releases them.

## Build from source

Needs Windows, Visual Studio 2022 or later with the **Visual Studio extension development** workload, and Node.js 18+.

```sh
git clone https://github.com/umerkk/vibe-review.git
cd vibe-review
npm ci
npm run build                     # builds dist/vs-bridge.js, dist/hook.js, dist/mcp.js (the build also does this if dist/ is missing)
node --test --import tsx test/vs-bridge.test.ts
```

Then open `visualstudio/VibeReview.VisualStudio.sln` in Visual Studio and press **F5**: it builds the VSIX and starts the **Experimental Instance** of Visual Studio with the extension installed. The `.vsix` is in `visualstudio/VibeReview/bin/<Configuration>/net48/`.

From a Developer Command Prompt: `msbuild visualstudio\VibeReview.VisualStudio.sln /restore /p:Configuration=Release`.

On macOS/Linux, `dotnet build visualstudio/VibeReview/VibeReview.VisualStudio.csproj` compiles the C# code against the Visual Studio SDK (useful to check for errors), but packaging a VSIX needs Windows.

CI ([`.github/workflows/visualstudio.yml`](../.github/workflows/visualstudio.yml)) runs the bridge tests on Windows, builds the VSIX, checks its contents and uploads it as an artifact. When you bump the version in `package.json`, update it in `source.extension.vsixmanifest`, `Vsix.cs` and `VibeReview.VisualStudio.csproj` too (CI checks they match).

## Manual test checklist

Use this to verify a build in Visual Studio. Run it in the Experimental Instance (F5) or after installing the `.vsix`. You need a test git repository with a commit and at least one agent CLI.

**Pass criteria: every box checked, with no error dialogs other than the expected ones, and nothing in the Activity Log** (start with `devenv /log`, then open `%APPDATA%\Microsoft\VisualStudio\<version>\ActivityLog.xml` and search for `VibeReview`).

### Install and load
- [ ] The extension appears in **Extensions → Manage Extensions → Installed** as *Vibe Review*, with its icon.
- [ ] **Tools → Vibe Review** shows: Show Changes & Comments, Submit Review…, Approve, Discard Review, Turn Review Mode On, Refresh, Set Up Agents (Hooks + MCP)…, Uninstall…, each with an icon.
- [ ] **View → Other Windows → Show Changes & Comments** opens the **Vibe Review** tool window, docked next to Solution Explorer.
- [ ] **Tools → Options → Vibe Review → General** shows *Wait timeout (minutes)* = 30 and an empty *Node.js executable*.
- [ ] With no solution open, the tool window says to open a solution or folder inside a git repository, and the review buttons are disabled.

### Node.js detection
- [ ] With Node.js installed normally, opening a repository shows the review state (no error banner).
- [ ] Set *Node.js executable* to a non-existent path → the banner explains Node.js is needed and how to fix it. Clear the setting → the error disappears within ~10 seconds (or on **Refresh**).

### Project detection
- [ ] Open a solution whose `.sln` is in a **subfolder** of the repository → the tool window lists the repository's changed files (paths relative to the repository root).
- [ ] **File → Open → Folder** on a repository works the same.
- [ ] Close the solution → the tool window returns to the "open a solution" message. Open a solution in a different repository → it shows that repository.
- [ ] Open a solution that's not in a git repository → "open a solution or folder inside a git repository" message, no errors.

### Set up agents
- [ ] **Set Up Agents…** lists Claude Code, Codex CLI and GitHub Copilot CLI with the files each will change. **Install** → a confirmation names the agents (and for Codex, the `/hooks` note).
- [ ] `~/.vibe-review/bin/hook.js` and `mcp.js` exist; the agents' config files contain the Vibe Review hooks/MCP entries pointing at the `node.exe` in use; `.vibe-review.bak` backups exist.
- [ ] Unticking all agents and clicking Install shows "Choose at least one agent." **Uninstall** for one agent removes only its entries.
- [ ] Restart the agent: its `/mcp` (or equivalent) lists `vibe-review`.

### Review Mode and waiting
- [ ] Click **Review Mode: Off** → it becomes **On**; `.vibe-review/config.json` has `"mode": "on"` and `waitTimeoutSec` = 1800; `.vibe-review/` is listed in `.git/info/exclude` and doesn't appear in `git status`. (With no agents set up, a prompt offers **Set Up Agents**.)
- [ ] **Tools → Vibe Review** menu item reads *Turn Review Mode Off* (checked) while on.
- [ ] `.vibe-review/editor.json` contains the `devenv.exe` process ID with a recent timestamp, refreshed about every 10 seconds.
- [ ] Ask the agent for a change. When it finishes, the agent **waits**; an info bar "*<Agent> finished and is waiting for your review*" appears with **Open Vibe Review** and **Approve**; the banner shows 🔔.
- [ ] Changing *Wait timeout* to 2 in Options updates `waitTimeoutSec` to 120; the agent stops waiting after ~2 minutes and the info bar disappears.

### Changed files and diffs
- [ ] The tree lists every changed file with its kind letter (M, A, D, R, U) and folder. Saving a file or the agent editing one updates the list within a few seconds.
- [ ] Double-clicking a modified file opens a **HEAD ↔ Working Tree** diff with syntax highlighting; the left side is read-only.
- [ ] A new (untracked) file opens a diff against an empty left side; a renamed file diffs against its old path; a deleted file opens its HEAD version read-only.

### Comments
- [ ] In the diff's right side (and in a normal editor tab), select changed lines → right-click → **Vibe Review: Add Comment…** → a dialog titled with the file and line range. Type a comment, **Add Comment** → the thread appears under the file as *pending · not submitted*, selected, with a hollow yellow dot in the editor margin on its first line.
- [ ] The context-menu item is hidden in files outside the repository (and with no repository open).
- [ ] Commenting on an **unchanged** line shows "You can only comment on changed lines, as in a pull request…" and creates nothing. Any line of a new file can be commented.
- [ ] A selection ending at the start of a line doesn't include that line. With no selection, the caret line is used.
- [ ] Commenting on a file with unsaved edits saves it first and anchors the comment to the right lines.
- [ ] In the tool window, **Edit** a pending comment → **Save** updates it; **Cancel** reverts. **Delete** removes it. **Delete Thread** asks for confirmation, then removes the thread.
- [ ] **Reply** (or Ctrl+Enter) adds a pending reply; text you're typing is not lost when the tool window refreshes.
- [ ] Hovering a margin dot shows the thread state and first comment; clicking it opens the tool window on that thread. Clicking the *file, line* link in the thread opens the diff at that line.

### Screenshots and rich text
- [ ] Paste a screenshot (Win+Shift+S, then Ctrl+V) into a comment box → `![screenshot](.vibe-review/attachments/….png)` is inserted and the image file exists. After saving, the image shows under the comment; clicking it opens it.
- [ ] Copy a `.png` in File Explorer and paste it, or drag it into a comment box → it's attached the same way.
- [ ] Copy formatted text (bold, a link, a list) from a web page and paste → Markdown is inserted. Copy code from the Visual Studio editor and paste → plain code text (no HTML conversion). **Ctrl+Shift+V** always pastes plain text.
- [ ] The agent's review text includes the attachment path, and the agent can read the image.

### Submit, replies, resolve
- [ ] **Submit Review** asks for an optional overall comment; with no comments, an empty summary is refused. Submitting while the agent waits shows "review sent to the agent" in the status bar; the agent continues with your comments.
- [ ] Submitting while no agent waits shows "Review submitted…" with **Copy Review** (copies the formatted review); the banner shows ✉ *not yet picked up* until you type something in the agent's terminal.
- [ ] Agent replies appear in the thread as *Agent · AI reply*; the thread turns **Active** (blue dot, ◐ in the banner). Threads follow the code when the agent moves lines.
- [ ] **Resolve** turns the thread green; **Reopen** makes it open again.
- [ ] **Approve** (with pending comments: confirmation "Approve Anyway") → the agent stops; status bar shows "approved". **Discard** (confirmation when there are pending comments) → drafts are gone, the agent stops.
- [ ] Info bar **Approve** and **Open Vibe Review** work.

### Editor heartbeat
- [ ] With Review Mode on, close Visual Studio while the agent waits → the agent stops waiting within a few seconds, and `editor.json` no longer lists the `devenv.exe` PID.
- [ ] Kill `devenv.exe` from Task Manager instead → the agent stops waiting within ~60 seconds at most.
- [ ] With Visual Studio and VS Code both open on the project, comments made in one show up in the other.

### Uninstall
- [ ] **Uninstall… → Only Remove Agent Setup** removes the agent entries and `~/.vibe-review/`; the extension stays.
- [ ] **Uninstall… → Uninstall Everything** also deletes the project's `.vibe-review/` and its `.git/info/exclude` entry, then opens **Manage Extensions**. Uninstalling there and restarting Visual Studio removes the extension.

### Themes and robustness
- [ ] The tool window and dialogs are readable in the Light, Dark and Blue themes (switch in **Tools → Theme**).
- [ ] Paths with spaces and non-ASCII characters (e.g. `C:\Users\Zoë\My Repo`), and comments with emoji, work end to end.
- [ ] No noticeable UI freezes while the tool window is open in a large repository.
