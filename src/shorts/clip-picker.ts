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
        temperature: 0.7,
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
You are an elite viral short-form video editor.

Your job is to:
- analyze the transcript
- obey the user instruction
- create the MOST engaging short possible
- dynamically adapt pacing based on requested duration

RULES:

SHORT DURATION STRATEGY:
- 10-20 sec → aggressive hook only
- 20-40 sec → hook + buildup + payoff
- 40-60 sec → mini story arc
- 60+ sec → full narrative with emotional pacing

INSTRUCTION PRIORITY:
- funny → fast pacing, reactions, punchlines
- educational → clarity, concise value
- motivational → emotional/high-energy moments
- storytelling → suspense + payoff
- podcast → insightful conversational moments

You MUST:
- remove boring parts
- avoid filler
- prioritize retention
- prioritize curiosity
- prioritize emotional spikes

Return JSON only.
`;
  const instructionBlock = instruction?.trim()
    ? `USER INSTRUCTION (STRICT - YOU MUST OBEY THIS):\n"${instruction.trim()}"\n`
    : `USER INSTRUCTION: (Find the most engaging, viral, and interesting segment suitable for a short-form video.)\n`;

  const user = `TRANSCRIPT (with timestamps in seconds):
${transcript}

TOTAL VIDEO DURATION: ${sourceDuration.toFixed(1)}s
TARGET SHORT DURATION: EXACTLY ${targetDuration}s
SELECTION NONCE: ${Date.now()}-${Math.random().toString(36).slice(2)}
${instructionBlock}

SELECTION RULES:
1. Pick ONE continuous range [start, end] from the transcript timestamps above that BEST matches the user instruction.
2. The clip must be self-contained: it should make sense on its own with no prior context.
3. Must have a strong hook in the first 3 seconds.
4. The total duration (end - start) MUST be EXACTLY ${targetDuration} seconds.
5. If a user instruction is provided, prioritize clips matching that instruction/topic above all else.
6. Prefer clips with: concrete insights, surprising claims, emotional peaks, actionable advice.
7. If multiple clips match, use the selection nonce to choose a fresh matching option instead of always choosing the earliest/default segment.

Respond with JSON ONLY:
{
  "start": 12.4,
  "end": ${12.4 + targetDuration},
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
  const clipDuration = Math.min(targetDuration, sourceDuration);
  start = Math.min(Math.max(0, start), Math.max(0, sourceDuration - clipDuration));
  end = start + clipDuration;

  return {
    start,
    end,
    title: String(parsed.title || "Short").slice(0, 80),
    hook: String(parsed.hook || "").slice(0, 200),
    reason: String(parsed.reason || "").slice(0, 300),
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
