#!/usr/bin/env python3
"""
Generate per-shot narration audio from a feature's narration.md.

Parses the `>` blockquote under each `## Shot N` heading and renders one WAV per
shot into <feature>/generated/clips/, plus manifest.json (shot -> {wav, duration, text}).

Platform copy — serves ANY feature folder via --dir:
  <venv-python> platform/tts/generate.py --dir <p>/modules/<m>/features/<f>

Backends (pluggable via --engine / WALKTHROUGH_TTS_ENGINE):
  chatterbox  (default) — local, free, no API key. Runs on CPU or GPU.
  openai                — OpenAI TTS (needs OPENAI_API_KEY). Model via OPENAI_TTS_MODEL.
  elevenlabs            — ElevenLabs (needs ELEVENLABS_API_KEY). Voice via ELEVENLABS_VOICE_ID.

The manifest is what build_narrated.py consumes; the engine used doesn't matter
downstream — only the per-shot WAVs and their durations.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import wave
from pathlib import Path

# Warm, confident product-demo read (chatterbox tunables).
# Lower cfg_weight -> slower, more deliberate pacing; moderate exaggeration -> natural.
CB_EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.5"))
CB_CFG_WEIGHT = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.35"))

# Per-clip sanity thresholds — cheap guards against a clip that "exists" but is
# silent or truncated (a mid-write kill, a model hiccup). Below these, the clip
# is rejected so a broken WAV never flows into the mux and passes verification.
MIN_CLIP_SEC = 0.30          # anything shorter than this can't be a real sentence
MIN_CHARS_PER_SEC = 3.0      # too-short audio for the text length => probably cut off
MIN_RMS = 1e-4               # near-silent render


def load_lexicon(feature_dir: Path) -> "dict[str, str]":
    """Pronunciation overrides applied to narration text before synthesis.

    Merged nearest-first (feature wins): <feature>/lexicon.json →
    <project>/project-overview/lexicon.json → platform/tts/lexicon.default.json. Each
    file is a flat {"written": "spoken"} map, e.g. {"DORA": "dora", "8x8": "eight
    by eight"}. Whole-word, case-insensitive replacement. Keeps brand/acronym
    pronunciation out of the model's guesswork.
    """
    here = Path(__file__).resolve().parent
    candidates = [here / "lexicon.default.json"]
    # project = two levels above modules/<m>/features/<f> => feature_dir.parents[3]
    for up in range(0, 6):
        base = feature_dir
        for _ in range(up):
            base = base.parent
        knowledge = base / "project-overview" / "lexicon.json"
        if knowledge.exists():
            candidates.append(knowledge)
            break
    candidates.append(feature_dir / "lexicon.json")  # highest precedence, applied last
    lex: "dict[str, str]" = {}
    for f in candidates:
        if f.exists():
            try:
                lex.update({str(k): str(v) for k, v in json.loads(f.read_text()).items()})
            except (json.JSONDecodeError, AttributeError):
                print(f"  (ignoring malformed lexicon: {f})", file=sys.stderr)
    return lex


def apply_lexicon(text: str, lex: "dict[str, str]") -> str:
    for written, spoken in lex.items():
        # \b won't anchor around non-word chars like '8x8'; use lookarounds on
        # whitespace/boundaries so tokens with digits/symbols still match.
        pattern = r"(?<!\w)" + re.escape(written) + r"(?!\w)"
        text = re.sub(pattern, spoken, text, flags=re.IGNORECASE)
    return text


def parse_shots(md: str) -> "dict[int, str]":
    """Return {shot_number: narration_text} parsed from the markdown."""
    shots: "dict[int, str]" = {}
    parts = re.split(r"^##\s+Shot\s+(\d+)\b.*$", md, flags=re.MULTILINE)
    # parts = [preamble, "1", body1, "2", body2, ...]
    for i in range(1, len(parts), 2):
        num = int(parts[i])
        body = parts[i + 1]
        quote_lines = [
            re.sub(r"^>\s?", "", ln).strip()
            for ln in body.splitlines()
            if ln.lstrip().startswith(">")
        ]
        text = re.sub(r"\s+", " ", " ".join(l for l in quote_lines if l)).strip()
        if text:
            shots[num] = text
    return shots


def wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except wave.Error:
        # Float32 WAVs (format tag 3, e.g. from torchaudio) — stdlib wave can't
        # read them; soundfile ships with the TTS deps.
        import soundfile as sf
        info = sf.info(str(path))
        return info.frames / float(info.samplerate)


def clip_rms(path: Path) -> float:
    """Rough loudness of a clip (0..1). Uses soundfile+numpy if present, else stdlib."""
    try:
        import numpy as np
        import soundfile as sf
        data = sf.read(str(path))[0]
        if data.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(data, dtype=np.float64))))
    except Exception:
        try:
            with wave.open(str(path), "rb") as w:
                frames = w.readframes(w.getnframes())
                width = w.getsampwidth()
            if not frames:
                return 0.0
            import audioop
            return audioop.rms(frames, width) / 32768.0
        except Exception:
            return 1.0  # can't measure -> don't block


def check_clip(path: Path, text: str, dur: float) -> "str | None":
    """Return a rejection reason if the rendered clip looks broken, else None."""
    if not path.exists() or path.stat().st_size == 0:
        return "file missing or empty"
    if dur < MIN_CLIP_SEC:
        return f"too short ({dur:.2f}s < {MIN_CLIP_SEC}s)"
    if len(text) / max(dur, 0.01) > 40:  # >40 chars/s of speech is implausible => truncated audio
        return f"audio too short for text ({len(text)} chars in {dur:.2f}s)"
    if clip_rms(path) < MIN_RMS:
        return "near-silent render"
    return None


# ── Backends ──────────────────────────────────────────────────────────────────
class ChatterboxEngine:
    """Local Resemble-AI Chatterbox. Free, no key. CPU or CUDA/MPS."""

    def __init__(self, device: str):
        import torchaudio as ta  # noqa: F401 (imported for save)
        # resemble-perth 1.0.x can ship PerthImplicitWatermarker as None (its
        # optional perth_net import fails), which crashes ChatterboxTTS.__init__.
        # The watermark is inaudible & optional — swap in the no-op DummyWatermarker.
        import perth
        if getattr(perth, "PerthImplicitWatermarker", None) is None:
            perth.PerthImplicitWatermarker = perth.DummyWatermarker
        from chatterbox.tts import ChatterboxTTS

        self.ta = ta
        if device == "auto":
            try:
                import torch
                device = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                device = "cpu"
        print(f"Loading Chatterbox on {device} (first run downloads weights)...")
        self.model = ChatterboxTTS.from_pretrained(device=device)
        self.sr = self.model.sr
        print(f"Model loaded. Sample rate = {self.sr} Hz")

    def synth(self, text: str, out: Path):
        wav = self.model.generate(
            text, exaggeration=CB_EXAGGERATION, cfg_weight=CB_CFG_WEIGHT
        )
        self.ta.save(str(out), wav, self.sr)


class OpenAIEngine:
    """OpenAI TTS. Needs OPENAI_API_KEY. Steerable tone via instructions."""

    def __init__(self, device: str):
        from openai import OpenAI  # pip install openai
        self.client = OpenAI()
        self.model = os.environ.get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
        self.voice = os.environ.get("OPENAI_TTS_VOICE", "alloy")
        self.instructions = os.environ.get(
            "OPENAI_TTS_INSTRUCTIONS", "Warm, confident product-demo narrator; steady pace."
        )

    def synth(self, text: str, out: Path):
        # WAV so build_narrated.py can read duration without extra deps.
        with self.client.audio.speech.with_streaming_response.create(
            model=self.model, voice=self.voice, input=text,
            instructions=self.instructions, response_format="wav",
        ) as resp:
            resp.stream_to_file(str(out))


class ElevenLabsEngine:
    """ElevenLabs. Needs ELEVENLABS_API_KEY. Best-in-class voices."""

    def __init__(self, device: str):
        from elevenlabs.client import ElevenLabs  # pip install elevenlabs
        self.client = ElevenLabs()
        self.voice = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
        self.model = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")

    def synth(self, text: str, out: Path):
        audio = self.client.text_to_speech.convert(
            voice_id=self.voice, model_id=self.model, text=text,
            output_format="pcm_24000",
        )
        pcm = b"".join(audio)
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(pcm)


ENGINES = {"chatterbox": ChatterboxEngine, "openai": OpenAIEngine, "elevenlabs": ElevenLabsEngine}


def voice_signature(engine: str) -> str:
    """Everything (besides the text) that changes the rendered audio."""
    if engine == "chatterbox":
        return f"ex={CB_EXAGGERATION}|cfg={CB_CFG_WEIGHT}"
    if engine == "openai":
        return "|".join(os.environ.get(k, "") for k in
                        ("OPENAI_TTS_MODEL", "OPENAI_TTS_VOICE", "OPENAI_TTS_INSTRUCTIONS"))
    if engine == "elevenlabs":
        return "|".join(os.environ.get(k, "") for k in ("ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL"))
    return ""


def clip_hash(engine: str, text: str) -> str:
    """Content hash for one clip: same engine + voice params + text -> same audio."""
    payload = f"{engine}|{voice_signature(engine)}|{text}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate per-shot narration WAVs from narration.md")
    ap.add_argument("--dir", required=True,
                    help="feature folder containing narration.md (clips land in <dir>/generated/clips)")
    ap.add_argument("--engine", default=os.environ.get("WALKTHROUGH_TTS_ENGINE", "chatterbox"),
                    choices=list(ENGINES), help="TTS backend (default: chatterbox)")
    ap.add_argument("--device", default=os.environ.get("CHATTERBOX_DEVICE", "auto"),
                    help="chatterbox device: auto|cpu|cuda|mps (default: auto)")
    ap.add_argument("--shots", default="", help="comma-separated shot numbers (default: all)")
    ap.add_argument("--force", action="store_true", help="ignore the hash cache and re-synthesize everything")
    args = ap.parse_args()

    feature_dir = Path(args.dir).resolve()
    narration = feature_dir / "narration.md"
    clips_dir = feature_dir / "generated" / "clips"

    if not narration.exists():
        print(f"ERROR: narration file not found: {narration}", file=sys.stderr)
        return 1

    shots = parse_shots(narration.read_text(encoding="utf-8"))
    if args.shots:
        want = {int(s) for s in args.shots.split(",") if s.strip()}
        shots = {k: v for k, v in shots.items() if k in want}
    if not shots:
        print("ERROR: no shots parsed from narration.md", file=sys.stderr)
        return 1

    clips_dir.mkdir(parents=True, exist_ok=True)
    lexicon = load_lexicon(feature_dir)
    if lexicon:
        print(f"Lexicon: {len(lexicon)} pronunciation override(s) applied.")
    # spoken[num] = what the engine actually says (lexicon-substituted); the
    # manifest keeps the RAW narration text so catalog can match it to
    # narration.md, but the hash is over the SPOKEN text so a lexicon change
    # correctly invalidates the cache.
    spoken = {num: apply_lexicon(shots[num], lexicon) for num in shots}
    print(f"Engine: {args.engine}. Shots: {sorted(shots)}")

    # ── Hash cache: only re-synthesize clips whose (engine|voice|spoken) changed.
    # The check runs BEFORE engine construction, so a fully-cached run never
    # loads the model. --force regenerates everything.
    prior = {}
    manifest_path = clips_dir / "manifest.json"
    if manifest_path.exists():
        try:
            prior = {m["shot"]: m for m in json.loads(manifest_path.read_text())}
        except (json.JSONDecodeError, KeyError):
            prior = {}

    todo, cached = {}, {}
    for num in sorted(shots):
        h = clip_hash(args.engine, spoken[num])
        wav = clips_dir / f"shot{num:02d}.wav"
        entry = prior.get(num)
        if (not args.force and entry and entry.get("hash") == h and wav.exists()):
            cached[num] = entry
        else:
            todo[num] = h

    if cached:
        print(f"Cached (unchanged): {sorted(cached)}")
    engine = ENGINES[args.engine](args.device) if todo else None

    manifest, rejected = [], []
    for num in sorted(shots):
        text = shots[num]
        out = clips_dir / f"shot{num:02d}.wav"
        if num in cached:
            manifest.append(cached[num])
            continue
        print(f"\n[Shot {num}] {spoken[num][:70]}...")
        engine.synth(spoken[num], out)
        dur = wav_duration(out)
        problem = check_clip(out, spoken[num], dur)
        if problem:
            print(f"  ✗ shot {num} clip rejected: {problem}", file=sys.stderr)
            rejected.append((num, problem))
            continue
        print(f"  -> {out.name}  ({dur:.1f}s)")
        manifest.append({"shot": num, "wav": out.name, "duration": round(dur, 2),
                         "text": text, "hash": todo[num]})

    if rejected:
        print("\nERROR: some clips failed sanity checks and were not written to the manifest:",
              file=sys.stderr)
        for num, why in rejected:
            print(f"  shot {num}: {why}", file=sys.stderr)
        print("Re-run (optionally with --force) or fix the narration/lexicon.", file=sys.stderr)

    manifest_path.write_text(json.dumps(manifest, indent=2))
    total = sum(m["duration"] for m in manifest)
    print(f"\nDone. {len(manifest)} clips ({len(todo) - len(rejected)} synthesized, "
          f"{len(cached)} cached, {len(rejected)} rejected), {total:.1f}s total narration.")
    print(f"Manifest: {manifest_path}")
    return 1 if rejected else 0


if __name__ == "__main__":
    raise SystemExit(main())
