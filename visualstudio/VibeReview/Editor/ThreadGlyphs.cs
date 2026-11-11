using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Linq;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Formatting;
using Microsoft.VisualStudio.Text.Tagging;
using Microsoft.VisualStudio.Utilities;
using VibeReview.Bridge;
using VibeReview.ToolWindow;

namespace VibeReview.Editor
{
    /// <summary>A comment thread starting on a line.</summary>
    internal sealed class ThreadGlyphTag : IGlyphTag
    {
        public ThreadGlyphTag(ThreadInfo thread) => Thread = thread;

        public ThreadInfo Thread { get; }
    }

    /// <summary>Marks lines with comment threads in the editor's glyph margin (like VS Code's comment gutter icons).</summary>
    [Export(typeof(ITaggerProvider))]
    [ContentType("text")]
    [TagType(typeof(ThreadGlyphTag))]
    internal sealed class ThreadGlyphTaggerProvider : ITaggerProvider
    {
        public ITagger<T>? CreateTagger<T>(ITextBuffer buffer) where T : ITag
        {
            if (EditorSelection.TryGetDocument(buffer) == null) return null;
            return new ThreadGlyphTagger(buffer) as ITagger<T>;
        }
    }

    internal sealed class ThreadGlyphTagger : ITagger<ThreadGlyphTag>, IDisposable
    {
        private readonly ITextBuffer _buffer;

        public ThreadGlyphTagger(ITextBuffer buffer)
        {
            _buffer = buffer;
            ReviewSession.Instance.Changed += OnChanged;
        }

        public event EventHandler<SnapshotSpanEventArgs>? TagsChanged;

        public IEnumerable<ITagSpan<ThreadGlyphTag>> GetTags(NormalizedSnapshotSpanCollection spans)
        {
            if (spans.Count == 0) yield break;
            var document = EditorSelection.TryGetDocument(_buffer);
            if (document == null) yield break;
            var threads = ReviewSession.Instance.ThreadsFor(document.FilePath);
            if (threads.Length == 0) yield break;
            var snapshot = spans[0].Snapshot;
            // One glyph per line: the most urgent thread wins (pending, then active, then resolved).
            foreach (var group in threads.GroupBy(t => Math.Min(t.StartLine, snapshot.LineCount - 1)))
            {
                var thread = group.OrderBy(t => t.State == "pending" ? 0 : t.State == "active" ? 1 : 2).First();
                var line = snapshot.GetLineFromLineNumber(group.Key);
                var span = new SnapshotSpan(line.Start, line.End);
                if (spans.Any(s => s.Start.Position <= line.End.Position && s.End.Position >= line.Start.Position))
                    yield return new TagSpan<ThreadGlyphTag>(span, new ThreadGlyphTag(thread));
            }
        }

        private void OnChanged(object sender, EventArgs e)
        {
            var snapshot = _buffer.CurrentSnapshot;
            TagsChanged?.Invoke(this, new SnapshotSpanEventArgs(new SnapshotSpan(snapshot, 0, snapshot.Length)));
        }

        public void Dispose() => ReviewSession.Instance.Changed -= OnChanged;
    }

    [Export(typeof(IGlyphFactoryProvider))]
    [Name("VibeReviewThreadGlyph")]
    [Order(After = "VsTextMarker")]
    [ContentType("text")]
    [TagType(typeof(ThreadGlyphTag))]
    internal sealed class ThreadGlyphFactoryProvider : IGlyphFactoryProvider
    {
        public IGlyphFactory GetGlyphFactory(IWpfTextView view, IWpfTextViewMargin margin) => new ThreadGlyphFactory();
    }

    internal sealed class ThreadGlyphFactory : IGlyphFactory
    {
        public UIElement? GenerateGlyph(IWpfTextViewLine line, IGlyphTag tag)
        {
            if (!(tag is ThreadGlyphTag glyph)) return null;
            var thread = glyph.Thread;
            var brush = ReviewControl.StateBrush(thread.State);
            var size = Math.Max(8, Math.Min(12, line.Height - 4));
            var dot = new Ellipse { Width = size, Height = size, Cursor = Cursors.Hand };
            if (thread.State == "pending" && thread.HasDraft)
            {
                dot.Stroke = brush;
                dot.StrokeThickness = 1.5;
                dot.Fill = Brushes.Transparent;
            }
            else
            {
                dot.Fill = brush;
            }
            var first = thread.Comments.FirstOrDefault()?.Body ?? "";
            if (first.Length > 300) first = first.Substring(0, 300) + "…";
            dot.ToolTip = $"Vibe Review — {thread.Label}\n\n{first}\n\nClick to open the thread.";
            dot.MouseLeftButtonUp += (_, e) =>
            {
                e.Handled = true;
                ThreadHelper.JoinableTaskFactory.RunAsync(() => ReviewToolWindow.ShowThreadAsync(thread.Id)).FireAndForget();
            };
            return dot;
        }
    }
}
