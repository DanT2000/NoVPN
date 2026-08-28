# Скачивает движок и драйвер адаптера в src-tauri/bin — их нет в git.
#
# Версии закреплены здесь намеренно: Tauri бандлит бинарник как sidecar по точному
# имени, а поведение движка от версии к версии меняется. Обновлять — осознанно,
# правкой этого файла и прогоном --selftest на тестовом сервере.
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-engine.ps1
#
# Почему compatible-сборка mihomo: обычная падает с ACCESS_VIOLATION на
# эмулированных CPU (QEMU, часть виртуалок и старого железа). Compatible собрана
# под базовый набор инструкций и запускается везде ценой небольшой потери
# скорости — для приложения, которое расходится по чужим машинам, это правильный
# размен (см. ARCHITECTURE.md).

$ErrorActionPreference = 'Stop'
$Mihomo = 'v1.19.30'
$Wintun = '0.14.1'

$bin = Join-Path $PSScriptRoot '..\src-tauri\bin'
New-Item -ItemType Directory -Force $bin | Out-Null
$tmp = Join-Path $PSScriptRoot '..\.tmp'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Fetch($url, $out) {
  Write-Host "  <- $url"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
}

# --- mihomo (compatible) ---
$mihomoExe = Join-Path $bin 'mihomo-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path $mihomoExe)) {
  $zip = Join-Path $tmp "mihomo-$Mihomo.zip"
  Fetch "https://github.com/MetaCubeX/mihomo/releases/download/$Mihomo/mihomo-windows-amd64-compatible-$Mihomo.zip" $zip
  $dir = Join-Path $tmp "mihomo-$Mihomo"
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  $exe = Get-ChildItem $dir -Filter '*.exe' | Select-Object -First 1
  Copy-Item $exe.FullName $mihomoExe -Force
  Write-Host "mihomo $Mihomo -> $mihomoExe"
} else {
  Write-Host "mihomo уже на месте: $mihomoExe"
}

# --- wintun ---
$dll = Join-Path $bin 'wintun.dll'
if (-not (Test-Path $dll)) {
  $zip = Join-Path $tmp "wintun-$Wintun.zip"
  Fetch "https://www.wintun.net/builds/wintun-$Wintun.zip" $zip
  $dir = Join-Path $tmp "wintun-$Wintun"
  Expand-Archive -Path $zip -DestinationPath $dir -Force
  Copy-Item (Join-Path $dir 'wintun\bin\amd64\wintun.dll') $dll -Force
  Copy-Item (Join-Path $dir 'wintun\LICENSE.txt') (Join-Path $bin 'LICENSE-wintun.txt') -Force
  Write-Host "wintun $Wintun -> $dll"
} else {
  Write-Host "wintun уже на месте: $dll"
}

Write-Host "--- проверка ---"
& $mihomoExe -v | Select-Object -First 1
