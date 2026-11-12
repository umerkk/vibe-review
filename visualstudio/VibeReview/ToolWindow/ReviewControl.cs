using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using VibeReview.Bridge;
using Task = System.Threading.Tasks.Task;

namespace VibeReview.ToolWindow
{
    /// <summary>
    /// The Vibe Review tool window: review actions, a status banner, changed files with their
    /// comment threads, and the selected thread's conversation with reply/resolve actions.
    /// The VS Code extension shows the same information in its Changes view, status bar and inline comment threads.
    /// </summary>
    public sealed class ReviewControl : UserControl
    {
        private static readonly Dictionary<string, string> KindLetter = new Dictionary<string, string>
        {
            ["modified"] = "M",
            ["added"] = "A",
            ["deleted"] = "D",
            ["renamed"] = "R",
            ["untracked"] = "U",
        };

        private readonly ReviewSession _session;
        private readonly Button _submit;
        private readonly Button _approve;
        private readonly Button _discard;
        private readonly Button _mode;
        private readonly TextBlock _banner = new TextBlock { TextWrapping = TextWrapping.Wrap };
        private readonly Border _bannerBorder;
        private readonly TreeView _tree = new TreeView { BorderThickness = new Thickness(0) };
        private readonly TextBlock _empty = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(8), Visibility = Visibility.Collapsed };
        private readonly StackPanel _detail = new StackPanel { Margin = new Thickness(8) };
        private readonly HashSet<string> _collapsed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _editingComments = new HashSet<string>();
        private readonly Dictionary<string, string> _replyDrafts = new Dictionary<string, string>();
        private readonly Dictionary<string, string> _editDrafts = new Dictionary<string, string>();
        private string? _selectedThreadId;
        private string? _renderedThreadKey;
        private CommentTextBox? _reply;
        private string? _replyThreadId;
        private string? _replyRoot;
        private readonly Dictionary<string, CommentTextBox> _editingBoxes = new Dictionary<string, CommentTextBox>();

        public ReviewControl(ReviewSession session)
        {
            _session = session;
            Current = this;
            Themes.SetUseVsTheme(this, true);

            var toolbar = new WrapPanel { Margin = new Thickness(4, 4, 4, 0) };
            _submit = AddButton(toolbar, "Submit Review", "Send your comments to the agent", () => Actions.SubmitAsync());
            _approve = AddButton(toolbar, "Approve", "Let the agent stop", () => Actions.ApproveAsync());
            _discard = AddButton(toolbar, "Discard", "Discard your pending comments", () => Actions.DiscardAsync());
            _mode = AddButton(toolbar, "Review Mode: Off", "", () => Actions.ToggleModeAsync());
            AddButton(toolbar, "Refresh", "Refresh", () => _session.RefreshAsync());
            AddButton(toolbar, "Set Up Agents…", "Install the hooks + MCP server for Claude Code, Codex CLI or GitHub Copilot CLI", () => Actions.SetupAgentsAsync());

            _bannerBorder = new Border { Padding = new Thickness(8, 5, 8, 5), Margin = new Thickness(4), Child = _banner, BorderThickness = new Thickness(1) };
            _bannerBorder.SetResourceReference(Border.BorderBrushProperty, EnvironmentColors.ToolWindowBorderBrushKey);

            _tree.SelectedItemChanged += (_, __) => OnSelectionChanged();
            _tree.MouseDoubleClick += OnTreeDoubleClick;
            _tree.KeyDown += (_, e) =>
            {
                if (e.Key == Key.Enter) OpenSelected();
            };

            var detailScroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Content = _detail };

