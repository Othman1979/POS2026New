using System;
using System.Drawing;
using System.Windows.Forms;

namespace Pos2026.Desktop
{
    internal sealed class SettingsForm : Form
    {
        private readonly AppSettings settings;
        private readonly RadioButton localRadio = new RadioButton { Text = "السيرفر على نفس الجهاز", AutoSize = true };
        private readonly TextBox localUrlBox = new TextBox { Width = 360, RightToLeft = RightToLeft.No };
        private readonly RadioButton remoteRadio = new RadioButton { Text = "سيرفر خارجي (Hostinger أو غيره)", AutoSize = true };
        private readonly TextBox remoteUrlBox = new TextBox { Width = 360, RightToLeft = RightToLeft.No };
        private readonly Label statusLabel = new Label { AutoSize = true, MaximumSize = new Size(380, 0) };
        private readonly Button testButton = new Button { Text = "اختبار الاتصال", AutoSize = true };

        public SettingsForm(AppSettings settings)
        {
            this.settings = settings;

            Text = "إعدادات الاتصال بالسيرفر";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            RightToLeft = RightToLeft.Yes;
            RightToLeftLayout = true;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Font = new Font("Segoe UI", 10F);
            Padding = new Padding(16);

            var saveButton = new Button { Text = "حفظ", AutoSize = true, DialogResult = DialogResult.None };
            var cancelButton = new Button { Text = "إلغاء", AutoSize = true, DialogResult = DialogResult.Cancel };

            var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
            layout.Controls.Add(localRadio);
            layout.Controls.Add(Indented(localUrlBox));
            layout.Controls.Add(remoteRadio);
            layout.Controls.Add(Indented(remoteUrlBox));
            layout.Controls.Add(Indented(new Label { Text = "مثال: https://pos.example.com", AutoSize = true, ForeColor = SystemColors.GrayText }));

            var testRow = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0, 12, 0, 0) };
            testRow.Controls.Add(testButton);
            testRow.Controls.Add(statusLabel);
            layout.Controls.Add(testRow);

            var buttons = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0, 16, 0, 0) };
            buttons.Controls.Add(saveButton);
            buttons.Controls.Add(cancelButton);
            layout.Controls.Add(buttons);
            Controls.Add(layout);

            AcceptButton = saveButton;
            CancelButton = cancelButton;

            var current = settings.ServerUrl;
            var isLocal = current == null || current.IsLoopback;
            localRadio.Checked = isLocal;
            remoteRadio.Checked = !isLocal;
            localUrlBox.Text = isLocal && current != null ? current.AbsoluteUri.TrimEnd('/') : AppSettings.LocalServerUrl;
            remoteUrlBox.Text = isLocal ? string.Empty : current.AbsoluteUri.TrimEnd('/');

            localRadio.CheckedChanged += (s, e) => UpdateEnabled();
            localUrlBox.TextChanged += (s, e) => statusLabel.Text = string.Empty;
            remoteUrlBox.TextChanged += (s, e) => statusLabel.Text = string.Empty;
            testButton.Click += async (s, e) => await TestAsync();
            saveButton.Click += (s, e) => Save();
            UpdateEnabled();
        }

        private static Control Indented(Control control)
        {
            control.Margin = new Padding(24, 2, 0, 8);
            return control;
        }

        private void UpdateEnabled()
        {
            localUrlBox.Enabled = localRadio.Checked;
            remoteUrlBox.Enabled = remoteRadio.Checked;
            statusLabel.Text = string.Empty;
        }

        private bool TryReadUrl(out Uri url)
        {
            if (AppSettings.TryParseUrl(localRadio.Checked ? localUrlBox.Text : remoteUrlBox.Text, out url)) return true;

            statusLabel.ForeColor = Color.Firebrick;
            statusLabel.Text = "اكتب عنواناً صحيحاً للسيرفر";
            return false;
        }

        private async System.Threading.Tasks.Task TestAsync()
        {
            if (!TryReadUrl(out var url)) return;

            testButton.Enabled = false;
            statusLabel.ForeColor = SystemColors.GrayText;
            statusLabel.Text = "جارٍ الاتصال...";

            var error = await ServerProbe.CheckAsync(url);

            testButton.Enabled = true;
            statusLabel.ForeColor = error == null ? Color.SeaGreen : Color.Firebrick;
            statusLabel.Text = error == null ? "تم الاتصال بالسيرفر" : "تعذّر الاتصال: " + error;
        }

        private void Save()
        {
            if (!TryReadUrl(out var url)) return;

            settings.ServerUrl = url;
            settings.Save();
            DialogResult = DialogResult.OK;
        }
    }
}
