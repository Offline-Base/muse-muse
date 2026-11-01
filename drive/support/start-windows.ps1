# Starts the model on this drive on a Windows PC, for "Start (Windows).cmd".
#
# It never downloads anything. It reads this PC's memory and graphics card, picks the build that fits (builds.tsv here,
# the same table the Muse Muse website uses), offers to copy that build to this PC, then starts the llama.cpp server
# on 127.0.0.1 only and opens its chat page in your browser. Close the window to stop the model.

$ErrorActionPreference = 'Stop'
$Drive = Split-Path -Parent $PSScriptRoot
$Support = $PSScriptRoot

function Finish([string]$Text, [int]$Code = 1) {
  Write-Host ''
  Write-Host $Text
  exit $Code
}

function Ask-Yes([string]$Question, [bool]$Default) {
  $answer = Read-Host $Question
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer.Trim().ToLowerInvariant().StartsWith('y')
}

function Sum-Of([string]$Rel) {
  foreach ($line in (Get-Content -LiteralPath (Join-Path $Drive 'SHA256SUMS') -Encoding UTF8)) {
    if ($line -match '^([0-9a-f]{64})  (.+)$' -and $Matches[2] -eq $Rel) { return $Matches[1] }
  }
  return ''
}

foreach ($name in 'builds.tsv', 'files.tsv', 'model.tsv') {
  if (-not (Test-Path -LiteralPath (Join-Path $Support $name))) {
    Finish 'This drive is missing its support folder. Run Verify (Windows).cmd to check its files.'
  }
}
$model = @{}
foreach ($line in (Get-Content -LiteralPath (Join-Path $Support 'model.tsv') -Encoding UTF8)) {
  $parts = $line.Split("`t", 2)
  if ($parts.Count -eq 2) { $model[$parts[0]] = $parts[1] }
}
$slug = if ($model['slug']) { $model['slug'] } else { 'model' }
$page = if ($model['page']) { $model['page'] } else { "the model's page on the Muse Muse website" }
# >>> adapter
# A model fine-tuned on a board is its base build with a LoRA adapter on top, as the board ran it (support\model.tsv).
$adapter = $model['adapter']
if ($adapter -and -not (Test-Path -LiteralPath (Join-Path $Drive "model\$adapter"))) {
  Finish "The adapter $adapter is missing from this drive. Run Verify (Windows).cmd to check its files."
}
# <<< adapter
Write-Host "$($model['title']), from a Muse Muse flash drive."
Write-Host ''

# 1. Smart App Control blocks programs that aren't signed, with no way around it, and this drive's server isn't signed
#    yet. Its state is 1 when it is on (0 off, 2 evaluating).
$sac = 0
try {
  $sac = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState').VerifiedAndReputablePolicyState
} catch { $sac = 0 }
if ($sac -eq 1) {
  Finish "Smart App Control is on, and it blocks this drive's model server, which isn't signed yet. Windows PCs with Smart App Control on aren't supported yet. Try it live instead, on its page: $page"
}

# 2. The machine: its memory, and its graphics card's own memory. nvidia-smi knows an NVIDIA card's; for other cards
#    the registry's 64-bit size does, since Win32_VideoController's AdapterRAM stops at 4 GB.
$ramGb = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
$vramGb = 0.0
$gpuName = ''
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  try {
    foreach ($line in (& $smi.Source --query-gpu=name,memory.total --format=csv,noheader,nounits)) {
      $parts = $line.Split(',')
      $gb = [double]$parts[$parts.Count - 1].Trim() / 1024
      if ($gb -gt $vramGb) { $vramGb = $gb; $gpuName = $parts[0].Trim() }
    }
  } catch { }
}
if ($vramGb -eq 0) {
  $class = 'HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  foreach ($key in (Get-ChildItem -Path $class -ErrorAction SilentlyContinue)) {
    try {
      $props = Get-ItemProperty -Path $key.PSPath
      $size = $props.'HardwareInformation.qwMemorySize'
      if ($size -is [byte[]]) { $size = [BitConverter]::ToInt64($size, 0) }
      if ($size) {
        $gb = [double]$size / 1GB
        if ($gb -gt $vramGb) { $vramGb = $gb; $gpuName = $props.DriverDesc }
      }
    } catch { }
  }
}
$ramShown = [math]::Round($ramGb)
$vramShown = [math]::Round($vramGb)
if ($gpuName) {
  Write-Host "This PC: $ramShown GB of memory, and $gpuName with $vramShown GB of its own."
} else {
  Write-Host "This PC: $ramShown GB of memory, and no graphics card with memory of its own."
}

