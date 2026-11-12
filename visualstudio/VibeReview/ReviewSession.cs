using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Imaging;
using Microsoft.Win32.SafeHandles;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VibeReview.Bridge;
using Task = System.Threading.Tasks.Task;

namespace VibeReview
{
    /// <summary>
    /// The review for the git repository containing the open solution or folder. Polls the shared
    /// store through the bridge, keeps the editor heartbeat fresh (agents only wait for a review
    /// while an editor is open on the repository) and notifies the UI when anything changes.
    /// </summary>
    public sealed class ReviewSession : IDisposable
    {
        /// <summary>Same cadence as the VS Code extension; agents treat a heartbeat older than 60s as gone.</summary>
        private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan ActivePoll = TimeSpan.FromSeconds(3);
        private static readonly TimeSpan IdlePoll = TimeSpan.FromSeconds(10);

        public static ReviewSession Instance { get; } = new ReviewSession();

        private readonly int _pid = Process.GetCurrentProcess().Id;
        private readonly SemaphoreSlim _wake = new SemaphoreSlim(0);
        private readonly SemaphoreSlim _tickLock = new SemaphoreSlim(1, 1);
        private readonly object _pollLock = new object();
        private CancellationTokenSource? _cts;
        private CancellationTokenSource _folderCts = new CancellationTokenSource();
        private AsyncPackage? _package;
        private string? _folder;
        private string? _resolvedFolder;
        private FileSystemWatcher? _watcher;
        private DateTime _lastBeat = DateTime.MinValue;
        private string? _lastJson;
        private int _folderGeneration;
        private Task _releaseTask = Task.CompletedTask;
        private int? _waitTimeoutMinutes;
        private string? _timeoutRoot;
        private int? _appliedTimeoutMinutes;
        private bool _disposed;
        private bool _wasWaiting;
        private InfoBar? _infoBar;

        private ReviewSession()
        {
        }

        /// <summary>Repository root, or null when no solution/folder in a git repository is open.</summary>
        public string? Root { get; private set; }

        /// <summary>Latest state, or null when there is no repository (or it couldn't be read).</summary>
        public ReviewState? State { get; private set; }

        /// <summary>Why the state couldn't be read (e.g. Node.js missing), if it couldn't.</summary>
        public string? Error { get; private set; }

        /// <summary>Raised on the UI thread whenever <see cref="Root"/>, <see cref="State"/> or <see cref="Error"/> change.</summary>
        public event EventHandler? Changed;

        public async Task StartAsync(AsyncPackage package)
        {
            _package = package;
            _cts = new CancellationTokenSource();
            VS.Events.SolutionEvents.OnAfterOpenSolution += _ => FolderChanged();
            VS.Events.SolutionEvents.OnAfterCloseSolution += FolderChanged;
            VS.Events.SolutionEvents.OnAfterOpenFolder += _ => FolderChanged();
            VS.Events.SolutionEvents.OnAfterCloseFolder += _ => FolderChanged();
            VS.Events.DocumentEvents.Saved += _ => RequestRefresh();
            VS.Events.ShellEvents.ShutdownStarted += Dispose;
            await UpdateFolderAsync();
            _ = Task.Run(() => LoopAsync(_cts.Token));
        }

        /// <summary>Asks for a refresh soon (coalesced with other requests).</summary>
        public void RequestRefresh()
        {
            if (_wake.CurrentCount == 0) _wake.Release();
        }

        /// <summary>Refreshes now and waits for it.</summary>
        public Task RefreshAsync() => TickAsync(_cts?.Token ?? CancellationToken.None);

        public void SetWaitTimeout(int minutes)
        {
            lock (_pollLock)
            {
                _waitTimeoutMinutes = Math.Max(1, Math.Min(55, minutes));
                _timeoutRoot = null;
                _appliedTimeoutMinutes = null;
            }
            RequestRefresh();
        }

        /// <summary>Calls the bridge for the current repository (adds "root"). Shows errors and returns null on failure.</summary>
        public async Task<JToken?> RunAsync(string command, object? args = null, bool refresh = true)
        {
            var root = Root;
            if (root == null)
            {
                await VS.MessageBox.ShowWarningAsync("Vibe Review", "Open a solution or folder inside a git repository to review your agent's changes.");
                return null;
            }
            try
            {
                var request = args == null ? new JObject() : JObject.FromObject(args);
                request["root"] = root;
                var result = await NodeBridge.CallAsync<JToken>(command, request);
                return result ?? JValue.CreateNull();
            }
            catch (BridgeException ex)
            {
                await ShowErrorAsync(ex);
                return null;
            }
            finally
            {
                if (refresh) await RefreshAsync();
            }
        }

