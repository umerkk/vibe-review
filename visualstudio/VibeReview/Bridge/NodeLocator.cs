using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace VibeReview.Bridge
{
    /// <summary>Finds node.exe: the configured path, then PATH, then the usual install locations.</summary>
    internal static class NodeLocator
    {
        public static string? Find(string? configured)
        {
            if (!string.IsNullOrWhiteSpace(configured))
            {
                var path = Environment.ExpandEnvironmentVariables(configured!.Trim().Trim('"'));
                if (Directory.Exists(path)) path = Path.Combine(path, "node.exe");
                return File.Exists(path) ? path : null;
            }
            return Candidates().FirstOrDefault(File.Exists);
        }

        private static IEnumerable<string> Candidates()
        {
            // PATH as seen by Visual Studio, then the machine/user PATH (Node may have been installed after VS started).
            var paths = new[]
            {
                Environment.GetEnvironmentVariable("PATH"),
                Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User),
                Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine),
            };
            foreach (var list in paths)
            {
                if (string.IsNullOrEmpty(list)) continue;
                foreach (var dir in list!.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string candidate;
                    try
                    {
                        candidate = Path.Combine(Environment.ExpandEnvironmentVariables(dir.Trim().Trim('"')), "node.exe");
                    }
                    catch (ArgumentException)
                    {
                        continue;
                    }
                    yield return candidate;
                }
            }

            string Env(string name) => Environment.GetEnvironmentVariable(name) ?? "";
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            foreach (var dir in new[]
            {
                Path.Combine(programFiles, "nodejs"),
                Path.Combine(Env("ProgramW6432"), "nodejs"),
                Path.Combine(localAppData, "Programs", "nodejs"),
                Env("NVM_SYMLINK"),
                Path.Combine(localAppData, "Volta", "bin"),
                Path.Combine(profile, "scoop", "apps", "nodejs-lts", "current"),
                Path.Combine(profile, "scoop", "apps", "nodejs", "current"),
            })
            {
                if (!string.IsNullOrEmpty(dir) && Path.IsPathRooted(dir)) yield return Path.Combine(dir, "node.exe");
            }
        }
    }
}
