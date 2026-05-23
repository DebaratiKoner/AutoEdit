import fs from "fs";
import path from "path";
import type {
  CaptionStyle,
  ShortsClipPick,
  ShortsJob,
  ShortsSourceVideo,
  ShortsStatus,
} from "./types";

const JOBS_DIR = path.join(process.cwd(), "jobs");
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const EXPORTS_DIR = path.join(process.cwd(), "exports");

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function ensureShortsDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

export function jobFilePath(jobId: string): string {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

export function createJob(params: {
  source: ShortsSourceVideo;
  instruction: string;
  targetDuration: number;
  captionStyle?: CaptionStyle;
  prefilledClip?: ShortsClipPick | null;
}): ShortsJob {
  ensureShortsDirs();
  const now = Date.now();
  const job: ShortsJob = {
    jobId: createId(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    progress: 0,
    source: params.source,
    instruction: params.instruction || "",
    targetDuration: params.targetDuration,
    captionStyle: params.captionStyle ?? "bold_yellow_pop",
    segments: [],
    words: [],
    clip: params.prefilledClip ?? null,
    clipLocked: !!params.prefilledClip,
    logs: [],
  };
  saveJob(job);
  return job;
}

export function saveJob(job: ShortsJob): void {
  ensureShortsDirs();
  job.updatedAt = Date.now();
  fs.writeFileSync(jobFilePath(job.jobId), JSON.stringify(job, null, 2));
}

export function readJob(jobId: string): ShortsJob | null {
  const p = jobFilePath(jobId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ShortsJob;
  } catch {
    return null;
  }
}

export function updateJob(
  jobId: string,
  patch: Partial<ShortsJob>
): ShortsJob | null {
  const current = readJob(jobId);
  if (!current) return null;
  const next: ShortsJob = { ...current, ...patch, updatedAt: Date.now() };
  saveJob(next);
  return next;
}

export function setStatus(
  jobId: string,
  status: ShortsStatus,
  progress: number,
  extra: Partial<ShortsJob> = {}
): ShortsJob | null {
  return updateJob(jobId, { status, progress, ...extra });
}

export function appendLog(jobId: string, message: string): void {
  const job = readJob(jobId);
  if (!job) return;
  const line = `[${new Date().toISOString()}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 200) job.logs = job.logs.slice(-200);
  saveJob(job);
}
