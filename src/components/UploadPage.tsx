/**
 * Upload Page Component
 * Handles video file selection and upload
 */

import { useState, useRef, DragEvent, ChangeEvent } from 'react';
import { FileValidator } from '../services';
import './UploadPage.css';

interface UploadPageProps {
  onUploadComplete?: (sessionId: string) => void;
}

export function UploadPage({ onUploadComplete }: UploadPageProps) {
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileValidator = new FileValidator();

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
  };

  const handleFile = async (file: File) => {
    setError(null);

    // Validate format
    const formatResult = fileValidator.validateFormat(file);
    if (!formatResult.valid) {
      setError(formatResult.error || 'Invalid file format');
      return;
    }

    // Validate resolution
    const resolutionResult = await fileValidator.validateResolution(file);
    if (!resolutionResult.valid) {
      setError(resolutionResult.error || 'Invalid resolution');
      return;
    }

    // Get video duration and metadata
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    const videoUrl = URL.createObjectURL(file);
    
    video.onloadedmetadata = async () => {
      const duration = video.duration;
      const { width, height } = resolutionResult.details?.resolution || { width: 1920, height: 1080 };
      
      // Store the actual file in IndexedDB
      try {
        const db = await openVideoDatabase();
        const transaction = db.transaction(['videos'], 'readwrite');
        const store = transaction.objectStore('videos');
        
        const sessionId = `session-${Date.now()}`;
        await store.put({ id: sessionId, file: file });
        
        URL.revokeObjectURL(videoUrl);
        
        if (onUploadComplete) {
          onUploadComplete(sessionId);
        }
      } catch (error) {
        console.error('Failed to store video:', error);
        setError('Failed to store video. Please try again.');
      }
    };
    
    video.onerror = () => {
      URL.revokeObjectURL(videoUrl);
      setError('Failed to load video metadata. Please try a different file.');
    };
    
    video.src = videoUrl;
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
    fileInputRef.current?.click();
  };

  return (
    <div className="upload-page">
      <header className="upload-header">
        <h1>AutoEdit</h1>
      </header>

      <main className="upload-main">
        <div
          className={`drop-zone ${dragActive ? 'drag-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleClick}
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
            <p className="drop-zone-text">Drop your video here</p>
            <p className="drop-zone-subtext">or click to browse</p>
            <p className="drop-zone-formats">Supported: MP4, MOV, WebM (720p minimum)</p>
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
