#!/usr/bin/env python3
"""Face tracker for Shorts reframing.

Samples a video clip at ~N fps, detects the largest frontal face in each sample
using OpenCV's built-in Haar cascade, smooths the horizontal centroid with an
exponential moving average, and writes a trajectory JSON consumed by the
Node.js reframe module.

Fallbacks gracefully when no face is found (holds last known centroid, defaults
to horizontal center if there are no detections at all).
"""

import argparse
import json
import sys

try:
    import cv2
except ImportError:
    print("ERROR: OpenCV is not installed. Please install it by running: pip install opencv-python", file=sys.stderr)
    sys.exit(1)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True, help="Path to the source video")
    p.add_argument("--start", type=float, default=0.0, help="Clip start (sec)")
    p.add_argument("--end", type=float, default=0.0, help="Clip end (sec). 0 = full")
    p.add_argument("--sample-fps", type=float, default=4.0)
    p.add_argument("--output", required=True, help="Where to write trajectory JSON")
    return p.parse_args()


def main():
    args = parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"ERROR: could not open {args.video}", file=sys.stderr)
        sys.exit(2)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = (total_frames / fps) if fps > 0 else 0

    if width <= 0 or height <= 0:
        print("ERROR: invalid video dimensions", file=sys.stderr)
        sys.exit(3)

    start = max(0.0, args.start)
    end = args.end if args.end > start else duration
    end = min(end, duration) if duration > 0 else end

    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        print("ERROR: could not load Haar cascade", file=sys.stderr)
        sys.exit(4)

    sample_interval = 1.0 / max(0.5, args.sample_fps)
    min_face = max(20, int(min(width, height) * 0.06))

    samples = []
    t = start
    while t <= end + 1e-6:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.2,
            minNeighbors=4,
            minSize=(min_face, min_face),
        )
        rel_t = round(t - start, 3)
        if len(faces) > 0:
            x, y, w, h = max(faces, key=lambda f: int(f[2]) * int(f[3]))
            cx = (x + w / 2.0) / width
            cy = (y + h / 2.0) / height
            samples.append({"t": rel_t, "cx": round(cx, 4), "cy": round(cy, 4), "conf": 1.0})
        else:
            samples.append({"t": rel_t, "cx": None, "cy": None, "conf": 0.0})

        t += sample_interval

    cap.release()

    if not samples:
        samples = [{"t": 0.0, "cx": 0.5, "cy": 0.5, "conf": 0.0}]

    # Fill Nones with nearest neighbour (forward-fill, then backward-fill).
    last = None
    for s in samples:
        if s["cx"] is not None:
            last = s["cx"]
            break
    if last is None:
        last = 0.5
    for s in samples:
        if s["cx"] is None:
            s["cx"] = last
            s["cy"] = 0.5
        else:
            last = s["cx"]

    # Heavy, zero-phase smoothing so the crop stays still most of the time.
    # 1) wide rolling median (k=9 @ 4fps ≈ ±1s window) kills detection outliers
    # 2) double bidirectional EMA at low alpha — equivalent of a 4th-order
    #    zero-phase lowpass, extremely gentle. No lag, no overshoot, almost
    #    all high-frequency motion is gone.
    raw_cx = [s["cx"] for s in samples]

    def rolling_median(values, k):
        half = k // 2
        out = []
        for i in range(len(values)):
            lo = max(0, i - half)
            hi = min(len(values), i + half + 1)
            window = sorted(values[lo:hi])
            out.append(window[len(window) // 2])
        return out

    def bidir_ema(values, alpha):
        fwd = [values[0]]
        for i in range(1, len(values)):
            fwd.append(alpha * values[i] + (1 - alpha) * fwd[-1])
        bwd = [fwd[-1]]
        for i in range(len(fwd) - 2, -1, -1):
            bwd.append(alpha * fwd[i] + (1 - alpha) * bwd[-1])
        bwd.reverse()
        return bwd

    med = rolling_median(raw_cx, 9)
    pass1 = bidir_ema(med, 0.10)
    pass2 = bidir_ema(pass1, 0.10)

    for i, s in enumerate(samples):
        s["cx_smooth"] = round(pass2[i], 4)

    # Count detections for telemetry.
    detected = sum(1 for s in samples if s["conf"] > 0)

    out = {
        "video": {
            "width": width,
            "height": height,
            "fps": fps,
            "duration": duration,
        },
        "clip": {
            "start": start,
            "end": end,
            "duration": end - start,
        },
        "stats": {
            "samples": len(samples),
            "detected": detected,
            "detectionRate": round(detected / max(1, len(samples)), 3),
        },
        "samples": samples,
    }
    with open(args.output, "w") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
