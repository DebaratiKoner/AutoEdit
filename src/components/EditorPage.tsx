/**
 * Editor Page Component
 * Main editing interface with video player, timeline, and controls
 */

import { useState, useEffect, useRef } from 'react';
import { SessionManager, APIClient, CompositionBuilder } from '../services';
import { formatTime, logger } from '../utils';
import type { SessionData, TimelineSegment, CompositionSchema } from '../types';
import { RemotionPreview } from './RemotionPreview';
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
  const [aiPrompt, setAiPrompt] = useState('');
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string; actions?: Array<Record<string, any>> }>>([]);
  const [isAiEditing, setIsAiEditing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showRemotionPreview, setShowRemotionPreview] = useState(false);
  const [compositionSchema, setCompositionSchema] = useState<CompositionSchema | null>(null);
  const [showTranscribeButton, setShowTranscribeButton] = useState(true);
  const [draggedSegmentId, setDraggedSegmentId] = useState<string | null>(null);
  const [dragOverSegmentId, setDragOverSegmentId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<number | null>(null);
  const [assets, setAssets] = useState<Array<{ id: string; name: string; type: 'photo' | 'video' | 'audio'; url: string; duration?: number }>>([]);
  const [uploadingAsset, setUploadingAsset] = useState(false);
  const [transcriptionVisible, setTranscriptionVisible] = useState(true);
  const [isEditPanelFullscreen, setIsEditPanelFullscreen] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const currentClipIndexRef = useRef(0);      // current clip index — stable across re-renders
  const isJumpingRef = useRef(false);  // guard against programmatic-seek → seeked loops
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const editPanelRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionData | null>(null); // always holds latest session for async closures

  const sessionManager = new SessionManager();

  // Helper function to add transcript history entry after editing operations
  const addTranscriptHistoryEntry = (session: SessionData, operation: string): SessionData => {
    if (!session.transcript) return session;
    
    const historyEntry = {
      timestamp: Date.now(),
      operation,
      transcript: session.transcript,
      segments: session.transcriptSegments,
    };
    
    return {
      ...session,
      transcriptHistory: [...(session.transcriptHistory || []), historyEntry],
    };
  };

  useEffect(() => {
    loadSession();
  }, [sessionId]);

  // Check if session has transcript on load to determine button visibility
  useEffect(() => {
    if (session) {
      const hasExistingTranscript = !!(session.transcript && session.transcript.trim().length > 0);
      logger.debug('Session loaded - hasTranscript:', hasExistingTranscript);
      setShowTranscribeButton(!hasExistingTranscript);
      
      // Always show transcript area if transcript exists
      if (hasExistingTranscript) {
        setTranscriptionVisible(true);
      }
    }
  }, [session?.sessionId]); // Only run when session ID changes (initial load)

  // Keep ref in sync so async handlers always read the latest session
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Sync video position when session loads or clips change
  useEffect(() => {
    if (!session || !videoRef.current) return;
    const video = videoRef.current;
    const sortedClips = [...session.timeline].sort((a, b) => a.order - b.order);
    if (sortedClips.length === 0) return;
    const t = video.currentTime;
    const inValidClip = sortedClips.some(c => t >= c.sourceStart && t < c.sourceEnd);
    logger.debug('Video init - currentTime:', t, 'clips:', sortedClips.map(c => `${c.sourceStart}-${c.sourceEnd}`));
    if (!inValidClip) {
      video.currentTime = sortedClips[0].sourceStart;
      setCurrentTime(sortedClips[0].sourceStart);
      logger.debug('Video init - snapped to first clip start:', sortedClips[0].sourceStart);
    }
  }, [session?.sessionId, session?.timeline.length]);

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isAiEditing]);

  // Build Remotion composition when timeline or transcriptSegments change
  useEffect(() => {
    if (session && showRemotionPreview) {
      try {
        const builder = new CompositionBuilder();
        const schema = builder.buildComposition(session);
        setCompositionSchema(schema);
      } catch (error) {
        logger.error('Failed to build composition:', error);
        setCompositionSchema(null);
      }
    }
  }, [session?.timeline, session?.transcriptSegments, showRemotionPreview]);

  useEffect(() => {
    // Controlled playback: enforce clip boundaries during play and on seek
    if (!session || !videoRef.current) return;

    const video = videoRef.current;
    const sortedClips = [...session.timeline].sort((a, b) => a.order - b.order);
    const EPS = 0.1; // float precision buffer

    let rafId = 0;
    let rafRunning = false;

    const jump = (time: number) => {
      if (isJumpingRef.current) return;
      isJumpingRef.current = true;
      video.currentTime = time;
      setCurrentTime(time);
      setTimeout(() => { isJumpingRef.current = false; }, 50);
    };

    const enforce = () => {
      if (video.paused || isJumpingRef.current) return;
      if (sortedClips.length === 0) { video.pause(); setIsPlaying(false); return; }

      const t = video.currentTime;
      setCurrentTime(t);

      // Find clip with epsilon buffer for float precision
      const currentClip = sortedClips.find(
        c => t >= c.sourceStart - EPS && t < c.sourceEnd + EPS
      );

      if (!currentClip) {
        // In a gap — jump aggressively to next clip by index
        const nextIndex = currentClipIndexRef.current + 1;
        const nextClip = nextIndex < sortedClips.length ? sortedClips[nextIndex] : sortedClips[0];
        currentClipIndexRef.current = nextIndex < sortedClips.length ? nextIndex : 0;
        if (nextIndex < sortedClips.length) {
          jump(nextClip.sourceStart);
        } else {
          video.pause();
          setIsPlaying(false);
          jump(sortedClips[0].sourceStart);
        }
        return;
      }

      // Near or past clip end — jump to next
      if (t >= currentClip.sourceEnd - EPS) {
        const nextIndex = currentClipIndexRef.current + 1;
        const nextClip = nextIndex < sortedClips.length ? sortedClips[nextIndex] : null;
        if (nextClip) {
          currentClipIndexRef.current = nextIndex;
          jump(nextClip.sourceStart);
        } else {
          // End of timeline, loop back to first clip
          currentClipIndexRef.current = 0;
          video.pause();
          setIsPlaying(false);
          jump(sortedClips[0].sourceStart);
        }
      }
    };

    // rAF loop — runs every frame (~16ms) while playing, much faster than timeupdate (~250ms)
    const rafLoop = () => {
      enforce();
      if (rafRunning) rafId = requestAnimationFrame(rafLoop);
    };

    const handlePlay = () => {
      if (sortedClips.length === 0) return;
      const t = video.currentTime;
      // Find current clip's index in sortedClips
      const currentIndex = sortedClips.findIndex(c => t >= c.sourceStart - EPS && t < c.sourceEnd + EPS);
      if (currentIndex >= 0) {
        currentClipIndexRef.current = currentIndex;
      } else {
        // Not in a clip, set index to 0 and jump to first clip
        currentClipIndexRef.current = 0;
        jump(sortedClips[0].sourceStart);
      }
      // Start rAF loop
      rafRunning = true;
      rafId = requestAnimationFrame(rafLoop);
    };

    const handlePause = () => {
      rafRunning = false;
      cancelAnimationFrame(rafId);
    };

    const handleSeeked = () => {
      if (isJumpingRef.current) return;
      const t = video.currentTime;
      if (sortedClips.length === 0) return;
      const clipIndex = sortedClips.findIndex(c => t >= c.sourceStart - EPS && t < c.sourceEnd + EPS);
      if (clipIndex >= 0) {
        currentClipIndexRef.current = clipIndex;
        return;
      }
      // Not in a clip, find next clip by index
      const nextIndex = sortedClips.findIndex(c => c.sourceStart > t);
      if (nextIndex >= 0) {
        currentClipIndexRef.current = nextIndex;
        jump(sortedClips[nextIndex].sourceStart);
      } else {
        currentClipIndexRef.current = sortedClips.length - 1;
        jump(sortedClips[sortedClips.length - 1].sourceStart);
      }
    };

    // Also keep timeupdate as a fallback for browsers that throttle rAF
    video.addEventListener('timeupdate', enforce);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeked', handleSeeked);

    // If video is already playing when effect runs (e.g. after edit), start loop immediately
    if (!video.paused) {
      rafRunning = true;
      rafId = requestAnimationFrame(rafLoop);
    }

    return () => {
      rafRunning = false;
      cancelAnimationFrame(rafId);
      video.removeEventListener('timeupdate', enforce);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeked', handleSeeked);
    };
  }, [session]);

  const loadSession = async () => {
    // 1. Try to restore a previously saved session (survives refresh)
    const data = await sessionManager.loadSession(sessionId);
    if (data) {
      // Always use the backend stream URL — blob URLs don't survive refresh
      const streamUrl = `/api/videos/${sessionId}/stream`;
      
      // Migrate: assign colors and tracks to clips that don't have them
      const migratedTimeline = data.timeline.map((seg, index) => ({
        ...seg,
        color: seg.color || getClipColor(index),
        track: seg.track !== undefined ? seg.track : 0, // Default to track 0
      }));
      
      const restoredSession = { ...data, videoUrl: streamUrl, timeline: migratedTimeline };
      logger.debug('Restored session from storage, videoUrl:', streamUrl);
      setSession(restoredSession);
      
      // Save migrated session
      if (migratedTimeline.some((seg, i) => seg.color !== data.timeline[i].color)) {
        await sessionManager.saveSession(sessionId, restoredSession);
      }
      return;
    }

    // 2. Fresh load — build session using backend stream URL directly
    const streamUrl = `/api/videos/${sessionId}/stream`;
    logger.debug('Fresh session load, videoUrl:', streamUrl);

    // Get duration from a temporary video element
    const getDuration = (): Promise<{ duration: number; width: number; height: number }> =>
      new Promise((resolve) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
        v.onerror = () => resolve({ duration: 0, width: 1920, height: 1080 });
        v.src = streamUrl;
      });

    const { duration, width, height } = await getDuration();

    const newSession: SessionData = {
      sessionId,
      videoUrl: streamUrl,
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
          track: 0, // Main video track
          color: getClipColor(0), // Assign permanent color
          name: 'Clip 1', // Initial clip name
        },
      ],
      transcript: null,
      transcriptSegments: null,
      undoStack: [],
      redoStack: [],
      lastModified: Date.now(),
    };

    logger.operation('Session created:', { sessionId, duration });
    setSession(newSession);
    await sessionManager.saveSession(sessionId, newSession);
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
    
    // Get next available color for the second segment only
    const existingColors = session.timeline.map(seg => seg.color).filter(c => c !== undefined) as string[];
    const availableColors = [
      '#4a90e2', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6',
      '#1abc9c', '#e67e22', '#34495e', '#16a085', '#27ae60'
    ];
    
    // First segment keeps the original color
    const color1 = segmentToCut.color || availableColors[0];
    
    // Find an unused color for the second segment
    let color2 = availableColors[0];
    for (let i = 0; i < availableColors.length; i++) {
      if (!existingColors.includes(availableColors[i]) && availableColors[i] !== color1) {
        color2 = availableColors[i];
        break;
      }
    }
    
    // If no unused colors, use the next color in the palette
    if (color2 === availableColors[0] && segmentToCut.color) {
      const currentIndex = availableColors.indexOf(segmentToCut.color);
      color2 = availableColors[(currentIndex + 1) % availableColors.length];
    }
    
    // Create two new segments from the cut
    const segment1: TimelineSegment = {
      id: `${segmentToCut.id}-1`,
      sourceStart: segmentToCut.sourceStart,
      sourceEnd: currentTime,
      timelineStart: segmentToCut.timelineStart,
      duration: currentTime - segmentToCut.sourceStart,
      order: segmentToCut.order,
      track: segmentToCut.track, // Preserve track
      color: color1, // Assign new unique color
      name: `Clip ${segmentToCut.order + 1}`, // Sequential naming: Clip 1, Clip 2, etc.
    };
    
    const segment2: TimelineSegment = {
      id: `${segmentToCut.id}-2`,
      sourceStart: currentTime,
      sourceEnd: segmentToCut.sourceEnd,
      timelineStart: segmentToCut.timelineStart + segment1.duration,
      duration: segmentToCut.sourceEnd - currentTime,
      order: segmentToCut.order + 1,
      track: segmentToCut.track, // Preserve track
      color: color2, // Assign new unique color
      name: `Clip ${segmentToCut.order + 2}`, // Sequential naming: next number
    };
    
    // Update timeline: remove old segment, add two new ones, adjust orders
    // Keep segment1 at the original order, segment2 at order+1, and shift everything after
    const newTimeline = session.timeline
      .filter(seg => seg.id !== segmentToCut.id)
      .map(seg => {
        // Shift order of segments that come after the cut segment
        if (seg.order > segmentToCut.order) {
          return { ...seg, order: seg.order + 1 };
        }
        return seg;
      })
      .concat([segment1, segment2])
      .sort((a, b) => a.order - b.order);
    
    // Recalculate timeline positions and renumber all clips sequentially
    let cumulativeTime = 0;
    const adjustedTimeline = newTimeline
      .sort((a, b) => a.order - b.order)
      .map((seg, index) => {
        const adjusted = { 
          ...seg, 
          order: index, 
          timelineStart: cumulativeTime,
          name: `Clip ${index + 1}` // Renumber all clips sequentially: Clip 1, Clip 2, Clip 3, etc.
        };
        cumulativeTime += seg.duration;
        return adjusted;
      });
    
    // Add history entry if transcript existed, then preserve original transcript
    let updatedSession: SessionData;
    if (session.transcript) {
      const sessionWithHistory = addTranscriptHistoryEntry(session, `Cut clip at ${formatTime(currentTime)}`);
      updatedSession = {
        ...sessionWithHistory,
        timeline: adjustedTimeline,
        // PRESERVE: Keep original transcript available for reference
        transcript: session.transcript, // Keep original transcript
        transcriptSegments: session.transcriptSegments, // Keep original segments
        undoStack: [...session.undoStack, { type: 'CUT' as const, segmentId: segmentToCut.id, cutTime: currentTime, newSegmentId: segment2.id }],
        redoStack: [],
      };
    } else {
      updatedSession = {
        ...session,
        timeline: adjustedTimeline,
        transcript: null, // No transcript to preserve
        transcriptSegments: null,
        undoStack: [...session.undoStack, { type: 'CUT' as const, segmentId: segmentToCut.id, cutTime: currentTime, newSegmentId: segment2.id }],
        redoStack: [],
      };
    }
    
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
    
    // Remove segment and reorder with sequential naming
    const newTimeline = session.timeline
      .filter(seg => seg.id !== selectedSegmentId)
      .sort((a, b) => a.order - b.order);
    
    // Recalculate timeline positions and renumber all clips sequentially
    let cumulativeTime = 0;
    const adjustedTimeline = newTimeline.map((seg, index) => {
      const adjusted = { 
        ...seg, 
        order: index, 
        timelineStart: cumulativeTime,
        name: `Clip ${index + 1}` // Renumber all clips sequentially: Clip 1, Clip 2, Clip 3, etc.
      };
      cumulativeTime += seg.duration;
      return adjusted;
    });
    
    // Add history entry if transcript existed, then preserve original transcript
    let updatedSession: SessionData;
    if (session.transcript) {
      const sessionWithHistory = addTranscriptHistoryEntry(session, `Deleted ${segmentToDelete.name || 'clip'}`);
      updatedSession = {
        ...sessionWithHistory,
        timeline: adjustedTimeline,
        // PRESERVE: Keep original transcript available for reference
        transcript: session.transcript, // Keep original transcript
        transcriptSegments: session.transcriptSegments, // Keep original segments
        undoStack: [...session.undoStack, { type: 'DELETE' as const, segment: segmentToDelete }],
        redoStack: [],
      };
    } else {
      updatedSession = {
        ...session,
        timeline: adjustedTimeline,
        transcript: null, // No transcript to preserve
        transcriptSegments: null,
        undoStack: [...session.undoStack, { type: 'DELETE' as const, segment: segmentToDelete }],
        redoStack: [],
      };
    }
    
    setSession(updatedSession);
    setSelectedSegmentId(null);
    sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleUndo = () => {
    if (!session || session.undoStack.length === 0) return;
    
    const lastAction = session.undoStack[session.undoStack.length - 1];
    let newTimeline = [...session.timeline];
    let newTranscript = session.transcript;
    let newTranscriptSegments = session.transcriptSegments;
    
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
          track: seg1.track, // Preserve track
          color: seg1.color, // Preserve color
          name: seg1.name, // Preserve name
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
    } else if (lastAction.type === 'AI_EDIT') {
      // Reverse AI edit: restore previous timeline and transcript state
      newTimeline = lastAction.previousTimeline;
      newTranscript = lastAction.previousTranscript;
      newTranscriptSegments = lastAction.previousTranscriptSegments;
    } else if (lastAction.type === 'REORDER') {
      // Reverse reorder: restore previous timeline order
      newTimeline = lastAction.previousTimeline;
    } else if (lastAction.type === 'ADD_ASSET') {
      // Reverse asset addition: restore previous timeline
      newTimeline = lastAction.previousTimeline;
    }
    
    const updatedSession = {
      ...session,
      timeline: newTimeline,
      transcript: newTranscript,
      transcriptSegments: newTranscriptSegments,
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
    let newTranscript = session.transcript;
    let newTranscriptSegments = session.transcriptSegments;
    
    if (actionToRedo.type === 'CUT') {
      // Redo cut
      const segmentToCut = newTimeline.find(s => s.id === actionToRedo.segmentId);
      if (segmentToCut) {
        // Get next available color for the second segment only
        const existingColors = newTimeline.map(seg => seg.color).filter(c => c !== undefined) as string[];
        const availableColors = [
          '#4a90e2', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6',
          '#1abc9c', '#e67e22', '#34495e', '#16a085', '#27ae60'
        ];
        
        // First segment keeps the original color
        const color1 = segmentToCut.color || availableColors[0];
        
        // Find an unused color for the second segment
        let color2 = availableColors[0];
        for (let i = 0; i < availableColors.length; i++) {
          if (!existingColors.includes(availableColors[i]) && availableColors[i] !== color1) {
            color2 = availableColors[i];
            break;
          }
        }
        
        // If no unused colors, use the next color in the palette
        if (color2 === availableColors[0] && segmentToCut.color) {
          const currentIndex = availableColors.indexOf(segmentToCut.color);
          color2 = availableColors[(currentIndex + 1) % availableColors.length];
        }
        
        const segment1: TimelineSegment = {
          id: `${segmentToCut.id}-1`,
          sourceStart: segmentToCut.sourceStart,
          sourceEnd: actionToRedo.cutTime,
          timelineStart: segmentToCut.timelineStart,
          duration: actionToRedo.cutTime - segmentToCut.sourceStart,
          order: segmentToCut.order,
          track: segmentToCut.track,
          color: color1,
          name: `Clip ${segmentToCut.order + 1}`, // Sequential naming
        };
        
        const segment2: TimelineSegment = {
          id: `${segmentToCut.id}-2`,
          sourceStart: actionToRedo.cutTime,
          sourceEnd: segmentToCut.sourceEnd,
          timelineStart: segmentToCut.timelineStart + segment1.duration,
          duration: segmentToCut.sourceEnd - actionToRedo.cutTime,
          order: segmentToCut.order + 1,
          track: segmentToCut.track,
          color: color2,
          name: `Clip ${segmentToCut.order + 2}`, // Sequential naming
        };
        
        newTimeline = newTimeline
          .filter(s => s.id !== segmentToCut.id)
          .map(seg => {
            // Shift order of segments that come after the cut segment
            if (seg.order > segmentToCut.order) {
              return { ...seg, order: seg.order + 1 };
            }
            return seg;
          })
          .concat([segment1, segment2])
          .sort((a, b) => a.order - b.order);
        
        // Recalculate timeline positions and renumber all clips sequentially
        let cumulativeTime = 0;
        newTimeline = newTimeline
          .sort((a, b) => a.order - b.order)
          .map((seg, index) => {
            const adjusted = { 
              ...seg, 
              order: index, 
              timelineStart: cumulativeTime,
              name: `Clip ${index + 1}` // Renumber all clips sequentially
            };
            cumulativeTime += seg.duration;
            return adjusted;
          });
      }
    } else if (actionToRedo.type === 'DELETE') {
      // Redo delete with sequential renaming
      newTimeline = newTimeline
        .filter(s => s.id !== actionToRedo.segment.id)
        .sort((a, b) => a.order - b.order);
      
      // Recalculate timeline positions and renumber all clips sequentially
      let cumulativeTime = 0;
      newTimeline = newTimeline.map((seg, index) => {
        const adjusted = { 
          ...seg, 
          order: index, 
          timelineStart: cumulativeTime,
          name: `Clip ${index + 1}` // Renumber all clips sequentially
        };
        cumulativeTime += seg.duration;
        return adjusted;
      });
    } else if (actionToRedo.type === 'AI_EDIT') {
      // For AI_EDIT redo, we need to re-apply the operations
      // This is complex, so for now we'll just show a message
      // In a full implementation, you'd store the result state and restore it
      logger.warn('AI_EDIT redo not fully implemented yet');
      return;
    }
    
    const updatedSession = {
      ...session,
      timeline: newTimeline,
      transcript: newTranscript,
      transcriptSegments: newTranscriptSegments,
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

  const handleSegmentDragStart = (segmentId: string, e: React.DragEvent) => {
    setDraggedSegmentId(segmentId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', segmentId);
  };

  const handleSegmentDragEnd = () => {
    setDraggedSegmentId(null);
    setDragOverSegmentId(null);
    setDragOverPosition(null);
  };

  const handleSegmentDragOver = (targetSegmentId: string, e: React.DragEvent) => {
    if (!draggedSegmentId || draggedSegmentId === targetSegmentId) return;
    
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    
    setDragOverSegmentId(targetSegmentId);
  };

  const handleSegmentDragLeave = (targetSegmentId: string, e: React.DragEvent) => {
    e.stopPropagation();
    if (dragOverSegmentId === targetSegmentId) {
      setDragOverSegmentId(null);
    }
  };

  const handleSegmentDrop = (targetSegmentId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!draggedSegmentId || !session || draggedSegmentId === targetSegmentId) return;
    
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    const targetSegment = session.timeline.find(seg => seg.id === targetSegmentId);
    
    if (!draggedSegment || !targetSegment) return;
    
    // Swap the order of the two segments (only if on same track)
    if (draggedSegment.track === targetSegment.track) {
      const newTimeline = session.timeline.map(seg => {
        if (seg.id === draggedSegmentId) {
          return { ...seg, order: targetSegment.order };
        } else if (seg.id === targetSegmentId) {
          return { ...seg, order: draggedSegment.order };
        }
        return seg;
      });
      
      // Sort by new order and recalculate timeline positions
      const sortedTimeline = [...newTimeline].sort((a, b) => a.order - b.order);
      let cumulativeTime = 0;
      const adjustedTimeline = sortedTimeline.map((seg, index) => {
        const adjusted = { ...seg, order: index, timelineStart: cumulativeTime };
        cumulativeTime += seg.duration;
        return adjusted;
      });
      
      const updatedSession = {
        ...session,
        timeline: adjustedTimeline,
        undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
        redoStack: [],
      };
      
      setSession(updatedSession);
      sessionManager.saveSession(sessionId, updatedSession);
    }
    
    setDraggedSegmentId(null);
    setDragOverSegmentId(null);
    setDragOverPosition(null);
  };

  // Handle dropping on a track (to move clip to different track)
  const handleTrackDrop = (trackNum: number, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!draggedSegmentId || !session) return;
    
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    if (!draggedSegment || draggedSegment.track === trackNum) return;
    
    // Move segment to new track
    const newTimeline = session.timeline.map(seg => {
      if (seg.id === draggedSegmentId) {
        return { ...seg, track: trackNum };
      }
      return seg;
    });
    
    const updatedSession = {
      ...session,
      timeline: newTimeline,
      undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    sessionManager.saveSession(sessionId, updatedSession);
    
    setDraggedSegmentId(null);
    setDragOverSegmentId(null);
    setDragOverPosition(null);
  };

  const handleTrackDragOver = (e: React.DragEvent) => {
    if (!draggedSegmentId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleTimelineDragOver = (e: React.DragEvent) => {
    if (!draggedSegmentId || !session || !timelineRef.current) return;
    
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const rect = timelineRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const percentage = mouseX / rect.width;
    const timePosition = percentage * session.duration;
    
    setDragOverPosition(timePosition);
  };

  const handleTimelineDrop = (e: React.DragEvent) => {
    e.preventDefault();
    
    if (!draggedSegmentId || !session || !timelineRef.current || dragOverPosition === null) return;
    
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    if (!draggedSegment) return;
    
    // Find the position to insert the segment based on drop position
    const sortedSegments = [...session.timeline]
      .filter(seg => seg.id !== draggedSegmentId)
      .sort((a, b) => a.sourceStart - b.sourceStart);
    
    let newOrder = 0;
    for (let i = 0; i < sortedSegments.length; i++) {
      if (dragOverPosition < sortedSegments[i].sourceStart) {
        newOrder = i;
        break;
      }
      newOrder = i + 1;
    }
    
    // Reorder all segments
    const reorderedTimeline = sortedSegments
      .slice(0, newOrder)
      .concat([draggedSegment])
      .concat(sortedSegments.slice(newOrder))
      .map((seg, index) => ({ ...seg, order: index }));
    
    // Recalculate timeline positions
    let cumulativeTime = 0;
    const adjustedTimeline = reorderedTimeline.map(seg => {
      const adjusted = { ...seg, timelineStart: cumulativeTime };
      cumulativeTime += seg.duration;
      return adjusted;
    });
    
    const updatedSession = {
      ...session,
      timeline: adjustedTimeline,
      undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    sessionManager.saveSession(sessionId, updatedSession);
    
    setDraggedSegmentId(null);
    setDragOverPosition(null);
  };

  const getClipColor = (index: number) => {
    const colors = [
      '#4a90e2', // Blue
      '#2ecc71', // Green  
      '#e74c3c', // Red
      '#f39c12', // Orange
      '#9b59b6', // Purple
      '#1abc9c', // Teal
      '#e67e22', // Dark Orange
      '#34495e', // Dark Blue Gray
      '#16a085', // Dark Teal
      '#27ae60', // Dark Green
    ];
    const color = colors[index % colors.length];
    logger.debug(`Clip color assignment - Index ${index} -> Color ${color}`);
    return color;
  };

  // Generate colors for different asset types
  const getAssetColor = (assetKind: string) => {
    const assetColors = {
      photo: '#e67e22', // Orange
      video: '#9b59b6', // Purple
      audio: '#1abc9c', // Teal
    };
    return assetColors[assetKind as keyof typeof assetColors] || '#4a90e2';
  };

  // Asset management functions
  const handleAssetUpload = async (file: File) => {
    if (!file) return;
    
    setUploadingAsset(true);
    
    try {
      // Create a URL for the file
      const url = URL.createObjectURL(file);
      
      // Determine asset type
      let type: 'photo' | 'video' | 'audio' = 'photo';
      if (file.type.startsWith('video/')) type = 'video';
      else if (file.type.startsWith('audio/')) type = 'audio';
      
      // For video/audio, get duration
      let duration = undefined;
      if (type === 'video' || type === 'audio') {
        duration = await getMediaDuration(file);
      }
      
      const newAsset = {
        id: `asset-${Date.now()}`,
        name: file.name,
        type,
        url,
        duration
      };
      
      setAssets(prev => [...prev, newAsset]);
    } catch (error) {
      logger.error('Failed to upload asset:', error);
      alert('Failed to upload asset. Please try again.');
    } finally {
      setUploadingAsset(false);
    }
  };

  const getMediaDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      const element = file.type.startsWith('video/') 
        ? document.createElement('video')
        : document.createElement('audio');
      
      element.preload = 'metadata';
      element.onloadedmetadata = () => {
        resolve(element.duration || 5); // Default 5 seconds for photos
        URL.revokeObjectURL(element.src);
      };
      element.onerror = () => {
        resolve(5); // Default duration on error
        URL.revokeObjectURL(element.src);
      };
      element.src = URL.createObjectURL(file);
    });
  };

  const handleAddAssetToTimeline = (assetId: string) => {
    if (!session) return;
    
    const asset = assets.find(a => a.id === assetId);
    if (!asset) return;
    
    const wasPlaying = isPlaying;
    if (wasPlaying) {
      videoRef.current?.pause();
      setIsPlaying(false);
    }
    
    // Calculate insertion position (at current timeline position)
    const insertPos = currentTime;
    const assetDuration = asset.duration || 5; // Default 5 seconds for photos
    
    // Create new timeline with asset inserted
    const sortedTimeline = [...session.timeline].sort((a, b) => a.order - b.order);
    
    // Find where to insert based on timeline position
    let insertOrder = sortedTimeline.length;
    for (let i = 0; i < sortedTimeline.length; i++) {
      if (insertPos < sortedTimeline[i].timelineStart + sortedTimeline[i].duration) {
        insertOrder = i;
        break;
      }
    }
    
    // Create new asset segment
    const newSegment: TimelineSegment = {
      id: `${asset.id}-${Date.now()}`,
      sourceStart: 0,
      sourceEnd: assetDuration,
      timelineStart: insertPos,
      duration: assetDuration,
      order: insertOrder,
      track: 1, // Default to track 1 (overlay), but user can drag to any track
      name: asset.name,
      assetKind: asset.type,
      assetUrl: asset.url,
      color: getClipColor(insertOrder),
    };
    
    // Reorder existing segments
    const newTimeline = [
      ...sortedTimeline.slice(0, insertOrder).map(seg => ({ ...seg, order: seg.order })),
      newSegment,
      ...sortedTimeline.slice(insertOrder).map(seg => ({ ...seg, order: seg.order + 1 }))
    ];
    
    // Recalculate timeline positions
    let cumulativeTime = 0;
    const adjustedTimeline = newTimeline.map(seg => {
      const adjusted = { ...seg, timelineStart: cumulativeTime };
      cumulativeTime += seg.duration;
      return adjusted;
    });
    
    // Update session state AND the ref immediately so the engine sees the new timeline
    const updatedSession = {
      ...session,
      timeline: adjustedTimeline,
      undoStack: [...session.undoStack, { type: 'ADD_ASSET' as const, previousTimeline: session.timeline }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    sessionRef.current = updatedSession;
    sessionManager.saveSession(sessionId, updatedSession);
    
    // Switch to the new asset segment
    if (videoRef.current) {
      videoRef.current.currentTime = insertPos;
      setCurrentTime(insertPos);
      if (wasPlaying) {
        setTimeout(() => setIsPlaying(true), 100);
      }
    }
  };

  const handleRemoveAsset = (assetId: string) => {
    const asset = assets.find(a => a.id === assetId);
    if (asset) {
      URL.revokeObjectURL(asset.url);
      setAssets(prev => prev.filter(a => a.id !== assetId));
    }
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

  const handleExport = async () => {
    logger.operation("Export process started");
    
    if (!session || session.timeline.length === 0) {
      alert('No clips to export.');
      return;
    }

    // CRITICAL: Use CURRENT session.timeline state (reflects all AI edits)
    const sortedTimeline = [...session.timeline].sort((a, b) => a.order - b.order);
    
    logger.debug("Export timeline state:", {
      totalClips: sortedTimeline.length,
      clips: sortedTimeline.map(seg => ({
        id: seg.id,
        order: seg.order,
        start: seg.sourceStart,
        end: seg.sourceEnd,
        name: seg.name || 'Unnamed'
      }))
    });

    // Map timeline segments to export format
    const clips = sortedTimeline.map((seg, index) => {
      const clip: any = {
        start: seg.timelineStart ?? 0,     // Timeline position (for sequencing)
        end: (seg.timelineStart ?? 0) + seg.duration,  // Timeline position (for sequencing)
        title: seg.name || `Clip ${index + 1}`,
        id: seg.id
      };
      
      // Handle merged clips with segments
      if (seg.isMerged && seg.segments) {
        logger.debug(`Export merged clip ${index + 1} with ${seg.segments.length} segments:`, seg.segments);
        clip.segments = seg.segments; // Pass segments to backend
        clip.isMerged = true;
      } else {
        // Regular clip
        clip.sourceStart = seg.sourceStart;
        clip.sourceEnd = seg.sourceEnd;
      }
      
      logger.debug(`Export mapped clip ${index + 1}:`, clip);
      return clip;
    });

    logger.debug("Export final clips array:", clips);
    logger.operation("Using Remotion export endpoint: /export-with-clips");

    try {
      // Use the new Remotion export endpoint
      const res = await fetch(`/api/videos/${sessionId}/export-with-clips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          clips,
          options: {
            fps: 30,
            width: 1920,
            height: 1080
          }
        }),
      });

      logger.debug("Export response status:", res.status, res.statusText);

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Export failed' }));
        logger.error("Export failed:", err);
        alert(`Export failed: ${err.detail || res.statusText}`);
        return;
      }

      const blob = await res.blob();
      logger.debug("Export blob received:", blob.size, "bytes");
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `edited-${sessionId.substring(0, 8)}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      
      logger.operation("Export download completed successfully");
    } catch (err) {
      logger.error("Export error:", err);
      alert(`Export failed: ${err instanceof Error ? err.message : 'Network error'}`);
    }
  };

  const handleTranscribe = async () => {
    if (!session) return;
    
    setIsTranscribing(true);
    
    try {
      // CRITICAL: Pass current edited clips to transcription
      // This ensures transcript reflects the EDITED timeline, not the original video
      const sortedClips = [...session.timeline].sort((a, b) => a.order - b.order);
      const clips = sortedClips.map(clip => ({
        start: clip.sourceStart,
        end: clip.sourceEnd,
        title: clip.name || `Clip ${clip.order + 1}`
      }));
      
      logger.debug('Transcribe - sending edited clips to backend:', clips);
      
      // Call the real Whisper API backend with edited clips
      const apiClient = new APIClient(); // Use default /api base URL
      const response = await apiClient.transcribeVideo(session.sessionId, clips);
      
      logger.debug('Transcribe response mode:', response.mode || 'unknown');
      logger.debug('Transcribe segments received:', response.segments?.length || 0);
      
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
      
      const transcriptSegments = response.segments && response.segments.length > 0
        ? response.segments.map((seg: any) => ({ start: seg.start, end: seg.end, text: seg.text }))
        : null;
      
      // Create history entry
      const historyEntry = {
        timestamp: Date.now(),
        operation: session.transcript ? 'Re-transcribed' : 'Initial transcription',
        transcript: formattedTranscript,
        segments: transcriptSegments,
      };
      
      const updatedSession = {
        ...session,
        transcript: formattedTranscript,
        transcriptSegments: transcriptSegments,
        transcriptHistory: [...(session.transcriptHistory || []), historyEntry],
      };
      
      setSession(updatedSession);
      await sessionManager.saveSession(sessionId, updatedSession);
      setIsTranscribing(false);
      
      // Hide transcribe button after successful transcription
      setShowTranscribeButton(false);
    } catch (error) {
      logger.error('Transcription failed:', error);
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

  const downloadTranscript = () => {
    logger.debug('Transcript download requested, transcript exists:', !!session?.transcript);
    if (!session?.transcript) {
      logger.warn('No transcript available to download');
      return;
    }
    
    try {
      const blob = new Blob([session.transcript], { type: 'text/plain' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `transcript-${sessionId.substring(0, 8)}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      logger.operation('Transcript download completed');
    } catch (error) {
      logger.error('Transcript download failed:', error);
      alert('Failed to download transcript. Please try again.');
    }
  };

  const toggleEditPanelFullscreen = async () => {
    if (!editPanelRef.current) return;
    
    try {
      if (!document.fullscreenElement) {
        await editPanelRef.current.requestFullscreen();
        setIsEditPanelFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsEditPanelFullscreen(false);
      }
    } catch (error) {
      logger.error('Error toggling fullscreen:', error);
    }
  };

  // Listen for fullscreen changes and keyboard "F" key
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsEditPanelFullscreen(!!document.fullscreenElement);
    };
    
    const handleKeyPress = (e: KeyboardEvent) => {
      // Toggle fullscreen on "F" key press (not when typing in input/textarea)
      if (e.key === 'f' || e.key === 'F') {
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          toggleEditPanelFullscreen();
        }
      }
    };
    
    // Enter fullscreen on mount
    const enterFullscreen = async () => {
      if (editPanelRef.current && !document.fullscreenElement) {
        try {
          await editPanelRef.current.requestFullscreen();
        } catch (error) {
          logger.debug('Could not enter fullscreen automatically:', error);
        }
      }
    };
    
    enterFullscreen();
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('keydown', handleKeyPress);
    
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('keydown', handleKeyPress);
    };
  }, [toggleEditPanelFullscreen]);

  const toggleTranscriptionVisibility = () => {
    logger.debug('Toggle transcript visibility:', transcriptionVisible, '->', !transcriptionVisible);
    setTranscriptionVisible(!transcriptionVisible);
  };

  const handleAiEdit = async () => {
    if (!session || !aiPrompt.trim()) return;

    const userMessage = aiPrompt.trim();
    
    // CRITICAL: Check if transcript is required for this command
    const contentBasedKeywords = [
      'about', 'mention', 'discuss', 'talk', 'say', 'explain',
      'describe', 'topic', 'subject', 'content', 'word', 'phrase',
      'name the clips', 'title', 'label'
    ];
    
    const isContentBased = contentBasedKeywords.some(keyword => 
      userMessage.toLowerCase().includes(keyword)
    );
    
    // Check if transcript exists
    const hasTranscript = session.transcript && session.transcript.trim().length > 0;
    const hasTranscriptSegments = session.transcriptSegments && session.transcriptSegments.length > 0;
    
    logger.debug('AI edit transcript check:', {
      hasTranscript,
      hasTranscriptSegments,
      isContentBased,
      command: userMessage
    });
    
    // Require transcript for content-based commands
    if (isContentBased && !hasTranscript && !hasTranscriptSegments) {
      setAiError('Transcript required for content-based editing. Please generate transcript first.');
      setChatMessages(prev => [...prev, 
        { role: 'user', content: userMessage },
        { 
          role: 'assistant', 
          content: '⚠️ Transcript required for this command. Please click "Transcribe Video" first, then try again.' 
        }
      ]);
      setIsAiEditing(false);
      return;
    }
    
    // Warn if transcript is missing for other commands
    if (!hasTranscript && !hasTranscriptSegments) {
      logger.warn('AI edit - no transcript available, working with clip titles only');
    }
    
    setAiPrompt('');
    setIsAiEditing(true);
    setAiError(null);

    // Append user message immediately so it shows in chat
    setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);

    try {
      // Read from ref — always the latest committed state, not the stale closure value
      const currentSession = sessionRef.current;
      if (!currentSession) throw new Error('Session not available.');

      // Guard: nothing to work with
      if (currentSession.timeline.length === 0) {
        setChatMessages(prev => [...prev, { role: 'assistant', content: 'No clips left to edit.' }]);
        return;
      }

      // Build one segment per user-defined clip using CURRENT timeline state
      const sortedClips = [...currentSession.timeline].sort((a, b) => a.order - b.order);
      const transcriptSegs = currentSession.transcriptSegments || [];

      const segments = sortedClips.map((clip, i) => {
        const overlapping = transcriptSegs.filter(
          ts => ts.end > clip.sourceStart && ts.start < clip.sourceEnd
        );
        // Ensure text is never empty — fall back to title then generic label
        const combinedText = overlapping.map(ts => ts.text.trim()).join(' ').trim()
          || clip.name?.trim()
          || `Clip ${i + 1}`;

        return {
          index: i + 1,                          // always 1-based, reindexed after mutations
          start: clip.sourceStart ?? 0,
          end: clip.sourceEnd ?? 0,
          title: clip.name?.trim() || `Clip ${i + 1}`,
          text: combinedText,
        };
      });

      logger.debug('AI edit - clips sent to AI:', segments);

      const apiClient = new APIClient(); // Use default /api base URL
      const response = await apiClient.editWithAI(sessionId, userMessage, segments);
      
      // ROBUSTNESS LAYER: Backend now returns enhanced response
      const actions: Array<Record<string, any>> = response.actions || [];
      const backendClips = (response as any).clips || null;  // NEW: Backend-validated clips
      const operations = (response as any).operations || [];  // NEW: Structured operations
      const warnings = (response as any).warnings || [];      // NEW: Non-fatal warnings
      
      logger.debug('AI edit backend operations:', operations);
      logger.debug('AI edit backend warnings:', warnings);

      // If backend provided validated clips, use them directly (source of truth)
      let updatedTimeline: typeof currentSession.timeline;
      
      if (backendClips && backendClips.length > 0) {
        // Backend returned authoritative clips — map to timeline format
        updatedTimeline = backendClips.map((clip: any, i: number) => {
          // Handle merged clips with segments
          if (clip.segments && Array.isArray(clip.segments)) {
            logger.debug('AI edit - processing merged clip with segments:', clip.id, clip.segments);
            
            // For merged clips, calculate total duration from segments
            const totalDuration = clip.segments.reduce((sum: number, seg: any) => sum + seg.duration, 0);
            
            return {
              id: clip.id || `clip-${i + 1}`,
              sourceStart: clip.segments[0].sourceStart, // Use first segment's start
              sourceEnd: clip.segments[clip.segments.length - 1].sourceEnd, // Use last segment's end
              timelineStart: 0,  // Will recalculate below
              duration: totalDuration,
              order: i,
              name: clip.title || clip.name || `Clip ${i + 1}`,
              segments: clip.segments, // Preserve segments for export
              isMerged: true, // Mark as merged clip
            };
          } else {
            // Regular clip
            return {
              id: clip.id || `clip-${i + 1}`,
              sourceStart: clip.sourceStart ?? clip.start ?? 0,
              sourceEnd: clip.sourceEnd ?? clip.end ?? 0,
              timelineStart: 0,  // Will recalculate below
              duration: (clip.sourceEnd ?? clip.end ?? 0) - (clip.sourceStart ?? clip.start ?? 0),
              order: i,
              name: clip.title || clip.name || `Clip ${i + 1}`,
            };
          }
        });
        
        // Recalculate timeline positions and ensure colors are assigned
        let cumulativeTime = 0;
        updatedTimeline = updatedTimeline.map((seg, index) => {
          const adjusted = { 
            ...seg, 
            timelineStart: cumulativeTime,
            color: seg.color || getClipColor(index), // Ensure color is assigned
            track: seg.track !== undefined ? seg.track : 0 // Ensure track is assigned
          };
          cumulativeTime += seg.duration;
          return adjusted;
        });
        
        logger.debug('AI edit - backend clips processed, timeline updated:', updatedTimeline.map(seg => ({
          id: seg.id,
          name: seg.name,
          sourceStart: seg.sourceStart,
          sourceEnd: seg.sourceEnd,
          timelineStart: seg.timelineStart,
          duration: seg.duration,
          order: seg.order,
          color: seg.color,
          track: seg.track
        })));
      } else {
        // Fallback: Apply actions client-side (backward compatibility)
        updatedTimeline = [...currentSession.timeline];
        const summaryParts: string[] = [];

        for (const action of actions) {
          const sorted = [...updatedTimeline].sort((a, b) => a.order - b.order);

          if (action.type === 'name_clips' && Array.isArray(action.clips)) {
            for (const clip of action.clips) {
              const idx = (clip.index as number) - 1;
              if (sorted[idx]) {
                const segId = sorted[idx].id;
                updatedTimeline = updatedTimeline.map(seg =>
                  seg.id === segId ? { ...seg, name: clip.title } : seg
                );
              }
            }
            summaryParts.push(`Renamed ${action.clips.length} clip${action.clips.length !== 1 ? 's' : ''}`);

          } else if (action.type === 'cut' && action.clip_index != null) {
            const idx = (action.clip_index as number) - 1;
            if (sorted[idx] && updatedTimeline.length > 1) {
              const clipName = sorted[idx].name || `Clip ${idx + 1}`;
              const segId = sorted[idx].id;
              updatedTimeline = updatedTimeline
                .filter(seg => seg.id !== segId)
                .map((seg, i) => ({ ...seg, order: i }));
              let t = 0;
              updatedTimeline = updatedTimeline.map(seg => { const s = { ...seg, timelineStart: t }; t += seg.duration; return s; });
              summaryParts.push(`Deleted "${clipName}"`);
            }

          } else if (action.type === 'cut_time' && action.start != null && action.end != null) {
            const cutStart = action.start as number;
            const cutEnd = action.end as number;
            const newSegments: typeof updatedTimeline = [];

            for (const seg of updatedTimeline) {
              const s = seg.sourceStart;
              const e = seg.sourceEnd;

              if (e <= cutStart || s >= cutEnd) {
                newSegments.push(seg);
              } else if (s >= cutStart && e <= cutEnd) {
                // Delete
              } else if (s < cutStart && e > cutEnd) {
                const left = {
                  ...seg,
                  id: `${seg.id}-L`,
                  sourceEnd: cutStart,
                  duration: cutStart - s,
                };
                const right = {
                  ...seg,
                  id: `${seg.id}-R`,
                  sourceStart: cutEnd,
                  duration: e - cutEnd,
                };
                newSegments.push(left, right);
              } else if (s < cutStart) {
                newSegments.push({ ...seg, sourceEnd: cutStart, duration: cutStart - s });
              } else {
                newSegments.push({ ...seg, sourceStart: cutEnd, duration: e - cutEnd });
              }
            }

            let t = 0;
            updatedTimeline = newSegments
              .map((seg, i) => ({ ...seg, order: i }))
              .map(seg => { const s = { ...seg, timelineStart: t }; t += seg.duration; return s; });

            const fmt = (sec: number) => {
              const m = Math.floor(sec / 60);
              const s2 = Math.floor(sec % 60).toString().padStart(2, '0');
              return `${m}:${s2}`;
            };
            summaryParts.push(`Deleted section from ${fmt(cutStart)} to ${fmt(cutEnd)}`);

          } else if (action.type === 'keep' && Array.isArray(action.clip_indexes)) {
            const keepIndexes = new Set((action.clip_indexes as number[]).map(n => n - 1));
            const toKeep = sorted.filter((_, i) => keepIndexes.has(i));
            if (toKeep.length > 0) {
              const keepIds = new Set(toKeep.map(s => s.id));
              updatedTimeline = updatedTimeline
                .filter(seg => keepIds.has(seg.id))
                .map((seg, i) => ({ ...seg, order: i }));
              let t = 0;
              updatedTimeline = updatedTimeline.map(seg => { const s = { ...seg, timelineStart: t }; t += seg.duration; return s; });
              summaryParts.push(`Kept clips ${(action.clip_indexes as number[]).join(', ')}`);
            }

          } else if (action.type === 'merge' && Array.isArray(action.clip_indexes) && action.clip_indexes.length >= 2) {
            const mergeIndexes = (action.clip_indexes as number[]).map(n => n - 1).sort((a, b) => a - b);
            const toMerge = mergeIndexes.map(i => sorted[i]).filter(Boolean);
            if (toMerge.length >= 2) {
              const mergeIds = new Set(toMerge.map(s => s.id));
              
              // FIXED: Proper merge logic - create one continuous clip
              // Sort clips by their source timeline position
              const sortedToMerge = toMerge.sort((a, b) => a.sourceStart - b.sourceStart);
              
              const merged = {
                ...sortedToMerge[0], // Use first clip as base
                id: `merged-${sortedToMerge.map(s => s.id).join('-')}`,
                sourceStart: sortedToMerge[0].sourceStart, // Start from first clip
                sourceEnd: sortedToMerge[sortedToMerge.length - 1].sourceEnd, // End at last clip
                duration: sortedToMerge[sortedToMerge.length - 1].sourceEnd - sortedToMerge[0].sourceStart, // Total span
                name: sortedToMerge.map(s => s.name || `Clip ${s.order + 1}`).join(' + '),
                order: sortedToMerge[0].order, // Keep original order of first clip
                color: sortedToMerge[0].color, // Keep color of first clip
                track: sortedToMerge[0].track, // Keep track of first clip
              };
              
              logger.debug('Merge operation - merging clips:', sortedToMerge.map(c => ({
                id: c.id, 
                name: c.name, 
                sourceStart: c.sourceStart, 
                sourceEnd: c.sourceEnd,
                duration: c.duration
              })));
              logger.debug('Merge operation result:', {
                id: merged.id,
                name: merged.name,
                sourceStart: merged.sourceStart,
                sourceEnd: merged.sourceEnd,
                duration: merged.duration
              });
              
              // Remove original clips and add merged clip
              updatedTimeline = [
                ...updatedTimeline.filter(seg => !mergeIds.has(seg.id)),
                merged,
              ]
                .sort((a, b) => a.order - b.order)
                .map((seg, i) => ({ ...seg, order: i })); // Reorder all clips
              
              // Recalculate timeline positions
              let t = 0;
              updatedTimeline = updatedTimeline.map(seg => { 
                const s = { ...seg, timelineStart: t }; 
                t += seg.duration; 
                return s; 
              });
              
              summaryParts.push(`Merged ${toMerge.length} clips into "${merged.name}"`);
            }
          }
        }
      }

      // CHANGED: Always preserve the original transcript for the session
      // The transcript represents the original full video content and should remain available
      // for reference, download, and hide/show functionality throughout the session
      logger.debug('AI edit - preserving original transcript after AI operations');
      
      // Build updated session - always preserve original transcript
      const updatedSession = { 
        ...currentSession, 
        timeline: updatedTimeline,
        // PRESERVE: Keep original transcript and segments for reference
        transcript: currentSession.transcript, // Always keep original
        transcriptSegments: currentSession.transcriptSegments, // Always keep original
        // FIXED: Add AI edit operation to undo stack
        undoStack: [...currentSession.undoStack, { 
          type: 'AI_EDIT' as const, 
          previousTimeline: currentSession.timeline,
          previousTranscript: currentSession.transcript,
          previousTranscriptSegments: currentSession.transcriptSegments,
          prompt: userMessage,
          operations: operations
        }],
        redoStack: [], // Clear redo stack when new action is performed
        lastModified: Date.now()
      };
      setSession(updatedSession);
      sessionRef.current = updatedSession;
      await sessionManager.saveSession(sessionId, updatedSession);
      
      logger.operation('AI edit session updated with', updatedSession.timeline.length, 'clips');
      
      // Force timeline refresh by triggering a re-render
      setTimeout(() => {
        logger.debug('AI edit - timeline refresh triggered');
        setCurrentTime(prev => prev); // Trigger re-render
      }, 100);

      // Build assistant reply
      let reply = '';
      if (operations.length > 0) {
        reply = 'Done! Your video has been edited.';
      } else {
        reply = 'No changes were needed for that instruction.';
      }

      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }]);

    } catch (err) {
      logger.error('AI edit failed:', err);
      const errMsg = err instanceof Error ? err.message : 'AI edit failed. Please try again.';
      setAiError(errMsg);
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${errMsg}` }]);
    } finally {
      setIsAiEditing(false);
    }
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
        logger.debug('Could not resume playback');
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
    <div className="editor-page" ref={editPanelRef}>
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
            {/* Conditionally render Remotion preview or native video player */}
            {showRemotionPreview && compositionSchema ? (
              <RemotionPreview
                composition={compositionSchema}
                currentTime={currentTime}
                onTimeUpdate={setCurrentTime}
                onError={(error) => {
                  logger.error('Remotion preview error:', error);
                  setShowRemotionPreview(false);
                }}
              />
            ) : (
              <video
                key={sessionId}
                ref={videoRef}
                src={session.videoUrl}
                controls
                className="video-element"
                preload="metadata"
                onLoadedMetadata={() => {
                  const video = videoRef.current;
                  if (!video || !session.timeline.length) return;
                  const first = [...session.timeline].sort((a, b) => a.order - b.order)[0];
                  logger.debug('Video onLoadedMetadata - snapping to first clip:', first.sourceStart);
                  isJumpingRef.current = true;
                  video.currentTime = first.sourceStart;
                  setCurrentTime(first.sourceStart);
                  currentClipIndexRef.current = 0;
                  setTimeout(() => { isJumpingRef.current = false; }, 150);
                }}
                onError={(e) => {
                  logger.error('Video error loading video:', e);
                }}
                onLoadStart={() => {
                  logger.debug('Video load started');
                }}
                onCanPlay={() => {
                  logger.debug('Video can play');
                }}
              >
                Your browser does not support the video tag.
              </video>
            )}
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
            <div className={`timeline-content ${isDraggingPlayhead ? 'dragging' : ''}`} 
                 ref={timelineRef} 
                 onClick={handleTimelineClick}
                 onDragOver={handleTimelineDragOver}
                 onDrop={handleTimelineDrop}>
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
              
              {/* Multiple tracks - All can contain any type of content */}
              {[0, 1, 2].map(trackNum => (
                <div 
                  key={trackNum} 
                  className="timeline-track" 
                  data-track={trackNum} 
                  style={{ position: 'relative', height: '80px', borderBottom: '1px solid #2d2d44' }}
                  onDragOver={handleTrackDragOver}
                  onDrop={(e) => handleTrackDrop(trackNum, e)}
                >
                  {/* Track label */}
                  <div className="track-label-inline" style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5, pointerEvents: 'none', zIndex: 1 }}>
                    Track {trackNum + 1}
                  </div>
                  
                  {/* Show deleted sections in gray (only for track 0) */}
                  {trackNum === 0 && getDeletedSections().map((section, index) => (
                    <div
                      key={`deleted-${index}`}
                      className="timeline-deleted"
                      style={{
                        left: `${(section.start / session.duration) * 100}%`,
                        width: `${(section.duration / session.duration) * 100}%`,
                      }}
                    />
                  ))}
                  
                  {/* Show segments for this track */}
                  {session.timeline
                    .filter(seg => seg.track === trackNum)
                    .sort((a, b) => a.order - b.order)
                    .map((segment) => {
                      // Calculate position based on order in timeline
                      // FIXED: Use the segment's timelineStart property directly, with fallback calculation
                      let timelineStart = segment.timelineStart ?? 0;
                      
                      // Fallback: calculate if timelineStart is not set properly
                      if (timelineStart === 0 && segment.order > 0) {
                        const sortedSegments = session.timeline
                          .filter(s => s.track === trackNum)
                          .sort((a, b) => a.order - b.order);
                        
                        timelineStart = sortedSegments
                          .filter(s => s.order < segment.order)
                          .reduce((sum, s) => sum + s.duration, 0);
                      }
                      
                      // Calculate total duration for this track only
                      const totalDuration = Math.max(
                        session.timeline
                          .filter(s => s.track === trackNum)
                          .reduce((sum, s) => sum + s.duration, 0),
                        session.duration || 1 // Prevent division by zero
                      );
                      
                      const leftPercent = (timelineStart / totalDuration) * 100;
                      const widthPercent = (segment.duration / totalDuration) * 100;
                      
                      logger.debug(`Timeline render segment ${segment.id}:`, {
                        name: segment.name,
                        timelineStart,
                        duration: segment.duration,
                        totalDuration,
                        leftPercent,
                        widthPercent,
                        color: segment.color,
                        track: segment.track
                      });
                      
                      return (
                        <div
                          key={segment.id}
                          className={`timeline-segment ${selectedSegmentId === segment.id ? 'selected' : ''} ${draggedSegmentId === segment.id ? 'dragging' : ''} ${dragOverSegmentId === segment.id ? 'drag-over' : ''} ${segment.assetKind ? `asset-${segment.assetKind}` : ''} ${segment.isMerged ? 'merged' : ''}`}
                          style={{
                            left: `${leftPercent}%`,
                            width: `${widthPercent}%`,
                            backgroundColor: segment.assetKind ? getAssetColor(segment.assetKind) : (segment.color || getClipColor(segment.order)),
                            cursor: 'move',
                            transition: draggedSegmentId ? 'none' : 'all 0.3s ease',
                          }}
                          onClick={(e) => handleSegmentClick(segment.id, e)}
                          draggable={true}
                          onDragStart={(e) => handleSegmentDragStart(segment.id, e)}
                          onDragEnd={handleSegmentDragEnd}
                          onDragOver={(e) => handleSegmentDragOver(segment.id, e)}
                          onDragLeave={(e) => handleSegmentDragLeave(segment.id, e)}
                          onDrop={(e) => handleSegmentDrop(segment.id, e)}
                        >
                          <span className="segment-label">
                            {segment.assetKind && (
                              <span className={`asset-icon asset-${segment.assetKind}`}>
                                {segment.assetKind === 'photo' && '🖼️'}
                                {segment.assetKind === 'video' && '🎥'}
                                {segment.assetKind === 'audio' && '🎵'}
                              </span>
                            )}
                            {segment.isMerged && (
                              <span className="merged-icon" title="Merged clip">
                                🔗
                              </span>
                            )}
                            {segment.name || `Clip ${segment.order + 1}`}
                          </span>
                        </div>
                      );
                    })}
                </div>
              ))}
              
              {/* Playhead spans all tracks */}
              <div
                className={`timeline-playhead ${isDraggingPlayhead ? 'dragging' : ''}`}
                style={{
                  left: `${(currentTime / session.duration) * 100}%`,
                  height: '240px', // Span all 3 tracks
                }}
                onMouseDown={handlePlayheadMouseDown}
              />
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
                        style={{
                          borderLeftColor: segment.color,
                          borderLeftWidth: '4px'
                        }}
                      >
                        <div className="clip-header">
                          <div className="clip-color-indicator" style={{ backgroundColor: segment.assetKind ? getAssetColor(segment.assetKind) : segment.color }}></div>
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
                          {segment.assetKind ? (
                            <span className={`clip-kind-badge ${segment.assetKind}`}>
                              {segment.assetKind === 'photo' && '🖼️ Photo'}
                              {segment.assetKind === 'video' && '🎥 Video'}
                              {segment.assetKind === 'audio' && '🎵 Audio'}
                            </span>
                          ) : segment.isMerged ? (
                            <span className="clip-kind-badge merged" style={{ background: '#f39c12', color: 'white' }}>
                              🔗 Merged ({segment.segments?.length || 0} parts)
                            </span>
                          ) : (
                            `${formatTime(segment.sourceStart)} - ${formatTime(segment.sourceEnd)}`
                          )}
                          <span className="clip-track-badge" style={{ marginLeft: '8px', padding: '2px 6px', background: '#2d2d44', borderRadius: '3px', fontSize: '0.7rem' }}>
                            Track {segment.track + 1}
                          </span>
                        </div>
                        <div className="clip-actions">
                          {/* Track change buttons */}
                          <div style={{ display: 'flex', gap: '4px', marginRight: '8px' }}>
                            {segment.track > 0 && (
                              <button
                                className="btn-small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const newTimeline = session.timeline.map(seg => 
                                    seg.id === segment.id ? { ...seg, track: segment.track - 1 } : seg
                                  );
                                  const updatedSession = { ...session, timeline: newTimeline };
                                  setSession(updatedSession);
                                  sessionManager.saveSession(sessionId, updatedSession);
                                }}
                                title="Move to track above"
                              >
                                ↑
                              </button>
                            )}
                            {segment.track < 2 && (
                              <button
                                className="btn-small"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const newTimeline = session.timeline.map(seg => 
                                    seg.id === segment.id ? { ...seg, track: segment.track + 1 } : seg
                                  );
                                  const updatedSession = { ...session, timeline: newTimeline };
                                  setSession(updatedSession);
                                  sessionManager.saveSession(sessionId, updatedSession);
                                }}
                                title="Move to track below"
                              >
                                ↓
                              </button>
                            )}
                          </div>
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
                {/* Enhanced Transcribe Section */}
                <div className="enhanced-transcribe-section">
                  <div className="transcribe-header">
                    <h3 className="panel-title">AI Transcription</h3>
                  </div>
                  
                  <p className="panel-description">
                    Generate and edit video transcript with AI assistance
                  </p>
                  
                  <div className="transcribe-action-bar">
                    <div className="transcribe-button-container" style={{ display: 'flex', gap: '0.5rem', width: '100%', alignItems: 'center' }}>
                      <button
                        className="btn-transcript-action-small"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          logger.debug('Transcript hide/show button clicked, current state:', transcriptionVisible);
                          toggleTranscriptionVisibility();
                        }}
                        disabled={!session.transcript}
                        title={session.transcript ? (transcriptionVisible ? "Hide transcript" : "Show transcript") : "Transcribe first"}
                        style={{
                          padding: '0.5rem',
                          background: session.transcript ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 100, 100, 0.1)',
                          border: session.transcript ? '1.5px solid #10b981' : '1.5px solid #555',
                          borderRadius: '8px',
                          color: session.transcript ? '#10b981' : '#888',
                          cursor: session.transcript ? 'pointer' : 'not-allowed',
                          transition: 'all 0.2s ease',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: '36px',
                          minHeight: '36px',
                          opacity: session.transcript ? 1 : 0.5,
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          {transcriptionVisible ? (
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/>
                          ) : (
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>
                          )}
                        </svg>
                      </button>
                      <button
                        className="btn-transcribe-pro"
                        onClick={handleTranscribe}
                        disabled={isTranscribing || !showTranscribeButton}
                        style={{ 
                          flex: 1,
                          minHeight: '36px',
                          height: '36px',
                          padding: '0 1rem',
                          opacity: showTranscribeButton ? 1 : 0.7,
                        }}
                      >
                        <div className="btn-content" style={{ padding: '0' }}>
                          <span style={{ fontSize: '0.9rem' }}>
                            {isTranscribing 
                              ? 'Processing Transcription...' 
                              : showTranscribeButton 
                                ? 'Transcribe Video' 
                                : '✓ Transcription Complete'
                            }
                          </span>
                        </div>
                        {isTranscribing && (
                          <div className="loading-bar">
                            <div className="loading-progress"></div>
                          </div>
                        )}
                      </button>
                      <button
                        className="btn-transcript-action-small"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          logger.debug('Transcript download button clicked, transcript exists:', !!session?.transcript);
                          downloadTranscript();
                        }}
                        disabled={!session.transcript}
                        title={session.transcript ? "Download transcript" : "Transcribe first to download"}
                        style={{
                          padding: '0.5rem',
                          background: session.transcript ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 100, 100, 0.1)',
                          border: session.transcript ? '1.5px solid #10b981' : '1.5px solid #555',
                          borderRadius: '8px',
                          color: session.transcript ? '#10b981' : '#888',
                          cursor: session.transcript ? 'pointer' : 'not-allowed',
                          transition: 'all 0.2s ease',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: '36px',
                          minHeight: '36px',
                          opacity: session.transcript ? 1 : 0.5,
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="7,10 12,15 17,10"/>
                          <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                  
                  {/* Collapsible Transcript Area */}
                  {transcriptionVisible && (
                    <div className="transcript-area-enhanced">
                      {session.transcript ? (
                        <div className="transcript-container">
                          <label className="transcript-label">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                              <polyline points="14,2 14,8 20,8"/>
                              <line x1="16" y1="13" x2="8" y2="13"/>
                              <line x1="16" y1="17" x2="8" y2="17"/>
                              <polyline points="10,9 9,9 8,9"/>
                            </svg>
                            Original Video Transcript
                            <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: '0.5rem' }}>
                              (Available throughout session)
                            </span>
                          </label>
                          <textarea
                            className="transcript-text-enhanced"
                            value={session.transcript}
                            onChange={handleTranscriptChange}
                            placeholder="Edit your transcript here..."
                            rows={8}
                          />
                          <div className="transcript-stats">
                            <span>{session.transcript.length} characters</span>
                            <span>{session.transcript.split(/\s+/).filter(w => w.length > 0).length} words</span>
                          </div>
                          
                          {/* Transcript History */}
                          {session.transcriptHistory && session.transcriptHistory.length > 0 && (
                            <div style={{ marginTop: '1.5rem' }}>
                              <label className="transcript-label" style={{ marginBottom: '0.75rem' }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="12" cy="12" r="10"/>
                                  <polyline points="12,6 12,12 16,14"/>
                                </svg>
                                Transcript History ({session.transcriptHistory.length})
                              </label>
                              <div style={{
                                maxHeight: '300px',
                                overflowY: 'auto',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.75rem',
                              }}>
                                {[...session.transcriptHistory].reverse().map((entry, idx) => (
                                  <div key={idx} style={{
                                    padding: '0.75rem',
                                    background: 'rgba(100, 100, 100, 0.1)',
                                    border: '1px solid rgba(100, 100, 100, 0.2)',
                                    borderRadius: '8px',
                                  }}>
                                    <div style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      marginBottom: '0.5rem',
                                      fontSize: '0.85rem',
                                      color: '#10b981',
                                    }}>
                                      <span style={{ fontWeight: 600 }}>{entry.operation}</span>
                                      <span style={{ fontSize: '0.75rem', color: '#888' }}>
                                        {new Date(entry.timestamp).toLocaleString()}
                                      </span>
                                    </div>
                                    <div style={{
                                      fontSize: '0.8rem',
                                      color: '#ccc',
                                      maxHeight: '100px',
                                      overflowY: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      padding: '0.5rem',
                                      background: 'rgba(0, 0, 0, 0.2)',
                                      borderRadius: '4px',
                                    }}>
                                      {entry.transcript.substring(0, 300)}
                                      {entry.transcript.length > 300 && '...'}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="transcript-empty-state">
                          <div className="empty-icon">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                              <line x1="12" y1="19" x2="12" y2="23"/>
                              <line x1="8" y1="23" x2="16" y2="23"/>
                            </svg>
                          </div>
                          <h4>No transcript available</h4>
                          <p>Click "Transcribe Video" to generate an AI-powered transcript of your video content</p>
                          
                          {/* Show history even when no current transcript */}
                          {session.transcriptHistory && session.transcriptHistory.length > 0 && (
                            <div style={{ marginTop: '1.5rem', width: '100%' }}>
                              <label className="transcript-label" style={{ marginBottom: '0.75rem' }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="12" cy="12" r="10"/>
                                  <polyline points="12,6 12,12 16,14"/>
                                </svg>
                                Previous Transcripts ({session.transcriptHistory.length})
                              </label>
                              <div style={{
                                maxHeight: '300px',
                                overflowY: 'auto',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.75rem',
                              }}>
                                {[...session.transcriptHistory].reverse().map((entry, idx) => (
                                  <div key={idx} style={{
                                    padding: '0.75rem',
                                    background: 'rgba(100, 100, 100, 0.1)',
                                    border: '1px solid rgba(100, 100, 100, 0.2)',
                                    borderRadius: '8px',
                                  }}>
                                    <div style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      marginBottom: '0.5rem',
                                      fontSize: '0.85rem',
                                      color: '#10b981',
                                    }}>
                                      <span style={{ fontWeight: 600 }}>{entry.operation}</span>
                                      <span style={{ fontSize: '0.75rem', color: '#888' }}>
                                        {new Date(entry.timestamp).toLocaleString()}
                                      </span>
                                    </div>
                                    <div style={{
                                      fontSize: '0.8rem',
                                      color: '#ccc',
                                      maxHeight: '100px',
                                      overflowY: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      padding: '0.5rem',
                                      background: 'rgba(0, 0, 0, 0.2)',
                                      borderRadius: '4px',
                                    }}>
                                      {entry.transcript.substring(0, 300)}
                                      {entry.transcript.length > 300 && '...'}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* AI Chat Section */}
                <div className="ai-chat-section">
                  <h4 className="panel-title" style={{ marginTop: '1.5rem' }}>AI Editor</h4>
                  <p className="panel-description">Give instructions to edit your clips</p>

                  {/* Message list */}
                  <div style={{
                    height: '250px',
                    minHeight: '250px',
                    maxHeight: '250px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                    marginBottom: '1rem',
                    padding: '0.5rem',
                    background: 'var(--color-surface, #1a1a2e)',
                    borderRadius: '6px',
                    border: '1px solid var(--color-border, #2d2d44)',
                  }}>
                    {chatMessages.map((msg, i) => (
                      <div key={i} style={{
                        alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '85%',
                        padding: '0.4rem 0.7rem',
                        borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                        background: msg.role === 'user' ? 'var(--color-primary, #6c63ff)' : 'var(--color-surface-2, #2d2d44)',
                        fontSize: '0.82rem',
                        lineHeight: '1.4',
                      }}>
                        {msg.content}
                      </div>
                    ))}
                    {isAiEditing && (
                      <div style={{
                        alignSelf: 'flex-start',
                        padding: '0.4rem 0.7rem',
                        borderRadius: '12px 12px 12px 2px',
                        background: 'var(--color-surface-2, #2d2d44)',
                        fontSize: '0.82rem',
                        opacity: 0.6,
                      }}>
                        Thinking…
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                </div>
              </div>
            )}
            
            {activeTab === 'assets' && (
              <div className="tab-panel">
                <h3 className="panel-title">Media Assets</h3>
                <p className="panel-description">
                  Add photos, videos, and audio to your timeline
                </p>
                
                {/* Asset Upload */}
                <div className="asset-upload-section">
                  <input
                    type="file"
                    id="asset-upload"
                    accept="image/*,video/*,audio/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        handleAssetUpload(file);
                        e.target.value = ''; // Reset input
                      }
                    }}
                    style={{ display: 'none' }}
                  />
                  <button
                    className="btn btn-primary btn-full"
                    onClick={() => document.getElementById('asset-upload')?.click()}
                    disabled={uploadingAsset}
                  >
                    {uploadingAsset ? 'Uploading...' : '+ Add Media Asset'}
                  </button>
                </div>

                {/* Assets List */}
                <div className="asset-list">
                  {assets.map((asset) => (
                    <div key={asset.id} className="asset-item">
                      <div className="asset-icon">
                        {asset.type === 'photo' && (
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                            <circle cx="8.5" cy="8.5" r="1.5"/>
                            <polyline points="21,15 16,10 5,21"/>
                          </svg>
                        )}
                        {asset.type === 'video' && (
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="23 7 16 12 23 17 23 7"/>
                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                          </svg>
                        )}
                        {asset.type === 'audio' && (
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 18V5l12-2v13"/>
                            <circle cx="6" cy="18" r="3"/>
                            <circle cx="18" cy="16" r="3"/>
                          </svg>
                        )}
                      </div>
                      <div className="asset-info">
                        <div className="asset-name">{asset.name}</div>
                        <div className="asset-meta">
                          {asset.type} • {asset.duration ? formatTime(asset.duration) : 'Static'}
                        </div>
                      </div>
                      <div className="asset-actions">
                        <button
                          className="btn-small"
                          onClick={() => handleAddAssetToTimeline(asset.id)}
                        >
                          Add to Timeline
                        </button>
                        <button
                          className="btn-small btn-danger-small"
                          onClick={() => handleRemoveAsset(asset.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                  
                  {assets.length === 0 && (
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
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21,15 16,10 5,21"/>
                      </svg>
                      <p>No assets yet</p>
                      <p className="empty-state-hint">
                        Click "Add Media Asset" to upload photos, videos, or audio files
                      </p>
                    </div>
                  )}
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
                    <span>Assets:</span>
                    <span>{assets.length}</span>
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

        {/* Fixed Chat Input at Bottom */}
        {activeTab === 'ai-edit' && (
          <div className="chat-input-fixed">
            <div style={{ display: 'flex', gap: '0.4rem', padding: '1rem' }}>
              <input
                type="text"
                style={{
                  flex: 1,
                  padding: '0.75rem 1rem',
                  borderRadius: '25px',
                  border: '1px solid var(--color-border, #2d2d44)',
                  background: 'var(--color-surface, #1a1a2e)',
                  color: 'inherit',
                  fontSize: '0.9rem',
                }}
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                placeholder="Type your message..."
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handleAiEdit(); }}
                disabled={isAiEditing}
              />
              <button
                className="btn btn-primary"
                onClick={handleAiEdit}
                disabled={isAiEditing || !aiPrompt.trim()}
                style={{ 
                  whiteSpace: 'nowrap',
                  borderRadius: '25px',
                  padding: '0.75rem 1.5rem'
                }}
              >
                Send
              </button>
            </div>
            {aiError && (
              <p style={{ color: '#e53e3e', fontSize: '0.8rem', padding: '0 1rem 1rem', margin: 0 }}>
                {aiError}
              </p>
            )}
          </div>
        )}
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
