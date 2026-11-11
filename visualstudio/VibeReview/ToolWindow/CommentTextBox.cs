using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json.Linq;
using VibeReview.Bridge;
using Task = System.Threading.Tasks.Task;

namespace VibeReview.ToolWindow
{
    /// <summary>
    /// Multi-line Markdown comment box. Like the VS Code comment box: pasting or dropping a
    /// screenshot or image file attaches it (saved in .vibe-review/attachments, which agents read),
    /// and rich text (e.g. from a browser) is pasted as Markdown. Ctrl+Shift+V pastes plain text.
    /// </summary>
    public sealed class CommentTextBox : TextBox
    {
        private static readonly string[] ImageExtensions = { ".png", ".jpg", ".jpeg", ".gif", ".webp" };
        /// <summary>Formats Visual Studio puts on the clipboard when copying from a code editor: its HTML is only syntax highlighting.</summary>
        private static readonly string[] EditorClipboardFormats = { "VisualStudioEditorOperationsLineCutCopyClipboardTag", "MSDEVLineSelect", "MSDEVColumnSelect" };
        private static readonly Regex TagName = new Regex(@"<\s*([a-zA-Z][a-zA-Z0-9]*)", RegexOptions.Compiled);
        private static readonly HashSet<string> CodeOnlyTags = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "pre", "span", "div", "br", "font", "html", "body", "meta" };

        public CommentTextBox()
        {
            AcceptsReturn = true;
            AcceptsTab = false;
            TextWrapping = TextWrapping.Wrap;
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            MinHeight = 60;
            MaxHeight = 240;
            AllowDrop = true;
            SpellCheck.SetIsEnabled(this, true);
            DataObject.AddPastingHandler(this, OnPasting);
            PreviewDragOver += OnDragOver;
            PreviewDrop += OnDrop;
            PreviewKeyDown += OnPreviewKeyDown;
            ToolTip = "Markdown. Paste or drop screenshots and image files to attach them for the agent. Ctrl+Shift+V pastes plain text.";
        }

        /// <summary>Raised for Ctrl+Enter, to submit the comment.</summary>
        public event EventHandler? SubmitRequested;

        private void OnPreviewKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.Control)
            {
                e.Handled = true;
                SubmitRequested?.Invoke(this, EventArgs.Empty);
            }
            else if (e.Key == Key.V && Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Shift))
            {
                e.Handled = true;
                if (Clipboard.ContainsText()) InsertText(Clipboard.GetText());
            }
        }

        private void OnPasting(object sender, DataObjectPastingEventArgs e)
        {
            var data = e.DataObject;
            var images = ImageFiles(data);
            if (images.Count > 0)
            {
                e.CancelCommand();
                Run(() => AttachFilesAsync(images));
                return;
            }
            var png = ImageBytes(data);
            if (png != null)
            {
                e.CancelCommand();
                Run(() => AttachAsync(new { mime = "image/png", data = Convert.ToBase64String(png) }));
                return;
            }
            if (data.GetDataPresent(DataFormats.Html) && !EditorClipboardFormats.Any(data.GetDataPresent))
            {
                var fragment = HtmlFragment(data.GetData(DataFormats.Html) as string);
                if (fragment != null && !IsCodeOnly(fragment))
                {
                    var plain = (data.GetData(DataFormats.UnicodeText) as string ?? "").Trim();
                    e.CancelCommand();
                    Run(async () =>
                    {
                        string? md = null;
                        try
                        {
                            md = await NodeBridge.CallAsync<string>("html-to-markdown", new { html = fragment });
                        }
                        catch (BridgeException)
                        {
                            // fall back to plain text
                        }
                        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                        InsertText(string.IsNullOrWhiteSpace(md) || md!.Trim() == plain ? plain : md!);
                    });
                }
            }
        }

        private void OnDragOver(object sender, DragEventArgs e)
        {
            if (ImageFiles(e.Data).Count > 0)
            {
                e.Effects = DragDropEffects.Copy;
                e.Handled = true;
            }
        }

        private void OnDrop(object sender, DragEventArgs e)
        {
            var images = ImageFiles(e.Data);
            if (images.Count == 0) return;
            e.Handled = true;
            Focus();
            Run(() => AttachFilesAsync(images));
        }

        private async Task AttachFilesAsync(IEnumerable<string> paths)
        {
            foreach (var path in paths) await AttachAsync(new { path });
        }

        private async Task AttachAsync(object args)
        {
            var result = await ReviewSession.Instance.RunAsync("attach", args, refresh: false);
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (result is JValue v && v.Type == JTokenType.String) InsertText((string)v! + Environment.NewLine);
        }

        private void InsertText(string text)
        {
            text = text.Replace("\r\n", "\n").Replace("\n", Environment.NewLine);
            var start = SelectionStart;
            SelectedText = text;
            SelectionLength = 0;
            CaretIndex = start + text.Length;
            Focus();
        }

        private static void Run(Func<Task> work) =>
            ThreadHelper.JoinableTaskFactory.RunAsync(async () =>
            {
                try
                {
                    await work();
                }
                catch (Exception ex)
                {
                    await ReviewSession.ShowErrorAsync(ex);
                }
            }).FireAndForget();

        /// <summary>Image files copied in File Explorer or dragged in. Files win over image data (Explorer also puts the file icon on the clipboard).</summary>
        private static List<string> ImageFiles(IDataObject data)
        {
            if (!data.GetDataPresent(DataFormats.FileDrop)) return new List<string>();
            return (data.GetData(DataFormats.FileDrop) as string[] ?? Array.Empty<string>())
                .Where(p => ImageExtensions.Contains(Path.GetExtension(p).ToLowerInvariant()) && File.Exists(p))
                .ToList();
        }

        /// <summary>Pasted image data (e.g. a screenshot), as PNG bytes.</summary>
        private static byte[]? ImageBytes(IDataObject data)
        {
            if (data.GetDataPresent("PNG") && data.GetData("PNG") is MemoryStream png) return png.ToArray();
            if (!data.GetDataPresent(DataFormats.Bitmap) || !(data.GetData(DataFormats.Bitmap) is BitmapSource bitmap)) return null;
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using var stream = new MemoryStream();
            encoder.Save(stream);
            return stream.ToArray();
        }

        /// <summary>The copied fragment of a CF_HTML clipboard payload.</summary>
        internal static string? HtmlFragment(string? cfHtml)
        {
            if (string.IsNullOrEmpty(cfHtml)) return null;
            const string start = "<!--StartFragment-->";
            const string end = "<!--EndFragment-->";
            var s = cfHtml!.IndexOf(start, StringComparison.OrdinalIgnoreCase);
            var e = cfHtml.IndexOf(end, StringComparison.OrdinalIgnoreCase);
            if (s >= 0 && e > s) return cfHtml.Substring(s + start.Length, e - s - start.Length);
            var html = cfHtml.IndexOf("<html", StringComparison.OrdinalIgnoreCase);
            return html >= 0 ? cfHtml.Substring(html) : null;
        }

        /// <summary>Syntax-highlighted code copied from an IDE: nothing worth converting to Markdown.</summary>
        internal static bool IsCodeOnly(string fragment) =>
            TagName.Matches(fragment).Cast<Match>().All(m => CodeOnlyTags.Contains(m.Groups[1].Value));
    }
}
