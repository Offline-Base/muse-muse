# Sets up the AWS Windows box as a lab box. Run it once in an elevated PowerShell over an SSM session, from an unpacked
# native/lab folder. It's safe to run again. See docs/NATIVE_LAB.md, "Setting up Windows".
#
#   powershell -ExecutionPolicy Bypass -File setup\windows.ps1 -Platform https://muse-muse.vercel.app -Region us-east-1
#
# The box signs in by itself as a standard user, so the agent runs in a real desktop session with no RDP attached. The
# agent stops the box after 20 idle minutes. The password is random, and nothing here prints it.
param(
  [string]$Platform = "https://muse-muse.vercel.app",
  [string]$Region = "us-east-1"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = "C:\MuseLab"
$LabUser = "musemuse"
$NodeVersion = "22.22.2"
$TaskName = "MuseLabAgent"
$IdleMinutes = 20
$Here = Split-Path -Parent $PSScriptRoot
$Version = (Get-Content (Join-Path $Here "package.json") -Raw | ConvertFrom-Json).version

function Step($text) { Write-Host "`n== $text" }

function Get-Verified($url, $file, $expected) {
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  if ($expected) {
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) { throw "The download from $url didn't match its checksum." }
  }
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an elevated PowerShell."
}

foreach ($dir in @($Root, "$Root\data", "$Root\logs", "$Root\releases", "$Root\tools", "$Root\downloads")) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

Step "Node $NodeVersion"
$node = "C:\Program Files\nodejs\node.exe"
$haveNode = (Test-Path $node) -and ((& $node --version) -eq "v$NodeVersion")
if (-not $haveNode) {
  $msi = "node-v$NodeVersion-x64.msi"
  $base = "https://nodejs.org/dist/v$NodeVersion"
  $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $expected = (($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($msi) } | Select-Object -First 1) -split "\s+" | Select-Object -First 1
  if (-not $expected) { throw "Node's checksum list doesn't name $msi." }
  Get-Verified "$base/$msi" "$Root\downloads\$msi" $expected
  Start-Process msiexec.exe -Wait -ArgumentList "/i", "$Root\downloads\$msi", "/qn", "/norestart"
}

Step "ffmpeg"
$ffmpeg = "$Root\tools\ffmpeg\bin\ffmpeg.exe"
if (-not (Test-Path $ffmpeg)) {
  $url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
  $expected = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content.Trim()
  Get-Verified $url "$Root\downloads\ffmpeg.zip" $expected
  $unpacked = "$Root\downloads\ffmpeg"
  if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
  Expand-Archive "$Root\downloads\ffmpeg.zip" $unpacked
  $inner = Get-ChildItem $unpacked -Directory | Select-Object -First 1
  if (Test-Path "$Root\tools\ffmpeg") { Remove-Item "$Root\tools\ffmpeg" -Recurse -Force }
  Move-Item $inner.FullName "$Root\tools\ffmpeg"
}

Step "AWS CLI"
if (-not (Get-Command aws -ErrorAction SilentlyContinue) -and -not (Test-Path "C:\Program Files\Amazon\AWSCLIV2\aws.exe")) {
  Get-Verified "https://awscli.amazonaws.com/AWSCLIV2.msi" "$Root\downloads\AWSCLIV2.msi" $null
  Start-Process msiexec.exe -Wait -ArgumentList "/i", "$Root\downloads\AWSCLIV2.msi", "/qn", "/norestart"
}

Step "The lab user"
Add-Type -AssemblyName System.Web
$password = [System.Web.Security.Membership]::GeneratePassword(32, 6)
$secure = ConvertTo-SecureString $password -AsPlainText -Force
if (Get-LocalUser -Name $LabUser -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $LabUser -Password $secure -PasswordNeverExpires $true
} else {
  New-LocalUser -Name $LabUser -Password $secure -PasswordNeverExpires -AccountNeverExpires -Description "Muse Muse lab agent" | Out-Null
  Add-LocalGroupMember -Group "Users" -Member $LabUser -ErrorAction SilentlyContinue
}
$acl = "${LabUser}:(OI)(CI)M"
& icacls "$Root\data" /grant $acl /T /Q | Out-Null
& icacls "$Root\logs" /grant $acl /T /Q | Out-Null