        public static async Task ShowErrorAsync(Exception ex)
        {
            if (ex is BridgeException b && b.IsUserError) await VS.MessageBox.ShowWarningAsync("Vibe Review", ex.Message);
            else await VS.MessageBox.ShowErrorAsync("Vibe Review", ex.Message);
        }

        /// <summary>Absolute path of a repository-relative path.</summary>
        public string? FullPath(string relative) =>
            Root == null ? null : Path.GetFullPath(Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar)));

        /// <summary>Repository-relative, forward-slash path of an absolute path, or null when outside the repository.</summary>
        public string? RelativePath(string fullPath)
        {
            var root = Root;
            if (root == null || string.IsNullOrEmpty(fullPath)) return null;
            string full;
            try
            {
                full = CanonicalPath(fullPath);
                root = CanonicalPath(root);
            }
            catch (Exception ex) when (ex is ArgumentException || ex is NotSupportedException || ex is PathTooLongException)
            {
                return null;
            }
            var prefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
            return full.Substring(prefix.Length).Replace(Path.DirectorySeparatorChar, '/');
        }

        private static string CanonicalPath(string path)
        {
            path = Path.GetFullPath(path);
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return path;

            using (var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
            {
                if (handle.IsInvalid) return path;
                var buffer = new StringBuilder(32768);
                var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity) return path;
                var canonical = buffer.ToString();
                if (canonical.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                    return @"\\" + canonical.Substring(8);
                return canonical.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)
                    ? canonical.Substring(4)
                    : canonical;
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder filePath, uint filePathLength, uint flags);

        private void FolderChanged()
        {
            CancellationTokenSource oldPoll;
            int generation;
            string? previousRoot;
            Task precedingRelease;
            TaskCompletionSource<bool>? releaseGate = null;
            lock (_pollLock)
            {
                if (_disposed) return;
                generation = ++_folderGeneration;
                oldPoll = _folderCts;
                _folderCts = new CancellationTokenSource();

                previousRoot = Root;
                Root = null;
                State = null;
                Error = null;
                _lastJson = null;
                _folder = null;
                _resolvedFolder = null;
                _lastBeat = DateTime.MinValue;
                _wasWaiting = false;
                _timeoutRoot = null;
                _appliedTimeoutMinutes = null;
                _watcher?.Dispose();
                _watcher = null;
                precedingRelease = _releaseTask;
                if (previousRoot != null)
                {
                    releaseGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    _releaseTask = releaseGate.Task;
                }
            }
            oldPoll.Cancel();
            oldPoll.Dispose();
            if (previousRoot != null && releaseGate != null)
                _ = ReleaseAgentsAfterPollAsync(previousRoot, precedingRelease, releaseGate);
            _ = ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (generation != Volatile.Read(ref _folderGeneration)) return;
                Changed?.Invoke(this, EventArgs.Empty);
                CloseInfoBar();
                await UpdateFolderAsync(generation);
                RequestRefresh();
            });
        }

        private async Task UpdateFolderAsync(int? generation = null)
        {
            var expectedGeneration = generation ?? Volatile.Read(ref _folderGeneration);
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            string? folder = null;
            if (await VS.Services.GetSolutionAsync() is IVsSolution solution)
            {
                if (solution.GetProperty((int)__VSPROPID.VSPROPID_IsSolutionOpen, out var open) == 0 && open is bool isOpen && isOpen)
                {
                    if (solution.GetSolutionInfo(out var dir, out _, out _) == 0 && !string.IsNullOrEmpty(dir)) folder = dir;
                    // Open Folder mode: the "solution directory" is the opened folder.
                    else if (solution.GetProperty((int)__VSPROPID.VSPROPID_SolutionDirectory, out var sd) == 0 && sd is string s && s.Length > 0) folder = s;
                }
            }
            lock (_pollLock)
            {
                if (expectedGeneration != _folderGeneration) return;
                _folder = folder;
            }
        }

        private async Task LoopAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await TickAsync(ct);
                }
                catch (OperationCanceledException)
                {
                    if (ct.IsCancellationRequested) return;
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"Vibe Review: {ex}");
                }

                var state = State;
                var interval = state != null && state.StoreExists && (state.ModeOn || state.Agent.Waiting) ? ActivePoll : IdlePoll;
                try
                {
                    if (await _wake.WaitAsync(interval, ct))
                    {
                        // Coalesce bursts (file saves, watcher events).
                        await Task.Delay(250, ct);
                        while (_wake.CurrentCount > 0) await _wake.WaitAsync(ct);
                    }
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        private async Task TickAsync(CancellationToken ct)
        {
            CancellationTokenSource poll;
            int generation;
            Task releaseTask;
            lock (_pollLock)
            {
                generation = _folderGeneration;
                poll = CancellationTokenSource.CreateLinkedTokenSource(ct, _folderCts.Token);
                releaseTask = _releaseTask;
            }
            using (poll)
            {
                await releaseTask;
                poll.Token.ThrowIfCancellationRequested();
                await _tickLock.WaitAsync(poll.Token);
                try
                {
                    poll.Token.ThrowIfCancellationRequested();
                    await TickCoreAsync(poll.Token, generation);
                }
                finally
                {
                    _tickLock.Release();
                }
            }
        }

        private async Task TickCoreAsync(CancellationToken ct, int generation)
        {
            string? folder;
            lock (_pollLock)
            {
                if (generation != _folderGeneration) return;
                folder = _folder;
            }
            if (folder != _resolvedFolder)
            {
                string? root = null;
                string? error = null;
                if (folder != null)
                {
                    try
                    {
                        root = await NodeBridge.CallAsync<string?>("root", new { path = folder }, ct);
                    }
                    catch (BridgeException ex)
                    {
                        error = ex.Message;
                    }
                }
                lock (_pollLock)
                {
                    if (generation != _folderGeneration) return;
                    if (error == null && (root != null || folder == null)) _resolvedFolder = folder;
                    SwitchRoot(root);
                }
                if (error != null)
                {
                    await PublishAsync(null, null, error, generation);
                    return;
                }
            }

            var current = Root;
            if (current == null)
            {
                await PublishAsync(null, null, null, generation);
                return;
            }

            ReviewState? state;
            JToken token;
            try
            {
                var beat = DateTime.UtcNow - _lastBeat >= HeartbeatInterval;
                token = beat
                    ? await NodeBridge.CallAsync<JToken>("state", new { root = current, pid = _pid }, ct)
                    : await NodeBridge.CallAsync<JToken>("state", new { root = current }, ct);
                state = token.ToObject<ReviewState>();
                if (beat && state?.StoreExists == true)
                {
                    lock (_pollLock)
                    {
                        if (generation != _folderGeneration) return;
                        _lastBeat = DateTime.UtcNow;
                    }
                }
            }
            catch (BridgeException ex)
            {
                await PublishAsync(null, null, ex.Message, generation);
                return;
            }
            if (generation != Volatile.Read(ref _folderGeneration) || Root != current) return;
            int? timeout;
            bool applyTimeout;
            lock (_pollLock)
            {
                timeout = _waitTimeoutMinutes;
                applyTimeout = state?.StoreExists == true && timeout.HasValue &&
                    (!string.Equals(_timeoutRoot, current, StringComparison.OrdinalIgnoreCase) || _appliedTimeoutMinutes != timeout);
            }
            if (applyTimeout)
            {
                try
                {
                    await NodeBridge.CallAsync<JToken>("set-timeout", new { root = current, waitTimeoutMinutes = timeout }, ct);
                }
                catch (BridgeException ex)
                {
                    if (generation == Volatile.Read(ref _folderGeneration))
                        await PublishAsync(null, null, ex.Message, generation);
                    return;
                }
                lock (_pollLock)
                {
                    if (generation != _folderGeneration) return;
                    _timeoutRoot = current;
                    _appliedTimeoutMinutes = timeout;
                }
            }
            await PublishAsync(state, token.ToString(Formatting.None), null, generation);
        }

        private async Task PublishAsync(ReviewState? state, string? json, string? error, int generation)
        {
            var key = (json ?? "") + "|" + (Root ?? "") + "|" + (error ?? "");
            lock (_pollLock)
            {
                if (generation != _folderGeneration || key == _lastJson) return;
                _lastJson = key;
                State = state;
                Error = error;
            }

            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (generation != Volatile.Read(ref _folderGeneration)) return;
            Changed?.Invoke(this, EventArgs.Empty);

            var waiting = state?.Agent.Waiting == true;
            if (waiting && !_wasWaiting) await ShowWaitingInfoBarAsync(state!.Agent.Name);
            if (!waiting) CloseInfoBar();
            _wasWaiting = waiting;
        }

        private void SwitchRoot(string? root)
        {
            if (string.Equals(root, Root, StringComparison.OrdinalIgnoreCase)) return;
            _watcher?.Dispose();
            _watcher = null;
            Root = root;
            _lastBeat = DateTime.MinValue;
            _timeoutRoot = null;
            _appliedTimeoutMinutes = null;
            if (root == null) return;
            try
            {
                _watcher = new FileSystemWatcher(root)
                {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                    InternalBufferSize = 64 * 1024,
                };
                _watcher.Changed += OnFileEvent;
                _watcher.Created += OnFileEvent;
                _watcher.Deleted += OnFileEvent;
                _watcher.Renamed += OnFileEvent;
                _watcher.Error += (_, __) => RequestRefresh();
                _watcher.EnableRaisingEvents = true;
            }
            catch (Exception ex) when (ex is ArgumentException || ex is IOException || ex is UnauthorizedAccessException)
            {
                // Polling still picks up changes.
                _watcher = null;
            }
        }

        private void OnFileEvent(object sender, FileSystemEventArgs e)
        {
            var path = e.FullPath;
            var sep = Path.DirectorySeparatorChar;
            // Git internals change on every status call; our heartbeat must not cause a refresh either.
            if (path.IndexOf($"{sep}.git{sep}", StringComparison.OrdinalIgnoreCase) >= 0 || path.EndsWith($"{sep}.git", StringComparison.OrdinalIgnoreCase)) return;
            if (path.IndexOf($"{sep}node_modules{sep}", StringComparison.OrdinalIgnoreCase) >= 0) return;
            if (path.IndexOf($"{sep}.vs{sep}", StringComparison.OrdinalIgnoreCase) >= 0) return;
            if (Path.GetFileName(path).StartsWith("editor.json", StringComparison.OrdinalIgnoreCase)) return;
            RequestRefresh();
        }

        private async Task ShowWaitingInfoBarAsync(string agentName)
        {
            CloseInfoBar();
            var model = new InfoBarModel(
                new[] { new InfoBarTextSpan($"{agentName} finished and is waiting for your review.  ") },
                new[] { new InfoBarHyperlink("Open Vibe Review", "open"), new InfoBarHyperlink("Approve", "approve") },
                KnownMonikers.StatusInformation,
                isCloseButtonVisible: true);
            var bar = await VS.InfoBar.CreateAsync(model);
            if (bar == null) return;
            bar.ActionItemClicked += (_, e) =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var action = e.ActionItem.ActionContext as string;
                ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
                {
                    if (action == "open") await ToolWindow.ReviewToolWindow.ShowAsync();
                    else if (action == "approve") await Actions.ApproveAsync();
                }).FireAndForget();
                e.InfoBarUIElement.Close();
            };
            if (await bar.TryShowInfoBarUIAsync()) _infoBar = bar;
            await VS.StatusBar.ShowMessageAsync($"Vibe Review: {agentName} is waiting for your review");
        }

        private void CloseInfoBar()
        {
            try
            {
                _infoBar?.Close();
            }
            catch (InvalidOperationException)
            {
            }
            _infoBar = null;
        }

        /// <summary>Tells agents this editor is gone so they stop waiting for a review.</summary>
        private async Task ReleaseAgentsAfterPollAsync(string root, Task precedingRelease, TaskCompletionSource<bool> releaseGate)
        {
            try
            {
#pragma warning disable VSTHRD003 // This chained cleanup task is awaited without capturing the UI context.
                await precedingRelease.ConfigureAwait(false);
#pragma warning restore VSTHRD003
                await _tickLock.WaitAsync().ConfigureAwait(false);
                try
                {
                    await NodeBridge.CallAsync<JToken>("editor-closed", new { root, pid = _pid }, timeoutMs: 5000).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // Best effort: a stale heartbeat expires on its own.
                }
                finally
                {
                    _tickLock.Release();
                }
            }
            catch (Exception)
            {
                // Best effort: a stale heartbeat expires on its own.
            }
            finally
            {
                releaseGate.TrySetResult(true);
            }
        }

        public void Dispose()
        {
            CancellationTokenSource folderCts;
            string? root;
            Task precedingRelease;
            TaskCompletionSource<bool>? releaseGate = null;
            lock (_pollLock)
            {
                if (_disposed) return;
                _disposed = true;
                _cts?.Cancel();
                _cts = null;
                folderCts = _folderCts;
                root = Root;
                Root = null;
                State = null;
                Error = null;
                _folderGeneration++;
                precedingRelease = _releaseTask;
                if (root != null)
                {
                    releaseGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    _releaseTask = releaseGate.Task;
                }
            }
            folderCts.Cancel();
            folderCts.Dispose();
            _watcher?.Dispose();
            _watcher = null;
            if (root != null && releaseGate != null)
                _ = ReleaseAgentsAfterPollAsync(root, precedingRelease, releaseGate);
        }

        /// <summary>Threads on a file, by absolute path.</summary>
        public ThreadInfo[] ThreadsFor(string fullPath)
        {
            var rel = RelativePath(fullPath);
            var state = State;
            if (rel == null || state == null) return Array.Empty<ThreadInfo>();
            return state.Threads.Where(t => string.Equals(t.File, rel, StringComparison.OrdinalIgnoreCase)).ToArray();
        }
    }
}
