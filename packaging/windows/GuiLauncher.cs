using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: TargetFramework(".NETFramework,Version=v4.7")]

internal static class GuiDpi
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDPIAware();

    internal static void Initialize()
    {
        // Run before creating controls, including the tray's hidden message window.
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; // Per-monitor V2.
            // WinForms configuration or Windows compatibility settings already chose a mode.
            if (Marshal.GetLastWin32Error() == 5) return;
        }
        catch (EntryPointNotFoundException) { }
        // Older Windows 10 builds still support sharp rendering at the system DPI.
        SetProcessDPIAware();
    }
}

internal static class TrayMenuTheme
{
    internal static void Apply(ContextMenuStrip menu)
    {
        // Read on every opening so a Windows theme change needs no application restart.
        if (SystemInformation.HighContrast)
        {
            menu.Renderer = new ToolStripSystemRenderer();
            menu.BackColor = SystemColors.Menu;
            menu.ForeColor = SystemColors.MenuText;
        }
        else
        {
            bool dark = UsesDarkTheme();
            var colors = new TrayMenuColors(dark);
            menu.Renderer = new TrayMenuRenderer(colors);
            menu.BackColor = colors.ToolStripDropDownBackground;
            menu.ForeColor = dark ? Color.FromArgb(245, 245, 245) : Color.FromArgb(32, 32, 32);
        }
        foreach (ToolStripItem item in menu.Items)
        {
            item.BackColor = menu.BackColor;
            item.ForeColor = menu.ForeColor;
        }
    }

    private static bool UsesDarkTheme()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                // Tray menus belong to the Windows shell; prefer Windows mode in custom themes.
                object value = key == null ? null : key.GetValue("SystemUsesLightTheme", key.GetValue("AppsUseLightTheme", 1));
                return value is int && (int)value == 0;
            }
        }
        catch (System.Security.SecurityException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (IOException) { return false; }
    }
}

internal sealed class TrayMenuRenderer : ToolStripProfessionalRenderer
{
    internal TrayMenuRenderer(TrayMenuColors colors) : base(colors) { RoundedEdges = false; }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        bool selected = e.Item.Enabled && (e.Item.Selected || e.Item.Pressed);
        using (var brush = new SolidBrush(selected ? ColorTable.MenuItemSelected : ColorTable.ToolStripDropDownBackground))
            e.Graphics.FillRectangle(brush, new Rectangle(Point.Empty, e.Item.Size));
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        Color color = e.Item.Enabled ? e.Item.ForeColor : Color.FromArgb(128, 128, 128);
        TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, color, e.TextFormat);
    }
}

internal sealed class TrayMenuColors : ProfessionalColorTable
{
    private readonly bool dark;
    internal TrayMenuColors(bool useDarkTheme) { dark = useDarkTheme; UseSystemColors = false; }
    public override Color ToolStripDropDownBackground { get { return dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(250, 250, 250); } }
    public override Color MenuBorder { get { return dark ? Color.FromArgb(74, 74, 74) : Color.FromArgb(200, 200, 200); } }
    public override Color MenuItemSelected { get { return dark ? Color.FromArgb(62, 62, 62) : Color.FromArgb(229, 229, 229); } }
    public override Color MenuItemBorder { get { return MenuItemSelected; } }
    public override Color MenuItemSelectedGradientBegin { get { return MenuItemSelected; } }
    public override Color MenuItemSelectedGradientEnd { get { return MenuItemSelected; } }
    public override Color MenuItemPressedGradientBegin { get { return MenuItemSelected; } }
    public override Color MenuItemPressedGradientMiddle { get { return MenuItemSelected; } }
    public override Color MenuItemPressedGradientEnd { get { return MenuItemSelected; } }
    public override Color ImageMarginGradientBegin { get { return ToolStripDropDownBackground; } }
    public override Color ImageMarginGradientMiddle { get { return ToolStripDropDownBackground; } }
    public override Color ImageMarginGradientEnd { get { return ToolStripDropDownBackground; } }
}

internal sealed class GuiContext : ApplicationContext
{
    private readonly NotifyIcon tray;
    private readonly Process child;
    private readonly EventWaitHandle reopen;
    private readonly System.Windows.Forms.Timer timer;
    private readonly ToolStripMenuItem exitItem;
    private volatile Uri session;
    private bool opened;
    private volatile bool stopping;
    private bool exitHandled;

