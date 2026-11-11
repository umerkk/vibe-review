using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VibeReview.Bridge
{
    /// <summary>An error reported by the bridge. <see cref="IsUserError"/> errors are meant to be shown as-is.</summary>
    public sealed class BridgeException : Exception
    {
        public BridgeException(string message, bool isUserError = false, Exception? inner = null) : base(message, inner)
        {
            IsUserError = isUserError;
        }

        public bool IsUserError { get; }
    }

    /// <summary>
    /// Runs the shared review logic (dist/vs-bridge.js, the same code the VS Code extension, agent
    /// hooks and MCP server use) with Node.js: one short-lived process per call, request JSON on
    /// stdin, one response JSON line on stdout. Never call from the UI thread; use <see cref="CallAsync{T}"/>.
    /// </summary>
    public static class NodeBridge
    {
        private const int DefaultTimeoutMs = 60_000;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        /// <summary>The node.exe override from Tools &gt; Options (set by the package).</summary>
        public static string? ConfiguredNodePath { get; set; }

        public static string ExtensionDir =>
            Path.GetDirectoryName(typeof(NodeBridge).Assembly.Location) ?? AppDomain.CurrentDomain.BaseDirectory;

        public static string BridgeScript => Path.Combine(ExtensionDir, "dist", "vs-bridge.js");

        public static string NodeNotFoundMessage =>
            "Vibe Review needs Node.js 18 or later (it runs the same review engine, agent hooks and MCP server as the VS Code extension). " +
            "Install it from https://nodejs.org, or set its path in Tools > Options > Vibe Review, then restart Visual Studio.";

        public static Task<T> CallAsync<T>(string command, object? args = null, CancellationToken cancellationToken = default, int timeoutMs = DefaultTimeoutMs) =>
            Task.Run(() => Call<T>(command, args, timeoutMs, cancellationToken), cancellationToken);

        public static Task CallAsync(string command, object? args = null, CancellationToken cancellationToken = default) =>
            CallAsync<JToken>(command, args, cancellationToken);

        public static T Call<T>(string command, object? args, int timeoutMs = DefaultTimeoutMs, CancellationToken cancellationToken = default)
        {
            var token = Invoke(command, args, timeoutMs, cancellationToken);
            if (token == null || token.Type == JTokenType.Null) return default!;
            return token.ToObject<T>()!;
        }

        private static JToken? Invoke(string command, object? args, int timeoutMs, CancellationToken cancellationToken)
        {
            var node = NodeLocator.Find(ConfiguredNodePath);
            if (node == null) throw new BridgeException(NodeNotFoundMessage, isUserError: true);
            var script = BridgeScript;
            if (!File.Exists(script)) throw new BridgeException($"Vibe Review is not installed correctly: {script} is missing. Reinstall the extension.", isUserError: true);

            var info = new ProcessStartInfo
            {
                FileName = node,
                Arguments = Quote(script) + " " + command,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Utf8,
                StandardErrorEncoding = Utf8,
                WorkingDirectory = ExtensionDir,
            };

            using var process = new Process { StartInfo = info };
            try
            {
                process.Start();
            }
            catch (Exception ex)
            {
                throw new BridgeException($"Couldn't start Node.js ({node}): {ex.Message}", isUserError: true, inner: ex);
            }

            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            try
            {
                // .NET Framework has no StandardInputEncoding: write UTF-8 bytes ourselves (no BOM).
                var payload = Utf8.GetBytes(JsonConvert.SerializeObject(args ?? new object()));
                var stdin = process.StandardInput.BaseStream;
                stdin.Write(payload, 0, payload.Length);
                stdin.Flush();
                process.StandardInput.Close();
            }
            catch (IOException)
            {
                // The process exited early; its output explains why.
            }

            using (cancellationToken.Register(() => TryKill(process)))
            {
                if (!process.WaitForExit(timeoutMs))
                {
                    TryKill(process);
                    throw new BridgeException($"Vibe Review timed out running \"{command}\".");
                }
                process.WaitForExit(); // flush async readers
            }
            cancellationToken.ThrowIfCancellationRequested();

#pragma warning disable VSTHRD002 // Runs on a background thread (see CallAsync) and the process has exited.
            var output = stdout.Result;
            var line = FirstJsonLine(output);
            if (line == null)
            {
                var err = stderr.Result.Trim();
                throw new BridgeException($"Vibe Review's Node.js runtime failed running \"{command}\" (exit code {process.ExitCode}). {Truncate(err.Length > 0 ? err : output, 600)}");
            }
#pragma warning restore VSTHRD002

            JObject response;
            try
            {
                response = JObject.Parse(line);
            }
            catch (JsonException ex)
            {
                throw new BridgeException($"Unexpected response from Vibe Review's Node.js runtime: {Truncate(line, 300)}", inner: ex);
            }

            if (response.Value<bool>("ok")) return response["result"];
            throw new BridgeException(response.Value<string>("error") ?? "Unknown error.", response.Value<bool?>("user") ?? false);
        }

        private static string? FirstJsonLine(string output)
        {
            foreach (var raw in output.Split('\n'))
            {
                var line = raw.Trim();
                if (line.StartsWith("{", StringComparison.Ordinal)) return line;
            }
            return null;
        }

        private static void TryKill(Process process)
        {
            try
            {
                if (!process.HasExited) process.Kill();
            }
            catch (InvalidOperationException)
            {
            }
            catch (System.ComponentModel.Win32Exception)
            {
            }
        }

        private static string Truncate(string s, int max) => s.Length <= max ? s : s.Substring(0, max) + "…";

        /// <summary>Quotes one argument for the Windows command line (CommandLineToArgvW rules).</summary>
        internal static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            var backslashes = 0;
            foreach (var c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                sb.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
                backslashes = 0;
                sb.Append(c);
            }
            sb.Append('\\', backslashes * 2).Append('"');
            return sb.ToString();
        }
    }
}
