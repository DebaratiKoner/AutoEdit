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
        temperature: 0.1,
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

export async function planDynamicShort(params: {
  segments: TranscriptSegment[];
  sourceDuration: number;
  targetDuration: number;
  instruction: string;
}): Promise<ShortsClipPick> {
  const { segments, sourceDuration, targetDuration, instruction } = params;

  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
    .join("\n");

  const system = `
You are an expert AI video editor. Your task is to select the EXACT continuous segment from the video that most appropriately matches the user's instruction, based entirely on the transcript content.

CRITICAL RULES:
1. Thoroughly read the transcript and evaluate which spoken parts perfectly align with the user's focus/instruction.
2. If the instruction asks for a specific topic, locate the exact timestamps where it is discussed.
3. If specific timestamps are requested (e.g. 'from 15s to 90s'), use those exact timestamps.
4. Prioritize semantic completeness (don't cut off mid-sentence) while staying close to the target duration.
5. Return ONLY a valid JSON object.
`;
  const instructionBlock = instruction?.trim()
    ? `Instruction or focus: "${instruction.trim()}"\n`
    : `Instruction or focus: (Find the most engaging, viral, and interesting segment.)\n`;

  const user = `TRANSCRIPT (with timestamps in seconds):
${transcript}

TOTAL VIDEO DURATION: ${sourceDuration.toFixed(1)}s
TARGET SHORT DURATION: EXACTLY ${targetDuration}s
SELECTION NONCE: ${Date.now()}-${Math.random().toString(36).slice(2)}
${instructionBlock}

Respond with JSON ONLY:
{
  "start": 12.4,
  "end": ${12.4 + targetDuration},
  "title": "5-6 word catchy title",
  "hook": "first line (1 sentence) of the clip",
  "reason": "1-2 sentences on why this clip"
}`;

  const clipDuration = Math.min(targetDuration, sourceDuration);
  const latestStart = Math.max(0, sourceDuration - clipDuration);

  // First pass
  const text1 = await chatJSON(system, user);
  const parsed1 = parseJSON<{
    start?: number;
    end?: number;
    title?: string;
    hook?: string;
    reason?: string;
    instructionKeyPhrases?: string[];
  }>(text1);

  let start1 = Number(parsed1.start);
  let end1 = Number(parsed1.end);
  if (!Number.isFinite(start1) || !Number.isFinite(end1) || end1 <= start1) {
    throw new Error("Clip picker returned invalid start/end");
  }

  const repairedStart1 = Math.min(Math.max(0, start1), latestStart);
  const repairedEnd1 = repairedStart1 + clipDuration;

  const instructionKeyPhrases1 = Array.isArray(parsed1.instructionKeyPhrases)
    ? parsed1.instructionKeyPhrases.map((x) => String(x)).filter(Boolean).slice(0, 8)
    : [];

  const overlapScore = (windowStart: number, windowEnd: number, phrases: string[]) => {
    if (!phrases.length) return 0;
    const windowText = segments
      .filter((s) => s.end > windowStart && s.start < windowEnd)
      .map((s) => s.text)
      .join(" ")
      .toLowerCase();
    const tokens = phrases.map((p) => p.toLowerCase().trim()).filter(Boolean);
    if (!tokens.length) return 0;
    const hits = tokens.reduce((acc, t) => acc + (windowText.includes(t) ? 1 : 0), 0);
    return hits / tokens.length;
  };

  const score1 = overlapScore(repairedStart1, repairedEnd1, instructionKeyPhrases1);

  const needsSecondPass = instruction?.trim()
    ? (score1 < 0.35 || repairedStart1 !== start1)
    : repairedStart1 !== start1;

  if (!needsSecondPass) {
    return {
      start: repairedStart1,
      end: repairedEnd1,
      title: String(parsed1.title || "Short").slice(0, 80),
      hook: String(parsed1.hook || "").slice(0, 200),
      reason: String(parsed1.reason || "").slice(0, 300),
    };
  }

  // Second pass (only if needed) — ask to re-pick within bounds and align with instruction.
  const secondPassUser = `${user}\n\nSECOND PASS (REPAIR):\n- instructionKeyPhrases is required: return 3-7 short phrases that appear in the chosen segment.\n- Pick a VALID continuous window within [0, ${sourceDuration.toFixed(1)}] with EXACTLY ${targetDuration}s duration.\n- Prefer shifting within bounds rather than returning out-of-range.\n`;

  const text2 = await chatJSON(system, secondPassUser);
  const parsed2 = parseJSON<{
    start?: number;
    end?: number;
    title?: string;
    hook?: string;
    reason?: string;
  }>(text2);

  let start2 = Number(parsed2.start);
  let end2 = Number(parsed2.end);
  if (!Number.isFinite(start2) || !Number.isFinite(end2) || end2 <= start2) {
    throw new Error("Clip picker (second pass) returned invalid start/end");
  }

  const repairedStart2 = Math.min(Math.max(0, start2), latestStart);
  const repairedEnd2 = repairedStart2 + clipDuration;

  return {
    start: repairedStart2,
    end: repairedEnd2,
    title: String(parsed2.title || parsed1.title || "Short").slice(0, 80),
    hook: String(parsed2.hook || parsed1.hook || "").slice(0, 200),
    reason: String(parsed2.reason || parsed1.reason || "").slice(0, 300),
  };
}


export const pickBestClip = planDynamicShort;

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
