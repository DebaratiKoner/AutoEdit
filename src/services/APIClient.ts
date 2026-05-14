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
          // Try to extract the FastAPI detail message
          let errorMessage = `Upload failed with status ${xhr.status}`;
          try {
            const errJson = JSON.parse(xhr.responseText);
            if (errJson.detail) {
              errorMessage = typeof errJson.detail === 'string'
                ? errJson.detail
                : JSON.stringify(errJson.detail);
            }
          } catch {
            if (xhr.responseText) errorMessage = xhr.responseText;
          }
          reject(new APIError(xhr.status, errorMessage, xhr.responseText));
        }
      });

      // Handle network errors
      xhr.addEventListener('error', () => {
        reject(new NetworkError('Cannot connect to server. Make sure the backend is running on port 8000.'));
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
   * @param clips - Optional: array of edited clips to transcribe (if omitted, transcribes full video)
   * @returns Promise resolving to transcript response
   */
  async getTranscriptionJobStatus(
    sessionId: string,
    jobId: string
  ): Promise<{
    jobId: string;
    status: string;
    transcript?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    error?: string;
  }> {
    return this.requestWithRetry(
      `${this.baseUrl}/videos/${sessionId}/transcribe/jobs/${jobId}`,
      {
        method: 'GET',
      }
    );
  }

  async transcribeVideo(
    sessionId: string
  ): Promise<TranscriptResponse> {


    type JobStatusResponse = {
      jobId: string;
      status: string;
      transcript?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
      error?: string;
    };

    const response = await this.requestWithRetry<TranscriptResponse | JobStatusResponse>(
      `${this.baseUrl}/videos/${sessionId}/transcribe`,
      {
        method: 'POST',
      }
    );

    if ('transcript' in response && response.transcript != null) {
      return response as TranscriptResponse;
    }

    if ('jobId' in response && response.status) {
      const start = Date.now();
      const timeoutMs = 600_000; // Allow 10 minutes max to poll job status
      const pollInterval = 1200;

      let job: JobStatusResponse = response;
      while (job.status === 'pending' || job.status === 'running') {
        if (Date.now() - start > timeoutMs) {
          throw new Error('Transcription timed out. Please try again later.');
        }

        await this.delay(pollInterval);
        job = await this.getTranscriptionJobStatus(sessionId, response.jobId);
      }

      if (job.status === 'failed') {
        throw new Error(job.error || 'Transcription failed');
      }

      if (!job.transcript) {
        throw new Error('Transcription finished without returning text');
      }

      return {
        transcript: job.transcript,
        segments: job.segments || [],
      };
    }

    throw new Error('Unexpected transcription response from server');
  }

  /**
   * Generate AI edit actions from a natural language prompt
   * @param sessionId - Session identifier
   * @param prompt - Natural language editing instruction
   * @param segments - Transcript segments with start/end/text
   * @returns Promise resolving to enhanced response with actions, clips, operations, and warnings
   */
  async editWithAI(
    sessionId: string,
    prompt: string,
    segments: Array<{ start: number; end: number; text: string; title?: string }>
  ): Promise<{ 
    actions: Array<Record<string, any>>;
    clips?: Array<Record<string, any>>;
    operations?: Array<Record<string, any>>;
    warnings?: string[];
  }> {
    return this.requestWithRetry(
      `${this.baseUrl}/videos/${sessionId}/edit-with-ai`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, segments }),
      }
    );
  }

  /**
   * NEW: Plan edit operations using structured planner
   * @param sessionId - Session identifier
   * @param instruction - Natural language editing instruction
   * @param clips - Array of clips with id, start, end, label
   * @param transcript - Optional transcript segments
   * @returns Promise resolving to { intent, operations, confidence, warnings }
   */
  async planEdit(
    sessionId: string,
    instruction: string,
    clips: Array<{ id: string; start: number; end: number; label?: string }>,
    transcript: Array<{ start: number; end: number; text: string }> = []
  ): Promise<{
    intent: string;
    operations: Array<Record<string, any>>;
    confidence: number;
    warnings: string[];
  }> {
    return this.requestWithRetry(
      `${this.baseUrl}/videos/${sessionId}/plan-edit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, clips, transcript }),
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
   * Export edited video as a ZIP containing main video, clips, and metadata
   * @param sessionId - Session identifier
   * @param timeline - Array of timeline segments
   * @param transcriptSegments - Array of transcript segments for metadata
   * @returns Promise resolving to a Blob (the ZIP file)
   */
  async exportZipVideo(
    sessionId: string,
    timeline: TimelineSegment[],
    transcriptSegments: any[] = []
  ): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/videos/${sessionId}/export-zip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timeline, transcriptSegments }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Export failed with status ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.detail) {
          errorMessage = typeof errorJson.detail === 'string'
            ? errorJson.detail
            : JSON.stringify(errorJson.detail);
        }
      } catch {
        if (errorText) errorMessage = errorText;
      }
      throw new APIError(response.status, errorMessage, errorText);
    }

    return await response.blob();
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
        // Try to extract the detail message from FastAPI's JSON error response
        let errorMessage = `Request failed with status ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.detail) {
            errorMessage = typeof errorJson.detail === 'string'
              ? errorJson.detail
              : JSON.stringify(errorJson.detail);
          }
        } catch {
          // Not JSON — use raw text if available
          if (errorText) errorMessage = errorText;
        }
        throw new APIError(response.status, errorMessage, errorText);
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
