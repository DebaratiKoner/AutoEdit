/**
 * Property-based test generators using fast-check
 * These generators create valid test data for property tests
 */

import * as fc from 'fast-check';
import type { TimelineSegment, SessionData, EditAction } from '../types';

/**
 * Generates arbitrary TimelineSegment objects
 */
export function arbitraryTimelineSegment(): fc.Arbitrary<TimelineSegment> {
  return fc
    .record({
      id: fc.uuid(),
      sourceStart: fc.double({ min: 0, max: 3600, noNaN: true }),
      sourceEnd: fc.double({ min: 0, max: 3600, noNaN: true }),
      timelineStart: fc.double({ min: 0, max: 3600, noNaN: true }),
      order: fc.nat({ max: 1000 }),
    })
    .filter((seg) => seg.sourceEnd > seg.sourceStart)
    .map((seg) => ({
      ...seg,
      duration: seg.sourceEnd - seg.sourceStart,
    }));
}

/**
 * Generates arbitrary EditAction objects
 */
export function arbitraryEditAction(): fc.Arbitrary<EditAction> {
  return fc.oneof(
    fc.record({
      type: fc.constant('CUT' as const),
      segmentId: fc.uuid(),
      cutTime: fc.double({ min: 0, max: 3600, noNaN: true }),
      newSegmentId: fc.uuid(),
    }),
    fc.record({
      type: fc.constant('DELETE' as const),
      segment: arbitraryTimelineSegment(),
    }),
    fc.record({
      type: fc.constant('MOVE' as const),
      segmentId: fc.uuid(),
      oldOrder: fc.nat({ max: 1000 }),
      newOrder: fc.nat({ max: 1000 }),
    }),
    fc.record({
      type: fc.constant('TRANSCRIPT_EDIT' as const),
      oldText: fc.string(),
      newText: fc.string(),
    })
  );
}

/**
 * Generates arbitrary SessionData objects
 */
export function arbitrarySessionData(): fc.Arbitrary<SessionData> {
  return fc.record({
    sessionId: fc.uuid(),
    videoUrl: fc.webUrl(),
    duration: fc.double({ min: 1, max: 7200, noNaN: true }),
    resolution: fc.record({
      width: fc.integer({ min: 1280, max: 3840 }),
      height: fc.integer({ min: 720, max: 2160 }),
    }),
    timeline: fc.array(arbitraryTimelineSegment(), { minLength: 0, maxLength: 50 }),
    transcript: fc.option(fc.string(), { nil: null }),
    undoStack: fc.array(arbitraryEditAction(), { maxLength: 100 }),
    redoStack: fc.array(arbitraryEditAction(), { maxLength: 100 }),
    lastModified: fc
      .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
      .map((d) => d.getTime()),
  });
}