# 3. The build: the row for the sizes this PC has at least. Windows keeps a little memory for the hardware, so a
#    "32 GB" PC reads about 31.8 GB, and a 24 GB card about 23.9.
$rows = @(Import-Csv -LiteralPath (Join-Path $Support 'builds.tsv') -Delimiter "`t" | Where-Object { $_.kind -eq 'pc' })
$ramSizes = @($rows | ForEach-Object { [int]$_.memory_gb } | Where-Object { $_ -le $ramGb + 2 } | Sort-Object)
$vramSizes = @($rows | ForEach-Object { [int]$_.vram_gb } | Where-Object { $_ -le $vramGb + 1 } | Sort-Object)
$row = $null
if ($ramSizes.Count -gt 0) {
  $ramNominal = $ramSizes[$ramSizes.Count - 1]
  $vramNominal = if ($vramSizes.Count -gt 0) { $vramSizes[$vramSizes.Count - 1] } else { 0 }
  $row = $rows | Where-Object { [int]$_.memory_gb -eq $ramNominal -and [int]$_.vram_gb -eq $vramNominal } | Select-Object -First 1
}
$files = @(Import-Csv -LiteralPath (Join-Path $Support 'files.tsv') -Delimiter "`t")
if (-not $row -or $row.level -eq '-') {
  $fits = @($rows | Where-Object { $_.level -ne '-' })
  $minVram = ($fits | Where-Object { $_.where -eq 'gpu' } | ForEach-Object { [int]$_.vram_gb } | Measure-Object -Minimum).Minimum
  $minRam = ($fits | Where-Object { $_.where -eq 'cpu' } | ForEach-Object { [int]$_.memory_gb } | Measure-Object -Minimum).Minimum
  $needs = @()
  if ($minVram) { $needs += "a graphics card with $minVram GB of its own memory or more" }
  if ($minRam) { $needs += "$minRam GB of memory" }
  Write-Host ''
  if ($needs.Count -gt 0) { Write-Host "This model needs $($needs -join ', or '), and this PC has less." }
  else { Write-Host "None of the builds on this drive fits this PC." }
  Write-Host 'It would run very slowly here, if at all, and other programs would slow down too.'
  if (-not (Ask-Yes 'Try the smallest build anyway? [y/N]' $false)) {
    Finish "Nothing was started. Try it live instead, on its page: $page" 0
  }
  $level = $files[0].level
  $runtime = if ($vramGb -ge 4) { 'windows-x64-vulkan' } else { 'windows-x64-cpu' }
  $fit = 'no'
  $where = 'cpu'
} else {
  $level = $row.level
  $runtime = $row.runtime
  $fit = $row.fit
  $where = $row.where
}
$file = $files | Where-Object { $_.level -eq $level } | Select-Object -First 1
if (-not $file -or -not (Test-Path -LiteralPath (Join-Path $Drive "model\$($file.name)"))) {
  Finish "The $level build is missing from this drive. Run Verify (Windows).cmd to check its files."
}
$sizeGb = [math]::Round([double]$file.bytes / 1e9)
switch ($fit) {
  'well' { Write-Host "The $level build ($sizeGb GB) runs well on this PC's graphics card." }
  'slow' {
    if ($where -eq 'split') { Write-Host "The $level build ($sizeGb GB) runs slowly here: part of it runs on the processor." }
    else { Write-Host "The $level build ($sizeGb GB) runs slowly here, on the processor. Long answers take minutes." }
  }
  default { Write-Host "Starting the $level build ($sizeGb GB). Expect it to be slow." }
}
Write-Host ''

# 4. Copy it to this PC, if the person agrees: loads are faster and the drive can come out.
$runDir = $Drive
$want = Sum-Of "model/$($file.name)"
$copy = Join-Path (Join-Path $env:LOCALAPPDATA 'Muse Muse') $slug
$copied = Join-Path $copy "model\$($file.name)"
$marker = "$copied.verified"
if ($want -and (Test-Path -LiteralPath $copied) -and (Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $want)) {
  Write-Host "Using the copy on this PC, in $copy."
  $runDir = $copy
} elseif (Ask-Yes "Copy the $level build to this PC first? Loads are faster, and you can take the drive out. [Y/n]" $true) {
  $free = (Get-PSDrive -Name $env:LOCALAPPDATA.Substring(0, 1)).Free
  $need = [double]$file.bytes + 5GB
  if ($free -lt $need) {
    Write-Host "There isn't room to copy it: it needs $([math]::Ceiling($need / 1e9)) GB free, and this PC has $([math]::Floor($free / 1e9)) GB. Running it from the drive instead."
  } else {
    # At about 100 MB/s from a USB 3 drive; a slower drive or port takes longer. robocopy shows how far it has got.
    Write-Host "Copying $sizeGb GB to $copy. This takes about $([math]::Floor([double]$file.bytes / 6e9) + 1) minutes."
    try {
      foreach ($dir in 'model', 'runtime') {
        $path = Join-Path $copy $dir
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
        New-Item -ItemType Directory -Path $path -Force | Out-Null
      }
      Copy-Item -LiteralPath (Join-Path $Drive "runtime\$runtime") -Destination (Join-Path $copy 'runtime') -Recurse
      foreach ($small in 'ui-config.json', 'system.txt', 'tuned.jinja') {
        $from = Join-Path $Drive "model\$small"
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $copy 'model') }
      }
# >>> adapter
      if ($adapter) {
        # It goes with the build. A copy that doesn't match its checksum is deleted, and the drive's own is used.
        $adapterCopy = Join-Path $copy "model\$adapter"
        Copy-Item -LiteralPath (Join-Path $Drive "model\$adapter") -Destination $adapterCopy
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $adapterCopy).Hash.ToLowerInvariant() -ne (Sum-Of "model/$adapter")) {
          Remove-Item -LiteralPath $adapterCopy -Force
        }
      }
