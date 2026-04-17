import { describe, it, expect } from 'vitest';
import type { TimelineSegment, SessionData, ValidationResult } from './index';

describe('Type definitions', () => {
  it('should create a valid TimelineSegment', () => {
    const segment: TimelineSegment = {
      id: 'test-id',
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      duration: 10,
      order: 0,
    };

    expect(segment.id).toBe('test-id');
    expect(segment.duration).toBe(10);
  });

  it('should create a valid SessionData', () => {
    const session: SessionData = {
      sessionId: 'session-123',
      videoUrl: 'https://example.com/video.mp4',
      duration: 120,
      resolution: { width: 1920, height: 1080 },
      timeline: [],
      transcript: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };

    expect(session.sessionId).toBe('session-123');
    expect(session.resolution.width).toBe(1920);
  });

  it('should create a valid ValidationResult', () => {
    const result: ValidationResult = {
      valid: true,
      details: {
        format: 'mp4',
        resolution: { width: 1920, height: 1080 },
        duration: 120,
      },
    };

    expect(result.valid).toBe(true);
    expect(result.details?.format).toBe('mp4');
  });

  it('should create an invalid ValidationResult with error', () => {
    const result: ValidationResult = {
      valid: false,
      error: 'Invalid file format',
    };

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid file format');
  });
});
