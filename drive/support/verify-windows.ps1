# Checks every file on this drive against SHA256SUMS, for "Verify (Windows).cmd". It reads the files and changes nothing.

$Drive = Split-Path -Parent $PSScriptRoot
$Sums = Join-Path $Drive 'SHA256SUMS'
if (-not (Test-Path -LiteralPath $Sums)) {
  Write-Host 'This drive has no SHA256SUMS file, so there is nothing to check against.'
  exit 1
}

# Where to write about a drive that fails, as the drive's own support\model.tsv says it.
$contact = 'reply to the email your invoice came from'
$modelTsv = Join-Path $PSScriptRoot 'model.tsv'
if (Test-Path -LiteralPath $modelTsv) {
  foreach ($line in (Get-Content -LiteralPath $modelTsv -Encoding UTF8)) {
    $parts = $line.Split("`t", 2)
    if ($parts.Count -eq 2 -and $parts[0] -eq 'contact' -and $parts[1]) { $contact = $parts[1] }
  }
}
# How much there is to read: the sizes of the files SHA256SUMS lists, read at 45 to 90 MB/s, as a USB drive reads.
$total = 0.0
foreach ($line in (Get-Content -LiteralPath $Sums -Encoding UTF8)) {
  if ($line -match '^[0-9a-f]{64}  (.+)$') {
    $item = Get-Item -LiteralPath (Join-Path $Drive ($Matches[1] -replace '/', '\')) -ErrorAction SilentlyContinue
    if ($item) { $total += $item.Length }
  }
}
Write-Host 'Checking every file on this drive against SHA256SUMS.'
Write-Host "Reading about $([math]::Round($total / 1e9)) GB from a USB drive takes $([math]::Floor($total / 5.4e9) + 1) to $([math]::Floor($total / 2.7e9) + 1) minutes."
Write-Host ''
$bad = 0
$count = 0
foreach ($line in (Get-Content -LiteralPath $Sums -Encoding UTF8)) {
  if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { continue }
  $want = $Matches[1]
  $rel = $Matches[2]
  $path = Join-Path $Drive ($rel -replace '/', '\')
  $count++
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Host "MISSING  $rel"
    $bad++
    continue
  }
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($got -eq $want) {
    Write-Host "OK       $rel"
  } else {
    Write-Host "FAILED   $rel"
    $bad++
  }
}

Write-Host ''
if ($bad -eq 0 -and $count -gt 0) {
  Write-Host "PASS: all $count files match their checksums."
  exit 0
}
Write-Host "FAIL: $bad of $count files don't match. Copy nothing from this drive. For a new one, $contact."
exit 1
