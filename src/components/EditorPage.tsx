/**
 * Editor Page Component
 * Main editing interface with video player, timeline, and controls
 */

import { useState, useEffect, useRef } from 'react';
import { SessionManager, APIClient } from '../services';
import { formatTime } from '../utils';
import type { SessionData, TimelineSegment } from '../types';
import './EditorPage.css';

interface EditorPageProps {
  sessionId: string;
  onReset?: () => void;
}

export function EditorPage({ sessionId, onReset }: EditorPageProps) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<'clips' | 'ai-edit' | 'assets'>('clips');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [seekingSegmentId, setSeekingSegmentId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const sessionManager = new SessionManager();

  useEffect(() => {
    loadSession();
  }, [sessionId]);

  useEffect(() => {
    // Handle playback to skip deleted segments
    if (!session || !videoRef.current) return;

    const video = videoRef.current;
    
    const handleTimeUpdate = () => {
      const currentVideoTime = video.currentTime;
      setCurrentTime(currentVideoTime);
      
      // Check if current time is within any timeline segment
      const currentSegment = session.timeline.find(
        seg => currentVideoTime >= seg.sourceStart && currentVideoTime < seg.sourceEnd
      );
      
      if (!currentSegment && !video.paused) {
        // Current time is in a deleted section, jump to next segment
        const nextSegment = session.timeline.find(seg => seg.sourceStart > currentVideoTime);
        
        if (nextSegment) {
          video.currentTime = nextSegment.sourceStart;
        } else {
          // No more segments, reset to start of first segment
          video.pause();
          setIsPlaying(false);
          
          const firstSegment = session.timeline.sort((a, b) => a.order - b.order)[0];
          if (firstSegment) {
            video.currentTime = firstSegment.sourceStart;
            setCurrentTime(firstSegment.sourceStart);
          }
        }
      }
    };
    
    video.addEventListener('timeupdate', handleTimeUpdate);
    
    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [session]);

  const loadSession = async () => {
    const data = await sessionManager.loadSession(sessionId);
    if (data) {
      setSession(data);
    } else {
      // Try to load the uploaded video from IndexedDB
      try {
        const db = await openVideoDatabase();
        const transaction = db.transaction(['videos'], 'readonly');
        const store = transaction.objectStore('videos');
        const request = store.get(sessionId);
        
        request.onsuccess = async () => {
          const result = request.result;
          
          if (result && result.file) {
            // Create blob URL from the stored file
            const videoUrl = URL.createObjectURL(result.file);
            
            // Get video metadata
            const video = document.createElement('video');
            video.preload = 'metadata';
            
            video.onloadedmetadata = async () => {
              const duration = video.duration;
              const width = video.videoWidth;
              const height = video.videoHeight;
              
              const mockSession: SessionData = {
                sessionId,
                videoUrl,
                duration,
                resolution: { width, height },
                timeline: [
                  {
                    id: '1',
                    sourceStart: 0,
                    sourceEnd: duration,
                    timelineStart: 0,
                    duration,
                    order: 0,
                  },
                ],
                transcript: null,
                undoStack: [],
                redoStack: [],
                lastModified: Date.now(),
              };
              
              setSession(mockSession);
              await sessionManager.saveSession(sessionId, mockSession);
            };
            
            video.src = videoUrl;
          } else {
            // Fallback to sample video
            loadSampleVideo();
          }
        };
        
        request.onerror = () => {
          loadSampleVideo();
        };
      } catch (error) {
        console.error('Failed to load video from IndexedDB:', error);
        loadSampleVideo();
      }
    }
  };

  const loadSampleVideo = async () => {
    const mockSession: SessionData = {
      sessionId,
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      duration: 596,
      resolution: { width: 1920, height: 1080 },
      timeline: [
        {
          id: '1',
          sourceStart: 0,
          sourceEnd: 596,
          timelineStart: 0,
          duration: 596,
          order: 0,
        },
      ],
      transcript: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };
    setSession(mockSession);
    await sessionManager.saveSession(sessionId, mockSession);
  };

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

  const handlePlayPause = () => {
    setIsPlaying(!isPlaying);
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!session || !videoRef.current || isDraggingPlayhead) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * session.duration;
    
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDraggingPlayhead(true);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDraggingPlayhead || !session || !videoRef.current || !timelineRef.current) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, mouseX / rect.width));
    const newTime = percentage * session.duration;
    
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleMouseUp = () => {
    setIsDraggingPlayhead(false);
  };

  useEffect(() => {
    if (isDraggingPlayhead) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDraggingPlayhead, session]);

  const handleCut = () => {
    if (!session) return;
    
    // Find which segment contains the current time
    const segmentToCut = session.timeline.find(
      seg => currentTime >= seg.sourceStart && currentTime <= seg.sourceEnd
    );
    
    if (!segmentToCut || currentTime === segmentToCut.sourceStart || currentTime === segmentToCut.sourceEnd) {
      alert('Cannot cut at segment boundaries. Please position the playhead within a segment.');
      return;
    }
    
    // Create two new segments from the cut
    const segment1: TimelineSegment = {
      id: `${segmentToCut.id}-1`,
      sourceStart: segmentToCut.sourceStart,
      sourceEnd: currentTime,
      timelineStart: segmentToCut.timelineStart,
      duration: currentTime - segmentToCut.sourceStart,
      order: segmentToCut.order,
    };
    
    const segment2: TimelineSegment = {
      id: `${segmentToCut.id}-2`,
      sourceStart: currentTime,
      sourceEnd: segmentToCut.sourceEnd,
      timelineStart: segmentToCut.timelineStart + segment1.duration,
      duration: segmentToCut.sourceEnd - currentTime,
      order: segmentToCut.order + 1,
    };
    
    // Update timeline: remove old segment, add two new ones, reorder
    const newTimeline = session.timeline
      .filter(seg => seg.id !== segmentToCut.id)
      .concat([segment1, segment2])
      .map((seg, index) => ({ ...seg, order: index }))
      .sort((a, b) => a.order - b.order);
    
    // Save to undo stack
    const updatedSession = {
      ...session,
      timeline: newTimeline,
      undoStack: [...session.undoStack, { type: 'CUT' as const, segmentId: segmentToCut.id, cutTime: currentTime, newSegmentId: segment2.id }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleDelete = () => {
    if (!session || !selectedSegmentId) {
      alert('Please select a segment to delete by clicking on it in the timeline.');
      return;
    }
    
    const segmentToDelete = session.timeline.find(seg => seg.id === selectedSegmentId);
    if (!segmentToDelete) return;
    
    if (session.timeline.length === 1) {
      alert('Cannot delete the last segment.');
      return;
    }
    
    // Remove segment and reorder
    const newTimeline = session.timeline
      .filter(seg => seg.id !== selectedSegmentId)
      .map((seg, index) => ({ ...seg, order: index }))
      .sort((a, b) => a.order - b.order);
    
    // Recalculate timeline positions
    let cumulativeTime = 0;
    const adjustedTimeline = newTimeline.map(seg => {
      const adjusted = { ...seg, timelineStart: cumulativeTime };
      cumulativeTime += seg.duration;
      return adjusted;
    });
    
    // Save to undo stack
    const updatedSession = {
      ...session,
      timeline: adjustedTimeline,
      undoStack: [...session.undoStack, { type: 'DELETE' as const, segment: segmentToDelete }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    setSelectedSegmentId(null);
    sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleUndo = () => {
    if (!session || session.undoStack.length === 0) return;
    
    const lastAction = session.undoStack[session.undoStack.length - 1];
    let newTimeline = [...session.timeline];
    
    if (lastAction.type === 'CUT') {
      // Reverse cut: merge the two segments back
      const seg1 = newTimeline.find(s => s.id === `${lastAction.segmentId}-1`);
      const seg2 = newTimeline.find(s => s.id === `${lastAction.segmentId}-2`);
      
      if (seg1 && seg2) {
        const merged: TimelineSegment = {
          id: lastAction.segmentId,
          sourceStart: seg1.sourceStart,
          sourceEnd: seg2.sourceEnd,
          timelineStart: seg1.timelineStart,
          duration: seg1.duration + seg2.duration,
          order: seg1.order,
        };
        
        newTimeline = newTimeline
          .filter(s => s.id !== seg1.id && s.id !== seg2.id)
          .concat([merged])
          .map((seg, index) => ({ ...seg, order: index }))
          .sort((a, b) => a.order - b.order);
      }
    } else if (lastAction.type === 'DELETE') {
      // Reverse delete: restore the segment
      newTimeline = [...newTimeline, lastAction.segment]
        .sort((a, b) => a.order - b.order)
        .map((seg, index) => ({ ...seg, order: index }));
      
      // Recalculate timeline positions
      let cumulativeTime = 0;
      newTimeline = newTimeline.map(seg => {
        const adjusted = { ...seg, timelineStart: cumulativeTime };
        cumulativeTime += seg.duration;
        return adjusted;
      });
    }
    
    const updatedSession = {
      ...session,
      timeline: newTimeline,
      undoStack: session.undoStack.slice(0, -1),
      redoStack: [...session.redoStack, lastAction],
    };
    
    setSession(updatedSession);
    sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleRedo = () => {
    if (!session || session.redoStack.length === 0) return;
    
    const actionToRedo = session.redoStack[session.redoStack.length - 1];
    let newTimeline = [...session.timeline];
    
    if (actionToRedo.type === 'CUT') {
      // Redo cut
      const segmentToCut = newTimeline.find(s => s.id === actionToRedo.segmentId);
      if (segmentToCut) {
        const segment1: TimelineSegment = {
          id: `${segmentToCut.id}-1`,
          sourceStart: segmentToCut.sourceStart,
          sourceEnd: actionToRedo.cutTime,
          timelineStart: segmentToCut.timelineStart,
          duration: actionToRedo.cutTime - segmentToCut.sourceStart,
          order: segmentToCut.order,
        };
        
        const segment2: TimelineSegment = {
          id: `${segmentToCut.id}-2`,
          sourceStart: actionToRedo.cutTime,
          sourceEnd: segmentToCut.sourceEnd,
          timelineStart: segmentToCut.timelineStart + segment1.duration,
          duration: segmentToCut.sourceEnd - actionToRedo.cutTime,
          order: segmentToCut.order + 1,
        };
        
        newTimeline = newTimeline
          .filter(s => s.id !== segmentToCut.id)
          .concat([segment1, segment2])
          .map((seg, index) => ({ ...seg, order: index }))
          .sort((a, b) => a.order - b.order);
      }
    } else if (actionToRedo.type === 'DELETE') {
      // Redo delete
      newTimeline = newTimeline
        .filter(s => s.id !== actionToRedo.segment.id)
        .map((seg, index) => ({ ...seg, order: index }))
        .sort((a, b) => a.order - b.order);
      
      // Recalculate timeline positions
      let cumulativeTime = 0;
      newTimeline = newTimeline.map(seg => {
        const adjusted = { ...seg, timelineStart: cumulativeTime };
        cumulativeTime += seg.duration;
        return adjusted;
      });
    }
    
    const updatedSession = {
      ...session,
      timeline: newTimeline,
      undoStack: [...session.undoStack, actionToRedo],
      redoStack: session.redoStack.slice(0, -1),
    };
    
    setSession(updatedSession);
    sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleSegmentClick = (segmentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedSegmentId(segmentId);
  };

  const handleClipRename = (segmentId: string, newName: string) => {
    if (!session) return;
    
    const updatedTimeline = session.timeline.map(seg =>
      seg.id === segmentId ? { ...seg, name: newName } : seg
    );
    
    const updatedSession = {
      ...session,
      timeline: updatedTimeline,
    };
    
    setSession(updatedSession);
    sessionManager.saveSession(sessionId, updatedSession);
  };

  const getDeletedSections = () => {
    if (!session) return [];
    
    const deletedSections: Array<{ start: number; duration: number }> = [];
    const sortedSegments = [...session.timeline].sort((a, b) => a.sourceStart - b.sourceStart);
    
    // Check for gaps between segments (deleted sections)
    for (let i = 0; i < sortedSegments.length; i++) {
      const currentSegment = sortedSegments[i];
      const nextSegment = sortedSegments[i + 1];
      
      // Check gap before first segment
      if (i === 0 && currentSegment.sourceStart > 0) {
        deletedSections.push({
          start: 0,
          duration: currentSegment.sourceStart,
        });
      }
      
      // Check gap between segments
      if (nextSegment && currentSegment.sourceEnd < nextSegment.sourceStart) {
        deletedSections.push({
          start: currentSegment.sourceEnd,
          duration: nextSegment.sourceStart - currentSegment.sourceEnd,
        });
      }
      
      // Check gap after last segment
      if (i === sortedSegments.length - 1 && currentSegment.sourceEnd < session.duration) {
        deletedSections.push({
          start: currentSegment.sourceEnd,
          duration: session.duration - currentSegment.sourceEnd,
        });
      }
    }
    
    return deletedSections;
  };

  const handleExport = () => {
    alert('Export functionality will be implemented');
  };

  const handleTranscribe = async () => {
    if (!session) return;
    
    setIsTranscribing(true);
    
    try {
      // Call the real Whisper API backend
      const apiClient = new APIClient('http://localhost:8000/api');
      const response = await apiClient.transcribeVideo(session.sessionId);
      
      // Format the transcript with timestamps if segments are available
      let formattedTranscript = response.transcript;
      
      if (response.segments && response.segments.length > 0) {
        formattedTranscript = response.segments
          .map((seg: any) => {
            const startTime = formatTime(seg.start);
            const endTime = formatTime(seg.end);
            return `[${startTime} - ${endTime}] ${seg.text}`;
          })
          .join('\n\n');
      }
      
      const updatedSession = {
        ...session,
        transcript: formattedTranscript,
      };
      
      setSession(updatedSession);
      await sessionManager.saveSession(sessionId, updatedSession);
      setIsTranscribing(false);
    } catch (error) {
      console.error('Transcription failed:', error);
      setIsTranscribing(false);
      
      // Show error message to user
      let errorMessage = 'Transcription failed. ';
      
      if (error instanceof Error) {
        if (error.message.includes('OpenAI API key')) {
          errorMessage += 'OpenAI API key not configured. Please set OPENAI_API_KEY in backend/.env';
        } else if (error.message.includes('Video file not found')) {
          errorMessage += 'Video file not found. Please upload the video to the backend first.';
        } else if (error.message.includes('Connection failed')) {
          errorMessage += 'Cannot connect to backend. Make sure the backend server is running on http://localhost:8000';
        } else {
          errorMessage += error.message;
        }
      }
      
      alert(errorMessage);
    }
  };

  const handleTranscriptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!session) return;
    
    const updatedSession = {
      ...session,
      transcript: e.target.value,
    };
    
    setSession(updatedSession);
    sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleSegmentJump = async (segment: TimelineSegment) => {
    if (!videoRef.current) return;
    
    const video = videoRef.current;
    const wasPlaying = !video.paused;
    
    // Check if we're already at the target position (within 0.1 seconds)
    const isAlreadyAtPosition = Math.abs(video.currentTime - segment.sourceStart) < 0.1;
    
    if (isAlreadyAtPosition) {
      // Already at position, just select the segment
      setSelectedSegmentId(segment.id);
      return;
    }
    
    // Show seeking indicator for this specific segment
    setSeekingSegmentId(segment.id);
    
    // Pause first to avoid playback issues during seek
    video.pause();
    
    // Set the time
    video.currentTime = segment.sourceStart;
    setCurrentTime(segment.sourceStart);
    setSelectedSegmentId(segment.id);
    
    // Wait for seek to complete
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      
      // Timeout fallback
      setTimeout(resolve, 500);
    });
    
    // Hide seeking indicator
    setSeekingSegmentId(null);
    
    // Resume playback if it was playing before
    if (wasPlaying) {
      try {
        await video.play();
        setIsPlaying(true);
      } catch (error) {
        console.log('Could not resume playback');
      }
    }
  };

  const handleResetConfirm = async () => {
    if (session) {
      await sessionManager.clearSession(session.sessionId);
    }
    setShowResetDialog(false);
    if (onReset) {
      onReset();
    }
  };

  if (!session) {
    return (
      <div className="editor-page">
        <div className="loading">Loading session...</div>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <header className="editor-header">
        <div className="header-left">
          <h1>AutoEdit</h1>
          <span className="session-id">Session: {sessionId.substring(0, 8)}...</span>
        </div>
        <div className="header-right">
          <button className="btn btn-secondary" onClick={() => setShowResetDialog(true)}>
            Reset
          </button>
          <button className="btn btn-primary" onClick={handleExport}>
            Export
          </button>
        </div>
      </header>

      <div className="editor-content">
        <main className="editor-main">
          {/* Video Player */}
          <div className="video-player">
            <video
              ref={videoRef}
              src={session.videoUrl}
              controls
              className="video-element"
              crossOrigin="anonymous"
              preload="auto"
            >
              Your browser does not support the video tag.
            </video>
          </div>

          {/* Editing Controls */}
          <div className="editing-controls">
            <button className="btn btn-icon" title="Cut at playhead position" onClick={handleCut}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <line x1="20" y1="4" x2="8.12" y2="15.88" />
                <line x1="14.47" y1="14.48" x2="20" y2="20" />
                <line x1="8.12" y1="8.12" x2="12" y2="12" />
              </svg>
            </button>
            <button 
              className="btn btn-icon" 
              title="Delete selected segment" 
              onClick={handleDelete}
              disabled={!selectedSegmentId}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
            <button 
              className="btn btn-icon" 
              title="Undo last action" 
              onClick={handleUndo}
              disabled={!session || session.undoStack.length === 0}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
            <button 
              className="btn btn-icon" 
              title="Redo last undone action" 
              onClick={handleRedo}
              disabled={!session || session.redoStack.length === 0}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>

          {/* Timeline */}
          <div className="timeline">
            <div className="timeline-header">
              <span>Timeline</span>
              <span className="timeline-time">{formatTime(currentTime)} / {formatTime(session.duration)}</span>
            </div>
            <div className={`timeline-content ${isDraggingPlayhead ? 'dragging' : ''}`} ref={timelineRef} onClick={handleTimelineClick}>
              {/* Timestamp ruler */}
              <div className="timeline-ruler">
                {Array.from({ length: 11 }).map((_, i) => {
                  const time = (session.duration / 10) * i;
                  return (
                    <div
                      key={i}
                      className="timeline-tick"
                      style={{ left: `${i * 10}%` }}
                    >
                      <span className="timeline-tick-label">{formatTime(time)}</span>
                    </div>
                  );
                })}
              </div>
              
              <div className="timeline-track">
                {/* Show deleted sections in gray */}
                {getDeletedSections().map((section, index) => (
                  <div
                    key={`deleted-${index}`}
                    className="timeline-deleted"
                    style={{
                      left: `${(section.start / session.duration) * 100}%`,
                      width: `${(section.duration / session.duration) * 100}%`,
                    }}
                  />
                ))}
                
                {/* Show active segments */}
                {session.timeline.map((segment) => (
                  <div
                    key={segment.id}
                    className={`timeline-segment ${selectedSegmentId === segment.id ? 'selected' : ''}`}
                    style={{
                      left: `${(segment.sourceStart / session.duration) * 100}%`,
                      width: `${(segment.duration / session.duration) * 100}%`,
                    }}
                    onClick={(e) => handleSegmentClick(segment.id, e)}
                  >
                    <span className="segment-label">{segment.name || `Clip ${segment.order + 1}`}</span>
                  </div>
                ))}
                <div
                  className={`timeline-playhead ${isDraggingPlayhead ? 'dragging' : ''}`}
                  style={{
                    left: `${(currentTime / session.duration) * 100}%`,
                  }}
                  onMouseDown={handlePlayheadMouseDown}
                />
              </div>
            </div>
          </div>
        </main>

        {/* Sidebar */}
        <aside className="editor-sidebar">
          <div className="sidebar-tabs">
            <button
              className={`tab ${activeTab === 'clips' ? 'active' : ''}`}
              onClick={() => setActiveTab('clips')}
            >
              Clips
            </button>
            <button
              className={`tab ${activeTab === 'ai-edit' ? 'active' : ''}`}
              onClick={() => setActiveTab('ai-edit')}
            >
              AI Edit
            </button>
            <button
              className={`tab ${activeTab === 'assets' ? 'active' : ''}`}
              onClick={() => setActiveTab('assets')}
            >
              Assets
            </button>
          </div>

          <div className="sidebar-content">
            {activeTab === 'clips' && (
              <div className="tab-panel">
                <h3 className="panel-title">Video Clips</h3>
                <p className="panel-description">
                  {session.timeline.length} clip{session.timeline.length !== 1 ? 's' : ''} in timeline
                </p>
                
                <div className="clips-list">
                  {session.timeline
                    .sort((a, b) => a.order - b.order)
                    .map((segment) => (
                      <div
                        key={segment.id}
                        className={`clip-item ${selectedSegmentId === segment.id ? 'selected' : ''}`}
                        onClick={() => handleSegmentJump(segment)}
                      >
                        <div className="clip-header">
                          <input
                            type="text"
                            className="clip-name-input"
                            value={segment.name || `Clip ${segment.order + 1}`}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleClipRename(segment.id, e.target.value);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            placeholder={`Clip ${segment.order + 1}`}
                          />
                          <span className="clip-duration">{formatTime(segment.duration)}</span>
                        </div>
                        <div className="clip-time-range">
                          {formatTime(segment.sourceStart)} - {formatTime(segment.sourceEnd)}
                        </div>
                        <div className="clip-actions">
                          <button
                            className="btn-small"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSegmentJump(segment);
                            }}
                            disabled={seekingSegmentId === segment.id}
                          >
                            {seekingSegmentId === segment.id ? 'Seeking...' : 'Jump to'}
                          </button>
                          <button
                            className="btn-small btn-danger-small"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSegmentId(segment.id);
                              handleDelete();
                            }}
                            disabled={seekingSegmentId !== null}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
                
                {session.timeline.length === 0 && (
                  <div className="empty-state">
                    <p>No clips in timeline</p>
                    <p className="empty-state-hint">Upload a video to get started</p>
                  </div>
                )}
              </div>
            )}
            
            {activeTab === 'ai-edit' && (
              <div className="tab-panel">
                <h3 className="panel-title">AI Transcription</h3>
                <p className="panel-description">
                  Generate and edit video transcript
                </p>
                
                <button
                  className="btn btn-secondary btn-full"
                  onClick={handleTranscribe}
                  disabled={isTranscribing}
                >
                  {isTranscribing ? 'Transcribing...' : 'Transcribe Video'}
                </button>
                
                <div className="transcript-area">
                  {session.transcript ? (
                    <>
                      <label className="transcript-label">Transcript:</label>
                      <textarea
                        className="transcript-text"
                        value={session.transcript}
                        onChange={handleTranscriptChange}
                        placeholder="Edit your transcript here..."
                      />
                      <p className="transcript-hint">
                        Edit the transcript to modify your video content
                      </p>
                    </>
                  ) : (
                    <div className="empty-state">
                      <svg
                        width="48"
                        height="48"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        style={{ margin: '0 auto 1rem', opacity: 0.5 }}
                      >
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="23" />
                        <line x1="8" y1="23" x2="16" y2="23" />
                      </svg>
                      <p>No transcript yet</p>
                      <p className="empty-state-hint">
                        Click "Transcribe Video" to generate a transcript using AI
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {activeTab === 'assets' && (
              <div className="tab-panel">
                <h3 className="panel-title">Media Assets</h3>
                <p className="panel-description">
                  Manage your video and audio files
                </p>
                
                <div className="asset-list">
                  <div className="asset-item">
                    <div className="asset-icon">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                      </svg>
                    </div>
                    <div className="asset-info">
                      <div className="asset-name">Original Video</div>
                      <div className="asset-meta">
                        {session.resolution.width}x{session.resolution.height} • {formatTime(session.duration)}
                      </div>
                    </div>
                  </div>
                  
                  {session.transcript && (
                    <div className="asset-item">
                      <div className="asset-icon">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                          <polyline points="10 9 9 9 8 9" />
                        </svg>
                      </div>
                      <div className="asset-info">
                        <div className="asset-name">Transcript</div>
                        <div className="asset-meta">
                          {session.transcript.length} characters
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <div className="asset-item">
                    <div className="asset-icon">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18V5l12-2v13" />
                        <circle cx="6" cy="18" r="3" />
                        <circle cx="18" cy="16" r="3" />
                      </svg>
                    </div>
                    <div className="asset-info">
                      <div className="asset-name">Audio Track</div>
                      <div className="asset-meta">
                        Embedded • {formatTime(session.duration)}
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="asset-stats">
                  <h4>Project Stats</h4>
                  <div className="stat-row">
                    <span>Total Clips:</span>
                    <span>{session.timeline.length}</span>
                  </div>
                  <div className="stat-row">
                    <span>Original Duration:</span>
                    <span>{formatTime(session.duration)}</span>
                  </div>
                  <div className="stat-row">
                    <span>Edited Duration:</span>
                    <span>
                      {formatTime(
                        session.timeline.reduce((sum, seg) => sum + seg.duration, 0)
                      )}
                    </span>
                  </div>
                  <div className="stat-row">
                    <span>Resolution:</span>
                    <span>{session.resolution.width}x{session.resolution.height}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Reset Confirmation Dialog */}
      {showResetDialog && (
        <div className="dialog-overlay" onClick={() => setShowResetDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Reset Session?</h2>
            <p>This will clear all editing data and return to the upload page.</p>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => setShowResetDialog(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleResetConfirm}>
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
