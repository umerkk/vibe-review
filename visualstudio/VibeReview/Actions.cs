using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Differencing;
using Microsoft.VisualStudio.Text.Editor;
using Newtonsoft.Json.Linq;
using VibeReview.Bridge;
using VibeReview.Dialogs;
using Task = System.Threading.Tasks.Task;

namespace VibeReview
{
    /// <summary>The user-facing actions, shared by menu commands, the tool window and the InfoBar. Same behavior as the VS Code extension.</summary>
    internal static class Actions
    {
        private static ReviewSession Session => ReviewSession.Instance;

        public static async Task SubmitAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var drafts = Session.State?.DraftCount ?? 0;
            var summary = VibeDialog.AskComment(
                drafts > 0 ? $"Submit review ({drafts} comment{(drafts == 1 ? "" : "s")})" : "Submit review",
                drafts > 0 ? "Optional overall comment for the agent:" : "No line comments yet — write an overall comment for the agent:",
                "Submit Review",
                allowEmpty: drafts > 0);
            if (summary == null) return;
            var result = (await Session.RunAsync("submit", new { summary }))?.ToObject<SubmitResult>();
            if (result == null) return;
            if (result.AgentWaiting)
            {
                await VS.StatusBar.ShowMessageAsync("Vibe Review: review sent to the agent");
                return;
            }
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var choice = VibeDialog.Choose(
                "Vibe Review",
                "Review submitted.",
                "No agent is waiting right now: it will be picked up when the agent next finishes a turn, or send any message (e.g. \"review\") in the agent's terminal.",
                "OK",
                "Copy Review");
            if (choice == "Copy Review") Clipboard.SetText(result.Text);
        }

