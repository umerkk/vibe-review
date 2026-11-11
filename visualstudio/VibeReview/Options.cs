using System.ComponentModel;
using System.Runtime.InteropServices;
using Community.VisualStudio.Toolkit;

namespace VibeReview
{
    internal static class OptionsProvider
    {
        [ComVisible(true)]
        [Guid(PackageGuids.OptionsPageString)]
        public class GeneralOptions : BaseOptionPage<General> { }
    }

    /// <summary>Tools &gt; Options &gt; Vibe Review &gt; General. Mirrors the VS Code settings.</summary>
    public class General : BaseOptionModel<General>
    {
        public const int DefaultWaitTimeoutMinutes = 30;

        [Category("Review")]
        [DisplayName("Wait timeout (minutes)")]
        [Description("With Review Mode on, how long an agent waits for your review after finishing a turn before it stops anyway (1-55). Your draft is kept.")]
        [DefaultValue(DefaultWaitTimeoutMinutes)]
        public int WaitTimeoutMinutes { get; set; } = DefaultWaitTimeoutMinutes;

        [Category("Node.js")]
        [DisplayName("Node.js executable")]
        [Description("Full path to node.exe (Node.js 18 or later). Leave empty to find it on PATH or in the usual install locations. Vibe Review runs its review logic, agent hooks and MCP server with Node.js.")]
        [DefaultValue("")]
        public string NodePath { get; set; } = "";

        /// <summary>The timeout clamped to the range agents accept (hooks time out after one hour).</summary>
        public int EffectiveWaitTimeoutMinutes =>
            WaitTimeoutMinutes < 1 ? 1 : WaitTimeoutMinutes > 55 ? 55 : WaitTimeoutMinutes;
    }
}
