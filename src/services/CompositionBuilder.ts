/**
 * CompositionBuilder Service
 * Transforms SessionData into Remotion-compatible composition schema
 */

import type {
  SessionData,
  CompositionSchema,
  ClipDefinition,
  SubtitleDefinition,
  SubtitleStyle,
  TransitionConfig,
  BuildOptions,
  CompositionValidationResult,
} from '../types';

const DEFAULT_FPS = 30;
const DEFAULT_TRANSITION_DURATION = 0.5; // seconds

const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 32,
  fontFamily: 'Arial, sans-serif',
  color: '#FFFFFF',
  backgroundColor: 'rgba(0, 0, 0, 0.75)',
  position: 'bottom',
  padding: 40,
};

export class CompositionBuilder {
  /**
   * Build Remotion composition schema from session data
   */
  buildComposition(session: SessionData, options: BuildOptions = {}): CompositionSchema {
    const fps = options.fps ?? session.remotionSettings?.exportFps ?? DEFAULT_FPS;
    const enableTransitions = options.enableTransitions ?? true;
    const transitionDuration = options.transitionDuration ?? session.remotionSettings?.transitionDuration ?? DEFAULT_TRANSITION_DURATION;

    // Step 1: Sort timeline segments by order
    const sortedSegments = [...session.timeline].sort((a, b) => a.order - b.order);

    // Step 2: Calculate cumulative frame offsets and map to ClipDefinitions
    let cumulativeFrames = 0;
    const clips: ClipDefinition[] = [];

    for (const segment of sortedSegments) {
      const durationInFrames = Math.floor(segment.duration * fps);

      const assetKind = segment.assetKind ?? (segment.assetUrl ? 'video' : 'video');
      const src = assetKind === 'photo'
        ? (segment.assetUrl || session.videoUrl)
        : session.videoUrl;

      clips.push({
        id: segment.id,
        src,
        startFrom: cumulativeFrames,
        durationInFrames,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        volume: 1.0,
        name: segment.name,
        order: segment.order,
        assetKind,
      });

      cumulativeFrames += durationInFrames;
    }

    // Step 3: Map transcript segments to subtitles
    const subtitles: SubtitleDefinition[] = [];
    const enableSubtitles = session.remotionSettings?.enableSubtitles ?? true;

    if (enableSubtitles && session.transcriptSegments) {
      for (let i = 0; i < session.transcriptSegments.length; i++) {
        const seg = session.transcriptSegments[i];
        const customStyle = session.remotionSettings?.subtitleStyle ?? options.subtitleStyle;

        subtitles.push({
          id: `subtitle-${i}`,
          text: seg.text,
          startFrame: Math.floor(seg.start * fps),
          endFrame: Math.floor(seg.end * fps),
          style: customStyle ? { ...DEFAULT_SUBTITLE_STYLE, ...customStyle } : DEFAULT_SUBTITLE_STYLE,
        });
      }
    }

    // Step 4: Configure transitions
    const transitionDurationFrames = Math.floor(transitionDuration * fps);
    const transitionType = session.remotionSettings?.transitionType ?? 'fade';

    const transitions: TransitionConfig = {
      enabled: enableTransitions,
      type: transitionType,
      durationInFrames: transitionDurationFrames,
    };

    // Step 5: Build final schema
    return {
      id: session.sessionId,
      version: '1.0',
      fps,
      width: session.resolution.width,
      height: session.resolution.height,
      durationInFrames: cumulativeFrames,
      clips,
      subtitles,
      transitions,
      createdAt: new Date().toISOString(),
      sourceSessionId: session.sessionId,
    };
  }

  /**
   * Convert seconds to frames based on fps
   */
  secondsToFrames(seconds: number, fps: number): number {
    return Math.floor(seconds * fps);
  }

  /**
   * Convert frames to seconds based on fps
   */
  framesToSeconds(frames: number, fps: number): number {
    return frames / fps;
  }

