import { transcribeWithWords } from "./transcribe";
import { pickBestClip } from "./clip-picker";
import { assembleJob } from "./assemble";
import {
  appendLog,
  readJob,
  setStatus,
  updateJob,
} from "./job";
import type { ShortsJob } from "./types";

export async function runPipeline(jobId: string): Promise<void> {
  let job = readJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  try {
    appendLog(
      jobId,
      `Pipeline start. Source: ${job.source.filename} (${job.source.duration.toFixed(1)}s, ${job.source.width}x${job.source.height})`
    );

    setStatus(jobId, "transcribing", 10);
    appendLog(jobId, `Transcribing with Whisper (word timestamps)…`);
    const { segments, words } = await transcribeWithWords(job.source.filename);
    appendLog(
      jobId,
      `Transcript: ${segments.length} segments, ${words.length} words`
    );
    job = updateJob(jobId, { segments, words })!;

    setStatus(jobId, "picking", 40);
    let clip = job.clip;
    if (job.clipLocked && clip) {
      appendLog(
        jobId,
        `Using manual clip window: [${clip.start.toFixed(1)}s → ${clip.end.toFixed(1)}s] "${clip.title}"`
      );
    } else {
      appendLog(jobId, `Finding best clip with LLM…`);
      clip = await pickBestClip({
        segments,
        sourceDuration: job.source.duration,
        targetDuration: job.targetDuration,
        instruction: job.instruction,
      });
      appendLog(
        jobId,
        `Clip chosen: [${clip.start.toFixed(1)}s → ${clip.end.toFixed(1)}s] "${clip.title}"`
      );
      job = updateJob(jobId, { clip })!;
    }

    setStatus(jobId, "reframing", 65);
    appendLog(jobId, `Tracking faces and planning 9:16 reframe…`);

    setStatus(jobId, "captioning", 80);
    appendLog(jobId, `Generating word-by-word captions and rendering…`);

    setStatus(jobId, "assembling", 90);
    const { finalFilename, cropMode, detectionRate } = await assembleJob(
      readJob(jobId)!
    );
    appendLog(
      jobId,
      `Render done. Crop=${cropMode}, face detection rate=${(detectionRate * 100).toFixed(0)}%`
    );

    setStatus(jobId, "ready", 100, {
      finalFilename,
      finalUrl: `/api/shorts/video/${finalFilename}`,
      downloadUrl: `/api/shorts/download/${finalFilename}`,
    });
    appendLog(jobId, `Done: ${finalFilename}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[shorts] pipeline error for ${jobId}:`, msg);
    appendLog(jobId, `ERROR: ${msg}`);
    setStatus(jobId, "error", 100, { error: msg });
  }
}

export function kickoffPipeline(job: ShortsJob): void {
  setImmediate(() => {
    runPipeline(job.jobId).catch((e) => {
      console.error(`[shorts] uncaught pipeline error:`, e);
    });
  });
}
