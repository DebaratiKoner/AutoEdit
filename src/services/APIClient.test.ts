/**
 * APIClient Tests
 * Tests for API client service with HTTP request methods
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIClient, APIError, NetworkError } from './APIClient';
import type { UploadResponse, TranscriptResponse, ExportResponse, SessionResponse } from '../types';

describe('APIClient', () => {
  let apiClient: APIClient;

  beforeEach(() => {
    apiClient = new APIClient('/api', 3, 100);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('uploadVideo', () => {
    it('should upload video file successfully', async () => {
      const mockFile = new File(['video content'], 'test.mp4', { type: 'video/mp4' });
      const mockResponse: UploadResponse = {
        sessionId: 'session-123',
        videoUrl: 'https://example.com/video.mp4',
        duration: 120,
        resolution: { width: 1920, height: 1080 },
      };

      // Mock XMLHttpRequest
      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        upload: { addEventListener: vi.fn() },
        addEventListener: vi.fn(),
        status: 200,
        responseText: JSON.stringify(mockResponse),
      };

      const originalXHR = global.XMLHttpRequest;
      global.XMLHttpRequest = vi.fn(() => mockXHR) as any;

      const uploadPromise = apiClient.uploadVideo(mockFile);

      // Simulate successful upload
      const loadHandler = mockXHR.addEventListener.mock.calls.find(
        (call) => call[0] === 'load'
      )?.[1];
      loadHandler?.();

      const result = await uploadPromise;

      expect(result).toEqual(mockResponse);
      expect(mockXHR.open).toHaveBeenCalledWith('POST', '/api/videos/upload');
      expect(mockXHR.send).toHaveBeenCalled();

      global.XMLHttpRequest = originalXHR;
    });

    it('should track upload progress', async () => {
      const mockFile = new File(['video content'], 'test.mp4', { type: 'video/mp4' });
      const progressCallback = vi.fn();

      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        upload: { addEventListener: vi.fn() },
        addEventListener: vi.fn(),
        status: 200,
        responseText: JSON.stringify({ sessionId: 'test' }),
      };

      const originalXHR = global.XMLHttpRequest;
      global.XMLHttpRequest = vi.fn(() => mockXHR) as any;

      const uploadPromise = apiClient.uploadVideo(mockFile, progressCallback);

      // Simulate progress events
      const progressHandler = mockXHR.upload.addEventListener.mock.calls.find(
        (call) => call[0] === 'progress'
      )?.[1];

      progressHandler?.({ lengthComputable: true, loaded: 50, total: 100 });
      progressHandler?.({ lengthComputable: true, loaded: 100, total: 100 });

      // Complete upload
      const loadHandler = mockXHR.addEventListener.mock.calls.find(
        (call) => call[0] === 'load'
      )?.[1];
      loadHandler?.();

      await uploadPromise;

      expect(progressCallback).toHaveBeenCalledWith(50);
      expect(progressCallback).toHaveBeenCalledWith(100);

      global.XMLHttpRequest = originalXHR;
    });

    it('should handle upload errors', async () => {
      const mockFile = new File(['video content'], 'test.mp4', { type: 'video/mp4' });

      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        upload: { addEventListener: vi.fn() },
        addEventListener: vi.fn(),
        status: 400,
        responseText: 'Bad request',
      };

      const originalXHR = global.XMLHttpRequest;
      global.XMLHttpRequest = vi.fn(() => mockXHR) as any;

      const uploadPromise = apiClient.uploadVideo(mockFile);

      // Simulate error
      const loadHandler = mockXHR.addEventListener.mock.calls.find(
        (call) => call[0] === 'load'
      )?.[1];
      loadHandler?.();

      await expect(uploadPromise).rejects.toThrow(APIError);

      global.XMLHttpRequest = originalXHR;
    });

    it('should handle network errors', async () => {
      const mockFile = new File(['video content'], 'test.mp4', { type: 'video/mp4' });

      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        upload: { addEventListener: vi.fn() },
        addEventListener: vi.fn(),
      };

      const originalXHR = global.XMLHttpRequest;
      global.XMLHttpRequest = vi.fn(() => mockXHR) as any;

      const uploadPromise = apiClient.uploadVideo(mockFile);

      // Simulate network error
      const errorHandler = mockXHR.addEventListener.mock.calls.find(
        (call) => call[0] === 'error'
      )?.[1];
      errorHandler?.();

      await expect(uploadPromise).rejects.toThrow(NetworkError);

      global.XMLHttpRequest = originalXHR;
    });
  });

  describe('transcribeVideo', () => {
    it('should request transcription successfully', async () => {
      const mockResponse: TranscriptResponse = {
        transcript: 'Hello world',
        segments: [
          { start: 0, end: 2, text: 'Hello world' },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.transcribeVideo('session-123');

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/videos/session-123/transcribe',
        { method: 'POST' }
      );
    });

    it('should handle transcription errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Session not found',
      });

      await expect(apiClient.transcribeVideo('invalid-session')).rejects.toThrow(APIError);
    });
  });

  describe('exportVideo', () => {
    it('should export video successfully', async () => {
      const mockTimeline = [
        {
          id: '1',
          sourceStart: 0,
          sourceEnd: 10,
          timelineStart: 0,
          duration: 10,
          order: 0,
        },
      ];

      const mockResponse: ExportResponse = {
        downloadUrl: 'https://example.com/download/video.mp4',
        expiresAt: '2024-12-31T23:59:59Z',
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.exportVideo('session-123', mockTimeline);

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/videos/session-123/export',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeline: mockTimeline, format: 'mp4' }),
        }
      );
    });

    it('should support different export formats', async () => {
      const mockTimeline = [
        {
          id: '1',
          sourceStart: 0,
          sourceEnd: 10,
          timelineStart: 0,
          duration: 10,
          order: 0,
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ downloadUrl: 'test', expiresAt: 'test' }),
      });

      await apiClient.exportVideo('session-123', mockTimeline, 'webm');

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/videos/session-123/export',
        expect.objectContaining({
          body: JSON.stringify({ timeline: mockTimeline, format: 'webm' }),
        })
      );
    });
  });

  describe('getSession', () => {
    it('should retrieve session successfully', async () => {
      const mockResponse: SessionResponse = {
        sessionId: 'session-123',
        videoUrl: 'https://example.com/video.mp4',
        duration: 120,
        createdAt: '2024-01-01T00:00:00Z',
        lastModified: '2024-01-01T01:00:00Z',
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await apiClient.getSession('session-123');

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/sessions/session-123',
        { method: 'GET' }
      );
    });

    it('should handle session not found', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Session not found',
      });

      await expect(apiClient.getSession('invalid-session')).rejects.toThrow(APIError);
    });
  });

  describe('retry logic', () => {
    it('should retry on 5xx errors', async () => {
      let attemptCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          return {
            ok: false,
            status: 500,
            text: async () => 'Server error',
          };
        }
        return {
          ok: true,
          json: async () => ({ sessionId: 'test' }),
        };
      });

      const result = await apiClient.getSession('session-123');

      expect(attemptCount).toBe(3);
      expect(result).toEqual({ sessionId: 'test' });
    });

    it('should use exponential backoff between retries', async () => {
      vi.useFakeTimers();
      let attemptCount = 0;
      const attemptTimestamps: number[] = [];

      global.fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        attemptTimestamps.push(Date.now());
        
        if (attemptCount < 3) {
          return {
            ok: false,
            status: 503,
            text: async () => 'Service unavailable',
          };
        }
        return {
          ok: true,
          json: async () => ({ sessionId: 'test' }),
        };
      });

      const requestPromise = apiClient.getSession('session-123');

      // Fast-forward through retry delays
      // First attempt happens immediately
      await vi.advanceTimersByTimeAsync(0);
      
      // Second attempt after 100ms * 2^0 = 100ms (retryDelay * 2^(attempt-1))
      await vi.advanceTimersByTimeAsync(100);
      
      // Third attempt after 100ms * 2^1 = 200ms
      await vi.advanceTimersByTimeAsync(200);

      const result = await requestPromise;

      expect(attemptCount).toBe(3);
      expect(result).toEqual({ sessionId: 'test' });

      vi.useRealTimers();
    });

    it('should retry on different 5xx status codes', async () => {
      const statusCodes = [500, 502, 503, 504];
      
      for (const statusCode of statusCodes) {
        let attemptCount = 0;

        global.fetch = vi.fn().mockImplementation(async () => {
          attemptCount++;
          if (attemptCount < 2) {
            return {
              ok: false,
              status: statusCode,
              text: async () => `Server error ${statusCode}`,
            };
          }
          return {
            ok: true,
            json: async () => ({ sessionId: 'test' }),
          };
        });

        const result = await apiClient.getSession('session-123');
        
        expect(attemptCount).toBe(2);
        expect(result).toEqual({ sessionId: 'test' });
      }
    });

    it('should not retry on 4xx errors', async () => {
      let attemptCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        return {
          ok: false,
          status: 400,
          text: async () => 'Bad request',
        };
      });

      await expect(apiClient.getSession('session-123')).rejects.toThrow(APIError);
      expect(attemptCount).toBe(1);
    });

    it('should not retry on different 4xx status codes', async () => {
      const statusCodes = [400, 401, 403, 404, 413, 422];
      
      for (const statusCode of statusCodes) {
        let attemptCount = 0;

        global.fetch = vi.fn().mockImplementation(async () => {
          attemptCount++;
          return {
            ok: false,
            status: statusCode,
            text: async () => `Client error ${statusCode}`,
          };
        });

        await expect(apiClient.getSession('session-123')).rejects.toThrow(APIError);
        expect(attemptCount).toBe(1);
      }
    });

    it('should fail after max retries', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      });

      await expect(apiClient.getSession('session-123')).rejects.toThrow(APIError);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should not retry on network errors', async () => {
      let attemptCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        throw new Error('Network error');
      });

      await expect(apiClient.getSession('session-123')).rejects.toThrow(NetworkError);
      expect(attemptCount).toBe(1);
    });

    it('should respect custom maxRetries configuration', async () => {
      const customClient = new APIClient('/api', 5, 100);
      let attemptCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        return {
          ok: false,
          status: 500,
          text: async () => 'Server error',
        };
      });

      await expect(customClient.getSession('session-123')).rejects.toThrow(APIError);
      expect(attemptCount).toBe(5);
    });

    it('should apply exponential backoff correctly for multiple retries', async () => {
      vi.useFakeTimers();
      const customClient = new APIClient('/api', 4, 100);
      let attemptCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 4) {
          return {
            ok: false,
            status: 500,
            text: async () => 'Server error',
          };
        }
        return {
          ok: true,
          json: async () => ({ sessionId: 'test' }),
        };
      });

      const requestPromise = customClient.getSession('session-123');

      // First attempt
      await vi.advanceTimersByTimeAsync(0);
      
      // Second attempt: 100ms * 2^0 = 100ms
      await vi.advanceTimersByTimeAsync(100);
      
      // Third attempt: 100ms * 2^1 = 200ms
      await vi.advanceTimersByTimeAsync(200);
      
      // Fourth attempt: 100ms * 2^2 = 400ms
      await vi.advanceTimersByTimeAsync(400);

      const result = await requestPromise;

      expect(attemptCount).toBe(4);
      expect(result).toEqual({ sessionId: 'test' });

      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('should create APIError with correct properties', () => {
      const error = new APIError(404, 'Not found', 'Session not found');

      expect(error.name).toBe('APIError');
      expect(error.status).toBe(404);
      expect(error.message).toBe('Not found');
      expect(error.response).toBe('Session not found');
    });

    it('should create NetworkError with correct properties', () => {
      const cause = new Error('Connection refused');
      const error = new NetworkError('Connection failed', cause);

      expect(error.name).toBe('NetworkError');
      expect(error.message).toBe('Connection failed');
      expect(error.cause).toBe(cause);
    });

    it('should handle 400 Bad Request errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid request body',
      });

      try {
        await apiClient.getSession('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(400);
        expect((error as APIError).response).toBe('Invalid request body');
      }
    });

    it('should handle 401 Unauthorized errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized access',
      });

      try {
        await apiClient.transcribeVideo('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(401);
      }
    });

    it('should handle 403 Forbidden errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Access forbidden',
      });

      try {
        await apiClient.getSession('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(403);
      }
    });

    it('should handle 404 Not Found errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Resource not found',
      });

      try {
        await apiClient.getSession('nonexistent-session');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(404);
        expect((error as APIError).response).toBe('Resource not found');
      }
    });

    it('should handle 413 Payload Too Large errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        text: async () => 'File too large',
      });

      try {
        await apiClient.transcribeVideo('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(413);
      }
    });

    it('should handle 422 Unprocessable Entity errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => 'Validation failed',
      });

      try {
        await apiClient.exportVideo('session-123', []);
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(422);
      }
    });

    it('should handle 500 Internal Server Error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      try {
        await apiClient.getSession('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(500);
      }
    });

    it('should handle 502 Bad Gateway errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => 'Bad gateway',
      });

      try {
        await apiClient.getSession('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(502);
      }
    });

    it('should handle 503 Service Unavailable errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service temporarily unavailable',
      });

      try {
        await apiClient.transcribeVideo('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(503);
      }
    });

    it('should handle 504 Gateway Timeout errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 504,
        text: async () => 'Gateway timeout',
      });

      try {
        await apiClient.getSession('session-123');
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(504);
      }
    });

    it('should handle invalid JSON response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      try {
        await apiClient.getSession('session-123');
        expect.fail('Should have thrown NetworkError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toContain('Connection failed');
      }
    });

    it('should handle fetch network failures', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

      try {
        await apiClient.getSession('session-123');
        expect.fail('Should have thrown NetworkError');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toBe('Connection failed');
      }
    });

    it('should preserve error response text in APIError', async () => {
      const errorResponse = JSON.stringify({
        error: 'validation_failed',
        details: ['Field "timeline" is required'],
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => errorResponse,
      });

      try {
        await apiClient.exportVideo('session-123', []);
        expect.fail('Should have thrown APIError');
      } catch (error) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).response).toBe(errorResponse);
      }
    });
  });
});
