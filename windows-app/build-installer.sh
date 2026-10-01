#!/usr/bin/env bash
# Builds dist/POS2026-Setup.exe and dist/POS2026-portable.zip (needs .NET SDK 8+, makensis, zip).
set -euo pipefail
cd "$(dirname "$0")"

version="${1:-1.0.0}"
app_dir="$PWD/dist/app"

rm -rf dist
dotnet publish POS2026.Desktop -c Release -p:Version="$version" -o "$app_dir"
rm -f "$app_dir"/*.pdb

(cd installer && makensis -V2 -DAPP_DIR="$app_dir" -DVERSION="$version" -DOUT_FILE="$PWD/../dist/POS2026-Setup.exe" POS2026.nsi)
(cd "$app_dir" && zip -qr ../POS2026-portable.zip .)
ls -lh dist
