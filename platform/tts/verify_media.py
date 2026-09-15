#!/usr/bin/env python3
"""
Deterministic media verification for a feature's walkthrough outputs.

Platform copy — serves ANY feature folder via --dir:
  <venv-python> platform/tts/verify_media.py --dir walkthroughs/<p>/modules/<m>/features/<f>

Does the mechanical half of "verify by looking":
  1. Probes the recording (walkthrough.webm) and the narrated MP4 — streams
     present, duration, audio level (volumedetect).
  2. Extracts one frame per shot plus the final frame, into
     <dir>/generated/frames/verify/. Frames from the narrated MP4 use
     shot-timings-narrated.json (the post-mux timeline written by
     build_narrated.py); frames from the raw webm use shot-timings.json.
  3. Per-shot perceptual frame hashes (aHash) — `--baseline write` saves them
     to <dir>/frame-baseline.json (small, committable); on later runs the
     baseline is compared automatically, so an app-UI change that shifts what
     a shot shows is flagged without a human re-watching the video.

Prints a compact JSON report. The JUDGMENT half — reading the frames to see
that the cursor is on target, results rendered, no error toasts — stays with
the reviewer; this script only makes the evidence cheap.

Exit code 0 with "ok": true/false in the JSON (missing files are reported,
not fatal, so the report is useful at any pipeline stage).
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

from build_narrated import find_ffmpeg, probe_duration, FPS, MARKER_CROP

FRAME_OFFSET = 0.8   # seconds into each shot — past the navigation, into the content
MIN_MEAN_DB = -60.0  # quieter than this means effectively silent narration
MAX_HASH_DISTANCE = 10  # aHash Hamming bits before a shot counts as visually changed
FPS_TOLERANCE = 1.0     # allowed drift from the target output FPS
BLANK_STDEV = 5.0    # gray std-dev below this = a near-uniform (blank/white/spinner)
                     # frame — an SPA lazy-load flash or an unsettled page. Tuned
                     # below the observed real-UI floor (~8) with margin; a true
                     # white flash measures ~3. App-dependent — raise for very
                     # dense UIs, lower for mostly-white ones.


def frame_ahash(ff: str, video: Path, ts: float):
    """64-bit average-hash of the frame at `ts` (8x8 gray via ffmpeg, no deps)."""
    p = subprocess.run(
        [ff, "-ss", f"{ts:.2f}", "-i", str(video), "-frames:v", "1",
         "-vf", "scale=8:8", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        capture_output=True,
    )
    px = p.stdout[:64]
    if len(px) < 64:
        return None
    mean = sum(px) / 64
    bits = 0
    for b in px:
        bits = (bits << 1) | (1 if b > mean else 0)
    return f"{bits:016x}"


def hash_distance(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def frame_stdev(ff: str, video: Path, ts: float, n: int = 24):
    """Gray std-dev of the frame at `ts` (NxN sample). Near-0 = a blank/uniform
    frame (white flash, spinner, unsettled page); a real screen is much higher."""
    p = subprocess.run(
        [ff, "-ss", f"{ts:.2f}", "-i", str(video), "-frames:v", "1",
         "-vf", f"scale={n}:{n}", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        capture_output=True,
    )
    px = p.stdout[:n * n]
    if len(px) < n * n:
        return None
    mean = sum(px) / len(px)
    return (sum((b - mean) ** 2 for b in px) / len(px)) ** 0.5


def probe_streams(ff: str, path: Path) -> dict:
    """Stream inventory + duration + video format from `ffmpeg -i` (no ffprobe)."""
    err = subprocess.run([ff, "-i", str(path)], capture_output=True, text=True).stderr
    vline = re.search(r"Stream #.*: Video:.*", err)
    dims = re.search(r"(\d{2,5})x(\d{2,5})", vline.group(0)) if vline else None
    fps = re.search(r"([\d.]+)\s*fps", vline.group(0)) if vline else None
    return {
        "durationSec": probe_duration(ff, path),
        "videoStream": bool(re.search(r"Stream #.*: Video", err)),
        "audioStream": bool(re.search(r"Stream #.*: Audio", err)),
        "width": int(dims.group(1)) if dims else None,
        "height": int(dims.group(2)) if dims else None,
        "fps": float(fps.group(1)) if fps else None,
    }


def probe_volume(ff: str, path: Path) -> dict:
    err = subprocess.run(
        [ff, "-i", str(path), "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    mean = re.search(r"mean_volume:\s*(-?[\d.]+) dB", err)
    peak = re.search(r"max_volume:\s*(-?[\d.]+) dB", err)
    return {
        "meanVolumeDb": float(mean.group(1)) if mean else None,
        "maxVolumeDb": float(peak.group(1)) if peak else None,
    }


def extract_frames(ff: str, video: Path, timings: list, out_dir: Path) -> list:
    out_dir.mkdir(parents=True, exist_ok=True)
    vid_len = probe_duration(ff, video)
    ordered = sorted(timings, key=lambda t: t["start"])
    frames = []
    for i, t in enumerate(ordered):
        name = f"shot{t['shot']:02d}"
        ts = min(t["start"] + FRAME_OFFSET, vid_len - 0.05)  # viewing/baseline frame (shows the action)
        png = out_dir / f"{name}.png"
        subprocess.run([ff, "-y", "-ss", f"{ts:.2f}", "-i", str(video),
                        "-frames:v", "1", str(png)], capture_output=True, text=True, check=True)
        # Blank check at the shot's RESTING frame (just before the next shot),
        # where freeze-to-fit dwells — a transient mid-navigation blank at `ts` is
        # normal; a blank AT REST (lazy-load flash that never settled) is a defect.
        nxt = ordered[i + 1]["start"] if i + 1 < len(ordered) else vid_len
        rest = max(ts, min(nxt - 0.3, vid_len - 0.05))
        sd = frame_stdev(ff, video, rest)
        frames.append({"name": name, "atSec": round(ts, 2), "path": str(png),
                       "ahash": frame_ahash(ff, video, ts),
                       "restSec": round(rest, 2),
                       "stdev": round(sd, 1) if sd is not None else None,
                       "blank": bool(sd is not None and sd < BLANK_STDEV)})
    # Final frame (its own blankness).
    fts = max(vid_len - 0.2, 0.0)
    fpng = out_dir / "final.png"
    subprocess.run([ff, "-y", "-ss", f"{fts:.2f}", "-i", str(video),
                    "-frames:v", "1", str(fpng)], capture_output=True, text=True, check=True)
    fsd = frame_stdev(ff, video, fts)
    frames.append({"name": "final", "atSec": round(fts, 2), "path": str(fpng),
                   "ahash": frame_ahash(ff, video, fts),
                   "restSec": round(fts, 2),
                   "stdev": round(fsd, 1) if fsd is not None else None,
                   "blank": bool(fsd is not None and fsd < BLANK_STDEV)})
    return frames


def main():
    ap = argparse.ArgumentParser(description="Probe a feature's media + extract per-shot frames")
    ap.add_argument("--dir", required=True, help="feature folder")
    ap.add_argument("--no-frames", action="store_true", help="probe only, skip frame extraction")
    ap.add_argument("--baseline", choices=["auto", "write", "off"], default="auto",
                    help="frame-hash baseline: auto = compare against <dir>/frame-baseline.json "
                         "if it exists; write = save current hashes as the new baseline")
    args = ap.parse_args()

    feature_dir = Path(args.dir).resolve()
    gen = feature_dir / "generated"
    webm = gen / "walkthrough.webm"
    mp4 = gen / "walkthrough-narrated.mp4"
    timings_file = gen / "shot-timings.json"
    narrated_timings_file = gen / "shot-timings-narrated.json"
    baseline_file = feature_dir / "frame-baseline.json"

    ff = find_ffmpeg()
    report = {"featureDir": args.dir, "ffmpeg": ff}

    if webm.exists():
        report["recording"] = probe_streams(ff, webm)
    else:
        report["recording"] = None

    if mp4.exists():
        report["narrated"] = {**probe_streams(ff, mp4), **probe_volume(ff, mp4)}
    else:
        report["narrated"] = None

    # Frames from the narrated MP4 when it exists (final deliverable), else
    # from the raw recording. The MP4's timeline is remapped by extend/
    # sequential muxing, so it MUST use shot-timings-narrated.json — using the
    # webm timings against the MP4 extracts frames from the wrong moments.
    report["timingsMismatch"] = None
    # Staleness: if the raw recording is newer than the narrated deliverable, the
    # feature was re-recorded but not re-muxed. Verifying now samples the FRESH
    # webm at the OLD narrated timeline (or inspects a stale MP4), producing
    # misleading frames that look like regressions. Detect and flag it.
    def _newer(a: Path, b: Path, eps: float = 1.0) -> bool:
        return a.exists() and b.exists() and a.stat().st_mtime > b.stat().st_mtime + eps
    if mp4.exists() and webm.exists() and (
        _newer(webm, mp4) or (narrated_timings_file.exists() and _newer(webm, narrated_timings_file))
    ):
        report["timingsMismatch"] = (
            "walkthrough.webm is NEWER than the narrated MP4 / shot-timings-narrated.json — "
            "the feature was re-recorded but not re-muxed. Frames and checks below are "
            "STALE; re-run generate.py + build_narrated.py, then verify again."
        )
    if not args.no_frames:
        source, tf = None, None
        if mp4.exists():
            source = mp4
            if narrated_timings_file.exists():
                tf = narrated_timings_file
            elif timings_file.exists():
                tf = timings_file
                report["timingsMismatch"] = (
                    "narrated MP4 exists but shot-timings-narrated.json is missing — "
                    "frame timestamps below use the PRE-mux timeline and may be wrong "
                    "for extend/sequential builds; re-run build_narrated.py"
                )
        elif webm.exists() and timings_file.exists():
            source, tf = webm, timings_file
        if source and tf:
            timings = json.loads(tf.read_text())
            report["frames"] = extract_frames(ff, source, timings, gen / "frames" / "verify")
        else:
            report["frames"] = None
    else:
        report["frames"] = None

    # ── Frame-hash baseline (regression signal against target-app UI drift) ──
    report["baseline"] = None
    frames = report["frames"] or []
    hashes = {f["name"]: f["ahash"] for f in frames if f.get("ahash")}
    baseline_ok = True
    if args.baseline == "write" and hashes:
        baseline_file.write_text(json.dumps(
            {"source": "narrated" if mp4.exists() else "recording", "hashes": hashes}, indent=2))
        report["baseline"] = {"action": "written", "path": str(baseline_file)}
    elif args.baseline == "auto" and baseline_file.exists() and hashes:
        base = json.loads(baseline_file.read_text())
        diffs = {}
        for name, h in (base.get("hashes") or {}).items():
            cur = hashes.get(name)
            d = hash_distance(cur, h) if cur else None
            if d is None or d > MAX_HASH_DISTANCE:
                diffs[name] = d
        baseline_ok = not diffs
        report["baseline"] = {"action": "checked", "changedShots": diffs,
                              "maxAllowedDistance": MAX_HASH_DISTANCE}

    # Does the narrated video hold ALL the narration? (anchored/extend rebuild +
    # tail-trim make it SHORTER than the raw recording, so comparing to the
    # recording length is wrong — check it covers the last voice instead.)
    narration_end = None
    if narrated_timings_file.exists():
        try:
            nt = json.loads(narrated_timings_file.read_text())
            manifest = json.loads((gen / "clips" / "manifest.json").read_text())
            dur = {m["shot"]: m["duration"] for m in manifest}
            narration_end = max((t["start"] + dur.get(t["shot"], 0.0)) for t in nt) if nt else None
        except Exception:
            narration_end = None
    report["narrationEndSec"] = round(narration_end, 2) if narration_end is not None else None

    # Shots whose sampled frame is near-blank (SPA lazy-load flash / unsettled
    # page) — the automated half of "no blank/loading frame at a shot".
    blank_shots = [f["name"] for f in frames if f.get("blank") and f["name"] != "final"]
    report["blankFrames"] = blank_shots

    rec, nar = report["recording"], report["narrated"]
    # Expected delivered resolution = the recording minus the framing gutter that
    # the mux crops (MARKER_CROP). If there's no recording to compare against,
    # fall back to the Full-HD minimum (1920x1080).
    exp_w = rec.get("width") if rec else None
    exp_h = (rec.get("height") - MARKER_CROP) if (rec and rec.get("height")) else None
    report["expectedResolution"] = (f"{exp_w}x{exp_h}" if exp_w and exp_h else ">=1920x1080")
    if nar:
        nar["resolution"] = (f"{nar.get('width')}x{nar.get('height')}"
                             if nar.get("width") and nar.get("height") else None)
    checks = {
        "recordingExists": rec is not None,
        "recordingHasVideo": bool(rec and rec["videoStream"]),
        "narratedExists": nar is not None,
        "narratedHasBothStreams": bool(nar and nar["videoStream"] and nar["audioStream"]),
        "narratedAudible": bool(nar and nar.get("meanVolumeDb") is not None and nar["meanVolumeDb"] > MIN_MEAN_DB),
        # Video must be long enough to contain every voice clip (not compared to
        # the raw recording, which the rebuild intentionally trims).
        "narratedCoversNarration": bool(
            nar and (narration_end is None or nar["durationSec"] >= narration_end - 0.5)),
        # Delivered frame is the intended size (crop worked; no clipping/letterbox).
        "narratedResolutionOk": bool(
            nar and nar.get("width") and nar.get("height") and (
                (exp_w and exp_h and nar["width"] == exp_w and nar["height"] == exp_h)
                or (not exp_w and nar["width"] >= 1920 and nar["height"] >= 1080))),
        # Constant, standard-smooth frame rate.
        "narratedFps30": bool(
            nar and nar.get("fps") is not None and abs(nar["fps"] - FPS) <= FPS_TOLERANCE),
        "frameTimingsTrustworthy": report["timingsMismatch"] is None,
        "framesMatchBaseline": baseline_ok,
    }
    # blankFrames is an ADVISORY signal, not a hard gate: a shot resting on a
    # near-uniform frame (lazy-load flash / unsettled async page) is usually a
    # defect worth a settle, but sparse-by-design pages (a centered login, a
    # loading dashboard) are legitimate — so it's surfaced for the reviewer to
    # judge (read the flagged frames), and does NOT fail `ok`.
    report["checks"] = checks
    report["ok"] = all(checks.values())

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
