#!/usr/bin/env pwsh
# setup.ps1 — Windows (PowerShell) one-command install of dsh-lark-bridge (bundle mode).
# Mirror of scripts/setup.sh; idempotent (safe to re-run).
#
# What it does:
#   1. preflight: Node version / pnpm / dsh profile
#   2. build the plugin if lib/ is missing
#   3. junction-link the plugin into the profile's node_modules
#      (a directory junction needs no admin rights, unlike a symlink)
#   4. register "dsh-lark-bridge" in the profile's dsh.profile.bundles
#   5. print next steps
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1   (Windows PowerShell 5.1)
#   pwsh scripts/setup.ps1                                       (PowerShell 7+)
#   $env:DSH_PROFILE = 'headless'; pwsh scripts/setup.ps1        (different profile)
#   $env:DSH_HOME = 'D:\...\.dsh'; pwsh scripts/setup.ps1        (custom dsh home)

$ErrorActionPreference = 'Stop'

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$Profile = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$Manifest = Join-Path $ProfileDir 'package.json'
$Link = Join-Path $ProfileDir (Join-Path 'node_modules' 'dsh-lark-bridge')

Write-Host '==> dsh-lark-bridge setup'
Write-Host "    project : $ProjectDir"
Write-Host "    profile : $ProfileDir"

# 1. Preflight: node (dsh needs ^22.19.0 || >=24.0.0)
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'node not found in PATH. Install Node.js ^22.19.0 or >=24.0.0 (https://nodejs.org).'
    exit 1
}
$nodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($nodeMajor -lt 22) {
    Write-Error "node $(& node -v) is too old - dsh needs ^22.19.0 || >=24.0.0."
    exit 1
}
Write-Host "    node    : $(& node -v) (ok)"

# 2. Build the plugin if needed
if (-not (Test-Path (Join-Path $ProjectDir 'lib\index.js'))) {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Error 'pnpm not found in PATH - needed to build the plugin (or run "corepack enable").'
        exit 1
    }
    Write-Host '==> building plugin (pnpm install && pnpm build)'
    Push-Location $ProjectDir
    try {
        & pnpm install
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Host '    build  : lib/ present, skipping build'
}

# 3. The profile must exist (first `dsh web` run creates it)
if (-not (Test-Path $ProfileDir)) {
    Write-Error "profile '$Profile' does not exist yet. Start dsh once (e.g. 'dsh web') so the profile is created, then re-run this script."
    exit 1
}

# 4. Link the plugin into the profile's node_modules.
#    Windows: directory junction (no admin rights needed).
#    macOS/Linux (pwsh): symbolic link — `-ItemType Junction` is a silent
#    no-op on Unix, so branch on the OS explicitly.
$IsWindowsOs = $env:OS -eq 'Windows_NT'
$ModulesDir = Split-Path $Link
New-Item -ItemType Directory -Force -Path $ModulesDir | Out-Null
if (Test-Path $Link) {
    $existing = Get-Item $Link -Force
    if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
        Write-Host "==> link already present: $Link"
    }
    else {
        Write-Error "$Link exists and is not a link - remove it first."
        exit 1
    }
}
else {
    if ($IsWindowsOs) {
        New-Item -ItemType Junction -Path $Link -Target $ProjectDir | Out-Null
    }
    else {
        New-Item -ItemType SymbolicLink -Path $Link -Target $ProjectDir | Out-Null
    }
    # Verify the link actually landed — Unix junctions fail silently otherwise.
    if (-not (Test-Path $Link)) {
        Write-Error "link creation failed for $Link"
        exit 1
    }
    Write-Host "==> linked $Link -> $ProjectDir"
}

# 5. Register the bundle in the profile manifest (idempotent)
$pkg = Get-Content $Manifest -Raw | ConvertFrom-Json
if ($null -eq $pkg.dsh) {
    $pkg | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $pkg.dsh.profile) {
    $pkg.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $pkg.dsh.profile.bundles) {
    $pkg.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue @()
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -contains 'dsh-lark-bridge') {
    Write-Host "==> bundle already registered in $Manifest"
}
else {
    $pkg.dsh.profile.bundles = @($bundles + 'dsh-lark-bridge')
    # Depth 10 keeps the nested dsh.profile.bundles intact; UTF-8 without BOM
    # so Node's JSON.parse never trips on a BOM.
    $json = $pkg | ConvertTo-Json -Depth 10
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Manifest, $json + [Environment]::NewLine, $utf8NoBom)
    Write-Host "==> registered dsh-lark-bridge bundle in $Manifest"
}

Write-Host ''
Write-Host '==> Done. Next steps:'
Write-Host '  1. Start dsh - the bundle loads automatically, no --patch needed:'
Write-Host '     $env:DSH_PERMISSION_MODE = "danger-full-access"; dsh web'
Write-Host '  2. On first run, scan the QR code with the Feishu app, or open the URL'
Write-Host '     written to ~\.dsh-lark-bridge\register-url.txt in a browser.'
Write-Host '  3. Add the bot to a group chat (or DM it) and send /help.'
