using System;
using System.Net.Http;
using System.Threading.Tasks;

namespace Pos2026.Desktop
{
    internal static class ServerProbe
    {
        private static readonly HttpClient Client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };

        public static async Task<string> CheckAsync(Uri serverUrl)
        {
            try
            {
                using (await Client.GetAsync(new Uri(serverUrl, "/health"), HttpCompletionOption.ResponseHeadersRead))
                {
                    return null;
                }
            }
            catch (TaskCanceledException)
            {
                return "انتهت مهلة الاتصال";
            }
            catch (HttpRequestException ex)
            {
                return ex.InnerException?.Message ?? ex.Message;
            }
        }
    }
}