# <<< adapter
      # robocopy shows how far a big copy has got. Its exit codes under 8 mean the copy worked.
      & robocopy.exe (Join-Path $Drive 'model') (Join-Path $copy 'model') $file.name /J /NJH /NJS /NDL /NC /NS | Out-Host
      if ($LASTEXITCODE -ge 8) { throw 'robocopy failed' }
      Write-Host 'Checking the copy against its checksum.'
      $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $copied).Hash.ToLowerInvariant()
      if ($want -and $got -eq $want) {
        Set-Content -LiteralPath $marker -Value $want -NoNewline
        $runDir = $copy
        Write-Host 'The copy matches. You can take the drive out once the chat opens.'
      } else {
        Remove-Item -LiteralPath $copied -Force
        Write-Host "The copy didn't match its checksum, so it was deleted. Running it from the drive instead."
      }
    } catch {
      if (Test-Path -LiteralPath $copied) { Remove-Item -LiteralPath $copied -Force }
      Write-Host "The copy didn't finish. Running it from the drive instead."
    }
  }
}

# 5. A free port on 127.0.0.1, then the server, with the chat's system message preset (model\ui-config.json).
function Port-Free([int]$Port) {
  try {
    return -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
  } catch {
    return $true
  }
}
$port = 0
foreach ($p in 9931..9950) {
  if (Port-Free $p) { $port = $p; break }
}
if ($port -eq 0) { Finish 'Ports 9931 to 9950 are all in use on this PC. Close the other model server and try again.' }

function Start-Server([string]$Runtime) {
  $exe = Join-Path $runDir "runtime\$Runtime\llama-server.exe"
  if (-not (Test-Path -LiteralPath $exe)) { $exe = Join-Path $Drive "runtime\$Runtime\llama-server.exe" }
  $modelPath = Join-Path $runDir "model\$($file.name)"
  $ui = Join-Path $runDir 'model\ui-config.json'
  $tuned = Join-Path $runDir 'model\tuned.jinja'
  $list = @('-m', "`"$modelPath`"", '--host', '127.0.0.1', '--port', "$port", '--offline', '--jinja', '-c', '8192',
    '--no-mmproj', '-np', '1', '--temp', '0', '--ui-config-file', "`"$ui`"")
  if (Test-Path -LiteralPath $tuned) {
    # A model trained before it learned to open its answer itself needs the template that opens it.
    $list += @('--chat-template-file', "`"$tuned`"", '--skip-chat-parsing', '--reasoning', 'off')
  }
# >>> adapter
  if ($adapter) {
    # The copy's adapter when the copy has one, else the drive's.
    $lora = Join-Path $runDir "model\$adapter"
    if (-not (Test-Path -LiteralPath $lora)) { $lora = Join-Path $Drive "model\$adapter" }
    $list += @('--lora', "`"$lora`"")
  }
# <<< adapter
  return Start-Process -FilePath $exe -ArgumentList $list -NoNewWindow -PassThru
}

# curl.exe ships with Windows 10 (1803 and later) and 11, and unlike Invoke-WebRequest it never sends 127.0.0.1 through a
# proxy. Older Windows 10 gets Invoke-WebRequest.
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
function Health-Ok {
  try {
    if ($curl) { return (& $curl.Source -s -o NUL -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/health") -eq '200' }
    return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$port/health").StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-Ready($Server) {
  for ($i = 0; $i -lt 600; $i++) {
    if ($Server.HasExited) { return $false }
    if (Health-Ok) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

Write-Host ''
Write-Host 'Loading the model. The first time after copying or plugging in the drive can take up to 10 minutes.'
Write-Host "The server's messages scroll by below while it loads. That's normal: the chat opens once it's ready."
$server = Start-Server $runtime
$ready = Wait-Ready $server
if (-not $ready -and $server.HasExited -and $runtime -eq 'windows-x64-vulkan' -and $ramGb + 2 -ge 32) {
  Write-Host ''
  Write-Host "The graphics card's build stopped. Trying the processor-only build instead, which is slower."
  $server = Start-Server 'windows-x64-cpu'
  $ready = Wait-Ready $server
}
if (-not $ready) {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  Finish "The model server stopped or didn't finish loading. Its messages are above."
}

Start-Process "http://127.0.0.1:$port/"
Write-Host ''
Write-Host "The chat is open at http://127.0.0.1:$port in your browser. Only this PC can reach it."
Write-Host 'Keep this window open while you use it. Close it to stop the model.'
$server.WaitForExit()
