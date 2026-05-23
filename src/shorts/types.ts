export type ShortsStatus =
  | "pending"
  | "transcribing"
  | "picking"
  | "reframing"
  | "captioning"
  | "assembling"
  | "ready"
  | "error";

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface ShortsClipPick {
  start: number;
  end: number;
  title: string;
  reason: string;
  hook: string;
}

export interface ShortsSourceVideo {
  filename: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export type CaptionStyle =
  | "bold_yellow_pop"
  | "clean_white"
  | "minimal_bottom"
  | "off";

export const CAPTION_STYLES: {
  id: CaptionStyle;
  label: string;
  description: string;
}[] = [
  {
    id: "bold_yellow_pop",
    label: "Bold Yellow Pop",
    description: "High-contrast yellow words, large and loud — TikTok energy.",
  },
  {
    id: "clean_white",
    label: "Clean White",
    description: "Crisp white with subtle shadow. Works for almost anything.",
  },
  {
    id: "minimal_bottom",
    label: "Minimal Bottom",
    description: "Smaller, dialed-down captions anchored to the bottom.",
  },
  {
    id: "off",
    label: "No Captions",
    description: "Skip burned-in captions entirely.",
  },
];

export interface ShortsJob {
  jobId: string;
  status: ShortsStatus;
  createdAt: number;
  updatedAt: number;
  progress: number;

  source: ShortsSourceVideo;
  instruction: string;
  targetDuration: number;
  captionStyle: CaptionStyle;

  segments: TranscriptSegment[];
  words: TranscriptWord[];
  clip: ShortsClipPick | null;
  // When true, the pipeline must skip LLM clip selection and use `clip` as-is.
  clipLocked?: boolean;

  finalFilename?: string;
  finalUrl?: string;
  downloadUrl?: string;
  error?: string;
  logs: string[];
}

export interface ShortsGenerateRequest {
  filename: string;
  instruction?: string;
  targetDuration: number;
  captionStyle?: CaptionStyle;
  // Optional explicit clip window. When both are provided the backend skips
  // the LLM clip picker entirely and uses this window verbatim.
  clipStart?: number;
  clipEnd?: number;
}
