using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pos2026.Desktop
{
    internal sealed class PopupForm : Form
    {
        private readonly MainForm owner;
        private readonly WebView2 webView = new WebView2 { Dock = DockStyle.Fill };

        public PopupForm(MainForm owner, CoreWebView2WindowFeatures features)
        {
            this.owner = owner;

            Text = "POS2026";
            Icon = owner.Icon;
            StartPosition = FormStartPosition.CenterParent;
            Size = features != null && features.HasSize && features.Width > 0 && features.Height > 0
                ? new Size((int)features.Width, (int)features.Height)
                : new Size(1000, 760);
            MinimumSize = new Size(400, 300);
            Controls.Add(webView);
        }

        public CoreWebView2 Core => webView.CoreWebView2;

        public async Task InitializeAsync(CoreWebView2Environment environment)
        {
            await webView.EnsureCoreWebView2Async(environment);

            var core = webView.CoreWebView2;
            MainForm.Configure(core);
            core.WindowCloseRequested += (s, e) => Close();
            core.DocumentTitleChanged += (s, e) => Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "POS2026" : core.DocumentTitle;
            owner.AttachNewWindowHandler(core);
        }
    }
}
