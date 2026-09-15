#!/usr/bin/env python3
"""
Stitch already-produced feature videos into ONE journey MP4.

Platform copy — reuses each feature's generated/walkthrough-narrated.mp4 (NOT
re-recorded). Given a plan of (mp4, start, end) segments it trims each to its
window and concatenates them into a single 1920x1080 / 30fps / H.264+AAC video.

  <venv-python> platform/tts/build_journey.py --plan <plan.json> --out <journey.mp4>

plan.json = [{"mp4": "...", "start": 0.0, "end": null, "label": "users/add-user"}, ...]
  start/end are seconds on that feature's own narrated timeline; end=null = clip end.

The orchestrator (platform/scripts/journey.mjs) computes the plan from each
feature's shot-timings-narrated.json (fromShot/toShot -> trim points) and ensures
every segment feature is produced + fresh first.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from build_narrated import find_ffmpeg, probe_duration, FPS

W, H = 1920, 1080


def probe_format(ff: str, path: Path):
    err = subprocess.run([ff, "-i", str(path)], capture_output=True, text=True).stderr
    v = re.search(r"Stream #.*: Video:.*", err)
    dims = re.search(r"(\d{2,5})x(\d{2,5})", v.group(0)) if v else None
    fps = re.search(r"([\d.]+)\s*fps", v.group(0)) if v else None
    return ((int(dims.group(1)), int(dims.group(2))) if dims else (None, None),
            float(fps.group(1)) if fps else None)


def main():
    ap = argparse.ArgumentParser(description="Concatenate feature videos into a journey")
    ap.add_argument("--plan", required=True, help="JSON list of {mp4,start,end,label}")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    ff = find_ffmpeg(need_mp4=True)
    print(f"ffmpeg: {ff}")
    plan = json.loads(Path(args.plan).read_text())
    if not plan:
        raise SystemExit("journey plan is empty")

    inputs, filt, labels = [], [], []
    for i, seg in enumerate(plan):
        mp4 = Path(seg["mp4"])
        if not mp4.exists():
            raise SystemExit(f"segment video missing: {mp4} (produce the feature first)")
        start = float(seg.get("start") or 0.0)
        end = seg.get("end")
        end = float(end) if end is not None else probe_duration(ff, mp4)
        if end <= start:
            raise SystemExit(f"segment {seg.get('label', i)} has non-positive length ({start:.2f}..{end:.2f})")
        inputs += ["-i", str(mp4)]
        # Trim, reset PTS, and NORMALIZE to the standard frame (defensive — all
        # feature MP4s are already 1920x1080/30fps, so scale/pad is a no-op; it
        # only kicks in if a segment somehow differs, keeping the concat clean).
        filt.append(
            f"[{i}:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS,"
            f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps={FPS},format=yuv420p[v{i}];")
        filt.append(
            f"[{i}:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[a{i}];")
        labels.append(f"[v{i}][a{i}]")
        print(f"  segment {i}: {seg.get('label', '')}  {start:.2f}..{end:.2f}s  ({mp4.name})")

    graph = "".join(filt) + "".join(labels) + f"concat=n={len(plan)}:v=1:a=1[v][a]"
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ff, "-y", *inputs, "-filter_complex", graph,
           "-map", "[v]", "-map", "[a]",
           "-r", str(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
           "-c:a", "aac", "-b:a", "192k", str(out)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr or p.stdout or "")
        raise SystemExit(f"ffmpeg failed (exit {p.returncode})")

    # Assert the deliverable is the standard frame + rate.
    (ow, oh), ofps = probe_format(ff, out)
    dur = probe_duration(ff, out)
    ok = (ow, oh) == (W, H) and ofps is not None and abs(ofps - FPS) <= 1.0
    print(json.dumps({
        "out": str(out), "durationSec": round(dur, 2),
        "resolution": f"{ow}x{oh}", "fps": ofps, "segments": len(plan), "ok": ok,
    }, indent=2))
    if not ok:
        raise SystemExit(f"journey output is not {W}x{H}@{FPS} (got {ow}x{oh}@{ofps})")


if __name__ == "__main__":
    main()
