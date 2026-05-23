import type {
  ShortsClipPick,
  TranscriptSegment,
  TranscriptWord,
} from "./types";

const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_RETRIES = 3;

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set in environment");
  return key;
}

function parseJSON<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Clip picker did not return valid JSON");
  return JSON.parse(match[0]) as T;
}

async function chatJSON(system: string, user: string): Promise<string> {
  const apiKey = getApiKey();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (res.status === 429 && attempt < MAX_RETRIES - 1) {
      const retryAfter = res.headers.get("retry-after");
      const waitSec = retryAfter ? parseInt(retryAfter) + 1 : 8;
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message || `OpenAI API error: ${res.status}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || "";
  }
  throw new Error("Clip picker: max retries exceeded");
}

export async function pickBestClip(params: {
  segments: TranscriptSegment[];
  sourceDuration: number;
  targetDuration: number;
  instruction: string;
}): Promise<ShortsClipPick> {
  const { segments, sourceDuration, targetDuration, instruction } = params;

  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
    .join("\n");

  const minDur = Math.max(10, Math.round(targetDuration * 0.7));
  const maxDur = Math.min(90, Math.round(targetDuration * 1.3));

  const system = `You are a short-form video editor. Given a transcript of a longer video, you find the single BEST self-contained clip to turn into a viral 9:16 short. You always respond with valid JSON only.`;

  const instructionBlock = instruction?.trim()
    ? `USER INSTRUCTION (obey this above all else if compatible):\n"${instruction.trim()}"\n`
    : `USER INSTRUCTION: (none — pick whatever will perform best as a standalone short)\n`;

  const user = `TRANSCRIPT (with timestamps in seconds):
${transcript}

TOTAL VIDEO DURATION: ${sourceDuration.toFixed(1)}s
TARGET SHORT DURATION: ~${targetDuration}s (acceptable range ${minDur}s–${maxDur}s)
${instructionBlock}

SELECTION RULES:
1. Pick ONE continuous range [start, end] from the transcript timestamps above. Do NOT invent times outside these ranges.
2. The clip must be self-contained: it should make sense on its own with no prior context.
3. Must have a strong hook in the first 3 seconds.
4. Must feel complete — avoid cutting off mid-thought. Align start/end to sentence boundaries from the transcript.
5. Duration must be between ${minDur}s and ${maxDur}s.
6. If a user instruction is provided, prioritize clips matching that instruction/topic.
7. Prefer clips with: concrete insights, surprising claims, emotional peaks, actionable advice, punchy delivery, humor, or strong stories. Avoid intros, outros, filler, and logistics talk.

Respond with JSON ONLY:
{
  "start": 12.4,
  "end": 67.8,
  "title": "5-6 word catchy title",
  "hook": "first line (1 sentence) of the clip — what will grab viewers",
  "reason": "1-2 sentences on why this clip"
}`;

  const text = await chatJSON(system, user);
  const parsed = parseJSON<{ start?: number; end?: number; title?: string; hook?: string; reason?: string }>(text);

  let start = Number(parsed.start);
  let end = Number(parsed.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("Clip picker returned invalid start/end");
  }
  start = Math.max(0, start);
  end = Math.min(sourceDuration, end);
  const dur = end - start;
  if (dur < 5) {
    throw new Error(`Clip picker chose a too-short clip (${dur.toFixed(1)}s)`);
  }

  return {
    start,
    end,
    title: String(parsed.title || "Short").slice(0, 80),
    hook: String(parsed.hook || "").slice(0, 200),
    reason: String(parsed.reason || "").slice(0, 300),
  };
}

export function wordsInRange(
  words: TranscriptWord[],
  start: number,
  end: number
): TranscriptWord[] {
  return words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({
      word: w.word,
      start: Math.max(start, w.start) - start,
      end: Math.min(end, w.end) - start,
    }));
}
