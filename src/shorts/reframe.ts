import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const PY_SCRIPT = path.join(process.cwd(), "src", "shorts", "face_track.py");
const VENV_PYTHON = process.platform === "win32"
  ? path.join(process.cwd(), ".venv", "Scripts", "python.exe")
  : path.join(process.cwd(), ".venv", "bin", "python");

const TARGET_W = 1080;
const TARGET_H = 1920;
const TARGET_ASPECT = TARGET_W / TARGET_H;

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

interface Sample {
  t: number;
  cx: number;
  cy: number;
  conf: number;
  cx_smooth: number;
}

interface Trajectory {
  video: { width: number; height: number; fps: number; duration: number };
  clip: { start: number; end: number; duration: number };
  stats: { samples: number; detected: number; detectionRate: number };
  samples: Sample[];
}

export interface CropPlan {
  mode: "h-crop" | "v-crop" | "passthrough";
  windowW: number;
  windowH: number;
  // Static crop anchor; used when xTimeline is empty, and as the initial
  // crop position (crop parameters set when sendcmd is used too).
  staticX: number;
  staticY: number;
  // When non-empty, crop x should animate over time via sendcmd.
  // Each entry: { t: seconds-from-clip-start, x: pixel offset in source frame }
  xTimeline: { t: number; x: number }[];
}

function pickPython(): string {
  if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
  return "python3";
}

export function runFaceTrack(params: {
  videoPath: string;
  start: number;
  end: number;
}): Trajectory {
  const trajectoryPath = path.join(UPLOADS_DIR, `shorts_track_${createId()}.json`);
  try {
    const py = pickPython();
    const result = spawnSync(
      py,
      [
        PY_SCRIPT,
        "--video", params.videoPath,
        "--start", params.start.toFixed(3),
        "--end", params.end.toFixed(3),
        "--sample-fps", "4",
        "--output", trajectoryPath,
      ],
      { encoding: "utf-8", timeout: 300_000 }
    );
    if (result.status !== 0) {
      const err = (result.stderr || result.stdout || `exit ${result.status}`).toString();
      throw new Error(`face_track failed: ${err.slice(0, 400)}`);
    }
    const raw = fs.readFileSync(trajectoryPath, "utf-8");
    return JSON.parse(raw) as Trajectory;
  } finally {
    try {
      fs.unlinkSync(trajectoryPath);
    } catch {}
  }
}

function decimate<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

// Hysteretic deadband with hold time. The crop only repositions when the
// smoothed face has stayed more than `deadband` px away from the currently
// held position for at least `holdSeconds` continuously. This eliminates
// drift-induced ping-pong near threshold boundaries.
function hystereticKeyframes(
  samples: { t: number; x: number }[],
  deadband: number,
  holdSeconds: number
): { t: number; x: number }[] {
  if (samples.length <= 1) return samples.slice();
  const out: { t: number; x: number }[] = [samples[0]];
  let heldX = samples[0].x;
  let candidateStart = -1;
  let candidateX = heldX;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (Math.abs(s.x - heldX) <= deadband) {
      candidateStart = -1;
      continue;
    }
    if (candidateStart < 0 || Math.sign(s.x - heldX) !== Math.sign(candidateX - heldX)) {
      candidateStart = s.t;
      candidateX = s.x;
      continue;
    }
    candidateX = s.x;
    if (s.t - candidateStart >= holdSeconds) {
      out.push({ t: candidateStart, x: candidateX });
      heldX = candidateX;
      candidateStart = -1;
    }
  }
  return out;
}

// Turn a sparse list of keyframes into a smooth pan by inserting intermediate
// linearly-interpolated points right before each target keyframe. sendcmd
// holds the last x between commands, so the crop stays still during the hold
// and only ramps to the new position over `rampSeconds`.
function ramp(
  keyframes: { t: number; x: number }[],
  rampSeconds: number,
  stepSeconds: number
): { t: number; x: number }[] {
  if (keyframes.length <= 1) return keyframes.slice();
  const out: { t: number; x: number }[] = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const prev = keyframes[i - 1];
    const curr = keyframes[i];
    const startT = Math.max(prev.t, curr.t - rampSeconds);
    if (startT > prev.t + 1e-3) {
      out.push({ t: startT, x: prev.x });
    }
    const steps = Math.max(2, Math.ceil((curr.t - startT) / stepSeconds));
    for (let s = 1; s <= steps; s++) {
      const frac = s / steps;
      const t = startT + (curr.t - startT) * frac;
      const x = Math.round(prev.x + (curr.x - prev.x) * frac);
      out.push({ t, x });
    }
  }
  return out;
}

export function buildCropPlan(trajectory: Trajectory): CropPlan {
  const { width, height } = trajectory.video;
  const sourceAspect = width / height;

  if (sourceAspect > TARGET_ASPECT) {
    const windowH = height;
    let windowW = Math.floor(height * TARGET_ASPECT);
    if (windowW % 2 !== 0) windowW -= 1;
    const maxX = width - windowW;

    // Three-stage pipeline to kill wobble:
    // 1) project smoothed centroid -> pixel window position
    // 2) hysteretic deadband (≥10% of windowW, held ≥1s) picks sparse keyframes
    // 3) ramp between keyframes over ~1s so each move plays as a slow pan
    //    instead of an instant snap. Hard cap at 60 total commands.
    const deadbandPx = Math.max(40, Math.round(windowW * 0.10));
    const raw = trajectory.samples.map((s) => {
      const cx = typeof s.cx_smooth === "number" ? s.cx_smooth : 0.5;
      let px = Math.round(width * cx - windowW / 2);
      px = Math.max(0, Math.min(maxX, px));
      return { t: Math.max(0, s.t), x: px };
    });
    const keyframes = hystereticKeyframes(raw, deadbandPx, 1.0);
    const ramped = ramp(keyframes, 1.0, 0.2);
    const timeline = decimate(ramped, 60);

    // Fallback to center if detection yielded nothing usable.
    const initialX = timeline.length > 0
      ? timeline[0].x
      : Math.max(0, Math.min(maxX, Math.round((width - windowW) / 2)));

    return {
      mode: "h-crop",
      windowW,
      windowH,
      staticX: initialX,
      staticY: 0,
      xTimeline: timeline.length > 1 ? timeline : [],
    };
  }

  if (sourceAspect < TARGET_ASPECT) {
    const windowW = width;
    let windowH = Math.floor(width / TARGET_ASPECT);
    if (windowH % 2 !== 0) windowH -= 1;
    const y = Math.max(0, Math.round((height - windowH) / 2));
    return {
      mode: "v-crop",
      windowW,
      windowH,
      staticX: 0,
      staticY: y,
      xTimeline: [],
    };
  }

  return {
    mode: "passthrough",
    windowW: width,
    windowH: height,
    staticX: 0,
    staticY: 0,
    xTimeline: [],
  };
}

export const TARGET = { W: TARGET_W, H: TARGET_H } as const;
