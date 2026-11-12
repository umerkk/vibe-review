using System;

namespace VibeReview
{
    /// <summary>GUIDs from VSCommandTable.vsct. Keep both files in sync.</summary>
    internal static class PackageGuids
    {
        public const string PackageString = "4c96abaf-b98d-4a0e-8d3f-0d7e622aa7d2";
        public const string CommandSetString = "fed2d5b7-e980-4175-87db-7a89c157157f";
        public const string ToolWindowString = "eee0f038-649c-4e45-8dae-d151b03c99a8";
        public const string OptionsPageString = "8ca6f784-6dd3-44ce-9b7b-df720daa9ce8";

        public static readonly Guid Package = new Guid(PackageString);
        public static readonly Guid CommandSet = new Guid(CommandSetString);
    }

    /// <summary>Command IDs from VSCommandTable.vsct. Keep both files in sync.</summary>
    internal static class PackageIds
    {
        public const int ShowToolWindow = 0x0100;
        public const int Submit = 0x0101;
        public const int Approve = 0x0102;
        public const int Discard = 0x0103;
        public const int ToggleMode = 0x0104;
        public const int Refresh = 0x0105;
        public const int AddComment = 0x0106;
        public const int SetupAgents = 0x0107;
        public const int Uninstall = 0x0108;
    }
}
