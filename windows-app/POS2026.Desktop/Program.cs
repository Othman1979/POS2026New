using System;
using System.Windows.Forms;

namespace Pos2026.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var settings = AppSettings.Load();
            if (settings.ServerUrl == null)
            {
                using (var form = new SettingsForm(settings))
                {
                    if (form.ShowDialog() != DialogResult.OK) return;
                }
            }

            Application.Run(new MainForm(settings));
        }
    }
}