  /**
   * Validate composition schema before rendering
   * Returns validation result with errors if any
   */
  validateComposition(schema: CompositionSchema): CompositionValidationResult {
    const errors: string[] = [];

    // Validate metadata
    if (!schema.id || typeof schema.id !== 'string') {
      errors.push('Composition ID must be a non-empty string');
    }

    // Validate video configuration
    if (!Number.isInteger(schema.fps) || schema.fps < 24 || schema.fps > 60) {
      errors.push(`FPS must be an integer between 24-60, got ${schema.fps}`);
    }

    if (!Number.isInteger(schema.width) || schema.width <= 0) {
      errors.push(`Width must be a positive integer, got ${schema.width}`);
    }

    if (!Number.isInteger(schema.height) || schema.height <= 0) {
      errors.push(`Height must be a positive integer, got ${schema.height}`);
    }

    if (!Number.isInteger(schema.durationInFrames) || schema.durationInFrames <= 0) {
      errors.push(`Duration must be a positive integer, got ${schema.durationInFrames}`);
    }

    // Validate clips
    if (!Array.isArray(schema.clips) || schema.clips.length === 0) {
      errors.push('Composition must have at least one clip');
    }

    let totalClipDuration = 0;
    for (let i = 0; i < schema.clips.length; i++) {
      const clip = schema.clips[i];
      const prefix = `clips[${i}]`;

      if (!clip.id) {
        errors.push(`${prefix}.id is required`);
      }

      if (!clip.src) {
        errors.push(`${prefix}.src is required`);
      }

      if (!Number.isInteger(clip.startFrom) || clip.startFrom < 0) {
        errors.push(`${prefix}.startFrom must be a non-negative integer, got ${clip.startFrom}`);
      }

      if (!Number.isInteger(clip.durationInFrames) || clip.durationInFrames <= 0) {
        errors.push(`${prefix}.durationInFrames must be a positive integer, got ${clip.durationInFrames}`);
      }

      if (typeof clip.sourceStart !== 'number' || clip.sourceStart < 0) {
        errors.push(`${prefix}.sourceStart must be a non-negative number, got ${clip.sourceStart}`);
      }

      if (typeof clip.sourceEnd !== 'number' || clip.sourceEnd <= clip.sourceStart) {
        errors.push(`${prefix}.sourceEnd must be greater than sourceStart, got ${clip.sourceEnd}`);
      }

      if (typeof clip.volume !== 'number' || clip.volume < 0 || clip.volume > 1) {
        errors.push(`${prefix}.volume must be between 0 and 1, got ${clip.volume}`);
      }

      totalClipDuration += clip.durationInFrames;
    }

    // Validate total duration matches sum of clips
    if (totalClipDuration !== schema.durationInFrames) {
      errors.push(
        `Total clip duration (${totalClipDuration}) does not match composition duration (${schema.durationInFrames})`
      );
    }

    // Validate subtitles
    for (let i = 0; i < schema.subtitles.length; i++) {
      const subtitle = schema.subtitles[i];
      const prefix = `subtitles[${i}]`;

      if (!subtitle.id) {
        errors.push(`${prefix}.id is required`);
      }

      if (!subtitle.text || typeof subtitle.text !== 'string') {
        errors.push(`${prefix}.text must be a non-empty string`);
      }

      if (!Number.isInteger(subtitle.startFrame) || subtitle.startFrame < 0) {
        errors.push(`${prefix}.startFrame must be a non-negative integer, got ${subtitle.startFrame}`);
      }

      if (!Number.isInteger(subtitle.endFrame) || subtitle.endFrame <= subtitle.startFrame) {
        errors.push(`${prefix}.endFrame must be greater than startFrame, got ${subtitle.endFrame}`);
      }

      if (subtitle.endFrame > schema.durationInFrames) {
        errors.push(
          `${prefix}.endFrame (${subtitle.endFrame}) exceeds composition duration (${schema.durationInFrames})`
        );
      }
    }

    // Validate transitions
    if (!schema.transitions) {
      errors.push('Transitions configuration is required');
    } else {
      if (typeof schema.transitions.enabled !== 'boolean') {
        errors.push('transitions.enabled must be a boolean');
      }

      if (!['none', 'fade', 'crossfade'].includes(schema.transitions.type)) {
        errors.push(`transitions.type must be 'none', 'fade', or 'crossfade', got ${schema.transitions.type}`);
      }

      if (!Number.isInteger(schema.transitions.durationInFrames) || schema.transitions.durationInFrames < 0) {
        errors.push(
          `transitions.durationInFrames must be a non-negative integer, got ${schema.transitions.durationInFrames}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
