#!/usr/bin/env python3
"""
Mux per-shot narration audio onto a feature's recorded video.

Platform copy — serves ANY feature folder via --dir:
  <venv-python> platform/tts/build_narrated.py --dir <p>/modules/<m>/features/<f>

Inputs (inside <dir>/generated/, all produced by record-feature + generate.py):
  walkthrough.webm           silent screen recording
  shot-timings.json          real per-shot start times [{shot, start}, ...]
  clips/shot*.wav + clips/manifest.json

Modes:
  anchored           BEST sync (what `npm run produce` uses). The recorder saved a
                     screenshot of each shot's settled screen (ShotTimer.markVisual
                     -> generated/anchors/). This scans the recording for the frame
                     that matches each screenshot and places the voice THERE — so
                     the clip lands on the real painted screen, immune to SPA render
                     lag and the screencast's variable frame rate. Falls back to
                     'aligned' if a recording has no anchors.
  aligned            For voice-first recordings without anchors: place each clip at
                     its recorded wall-clock mark. Works only if video-time tracks
                     wall-clock (often it doesn't on heavy SPAs — prefer anchored).
  extend   (default) For record-first: freeze-frame each shot's window so it's
                     long enough for its narration clip, then place clips at the
                     new starts, offset by a short LEAD. No overlap; audio matches
                     the (held) on-screen action. Tune the pre-roll with --lead.
  exact              Place each clip at its real recorded start; longer clips may
                     bleed into the next shot (voices can overlap). Video length
                     unchanged. Use when clips comfortably fit their windows.
  sequential         Ignore recorded timings; play clips back-to-back and stretch
                     the video (evenly) to match total narration length.

Only shots that appear in BOTH shot-timings.json and the clip manifest are used,
so a shot the recorder skipped (guarded/absent) is dropped automatically.

Output: <dir>/generated/final-video.mp4

Uses system ffmpeg if present, else Playwright's bundled ffmpeg.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PAD = 0.6     # silence after each clip before the next shot (extend mode)
TAIL = 0.8    # freeze after the last clip ends
LEAD = 0.35   # pre-roll: let a shot's visual appear/settle before its narration
              # speaks, so audio never leads the on-screen action (extend mode).
MAX_TAIL = 2.0  # max seconds of recording kept AFTER a shot's narration ends —
                # trims long silent stretches (slow page loads, slow typing) so a
                # shot doesn't linger with the voice already finished.
FPS = 30        # output frame rate — the rebuilt segments are re-encoded at this
                # (verify_media asserts the narrated MP4 matches it). 30 fps is the
                # standard for a smooth product-demo video.


def _has_mp4_encoders(ff: str) -> bool:
    """True when this ffmpeg can encode H.264 + AAC (i.e. produce MP4)."""
    try:
        out = subprocess.run([ff, "-hide_banner", "-encoders"],
                             capture_output=True, text=True).stdout
        return "libx264" in out and " aac" in out
    except OSError:
        return False


def find_ffmpeg(need_mp4: bool = False) -> str:
    sys_ff = shutil.which("ffmpeg")
    if sys_ff and (not need_mp4 or _has_mp4_encoders(sys_ff)):
        return sys_ff
    # Full-featured ffmpeg from imageio-ffmpeg, if installed (Playwright's
    # bundled ffmpeg only has a VP8 encoder — no libx264/AAC, so no MP4).
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass
    # Playwright bundles an ffmpeg; find it in the browser cache. It cannot
    # encode MP4 (VP8 only), so it is only viable for probing/extraction.
    if need_mp4:
        raise SystemExit(
            "no MP4-capable ffmpeg found (need libx264 + aac).\n"
            "Fix: install system ffmpeg (winget install ffmpeg / apt install ffmpeg), or\n"
            "     <venv-python> -m pip install imageio-ffmpeg"
        )
    bases = [Path.home() / ".cache/ms-playwright", Path("/root/.cache/ms-playwright")]
    if os.environ.get("LOCALAPPDATA"):
        bases.append(Path(os.environ["LOCALAPPDATA"]) / "ms-playwright")
    for base in bases:
        for name in ("ffmpeg-linux", "ffmpeg-mac", "ffmpeg-win.exe", "ffmpeg-win64.exe"):
            hits = sorted(glob.glob(str(base / "ffmpeg-*" / name)))
            if hits:
                return hits[-1]
    raise SystemExit("ffmpeg not found (install ffmpeg, or run `npx playwright install ffmpeg`)")


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        # Surface ffmpeg's own diagnostics — an opaque exit code is undebuggable.
        sys.stderr.write(p.stderr or p.stdout or "")
        raise SystemExit(f"ffmpeg failed (exit {p.returncode}): {' '.join(str(c) for c in cmd)}")


def load_json(path: Path, what: str):
    """Read + parse a pipeline hand-off file with a diagnosable error."""
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(
            f"{what} is unreadable or corrupt: {path}\n  ({e})\n"
            "Re-run the stage that produces it (record for shot-timings.json, "
            "generate.py for clips/manifest.json)."
        )


def probe_duration(ff: str, path: Path) -> float:
    """Duration in seconds via ffmpeg (ffprobe may be absent when using bundled ffmpeg)."""
    out = subprocess.run([ff, "-i", str(path)], capture_output=True, text=True).stderr
    import re
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", out)
    if not m:
        raise SystemExit(f"could not probe duration of {path}")
    h, mm, ss = m.groups()
    return int(h) * 3600 + int(mm) * 60 + float(ss)


# ── Frame-anchored placement: match each shot's anchor screenshot to the real
#    video frame, so the voice lands on the painted screen (immune to SPA render
#    lag + Playwright's variable-frame-rate screencast). ────────────────────────
HASH_SIZE = 32      # NxN downscale for the perceptual (average) hash. 32 gives a
                    # clean gap between same-screen shots (a few bits apart) and
                    # real screen changes (hundreds apart); 16 blurred them.
SAME_SCREEN_BITS = 60  # anchors within this aHash distance are the SAME screen
                       # (e.g. two form-fill shots) — matching can't tell them
                       # apart, so place by wall-clock interval instead.


def _ahash_bits(px: bytes, n: int) -> int:
    mean = sum(px) / n
    bits = 0
    for b in px:
        bits = (bits << 1) | (1 if b > mean else 0)
    return bits


def image_ahash(ff: str, img: Path, size: int = HASH_SIZE):
    """Average-hash of a still image (NxN gray), or None if unreadable."""
    n = size * size
    px = subprocess.run(
        [ff, "-i", str(img), "-vf", f"scale={size}:{size}", "-pix_fmt", "gray", "-f", "rawvideo", "-"],
        capture_output=True,
    ).stdout[:n]
    return _ahash_bits(px, n) if len(px) == n else None


def video_ahash_track(ff: str, video: Path, fps: float = 4.0, size: int = HASH_SIZE):
    """One ffmpeg pass -> list of (t_seconds, ahash) sampling the video at `fps`."""
    n = size * size
    data = subprocess.run(
        [ff, "-i", str(video), "-vf", f"fps={fps},scale={size}:{size}", "-pix_fmt", "gray",
         "-f", "rawvideo", "-"],
        capture_output=True,
    ).stdout
    return [(i / fps, _ahash_bits(data[i * n:(i + 1) * n], n)) for i in range(len(data) // n)]


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


# Height (px) of the magenta scan-marker bar painted by ShotTimer.markVisual, and
# how much to crop off the top so it never shows in the final video.
# MARKER_CROP MUST equal FRAME_GUTTER in platform/engine/env.mjs: the recorder
# captures that many extra pixels at top and shifts the page down into them, so
# cropping this band removes the marker (and the blank gutter) WITHOUT clipping
# the app's real top bar. MARKER_H (marker height) fits inside the gutter.
MARKER_H = 16
MARKER_CROP = 20


def marker_times(ff, video, fps: float = 12.0):
    """Video-times where a shot's magenta top-bar marker APPEARS (rising edges).

    Returns a list of times in order — one per recorded shot. This is the robust
    timing signal: each shot paints a distinct marker flash at its exact frame,
    so it works even when consecutive shots share the same screen (which defeats
    screenshot matching) and regardless of screencast lag."""
    # Average colour of the very top strip per sampled frame.
    data = subprocess.run(
        [ff, "-i", str(video), "-vf",
         f"fps={fps},crop=iw:{MARKER_H}:0:0,scale=1:1,format=rgb24", "-f", "rawvideo", "-"],
        capture_output=True,
    ).stdout
    times, prev = [], False
    for i in range(len(data) // 3):
        r, g, b = data[3 * i], data[3 * i + 1], data[3 * i + 2]
        is_marker = r > 165 and g < 95 and b > 165          # ~magenta
        if is_marker and not prev:
            times.append(round(i / fps, 3))
        prev = is_marker
    return times


def match_anchors(ff, video, anchors_dir, shots, timings, vid_len):
    """Find the true video-time of each shot by matching its anchor screenshot to
    the recorded video. Returns {shot: video_time}. Monotonic (each shot after the
    previous), with a weak wall-clock time bias to disambiguate similar screens."""
    track = video_ahash_track(ff, video)
    if not track:
        return None
    span = max((timings[s] for s in shots), default=1.0) or 1.0  # wall-clock span
    anchor_hash = {s: (image_ahash(ff, anchors_dir / f"shot-{s:02d}.png")
                       if (anchors_dir / f"shot-{s:02d}.png").exists() else None)
                   for s in shots}
    shot_seq = list(shots)
    start_of, prev_s = {}, None
    for i, s in enumerate(shot_seq):
        remaining_after = len(shot_seq) - i - 1
        ah = anchor_hash[s]
        # Same screen as the previous shot? (near-identical anchor). aHash can't
        # place these precisely, so advance by the WALL-CLOCK interval — reliable
        # within a static screen (no navigation drift) and keeps each shot's
        # cursor action aligned with its voice.
        same_screen = (prev_s is not None and ah is not None and anchor_hash[prev_s] is not None
                       and hamming(ah, anchor_hash[prev_s]) <= SAME_SCREEN_BITS)
        if same_screen:
            dt = max(0.3, timings[s] - timings[prev_s])
            # Never place so late that this shot + the remaining ones can't each
            # hold a minimal (non-empty) segment before the video ends —
            # build_extend freezes short segments to fit the voice, it just needs
            # them non-empty. This absorbs any wall-clock overshoot past vid_len.
            cap = vid_len - 0.4 * (remaining_after + 1)
            start_of[s] = min(start_of[prev_s] + dt, max(start_of[prev_s] + 0.4, cap))
            print(f"  shot {s}: same screen -> video {start_of[s]:.2f}s (wall-clock +{dt:.2f}s)")
        else:
            prev_t = start_of[prev_s] if prev_s is not None else -1.0
            expect_t = (timings[s] / span) * vid_len  # uniform-drift estimate (weak tiebreak)
            best_t, best_score = None, None
            for (t, fh) in track:
                if t <= prev_t + 0.2:  # keep order + a minimum gap
                    continue
                dist = hamming(ah, fh) if ah is not None else 0
                score = dist + 0.05 * abs(t - expect_t)  # aHash dominates; time breaks ties
                if best_score is None or score < best_score:
                    best_score, best_t = score, t
            start_of[s] = best_t if best_t is not None else max(prev_t + 0.5, min(timings[s], vid_len))
            print(f"  shot {s}: anchor -> video {start_of[s]:.2f}s (wall-clock hint {timings[s]:.2f}s)")
        prev_s = s
    return start_of


def audio_mix_args(clips_dir: Path, shots, start_of):
    """Build (adelay+amix) filter placing each shot's clip at start_of[shot] seconds."""
    inputs, delays, labels = [], [], []
    for i, s in enumerate(shots):
        inputs += ["-i", str(clips_dir / f"shot{s:02d}.wav")]
        ms = int(round(start_of[s] * 1000))
        delays.append(f"[{1 + i}:a]adelay={ms}|{ms}[a{i}];")
        labels.append(f"[a{i}]")
    filt = "".join(delays) + "".join(labels) + f"amix=inputs={len(shots)}:normalize=0[mix]"
    return inputs, filt


