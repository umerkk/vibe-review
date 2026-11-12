using System.Collections.Generic;

namespace VibeReview.Bridge
{
    // Shapes returned by dist/vs-bridge.js (see src/vs-bridge.ts). Json.NET matches names case-insensitively.

    public sealed class ReviewState
    {
        public string Root { get; set; } = "";
        public bool StoreExists { get; set; }
        public ReviewConfig Config { get; set; } = new ReviewConfig();
        public AgentInfo Agent { get; set; } = new AgentInfo();
        public int DraftCount { get; set; }
        public bool Undelivered { get; set; }
        public bool RuntimeInstalled { get; set; }
        public List<ChangedFile> Files { get; set; } = new List<ChangedFile>();
        public List<ThreadInfo> Threads { get; set; } = new List<ThreadInfo>();

        public bool ModeOn => Config.Mode == "on";
    }

    public sealed class ReviewConfig
    {
        public string Mode { get; set; } = "off";
        public int WaitTimeoutSec { get; set; }
    }

    public sealed class AgentInfo
    {
        public bool Waiting { get; set; }
        public string? Agent { get; set; }
        public string Name { get; set; } = "Agent";
    }

    public sealed class ChangedFile
    {
        public string Path { get; set; } = "";
        public string? OldPath { get; set; }
        /// <summary>modified, added, deleted, renamed or untracked.</summary>
        public string Kind { get; set; } = "modified";
    }

    public sealed class ThreadInfo
    {
        public string Id { get; set; } = "";
        public string File { get; set; } = "";
        /// <summary>0-based, inclusive.</summary>
        public int StartLine { get; set; }
        public int EndLine { get; set; }
        /// <summary>open or resolved.</summary>
        public string Status { get; set; } = "open";
        /// <summary>pending, active or resolved.</summary>
        public string State { get; set; } = "pending";
        public bool HasDraft { get; set; }
        public string Label { get; set; } = "";
        public List<CommentInfo> Comments { get; set; } = new List<CommentInfo>();
    }

    public sealed class CommentInfo
    {
        public string Id { get; set; } = "";
        /// <summary>user or agent.</summary>
        public string Author { get; set; } = "user";
        public string Body { get; set; } = "";
        public string CreatedAt { get; set; } = "";
        public bool Draft { get; set; }
        public List<AttachmentInfo> Attachments { get; set; } = new List<AttachmentInfo>();
    }

    public sealed class AttachmentInfo
    {
        public string Alt { get; set; } = "";
        public string Path { get; set; } = "";
    }

    public sealed class AgentSetupInfo
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public bool Installed { get; set; }
        public List<string> Files { get; set; } = new List<string>();
    }

    public sealed class SetupResult
    {
        public List<string> Agents { get; set; } = new List<string>();
        public List<string> Notes { get; set; } = new List<string>();
    }

    public sealed class SubmitResult
    {
        public string ReviewId { get; set; } = "";
        public bool AgentWaiting { get; set; }
        public string Text { get; set; } = "";
    }

    public sealed class ModeResult
    {
        public bool RuntimeInstalled { get; set; }
    }

    public sealed class UninstallResult
    {
        public List<string> RemovedFrom { get; set; } = new List<string>();
        public List<string> Errors { get; set; } = new List<string>();
        public bool RuntimeRemoved { get; set; }
        public string RuntimeDir { get; set; } = "";
        public bool RepoDataRemoved { get; set; }
    }

    public sealed class PingResult
    {
        public string Node { get; set; } = "";
        public string Bridge { get; set; } = "";
    }
}
