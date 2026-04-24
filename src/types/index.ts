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
  name?: string;           // Optional custom name for the clip
  assetUrl?: string;       // External asset URL (Pixabay video/photo)
  assetKind?: 'video' | 'photo'; // Type of external asset
}

/**
 * Represents an editing operation for undo/redo functionality
 */
export type EditAction = 
  | { type: 'CUT'; segmentId: string; cutTime: number; newSegmentId: string }
  | { type: 'DELETE'; segment: TimelineSegment }
  | { type: 'MOVE'; segmentId: string; oldOrder: number; newOrder: number }
  | { type: 'TRANSCRIPT_EDIT'; oldText: string; newText: string };

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
  undoStack: EditAction[];
  redoStack: EditAction[];
  lastModified: number;
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
