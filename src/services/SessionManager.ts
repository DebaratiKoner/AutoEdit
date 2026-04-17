/**
 * Session Manager Service
 * Handles browser storage operations for session persistence
 */

import type { SessionData } from '../types';

const DB_NAME = 'AutoEditDB';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const STORAGE_PREFIX = 'autoedit_session_';

/**
 * Session Manager for browser storage operations
 */
export class SessionManager {
  private db: IDBDatabase | null = null;
  private inMemoryStorage: Map<string, SessionData> = new Map();

  /**
   * Initialize IndexedDB connection
   */
  private async initDB(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
        }
      };
    });
  }

  /**
   * Save session data to browser storage
   * @param sessionId - Session identifier
   * @param data - Session data to save
   */
  async saveSession(sessionId: string, data: SessionData): Promise<void> {
    try {
      // Try IndexedDB first
      const db = await this.initDB();
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      await new Promise<void>((resolve, reject) => {
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('IndexedDB save failed, falling back to localStorage:', error);
      
      try {
        // Fallback to localStorage
        const key = `${STORAGE_PREFIX}${sessionId}`;
        localStorage.setItem(key, JSON.stringify(data));
      } catch (storageError) {
        console.warn('localStorage save failed, using in-memory storage:', storageError);
        // Final fallback to in-memory storage
        this.inMemoryStorage.set(sessionId, data);
      }
    }
  }

  /**
   * Load session data from browser storage
   * @param sessionId - Session identifier
   * @returns Session data or null if not found
   */
  async loadSession(sessionId: string): Promise<SessionData | null> {
    try {
      // Try IndexedDB first
      const db = await this.initDB();
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      
      const data = await new Promise<SessionData | null>((resolve, reject) => {
        const request = store.get(sessionId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      
      if (data) {
        return data;
      }
    } catch (error) {
      console.warn('IndexedDB load failed, trying localStorage:', error);
    }

    try {
      // Fallback to localStorage
      const key = `${STORAGE_PREFIX}${sessionId}`;
      const stored = localStorage.getItem(key);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.warn('localStorage load failed, checking in-memory storage:', error);
    }

    // Final fallback to in-memory storage
    return this.inMemoryStorage.get(sessionId) || null;
  }

  /**
   * Clear session data from browser storage
   * @param sessionId - Session identifier
   */
  async clearSession(sessionId: string): Promise<void> {
    try {
      // Clear from IndexedDB
      const db = await this.initDB();
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      await new Promise<void>((resolve, reject) => {
        const request = store.delete(sessionId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('IndexedDB clear failed:', error);
    }

    try {
      // Clear from localStorage
      const key = `${STORAGE_PREFIX}${sessionId}`;
      localStorage.removeItem(key);
    } catch (error) {
      console.warn('localStorage clear failed:', error);
    }

    // Clear from in-memory storage
    this.inMemoryStorage.delete(sessionId);
  }

  /**
   * List all stored session IDs
   * @returns Array of session IDs
   */
  async listSessions(): Promise<string[]> {
    const sessionIds = new Set<string>();

    try {
      // Get from IndexedDB
      const db = await this.initDB();
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      
      const keys = await new Promise<string[]>((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      });
      
      keys.forEach(key => sessionIds.add(key));
    } catch (error) {
      console.warn('IndexedDB list failed:', error);
    }

    try {
      // Get from localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(STORAGE_PREFIX)) {
          const sessionId = key.substring(STORAGE_PREFIX.length);
          sessionIds.add(sessionId);
        }
      }
    } catch (error) {
      console.warn('localStorage list failed:', error);
    }

    // Get from in-memory storage
    this.inMemoryStorage.forEach((_, sessionId) => {
      sessionIds.add(sessionId);
    });

    return Array.from(sessionIds);
  }
}
