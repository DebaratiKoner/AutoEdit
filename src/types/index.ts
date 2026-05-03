/**
 * Core data models for the video editor application
 */

/**
 * Represents a segment of video in the timeline
 */
export interface TimelineSegment {
  id: string;              // Unique identifier (UUID)
  sourceStart: number;     // Start time in source video (seconds)
  sourceEnd: number;       // End time in source video (seconds)
  timelineStart: number;   // Start position in timeline (seconds)
  duration: number;        // Segment duration (seconds)
  order: number;           // Sequence order in timeline
  track: number;           // Track number (0 = main video, 1 = overlay, 2 = audio, etc.)
  name?: string;           // Optional custom name for the clip
  color?: string;          // Permanent color for visual identification
  assetKind?: 'video' | 'photo' | 'audio'; // Type of asset if this is an imported asset
  assetUrl?: string;       // URL for imported assets
  volume?: number;         // Volume level for audio tracks (0-2, default 1)
  segments?: Array<{       // For merged clips: array of source segments
    sourceStart: number;
    sourceEnd: number;
    duration: number;
  }>;
  isMerged?: boolean;      // Flag indicating this is a merged clip
}

/**
 * Represents an editing operation for undo/redo functionality
 */
export type EditAction = 
  | { type: 'CUT'; segmentId: string; cutTime: number; newSegmentId: string }
  | { type: 'DELETE'; segment: TimelineSegment }
  | { type: 'MOVE'; segmentId: string; oldOrder: number; newOrder: number }
  | { type: 'REORDER'; previousTimeline: TimelineSegment[] }
  | { type: 'ADD_ASSET'; previousTimeline: TimelineSegment[]; asset?: TimelineSegment }
  | { type: 'RESIZE'; previousTimeline: TimelineSegment[] }
  | { type: 'TRANSCRIPT_EDIT'; oldText: string; newText: string }
  | { 
      type: 'AI_EDIT'; 
      previousTimeline: TimelineSegment[];
      previousTranscript: string | null;
      previousTranscriptSegments: Array<{ start: number; end: number; text: string }> | null;
      prompt?: string;
      operations?: Array<Record<string, any>>;
    };

/**
 * Represents a transcript history entry
 */
export interface TranscriptHistoryEntry {
  timestamp: number;
  operation: string;
  transcript: string;
  segments: Array<{ start: number; end: number; text: string }> | null;
}

/**
 * Complete editing session state
 */
export interface SessionData {
  sessionId: string;
  videoUrl: string;
  duration: number;
  resolution: { width: number; height: number };
  timeline: TimelineSegment[];
  transcript: string | null;
  transcriptSegments: Array<{ start: number; end: number; text: string }> | null;
  transcriptHistory?: TranscriptHistoryEntry[]; // History of all transcript versions
  undoStack: EditAction[];
  redoStack: EditAction[];
  lastModified: number;
  remotionSettings?: RemotionSettings;
}

/**
 * Remotion-specific settings (optional, backward compatible)
 */
export interface RemotionSettings {
  subtitleStyle?: Partial<SubtitleStyle>;
  transitionType?: TransitionType;
  transitionDuration?: number;  // In seconds
  exportFps?: number;
  enableSubtitles?: boolean;
}

/**
 * File validation outcome
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  details?: {
    format?: string;
    resolution?: { width: number; height: number };
    duration?: number;
  };
}

/**
 * Backend response for video upload
 */
export interface UploadResponse {
  sessionId: string;
  videoUrl: string;
  duration: number;
  resolution: { width: number; height: number };
}

/**
 * Backend response for transcription
 */
export interface TranscriptResponse {
  transcript: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
  }>;
  mode?: 'edited' | 'full';  // Indicates if transcript is from edited clips or full video
}

/**
 * Backend response for video export
 */
export interface ExportResponse {
  downloadUrl: string;
  expiresAt: string;
}

/**
 * Backend response for session retrieval
 */
export interface SessionResponse {
  sessionId: string;
  videoUrl: string;
  duration: number;
  createdAt: string;
  lastModified: string;
}

/**
 * Remotion Composition Schema
 * Defines a complete video composition for Remotion rendering
 */
export interface CompositionSchema {
  id: string;
  version: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  clips: ClipDefinition[];
  subtitles: SubtitleDefinition[];
  transitions: TransitionConfig;
  createdAt: string;
  sourceSessionId: string;
}

/**
 * Clip definition for Remotion composition
 */
export interface ClipDefinition {
  id: string;
  src: string;              // Video file URL or path
  startFrom: number;        // Frame offset in composition
  durationInFrames: number; // Clip duration in frames
  sourceStart: number;      // Trim start in source video (seconds)
  sourceEnd: number;        // Trim end in source video (seconds)
  volume: number;           // Audio volume (0-1)
  name?: string;            // Clip name
  order: number;            // Original timeline order
}

/**
 * Subtitle definition for Remotion overlay
 */
export interface SubtitleDefinition {
  id: string;
  text: string;
  startFrame: number;
  endFrame: number;
  style?: SubtitleStyle;
}

/**
 * Subtitle styling configuration
 */
export interface SubtitleStyle {
  fontSize: number;
  fontFamily: string;
  color: string;
  backgroundColor: string;
  position: 'top' | 'center' | 'bottom';
  padding: number;
}

/**
 * Transition configuration
 */
export interface TransitionConfig {
  enabled: boolean;
  type: TransitionType;
  durationInFrames: number;
}

/**
 * Transition types
 */
export type TransitionType = 'none' | 'fade' | 'crossfade';

/**
 * Build options for CompositionBuilder
 */
export interface BuildOptions {
  fps?: number;
  enableTransitions?: boolean;
  transitionDuration?: number;
  subtitleStyle?: Partial<SubtitleStyle>;
}

/**
 * Validation result for composition schema
 */
export interface CompositionValidationResult {
  valid: boolean;
  errors: string[];
}
