using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace VibeReview.ToolWindow
{
    /// <summary>View &gt; Other Windows &gt; Vibe Review: changed files, comment threads and review actions.</summary>
    public class ReviewToolWindow : BaseToolWindow<ReviewToolWindow>
    {
        public override string GetTitle(int toolWindowId) => "Vibe Review";

        public override Type PaneType => typeof(Pane);

        public override Task<FrameworkElement> CreateAsync(int toolWindowId, CancellationToken cancellationToken) =>
            Task.FromResult<FrameworkElement>(new ReviewControl(ReviewSession.Instance));

        public static async Task ShowAsync() => await ShowAsync(0, true);

        /// <summary>Shows the tool window with a thread selected.</summary>
        public static async Task ShowThreadAsync(string threadId)
        {
            await ShowAsync(0, true);
            await ReviewSession.Instance.RefreshAsync();
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            ReviewControl.Current?.SelectThread(threadId);
        }

        [Guid(PackageGuids.ToolWindowString)]
        internal class Pane : ToolkitToolWindowPane
        {
            public Pane()
            {
                BitmapImageMoniker = KnownMonikers.CodeReview;
            }
        }
    }
}
