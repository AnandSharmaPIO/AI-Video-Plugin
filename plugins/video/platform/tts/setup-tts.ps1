<#
.SYNOPSIS
  setup-tts.ps1 - create the Python venv for narration TTS on Windows.

  Native PowerShell equivalent of setup-tts.sh, so a Windows user does NOT need
  Git Bash to build the (mandatory) TTS venv. The venv lands at platform/tts/venv
  (gitignored) unless $env:WALKTHROUGH_TTS_VENV is set.

  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
  scripts as the system ANSI codepage, so a UTF-8 (no BOM) file with box-drawing
  or em-dash characters fails to parse. Keep it ASCII.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File platform\tts\setup-tts.ps1
  powershell -ExecutionPolicy Bypass -File platform\tts\setup-tts.ps1 -Predownload
  powershell -ExecutionPolicy Bypass -File platform\tts\setup-tts.ps1 -Python "py -3.12"

  The TTS stack (chatterbox-tts -> torch/spacy/numpy) ships wheels for Python
  3.10-3.12 ONLY. Newer Pythons (3.13/3.14) have no wheels and the build fails,
  so this script auto-selects a supported version and refuses an unsupported one.
  Chatterbox pulls a CPU build of torch by default (no GPU needed). For CUDA,
  install a CUDA torch into the venv yourself afterward.
#>
[CmdletBinding()]
param([switch]$Predownload, [string]$Python)

# NOT 'Stop': Windows PowerShell 5.1 turns a native command's stderr into a
# TERMINATING error under Stop (e.g. python printing "No module named pip"),
# which would kill the script mid-probe. We drive control flow off exit codes
# ($LASTEXITCODE) instead, and fail loudly only where it matters.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path        # platform/tts
$venv = if ($env:WALKTHROUGH_TTS_VENV) { $env:WALKTHROUGH_TTS_VENV } else { Join-Path $here 'venv' }

# Run a native command silently and return its exit code. Nothing here throws;
# callers decide what a non-zero code means.
function Invoke-Quiet($exe, $rest) {
  & $exe @($rest) *> $null
  return $LASTEXITCODE
}
function Die($msg) { Write-Host "ERROR: $msg"; exit 1 }

# Supported Python range for the TTS stack (inclusive). Update if upstream adds wheels.
$MIN = @(3, 10); $MAX = @(3, 12)

# Split a launcher STRING like 'py -3.12' or 'python3.12' into exe + arg array.
# (Only for launcher tokens - never for a filesystem path, which may contain spaces.)
function Split-PyCmd($cmd) {
  $t = $cmd -split ' '
  $rest = if ($t.Count -gt 1) { $t[1..($t.Count - 1)] } else { @() }
  return @{ exe = $t[0]; rest = $rest }
}
# Run a concrete exe (a path that may contain spaces) with an args array.
function Get-PyVersionExe($exe, $rest) {
  try {
    $v = & $exe @($rest) -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { return "$v".Trim() }
  } catch { }
  return $null
}
function Test-Supported($ver) {
  if (-not $ver) { return $false }
  $p = $ver.Split('.'); $mj = [int]$p[0]; $mn = [int]$p[1]
  return (($mj -gt $MIN[0]) -or ($mj -eq $MIN[0] -and $mn -ge $MIN[1])) -and
         (($mj -lt $MAX[0]) -or ($mj -eq $MAX[0] -and $mn -le $MAX[1]))
}

# Choose an interpreter whose version is in [3.10, 3.12].
# Prefer explicit -Python; else try version-specific launchers (so a too-new
# default like 'py -3' -> 3.14 is not picked), then generic names (validated).
$candidates = if ($Python) { @($Python) } else {
  @('py -3.12', 'py -3.11', 'py -3.10', 'python3.12', 'python3.11', 'python3.10', 'python', 'python3', 'py -3')
}
$python = $null; $found = @()
foreach ($cand in $candidates) {
  $c = Split-PyCmd $cand
  $ver = Get-PyVersionExe $c.exe $c.rest
  if ($ver) {
    $found += "$cand ($ver)"
    if (Test-Supported $ver) { $python = $cand; $chosenVer = $ver; break }
  }
}
if (-not $python) {
  Write-Error ("no supported Python found. The TTS stack needs Python 3.10-3.12.`n" +
    "  Detected: $((@($found) -join ', '))`n" +
    "  Install Python 3.12 from python.org (or 'winget install Python.Python.3.12'),`n" +
    "  then re-run. To force one:  -Python 'py -3.12'")
  exit 1
}
$pyCmd = Split-PyCmd $python
Write-Host "> Using Python: $python (v$chosenVer)  [supported range 3.10-3.12]"

