import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { TARGET, buildCropPlan, runFaceTrack, type CropPlan } from "./reframe";
import { buildWordByWordAss, writeAssFile } from "./captions";
import { wordsInRange } from "./clip-picker";
import type { ShortsJob } from "./types";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const EXPORTS_DIR = path.join(process.cwd(), "exports");

function runFFmpeg(cmd: string): void {
  execSync(cmd, { stdio: "pipe", timeout: 600_000, maxBuffer: 20 * 1024 * 1024 });
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

// Build the video filter chain. Uses `sendcmd` to re-target the crop filter's
// x parameter at discrete times instead of a giant nested `if()` expression
// (FFmpeg's expression parser chokes on deep nesting).
function buildVideoFilter(crop: CropPlan, assPath: string | null): string {
  const parts: string[] = [];

  if (crop.xTimeline.length > 1) {
    // Use a named crop instance so sendcmd can address it.
    const commands = crop.xTimeline
      .map((pt) => `${pt.t.toFixed(3)} [enter] crop@fc x ${pt.x}`)
      .join(";");
    parts.push(`sendcmd=c='${commands}'`);
    parts.push(
      `crop@fc=w=${crop.windowW}:h=${crop.windowH}:x=${crop.staticX}:y=${crop.staticY}`
    );
  } else {
    parts.push(
      `crop=w=${crop.windowW}:h=${crop.windowH}:x=${crop.staticX}:y=${crop.staticY}`
    );
  }

  parts.push(`scale=${TARGET.W}:${TARGET.H}:flags=bicubic`);
  parts.push(`setsar=1`);
  if (assPath) {
    parts.push(`subtitles='${escapeFilterPath(assPath)}'`);
  }
  return parts.join(",");
}

export async function assembleJob(job: ShortsJob): Promise<{
  finalFilename: string;
  cropMode: string;
  detectionRate: number;
}> {
  if (!job.clip) throw new Error("No clip selected");

  fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const sourcePath = path.join(UPLOADS_DIR, job.source.filename);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source video missing: ${job.source.filename}`);
  }

  const clipStart = job.clip.start;
  const clipEnd = job.clip.end;
  const clipDuration = clipEnd - clipStart;

  const trajectory = runFaceTrack({
    videoPath: sourcePath,
    start: clipStart,
    end: clipEnd,
  });
  const crop = buildCropPlan(trajectory);

  const captionStyle = job.captionStyle ?? "bold_yellow_pop";
  const clipWords = wordsInRange(job.words, clipStart, clipEnd);
  let assPath: string | null = null;
  if (captionStyle !== "off" && clipWords.length > 0) {
    const assContent = buildWordByWordAss(clipWords, {
      videoWidth: TARGET.W,
      videoHeight: TARGET.H,
      style: captionStyle,
    });
    assPath = path.join(UPLOADS_DIR, `shorts_${job.jobId}_captions.ass`);
    writeAssFile(assPath, assContent);
  }

  const finalFilename = `short_${job.jobId}.mp4`;
  const finalPath = path.join(EXPORTS_DIR, finalFilename);

  const vf = buildVideoFilter(crop, assPath);

  const cmd = [
    "ffmpeg",
    "-y",
    "-ss", clipStart.toFixed(3),
    "-i", `"${sourcePath}"`,
    "-t", clipDuration.toFixed(3),
    "-vf", `"${vf}"`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    "-movflags", "+faststart",
    `"${finalPath}"`,
  ].join(" ");

  try {
    runFFmpeg(cmd);
  } finally {
    if (assPath) {
      try {
        fs.unlinkSync(assPath);
      } catch {}
    }
  }

  return {
    finalFilename,
    cropMode: crop.mode,
    detectionRate: trajectory.stats.detectionRate,
  };
}