def build_extend(ff: str, work: Path, video_in: Path, timings, clip_dur, shots, vid_len, lead=LEAD):
    """Freeze-frame each shot's window to fit its narration.

    Returns (video, visual_start, audio_start, total). `visual_start` is where
    each shot's picture begins on the output timeline (used for frame checks);
    `audio_start` is `visual_start + lead`, so the voice starts a beat AFTER the
    shot's visual appears rather than on the transition frame. The window is
    sized to hold lead + clip + PAD so the audio never spills into the next shot.
    """
    work.mkdir(exist_ok=True)
    parts, visual_start, audio_start, cursor = [], {}, {}, 0.0
    for i, s in enumerate(shots):
        a = timings[s]
        b = timings[shots[i + 1]] if i + 1 < len(shots) else vid_len
        orig = b - a
        voice_needed = lead + clip_dur[s] + PAD
        # Fit each shot's on-screen time to its narration:
        #  - action SHORTER than the voice -> freeze the last frame so the cursor
        #    waits at its point until the voice finishes.
        #  - action LONGER than the voice -> keep only up to MAX_TAIL of trailing
        #    video, trimming dead time (slow loads / typing).
        target = max(voice_needed, min(orig, voice_needed + MAX_TAIL))
        use = min(orig, target)          # seconds of real recording to keep
        extra = max(0.0, target - orig)  # freeze padding (0 when trimming)
        visual_start[s] = cursor
        audio_start[s] = cursor + lead
        # fps must come BEFORE tpad: the screencast WebM is variable-frame-rate
        # and tpad pads nothing on a VFR stream. Crop the top strip to remove the
        # scan marker so it never appears in the final video.
        vf = f"setpts=PTS-STARTPTS,fps={FPS},crop=in_w:in_h-{MARKER_CROP}:0:{MARKER_CROP}"
        if extra > 0.05:
            vf += f",tpad=stop_mode=clone:stop_duration={extra:.3f}"
            print(f"  shot {s}: {orig:.2f}s -> {target:.2f}s (froze {extra:.2f}s, cursor waits) "
                  f"@ {cursor:.2f}s (voice @ {cursor + lead:.2f}s)")
        elif use < orig - 0.05:
            print(f"  shot {s}: {orig:.2f}s -> {target:.2f}s (trimmed {orig - use:.2f}s dead tail) "
                  f"@ {cursor:.2f}s (voice @ {cursor + lead:.2f}s)")
        else:
            print(f"  shot {s}: {orig:.2f}s fits clip {clip_dur[s]:.2f}s "
                  f"@ {cursor:.2f}s (voice @ {cursor + lead:.2f}s)")
        seg = work / f"seg{s:02d}.mp4"
        run([ff, "-y", "-ss", f"{a:.3f}", "-to", f"{a + use:.3f}", "-i", str(video_in),
             "-an", "-vf", vf,
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", str(seg)])
        parts.append(seg)
        cursor += target

    concat_list = work / "concat.txt"
    concat_list.write_text("".join(f"file '{p.name}'\n" for p in parts))
    extended = work / "extended.mp4"
    run([ff, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list), "-c", "copy", str(extended)])
    return extended, visual_start, audio_start, cursor + TAIL


def main():
    ap = argparse.ArgumentParser(description="Mux narration onto a feature's walkthrough video")
    ap.add_argument("--dir", required=True,
                    help="feature folder (uses <dir>/generated/{walkthrough.webm,shot-timings.json,clips/})")
    ap.add_argument("--mode", choices=["anchored", "aligned", "extend", "exact", "sequential"], default="extend")
    ap.add_argument("--lead", type=float, default=LEAD,
                    help=f"seconds of pre-roll before each shot's narration in extend/aligned mode "
                         f"(default {LEAD}); raise it if voices still start before the visual settles, "
                         f"set 0 to disable")
    ap.add_argument("--video", default="", help="override input video path")
    ap.add_argument("--out", default="", help="override output MP4 path")
    ap.add_argument("--allow-partial", action="store_true",
                    help="proceed even when the recording and the clips don't cover the same shots")
    args = ap.parse_args()

    feature_dir = Path(args.dir).resolve()
    gen = feature_dir / "generated"
    timings_file = gen / "shot-timings.json"
    clips = gen / "clips"
    manifest = clips / "manifest.json"
    work = gen / "work"

    ff = find_ffmpeg(need_mp4=True)
    print(f"ffmpeg: {ff}")

    video_in = Path(args.video) if args.video else gen / "walkthrough.webm"
    out = Path(args.out) if args.out else gen / "final-video.mp4"
    if not video_in.exists():
        raise SystemExit(f"video not found: {video_in}")
    if not manifest.exists():
        raise SystemExit(f"clip manifest not found: {manifest} (run generate.py first)")

    manifest_data = load_json(manifest, "clip manifest")
    if not (isinstance(manifest_data, list)
            and all(isinstance(m, dict) and isinstance(m.get("shot"), int)
                    and isinstance(m.get("duration"), (int, float)) for m in manifest_data)):
        raise SystemExit(f"clip manifest has an unexpected shape: {manifest} (re-run generate.py)")
    clip_dur = {m["shot"]: m["duration"] for m in manifest_data}
    vid_len = probe_duration(ff, video_in)
    anchored_prebuilt = False  # set True if anchored mode padded the video itself

    if args.mode == "sequential":
        # Back-to-back clips; stretch the whole video to the total narration length.
        shots = sorted(clip_dur)
        start_of, cursor = {}, 0.0
        for s in shots:
            start_of[s] = cursor
            cursor += clip_dur[s] + PAD
        total = cursor + TAIL
        audio_start = visual_start = start_of
        factor = total / vid_len
        work.mkdir(exist_ok=True)
        video_for_mux = work / "stretched.mp4"
        run([ff, "-y", "-i", str(video_in), "-an",
             "-vf", f"setpts={factor:.5f}*PTS,crop=in_w:in_h-{MARKER_CROP}:0:{MARKER_CROP}",
             "-r", str(FPS),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", str(video_for_mux)])
    else:
        if not timings_file.exists():
            raise SystemExit(
                f"shot-timings.json not found: {timings_file}\n"
                "The recorder must write real shot start times (ShotTimer in the spec). "
                "Re-record, or use --mode sequential to place clips back-to-back."
            )
        timings_data = load_json(timings_file, "shot timings")
        if not (isinstance(timings_data, list)
                and all(isinstance(t, dict) and isinstance(t.get("shot"), int)
                        and isinstance(t.get("start"), (int, float)) for t in timings_data)):
            raise SystemExit(f"shot-timings.json has an unexpected shape: {timings_file} (re-record)")
        timings = {t["shot"]: t["start"] for t in timings_data}
        # Only shots present in BOTH the recording and the clips.
        shots = sorted(set(timings) & set(clip_dur))
        # Two different mismatches, treated differently:
        #  - clip exists but shot NOT recorded  -> a guarded/skipped shot
        #    (guardExpr false at record time). EXPECTED — just drop the clip.
        #  - shot recorded but NO clip          -> a recorded action with no
        #    narration = a silent segment. A real gap; block unless --allow-partial.
        clips_not_recorded = sorted(set(clip_dur) - set(timings))
        recorded_no_clip = sorted(set(timings) - set(clip_dur))
        if not shots:
            raise SystemExit("no shot appears in both shot-timings.json and the clip manifest — "
                             "recording and narration are out of sync (re-record / re-run generate.py)")
        if clips_not_recorded:
            print(f"Note: narrated shots not in the recording (guarded/skipped): "
                  f"{clips_not_recorded} — their clips are dropped.")
        if recorded_no_clip:
            msg = (f"recorded shots have NO narration clip (would be silent): {recorded_no_clip}\n"
                   f"  timings: {sorted(timings)}  clips: {sorted(clip_dur)}")
            if args.allow_partial:
                print(f"Warning (--allow-partial): {msg}")
            else:
                raise SystemExit(msg + "\nRegenerate narration (generate.py), or pass "
                                 "--allow-partial to leave those segments silent.")
        print(f"Using shots: {shots}")

        if args.mode == "anchored":
            # 1) Find each shot's TRUE segment boundary. Prefer the scan MARKERS
            #    (a distinct magenta flash painted at each shot's frame) — they're
            #    unambiguous even for same-screen shots and immune to screencast
            #    lag. Fall back to screenshot matching, then wall-clock marks.
            anchors_dir = gen / "anchors"
            mt = marker_times(ff, video_in)
            if len(mt) == len(shots):
                matched = {s: mt[i] for i, s in enumerate(shots)}
                print("Using scan markers: "
                      + ", ".join(f"shot {s}@{matched[s]:.2f}s" for s in shots))
            else:
                print(f"Note: found {len(mt)} markers for {len(shots)} shots — "
                      "falling back to screenshot matching.")
                matched = (match_anchors(ff, video_in, anchors_dir, shots, timings, vid_len)
                           if anchors_dir.exists() else None)
            if matched is None:
                print("Note: no anchors either — falling back to wall-clock marks.")
                matched = {s: timings[s] for s in shots}
            # 2) REBUILD the video from those boundaries, freezing each segment to
            #    fit its narration (extend-style). This keeps audio and video in
            #    lockstep: the action plays, then the frame HOLDS while the voice
            #    finishes — no gap where the video runs ahead of the voice, and no
            #    overlap between voices. Best of both: accurate boundaries from the
            #    anchors + freeze-to-fit from extend.
            video_for_mux, visual_start, audio_start, total = build_extend(
                ff, work, video_in, matched, clip_dur, shots, vid_len, lead=args.lead)
            anchored_prebuilt = True  # build_extend emits H.264 → stream-copy
        elif args.mode == "extend":
            video_for_mux, visual_start, audio_start, total = build_extend(
                ff, work, video_in, timings, clip_dur, shots, vid_len, lead=args.lead)
        elif args.mode == "aligned":
            # Voice-first: the recorder already held each shot for its clip
            # length, so clips placed at their marks fit without overlap. No
            # freeze — just mux the recording. `lead` nudges the voice a hair
            # after the mark so it never speaks on the transition frame.
            visual_start = {s: timings[s] for s in shots}
            audio_start = {s: timings[s] + args.lead for s in shots}
            total = vid_len
            video_for_mux = video_in
        else:  # exact
            start_of = {s: timings[s] for s in shots}
            audio_start = visual_start = start_of
            total = vid_len
            video_for_mux = video_in

    # Stream-copy when the video for muxing is ALREADY H.264 (extend/sequential
    # work files, or an anchored run that pre-padded the video); otherwise the
    # WebM still needs the H.264 transcode for MP4.
    vcodec = (["-c:v", "copy"]
              if args.mode in ("extend", "sequential") or (args.mode == "anchored" and anchored_prebuilt)
              # aligned/exact re-encode the raw (VFR) webm — force the standard FPS
              # so every mode delivers a constant 30 fps (the copy paths already do).
              else ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(FPS)])
    inputs, filt = audio_mix_args(clips, shots, audio_start)
    # extend/anchored/sequential already cropped the marker while rebuilding;
    # exact/aligned mux the raw WebM, so crop the marker strip here.
    if args.mode in ("exact", "aligned"):
        filt = f"[0:v]crop=in_w:in_h-{MARKER_CROP}:0:{MARKER_CROP}[v];" + filt
        vmap = "[v]"
    else:
        vmap = "0:v"
    run([ff, "-y", "-i", str(video_for_mux), *inputs, "-filter_complex", filt,
         "-map", vmap, "-map", "[mix]", *vcodec,
         "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", str(out)])

    # Post-mux shot starts on the OUTPUT timeline (extend/sequential remap them).
    # verify_media.py prefers this file when extracting frames from the MP4 —
    # without it, frames would be pulled at the pre-mux (webm) timestamps.
    # Record the AUDIO placement (when each voice actually plays), so verify /
    # audits sample the frame shown when the narration starts.
    narrated_timings = gen / "shot-timings-narrated.json"
    narrated_timings.write_text(json.dumps(
        [{"shot": s, "start": round(audio_start[s], 2)} for s in shots], indent=2))
    print(f"Done ({args.mode}) -> {out}")
    print(f"Narrated-timeline shot starts -> {narrated_timings}")


if __name__ == "__main__":
    main()
