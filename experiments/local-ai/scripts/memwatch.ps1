<#
.SYNOPSIS
  Sampled memory/CPU watcher for one PID, used by the local-AI benchmarks.

.DESCRIPTION
  Polls Get-Process for a target PID and appends one CSV line per sample:
  elapsed ms, working set (RSS), private bytes, the OS-tracked peak working set
  since process start, CPU ms, free physical RAM and the current benchmark
  PHASE.

  The phase is read from a small text file the measured process rewrites when
  it enters a new phase. That avoids any clock synchronisation between the two
  processes: the sample is tagged with the phase that was in effect when it was
  taken, so per-phase peaks are attributable.

  A separate process is used deliberately: sampling from inside the measured
  Node process cannot see the native (ONNX Runtime arena) growth correctly and
  would perturb the very numbers being measured. `PeakWorkingSet64` is the
  Windows kernel's high-water mark for the process, so it is exact even between
  polls; the sampled WorkingSet series is what the per-phase split relies on.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/memwatch.ps1 -TargetPid 1234 -Out results\mem.csv -PhaseFile results\mem.phase
#>
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$PhaseFile = '',
  [int]$IntervalMs = 50,
  [int]$MaxSeconds = 7200
)

$ErrorActionPreference = 'SilentlyContinue'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("elapsed_ms,pid,phase,working_set_bytes,private_bytes_bytes,peak_working_set_bytes,cpu_ms,free_ram_bytes")
while ($sw.Elapsed.TotalSeconds -lt $MaxSeconds) {
  $p = Get-Process -Id $TargetPid
  if ($null -eq $p) { break }
  $phase = 'load'
  if ($PhaseFile -ne '' -and (Test-Path $PhaseFile)) {
    $c = (Get-Content -Path $PhaseFile -Raw -ErrorAction SilentlyContinue)
    if ($c) { $phase = $c.Trim() }
  }
  $os = Get-CimInstance Win32_OperatingSystem
  $free = if ($os) { [long]$os.FreePhysicalMemory * 1024 } else { -1 }
  $lines.Add(("{0},{1},{2},{3},{4},{5},{6},{7}" -f `
      [long]$sw.ElapsedMilliseconds, $p.Id, $phase, [long]$p.WorkingSet64, [long]$p.PrivateMemorySize64, `
      [long]$p.PeakWorkingSet64, [long]($p.CPU * 1000), $free))
  Start-Sleep -Milliseconds $IntervalMs
}
$lines | Set-Content -Path $Out -Encoding ASCII
Write-Output ("samples={0} out={1}" -f ($lines.Count - 1), $Out)
