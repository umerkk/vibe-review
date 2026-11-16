using System;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace VibeReview.Commands
{
    // Menu commands (Tools > Vibe Review, View > Other Windows, editor context menu). See VSCommandTable.vsct.

    [Command(PackageGuids.CommandSetString, PackageIds.ShowToolWindow)]
    internal sealed class ShowToolWindowCommand : BaseCommand<ShowToolWindowCommand>
    {
        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => ToolWindow.ReviewToolWindow.ShowAsync();
    }

    /// <summary>Commands that need a repository: disabled while no solution/folder in a git repository is open.</summary>
    internal abstract class ReviewCommand<T> : BaseCommand<T> where T : class, new()
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = ReviewSession.Instance.State != null;
    }

    [Command(PackageGuids.CommandSetString, PackageIds.Submit)]
    internal sealed class SubmitCommand : ReviewCommand<SubmitCommand>
    {
        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Actions.SubmitAsync();
    }

    [Command(PackageGuids.CommandSetString, PackageIds.Approve)]
    internal sealed class ApproveCommand : ReviewCommand<ApproveCommand>
    {
        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Actions.ApproveAsync();
    }

    [Command(PackageGuids.CommandSetString, PackageIds.Discard)]
    internal sealed class DiscardCommand : ReviewCommand<DiscardCommand>
    {
        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Actions.DiscardAsync();
    }

    [Command(PackageGuids.CommandSetString, PackageIds.ToggleMode)]
    internal sealed class ToggleModeCommand : ReviewCommand<ToggleModeCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e)
        {
            base.BeforeQueryStatus(e);
            var on = ReviewSession.Instance.State?.ModeOn == true;
            Command.Text = on ? "Turn Review Mode Off" : "Turn Review Mode On";
            Command.Checked = on;
        }

        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Actions.ToggleModeAsync();
    }

    [Command(PackageGuids.CommandSetString, PackageIds.Refresh)]
    internal sealed class RefreshCommand : BaseCommand<RefreshCommand>
    {
        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => ReviewSession.Instance.RefreshAsync();
    }

    [Command(PackageGuids.CommandSetString, PackageIds.AddComment)]
    internal sealed class AddCommentCommand : BaseCommand<AddCommentCommand>
    {
        /// <summary>Shown in the editor context menu only for files in the reviewed repository.</summary>
        protected override void BeforeQueryStatus(EventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var visible = false;
            if (ReviewSession.Instance.State != null)
            {
                var view = ThreadHelper.JoinableTaskFactory.Run(() => VS.Documents.GetActiveDocumentViewAsync());
                visible = view?.TextView != null && EditorSelection.Get(view.TextView) != null;
            }
            Command.Visible = Command.Enabled = visible;
        }

        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Actions.AddCommentFromEditorAsync();
    }

    [Command(PackageGuids.CommandSetString, PackageIds.SetupAgents)]
    internal sealed class SetupAgentsCommand : BaseCommand<SetupAgentsCommand>
    {
        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Actions.SetupAgentsAsync();
    }

    [Command(PackageGuids.CommandSetString, PackageIds.Uninstall)]
    internal sealed class UninstallCommand : BaseCommand<UninstallCommand>
    {
        protected override Task ExecuteAsync(OleMenuCmdEventArgs e) => Actions.UninstallAsync();
    }
}
