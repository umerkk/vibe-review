using System;
using System.Runtime.InteropServices;
using System.Threading;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json.Linq;
using VibeReview.Bridge;
using VibeReview.ToolWindow;
using Task = System.Threading.Tasks.Task;

namespace VibeReview
{
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [InstalledProductRegistration(Vsix.Name, Vsix.Description, Vsix.Version)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [Guid(PackageGuids.PackageString)]
    // Load in the background whenever a solution or folder is open: agents only wait for a review while an editor is open on the repository.
    [ProvideAutoLoad(VSConstants.UICONTEXT.SolutionExists_string, PackageAutoLoadFlags.BackgroundLoad)]
    [ProvideAutoLoad(VSConstants.UICONTEXT.FolderOpened_string, PackageAutoLoadFlags.BackgroundLoad)]
    [ProvideToolWindow(typeof(ReviewToolWindow.Pane), Style = VsDockStyle.Tabbed, Window = WindowGuids.SolutionExplorer)]
    [ProvideOptionPage(typeof(OptionsProvider.GeneralOptions), "Vibe Review", "General", 0, 0, true, SupportsProfiles = true)]
    public sealed class VibeReviewPackage : ToolkitPackage
    {
        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            await this.RegisterCommandsAsync();
            this.RegisterToolWindows();

            var options = await General.GetLiveInstanceAsync();
            NodeBridge.ConfiguredNodePath = options.NodePath;
            General.Saved += OnOptionsSaved;

            await ReviewSession.Instance.StartAsync(this);
            // Keep an installed hook/MCP runtime in sync with this extension version (as the VS Code extension does).
            _ = Task.Run(async () =>
            {
                try
                {
                    await NodeBridge.CallAsync<JToken>("sync-runtime");
                }
                catch (BridgeException)
                {
                    // Non-fatal: the previously installed runtime keeps working; Node.js problems show in the tool window.
                }
            });
        }

        private void OnOptionsSaved(General options)
        {
            NodeBridge.ConfiguredNodePath = options.NodePath;
            var session = ReviewSession.Instance;
            if (session.State?.StoreExists == true)
            {
                JoinableTaskFactory.RunAsync(() => session.RunAsync("set-timeout", new { waitTimeoutMinutes = options.EffectiveWaitTimeoutMinutes })).FireAndForget();
            }
            else
            {
                session.RequestRefresh();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                General.Saved -= OnOptionsSaved;
                ReviewSession.Instance.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
