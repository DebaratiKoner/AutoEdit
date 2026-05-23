import path from "path";
import fs from "fs";
import { execSync, spawnSync } from "child_process";
import type { TranscriptSegment, TranscriptWord } from "./types";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set in environment");
  return key;
}

function extractAudioMp3(videoPath: string, audioPath: string): void {
  execSync(
    `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 64k "${audioPath}"`,
    { stdio: "pipe", timeout: 300_000 }
  );
}

function compressIfNeeded(audioPath: string): string {
  const stats = fs.statSync(audioPath);
  const sizeMB = stats.size / (1024 * 1024);
  if (sizeMB <= 24) return audioPath;
  const compressedPath = audioPath.replace(/\.\w+$/, "_small.mp3");
  execSync(
    `ffmpeg -y -i "${audioPath}" -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 32k "${compressedPath}"`,
    { stdio: "pipe", timeout: 300_000 }
  );
  return compressedPath;
}

export async function transcribeWithWords(
  videoFilename: string
): Promise<{ segments: TranscriptSegment[]; words: TranscriptWord[] }> {
  const apiKey = getApiKey();
  const videoPath = path.join(UPLOADS_DIR, videoFilename);

  const audioFilename = videoFilename.replace(/\.\w+$/, ".mp3");
  const audioPath = path.join(UPLOADS_DIR, audioFilename);
  extractAudioMp3(videoPath, audioPath);
  const finalAudioPath = compressIfNeeded(audioPath);

  const curlArgs = [
    "-sS",
    "--http1.1",
    "--max-time", "300",
    "--retry", "3",
    "--retry-delay", "5",
    "--retry-all-errors",
    "-X", "POST",
    "https://api.openai.com/v1/audio/transcriptions",
    "-H", `Authorization: Bearer ${apiKey}`,
    "-F", `file=@${finalAudioPath};type=audio/mpeg;filename=audio.mp3`,
    "-F", "model=whisper-1",
    "-F", "response_format=verbose_json",
    "-F", "timestamp_granularities[]=segment",
    "-F", "timestamp_granularities[]=word",
  ];

  const result = spawnSync("curl", curlArgs, {
    maxBuffer: 100 * 1024 * 1024,
    timeout: 360_000,
  });

  if (result.error) throw new Error(`curl failed: ${result.error.message}`);
  const stdout = (result.stdout || "").toString();
  const stderr = (result.stderr || "").toString();

  if (result.status !== 0) {
    throw new Error(`Whisper request failed: ${stderr || stdout || result.status}`);
  }
  if (!stdout) throw new Error(`Whisper returned empty response: ${stderr}`);

  let data: { error?: { message?: string }; segments?: Array<{ start: number; end: number; text?: string }>; words?: Array<{ word?: string; start: number; end: number }> };
  try {
    data = JSON.parse(stdout) as typeof data;
  } catch {
    throw new Error(`Failed to parse Whisper response: ${stdout.slice(0, 400)}`);
  }
  if (data?.error) {
    throw new Error(data.error?.message || JSON.stringify(data.error));
  }

  const segments: TranscriptSegment[] = (data.segments || []).map(
    (s, i: number) => ({
      id: i,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text || "").trim(),
    })
  );

  const words: TranscriptWord[] = (data.words || []).map((w) => ({
    word: String(w.word || "").trim(),
    start: Number(w.start) || 0,
    end: Number(w.end) || 0,
  }));

  return { segments, words };
}
