[CmdletBinding()]
param(
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$flutter = 'C:\flutter\bin\flutter.bat'
$adb = 'C:\Users\LENOVO\AppData\Local\Android\Sdk\platform-tools\adb.exe'
$packageName = 'com.bluelinegpt.mobile.dev'
$launchActivity = 'com.bluelinegpt.mobile.MainActivity'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$apkPath = Join-Path $projectRoot 'build\app\outputs\flutter-apk\app-dev-debug.apk'
$devBuildStatePath = Join-Path $PSScriptRoot '.dev-build-number'

function Require-Tool {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Name was not found at: $Path"
    }
}

function Invoke-Checked {
    param([string]$Label, [string]$FilePath, [string[]]$Arguments)
    Write-Host "[DEV] $Label" -ForegroundColor Cyan
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

Require-Tool -Path $flutter -Name 'Flutter'
Require-Tool -Path $adb -Name 'Android Debug Bridge (ADB)'

$pubspec = Get-Content -Raw (Join-Path $projectRoot 'pubspec.yaml')
if ($pubspec -notmatch '(?m)^version:\s+([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)\s*$') {
    throw 'Unable to resolve the package version/build number from pubspec.yaml.'
}
$versionName = $Matches[1]
$packageBuildNumber = [int]$Matches[2]
$previousDevBuild = if (Test-Path -LiteralPath $devBuildStatePath) {
    [int](Get-Content -Raw $devBuildStatePath)
} else {
    $packageBuildNumber
}
$devBuildNumber = [Math]::Max($packageBuildNumber, $previousDevBuild) + 1
Set-Content -LiteralPath $devBuildStatePath -Value $devBuildNumber -NoNewline

Push-Location $projectRoot
try {
    Invoke-Checked -Label 'Cleaning Flutter development build' -FilePath $flutter -Arguments @('clean')
    Invoke-Checked -Label 'Resolving Flutter dependencies' -FilePath $flutter -Arguments @('pub', 'get')
    Invoke-Checked -Label 'Building development debug APK' -FilePath $flutter -Arguments @(
        'build', 'apk', '--debug', '--flavor', 'dev', '-t', 'lib/main.dart',
        '--dart-define-from-file=config/development.json', "--build-number=$devBuildNumber"
    )

    if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
        throw "Expected development APK was not created: $apkPath"
    }

    Write-Host '[DEV] Checking Android devices' -ForegroundColor Cyan
    $devices = & $adb devices
    if ($LASTEXITCODE -ne 0) {
        throw "ADB device discovery failed with exit code $LASTEXITCODE."
    }
    $authorizedDevices = @($devices | Select-String -Pattern "^\S+\s+device$")
    if ($authorizedDevices.Count -eq 0) {
        throw 'No authorized Android device is connected. Unlock the device, accept USB debugging, then retry.'
    }
    if ($authorizedDevices.Count -gt 1) {
        throw 'More than one authorized Android device is connected. Disconnect all but one, then retry.'
    }

    Invoke-Checked -Label 'Installing development debug APK' -FilePath $adb -Arguments @('install', '-r', $apkPath)

    if ($Launch) {
        Invoke-Checked -Label 'Launching BluelineGPT Dev' -FilePath $adb -Arguments @(
            'shell', 'am', 'start', '-n', "$packageName/$launchActivity"
        )
    }

    Write-Host "[DEV] Success. Version: $versionName+$devBuildNumber; APK: $apkPath" -ForegroundColor Green
} catch {
    Write-Error "[DEV] Rebuild/install failed: $($_.Exception.Message)"
    exit 1
} finally {
    Pop-Location
}
