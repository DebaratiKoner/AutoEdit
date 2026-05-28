import fs from "fs";
import type { CaptionStyle, TranscriptWord } from "./types";

function toAssTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  const whole = Math.floor(rest);
  const cs = Math.floor((rest - whole) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

export interface CaptionOptions {
  videoWidth: number;
  videoHeight: number;
  style?: CaptionStyle;
}

interface StyleSpec {
  fontName: string;
  fontSize: number;
  primary: string; // &HAABBGGRR
  outline: string;
  back: string;
  bold: 0 | 1;
  outlineThickness: number;
  shadow: number;
  marginV: number;
  alignment: number; // 2=bottom-center, 5=middle-center (ASS numpad)
  uppercase: boolean;
  fade: [number, number];
}

function styleSpec(style: CaptionStyle): StyleSpec {
  switch (style) {
    case "clean_white":
      return {
        fontName: "DejaVu Sans",
        fontSize: 96,
        primary: "&H00FFFFFF",
        outline: "&H00000000",
        back: "&H80000000",
        bold: 1,
        outlineThickness: 5,
        shadow: 2,
        marginV: 360,
        alignment: 2,
        uppercase: false,
        fade: [50, 50],
      };
    case "minimal_bottom":
      return {
        fontName: "DejaVu Sans",
        fontSize: 72,
        primary: "&H00FFFFFF",
        outline: "&H00000000",
        back: "&H90000000",
        bold: 0,
        outlineThickness: 3,
        shadow: 1,
        marginV: 180,
        alignment: 2,
        uppercase: false,
        fade: [60, 60],
      };
    case "bold_yellow_pop":
    default:
      return {
        fontName: "DejaVu Sans",
        fontSize: 110,
        primary: "&H0000FFFF",
        outline: "&H00000000",
        back: "&H80000000",
        bold: 1,
        outlineThickness: 8,
        shadow: 3,
        marginV: 420,
        alignment: 2,
        uppercase: true,
        fade: [40, 40],
      };
  }
}

export function buildWordByWordAss(
  words: TranscriptWord[],
  options: CaptionOptions
): string {
  const { videoWidth, videoHeight, style = "bold_yellow_pop" } = options;
  const s = styleSpec(style);

  const header = `[Script Info]
Title: AutoEdit Shorts Captions
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,${s.fontName},${s.fontSize},${s.primary},${s.primary},${s.outline},${s.back},${s.bold},0,0,0,100,100,0,0,1,${s.outlineThickness},${s.shadow},${s.alignment},60,60,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const cleaned = words
    .map((w) => ({
      ...w,
      word: (w.word || "").replace(/\\/g, "").trim(),
    }))
    .filter((w) => w.word.length > 0 && w.end > w.start);

  const lines: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const w = cleaned[i];
    const start = w.start;
    const next = cleaned[i + 1];
    const end = next ? Math.min(w.end + 0.02, next.start) : w.end;
    if (end <= start) continue;

    const raw = s.uppercase ? w.word.toUpperCase() : w.word;
    const text = escapeAssText(raw);
    lines.push(
      `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Word,,0,0,0,,{\\fad(${s.fade[0]},${s.fade[1]})}${text}`
    );
  }

  return header + lines.join("\n") + "\n";
}

export function writeAssFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf-8");
}