Step "Letting the lab user shut the box down"
# A standard user on Windows Server can't shut down by default, and the agent has to for the idle stop.
$sid = (Get-LocalUser -Name $LabUser).SID.Value
$policy = "$env:TEMP\muselab-secpol.inf"
$database = "$env:TEMP\muselab-secpol.sdb"
& secedit /export /cfg $policy /areas USER_RIGHTS | Out-Null
$lines = Get-Content $policy
if (-not ($lines | Where-Object { $_ -match "^SeShutdownPrivilege.*$sid" })) {
  $lines = $lines | ForEach-Object { if ($_ -match "^SeShutdownPrivilege") { "$_,*$sid" } else { $_ } }
  Set-Content -Path $policy -Value $lines -Encoding Unicode
  & secedit /configure /db $database /cfg $policy /areas USER_RIGHTS /quiet | Out-Null
}
Remove-Item $policy, $database -Force -ErrorAction SilentlyContinue

Step "No sleep and no screen lock"
& powercfg /change monitor-timeout-ac 0
& powercfg /change standby-timeout-ac 0
& powercfg /change hibernate-timeout-ac 0
$personalization = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization"
New-Item -Path $personalization -Force | Out-Null
Set-ItemProperty -Path $personalization -Name NoLockScreen -Value 1 -Type DWord
$system = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
Set-ItemProperty -Path $system -Name InactivityTimeoutSecs -Value 0 -Type DWord
$desktop = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop"
New-Item -Path $desktop -Force | Out-Null
Set-ItemProperty -Path $desktop -Name ScreenSaveActive -Value "0" -Type String

Step "Auto sign-in"
# Windows' own auto sign-in, with the password as an LSA secret rather than in plain text in the registry. No extra tool is
# needed, and so there's no third-party license for the box to accept.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MuseLabLsa {
  [StructLayout(LayoutKind.Sequential)]
  struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct LsaAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LsaAttributes attributes, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr policy, ref LsaString key, ref LsaString data);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  static LsaString Make(string text) {
    var value = new LsaString();
    value.Buffer = Marshal.StringToHGlobalUni(text);
    value.Length = (ushort)(text.Length * 2);
    value.MaximumLength = (ushort)(text.Length * 2 + 2);
    return value;
  }
  public static void Store(string key, string secret) {
    var attributes = new LsaAttributes();
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x00000020 | 0x00000004, out policy);
    if (status != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(status));
    var name = Make(key);
    var data = Make(secret);
    try {
      status = LsaStorePrivateData(policy, ref name, ref data);
      if (status != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(status));
    } finally {
      Marshal.ZeroFreeGlobalAllocUnicode(data.Buffer);
      Marshal.FreeHGlobal(name.Buffer);
      LsaClose(policy);
    }
  }
}
"@
[MuseLabLsa]::Store("DefaultPassword", $password)
Remove-Variable password, secure
$winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value "1" -Type String
Set-ItemProperty -Path $winlogon -Name DefaultUserName -Value $LabUser -Type String
Set-ItemProperty -Path $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String
Remove-ItemProperty -Path $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue

Step "The agent"
$release = "$Root\releases\$Version"
if ($Here -ne $release) {
  if (Test-Path $release) { Remove-Item $release -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $release | Out-Null
  Get-ChildItem $Here -Force | Where-Object { $_.Name -notin @("__tests__", "node_modules") } | Copy-Item -Destination $release -Recurse -Force
}
$current = "$Root\current"
if (Test-Path $current) { cmd /c rmdir $current | Out-Null }
New-Item -ItemType Junction -Path $current -Target $release | Out-Null
& icacls $release /grant "${LabUser}:(OI)(CI)RX" /T /Q | Out-Null

$start = @"
`$ErrorActionPreference = 'Continue'
try { Set-DisplayResolution -Width 1920 -Height 1080 -Force } catch { }
`$env:MUSE_LAB_LANE = 'windows'
`$env:MUSE_LAB_ROOT = '$Root'
`$env:MUSE_LAB_PLATFORM = '$Platform'
`$env:MUSE_LAB_IDLE_MINUTES = '$IdleMinutes'
`$env:MUSE_LAB_FFMPEG = '$ffmpeg'
`$env:AWS_REGION = '$Region'
`$env:PATH = 'C:\Program Files\nodejs;C:\Program Files\Amazon\AWSCLIV2;' + `$env:PATH
# Through cmd, because PowerShell 5's own redirect writes UTF-16 and wraps stderr in error records.
& cmd.exe /c '"C:\Program Files\nodejs\node.exe" "$current\agent.mjs" >> "$Root\logs\agent.log" 2>&1'
exit `$LASTEXITCODE
"@
Set-Content -Path "$Root\start-agent.ps1" -Value $start -Encoding UTF8

Step "The logon task"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $Root\start-agent.ps1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $LabUser
$principal = New-ScheduledTaskPrincipal -UserId $LabUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Step "Done"
Write-Host "Reboot once. The box signs in by itself and the agent starts. Check $Root\logs\agent.log."