        public static async Task ApproveAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var drafts = Session.State?.DraftCount ?? 0;
            if (drafts > 0 && VibeDialog.Choose("Vibe Review", $"You have {drafts} pending comment(s). Approving won't send them.", null, "Approve Anyway") == null) return;
            if (await Session.RunAsync("approve") != null) await VS.StatusBar.ShowMessageAsync("Vibe Review: approved — the agent can stop");
        }

        public static async Task DiscardAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var drafts = Session.State?.DraftCount ?? 0;
            if (drafts > 0 && VibeDialog.Choose("Vibe Review", $"Discard {drafts} pending comment(s)?", null, "Discard") == null) return;
            await Session.RunAsync("discard");
        }

        public static async Task ToggleModeAsync()
        {
            var on = Session.State?.ModeOn == true;
            var options = await General.GetLiveInstanceAsync();
            var result = await Session.RunAsync("set-mode", new { mode = on ? "off" : "on", waitTimeoutMinutes = options.EffectiveWaitTimeoutMinutes });
            if (on || result == null || result.ToObject<ModeResult>()?.RuntimeInstalled == true) return;
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (VibeDialog.Choose("Vibe Review", "Review Mode is on, but no agent hooks are installed yet.", null, "Set Up Agents") != null) await SetupAgentsAsync();
        }

        public static async Task SetupAgentsAsync()
        {
            try
            {
                var agents = await NodeBridge.CallAsync<List<AgentSetupInfo>>("agents");
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var choice = VibeDialog.AskSetup(agents);
                if (choice == null) return;
                var (ids, install) = choice.Value;
                var result = await NodeBridge.CallAsync<SetupResult>("setup", new { agents = ids, install });
                var names = string.Join(", ", result.Agents);
                await VS.MessageBox.ShowAsync(
                    "Vibe Review",
                    install ? $"Vibe Review set up for {names}. {string.Join(" ", result.Notes)}".Trim() : $"Vibe Review removed from {names}.",
                    OLEMSGICON.OLEMSGICON_INFO,
                    OLEMSGBUTTON.OLEMSGBUTTON_OK);
            }
            catch (BridgeException ex)
            {
                await VS.MessageBox.ShowErrorAsync("Vibe Review", ex.IsUserError ? ex.Message : $"Vibe Review setup failed: {ex.Message}");
            }
            Session.RequestRefresh();
        }

        /// <summary>One-click cleanup: agent hooks + MCP, the shared runtime and (optionally) this repository's review data.</summary>
        public static async Task UninstallAsync()
        {
            try
            {
                var agents = await NodeBridge.CallAsync<List<AgentSetupInfo>>("agents");
                var installed = agents.Where(a => a.Installed).ToList();
                var root = Session.Root;
                var repoData = root == null ? null : Path.Combine(root, ".vibe-review");
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var detail = new StringBuilder();
                detail.AppendLine(installed.Count > 0
                    ? $"Removes the Vibe Review hooks and MCP server from {string.Join(", ", installed.Select(a => a.Name))}:\n{string.Join("\n", installed.SelectMany(a => a.Files).Select(f => "  • " + f))}"
                    : "No agent is set up for Vibe Review.");
                detail.AppendLine().AppendLine($"Deletes {Path.Combine(home, ".vibe-review")}");
                detail.AppendLine().AppendLine("Your other agent settings are kept, and a .vibe-review.bak backup of each file is saved.");
                detail.AppendLine().Append(repoData != null && Directory.Exists(repoData)
                    ? $"\"Uninstall Everything\" also deletes this project's review data ({repoData}) and opens the Extension Manager so you can remove the extension."
                    : "\"Uninstall Everything\" also opens the Extension Manager so you can remove the extension.");

                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var choice = VibeDialog.Choose("Vibe Review", "Uninstall Vibe Review?", detail.ToString(), "Uninstall Everything", "Only Remove Agent Setup");
                if (choice == null) return;
                var everything = choice == "Uninstall Everything";

                var result = await NodeBridge.CallAsync<UninstallResult>("uninstall", new { everything, root = everything ? root : null });
                if (result.Errors.Count > 0)
                {
                    await VS.MessageBox.ShowErrorAsync("Vibe Review", $"Vibe Review couldn't clean up: {string.Join("; ", result.Errors)}. Fix or remove those entries by hand, then try again. Nothing else was deleted.");
                    return;
                }
                var restart = result.RemovedFrom.Count > 0 ? $" Restart running {string.Join(", ", result.RemovedFrom)} sessions." : "";
                if (!everything)
                {
                    await VS.MessageBox.ShowAsync("Vibe Review", $"Vibe Review removed from your agents.{restart} Run Tools > Vibe Review > Set Up Agents to add it back.", OLEMSGICON.OLEMSGICON_INFO, OLEMSGBUTTON.OLEMSGBUTTON_OK);
                    return;
                }
                await VS.MessageBox.ShowAsync(
                    "Vibe Review",
                    $"Vibe Review's agent setup and data are removed.{restart} To finish, uninstall \"Vibe Review\" in the Extension Manager that opens next, then restart Visual Studio.",
                    OLEMSGICON.OLEMSGICON_INFO,
                    OLEMSGBUTTON.OLEMSGBUTTON_OK);
                await VS.Commands.ExecuteAsync("Extensions.ManageExtensions");
            }
            catch (BridgeException ex)
            {
                await ReviewSession.ShowErrorAsync(ex);
            }
            finally
            {
                Session.RequestRefresh();
            }
        }

        /// <summary>Adds a comment on the selected lines of the active editor (also works in the right side of a diff).</summary>
        public static async Task AddCommentFromEditorAsync()
        {
            var target = await EditorSelection.GetAsync();
            if (target == null)
            {
                await VS.MessageBox.ShowWarningAsync("Vibe Review", "Put the cursor on a changed line of a file in this repository (or select lines), then try again.");
                return;
            }
            var (document, startLine, endLine, anchor) = target.Value;
            if (Session.RelativePath(document.FilePath) is not string rel)
            {
                await VS.MessageBox.ShowWarningAsync("Vibe Review", "Comments can only be added to files in the repository.");
                return;
            }
            if (document.IsDirty) document.Save();

            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var lines = startLine == endLine ? $"line {startLine + 1}" : $"lines {startLine + 1}–{endLine + 1}";
            var body = VibeDialog.AskComment($"Comment on {Path.GetFileName(rel)}, {lines}", "Your comment for the agent (saved as a draft until you submit the review):", "Add Comment");
            if (body == null) return;
            var id = await Session.RunAsync("create-thread", new { file = rel, startLine, endLine, anchor, body });
            if (id?.Type == JTokenType.String) await ToolWindow.ReviewToolWindow.ShowThreadAsync((string)id!);
        }

        /// <summary>Opens HEAD ↔ working tree for a changed file, optionally at a line.</summary>
        public static async Task OpenDiffAsync(ChangedFile file, int? line = null)
        {
            var root = Session.Root;
            if (root == null) return;
            try
            {
                var right = Session.FullPath(file.Path)!;
                var leftRel = file.Kind == "renamed" && !string.IsNullOrEmpty(file.OldPath) ? file.OldPath! : file.Path;
                var head = file.Kind == "untracked" || file.Kind == "added" ? "" : await NodeBridge.CallAsync<string>("head", new { root, file = Session.FullPath(leftRel) }) ?? "";
                var left = WriteHeadCopy(root, leftRel, head);

                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (file.Kind == "deleted")
                {
                    await VS.Documents.OpenAsync(left);
                    return;
                }
                var diff = await VS.GetRequiredServiceAsync<SVsDifferenceService, IVsDifferenceService>();
                var name = Path.GetFileName(file.Path);
                var frame = diff.OpenComparisonWindow2(
                    left,
                    right,
                    $"{name} (HEAD ↔ Working Tree)",
                    $"{file.Path}: HEAD ↔ Working Tree",
                    $"{leftRel} (HEAD)",
                    $"{file.Path} (Working Tree)",
                    $"{name} (HEAD ↔ Working Tree)",
                    null,
                    (uint)(__VSDIFFSERVICEOPTIONS.VSDIFFOPT_LeftFileIsTemporary | __VSDIFFSERVICEOPTIONS.VSDIFFOPT_DetectBinaryFiles));
                frame?.Show();
                if (frame != null && line.HasValue) GoToLine(frame, line.Value);
            }
            catch (BridgeException ex)
            {
                await ReviewSession.ShowErrorAsync(ex);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is System.Runtime.InteropServices.COMException)
            {
                // Fall back to the plain file.
                var path = Session.FullPath(file.Path);
                if (path != null && File.Exists(path)) await OpenFileAsync(path, line);
                else await VS.MessageBox.ShowErrorAsync("Vibe Review", ex.Message);
            }
        }

        public static async Task OpenFileAsync(string path, int? line)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var view = await VS.Documents.OpenAsync(path);
            if (view?.TextView == null || !line.HasValue) return;
            var snapshot = view.TextView.TextSnapshot;
            var target = snapshot.GetLineFromLineNumber(Math.Max(0, Math.Min(line.Value, snapshot.LineCount - 1)));
            MoveCaret(view.TextView, target.Start);
        }

        private static void GoToLine(IVsWindowFrame frame, int line)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (frame.GetProperty((int)__VSFPROPID.VSFPROPID_DocView, out var docView) != VSConstants.S_OK) return;
            if (!(docView is IVsDifferenceCodeWindow diffWindow) || diffWindow.DifferenceViewer is not IDifferenceViewer viewer) return;
            var snapshot = viewer.DifferenceBuffer.RightBuffer.CurrentSnapshot;
            var point = snapshot.GetLineFromLineNumber(Math.Max(0, Math.Min(line, snapshot.LineCount - 1))).Start;
            var view = viewer.ViewMode == DifferenceViewMode.Inline ? viewer.InlineView : viewer.RightView;
            if (view == null) return;
            var mapped = view.BufferGraph.MapUpToBuffer(point, PointTrackingMode.Positive, PositionAffinity.Successor, view.TextBuffer);
            if (mapped.HasValue) MoveCaret(view, mapped.Value);
        }

        private static void MoveCaret(ITextView view, SnapshotPoint point)
        {
            view.Caret.MoveTo(point);
            view.ViewScroller.EnsureSpanVisible(new SnapshotSpan(point, 0), EnsureSpanVisibleOptions.AlwaysCenter);
            (view as IWpfTextView)?.VisualElement.Focus();
        }

        /// <summary>Writes the HEAD version to a read-only temp file with the same name (for syntax highlighting).</summary>
        private static string WriteHeadCopy(string root, string rel, string content)
        {
            using var sha = SHA1.Create();
            var key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root + "\n" + rel))).Replace("-", "").Substring(0, 12);
            var dir = Path.Combine(Path.GetTempPath(), "VibeReview", key);
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, Path.GetFileName(rel.Replace('/', Path.DirectorySeparatorChar)));
            if (File.Exists(path)) File.SetAttributes(path, FileAttributes.Normal);
            File.WriteAllText(path, content, new UTF8Encoding(false));
            File.SetAttributes(path, FileAttributes.ReadOnly);
            return path;
        }
    }
}