    internal GuiContext(EventWaitHandle reopenEvent)
    {
        reopen = reopenEvent;
        var menu = new ContextMenuStrip();
        menu.ShowImageMargin = false;
        menu.Opening += delegate { TrayMenuTheme.Apply(menu); };
        menu.Items.Add("打开管理界面", null, delegate { OpenBrowser(); });
        exitItem = new ToolStripMenuItem("退出 SapLink 管理", null, delegate { Stop(); });
        menu.Items.Add(exitItem);
        // Read the packaged artwork directly instead of asking the shell icon cache.
        tray = new NotifyIcon { Text = "SapLink 管理", Icon = new Icon(Path.Combine(Launcher.Root, "saplink.ico"), 32, 32), ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { OpenBrowser(); };
        var start = Launcher.Node(new[] { "ui", "--no-open" });
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = Encoding.UTF8;
        child = new Process { StartInfo = start };
        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            const string prefix = "Management session URL: ";
            if (args.Data == null || !args.Data.StartsWith(prefix, StringComparison.Ordinal)) return;
            Uri candidate;
            if (Uri.TryCreate(args.Data.Substring(prefix.Length), UriKind.Absolute, out candidate) &&
                candidate.Scheme == "http" && candidate.Host == "127.0.0.1" && candidate.AbsolutePath == "/" && candidate.Fragment.Length > 1)
                session = candidate;
        };
        // Session URLs and diagnostics remain private; never write them to launcher logs.
        child.ErrorDataReceived += delegate { };
        child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
        timer = new System.Windows.Forms.Timer { Interval = 500 };
        timer.Tick += delegate
        {
            if (exitHandled) return;
            if (child.HasExited)
            {
                // MessageBox pumps a nested message loop: stop and guard before showing it.
                exitHandled = true;
                timer.Stop();
                bool failed = child.ExitCode != 0 && !stopping;
                tray.Dispose();
                child.Dispose();
                try
                {
                    if (failed)
                        MessageBox.Show("管理界面未能启动。请先关闭已有的管理进程，或运行 saplink doctor --json 检查。后台 MCP 服务可用 saplink service stop --json 正常停止。", "SapLink", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                finally { ExitThread(); }
                return;
            }
            if ((!opened || reopen.WaitOne(0)) && session != null) { opened = true; OpenBrowser(); }
            exitItem.Enabled = !stopping && session != null;
        };
        timer.Start();
    }

    private void OpenBrowser()
    {
        if (session == null || stopping) return;
        try { Process.Start(new ProcessStartInfo(session.AbsoluteUri) { UseShellExecute = true }); }
        catch { MessageBox.Show("无法打开默认浏览器。请检查 Windows 默认浏览器设置。", "SapLink"); }
    }

    private void Stop()
    {
        if (session == null || stopping) return;
        stopping = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(new Uri(session, "/api/application/stop"));
                request.Method = "POST"; request.ContentLength = 0; request.Timeout = 5000;
                request.Proxy = null; request.AllowAutoRedirect = false;
                request.Headers["Origin"] = session.GetLeftPart(UriPartial.Authority);
                request.Headers["X-Admin-Token"] = session.Fragment.Substring(1);
                using (var response = request.GetResponse()) { }
            }
            catch
            {
                stopping = false;
                MessageBox.Show("未能确认退出请求，请稍后重试。现有进程没有被强制结束。", "SapLink");
            }
        });
    }
}

internal static class GuiProgram
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        GuiDpi.Initialize();
        Application.SetCompatibleTextRenderingDefault(false);
        string identity;
        using (var hash = SHA256.Create()) identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Launcher.Root.ToUpperInvariant()))).Replace("-", "");
        bool first;
        using (var mutex = new Mutex(true, "Local\\SapLink.GUI." + identity, out first))
        using (var reopen = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\SapLink.GUI.Open." + identity))
        {
            if (!first) { reopen.Set(); return; }
            try
            {
                Application.Run(new GuiContext(reopen));
            }
            catch { MessageBox.Show("SapLink 无法启动，请修复安装或运行 saplink doctor --json 检查。", "SapLink"); }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
