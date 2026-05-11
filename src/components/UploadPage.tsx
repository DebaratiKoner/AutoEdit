/**
 * Upload Page Component
 * Handles video file selection and upload
 */

import { useState, useRef, DragEvent, ChangeEvent } from 'react';
import { FileValidator, APIClient } from '../services';
import { logger } from '../utils';
import './UploadPage.css';

interface UploadPageProps {
  onUploadComplete?: (sessionId: string) => void;
}

export function UploadPage({ onUploadComplete }: UploadPageProps) {
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileValidator = new FileValidator();
  const apiClient = new APIClient();

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      await handleFile(files[0]);
    }
  };

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await handleFile(files[0]);
    }
    // Reset input so the same file can be re-selected if needed
    e.target.value = '';
  };

  const handleFile = async (file: File) => {
    if (isUploading) return; // lock — prevent duplicate calls
    setError(null);

    if (!file) {
      setError('No file selected.');
      return;
    }

    // Validate format
    const formatResult = fileValidator.validateFormat(file);
    if (!formatResult.valid) {
      setError(formatResult.error || 'Invalid file format');
      return;
    }

    try {
      setIsUploading(true);
      // 1. Upload file to backend — backend assigns the session ID
      const uploadResponse = await apiClient.uploadVideo(file);
      const sessionId = uploadResponse.sessionId;

      // 2. Also cache in IndexedDB for local playback (non-fatal)
      try {
        const db = await openVideoDatabase();
        const transaction = db.transaction(['videos'], 'readwrite');
        const store = transaction.objectStore('videos');
        await store.put({ id: sessionId, file: file });
      } catch (dbError) {
        logger.warn('IndexedDB cache failed (non-fatal):', dbError);
      }

      if (onUploadComplete) {
        onUploadComplete(sessionId);
      }
    } catch (error: unknown) {
      logger.error('Failed to upload video:', error);
      if (error && typeof error === 'object' && 'message' in error) {
        const msg = (error as { message: string }).message;
        if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('connection') || msg.toLowerCase().includes('fetch')) {
          setError('Cannot connect to server. Make sure the backend is running on port 8000.');
        } else {
          setError(`Upload failed: ${msg}`);
        }
      } else {
        setError('Failed to upload video. Make sure the backend server is running on port 8000.');
      }
    } finally {
      setIsUploading(false);
    }
  };

  // Helper function to open IndexedDB for video storage
  const openVideoDatabase = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('VideoEditorDB', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos', { keyPath: 'id' });
        }
      };
    });
  };

  const handleClick = () => {
    if (isUploading) return;
    fileInputRef.current?.click();
  };

  return (
    <div className="upload-page">
      <header className="upload-header">
        <h1>AutoEdit</h1>
      </header>

      <main className="upload-main">
        <div
          className={`drop-zone ${dragActive ? 'drag-active' : ''} ${isUploading ? 'uploading' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleClick}
          style={{ pointerEvents: isUploading ? 'none' : 'auto', opacity: isUploading ? 0.6 : 1 }}
        >
          <div className="drop-zone-content">
            <svg
              className="upload-icon"
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="drop-zone-text">{isUploading ? 'Uploading...' : 'Drop your video here'}</p>
            <p className="drop-zone-subtext">{isUploading ? 'Please wait' : 'or click to browse'}</p>
            <p className="drop-zone-formats">Supported: MP4, MOV, WebM</p>
          </div>
        </div>

        {error && (
          <div className="error-message">
            <svg
              className="error-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </main>
    </div>
  );
}
