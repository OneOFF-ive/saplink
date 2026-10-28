using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

internal static class Launcher
{
    // Windows command-line quoting, including embedded quotes and trailing slashes.
    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    internal static string Root
    {
        get { return Directory.GetParent(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)).FullName; }
    }

    internal static ProcessStartInfo Node(string[] arguments)
    {
        string root = Root;
        var command = new StringBuilder(Quote(Path.Combine(root, "app", "dist", "cli.js")));
        foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        var start = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), command.ToString()) { UseShellExecute = false };
        start.EnvironmentVariables["SAPLINK_WINDOWS_LAUNCHER"] = Path.Combine(root, "bin", "saplink.exe");
        return start;
    }

#if !GUI
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedPointer, StdInput, StdOutput, StdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static int SpawnService(string[] arguments)
    {
        int port; Guid startupId;
        if (arguments.Length != 2 || !int.TryParse(arguments[1], out port) || port < 1 || port > 65535 ||
            !Guid.TryParse(Environment.GetEnvironmentVariable("SAPLINK_STARTUP_ID"), out startupId)) return 1;
        var start = Node(new[] { "service", "_run", "--port", port.ToString() });
        var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)) };
        ProcessInfo process;
        // No inherited handles, including hidden terminal/CRT pipe duplicates.
        // DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP gives a hidden background
        // runtime; lifecycle control continues through its authenticated endpoint.
        if (!CreateProcess(start.FileName, new StringBuilder(Quote(start.FileName) + " " + start.Arguments),
            IntPtr.Zero, IntPtr.Zero, false, 0x208, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out process)) return 1;
        CloseHandle(process.Thread); CloseHandle(process.Process);
        return 0;
    }

    private static int Main(string[] arguments)
    {
        try
        {
            if (arguments.Length > 0 && arguments[0] == "--internal-service-run") return SpawnService(arguments);
            if (arguments.Length > 0 && arguments[0] == "--internal-update-run") return SpawnUpdate(arguments);
            using (Process child = Process.Start(Node(arguments)))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch
        {
            Console.Error.WriteLine("SapLink could not start. Repair the installation; the bundled Node.js runtime is required.");
            return 1;
        }
    }

    private static int SpawnUpdate(string[] arguments)
    {
        if (arguments.Length != 3 || !Path.IsPathRooted(arguments[1]) || !Path.IsPathRooted(arguments[2]) ||
            Path.GetFileName(arguments[1]) != "update-runner.ps1" || Path.GetFileName(arguments[2]) != "plan.json") return 1;
        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var command = new StringBuilder(Quote(powershell) + " -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
            Quote(arguments[1]) + " -Plan " + Quote(arguments[2]));
        // Run without a console or inherited pipes so Windows Terminal cannot
        // expose a window that users could close during the upgrade.
        var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Flags = 1, ShowWindow = 0 };
        ProcessInfo process;
        if (!CreateProcess(powershell, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000200, IntPtr.Zero,
            Path.GetDirectoryName(arguments[1]), ref startup, out process)) return 1;
        CloseHandle(process.Thread); CloseHandle(process.Process);
        return 0;
    }
#endif
}