function Test-VenvHealthy($root) {
  # Healthy = a python that reports a SUPPORTED version AND has a working pip.
  # An interrupted `venv` creation leaves a python.exe with NO pip module, which
  # makes every install fail with "No module named pip" - treat that as unhealthy.
  $p = Join-Path $root 'Scripts\python.exe'
  if (-not (Test-Path $p)) { $p = Join-Path $root 'bin/python' }
  if (-not (Test-Path $p)) { return $false }
  if (-not (Test-Supported (Get-PyVersionExe $p @()))) { return $false }
  return ((Invoke-Quiet $p @('-m', 'pip', '--version')) -eq 0)
}

# If a venv already exists, reuse it only when it's HEALTHY (supported Python +
# working pip). A leftover from a too-new Python OR an interrupted creation
# (python present but no pip) is unusable - recreate from scratch.
if ((Test-Path $venv) -and -not (Test-VenvHealthy $venv)) {
  Write-Host "> Existing venv is unusable (wrong Python or missing pip) - recreating with $chosenVer"
  Remove-Item -Recurse -Force $venv
}
if (-not (Test-Path $venv)) {
  Write-Host "> Creating venv at $venv"
  & $pyCmd.exe @($pyCmd.rest) -m venv $venv
  if ($LASTEXITCODE -ne 0) { Die "could not create the venv (python -m venv failed)." }
}

# Venv layout on Windows: Scripts\python.exe
$vpy = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $vpy)) {
  $vpyPosix = Join-Path $venv 'bin/python'
  if (Test-Path $vpyPosix) { $vpy = $vpyPosix } else { Die "venv python not found under $venv" }
}

# Guarantee pip exists in the venv before installing (an interrupted venv, or a
# Python built without it, has no pip; bootstrap with ensurepip).
if ((Invoke-Quiet $vpy @('-m', 'pip', '--version')) -ne 0) {
  Write-Host '> Bootstrapping pip into the venv (ensurepip)...'
  & $vpy -m ensurepip --upgrade
  if ((Invoke-Quiet $vpy @('-m', 'pip', '--version')) -ne 0) {
    Die "venv still has no pip after ensurepip. Reinstall Python 3.12 with pip enabled."
  }
}

Write-Host '> Installing TTS deps (CPU torch index so no giant CUDA wheels)...'
& $vpy -m pip install --upgrade pip | Out-Null
& $vpy -m pip install --extra-index-url https://download.pytorch.org/whl/cpu -r (Join-Path $here 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Die "pip install of the TTS requirements failed (see output above)." }

# Sanity: confirm the default backend actually imports (proves the install took).
if ((Invoke-Quiet $vpy @('-m', 'pip', 'show', 'chatterbox-tts')) -eq 0) {
  & $vpy -c "import chatterbox; print('  OK: chatterbox importable')"
  if ($LASTEXITCODE -ne 0) { Die "chatterbox installed but failed to import (see error above)." }
}

if ($Predownload) {
  Write-Host '> Pre-downloading the Chatterbox model (resumable; a few GB)...'
  try {
    & $vpy -m huggingface_hub.commands.huggingface_cli download ResembleAI/chatterbox *> $null
  } catch {
    Write-Host '  (pre-download skipped/failed - the model will download on first generate.py run)'
  }
}

Write-Host ''
Write-Host "TTS ready. Venv python: $vpy"
Write-Host ''
Write-Host 'Generate narration audio for a feature (hash-cached per shot):'
Write-Host "    & `"$vpy`" platform/tts/generate.py --dir <p>/modules/<m>/features/<f>"
Write-Host 'Mux it onto the recorded video:'
Write-Host "    & `"$vpy`" platform/tts/build_narrated.py --dir <feature>"
