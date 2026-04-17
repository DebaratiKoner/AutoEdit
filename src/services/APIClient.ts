/**
 * API Client Service
 * Handles HTTP communication with the FastAPI backend
 */

import type {
  UploadResponse,
  TranscriptResponse,
  ExportResponse,
  SessionResponse,
  TimelineSegment,
} from '../types';

/**
 * Custom error class for API errors
 */
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
    public response?: string
  ) {
    super(message);
    this.name = 'APIError';
  }
}

/**
 * Custom error class for network errors
 */
export class NetworkError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * API Client for backend communication
 */
export class APIClient {
  private baseUrl: string;
  private maxRetries: number;
  private retryDelay: number;

  constructor(
    baseUrl: string = '/api',
    maxRetries: number = 3,
    retryDelay: number = 1000
  ) {
    this.baseUrl = baseUrl;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  /**
   * Upload video file with progress tracking
   * @param file - Video file to upload
   * @param onProgress - Callback for upload progress updates (0-100)
   * @returns Promise resolving to upload response with session data
   */
  async uploadVideo(
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', file);

      // Track upload progress
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          const progress = Math.round((event.loaded / event.total) * 100);
          onProgress(progress);
        }
      });

      // Handle completion
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            resolve(response);
          } catch (error) {
            reject(new NetworkError('Invalid JSON response', error));
          }
        } else {
          reject(
            new APIError(
              xhr.status,
              `Upload failed with status ${xhr.status}`,
              xhr.responseText
            )
          );
        }
      });

      // Handle network errors
      xhr.addEventListener('error', () => {
        reject(new NetworkError('Network error during upload'));
      });

      // Handle abort
      xhr.addEventListener('abort', () => {
        reject(new NetworkError('Upload cancelled'));
      });

      xhr.open('POST', `${this.baseUrl}/videos/upload`);
      xhr.send(formData);
    });
  }

  /**
   * Request video transcription
   * @param sessionId - Session identifier
   * @returns Promise resolving to transcript response
   */
  async transcribeVideo(sessionId: string): Promise<TranscriptResponse> {
    return this.requestWithRetry<TranscriptResponse>(
      `${this.baseUrl}/videos/${sessionId}/transcribe`,
      {
        method: 'POST',
      }
    );
  }

  /**
   * Export edited video
   * @param sessionId - Session identifier
   * @param timeline - Array of timeline segments
   * @param format - Output video format
   * @returns Promise resolving to export response with download URL
   */
  async exportVideo(
    sessionId: string,
    timeline: TimelineSegment[],
    format: 'mp4' | 'mov' | 'webm' = 'mp4'
  ): Promise<ExportResponse> {
    return this.requestWithRetry<ExportResponse>(
      `${this.baseUrl}/videos/${sessionId}/export`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ timeline, format }),
      }
    );
  }

  /**
   * Retrieve session data
   * @param sessionId - Session identifier
   * @returns Promise resolving to session response
   */
  async getSession(sessionId: string): Promise<SessionResponse> {
    return this.requestWithRetry<SessionResponse>(
      `${this.baseUrl}/sessions/${sessionId}`,
      {
        method: 'GET',
      }
    );
  }

  /**
   * Make HTTP request with retry logic for 5xx errors
   * @param url - Request URL
   * @param options - Fetch options
   * @returns Promise resolving to typed response
   */
  private async requestWithRetry<T>(
    url: string,
    options: RequestInit
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.request<T>(url, options);
      } catch (error) {
        lastError = error as Error;

        // Only retry on 5xx server errors
        if (error instanceof APIError && error.status >= 500) {
          if (attempt < this.maxRetries) {
            // Exponential backoff
            const delay = this.retryDelay * Math.pow(2, attempt - 1);
            await this.delay(delay);
            continue;
          }
        }

        // Don't retry client errors (4xx) or network errors
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Make HTTP request
   * @param url - Request URL
   * @param options - Fetch options
   * @returns Promise resolving to typed response
   */
  private async request<T>(url: string, options: RequestInit): Promise<T> {
    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(
          response.status,
          `Request failed with status ${response.status}`,
          errorText
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }
      throw new NetworkError('Connection failed', error);
    }
  }

  /**
   * Delay execution for specified milliseconds
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
