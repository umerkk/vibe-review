# Vibe Review

**Review your AI agent's code the way you review a pull request, without leaving VS Code or pushing anything.**

Leave comments on your uncommitted changes in VS Code and click **Submit**. Your coding agent in the terminal (**Claude Code**, **Codex CLI** or **GitHub Copilot CLI**) picks up the comments, fixes the code, replies on each thread, and waits for your next round. When you're happy, click **Approve**.

```
agent edits code → finishes its turn → waits for you ⏸
  → you comment in VS Code → Submit → agent fixes the code and replies on threads → waits again ⏸
  → you Approve → agent stops ✅
```

- **Fully local.** No accounts, no servers, no GitHub PRs. Reviews are plain JSON files inside your repo, hidden from git.
- **Works like a PR review.** Comments on changed lines, pending drafts, threaded replies, resolve and reopen.
- **Screenshots and formatting.** Paste screenshots and rich text into comments. The agent gets the images too.
- **Works with the agent you already use.** Claude Code, Codex CLI, GitHub Copilot CLI, or all three.

---

## Contents

- [Requirements](#requirements)
- [Quick start (about 5 minutes)](#quick-start-about-5-minutes)
- [Your first review](#your-first-review)
- [Everyday use](#everyday-use)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Privacy](#privacy)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Building from source](#building-from-source)

---

## Requirements

| You need | Check it with |
|---|---|
| **VS Code** 1.97 or newer | VS Code menu → **About** |
| **Node.js** 18 or newer, on your `PATH` | `node --version` in a terminal |
| **Git**, and your project must be a git repository | `git status` in your project folder |
| At least one agent CLI: **Claude Code**, **Codex CLI** or **GitHub Copilot CLI** | `claude --version`, `codex --version` or `copilot --version` |

> Tested on macOS and Linux. Windows is untested.

---

## Quick start (about 5 minutes)

You only do steps 1–4 once. You do step 5 once in each project.

### Step 1 — Download the extension

1. Go to the [**Releases** page](https://github.com/umerkk/vibe-review/releases) of this repository.
2. Under the latest release, open **Assets** and download the file ending in **`.vsix`** (for example `vibe-review-0.1.0.vsix`).

### Step 2 — Install it in VS Code

Choose **one** of these:

**Option A: from inside VS Code (easiest)**

1. Open the **Extensions** view: click the four-squares icon in the left sidebar, or press `Cmd+Shift+X` (macOS) or `Ctrl+Shift+X` (Windows/Linux).
2. Click the **`···`** (More Actions) button at the top right of the Extensions view.
3. Choose **Install from VSIX…**.
4. Select the `.vsix` file you downloaded.
5. Wait for the *"Completed installing extension"* notification.

**Option B: from a terminal**

```sh
code --install-extension ~/Downloads/vibe-review-0.1.0.vsix
```

> **`code: command not found`?** In VS Code, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), run **Shell Command: Install 'code' command in PATH**, open a new terminal and try again. Or use Option A.

### Step 3 — Connect your agent

This step teaches your agent to wait for your review and to reply to your comments. You run it from VS Code.

1. In VS Code, open your project folder (**File → Open Folder…**). It must be a git repository.
2. Open the **Command Palette**: `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux).
3. Type **`Vibe Review: Set Up Agents`** and press `Enter`.
4. A list of agents appears, all ticked. **Untick the agents you don't use** and press `Enter`.
5. A dialog lists every file that will be changed. Click **Install**.
6. A notification confirms the setup.

You don't need to repeat this step for other projects: the setup applies to every project on your machine. Each config file is backed up first.

<details>
<summary><b>What exactly does this change?</b></summary>

It copies two small scripts (a *hook* and an *MCP server*) to `~/.vibe-review/bin/`, and registers them in your agent's own config files:

| Agent | Hooks added to | MCP server added to |
|---|---|---|
| Claude Code | `~/.claude/settings.json` (`Stop`, `UserPromptSubmit`) | `~/.claude.json` |
| Codex CLI | `~/.codex/hooks.json` (`Stop`, `UserPromptSubmit`) | `~/.codex/config.toml` |
| GitHub Copilot CLI | `~/.copilot/hooks/vibe-review.json` (`agentStop`, `userPromptTransformed`) | `~/.copilot/mcp-config.json` |

- **Hooks** run when your agent finishes a turn or when you send it a message. They pause the agent while you review, and deliver your comments.
- **The MCP server** gives the agent tools to read your review, reply on threads and resolve them.

The first time Vibe Review changes a file, it saves the original next to it as `<file>.vibe-review.bak`. Later runs never overwrite that backup. Other settings in those files are left untouched, and running setup again is safe. If a file can't be parsed or isn't writable, setup stops without changing anything and tells you which file to fix.
</details>

### Step 4 — Restart your agent

Agents read hooks and MCP servers only when they start, so restart any open agent session.

1. In each terminal running an agent, quit it: type `/exit`, or press `Ctrl+C` twice.
2. Start it again **from your project folder**:
   ```sh
   cd path/to/your/project
   claude      # or: codex, or: copilot
   ```
3. **Codex CLI only:** Codex won't run new hooks until you trust them. Type `/hooks` and trust the two **vibe-review** hooks.
4. **Check it worked:** type `/mcp` in the agent. You should see **`vibe-review`** in the list, connected.

### Step 5 — Turn on Review Mode (once per project)

Review Mode tells the agent to **wait for your review after every turn** in this project.

1. Open the **Source Control** view: click the branch icon in the left sidebar, or press `Ctrl+Shift+G`.
2. Find the **Vibe Review** section in that view. It lists your uncommitted files. If it's collapsed, click its title.
3. Turn Review Mode on. Either:
   - hover the **Vibe Review** title and click the **crossed-out eye** icon (*Turn Review Mode On*), or
   - click **Review: Off** at the bottom-left of the status bar and choose **Turn Review Mode On**.

The status bar now shows **👁 Review: On**. You're ready. 🎉

> In projects where Review Mode is off, the hooks do nothing, so leaving them installed is harmless.

---

## Your first review

1. **Ask your agent for a change** in its terminal as usual, e.g. *"add input validation to the signup form"*.
2. **Wait for it to finish.** Instead of stopping, the agent now pauses. In VS Code:
   - the status bar turns yellow: **🔔 Claude Code waiting for review**
   - a notification says *"… finished and is waiting for your review."*
3. **Open the changes.** In **Source Control → Vibe Review**, click a file. A side-by-side diff opens (last commit on the left, your working copy on the right).
4. **Comment on a line.** Hover a changed line on the right side. A **`+`** appears in the gutter next to the line numbers. Click it, or drag over several lines first to comment on a range.
5. **Write your comment** and click **Add Comment**. Markdown works, and you can paste screenshots, see [Screenshots and rich text](#screenshots-and-rich-text). It's marked **Pending**: the agent doesn't see it yet, the same as a pending PR review. Add as many comments as you like across files.
6. **Submit.** Click the **send** icon (➤) in the Vibe Review title bar, or click the status bar and choose **Submit Review**. You can type an optional overall comment, then press `Enter`.
7. **Watch the agent work.** It gets every comment with its file, lines and code, makes the fixes, and **replies on each thread**. Replies appear right in your editor, and the thread becomes **Active**, waiting for you to accept it.
8. **Accept or push back.** Happy with a fix? Click **Resolve** (✓) on the thread. Not yet? Reply on it: the thread goes back to **Pending**. Then Submit for another round, or click **Approve** in the Vibe Review title bar to let the agent stop.

> **Tip:** you don't have to wait for the agent to pause. If it has already stopped, submit your review anyway, then type anything (e.g. `review`) in the agent's terminal. The review is attached to that message.

---

## Everyday use

### Buttons

Hover the **Vibe Review** section title in Source Control to see its buttons. The same actions are in the status bar menu (click the **Review:** item at the bottom-left).

| Button | What it does |
|---|---|
| ➤ **Submit Review** | Sends all pending comments, plus an optional overall comment, to the agent. The agent continues working. |
| ✓ **Approve** | Tells a waiting agent you're done, so it stops normally. Pending comments are **not** sent. |
| 👁 **Review Mode On / Off** | On: the agent waits for you after every turn. Off: the agent behaves normally. |
| ↻ **Refresh** | Re-reads git changes, which normally happens automatically. |
| `···` → **Discard Review** | Deletes your pending comments and lets a waiting agent stop. |
| `···` → **Set Up Agents…** | Re-runs setup from [Step 3](#step-3--connect-your-agent), or removes it from selected agents. |
| `···` → **Uninstall…** | One-click cleanup. See [Uninstall](#uninstall). |

### Comments and threads

Each thread has a state, shown in its header and in the Vibe Review tree:

| State | Meaning | What you do |
|---|---|---|
| ● **Pending** | You have the last word, and the agent hasn't responded yet. Shown as *not submitted yet* until you Submit. | Submit, or wait for the agent. |
| ◐ **Active** | The agent responded (fixed it, or asked something) and is waiting for you. | **Resolve** to accept, or reply to push back. |
| ✓ **Resolved** | You accepted it. | Nothing. Reply or **Reopen** to bring it back. |

Only you can resolve a thread. When the agent finishes a thread, it marks it addressed, which makes it Active. Replying to a resolved thread reopens it as **Pending**, like on GitHub.

In a thread, your comments show your GitHub avatar (if you're signed in to GitHub in VS Code, otherwise a blue placeholder) and the agent's replies have a purple robot avatar labelled **AI reply**, so it's easy to see where each message starts.

Hover a comment or thread to see its actions:

- **Reply:** add to the conversation. Replies on a thread are pending until you Submit, too.
- **Edit / Delete:** on your own comments while they're still **Pending**. Once submitted, they're part of the record.
- **Resolve / Reopen:** accept a thread, or bring it back.

### Screenshots and rich text

- **Screenshots and images:** paste an image into the comment box (e.g. after `Cmd+Ctrl+Shift+4` on macOS or `Win+Shift+S` on Windows). You can also paste or drag image files (PNG, JPEG, GIF, WebP) from Finder or Explorer. The image is saved in `.vibe-review/attachments/`, shows inline in the comment, and is sent to the agent, which opens it to see what you mean.
- **Rich text:** text copied from a browser, docs or chat keeps its formatting. Bold, links, lists and code are converted to Markdown. To paste plain text instead, click the small paste widget that appears after pasting and choose **Insert Plain Text**. Code copied from VS Code always pastes as plain text.
- **Markdown:** you can type `**bold**`, `` `code` ``, fenced code blocks, lists and links directly.

### Status bar

| Shows | Meaning |
|---|---|
| **Review: Off** | Agents behave normally in this project. |
| **Review: On** | Agents will wait for you after their next turn. |
| 🔔 **… waiting for review** (yellow) | An agent is paused right now, waiting for you to Submit or Approve. |
| 💬 **3** | You have 3 draft comments that aren't submitted yet. |
| ● **2** | 2 threads are submitted and waiting for the agent. |
| ◐ **1** | 1 thread has an agent reply waiting for you to Resolve or reply. |
| ✉ **not yet picked up** | You submitted while no agent was waiting. Type any message (e.g. `review`) in the agent's terminal to deliver it. |

### Stopping a waiting agent

- Click **Approve** or **Discard Review** in VS Code, or
- press `Esc` (or `Ctrl+C`) in the agent's terminal, or
- turn Review Mode off, or
- wait. After 30 minutes the agent stops by itself, and your pending comments are kept. See [Settings](#settings).

---

## Settings

Open **Settings** (`Cmd+,` / `Ctrl+,`) and search for **Vibe Review**.

| Setting | Default | Description |
|---|---|---|
| `vibeReview.waitTimeoutMinutes` | `30` | How long an agent waits for your review before stopping anyway (1–55 minutes). Your pending comments are kept. |
| `vibeReview.useGitHubAvatar` | `true` | Show your GitHub avatar on your comments, if you're signed in to GitHub in VS Code. Never prompts you to sign in. Turn off to use a placeholder and load nothing from the network. |

---

## Troubleshooting

| Problem | What to do |
|---|---|
| **There's no "Vibe Review" section in Source Control.** | The opened folder must be (inside) a git repository. Run `git init` if it isn't. Then reload VS Code: Command Palette → **Developer: Reload Window**. If it's still missing, it may be hidden: click the `···` menu at the top of the Source Control view and tick **Vibe Review**. |
| **No `+` appears when I hover a line.** | You can only comment on **changed** lines, just like a PR. New (untracked) files can be commented anywhere. If the file just changed, click ↻ **Refresh**. |
| **The agent finished without waiting for me.** | 1) The status bar must say **Review: On**. 2) The project must have uncommitted changes. 3) You must have restarted the agent after setup. 4) **Codex:** trust the hooks via `/hooks`. 5) Start the agent from inside the project folder. |
| **`/mcp` doesn't list `vibe-review`.** | Re-run **Vibe Review: Set Up Agents** for that agent, then fully restart the agent. |
| **I submitted, but the agent didn't react.** | The status bar shows ✉ **not yet picked up**: the agent wasn't waiting. Type any message (e.g. `review`) in the agent's terminal. Alternatively, click **Copy Review** in the notification that appears after submitting and paste it into the agent. |
| **The agent stops waiting after a few rounds.** | Claude Code and Copilot CLI allow at most 8 automatic continuations in a row. Type any message in the agent's terminal to continue; your next review is picked up then. |
| **Setup says a config file is invalid, damaged or not writable.** | Nothing was changed. Fix the file named in the message (for example invalid JSON, a hand-edited `# >>> vibe-review >>>` block in `~/.codex/config.toml`, or read-only permissions), then run setup again. Your original is in `<file>.vibe-review.bak` if setup changed it before. |
| **Hooks stopped working after I updated Node.js** (e.g. with `nvm`). | Setup saved the full path to your `node` at that time. Re-run **Vibe Review: Set Up Agents**, then restart the agent. |
| **The agent waits even though I don't want to review.** | Turn Review Mode **off**, or click **Approve**. |
| **Something else.** | Look in the hidden `.vibe-review/` folder in your project. It holds plain JSON files: your threads, reviews, and `agent.json` (whether an agent is waiting). Deleting the folder resets all review state for that project. |

---

## Uninstall

**One click:** open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), run **Vibe Review: Uninstall (Remove Hooks, MCP Server & Data)…**, and choose:

- **Uninstall Everything** removes the hooks and MCP server from every agent, deletes `~/.vibe-review/`, deletes this project's review data (`.vibe-review/`), and uninstalls the extension.
- **Only Remove Agent Setup** removes the hooks and MCP server from every agent and deletes `~/.vibe-review/`, but keeps the extension. Run **Set Up Agents** later to add them back.

You can also find it in the Vibe Review panel's **`···`** menu and in the status bar menu. Your other agent settings are left untouched, and each changed file is backed up as `<file>.vibe-review.bak`. Restart any running agent sessions afterwards.

**Uninstalled from the Extensions view instead?** That's fine: when VS Code finishes uninstalling, it runs a cleanup that removes the hooks and MCP server from your agents automatically. VS Code may wait until it next restarts to do this. Review data in your projects (`.vibe-review/` folders) is kept. Delete those folders if you no longer need them.

---

## Privacy

Everything runs on your machine. Vibe Review has **no telemetry and no accounts of its own**, and your code and comments never leave your computer. The only network request is VS Code loading your GitHub avatar image from `avatars.githubusercontent.com` when you're already signed in to GitHub. Turn off `vibeReview.useGitHubAvatar` to avoid it.

- Review data, including pasted images, lives in `<your-project>/.vibe-review/`. It's added to `.git/info/exclude` automatically, so it never appears in `git status` or gets committed. If a repository *does* contain a committed `.vibe-review/` folder (for example, from someone else), the hooks and MCP server ignore it, so a cloned repo can't plant fake review comments for your agent.
- Your comments go only to the agent CLI running in your own terminal. That agent then sends them to its AI provider as part of the conversation, as it does with anything you type to it.

---

## How it works

<details>
<summary>For the curious</summary>

| Piece | Role |
|---|---|
| **VS Code extension** | Shows changed files, lets you comment via VS Code's native comments UI, and writes threads and reviews as JSON into `.vibe-review/`. |
| **Stop hook** (`hook.js stop <agent>`) | Runs when the agent finishes a turn. With Review Mode on and uncommitted changes, it waits until you Submit. Then it returns `{"decision":"block","reason":<your review>}`, which all three agents treat as a new instruction to continue. Approve, Discard, the timeout or Esc let the agent stop. |
| **Prompt hook** (`hook.js prompt <agent>`) | Runs when you send the agent a message. If a submitted review hasn't been delivered yet, it attaches the review to your message. |
| **MCP server** (`mcp.js`) | Tools the agent uses: `get_review`, `list_threads`, `reply_to_thread`, `resolve_thread`, and `wait_for_review` (for setups without hooks). |

Each review is delivered **exactly once**. Delivery is claimed atomically, so two agents or two hooks never both receive it. When the agent moves code around, threads follow the commented lines.
</details>

---

## Known limitations

- Comments are allowed only on changed lines (working tree vs. `HEAD`, including untracked files), as in a PR.
- In multi-root workspaces, only the first git repository is reviewed.
- Claude Code and Copilot CLI end a turn after 8 hook-forced continuations in a row. Send any message to resume.
- The longest wait for one turn is 55 minutes, because agents cap how long a hook may run.

---

## Building from source

Only needed if you want to change the extension or build the `.vsix` yourself.

```sh
git clone https://github.com/umerkk/vibe-review.git
cd vibe-review
npm install
npm test            # builds, then runs end-to-end tests (git repos, hook processes, MCP over stdio, setup)
npm run package     # → vibe-review-0.1.0.vsix
code --install-extension vibe-review-0.1.0.vsix
```

To debug, open the folder in VS Code and press `F5` to launch an Extension Development Host.

## License

[MIT](LICENSE): free to use, modify and share.
