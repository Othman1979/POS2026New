using System;
using System.IO;
using System.Net;
using System.Text;

namespace Pos2026.Desktop
{
    internal sealed class AppSettings
    {
        public const string LocalServerUrl = "http://localhost:3000";

        private static readonly string Folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "POS2026");

        private static readonly string FilePath = Path.Combine(Folder, "settings.txt");

        public static readonly string WebViewDataFolder = Path.Combine(Folder, "WebView2");

        public Uri ServerUrl { get; set; }

        public static AppSettings Load()
        {
            var settings = new AppSettings();
            if (!File.Exists(FilePath)) return settings;

            foreach (var line in File.ReadAllLines(FilePath, Encoding.UTF8))
            {
                var separator = line.IndexOf('=');
                if (separator <= 0) continue;

                var key = line.Substring(0, separator).Trim();
                var value = line.Substring(separator + 1).Trim();
                if (key == "ServerUrl" && TryParseUrl(value, out var url)) settings.ServerUrl = url;
            }

            return settings;
        }

        public void Save()
        {
            Directory.CreateDirectory(Folder);
            File.WriteAllText(FilePath, "ServerUrl=" + ServerUrl.AbsoluteUri + Environment.NewLine, Encoding.UTF8);
        }

        public static bool TryParseUrl(string text, out Uri url)
        {
            url = null;
            var value = (text ?? string.Empty).Trim();
            if (value.Length == 0) return false;

            if (value.IndexOf("://", StringComparison.Ordinal) < 0)
            {
                var host = value.Split('/', ':')[0];
                value = (IsLocalHost(host) || IPAddress.TryParse(host, out _) ? "http://" : "https://") + value;
            }

            if (!Uri.TryCreate(value, UriKind.Absolute, out var parsed)) return false;
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return false;
            if (string.IsNullOrEmpty(parsed.Host)) return false;

            url = parsed;
            return true;
        }

        public static bool SameOrigin(Uri a, Uri b) =>
            string.Equals(a.Scheme, b.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase)
            && a.Port == b.Port;

        private static bool IsLocalHost(string host) =>
            string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase) || host == "127.0.0.1";
    }
}
