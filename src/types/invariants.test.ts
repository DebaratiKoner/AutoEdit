import { describe, it, expect } from 'vitest';
import { isValidTimelineSegment, hasUniqueOrders, isValidSessionData } from './invariants';
import type { TimelineSegment, SessionData } from './index';

describe('TimelineSegment invariants', () => {
  it('should validate a correct segment', () => {
    const segment: TimelineSegment = {
      id: 'test-1',
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      duration: 10,
      order: 0,
    };

    expect(isValidTimelineSegment(segment)).toBe(true);
  });

  it('should reject segment with incorrect duration calculation', () => {
    const segment: TimelineSegment = {
      id: 'test-1',
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      duration: 5, // Wrong! Should be 10
      order: 0,
    };

    expect(isValidTimelineSegment(segment)).toBe(false);
  });

  it('should reject segment with negative duration', () => {
    const segment: TimelineSegment = {
      id: 'test-1',
      sourceStart: 10,
      sourceEnd: 5,
      timelineStart: 0,
      duration: -5,
      order: 0,
    };

    expect(isValidTimelineSegment(segment)).toBe(false);
  });

  it('should reject segment with negative sourceStart', () => {
    const segment: TimelineSegment = {
      id: 'test-1',
      sourceStart: -5,
      sourceEnd: 5,
      timelineStart: 0,
      duration: 10,
      order: 0,
    };

    expect(isValidTimelineSegment(segment)).toBe(false);
  });

  it('should reject segment exceeding video duration', () => {
    const segment: TimelineSegment = {
      id: 'test-1',
      sourceStart: 0,
      sourceEnd: 150,
      timelineStart: 0,
      duration: 150,
      order: 0,
    };

    expect(isValidTimelineSegment(segment, 100)).toBe(false);
  });

  it('should reject segment with negative order', () => {
    const segment: TimelineSegment = {
      id: 'test-1',
      sourceStart: 0,
      sourceEnd: 10,
      timelineStart: 0,
      duration: 10,
      order: -1,
    };

    expect(isValidTimelineSegment(segment)).toBe(false);
  });
});

describe('Unique orders validation', () => {
  it('should validate segments with unique orders', () => {
    const segments: TimelineSegment[] = [
      { id: '1', sourceStart: 0, sourceEnd: 10, timelineStart: 0, duration: 10, order: 0 },
      { id: '2', sourceStart: 10, sourceEnd: 20, timelineStart: 10, duration: 10, order: 1 },
      { id: '3', sourceStart: 20, sourceEnd: 30, timelineStart: 20, duration: 10, order: 2 },
    ];

    expect(hasUniqueOrders(segments)).toBe(true);
  });

  it('should reject segments with duplicate orders', () => {
    const segments: TimelineSegment[] = [
      { id: '1', sourceStart: 0, sourceEnd: 10, timelineStart: 0, duration: 10, order: 0 },
      { id: '2', sourceStart: 10, sourceEnd: 20, timelineStart: 10, duration: 10, order: 1 },
      { id: '3', sourceStart: 20, sourceEnd: 30, timelineStart: 20, duration: 10, order: 1 }, // Duplicate!
    ];

    expect(hasUniqueOrders(segments)).toBe(false);
  });

  it('should handle empty array', () => {
    expect(hasUniqueOrders([])).toBe(true);
  });
});

describe('SessionData invariants', () => {
  it('should validate correct session data', () => {
    const session: SessionData = {
      sessionId: 'session-123',
      videoUrl: 'https://example.com/video.mp4',
      duration: 120,
      resolution: { width: 1920, height: 1080 },
      timeline: [
        { id: '1', sourceStart: 0, sourceEnd: 10, timelineStart: 0, duration: 10, order: 0 },
      ],
      transcript: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };

    expect(isValidSessionData(session)).toBe(true);
  });

  it('should reject session with missing sessionId', () => {
    const session: SessionData = {
      sessionId: '',
      videoUrl: 'https://example.com/video.mp4',
      duration: 120,
      resolution: { width: 1920, height: 1080 },
      timeline: [],
      transcript: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };

    expect(isValidSessionData(session)).toBe(false);
  });

  it('should reject session with resolution below 720p', () => {
    const session: SessionData = {
      sessionId: 'session-123',
      videoUrl: 'https://example.com/video.mp4',
      duration: 120,
      resolution: { width: 640, height: 480 }, // Below 720p
      timeline: [],
      transcript: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };

    expect(isValidSessionData(session)).toBe(false);
  });

  it('should reject session with invalid timeline segment', () => {
    const session: SessionData = {
      sessionId: 'session-123',
      videoUrl: 'https://example.com/video.mp4',
      duration: 120,
      resolution: { width: 1920, height: 1080 },
      timeline: [
        { id: '1', sourceStart: 0, sourceEnd: 10, timelineStart: 0, duration: 5, order: 0 }, // Invalid duration
      ],
      transcript: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };

    expect(isValidSessionData(session)).toBe(false);
  });

  it('should reject session with duplicate segment orders', () => {
    const session: SessionData = {
      sessionId: 'session-123',
      videoUrl: 'https://example.com/video.mp4',
      duration: 120,
      resolution: { width: 1920, height: 1080 },
      timeline: [
        { id: '1', sourceStart: 0, sourceEnd: 10, timelineStart: 0, duration: 10, order: 0 },
        { id: '2', sourceStart: 10, sourceEnd: 20, timelineStart: 10, duration: 10, order: 0 }, // Duplicate order
      ],
      transcript: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };

    expect(isValidSessionData(session)).toBe(false);
  });
});
