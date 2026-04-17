/**
 * Tests for SessionManager service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { SessionManager } from './SessionManager';
import type { SessionData } from '../types';

describe('SessionManager', () => {
  let manager: SessionManager;
  let mockIndexedDB: any;

  beforeEach(() => {
    manager = new SessionManager();
    
    // Clear localStorage before each test
    localStorage.clear();
    
    // Setup IndexedDB mock
    setupIndexedDBMock();
  });

  afterEach(() => {
    // Clean up
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('saveSession', () => {
    it('should save session to IndexedDB', async () => {
      const sessionData = createMockSessionData('session-1');
      
      await manager.saveSession('session-1', sessionData);
      
      const loaded = await manager.loadSession('session-1');
      expect(loaded).toEqual(sessionData);
    });

    it('should fallback to localStorage when IndexedDB fails', async () => {
      // Force IndexedDB to fail
      mockIndexedDBFailure();
      
      const sessionData = createMockSessionData('session-2');
      
      await manager.saveSession('session-2', sessionData);
      
      // Should be in localStorage
      const key = 'autoedit_session_session-2';
      const stored = localStorage.getItem(key);
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored!)).toEqual(sessionData);
    });

    it('should update existing session', async () => {
      const sessionData1 = createMockSessionData('session-3');
      const sessionData2 = { ...sessionData1, lastModified: Date.now() + 1000 };
      
      await manager.saveSession('session-3', sessionData1);
      await manager.saveSession('session-3', sessionData2);
      
      const loaded = await manager.loadSession('session-3');
      expect(loaded).toEqual(sessionData2);
    });

    it('should handle multiple sessions', async () => {
      const session1 = createMockSessionData('session-a');
      const session2 = createMockSessionData('session-b');
      const session3 = createMockSessionData('session-c');
      
      await manager.saveSession('session-a', session1);
      await manager.saveSession('session-b', session2);
      await manager.saveSession('session-c', session3);
      
      expect(await manager.loadSession('session-a')).toEqual(session1);
      expect(await manager.loadSession('session-b')).toEqual(session2);
      expect(await manager.loadSession('session-c')).toEqual(session3);
    });
  });

  describe('loadSession', () => {
    it('should load session from IndexedDB', async () => {
      const sessionData = createMockSessionData('session-4');
      
      await manager.saveSession('session-4', sessionData);
      const loaded = await manager.loadSession('session-4');
      
      expect(loaded).toEqual(sessionData);
    });

    it('should return null for non-existent session', async () => {
      const loaded = await manager.loadSession('non-existent');
      expect(loaded).toBeNull();
    });

    it('should fallback to localStorage when IndexedDB fails', async () => {
      const sessionData = createMockSessionData('session-5');
      
      // Save to localStorage directly
      localStorage.setItem('autoedit_session_session-5', JSON.stringify(sessionData));
      
      // Force IndexedDB to fail
      mockIndexedDBFailure();
      
      const loaded = await manager.loadSession('session-5');
      expect(loaded).toEqual(sessionData);
    });

    it('should load from IndexedDB first before localStorage', async () => {
      const sessionDataIDB = createMockSessionData('session-6');
      const sessionDataLS = { ...sessionDataIDB, lastModified: Date.now() - 1000 };
      
      // Save different data to both storages
      await manager.saveSession('session-6', sessionDataIDB);
      localStorage.setItem('autoedit_session_session-6', JSON.stringify(sessionDataLS));
      
      const loaded = await manager.loadSession('session-6');
      // Should load from IndexedDB (newer data)
      expect(loaded).toEqual(sessionDataIDB);
    });

    it('should handle corrupted localStorage data', async () => {
      // Save corrupted JSON
      localStorage.setItem('autoedit_session_session-7', 'invalid json {');
      
      const loaded = await manager.loadSession('session-7');
      expect(loaded).toBeNull();
    });
  });

  describe('clearSession', () => {
    it('should clear session from IndexedDB', async () => {
      const sessionData = createMockSessionData('session-8');
      
      await manager.saveSession('session-8', sessionData);
      await manager.clearSession('session-8');
      
      const loaded = await manager.loadSession('session-8');
      expect(loaded).toBeNull();
    });

    it('should clear session from localStorage', async () => {
      const sessionData = createMockSessionData('session-9');
      
      // Save to localStorage
      localStorage.setItem('autoedit_session_session-9', JSON.stringify(sessionData));
      
      await manager.clearSession('session-9');
      
      const key = 'autoedit_session_session-9';
      expect(localStorage.getItem(key)).toBeNull();
    });

    it('should clear from both storages', async () => {
      const sessionData = createMockSessionData('session-10');
      
      await manager.saveSession('session-10', sessionData);
      localStorage.setItem('autoedit_session_session-10', JSON.stringify(sessionData));
      
      await manager.clearSession('session-10');
      
      expect(await manager.loadSession('session-10')).toBeNull();
      expect(localStorage.getItem('autoedit_session_session-10')).toBeNull();
    });

    it('should not throw when clearing non-existent session', async () => {
      await expect(manager.clearSession('non-existent')).resolves.not.toThrow();
    });
  });

  describe('listSessions', () => {
    it('should list sessions from IndexedDB', async () => {
      const session1 = createMockSessionData('list-1');
      const session2 = createMockSessionData('list-2');
      
      await manager.saveSession('list-1', session1);
      await manager.saveSession('list-2', session2);
      
      const sessions = await manager.listSessions();
      expect(sessions).toContain('list-1');
      expect(sessions).toContain('list-2');
    });

    it('should list sessions from localStorage', async () => {
      const session1 = createMockSessionData('ls-1');
      const session2 = createMockSessionData('ls-2');
      
      localStorage.setItem('autoedit_session_ls-1', JSON.stringify(session1));
      localStorage.setItem('autoedit_session_ls-2', JSON.stringify(session2));
      
      // Force IndexedDB to fail
      mockIndexedDBFailure();
      
      const sessions = await manager.listSessions();
      expect(sessions).toContain('ls-1');
      expect(sessions).toContain('ls-2');
    });

    it('should combine sessions from both storages without duplicates', async () => {
      const session1 = createMockSessionData('both-1');
      const session2 = createMockSessionData('both-2');
      
      // Save to IndexedDB
      await manager.saveSession('both-1', session1);
      
      // Save to localStorage (including duplicate)
      localStorage.setItem('autoedit_session_both-1', JSON.stringify(session1));
      localStorage.setItem('autoedit_session_both-2', JSON.stringify(session2));
      
      const sessions = await manager.listSessions();
      expect(sessions).toContain('both-1');
      expect(sessions).toContain('both-2');
      // Should not have duplicates
      expect(sessions.filter(id => id === 'both-1').length).toBe(1);
    });

    it('should return empty array when no sessions exist', async () => {
      const sessions = await manager.listSessions();
      expect(sessions).toEqual([]);
    });

    it('should not list non-session localStorage items', async () => {
      localStorage.setItem('other_key', 'value');
      localStorage.setItem('autoedit_session_valid', JSON.stringify(createMockSessionData('valid')));
      
      const sessions = await manager.listSessions();
      expect(sessions).toEqual(['valid']);
    });
  });

  describe('Edge Cases', () => {
    it('should handle session with empty timeline', async () => {
      const sessionData = createMockSessionData('empty-timeline');
      sessionData.timeline = [];
      
      await manager.saveSession('empty-timeline', sessionData);
      const loaded = await manager.loadSession('empty-timeline');
      
      expect(loaded).toEqual(sessionData);
      expect(loaded?.timeline).toEqual([]);
    });

    it('should handle session with null transcript', async () => {
      const sessionData = createMockSessionData('null-transcript');
      sessionData.transcript = null;
      
      await manager.saveSession('null-transcript', sessionData);
      const loaded = await manager.loadSession('null-transcript');
      
      expect(loaded).toEqual(sessionData);
      expect(loaded?.transcript).toBeNull();
    });

    it('should handle session with empty undo/redo stacks', async () => {
      const sessionData = createMockSessionData('empty-stacks');
      sessionData.undoStack = [];
      sessionData.redoStack = [];
      
      await manager.saveSession('empty-stacks', sessionData);
      const loaded = await manager.loadSession('empty-stacks');
      
      expect(loaded).toEqual(sessionData);
      expect(loaded?.undoStack).toEqual([]);
      expect(loaded?.redoStack).toEqual([]);
    });

    it('should handle session with large timeline', async () => {
      const sessionData = createMockSessionData('large-timeline');
      sessionData.timeline = Array.from({ length: 500 }, (_, i) => ({
        id: `segment-${i}`,
        sourceStart: i * 10,
        sourceEnd: (i + 1) * 10,
        timelineStart: i * 10,
        duration: 10,
        order: i,
      }));
      
      await manager.saveSession('large-timeline', sessionData);
      const loaded = await manager.loadSession('large-timeline');
      
      expect(loaded).toEqual(sessionData);
      expect(loaded?.timeline.length).toBe(500);
    });

    it('should handle special characters in session ID', async () => {
      const sessionId = 'session-with-special_chars.123';
      const sessionData = createMockSessionData(sessionId);
      
      await manager.saveSession(sessionId, sessionData);
      const loaded = await manager.loadSession(sessionId);
      
      expect(loaded).toEqual(sessionData);
    });

    it('should handle very long session ID', async () => {
      const sessionId = 'a'.repeat(200);
      const sessionData = createMockSessionData(sessionId);
      
      await manager.saveSession(sessionId, sessionData);
      const loaded = await manager.loadSession(sessionId);
      
      expect(loaded).toEqual(sessionData);
    });
  });

  describe('Property-Based Tests', () => {
    /**
     * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6**
     * 
     * Property 9: Session persistence round-trip
     * For any valid SessionData object, saving it to Browser_Storage and then
     * loading it SHALL produce a SessionData object that is deeply equal to
     * the original (all fields match, including nested timeline segments and
     * action stacks).
     */
    it('Property 9: should preserve session data through save/load cycle', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitrarySessionData(),
          async (sessionData) => {
            await manager.saveSession(sessionData.sessionId, sessionData);
            const loaded = await manager.loadSession(sessionData.sessionId);
            
            expect(loaded).toEqual(sessionData);
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Clear operation removes session
     * For any session ID, after clearing, loading that session SHALL return null.
     */
    it('Property: should remove session after clear', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitrarySessionData(),
          async (sessionData) => {
            await manager.saveSession(sessionData.sessionId, sessionData);
            await manager.clearSession(sessionData.sessionId);
            const loaded = await manager.loadSession(sessionData.sessionId);
            
            expect(loaded).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: List includes all saved sessions
     * For any set of sessions, after saving them, listSessions SHALL include
     * all their session IDs.
     */
    it('Property: should list all saved sessions', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitrarySessionData(), { minLength: 1, maxLength: 10 }),
          async (sessions) => {
            // Ensure unique session IDs
            const uniqueSessions = sessions.filter((session, index, self) =>
              index === self.findIndex(s => s.sessionId === session.sessionId)
            );
            
            // Save all sessions
            for (const session of uniqueSessions) {
              await manager.saveSession(session.sessionId, session);
            }
            
            const listed = await manager.listSessions();
            
            // All saved session IDs should be in the list
            for (const session of uniqueSessions) {
              expect(listed).toContain(session.sessionId);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * Property: Update preserves session ID
     * For any session, updating it with new data SHALL preserve the session ID.
     */
    it('Property: should preserve session ID on update', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitrarySessionData(),
          arbitrarySessionData(),
          async (session1, session2) => {
            const sessionId = session1.sessionId;
            const updatedSession = { ...session2, sessionId };
            
            await manager.saveSession(sessionId, session1);
            await manager.saveSession(sessionId, updatedSession);
            
            const loaded = await manager.loadSession(sessionId);
            expect(loaded?.sessionId).toBe(sessionId);
            expect(loaded).toEqual(updatedSession);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

/**
 * Helper function to create mock session data
 */
function createMockSessionData(sessionId: string): SessionData {
  return {
    sessionId,
    videoUrl: 'blob:mock-video-url',
    duration: 120,
    resolution: { width: 1920, height: 1080 },
    timeline: [
      {
        id: 'segment-1',
        sourceStart: 0,
        sourceEnd: 30,
        timelineStart: 0,
        duration: 30,
        order: 0,
      },
      {
        id: 'segment-2',
        sourceStart: 40,
        sourceEnd: 70,
        timelineStart: 30,
        duration: 30,
        order: 1,
      },
    ],
    transcript: 'This is a test transcript',
    undoStack: [],
    redoStack: [],
    lastModified: Date.now(),
  };
}

/**
 * Setup IndexedDB mock for testing
 */
function setupIndexedDBMock() {
  const stores = new Map<string, Map<string, any>>();
  
  // @ts-expect-error - Mock implementation
  global.indexedDB = {
    open: (name: string, version: number) => {
      const request: any = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        result: null,
      };

      setTimeout(() => {
        if (!stores.has(name)) {
          stores.set(name, new Map());
          
          if (request.onupgradeneeded) {
            const event = {
              target: {
                result: {
                  objectStoreNames: {
                    contains: () => false,
                  },
                  createObjectStore: (storeName: string) => {
                    return {};
                  },
                },
              },
            };
            request.onupgradeneeded(event);
          }
        }

        const store = stores.get(name)!;
        
        request.result = {
          transaction: (storeNames: string[], mode: string) => {
            return {
              objectStore: (storeName: string) => {
                return {
                  put: (data: any) => {
                    const putRequest: any = {
                      onsuccess: null,
                      onerror: null,
                    };
                    setTimeout(() => {
                      store.set(data.sessionId, data);
                      if (putRequest.onsuccess) putRequest.onsuccess();
                    }, 0);
                    return putRequest;
                  },
                  get: (key: string) => {
                    const getRequest: any = {
                      onsuccess: null,
                      onerror: null,
                      result: null,
                    };
                    setTimeout(() => {
                      getRequest.result = store.get(key);
                      if (getRequest.onsuccess) getRequest.onsuccess();
                    }, 0);
                    return getRequest;
                  },
                  delete: (key: string) => {
                    const deleteRequest: any = {
                      onsuccess: null,
                      onerror: null,
                    };
                    setTimeout(() => {
                      store.delete(key);
                      if (deleteRequest.onsuccess) deleteRequest.onsuccess();
                    }, 0);
                    return deleteRequest;
                  },
                  getAllKeys: () => {
                    const getAllKeysRequest: any = {
                      onsuccess: null,
                      onerror: null,
                      result: null,
                    };
                    setTimeout(() => {
                      getAllKeysRequest.result = Array.from(store.keys());
                      if (getAllKeysRequest.onsuccess) getAllKeysRequest.onsuccess();
                    }, 0);
                    return getAllKeysRequest;
                  },
                };
              },
            };
          },
        };

        if (request.onsuccess) {
          request.onsuccess();
        }
      }, 0);

      return request;
    },
  };
}

/**
 * Mock IndexedDB to fail
 */
function mockIndexedDBFailure() {
  // @ts-expect-error - Mock implementation
  global.indexedDB = {
    open: () => {
      const request: any = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      setTimeout(() => {
        if (request.onerror) {
          request.onerror();
        }
      }, 0);
      return request;
    },
  };
}

/**
 * Arbitrary SessionData generator for property-based testing
 */
function arbitrarySessionData(): fc.Arbitrary<SessionData> {
  return fc.record({
    sessionId: fc.uuid(),
    videoUrl: fc.webUrl(),
    duration: fc.double({ min: 1, max: 7200, noNaN: true }),
    resolution: fc.record({
      width: fc.integer({ min: 1280, max: 3840 }),
      height: fc.integer({ min: 720, max: 2160 }),
    }),
    timeline: fc.array(
      fc.record({
        id: fc.uuid(),
        sourceStart: fc.double({ min: 0, max: 3600, noNaN: true }),
        sourceEnd: fc.double({ min: 0, max: 3600, noNaN: true }),
        timelineStart: fc.double({ min: 0, max: 3600, noNaN: true }),
        duration: fc.double({ min: 0.1, max: 3600, noNaN: true }),
        order: fc.nat({ max: 1000 }),
      }),
      { maxLength: 50 }
    ),
    transcript: fc.option(fc.string(), { nil: null }),
    undoStack: fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant('CUT' as const),
          segmentId: fc.uuid(),
          cutTime: fc.double({ min: 0, max: 3600, noNaN: true }),
          newSegmentId: fc.uuid(),
        }),
        fc.record({
          type: fc.constant('DELETE' as const),
          segment: fc.record({
            id: fc.uuid(),
            sourceStart: fc.double({ min: 0, max: 3600, noNaN: true }),
            sourceEnd: fc.double({ min: 0, max: 3600, noNaN: true }),
            timelineStart: fc.double({ min: 0, max: 3600, noNaN: true }),
            duration: fc.double({ min: 0.1, max: 3600, noNaN: true }),
            order: fc.nat({ max: 1000 }),
          }),
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
      ),
      { maxLength: 100 }
    ),
    redoStack: fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant('CUT' as const),
          segmentId: fc.uuid(),
          cutTime: fc.double({ min: 0, max: 3600, noNaN: true }),
          newSegmentId: fc.uuid(),
        }),
        fc.record({
          type: fc.constant('DELETE' as const),
          segment: fc.record({
            id: fc.uuid(),
            sourceStart: fc.double({ min: 0, max: 3600, noNaN: true }),
            sourceEnd: fc.double({ min: 0, max: 3600, noNaN: true }),
            timelineStart: fc.double({ min: 0, max: 3600, noNaN: true }),
            duration: fc.double({ min: 0.1, max: 3600, noNaN: true }),
            order: fc.nat({ max: 1000 }),
          }),
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
      ),
      { maxLength: 100 }
    ),
    lastModified: fc.date().map(d => d.getTime()),
  });
}
