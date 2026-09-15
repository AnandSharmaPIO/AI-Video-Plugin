#!/usr/bin/env bash
#
# setup-tts.sh — create a Python venv for narration TTS and install the backend.
# Cross-platform (Linux/macOS/Windows Git Bash). The venv lands next to this
# script (platform/tts/venv, gitignored) unless WALKTHROUGH_TTS_VENV is set.
#
#   bash platform/tts/setup-tts.sh                # chatterbox (default, local, free)
#   bash platform/tts/setup-tts.sh --predownload  # also pre-fetch the chatterbox model
#
# Chatterbox pulls a CPU build of torch by default (no GPU needed). If you have a
# CUDA GPU and want it, install a CUDA torch into the venv yourself afterward.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # platform/tts
VENV="${WALKTHROUGH_TTS_VENV:-$HERE/venv}"
PREDOWNLOAD="0"
FORCE_PYTHON=""
for a in "$@"; do case "$a" in
  --predownload) PREDOWNLOAD="1";;
  --python=*) FORCE_PYTHON="${a#--python=}";;
esac; done

# ── Choose a Python in the SUPPORTED range 3.10–3.12. The TTS stack
#    (chatterbox-tts -> torch/spacy/numpy) has no wheels for 3.13/3.14, so a
#    too-new default 'python3' would fail to build. Prefer version-specific
#    launchers, then validate any generic name. ─────────────────────────────
# Echo an interpreter's MAJOR.MINOR. The command is passed as separate args
# ("$@"), so a path CONTAINING SPACES (e.g. the venv under "Client Project") is
# kept as ONE token and never word-split.
py_ver() { "$@" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null; }
is_supported() { case "${1:-}" in 3.10|3.11|3.12) return 0;; *) return 1;; esac; }

if [ -n "$FORCE_PYTHON" ]; then CANDS=("$FORCE_PYTHON")
else CANDS=("python3.12" "python3.11" "python3.10" "python3" "python" "py -3"); fi
PYTHON_CMD=(); PYVER=""; FOUND=""
for cand in "${CANDS[@]}"; do
  read -ra parts <<< "$cand"                       # split launcher into exe + flags
  ver="$(py_ver "${parts[@]}")" || true
  [ -n "$ver" ] || continue
  FOUND="$FOUND $cand($ver)"
  if is_supported "$ver"; then PYTHON_CMD=("${parts[@]}"); PYVER="$ver"; break; fi
done
if [ ${#PYTHON_CMD[@]} -eq 0 ]; then
  echo "error: no supported Python found. The TTS stack needs Python 3.10-3.12."
  echo "  Detected:$FOUND"
  echo "  Install Python 3.12, then re-run (or force one: --python=python3.12)."
  exit 1
fi
echo "> Using Python: ${PYTHON_CMD[*]} (v$PYVER) [supported range 3.10-3.12]"

# Reuse an existing venv only when it's HEALTHY: a SUPPORTED Python AND a working
# pip. An interrupted `venv` creation leaves a python with NO pip ("No module
# named pip" on every install) - treat that, and a wrong Python, as unusable.
# The venv python is passed as ONE quoted arg, so a project path with spaces no
# longer makes this misfire.
venv_healthy() {
  local p="$VENV/bin/python"; [ -x "$p" ] || p="$VENV/Scripts/python.exe"
  [ -x "$p" ] || return 1
  is_supported "$(py_ver "$p")" || return 1
  "$p" -m pip --version >/dev/null 2>&1
}
if [ -d "$VENV" ] && ! venv_healthy; then
  echo "> Existing venv is unusable (wrong Python or missing pip) - recreating with $PYVER"
  rm -rf "$VENV"
fi
if [ ! -d "$VENV" ]; then
  echo "> Creating venv at $VENV"
  "${PYTHON_CMD[@]}" -m venv "$VENV"
fi

# ── Venv layout differs by OS: bin/ (POSIX) vs Scripts/ (Windows) ───────────
if [ -x "$VENV/bin/python" ]; then VPY="$VENV/bin/python";
elif [ -x "$VENV/Scripts/python.exe" ]; then VPY="$VENV/Scripts/python.exe";
else echo "error: venv python not found under $VENV"; exit 1; fi

# Guarantee pip exists before installing (bootstrap with ensurepip if not).
if ! "$VPY" -m pip --version >/dev/null 2>&1; then
  echo "▶ Bootstrapping pip into the venv (ensurepip)…"
  "$VPY" -m ensurepip --upgrade || true
  if ! "$VPY" -m pip --version >/dev/null 2>&1; then
    echo "error: venv still has no pip after ensurepip. Reinstall Python with pip enabled."
    exit 1
  fi
fi

echo "▶ Installing TTS deps (CPU torch index so no giant CUDA wheels)…"
"$VPY" -m pip install --upgrade pip >/dev/null
"$VPY" -m pip install --extra-index-url https://download.pytorch.org/whl/cpu \
  -r "$HERE/requirements.txt"

# Sanity: import chatterbox if it's the (default) backend.
# (ASCII output only — Windows consoles may be cp1252, which can't print ✓.)
if "$VPY" -m pip show chatterbox-tts >/dev/null 2>&1; then
  "$VPY" -c "import chatterbox; print('  OK: chatterbox importable')"
fi

if [ "$PREDOWNLOAD" = "1" ]; then
  echo "▶ Pre-downloading the Chatterbox model (resumable; a few GB)…"
  "$VPY" -m huggingface_hub.commands.huggingface_cli download ResembleAI/chatterbox 2>/dev/null || \
    echo "  (pre-download skipped/failed — the model will download on first generate.py run)"
fi

cat <<EOF

✅ TTS ready. Venv python: $VPY

Generate narration audio for a feature (hash-cached per shot):
    "$VPY" platform/tts/generate.py --dir walkthroughs/<p>/modules/<m>/features/<f>

Mux it onto the recorded video:
    "$VPY" platform/tts/build_narrated.py --dir <feature>   # extend (default) | --mode exact | sequential

Cloud backends: uncomment openai/elevenlabs in platform/tts/requirements.txt,
re-run this script, set the API key, then pass --engine openai / elevenlabs.
EOF