            var split = new Grid();
            split.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star), MinHeight = 60 });
            split.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            split.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1.3, GridUnitType.Star), MinHeight = 80 });
            var treeHost = new Grid();
            treeHost.Children.Add(_tree);
            treeHost.Children.Add(_empty);
            Grid.SetRow(treeHost, 0);
            var splitter = new GridSplitter { Height = 5, HorizontalAlignment = HorizontalAlignment.Stretch, ResizeDirection = GridResizeDirection.Rows };
            splitter.SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBorderBrushKey);
            Grid.SetRow(splitter, 1);
            Grid.SetRow(detailScroll, 2);
            split.Children.Add(treeHost);
            split.Children.Add(splitter);
            split.Children.Add(detailScroll);

            var root = new DockPanel();
            DockPanel.SetDock(toolbar, Dock.Top);
            DockPanel.SetDock(_bannerBorder, Dock.Top);
            root.Children.Add(toolbar);
            root.Children.Add(_bannerBorder);
            root.Children.Add(split);
            Content = root;
            SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);
            SetResourceReference(ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);

            _session.Changed += OnSessionChanged;
            Unloaded += (_, __) => _session.Changed -= OnSessionChanged;
            Loaded += (_, __) =>
            {
                _session.Changed -= OnSessionChanged;
                _session.Changed += OnSessionChanged;
                Render();
                _session.RequestRefresh();
            };
            Render();
        }

        /// <summary>The live tool window content, if created.</summary>
        public static ReviewControl? Current { get; private set; }

        public void SelectThread(string threadId)
        {
            _selectedThreadId = threadId;
            Render();
            var item = AllItems().FirstOrDefault(i => i.Tag is ThreadInfo t && t.Id == threadId);
            if (item != null)
            {
                if (item.Parent is TreeViewItem parent) parent.IsExpanded = true;
                item.IsSelected = true;
                item.BringIntoView();
            }
            _reply?.Focus();
        }

        private void OnSessionChanged(object sender, EventArgs e) => Render();

        private Button AddButton(Panel panel, string label, string tooltip, Func<Task> action)
        {
            var button = new Button { Content = label, Margin = new Thickness(0, 0, 4, 4), Padding = new Thickness(8, 2, 8, 2) };
            if (!string.IsNullOrEmpty(tooltip)) button.ToolTip = tooltip;
            button.Click += (_, __) => Run(action);
            panel.Children.Add(button);
            return button;
        }

        private static void Run(Func<Task> action) =>
            ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                try
                {
                    await action();
                }
                catch (Exception ex)
                {
                    await ReviewSession.ShowErrorAsync(ex);
                }
            }).FireAndForget();

        private void Render()
        {
            var state = _session.State;
            var enabled = state != null;
            _submit.IsEnabled = _approve.IsEnabled = _discard.IsEnabled = _mode.IsEnabled = enabled;
            _mode.Content = state?.ModeOn == true ? "Review Mode: On" : "Review Mode: Off";
            _mode.ToolTip = state?.ModeOn == true ? "Turn Review Mode off: agents stop normally" : "Turn Review Mode on: agents wait for your review after each turn";
            _submit.Content = state != null && state.DraftCount > 0 ? $"Submit Review ({state.DraftCount})" : "Submit Review";
            RenderBanner(state);
            RenderTree(state);
            RenderDetail(state);
        }

        private void RenderBanner(ReviewState? state)
        {
            _banner.Inlines.Clear();
            if (_session.Error != null)
            {
                _banner.Text = _session.Error;
                _bannerBorder.SetResourceReference(Border.BackgroundProperty, VsBrushes.InfoBackgroundKey);
                _banner.SetResourceReference(TextBlock.ForegroundProperty, VsBrushes.InfoTextKey);
                return;
            }
            _banner.SetResourceReference(TextBlock.ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            _bannerBorder.Background = Brushes.Transparent;
            if (state == null)
            {
                _banner.Text = _session.Root == null
                    ? "Open a solution or folder inside a git repository to review your agent's uncommitted changes."
                    : "Loading…";
                return;
            }

            var waitingOnAgent = state.Threads.Count(t => t.State == "pending" && !t.HasDraft);
            var active = state.Threads.Count(t => t.State == "active");
            var parts = new List<string>();
            if (state.Agent.Waiting)
            {
                parts.Add($"🔔 {state.Agent.Name} is waiting for your review. Submit, Approve or Discard to let it continue.");
                _bannerBorder.SetResourceReference(Border.BackgroundProperty, VsBrushes.InfoBackgroundKey);
                _banner.SetResourceReference(TextBlock.ForegroundProperty, VsBrushes.InfoTextKey);
            }
            else
            {
                parts.Add(state.ModeOn
                    ? "Review Mode is on: agents wait for your review after each turn."
                    : "Review Mode is off: agents stop normally. Comments are picked up on their next turn.");
            }
            if (state.DraftCount > 0) parts.Add($"✎ {state.DraftCount} draft comment(s), not submitted yet.");
            if (waitingOnAgent > 0) parts.Add($"● {waitingOnAgent} pending thread(s) submitted and waiting for the agent.");
            if (active > 0) parts.Add($"◐ {active} active thread(s): the agent replied. Resolve to accept, or reply.");
            if (state.Undelivered) parts.Add("✉ A submitted review hasn't been picked up yet. Send any message in the agent's terminal (e.g. \"review\").");
            if (state.ModeOn && !state.RuntimeInstalled) parts.Add("No agent hooks are installed yet: use Set Up Agents.");
            _banner.Text = string.Join(Environment.NewLine, parts);
        }

        private IEnumerable<TreeViewItem> AllItems() =>
            _tree.Items.OfType<TreeViewItem>().SelectMany(f => new[] { f }.Concat(f.Items.OfType<TreeViewItem>()));

        private void RenderTree(ReviewState? state)
        {
            _tree.Items.Clear();
            if (state == null)
            {
                _empty.Visibility = Visibility.Collapsed;
                return;
            }

            var files = state.Files.ToList();
            // Threads on files that are no longer changed stay reachable.
            foreach (var orphan in state.Threads.Select(t => t.File).Distinct().Where(f => files.All(c => c.Path != f)).ToList())
            {
                files.Add(new ChangedFile { Path = orphan, Kind = "" });
            }
            _empty.Text = "No uncommitted changes. When your agent edits files, they show up here for review.";
            _empty.Visibility = files.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

            foreach (var file in files)
            {
                var threads = state.Threads.Where(t => t.File == file.Path).OrderBy(t => t.StartLine).ToList();
                var fileItem = new TreeViewItem
                {
                    Tag = file,
                    Header = FileHeader(file, threads),
                    ToolTip = file.Kind.Length > 0 ? $"{file.Path} ({file.Kind}). Double-click to open the diff." : $"{file.Path} (no uncommitted changes)",
                    IsExpanded = !_collapsed.Contains(file.Path),
                };
                fileItem.Expanded += (_, e) =>
                {
                    if (e.OriginalSource == fileItem) _collapsed.Remove(file.Path);
                };
                fileItem.Collapsed += (_, e) =>
                {
                    if (e.OriginalSource == fileItem) _collapsed.Add(file.Path);
                };
                foreach (var thread in threads)
                {
                    var threadItem = new TreeViewItem { Tag = thread, Header = ThreadHeader(thread), ToolTip = thread.Label };
                    fileItem.Items.Add(threadItem);
                    if (thread.Id == _selectedThreadId) threadItem.IsSelected = true;
                }
                _tree.Items.Add(fileItem);
            }
        }

        private static object FileHeader(ChangedFile file, List<ThreadInfo> threads)
        {
            var panel = new StackPanel { Orientation = Orientation.Horizontal };
            panel.Children.Add(new TextBlock { Text = System.IO.Path.GetFileName(file.Path), FontWeight = FontWeights.SemiBold });
            var dir = System.IO.Path.GetDirectoryName(file.Path.Replace('/', System.IO.Path.DirectorySeparatorChar))?.Replace(System.IO.Path.DirectorySeparatorChar, '/');
            var pending = threads.Count(t => t.State == "pending");
            var active = threads.Count(t => t.State == "active");
            var letter = KindLetter.TryGetValue(file.Kind, out var l) ? l : "·";
            var description = string.Join("  ", new[] { letter, dir ?? "", pending > 0 ? $"● {pending}" : "", active > 0 ? $"◐ {active}" : "" }.Where(s => s.Length > 0));
            panel.Children.Add(new TextBlock { Text = "  " + description, Opacity = 0.7 });
            return panel;
        }

        private static object ThreadHeader(ThreadInfo thread)
        {
            var panel = new StackPanel { Orientation = Orientation.Horizontal };
            panel.Children.Add(StateDot(thread));
            var first = thread.Comments.FirstOrDefault()?.Body.Split('\n')[0].Trim() ?? "(empty)";
            if (first.Length > 80) first = first.Substring(0, 80) + "…";
            panel.Children.Add(new TextBlock { Text = first, Margin = new Thickness(4, 0, 0, 0) });
            var word = thread.State == "pending" ? (thread.HasDraft ? "pending · not submitted" : "pending") : thread.State;
            panel.Children.Add(new TextBlock { Text = $"  L{thread.StartLine + 1} · {word}", Opacity = 0.7 });
            return panel;
        }

        /// <summary>Same colors as the editor glyphs: yellow pending, blue active, green resolved.</summary>
        internal static Brush StateBrush(string state) => state switch
        {
            "resolved" => new SolidColorBrush(Color.FromRgb(0x3F, 0xB9, 0x50)),
            "active" => new SolidColorBrush(Color.FromRgb(0x37, 0x94, 0xFF)),
            _ => new SolidColorBrush(Color.FromRgb(0xE2, 0xA0, 0x1F)),
        };

        private static FrameworkElement StateDot(ThreadInfo thread)
        {
            var dot = new Ellipse { Width = 9, Height = 9, Fill = StateBrush(thread.State), VerticalAlignment = VerticalAlignment.Center };
            if (thread.HasDraft && thread.State == "pending")
            {
                dot.Fill = Brushes.Transparent;
                dot.Stroke = StateBrush(thread.State);
                dot.StrokeThickness = 1.5;
            }
            return dot;
        }

        private ThreadInfo? SelectedThread =>
            _selectedThreadId == null ? null : _session.State?.Threads.FirstOrDefault(t => t.Id == _selectedThreadId);

        private void OnSelectionChanged()
        {
            if (_tree.SelectedItem is TreeViewItem item && item.Tag is ThreadInfo thread)
            {
                if (_selectedThreadId == thread.Id) return;
                _selectedThreadId = thread.Id;
                RenderDetail(_session.State);
            }
        }

        private void OnTreeDoubleClick(object sender, MouseButtonEventArgs e)
        {
            if (!(e.OriginalSource is DependencyObject source)) return;
            // Only react to double-clicks on an item's header.
            while (source != null && !(source is TreeViewItem)) source = VisualTreeHelper.GetParent(source);
            if (source is TreeViewItem item && item.IsSelected)
            {
                e.Handled = true;
                OpenSelected();
            }
        }

        private void OpenSelected()
        {
            if (!(_tree.SelectedItem is TreeViewItem item)) return;
            var state = _session.State;
            if (state == null) return;
            switch (item.Tag)
            {
                case ChangedFile file when file.Kind.Length > 0:
                    Run(() => Actions.OpenDiffAsync(file));
                    break;
                case ChangedFile file:
                    Run(() => Actions.OpenFileAsync(_session.FullPath(file.Path)!, null));
                    break;
                case ThreadInfo thread:
                    var changed = state.Files.FirstOrDefault(f => f.Path == thread.File);
                    if (changed != null && changed.Kind != "deleted") Run(() => Actions.OpenDiffAsync(changed, thread.StartLine));
                    else if (changed == null) Run(() => Actions.OpenFileAsync(_session.FullPath(thread.File)!, thread.StartLine));
                    else Run(() => Actions.OpenDiffAsync(changed));
                    break;
            }
        }

        private void RenderDetail(ReviewState? state)
        {
            var thread = SelectedThread;
            CaptureDrafts();
            // Re-rendering would wipe what the user is typing: only do it when the thread changed.
            var root = _session.Root ?? "";
            var key = root + "|" + (thread == null ? "" : Newtonsoft.Json.JsonConvert.SerializeObject(thread));
            if (key == _renderedThreadKey && _detail.Children.Count > 0) return;
            _renderedThreadKey = key;
            _detail.Children.Clear();
            _reply = null;
            _replyThreadId = null;
            _replyRoot = null;
            _editingBoxes.Clear();

            if (state == null) return;
            if (thread == null)
            {
                _detail.Children.Add(new TextBlock
                {
                    TextWrapping = TextWrapping.Wrap,
                    Opacity = 0.8,
                    Text = "Select a comment thread to read and reply.\n\nTo comment: double-click a file to open its diff, select changed lines (in the working-tree side) and choose \"Vibe Review: Add Comment\" from the editor's right-click menu. "
                        + "Comments are drafts until you Submit Review.",
                });
                return;
            }

            var header = new DockPanel { Margin = new Thickness(0, 0, 0, 6) };
            var title = new TextBlock { TextWrapping = TextWrapping.Wrap, FontWeight = FontWeights.SemiBold };
            var location = thread.StartLine == thread.EndLine ? $"line {thread.StartLine + 1}" : $"lines {thread.StartLine + 1}–{thread.EndLine + 1}";
            var link = new Hyperlink(new Run($"{thread.File}, {location}"));
            link.Click += (_, __) => OpenSelectedThread(thread);
            title.Inlines.Add(link);
            header.Children.Add(title);
            _detail.Children.Add(header);

            var status = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 8) };
            status.Children.Add(StateDot(thread));
            status.Children.Add(new TextBlock { Text = thread.Label, Margin = new Thickness(6, 0, 0, 0), TextWrapping = TextWrapping.Wrap });
            _detail.Children.Add(status);

            foreach (var comment in thread.Comments) _detail.Children.Add(CommentView(thread, comment));

            var actions = new WrapPanel { Margin = new Thickness(0, 4, 0, 0) };
            var replyKey = ReplyDraftKey(root, thread.Id);
            _replyDrafts.TryGetValue(replyKey, out var draftReply);
            _reply = new CommentTextBox { Text = draftReply ?? "", Margin = new Thickness(0, 6, 0, 4) };
            _replyThreadId = thread.Id;
            _replyRoot = root;
            _reply.SubmitRequested += (_, __) => SendReply(thread);
            _detail.Children.Add(new TextBlock { Text = "Reply", FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 8, 0, 0) });
            _detail.Children.Add(_reply);
            AddButton(actions, "Reply", "Add a draft reply (Ctrl+Enter). Sent with your next review.", () =>
            {
                SendReply(thread);
                return Task.CompletedTask;
            });
            if (thread.Status == "resolved")
                AddButton(actions, "Reopen", "Reopen this thread", () => _session.RunAsync("set-status", new { threadId = thread.Id, status = "open" }));
            else
                AddButton(actions, "Resolve", "Accept the agent's change and resolve this thread", () => _session.RunAsync("set-status", new { threadId = thread.Id, status = "resolved" }));
            AddButton(actions, "Delete Thread", "Delete this thread", async () =>
            {
                if (Dialogs.VibeDialog.Choose("Vibe Review", "Delete this comment thread?", null, "Delete") == null) return;
                _selectedThreadId = null;
                await _session.RunAsync("delete-thread", new { threadId = thread.Id });
            });
            _detail.Children.Add(actions);
        }

        private void OpenSelectedThread(ThreadInfo thread)
        {
            _selectedThreadId = thread.Id;
            var item = AllItems().FirstOrDefault(i => i.Tag is ThreadInfo t && t.Id == thread.Id);
            if (item != null) item.IsSelected = true;
            OpenSelected();
        }

        private void SendReply(ThreadInfo thread)
        {
            var box = _reply;
            if (box == null || box.Text.Trim().Length == 0) return;
            var body = box.Text.Trim();
            var root = _replyRoot ?? _session.Root ?? "";
            var key = ReplyDraftKey(root, thread.Id);
            Run(async () =>
            {
                if (_session.Root != root) return;
                var result = await _session.RunAsync("reply", new { threadId = thread.Id, body });
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                if (result == null) return;
                CaptureDrafts();
                var currentText = _replyRoot == root && _replyThreadId == thread.Id && _reply != null
                    ? _reply.Text
                    : _replyDrafts.TryGetValue(key, out var savedDraft) ? savedDraft : null;
                if (currentText?.Trim() == body)
                {
                    if (_replyRoot == root && _replyThreadId == thread.Id && _reply != null) _reply.Text = "";
                    _replyDrafts.Remove(key);
                }
            });
        }

        private void CaptureDrafts()
        {
            if (_reply != null && _replyThreadId != null && _replyRoot != null)
                _replyDrafts[ReplyDraftKey(_replyRoot, _replyThreadId)] = _reply.Text;
            foreach (var editor in _editingBoxes)
                if (_editingComments.Contains(editor.Key))
                    _editDrafts[editor.Key] = editor.Value.Text;
        }

        private static string ReplyDraftKey(string root, string threadId) => root + "\0" + threadId;

        private static string EditDraftKey(string root, string threadId, string commentId) => root + "\0" + threadId + "\0" + commentId;

        private FrameworkElement CommentView(ThreadInfo thread, CommentInfo comment)
        {
            var card = new Border { Padding = new Thickness(8, 6, 8, 6), Margin = new Thickness(0, 0, 0, 6), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(3) };
            card.SetResourceReference(Border.BorderBrushProperty, EnvironmentColors.ToolWindowBorderBrushKey);
            var stack = new StackPanel();
            card.Child = stack;

            var who = new TextBlock { Margin = new Thickness(0, 0, 0, 4) };
            who.Inlines.Add(new Run(comment.Author == "agent" ? "Agent" : "You") { FontWeight = FontWeights.SemiBold });
            if (comment.Author == "agent") who.Inlines.Add(new Run("  · AI reply") { FontStyle = FontStyles.Italic });
            if (comment.Draft) who.Inlines.Add(new Run("  · Pending") { FontStyle = FontStyles.Italic });
            if (DateTime.TryParse(comment.CreatedAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var created))
                who.Inlines.Add(new Run("  " + created.ToLocalTime().ToString("g", CultureInfo.CurrentCulture)) { });
            who.Opacity = 0.85;
            stack.Children.Add(who);

            var editRoot = _session.Root ?? "";
            var editKey = EditDraftKey(editRoot, thread.Id, comment.Id);
            if (_editingComments.Contains(editKey))
            {
                var initialText = _editDrafts.TryGetValue(editKey, out var draft) ? draft : comment.Body;
                var editor = new CommentTextBox { Text = initialText };
                _editingBoxes[editKey] = editor;
                stack.Children.Add(editor);
                var buttons = new WrapPanel { Margin = new Thickness(0, 4, 0, 0) };
                void Save()
                {
                    var body = editor.Text.Trim();
                    if (body.Length == 0) return;
                    var root = editRoot;
                    Run(async () =>
                    {
                        if (_session.Root != root) return;
                        if (await _session.RunAsync("edit-comment", new { threadId = thread.Id, commentId = comment.Id, body }) == null) return;
                        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                        CaptureDrafts();
                        var unchanged = _editDrafts.TryGetValue(editKey, out var currentDraft) && currentDraft.Trim() == body;
                        if (unchanged)
                        {
                            _editDrafts.Remove(editKey);
                            _editingComments.Remove(editKey);
                        }
                        if (_session.Root == root && _selectedThreadId == thread.Id)
                        {
                            _renderedThreadKey = null;
                            RenderDetail(_session.State);
                        }
                    });
                }
                editor.SubmitRequested += (_, __) => Save();
                AddButton(buttons, "Save", "Save (Ctrl+Enter)", () =>
                {
                    Save();
                    return Task.CompletedTask;
                });
                AddButton(buttons, "Cancel", "", () =>
                {
                    _editDrafts.Remove(editKey);
                    _editingComments.Remove(editKey);
                    if (_session.Root == editRoot && _selectedThreadId == thread.Id)
                    {
                        _renderedThreadKey = null;
                        RenderDetail(_session.State);
                    }
                    return Task.CompletedTask;
                });
                stack.Children.Add(buttons);
                editor.Loaded += (_, __) => editor.Focus();
                return card;
            }

            stack.Children.Add(new TextBox
            {
                Text = comment.Body,
                IsReadOnly = true,
                TextWrapping = TextWrapping.Wrap,
                BorderThickness = new Thickness(0),
                Background = Brushes.Transparent,
                Padding = new Thickness(0),
            });
            foreach (var attachment in comment.Attachments) stack.Children.Add(AttachmentView(attachment));

            if (comment.Draft && comment.Author == "user")
            {
                var buttons = new WrapPanel { Margin = new Thickness(0, 4, 0, 0) };
                AddButton(buttons, "Edit", "Edit this pending comment", () =>
                {
                    var key = EditDraftKey(_session.Root ?? "", thread.Id, comment.Id);
                    _editingComments.Add(key);
                    if (!_editDrafts.ContainsKey(key)) _editDrafts[key] = comment.Body;
                    _renderedThreadKey = null;
                    RenderDetail(_session.State);
                    return Task.CompletedTask;
                });
                AddButton(buttons, "Delete", "Delete this pending comment", () => _session.RunAsync("delete-comment", new { threadId = thread.Id, commentId = comment.Id }));
                stack.Children.Add(buttons);
            }
            return card;
        }

        private static FrameworkElement AttachmentView(AttachmentInfo attachment)
        {
            try
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad; // don't lock the file
                image.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                image.UriSource = new Uri(attachment.Path);
                image.EndInit();
                image.Freeze();
                var view = new Image { Source = image, MaxHeight = 220, MaxWidth = 420, Stretch = Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 4, 0, 0), ToolTip = attachment.Alt, Cursor = Cursors.Hand };
                view.MouseLeftButtonUp += (_, __) =>
                {
                    // Attachments resolve inside .vibe-review/attachments; only ever hand image files to the shell.
                    var ext = System.IO.Path.GetExtension(attachment.Path).ToLowerInvariant();
                    if (ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".gif" && ext != ".webp") return;
                    try
                    {
                        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(attachment.Path) { UseShellExecute = true });
                    }
                    catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is FileNotFoundException)
                    {
                    }
                };
                return view;
            }
            catch (Exception ex) when (ex is IOException || ex is FileFormatException || ex is NotSupportedException || ex is UriFormatException || ex is UnauthorizedAccessException)
            {
                return new TextBlock { Text = $"[image: {attachment.Alt}]", Opacity = 0.7 };
            }
        }
    }
}
