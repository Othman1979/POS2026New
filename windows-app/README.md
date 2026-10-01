# POS2026 for Windows

A small Windows desktop app (C# WinForms, .NET Framework 4.8) that opens POSApp in its own window through Microsoft Edge WebView2. It has no address bar or browser controls and does not change the web app, the server or the print spooler.

## Use

- Install with `POS2026-Setup.exe` (per-user, no admin rights), or unzip `POS2026-portable.zip` and run `POS2026.exe`.
- On first start choose the server: on this machine (`http://localhost:3000`) or an external server such as Hostinger (`https://...`). The choice is saved in `%LOCALAPPDATA%\POS2026\settings.txt`.
- Change the server later from the window menu (right-click the title bar, then "إعدادات السيرفر..."), or from the screen shown when the server cannot be reached.
- If the server is unreachable the app shows a retry screen and reconnects by itself as soon as the server answers.
- Links to other sites open in the default browser. Pop-ups from the same server (report printing) open in an app window.

## Requirements

- Windows 10 or 11 (.NET Framework 4.8 is built in).
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 11 and on updated Windows 10). If it is missing the app opens Microsoft's download page.

## Build

- Windows: `dotnet publish POS2026.Desktop -c Release -o dist\app` (or open `POS2026.Desktop.csproj` in Visual Studio).
- Linux or WSL with `makensis` and `zip`: `./build-installer.sh 1.0.0` produces `dist/POS2026-Setup.exe` and `dist/POS2026-portable.zip`.
