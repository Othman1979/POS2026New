using System;
using System.Net;

namespace Pos2026.Desktop
{
    internal static class OfflinePage
    {
        public static string Html(Uri serverUrl) => @"<!doctype html>
<html lang=""ar"" dir=""rtl"">
<head>
<meta charset=""utf-8"">
<title>POS2026</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; background: #0f172a; color: #e2e8f0;
         font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
  main { max-width: 520px; padding: 32px; text-align: center; }
  h1 { margin: 0 0 12px; font-size: 26px; }
  p { margin: 0 0 8px; color: #94a3b8; line-height: 1.7; }
  bdi { color: #e2e8f0; }
  .actions { display: flex; gap: 12px; justify-content: center; margin-top: 24px; }
  button { border: 0; border-radius: 10px; padding: 12px 22px; font: inherit; font-size: 16px; cursor: pointer; }
  .primary { background: #14b8a6; color: #04201d; font-weight: 700; }
  .secondary { background: #1e293b; color: #e2e8f0; }
</style>
</head>
<body>
<main>
  <h1>تعذّر الاتصال بالسيرفر</h1>
  <p>العنوان: <bdi dir=""ltr"">" + WebUtility.HtmlEncode(serverUrl.AbsoluteUri) + @"</bdi></p>
  <p>تأكد أن السيرفر يعمل وأن الجهاز متصل بالشبكة. يعيد التطبيق المحاولة تلقائياً كل 10 ثوانٍ.</p>
  <div class=""actions"">
    <button class=""primary"" onclick=""chrome.webview.postMessage('retry')"">إعادة المحاولة</button>
    <button class=""secondary"" onclick=""chrome.webview.postMessage('settings')"">إعدادات السيرفر</button>
  </div>
</main>
</body>
</html>";
    }
}
