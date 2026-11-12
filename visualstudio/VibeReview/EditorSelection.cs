using System;
using System.Linq;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;

namespace VibeReview
{
    /// <summary>The selected lines of the active editor, mapped to the underlying file (so it also works in diff views).</summary>
    internal static class EditorSelection
    {
        public static async Task<(ITextDocument Document, int StartLine, int EndLine, string Anchor)?> GetAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var docView = await VS.Documents.GetActiveDocumentViewAsync();
            var view = docView?.TextView;
            return view == null ? null : Get(view);
        }

        public static (ITextDocument Document, int StartLine, int EndLine, string Anchor)? Get(ITextView view)
        {
            var session = ReviewSession.Instance;
            // In a diff view the view's buffer is a projection: find the working-tree file underneath.
            var buffer = view.BufferGraph
                .GetTextBuffers(b => TryGetDocument(b) is ITextDocument d && session.RelativePath(d.FilePath) != null)
                .FirstOrDefault();
            if (buffer == null || !(TryGetDocument(buffer) is ITextDocument document)) return null;

            var selection = view.Selection.IsEmpty
                ? new SnapshotSpan(view.Caret.Position.BufferPosition, 0)
                : new SnapshotSpan(view.Selection.Start.Position, view.Selection.End.Position);
            var spans = view.BufferGraph.MapDownToBuffer(selection, SpanTrackingMode.EdgeInclusive, buffer);
            if (spans.Count == 0) return null;

            var snapshot = buffer.CurrentSnapshot;
            var start = spans.Min(s => s.Start.Position);
            var end = spans.Max(s => s.End.Position);
            var startLine = snapshot.GetLineNumberFromPosition(start);
            var endLine = snapshot.GetLineNumberFromPosition(end);
            // A selection ending at the start of a line doesn't include that line.
            if (endLine > startLine && snapshot.GetLineFromLineNumber(endLine).Start.Position == end) endLine--;
            var anchor = string.Join("\n", Enumerable.Range(startLine, endLine - startLine + 1).Select(n => snapshot.GetLineFromLineNumber(n).GetText()));
            return (document, startLine, endLine, anchor);
        }

        public static ITextDocument? TryGetDocument(ITextBuffer buffer) =>
            buffer.Properties.TryGetProperty(typeof(ITextDocument), out ITextDocument document) ? document : null;
    }
}
