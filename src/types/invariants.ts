/**
 * Type invariants and validation functions
 * These functions ensure data integrity for core types
 */

import type { TimelineSegment, SessionData } from './index';

/**
 * Validates TimelineSegment invariants
 * 
 * Invariants:
 * - duration = sourceEnd - sourceStart
 * - duration > 0
 * - sourceStart >= 0
 * - sourceEnd <= video.duration (checked at runtime)
 * - order >= 0
 */
export function isValidTimelineSegment(
  segment: TimelineSegment,
  videoDuration?: number
): boolean {
  // Check duration calculation
  const calculatedDuration = segment.sourceEnd - segment.sourceStart;
  if (Math.abs(segment.duration - calculatedDuration) > 0.001) {
    return false;
  }

  // Check positive duration
  if (segment.duration <= 0) {
    return false;
  }

  // Check non-negative start
  if (segment.sourceStart < 0) {
    return false;
  }

  // Check order is non-negative
  if (segment.order < 0) {
    return false;
  }

  // Check against video duration if provided
  if (videoDuration !== undefined && segment.sourceEnd > videoDuration) {
    return false;
  }

  return true;
}

/**
 * Validates that no two segments have the same order value
 */
export function hasUniqueOrders(segments: TimelineSegment[]): boolean {
  const orders = segments.map((s) => s.order);
  const uniqueOrders = new Set(orders);
  return orders.length === uniqueOrders.size;
}

/**
 * Validates SessionData invariants
 */
export function isValidSessionData(session: SessionData): boolean {
  // Check required fields
  if (!session.sessionId || !session.videoUrl) {
    return false;
  }

  // Check positive duration
  if (session.duration <= 0) {
    return false;
  }

  // Check valid resolution
  if (session.resolution.width < 1 || session.resolution.height < 1) {
    return false;
  }

  // Check minimum resolution (720p)
  if (session.resolution.height < 720) {
    return false;
  }

  // Check all timeline segments are valid
  for (const segment of session.timeline) {
    if (!isValidTimelineSegment(segment, session.duration)) {
      return false;
    }
  }

  // Check unique orders
  if (!hasUniqueOrders(session.timeline)) {
    return false;
  }

  // Check timestamp is valid
  if (session.lastModified <= 0) {
    return false;
  }

  return true;
}
