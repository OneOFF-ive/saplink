using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// A GUI-subsystem host creates no console, including before PowerShell starts.
internal static class InstallerControlHost
{
    private static int Main(string[] arguments)
    {
        try
        {
            if (arguments.Length == 0 || !Path.IsPathRooted(arguments[0])) return 1;
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            var command = new StringBuilder("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File");
            foreach (string argument in arguments) command.Append(' ').Append(Launcher.Quote(argument));
            var start = new ProcessStartInfo(powershell, command.ToString()) {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            };
            // Results travel through ReportPath, never through inherited output pipes.
            using (var process = Process.Start(start))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch { return 1; }
    }
}
