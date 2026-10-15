param([string]$NodePath = '')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appPath = Join-Path $projectRoot 'src-tauri\target\debug\galgame-manager.exe'
$vitePath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
$mutex = New-Object System.Threading.Mutex($false, 'Local\KoiPageDesktopLauncher')
$ownsMutex = $false

function Test-AppFrontend {
    try {
        $page = Invoke-WebRequest -Uri 'http://127.0.0.1:1420' -UseBasicParsing -TimeoutSec 2
        return $page.Content.Contains('/src/main.tsx') -and $page.Content.Contains('KoiPage')
    } catch {
        return $false
    }
}

try {
    try { $ownsMutex = $mutex.WaitOne(30000) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another KoiPage launch is still in progress. Please try again shortly.' }
    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
        throw 'The development app is missing. Build the desktop app before using this shortcut.'
    }

    if (-not (Test-AppFrontend)) {
        if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
        if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js could not be found.' }
        if (-not (Test-Path -LiteralPath $vitePath -PathType Leaf)) { throw 'Frontend dependencies are missing. Run pnpm install in the project folder.' }
        $logDirectory = Join-Path $env:LOCALAPPDATA 'KoiPage\logs'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $server = Start-Process -FilePath $NodePath -ArgumentList @(('"{0}"' -f $vitePath), '--host', '127.0.0.1') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'desktop-vite.log') -RedirectStandardError (Join-Path $logDirectory 'desktop-vite-error.log') -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(25)
        while (-not (Test-AppFrontend)) {
            if ($server.HasExited) { throw ('The local frontend service failed to start. See {0}' -f $logDirectory) }
            if ([DateTime]::UtcNow -gt $deadline) {
                Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
                throw ('The local frontend service did not become ready. See {0}' -f $logDirectory)
            }
            Start-Sleep -Milliseconds 250
        }
    }

    $existing = Get-Process -Name 'galgame-manager' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appPath } | Select-Object -First 1
    if (-not $existing) {
        $existing = Start-Process -FilePath $appPath -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru
    }
    # Restore an existing minimized window and bring it forward.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KoiPageDesktopWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@
    $windowDeadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $existing.Refresh()
        if ($existing.HasExited) { throw 'KoiPage closed before its window became ready.' }
        if ($existing.MainWindowHandle -ne [IntPtr]::Zero) {
            [KoiPageDesktopWindow]::ShowWindowAsync($existing.MainWindowHandle, 9) | Out-Null
            [KoiPageDesktopWindow]::SetForegroundWindow($existing.MainWindowHandle) | Out-Null
            break
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $windowDeadline)
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'KoiPage', 'OK', 'Error') | Out-Null
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
