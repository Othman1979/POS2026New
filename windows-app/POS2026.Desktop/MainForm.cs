using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pos2026.Desktop
{
    internal sealed class MainForm : Form
    {
        private const string AppTitle = "POS2026";
        private const string RuntimeDownloadUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
        private const int WM_SYSCOMMAND = 0x0112;
        private const int MF_STRING = 0x0000;
        private const int MF_SEPARATOR = 0x0800;
        private const int ReloadCommand = 0x1010;
        private const int SettingsCommand = 0x1020;

        private static readonly CoreWebView2WebErrorStatus[] OfflineErrors =
        {
            CoreWebView2WebErrorStatus.CannotConnect,
            CoreWebView2WebErrorStatus.HostNameNotResolved,
            CoreWebView2WebErrorStatus.Timeout,
            CoreWebView2WebErrorStatus.Disconnected,
            CoreWebView2WebErrorStatus.ServerUnreachable,
            CoreWebView2WebErrorStatus.ConnectionReset,
        };

        private readonly AppSettings settings;
        private readonly WebView2 webView = new WebView2 { Dock = DockStyle.Fill };
        private readonly Timer retryTimer = new Timer { Interval = 10000 };
        private CoreWebView2Environment environment;
        private bool showingOffline;
        private bool probing;

        public MainForm(AppSettings settings)
        {
            this.settings = settings;

            Text = AppTitle;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1280, 800);
            MinimumSize = new Size(800, 600);
            WindowState = FormWindowState.Maximized;
            BackColor = Color.FromArgb(15, 23, 42);
            webView.DefaultBackgroundColor = BackColor;
            Controls.Add(webView);

            retryTimer.Tick += async (s, e) => await RetryWhenReachableAsync();
            Load += async (s, e) => await InitializeAsync();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            var menu = GetSystemMenu(Handle, false);
            AppendMenu(menu, MF_SEPARATOR, 0, null);
            AppendMenu(menu, MF_STRING, ReloadCommand, "إعادة تحميل\tF5");
            AppendMenu(menu, MF_STRING, SettingsCommand, "إعدادات السيرفر...");
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_SYSCOMMAND)
            {
                var command = (int)(m.WParam.ToInt64() & 0xFFF0);
                if (command == ReloadCommand) { LoadServer(); return; }
                if (command == SettingsCommand) { OpenSettings(); return; }
            }

            base.WndProc(ref m);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            retryTimer.Dispose();
            base.OnFormClosed(e);
        }

        private async Task InitializeAsync()
        {
            try
            {
                environment = await CoreWebView2Environment.CreateAsync(null, AppSettings.WebViewDataFolder);
                await webView.EnsureCoreWebView2Async(environment);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(
                    this,
                    "يحتاج التطبيق إلى Microsoft Edge WebView2 Runtime، وهو غير مثبت على هذا الجهاز.\nستُفتح صفحة التنزيل من Microsoft، ثبّته ثم افتح التطبيق مرة أخرى.",
                    AppTitle,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning,
                    MessageBoxDefaultButton.Button1,
                    MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
                OpenInBrowser(RuntimeDownloadUrl);
                Close();
                return;
            }

            var core = webView.CoreWebView2;
            Configure(core);
            core.NavigationCompleted += OnNavigationCompleted;
            core.WebMessageReceived += OnWebMessageReceived;
            core.DocumentTitleChanged += (s, e) => Text = showingOffline || string.IsNullOrWhiteSpace(core.DocumentTitle)
                ? AppTitle
                : core.DocumentTitle + " - " + AppTitle;
            AttachNewWindowHandler(core);
            LoadServer();
        }

        internal static void Configure(CoreWebView2 core)
        {
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
        }

        internal void AttachNewWindowHandler(CoreWebView2 core) => core.NewWindowRequested += OnNewWindowRequested;

        private void LoadServer()
        {
            if (webView.CoreWebView2 == null) return;

            retryTimer.Stop();
            showingOffline = false;
            webView.CoreWebView2.Navigate(settings.ServerUrl.AbsoluteUri);
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess || showingOffline || Array.IndexOf(OfflineErrors, e.WebErrorStatus) < 0) return;

            showingOffline = true;
            Text = AppTitle;
            webView.CoreWebView2.NavigateToString(OfflinePage.Html(settings.ServerUrl));
            retryTimer.Start();
        }

        private async Task RetryWhenReachableAsync()
        {
            if (!showingOffline || probing) return;

            probing = true;
            try
            {
                if (await ServerProbe.CheckAsync(settings.ServerUrl) == null && showingOffline) LoadServer();
            }
            finally
            {
                probing = false;
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!showingOffline) return;

            string message;
            try { message = e.TryGetWebMessageAsString(); }
            catch (ArgumentException) { return; }

            if (message == "retry") LoadServer();
            else if (message == "settings") OpenSettings();
        }

        private void OpenSettings()
        {
            using (var form = new SettingsForm(settings))
            {
                if (form.ShowDialog(this) == DialogResult.OK) LoadServer();
            }
        }

        private async void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var target)
                && (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps)
                && !AppSettings.SameOrigin(target, settings.ServerUrl))
            {
                e.Handled = true;
                OpenInBrowser(target.AbsoluteUri);
                return;
            }

            var deferral = e.GetDeferral();
            var popup = new PopupForm(this, e.WindowFeatures);
            try
            {
                popup.Show(this);
                await popup.InitializeAsync(environment);
                e.NewWindow = popup.Core;
                e.Handled = true;
            }
            catch (Exception)
            {
                popup.Close();
            }
            finally
            {
                deferral.Complete();
            }
        }

        private static void OpenInBrowser(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception) { }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool AppendMenu(IntPtr hMenu, int uFlags, int uIDNewItem, string lpNewItem);
    }
}
