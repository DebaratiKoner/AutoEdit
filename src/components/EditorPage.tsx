/**
 * Editor Page Component
 * Main editing interface with video player, timeline, and controls
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SessionManager, CompositionBuilder } from '../services';
import { formatTime, logger } from '../utils';
import LZString from 'lz-string';
import type { SessionData, TimelineSegment, CompositionSchema } from '../types';
import { RemotionPreview } from './RemotionPreview';
import { AssetsTab } from './AssetsTab';
import './EditorPage.css';

interface EditorPageProps {
  sessionId: string;
  onReset?: () => void;
}

export function EditorPage({ sessionId, onReset }: EditorPageProps) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeAssetClip, setActiveAssetClip] = useState<TimelineSegment | null>(null);
  const [activeOverlayClip, setActiveOverlayClip] = useState<TimelineSegment | null>(null);
  const [photoOverlay, setPhotoOverlay] = useState<{ url: string; name: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<'clips' | 'ai-edit' | 'assets'>('clips');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const showRemotionPreview = false;
  const [compositionSchema, setCompositionSchema] = useState<CompositionSchema | null>(null);
  const [draggedSegmentId, setDraggedSegmentId] = useState<string | null>(null);
  const [dragOverSegmentId, setDragOverSegmentId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<number | null>(null);
  const [dragOverSide, setDragOverSide] = useState<'left' | 'right' | null>(null);
  const [resizingSegmentId, setResizingSegmentId] = useState<string | null>(null);
  const [resizeType, setResizeType] = useState<'left' | 'right' | null>(null);
  const [resizeInitialX, setResizeInitialX] = useState<number>(0);
  const [resizeInitialStart, setResizeInitialStart] = useState<number>(0);
  const [resizeInitialDuration, setResizeInitialDuration] = useState<number>(0);
  const [dragOffset, setDragOffset] = useState<number>(0);
  const [isUploadingAsset, setIsUploadingAsset] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertAfterClipIdRef = useRef<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeTimer, setTranscribeTimer] = useState(0);
  const [showTranscript, setShowTranscript] = useState(true);
  const [isAiEditing, setIsAiEditing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [globalVolume, setGlobalVolume] = useState(1); // Global audio volume control (0-1) - only affects audio tracks
  const [aiPrompt, setAiPrompt] = useState('');
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);

  const sessionManager = new SessionManager();

  // LZ Compressor singleton (avoids repeated imports)
  const LZCompressor = {
    compress: (data: string): string => {
      if (data.length > 1024) { // Compress if >1KB
        return LZString.compressToBase64(data);
      }
      return data; // Raw if small
    },
    decompress: (data: string): string => {
      try {
        return LZString.decompressFromBase64(data) || data;
      } catch {
        return data; // Fallback to raw
      }
    },
    isCompressed: (data: string): boolean => {
      return data.length > 1024 && !data.startsWith('{');
    }
  };

  // Phase 4: Full session snapshot → optional LZ compression
  const saveFullSessionSnapshot = useCallback((currentSession: SessionData): string => {
    // Deep clone ALL mutable fields
    const snapshot: SessionData = {
      sessionId: currentSession.sessionId,
      videoUrl: currentSession.videoUrl,
      duration: currentSession.duration,
      resolution: { ...currentSession.resolution },
      timeline: structuredClone(currentSession.timeline),
      transcript: currentSession.transcript,
      transcriptSegments: structuredClone(currentSession.transcriptSegments || []),
      transcriptHistory: structuredClone(currentSession.transcriptHistory || []),
      undoStack: structuredClone(currentSession.undoStack),
      redoStack: structuredClone(currentSession.redoStack),
      lastModified: Date.now(),
    };
    const json = JSON.stringify(snapshot);
    return LZCompressor.compress(json); // Auto-compress large snapshots
  }, []);

  // Phase 4: Restore full snapshot → LZ decompress → parse → validate
  const restoreFullSessionSnapshot = useCallback((snapshotStr: string): SessionData => {
    try {
      let jsonStr = LZCompressor.decompress(snapshotStr);
      const snapshot: SessionData = JSON.parse(jsonStr);
      
      // Safety: Deep clone mutable fields post-parse
      return {
        ...snapshot,
        timeline: structuredClone(snapshot.timeline || []),
        transcriptSegments: structuredClone(snapshot.transcriptSegments || []),
        transcriptHistory: structuredClone(snapshot.transcriptHistory || []),
        undoStack: structuredClone(snapshot.undoStack || []),
        redoStack: structuredClone(snapshot.redoStack || []),
        lastModified: Date.now(), // Update timestamp
      };
    } catch (error) {
      logger.error('Failed to restore snapshot:', error);
      throw new Error(`Invalid snapshot: ${error}`);
    }
  }, []);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const currentClipIndexRef = useRef<number>(0);
  const isJumpingRef = useRef<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const assetVideoRef = useRef<HTMLVideoElement>(null);  // dedicated element for asset clips
  const audioRef = useRef<HTMLAudioElement>(null);       // dedicated element for track-1 audio
  const audioSrcRef = useRef<string>('');                // tracks current audio src
  const audioCtxRef = useRef<AudioContext | null>(null); // Web Audio context for gain > 1
  const gainNodeRef = useRef<GainNode | null>(null);     // GainNode for volume > 100%
  const timelineRef = useRef<HTMLDivElement>(null);
  const editPanelRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionData | null>(null);
  const isSwitchingRef = useRef<boolean>(false);
  const currentSrcRef = useRef<string>('');
  const assetSrcRef = useRef<string>('');               // tracks current asset video src
  const [assetVideoOpacity, setAssetVideoOpacity] = useState(0);
  // photo timer ref
  const photoTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemActionRef = useRef<boolean>(false);
  const isPlayingRef = useRef<boolean>(false);
  const photoElapsedRef = useRef<number>(0);
  const photoStartTimeRef = useRef<number>(0); // performance.now() when photo started playing

  const snapshotImgRef = useRef<HTMLImageElement>(null);

  const handleLocalFileInsert = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !session) return;
    const file = files[0];
    try {
      setIsUploadingAsset(true);
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/assets/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();

      const isAudio = data.assetType === 'audio' || file.type.startsWith('audio/');
      const assetDuration = data.assetType === 'audio'
        ? (data.duration || 300)
        : data.assetType === 'photo'
          ? (data.duration || 1)
          : (data.duration || 3);
      const assetUrl = data.assetUrl || `/api/assets/${data.assetId}/stream`;

      if (isAudio) {
        // Audio → track 1 at current playhead
        const track0Segs = session.timeline.filter(s => s.track === 0);
        const totalDur = track0Segs.reduce((sum, s) => sum + s.duration, 0);
        const insertAt = Math.min(currentTime, totalDur);
        const newSeg: TimelineSegment = {
          id: `local-${Date.now()}`, name: file.name,
          assetUrl, assetKind: 'audio',
          duration: assetDuration, timelineStart: insertAt,
          sourceStart: 0, sourceEnd: assetDuration,
          order: session.timeline.filter(s => s.track === 1).length,
          track: 1, color: getAssetColor('audio'), volume: 1, originalDuration: assetDuration,
        };
        // Phase 4.14: Capture FULL session snapshot BEFORE mutation
        const previousSnapshot = saveFullSessionSnapshot(session);

        setSession({ 
          ...session, 
          timeline: [...session.timeline, newSeg],
          undoStack: [...session.undoStack, { 
            type: 'FULL_SNAPSHOT' as const,
            previousSnapshot,
            actionType: 'ADD_ASSET' as const
          }],
          redoStack: [] 
        });
        return;
      }

      const track0Segs = session.timeline.filter(s => s.track === 0).sort((a, b) => a.order - b.order);
      let newTrack0: TimelineSegment[] = [];

      const newSeg: TimelineSegment = {
        id: `local-${Date.now()}`, name: file.name,
        assetUrl, assetKind: data.assetType === 'video' ? 'video' : 'photo',
        duration: assetDuration, timelineStart: 0,
        sourceStart: 0, sourceEnd: assetDuration,
        order: 0, track: 0, color: getAssetColor(data.assetType || 'video'),
      };

      if (insertAfterClipIdRef.current) {
        // Per-clip Insert button was clicked — insert after that specific clip
        const i = track0Segs.findIndex(s => s.id === insertAfterClipIdRef.current);
        const idx = i >= 0 ? i : track0Segs.length - 1;
        newTrack0 = [
          ...track0Segs.slice(0, idx + 1),
          newSeg,
          ...track0Segs.slice(idx + 1),
        ];
      } else if (selectedSegmentId) {
        // A clip is selected in the sidebar — insert after it
        const i = track0Segs.findIndex(s => s.id === selectedSegmentId);
        const idx = i >= 0 ? i : track0Segs.length - 1;
        newTrack0 = [
          ...track0Segs.slice(0, idx + 1),
          newSeg,
          ...track0Segs.slice(idx + 1),
        ];
      } else {
        let cutMade = false;
        for (let i = 0; i < track0Segs.length; i++) {
          const seg = track0Segs[i];
          const start = seg.timelineStart ?? 0;
          const end = start + seg.duration;
          
          if (currentTime > start + 0.05 && currentTime < end - 0.05) {
            const cutOffset = currentTime - start;
            const sourceCutTime = (seg.sourceStart ?? 0) + cutOffset;
            
            const segment1: TimelineSegment = { ...seg, id: `${seg.id}-1`, sourceEnd: sourceCutTime, duration: cutOffset };
            const segment2: TimelineSegment = { ...seg, id: `${seg.id}-2`, sourceStart: sourceCutTime, duration: seg.duration - cutOffset };
            
            newTrack0 = [
              ...track0Segs.slice(0, i),
              segment1,
              newSeg,
              segment2,
              ...track0Segs.slice(i + 1),
            ];
            cutMade = true;
            break;
          }
        }
        
        if (!cutMade) {
          let insertIdx = track0Segs.length;
          for (let i = 0; i < track0Segs.length; i++) {
            if (currentTime <= (track0Segs[i].timelineStart ?? 0) + 0.05) {
              insertIdx = i;
              break;
            }
          }
          newTrack0 = [
            ...track0Segs.slice(0, insertIdx),
            newSeg,
            ...track0Segs.slice(insertIdx),
          ];
        }
      }

      let t = 0;
    const adjusted = newTrack0.map((s, i) => { 
      const r = { 
        ...s, 
        order: i, 
        timelineStart: t,
        // ✅ FIXED: Preserve custom names (no "Clip N" override)
        name: preserveClipName(s) 
      }; 
      t += s.duration; 
      return r; 
    });
      const others = session.timeline.filter(s => s.track !== 0);
      // Phase 4.14: Capture FULL session snapshot BEFORE mutation
      const previousSnapshot = saveFullSessionSnapshot(session);

      setSession({ 
        ...session, 
        timeline: [...adjusted, ...others],
        undoStack: [...session.undoStack, { 
          type: 'FULL_SNAPSHOT' as const,
          previousSnapshot,
          actionType: 'ADD_ASSET' as const
        }],
        redoStack: [] 
      });
    } catch (err) {
      console.error(err);
      alert('Failed to upload file');
    } finally {
      setIsUploadingAsset(false);
      insertAfterClipIdRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleTranscribe = async () => {
    if (!session) return;
    setIsTranscribing(true);
    try {
      // Send the actual edited timeline clips so Whisper transcribes only kept segments
      // Timestamps are mapped back to timeline positions after transcription
      const track0Clips = session.timeline
        .filter(s => s.track === 0 && !s.assetUrl) // only original video segments
        .sort((a, b) => a.order - b.order)
        .map(s => ({
          start: s.sourceStart ?? 0,
          end: s.sourceEnd ?? s.duration,
          timelineStart: s.timelineStart ?? 0,
        }));

      const response = await fetch(`/api/videos/${sessionId}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: track0Clips.length > 0 ? track0Clips : null,
          quick: false,  // full transcription — audio is compressed to tiny size so it's still fast
        })
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.detail || 'Transcription failed');
      }
      const data = await response.json();

      // Backend already remaps Whisper timestamps to timeline positions.
      // Segments arrive with start/end matching the edited timeline.
      const updatedSession = {
        ...session,
        transcript: data.transcript,
        transcriptSegments: data.segments || [],
      };
      setSession(updatedSession);
      void sessionManager.saveSession(sessionId, updatedSession);
      setChatHistory(prev => [...prev, { role: 'assistant', content: 'Transcription complete!' }]);
    } catch (e: any) {
      console.error(e);
      alert(`Failed to transcribe video: ${e.message}`);
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleAiEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !aiPrompt.trim()) return;

    const userInput = aiPrompt.trim();
    const currentPrompt = userInput.toLowerCase();
    
    // Add user message to chat
    setAiPrompt('');
    setChatHistory(prev => [...prev, { role: 'user', content: userInput }]);

    // Handle undo/redo typed as text commands
    if (currentPrompt === 'undo' || currentPrompt === 'undo last' || currentPrompt === 'go back') {
      if (session.undoStack.length === 0) {
        setChatHistory(prev => [...prev, { role: 'assistant', content: 'Nothing to undo.' }]);
        return;
      }
      const lastAction = session.undoStack[session.undoStack.length - 1];
      if (lastAction.type === 'FULL_SNAPSHOT' && lastAction.previousSnapshot) {
        try {
          const restored = restoreFullSessionSnapshot(lastAction.previousSnapshot);
          const currentSnapshot = saveFullSessionSnapshot(session);
          const updated: SessionData = {
            ...restored,
            undoStack: session.undoStack.slice(0, -1),
            redoStack: [...session.redoStack, { type: 'FULL_SNAPSHOT' as const, previousSnapshot: currentSnapshot, actionType: 'UNDO' as const }],
          };
          setSession(updated);
          void sessionManager.saveSession(sessionId, updated);
          setChatHistory(prev => [...prev, { role: 'assistant', content: `Undone. (${updated.timeline.filter(s => s.track === 0).length} clips remaining)` }]);
          logger.debug('Undo successful');
        } catch(e) { 
          logger.error('Undo failed:', e);
          setChatHistory(prev => [...prev, { role: 'assistant', content: 'Undo failed.' }]); 
        }
      }
      return;
    }

    if (currentPrompt === 'redo' || currentPrompt === 'redo last' || currentPrompt === 'redo it') {
      if (session.redoStack.length === 0) {
        setChatHistory(prev => [...prev, { role: 'assistant', content: 'Nothing to redo.' }]);
        return;
      }
      const lastAction = session.redoStack[session.redoStack.length - 1];
      if (lastAction.type === 'FULL_SNAPSHOT' && lastAction.previousSnapshot) {
        try {
          const restored = restoreFullSessionSnapshot(lastAction.previousSnapshot);
          const currentSnapshot = saveFullSessionSnapshot(session);
          const updated: SessionData = {
            ...restored,
            undoStack: [...session.undoStack, { type: 'FULL_SNAPSHOT' as const, previousSnapshot: currentSnapshot, actionType: 'REDO' as const }],
            redoStack: session.redoStack.slice(0, -1),
          };
          setSession(updated);
          void sessionManager.saveSession(sessionId, updated);
          setChatHistory(prev => [...prev, { role: 'assistant', content: `Redone. (${updated.timeline.filter(s => s.track === 0).length} clips)` }]);
          logger.debug('Redo successful');
        } catch(e) { 
          logger.error('Redo failed:', e);
          setChatHistory(prev => [...prev, { role: 'assistant', content: 'Redo failed.' }]); 
        }
      }
      return;
    }

    setIsAiEditing(true);
    const promptToSend = userInput;

    try {
      const response = await fetch(`/api/videos/${sessionId}/edit-with-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: promptToSend,
          // Map to the format the backend expects: {start, end, id, title, text}
          segments: session.timeline
            .filter(s => s.track === 0)
            .sort((a, b) => a.order - b.order)
            .map((s, i) => {
              // Extract transcript text for this specific segment based on timeline overlap
              let text = '';
              if (session.transcriptSegments) {
                const segStart = s.timelineStart ?? 0;
                const segEnd = segStart + s.duration;
                text = session.transcriptSegments
                  .filter(ts => ts.start < segEnd && ts.end > segStart)
                  .map(ts => ts.text)
                  .join(' ')
                  .trim();
              }
              return {
                id: s.id,
                index: i + 1,
                start: s.sourceStart ?? 0,
                end: s.sourceEnd ?? s.duration,
                timelineStart: s.timelineStart ?? 0,
                duration: s.duration,
                title: s.name || `Clip ${i + 1}`,
                text,
                order: s.order,
                track: s.track,
                color: s.color,
                assetUrl: s.assetUrl,
                assetKind: s.assetKind,
              };
            })
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.detail?.message || err.detail || 'AI Edit failed');
      }

      const data = await response.json();
      
      // Map backend clips back to TimelineSegment format
      const track0 = (data.clips || []).map((clip: any, i: number) => {
        const origSeg = session.timeline.find(s => s.id === clip.id);
        const assetUrl = clip.assetUrl ?? origSeg?.assetUrl;
        const assetKind = clip.assetKind ?? origSeg?.assetKind;
        const srcStart = clip.sourceStart ?? (origSeg?.sourceStart ?? 0);
        const srcEnd = clip.sourceEnd ?? (origSeg?.sourceEnd ?? 0);
        const duration = clip.duration ?? (srcEnd - srcStart);
        // Use name from backend (already enforced correctly), fall back to original, then sequential
        const name = clip.name || clip.title || origSeg?.name || `Clip ${i + 1}`;
        return {
          id: clip.id || origSeg?.id || `ai-clip-${i}`,
          sourceStart: srcStart,
          sourceEnd: srcEnd,
          timelineStart: clip.timelineStart ?? 0,
          duration,
          order: i,
          track: 0,
          color: assetUrl ? getAssetColor(assetKind || 'video') : getClipColor(i),
          name,
          assetUrl,
          assetKind,
          volume: clip.volume ?? origSeg?.volume,
        };
      });
      // Recalculate timelineStart for all clips
      let t = 0;
      const adjustedTrack0 = track0.map((seg: any) => {
        const s = { ...seg, timelineStart: t };
        t += seg.duration;
        return s;
      });
      const otherTracks = session.timeline.filter(s => s.track !== 0);
      const newTimeline = [...adjustedTrack0, ...otherTracks];
      
      // Phase 4.13: Capture FULL session snapshot BEFORE mutation
      const previousSnapshot = saveFullSessionSnapshot(session);

      const updatedSession = {
         ...session,
         timeline: newTimeline,
         undoStack: [...session.undoStack, { 
           type: 'FULL_SNAPSHOT' as const,
           previousSnapshot,
           actionType: 'AI_EDIT' as const
         }],
         redoStack: []
      };

      setSession(updatedSession);
      void sessionManager.saveSession(sessionId, updatedSession);

      setChatHistory(prev => [...prev, { 
        role: 'assistant', 
        content: 'Done' 
      }]);
      
    } catch (e: any) {
      console.error(e);
      setChatHistory(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setIsAiEditing(false);
    }
  };

/**
 * CRITICAL: Preserve custom clip names across ALL mutations.
 * Returns seg.name if set, otherwise null (no fallback to "Clip N").
 * Sequential "Clip 1,2,3" ONLY for initial untouched clips.
 */
function preserveClipName(seg: TimelineSegment): string {
  return seg.name ?? `Clip`;
}

function getShortName(name: string | undefined | null, fallback: string) {
    if (!name || typeof name !== 'string') return fallback;
    const trimmed = name.trim();
    if (/^clip\s+\d+$/i.test(trimmed)) return trimmed;
    return trimmed || fallback;
  }

  function getAssetPreviewUrl(url?: string | null) {
    if (!url || typeof url !== 'string') return '';
    return url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('/api/') ? url : `/api/proxy-image?url=${encodeURIComponent(url)}`;
  }

  // Helper function to add transcript history entry after editing operations
  /* addTranscriptHistoryEntry removed - unused */
  //   if (!session.transcript) return session;
  //   const historyEntry = {
  //     timestamp: Date.now(),
  //     operation,
  //     transcript: session.transcript,
  //     segments: session.transcriptSegments,
  //   };
  //   return {
  //     ...session,
  //     transcriptHistory: [...(session.transcriptHistory || []), historyEntry],
  //   };
  // };

  useEffect(() => {
    loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isTranscribing) {
      setTranscribeTimer(0);
      interval = setInterval(() => {
        setTranscribeTimer(prev => prev + 0.1);
      }, 100);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isTranscribing]);

  // Check if session has transcript on load to determine button visibility
  useEffect(() => {
    if (session) {
      const hasExistingTranscript = !!(session.transcript && session.transcript.trim().length > 0);
      logger.debug('Session loaded - hasTranscript:', hasExistingTranscript);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId]); // Only run when session ID changes (initial load)

  // Keep ref in sync so async handlers always read the latest session
  useEffect(() => {
    sessionRef.current = session;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Set the video src imperatively on initial load — never via React prop
  // This prevents React re-renders from resetting the src during asset playback
  useEffect(() => {
    if (!session?.videoUrl || !videoRef.current) return;
    const video = videoRef.current;
    // Only set if not already on this src (don't interrupt asset playback)
    if (currentSrcRef.current === '' || currentSrcRef.current === session.videoUrl) {
      video.src = session.videoUrl;
      currentSrcRef.current = session.videoUrl;
      video.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId]); // Only on session change, not every render

  // Sync video position when session loads or clips change
  useEffect(() => {
    if (!session || !videoRef.current) return;
    const video = videoRef.current;
    const sortedClips = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    if (sortedClips.length === 0) return;
    
    try {
      const t = video.currentTime;
      const inValidClip = sortedClips.some(c => !c.assetUrl && t >= (c.sourceStart ?? 0) && t < (c.sourceEnd ?? 0));
      if (!inValidClip) {
        if (video.readyState > 0) {
          video.currentTime = sortedClips[0].sourceStart ?? 0;
        }
        setCurrentTime(sortedClips[0].timelineStart ?? 0);
      }
    } catch (e) {
      logger.error('Video sync error:', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId, session?.timeline.length]);

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isAiEditing]);

  // ── Track-1 audio sync with Web Audio GainNode (allows volume > 100%) ──────
  useEffect(() => {
    const au = audioRef.current;
    const video = videoRef.current;
    if (!au || !session) return;

    const audioClips = session.timeline
      .filter(s => s.track === 1 && s.assetKind === 'audio' && s.assetUrl)
      .sort((a, b) => (a.timelineStart ?? 0) - (b.timelineStart ?? 0));

    const activeAudio = audioClips.find(
      s => currentTime >= (s.timelineStart ?? 0) && currentTime < (s.timelineStart ?? 0) + s.duration
    );

    if (activeAudio && activeAudio.assetUrl) {
      const offsetInClip = currentTime - (activeAudio.timelineStart ?? 0);
      // vol is 0-5: 1 = 100%, 2 = 200%, etc.
      const vol = Math.max(0, activeAudio.volume ?? 1);
      // freq is 0.5-2.0: 1 = normal pitch, 0.5 = half speed/pitch, 2.0 = double speed/pitch
      const freq = Math.max(0.5, Math.min(2.0, activeAudio.frequency ?? 1));

      // Set up Web Audio GainNode on first use (allows gain > 1.0)
      if (!audioCtxRef.current) {
        try {
          const ctx = new AudioContext();
          const gain = ctx.createGain();
          const src = ctx.createMediaElementSource(au);
          src.connect(gain);
          gain.connect(ctx.destination);
          audioCtxRef.current = ctx;
          gainNodeRef.current = gain;
        } catch(e) { /* fallback to native volume */ }
      }

      // Apply gain
      // Map UI volume (0..5) to a perceptually stronger loudness curve.
      // Humans perceive loudness roughly non-linearly, so linear scaling can feel weak.
      //
      // We use an exponential curve with a bit of headroom to keep 100% reasonable
      // while making 200-500% clearly audible.
      if (gainNodeRef.current) {
        // volEffective: 0..5 (includes per-clip + global)
        const volEffective = Math.max(0, vol * globalVolume);

        // Loudness curve:
        // - keep vol=1 near 1.0 gain
        // - amplify higher values aggressively
        // This yields: 2x -> ~2.7x, 3x -> ~6.0x, 5x -> ~18x (subject to source headroom)
        const gain = Math.pow(volEffective, 2.1);

        // Prevent totally unusable distortion while still being “very loud”
        const clampedGain = Math.min(18, gain);

        gainNodeRef.current.gain.value = clampedGain;
        au.volume = 1; // keep media element normalized; WebAudio does the real gain
      } else {
        // Fallback (no WebAudio): native volume is 0..1 so we can’t exceed it.
        // Still try to make changes obvious.
        const volEffective = Math.max(0, vol * globalVolume);
        au.volume = Math.min(1, Math.pow(volEffective, 1.5));
      }

      // Apply frequency/pitch adjustment using playbackRate
      au.playbackRate = freq;

      // Duck video volume so track 1 audio overpowers it
      if (video) {
        const volEffective = Math.max(0, vol * globalVolume);
        video.volume = Math.max(0.05, 1 - (volEffective * 0.4));
      }

      if (audioSrcRef.current !== activeAudio.assetUrl) {
        au.src = activeAudio.assetUrl;
        audioSrcRef.current = activeAudio.assetUrl;
        au.load();
        if (audioCtxRef.current?.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
      }
      if (Math.abs(au.currentTime - offsetInClip) > 0.3) {
        au.currentTime = Math.max(0, offsetInClip);
      }
      if (isPlaying && au.paused) {
        if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
        au.play().catch(() => {});
      } else if (!isPlaying && !au.paused) {
        au.pause();
      }
    } else {
      if (!au.paused) au.pause();
      if (audioSrcRef.current) { au.src = ''; audioSrcRef.current = ''; }
      if (video) video.volume = 1;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, isPlaying, session?.timeline, globalVolume]);

  // Pre-load the next asset video clip so transitions are instant
  useEffect(() => {
    if (!session || !assetVideoRef.current) return;
    const av = assetVideoRef.current;
    const sorted = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    // Find the next asset video clip after the current position
    const nextAsset = sorted.find((s, i) => i >= currentClipIndexRef.current && s.assetKind === 'video' && s.assetUrl);
    if (nextAsset?.assetUrl && assetSrcRef.current !== nextAsset.assetUrl && assetVideoOpacity === 0) {
      // Pre-load silently in background
      av.src = nextAsset.assetUrl;
      assetSrcRef.current = nextAsset.assetUrl;
      av.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.timeline]);

  // Track which asset clip is currently active — based on clip index, not raw video time
  // This fires whenever currentTime changes (every RAF frame during playback)
  useEffect(() => {
    if (!session) { setActiveAssetClip(null); setPhotoOverlay(null); return; }
    const sorted = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    const idx = currentClipIndexRef.current;
    const activeSeg = sorted[idx] ?? null;

    if (activeSeg?.assetUrl) {
      setActiveAssetClip(activeSeg);
      // Fallback: If legacy session had a photo on Track 0, display it
      if (activeSeg.assetKind === 'photo') {
        setPhotoOverlay(prev => {
          const newUrl = getAssetPreviewUrl(activeSeg.assetUrl);
          const newName = activeSeg.name ?? 'Photo';
          if (prev?.url === newUrl && prev?.name === newName) return prev;
          return { url: newUrl, name: newName };
        });
      } else {
        setPhotoOverlay(null);
      }
    } else {
      setActiveAssetClip(null);
      setPhotoOverlay(null);
    }

    // Evaluate active free-positioned overlays on Track 1
    const track1Clips = (session.timeline || []).filter(s => s.track === 1 && s.assetKind !== 'audio');
    const activeOverlay = track1Clips.find(s => currentTime >= (s.timelineStart ?? 0) && currentTime < (s.timelineStart ?? 0) + (s.duration || 0));
    
    setActiveOverlayClip(activeOverlay && activeOverlay.assetUrl ? activeOverlay : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, session?.timeline]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.timeline, session?.transcriptSegments, showRemotionPreview]);

  // FIXED: Phase 1 - Playback/Playhead Sync (#2, #3)
  useEffect(() => {
    if (!session || !videoRef.current) return;

    const video = videoRef.current;
    const av = assetVideoRef.current;
    const sortedClips = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    const EPS = 0.01;

    let rafId = 0;
    let rafRunning = false;

    const clearPhotoTimer = () => {
      if (photoTimerRef.current) { 
        clearTimeout(photoTimerRef.current); 
        photoTimerRef.current = null; 
      }
    };

    isJumpingRef.current = false;

    const loadClip = async (clip: typeof sortedClips[0], offset = 0, shouldPlay = false) => {
      isSwitchingRef.current = true;
      clearPhotoTimer();
      isJumpingRef.current = true;

      // Pause all
      if (video) video.pause();
      if (av && !av.paused) av.pause();

      // PHOTO
      if (clip.assetKind === 'photo' && clip.assetUrl) {
        setPhotoOverlay({ url: getAssetPreviewUrl(clip.assetUrl), name: clip.name ?? 'Photo' });
        setActiveAssetClip(clip);
        setAssetVideoOpacity(0);
        photoElapsedRef.current = offset;
        photoStartTimeRef.current = performance.now();
        isSwitchingRef.current = false;
        isJumpingRef.current = false;
        if (shouldPlay) {
          setIsPlaying(true);
          isPlayingRef.current = true;
          const remaining = clip.duration - offset;
          photoTimerRef.current = setTimeout(() => advanceToNextClip(true), remaining * 1000);
        }
        return;
      }

      // ASSET VIDEO
      if (clip.assetUrl && clip.assetKind === 'video' && av) {
        setPhotoOverlay(null);
        setActiveAssetClip(clip);
        if (assetSrcRef.current !== clip.assetUrl) {
          av.src = clip.assetUrl;
          assetSrcRef.current = clip.assetUrl;
        }
        av.currentTime = offset;
        av.volume = 1;
        setAssetVideoOpacity(1);
        isSwitchingRef.current = false;
        isJumpingRef.current = false;
        if (shouldPlay) {
          av.play().catch(() => {});
          setIsPlaying(true);
          isPlayingRef.current = true;
        }
        return;
      }

      // ORIGINAL
      setPhotoOverlay(null);
      setActiveAssetClip(null);
      setAssetVideoOpacity(0);
      if (av && !av.paused) av.pause();

      const targetTime = (clip.sourceStart ?? 0) + offset;
      if (video) video.currentTime = targetTime;

      isSwitchingRef.current = false;
      isJumpingRef.current = false;
      if (shouldPlay && video) {
        video.play().catch(() => {});
        setIsPlaying(true);
        isPlayingRef.current = true;
      }
    };

    const advanceToNextClip = (shouldPlay = false) => {
      const next = currentClipIndexRef.current + 1;
      if (next < sortedClips.length) {
        currentClipIndexRef.current = next;
        loadClip(sortedClips[next], 0, shouldPlay);
      } else {
        currentClipIndexRef.current = 0;
        setIsPlaying(false);
        isPlayingRef.current = false;
        clearPhotoTimer();
        setPhotoOverlay(null);
        setActiveAssetClip(null);
        setAssetVideoOpacity(0);
        setCurrentTime(0);
        rafRunning = false;
        if (video) video.currentTime = sortedClips[0]?.sourceStart ?? 0;
      }
    };

    const rafLoop = () => {
      if (isSwitchingRef.current || isJumpingRef.current) {
        rafId = requestAnimationFrame(rafLoop);
        return;
      }
      if (sortedClips.length === 0) return;

      const clip = sortedClips[currentClipIndexRef.current];
      if (!clip) return;

      if (clip.assetKind === 'photo') {
        // Update currentTime during photo display so the scrubber moves
        if (isPlayingRef.current) {
          const wallElapsed = (performance.now() - photoStartTimeRef.current) / 1000;
          const elapsed = photoElapsedRef.current + wallElapsed;
          const photoTime = Math.min(elapsed, clip.duration);
          setCurrentTime((clip.timelineStart ?? 0) + photoTime);
        }
        rafId = requestAnimationFrame(rafLoop);
        return;
      }

      if (clip.assetUrl && clip.assetKind === 'video' && av) {
        // Always update currentTime from asset video position (even if briefly paused during buffering)
        const t = av.currentTime;
        setCurrentTime((clip.timelineStart ?? 0) + t);
        if (!av.paused && t >= clip.duration - EPS) advanceToNextClip(isPlayingRef.current);
        // Always keep rAF running for asset video
        rafId = requestAnimationFrame(rafLoop);
        return;
      }

      if (video && !video.paused) {
        const sourceOffset = video.currentTime - (clip.sourceStart ?? 0);
        setCurrentTime((clip.timelineStart ?? 0) + Math.max(0, sourceOffset));
        const clipEnd = (clip.sourceStart ?? 0) + clip.duration;
        if (video.currentTime >= clipEnd - EPS) advanceToNextClip(isPlayingRef.current);
      }
      // Always keep rAF running so red line stays in sync
      rafId = requestAnimationFrame(rafLoop);
    };

    const handleUnifiedPlay = () => {
      if (systemActionRef.current) {
        systemActionRef.current = false;
        return;
      }
      const clip = sortedClips[currentClipIndexRef.current];
      setIsPlaying(true);
      isPlayingRef.current = true;
      
      if (clip?.assetKind === 'video' && clip.assetUrl && av) {
        av.play().catch(() => {});
      } else if (clip?.assetKind === 'photo') {
        const offset = photoElapsedRef.current;
        const remaining = clip.duration - offset;
        photoStartTimeRef.current = performance.now(); // reset wall-clock start
        photoTimerRef.current = setTimeout(() => advanceToNextClip(true), remaining * 1000);
      } else if (video) {
        video.play().catch(() => {});
      }
      
      rafRunning = true;
      rafId = requestAnimationFrame(rafLoop);
    };

    const handleUnifiedPause = () => {
      if (systemActionRef.current) {
        systemActionRef.current = false;
        return;
      }
      setIsPlaying(false);
      isPlayingRef.current = false;
      rafRunning = false;
      cancelAnimationFrame(rafId);
      clearPhotoTimer();
      // Save elapsed time for photo so resume works correctly
      const clip = sortedClips[currentClipIndexRef.current];
      if (clip?.assetKind === 'photo') {
        photoElapsedRef.current += (performance.now() - photoStartTimeRef.current) / 1000;
      }
      if (video && !video.paused) video.pause();
      if (av && !av.paused) av.pause();
    };

    const handleAssetPlay = () => {
      setIsPlaying(true);
      isPlayingRef.current = true;
      if (!rafRunning) {
        rafRunning = true;
        rafId = requestAnimationFrame(rafLoop);
      }
    };

    const handleAssetPause = () => {
      // Don't stop rAF on asset pause — it may be a brief buffer pause
    };

    video?.addEventListener('play', handleUnifiedPlay);
    video?.addEventListener('pause', handleUnifiedPause);
    av?.addEventListener('play', handleAssetPlay);
    av?.addEventListener('pause', handleAssetPause);
    av?.addEventListener('ended', () => advanceToNextClip(isPlayingRef.current));

    // Always start rAF loop — it self-throttles when paused
    rafRunning = true;
    rafId = requestAnimationFrame(rafLoop);

    return () => {
      rafRunning = false;
      cancelAnimationFrame(rafId);
      clearPhotoTimer();
      video?.removeEventListener('play', handleUnifiedPlay);
      video?.removeEventListener('pause', handleUnifiedPause);
      av?.removeEventListener('play', handleAssetPlay);
      av?.removeEventListener('pause', handleAssetPause);
      av?.removeEventListener('ended', () => advanceToNextClip(isPlayingRef.current));
    };
  }, [session?.timeline]);

  async function loadSession() {
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
        void sessionManager.saveSession(sessionId, restoredSession);
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
    void sessionManager.saveSession(sessionId, newSession);
  }

  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDraggingPlayhead(true);
    if (isPlaying) {
      setIsPlaying(false);
      if (videoRef.current) videoRef.current.pause();
      if (assetVideoRef.current) assetVideoRef.current.pause();
      isPlayingRef.current = true;
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!timelineRef.current || !sessionRef.current) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const track0Segments = sessionRef.current.timeline.filter(s => s.track === 0);
    const totalDur = track0Segments.reduce((sum, s) => sum + s.duration, 0) || 1;

    if (isDraggingPlayhead && videoRef.current) {
      const mouseX = e.clientX - rect.left;
      // Use scroll offset + pixel container width for accurate position
      const MIN_PX_PER_SEC = 1.5;
      const MIN_CLIP_PX = 35;
      const totalPx = Math.max(
        track0Segments.reduce((sum, s) => sum + Math.max(MIN_CLIP_PX, s.duration * MIN_PX_PER_SEC), 0),
        200
      );
      const scrollLeft = timelineRef.current?.scrollLeft ?? 0;
      const clickPx = Math.max(0, Math.min(totalPx, mouseX + scrollLeft));
      const newTime = (clickPx / totalPx) * totalDur;
      
      setCurrentTime(newTime);
      void jumpToTimelineTime(newTime, sessionRef.current, true);
    }

    if (resizingSegmentId && resizeType) {
      const session = sessionRef.current;
      const deltaX = e.clientX - resizeInitialX;
      const MIN_PX_PER_SEC = 4;
      const MIN_CLIP_PX = 80;
      const track0Segs = session.timeline.filter(s => s.track === 0);
      const totalDurLocal = track0Segs.reduce((sum, s) => sum + s.duration, 0) || 1;
      const totalPxLocal = Math.max(
        track0Segs.reduce((sum, s) => sum + Math.max(MIN_CLIP_PX, s.duration * MIN_PX_PER_SEC), 0),
        400
      );
      const deltaTime = (deltaX / totalPxLocal) * totalDurLocal;

      const seg = session.timeline.find(s => s.id === resizingSegmentId);
      // Max = original file duration so you can't exceed it
      const maxDuration = seg?.assetKind === 'audio'
        ? (seg.originalDuration && seg.originalDuration > 0 ? seg.originalDuration : totalDurLocal)
        : (seg?.originalDuration ?? ((seg?.sourceEnd ?? 0) - (seg?.sourceStart ?? 0)));

      let newStart = resizeInitialStart;
      let newDuration = resizeInitialDuration;

      if (resizeType === 'left') {
        // Left handle moves the segment start, which changes duration = initialDuration - deltaMoved
        newStart = Math.max(0, resizeInitialStart + deltaTime);
        const effectiveDelta = newStart - resizeInitialStart;
        newDuration = Math.max(0.5, resizeInitialDuration - effectiveDelta);

        // Clamp duration to originalDuration (no extension beyond original)
        if (maxDuration > 0) {
          newDuration = Math.min(maxDuration, newDuration);
        }

        // If duration got clamped, recompute start so duration/timelineStart remain consistent.
        // (timelineStart should shift right when duration is reduced)
        newStart = resizeInitialStart + (resizeInitialDuration - newDuration);
      } else {
        // Right handle: duration changes, start stays constant.
        newDuration = Math.max(0.5, resizeInitialDuration + deltaTime);
        if (maxDuration > 0) newDuration = Math.min(maxDuration, newDuration);
      }

      const updatedTimeline = session.timeline.map(s => {
        if (s.id !== resizingSegmentId) return s;

        const updated: typeof s = { ...s, timelineStart: newStart, duration: newDuration };

        if (s.assetKind === 'audio') {
          updated.duration = newDuration;

          if (resizeType === 'left') {
            updated.sourceStart = Math.max(0, (s.sourceStart ?? 0) + (resizeInitialDuration - newDuration));
            updated.sourceEnd = updated.sourceStart + newDuration;
          } else {
            const currentSourceStart = s.sourceStart ?? 0;
            updated.sourceStart = currentSourceStart;
            updated.sourceEnd = currentSourceStart + newDuration;
          }
        } else {
          updated.sourceEnd = (s.sourceStart ?? 0) + newDuration;
        }

        return updated;
      });

      setSession({ ...session, timeline: updatedTimeline });
    }
  };

  const handleMouseUp = () => {
    if (isDraggingPlayhead) {
      setIsDraggingPlayhead(false);
      if (isPlayingRef.current) {
        const video = videoRef.current;
        const av = assetVideoRef.current;
        if (video && video.paused) video.play().catch(() => {});
        if (av && av.src && av.paused) av.play().catch(() => {});
        setIsPlaying(true);
      }
    }
    if (resizingSegmentId) {
      if (sessionRef.current) {
        const session = sessionRef.current;
        const previousSnapshot = saveFullSessionSnapshot(session);
        const updatedSession = {
          ...session,
          undoStack: [...session.undoStack, { 
            type: 'FULL_SNAPSHOT' as const,
            previousSnapshot,
            actionType: 'RESIZE' as const
          }],
          redoStack: []
        };
         void sessionManager.saveSession(sessionId, updatedSession);
      }
      setResizingSegmentId(null);
      setResizeType(null);
    }
  };

  async function jumpToTimelineTime(timelineTime: number, sourceSession: SessionData = session!, isScrubbing: boolean = false) {
    if (!videoRef.current || !sourceSession) return;

    const video = videoRef.current;
    const av = assetVideoRef.current;
    const sorted = [...(sourceSession.timeline || [])]
      .filter(seg => seg.track === 0)
      .sort((a, b) => a.order - b.order);
    if (sorted.length === 0) return;

    const clampedTime = Math.max(0, Math.min(timelineTime, sorted.reduce((sum, seg) => sum + seg.duration, 0)));
    // Prefer the clip that STARTS at or after clampedTime over one that ends exactly at clampedTime
    const segmentIndex = sorted.findIndex(
      seg => clampedTime >= (seg.timelineStart ?? 0) && clampedTime < (seg.timelineStart ?? 0) + seg.duration
    );
    const targetIndex = segmentIndex >= 0 ? segmentIndex : sorted.length - 1;
    const segment = sorted[targetIndex];
    const offset = Math.max(0, Math.min(segment.duration, clampedTime - (segment.timelineStart ?? 0)));

    currentClipIndexRef.current = targetIndex;
    setSelectedSegmentId(segment.id);
    setCurrentTime((segment.timelineStart ?? 0) + offset);
    isJumpingRef.current = true; // prevent rAF from overwriting currentTime during seek

    if (photoTimerRef.current) { clearTimeout(photoTimerRef.current); photoTimerRef.current = null; }

    // Photo
    if (segment.assetKind === 'photo' && segment.assetUrl) {
      video.pause();
      if (av && !av.paused) av.pause();
      setAssetVideoOpacity(0);
      setPhotoOverlay({ url: getAssetPreviewUrl(segment.assetUrl), name: segment.name ?? 'Photo' });
      setActiveAssetClip(segment);
      isJumpingRef.current = false;
      return;
    }

    // Asset video
    if (segment.assetKind === 'video' && segment.assetUrl && av) {
      const wasPlaying = !isScrubbing && (!video.paused || (av && !av.paused));
      video.pause();
      setPhotoOverlay(null);
      setActiveAssetClip(segment);
      if (assetSrcRef.current !== segment.assetUrl) {
        av.src = segment.assetUrl;
        assetSrcRef.current = segment.assetUrl;
      }
      av.currentTime = offset;
      setAssetVideoOpacity(1);
      isJumpingRef.current = false;
      if (wasPlaying) { av.play().catch(() => {}); setIsPlaying(true); isPlayingRef.current = true; }
      return;
    }

    // Original video clip
    setPhotoOverlay(null);
    setActiveAssetClip(null);
    setAssetVideoOpacity(0);
    if (av && !av.paused) av.pause();

    const targetTime = (segment.sourceStart ?? 0) + offset;
    const wasPlaying = !isScrubbing && !video.paused;
    try { video.currentTime = targetTime; } catch(e) { /* ignore */ }
    isJumpingRef.current = false;

    if (wasPlaying) {
      try { video.play().catch(() => {}); setIsPlaying(true); } catch {}
    }
  }

  useEffect(() => {
    if (isDraggingPlayhead || resizingSegmentId) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraggingPlayhead, resizingSegmentId, resizeType, resizeInitialX, resizeInitialStart, resizeInitialDuration]);

  // Keyboard shortcuts: Space = play/pause, ← = rewind 5s, → = forward 5s, J = -10s, L = +10s
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Don't fire when typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        const video = videoRef.current;
        const av = assetVideoRef.current;
        if (isPlayingRef.current) {
          video?.pause();
          av?.pause();
        } else {
          const clips = (sessionRef.current?.timeline || []).filter(s => s.track === 0).sort((a, b) => a.order - b.order);
          const clip = clips[currentClipIndexRef.current];
          if (clip?.assetKind === 'video' && clip.assetUrl && av) {
            av.play().catch(() => {});
          } else {
            video?.play().catch(() => {});
          }
        }
      } else if (e.code === 'ArrowLeft' || e.code === 'KeyJ') {
        e.preventDefault();
        const step = e.code === 'KeyJ' ? 10 : 5;
        void jumpToTimelineTime(Math.max(0, currentTime - step));
      } else if (e.code === 'ArrowRight' || e.code === 'KeyL') {
        e.preventDefault();
        const step = e.code === 'KeyL' ? 10 : 5;
        const totalDur = (sessionRef.current?.timeline || []).filter(s => s.track === 0).reduce((sum, s) => sum + s.duration, 0);
        void jumpToTimelineTime(Math.min(totalDur, currentTime + step));
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime]);

  // FIXED: Phase 3 - Clip Splitting Names (#1)
  const handleCut = () => {
    if (!session) return;
    
    const previousSnapshot = saveFullSessionSnapshot(session);
    
    const segmentToCut = session.timeline
      .filter(seg => seg.track === 0)
      .find(seg => currentTime >= (seg.timelineStart ?? 0) && currentTime < (seg.timelineStart ?? 0) + seg.duration);

    if (!segmentToCut) return;

    const cutOffset = currentTime - (segmentToCut.timelineStart ?? 0);
    const sourceCutTime = (segmentToCut.sourceStart ?? 0) + cutOffset;

    if (cutOffset <= 0.1 || cutOffset >= segmentToCut.duration - 0.1) {
      alert('Playhead must be inside segment (not at edges)');
      return;
    }
    
    // Colors - original for part1, next for part2
    const availableColors = ['#2ecc71', '#e74c3c', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#16a085', '#27ae60'];
    const color1 = segmentToCut.color || availableColors[0];
    const color2 = availableColors[(availableColors.indexOf(color1) + 1) % availableColors.length];
    
    // FIXED: Smart name splitting - "MyClip" → "MyClip-A/B", "Clip1-A" → "Clip1-A1/A2"
    const baseNameMatch = segmentToCut.name?.match(/^(.+?)(?:-([AB]\\d+))?$/i);
    const baseName = baseNameMatch ? baseNameMatch[1].trim() : (segmentToCut.name || `Clip ${segmentToCut.order + 1}`);
    const partNum = baseNameMatch?.[2] ? parseInt(baseNameMatch[2].slice(1)) : 0;
    
    const segment1Name = partNum > 0 ? `${baseName}-${String.fromCharCode(65 + partNum)}${1}` : `${baseName}-A`;
    const segment2Name = partNum > 0 ? `${baseName}-${String.fromCharCode(65 + partNum)}${2}` : `${baseName}-B`;
    
    const segment1: TimelineSegment = {
      ...segmentToCut,
      id: `${segmentToCut.id}-1`,
      sourceEnd: sourceCutTime,
      duration: cutOffset,
      name: segment1Name,
      color: color1,
    };
    
    const segment2: TimelineSegment = {
      ...segmentToCut,
      id: `${segmentToCut.id}-2`,
      sourceStart: sourceCutTime,
      timelineStart: (segmentToCut.timelineStart ?? 0) + cutOffset,
      duration: segmentToCut.duration - cutOffset,
      name: segment2Name,
      color: color2,
    };

    // Correctly replace the single segment with two parts in the timeline
    const track0 = session.timeline.filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    const others = session.timeline.filter(s => s.track !== 0);
    const cutIdx = track0.findIndex(s => s.id === segmentToCut.id);
    
    const newTrack0 = [
      ...track0.slice(0, cutIdx),
      segment1,
      segment2,
      ...track0.slice(cutIdx + 1)
    ];
    
    // Recalculate positions/names
    let t = 0;
    const adjusted = newTrack0.map((seg, i) => {
      const adj = { ...seg, order: i, timelineStart: t };
      t += seg.duration;
      return adj;
    });

    const updatedSession = {
      ...session,
      timeline: [...adjusted, ...others],
      undoStack: [...session.undoStack, { 
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot,
        actionType: 'CUT' as const,
        details: { cutId: segmentToCut.id, cutTime: cutOffset }
      }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
    setSelectedSegmentId(segment2.id); // Select right part
  };

  const handleDelete = () => {
    if (!session) return;

    const previousSnapshot = saveFullSessionSnapshot(session);

    let targetId = selectedSegmentId;

    // Auto-select the first track-0 clip if nothing is selected
    targetId = targetId || (
      [...session.timeline].filter(s => s.track === 0).sort((a, b) => a.order - b.order)[0]?.id ?? null
    );

    if (!targetId) return;

    const segmentToDelete = session.timeline.find(seg => seg.id === targetId);
    if (!segmentToDelete) return;

    if (session.timeline.filter(s => s.track === 0).length === 1 && segmentToDelete.track === 0) {
      alert('Cannot delete the last video clip.');
      return;
    }
    
    // Remove segment and reorder (preserve custom names)
    const newTimeline = session.timeline
      .filter(seg => seg.id !== targetId)
      .sort((a, b) => a.order - b.order);
    
    // Recalculate timeline positions → STRICTLY PRESERVE custom names
    let cumulativeTime = 0;
    const adjustedTimeline = newTimeline.map((seg, index) => {
      const adjusted = { 
        ...seg, 
        order: index, 
        timelineStart: cumulativeTime,
        name: preserveClipName(seg)
      };
      cumulativeTime += seg.duration;
      return adjusted;
    });
    
    const updatedSession: SessionData = {
      ...session,
      timeline: adjustedTimeline,
      transcript: session.transcript,
      transcriptSegments: session.transcriptSegments,
      undoStack: [...session.undoStack, { 
        type: 'FULL_SNAPSHOT' as const, 
        previousSnapshot,
        actionType: 'DELETE' as const,
        details: { segmentId: targetId } 
      }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    setSelectedSegmentId(null);
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleUndo = () => {
    if (!session || session.undoStack.length === 0) return;
    
    const lastAction = session.undoStack[session.undoStack.length - 1];
    const previousSnapshot = lastAction.type === 'FULL_SNAPSHOT' ? lastAction.previousSnapshot : null;
    
    if (previousSnapshot) {
      try {
        const restored = restoreFullSessionSnapshot(previousSnapshot);
        const currentSnapshot = saveFullSessionSnapshot(session);
        
        const updated: SessionData = {
          ...restored,
          undoStack: session.undoStack.slice(0, -1),
          redoStack: [...session.redoStack, { 
            type: 'FULL_SNAPSHOT' as const,
            previousSnapshot: currentSnapshot,
            actionType: 'UNDO' as const
          }],
        };
        
        setSession(updated);
        sessionManager.saveSession(sessionId, updated);
      } catch (e) {
        logger.error('Undo failed:', e);
      }
    }
  };

  const handleRedo = () => {
    if (!session || session.redoStack.length === 0) return;
    
    const lastAction = session.redoStack[session.redoStack.length - 1];
    const previousSnapshot = lastAction.type === 'FULL_SNAPSHOT' ? lastAction.previousSnapshot : null;
    
    if (previousSnapshot) {
      try {
        const restored = restoreFullSessionSnapshot(previousSnapshot);
        const currentSnapshot = saveFullSessionSnapshot(session);
        
        const updated: SessionData = {
          ...restored,
          undoStack: [...session.undoStack, { 
            type: 'FULL_SNAPSHOT' as const,
            previousSnapshot: currentSnapshot,
            actionType: 'REDO' as const
          }],
          redoStack: session.redoStack.slice(0, -1),
        };
        
        setSession(updated);
        sessionManager.saveSession(sessionId, updated);
      } catch (e) {
        logger.error('Redo failed:', e);
      }
    }
  };

  const handleSegmentClick = (segmentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const clip = session?.timeline.find(s => s.id === segmentId);
    if (!clip) return;
    isJumpingRef.current = true; // block rAF from overwriting currentTime
    setSelectedSegmentId(segmentId);
    setCurrentTime(clip.timelineStart ?? 0);
    currentClipIndexRef.current = (session?.timeline || [])
      .filter(s => s.track === 0).sort((a, b) => a.order - b.order)
      .findIndex(s => s.id === segmentId);
    void jumpToTimelineTime((clip.timelineStart ?? 0) + 0.001).then(() => {
      const video = videoRef.current;
      const av = assetVideoRef.current;
      if (clip.assetKind === 'video' && clip.assetUrl && av) {
        av.play().catch(() => {});
      } else if (clip.assetKind !== 'photo') {
        video?.play().catch(() => {});
      }
    });
  };

  const handleSegmentDragStart = (segmentId: string, e: React.DragEvent) => {
    setDraggedSegmentId(segmentId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', segmentId);

    // Compute mouse offset inside clip for smooth dragging drop
    if (timelineRef.current && session) {
      const rect = timelineRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      
      const track0Segments = (session.timeline || []).filter(s => s.track === 0);
      const totalDur = track0Segments.reduce((sum, s) => sum + s.duration, 0) || 1;
      
      const timeAtCursor = (mouseX / rect.width) * totalDur;
      const segment = session.timeline.find(s => s.id === segmentId);
      if (segment && segment.track === 1) {
        setDragOffset(timeAtCursor - (segment.timelineStart ?? 0));
      } else {
        setDragOffset(0);
      }
    }
  };

  const handleSegmentDragEnd = () => {
    setDraggedSegmentId(null);
    setDragOverSegmentId(null);
    setDragOverPosition(null);
    setDragOverSide(null);
  };

  const handleSegmentDragOver = (targetSegmentId: string, e: React.DragEvent) => {
    if (!draggedSegmentId || draggedSegmentId === targetSegmentId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverSegmentId(targetSegmentId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDragOverSide((e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right');
  };

  const handleSegmentDragLeave = (targetSegmentId: string, e: React.DragEvent) => {
    e.stopPropagation();
    if (dragOverSegmentId === targetSegmentId) {
      setDragOverSegmentId(null);
      setDragOverSide(null);
    }
  };

  const handleSegmentDrop = (targetSegmentId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedSegmentId || !session || draggedSegmentId === targetSegmentId) return;

    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    const targetSegment  = session.timeline.find(seg => seg.id === targetSegmentId);
    if (!draggedSegment || !targetSegment) return;

    // Only reorder within track 0
    if (draggedSegment.track !== 0 || targetSegment.track !== 0) return;

    // Determine drop side: left half → insert before target, right half → insert after target
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const insertBefore = (e.clientX - rect.left) < rect.width / 2;

    const track0 = [...session.timeline]
      .filter(s => s.track === 0)
      .sort((a, b) => a.order - b.order);

    // Remove dragged from list
    const without = track0.filter(s => s.id !== draggedSegmentId);
    const targetIdx = without.findIndex(s => s.id === targetSegmentId);
    // Bounds validation for insert position
    const insertAt = Math.max(0, Math.min(without.length, insertBefore ? targetIdx : targetIdx + 1));

    // Splice dragged into new position
    const reordered = [
      ...without.slice(0, insertAt),
      draggedSegment,
      ...without.slice(insertAt),
    ];

    let t = 0;
    const adjustedTrack0 = reordered.map((seg, idx) => {
      const s = { 
        ...seg, 
        order: idx, 
        timelineStart: t,
        // ✅ FIXED: Preserve custom names on reorder/drop
        name: preserveClipName(seg)
      };
      t += seg.duration;
      return s;
    });

    const otherTracks = session.timeline.filter(s => s.track !== 0);
    // Phase 4.15: Capture FULL session snapshot BEFORE mutation (segment drop reorder)
    const previousSnapshot = saveFullSessionSnapshot(session);

    const updatedSession = {
      ...session,
      timeline: [...adjustedTrack0, ...otherTracks],
      undoStack: [...session.undoStack, { 
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot,
        actionType: 'REORDER_DROP' as const
      }],
      redoStack: [],
    };

    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
    setDraggedSegmentId(null);
    setDragOverSegmentId(null);
    setDragOverPosition(null);
  };

  // Handle dropping on a track (to move clip to different track)
  const handleTrackDrop = (trackNum: number, e: React.DragEvent) => {
    e.preventDefault();
    
    if (!draggedSegmentId || !session) return;
    
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    if (!draggedSegment) return;
    
    if (draggedSegment.track === trackNum) {
      // Already on this track, let it bubble up to handleTimelineDrop for exact repositioning
      return;
    }
    
    // Only allow audio on track 1, and no audio on track 0
    if (trackNum === 1 && draggedSegment.assetKind !== 'audio') return;
    if (trackNum === 0 && draggedSegment.assetKind === 'audio') return;
    
    e.stopPropagation();
    // Move segment to new track
    const newTimeline = session.timeline.map(seg => {
      if (seg.id === draggedSegmentId) {
        return { ...seg, track: trackNum };
      }
      return seg;
    });
    
    // Phase 4.15: Capture FULL session snapshot BEFORE mutation (track drop)
    const previousSnapshot = saveFullSessionSnapshot(session);

    const updatedSession = {
      ...session,
      timeline: newTimeline,
      undoStack: [...session.undoStack, { 
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot,
        actionType: 'TRACK_DROP' as const
      }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
    
    setDraggedSegmentId(null);
    setDragOverSegmentId(null);
    setDragOverPosition(null);
  };

  const handleTrackDragOver = (e: React.DragEvent) => {
    if (!draggedSegmentId || !session) return;
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    if (draggedSegment) {
      const targetTrack = parseInt((e.currentTarget as HTMLElement).dataset.track || '0', 10);
      if (targetTrack === 1 && draggedSegment.assetKind !== 'audio') return;
      if (targetTrack === 0 && draggedSegment.assetKind === 'audio') return;
    }
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
    
    const track0Segments = (session.timeline || []).filter(s => s.track === 0);
    const totalDur = track0Segments.reduce((sum, s) => sum + s.duration, 0) || 1;
    
    const timePosition = percentage * totalDur;
    
    setDragOverPosition(timePosition);
  };

  const handleTimelineDrop = (e: React.DragEvent) => {
    e.preventDefault();
    
    if (!draggedSegmentId || !session || !timelineRef.current || dragOverPosition === null) return;
    
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    if (!draggedSegment) return;
    
    if (draggedSegment.track === 1) {
      // Audio segment: absolute positioning with bounds validation
      const track0Dur = session.timeline.filter(s => s.track === 0).reduce((sum, s) => sum + s.duration, 0);
      const newStart = Math.max(0, Math.min(track0Dur - draggedSegment.duration + 0.1, dragOverPosition - dragOffset));
      const updatedTimeline = session.timeline.map(seg => {
        if (seg.id === draggedSegmentId) {
          return { ...seg, timelineStart: newStart };
        }
        return seg;
      });
      // Phase 4.15: Capture FULL session snapshot BEFORE mutation (audio reposition/timeline drop)
      const previousSnapshot = saveFullSessionSnapshot(session);

      const updatedSession = {
        ...session,
        timeline: updatedTimeline,
        undoStack: [...session.undoStack, { 
          type: 'FULL_SNAPSHOT' as const,
          previousSnapshot,
          actionType: 'TIMELINE_DROP' as const
        }],
        redoStack: [],
      };
      setSession(updatedSession);
      void sessionManager.saveSession(sessionId, updatedSession);
      
      setDraggedSegmentId(null);
      setDragOverPosition(null);
      return;
    }

    // Find the position to insert the segment based on drop position for track 0
    const track0Segments = [...session.timeline]
      .filter(seg => seg.track === 0 && seg.id !== draggedSegmentId)
      .sort((a, b) => a.order - b.order);
    
    let newOrder = 0;
    for (let i = 0; i < track0Segments.length; i++) {
      if (dragOverPosition < (track0Segments[i].timelineStart ?? 0) + (track0Segments[i].duration / 2)) {
        newOrder = i;
        break;
      }
      newOrder = i + 1;
    }
    
    // Reorder all track 0 segments
    const reorderedTrack0 = track0Segments
      .slice(0, newOrder)
      .concat([draggedSegment])
      .concat(track0Segments.slice(newOrder))
      .map((seg, index) => ({ ...seg, order: index }));
    
    // Recalculate timeline positions for track 0
    let cumulativeTime = 0;
    const adjustedTrack0 = reorderedTrack0.map(seg => {
      const adjusted = { ...seg, timelineStart: cumulativeTime };
      cumulativeTime += seg.duration;
      return adjusted;
    });

    const otherTracks = session.timeline.filter(seg => seg.track !== 0 && seg.id !== draggedSegmentId);
    
    const previousSnapshot = saveFullSessionSnapshot(session);
    const updatedSession = {
      ...session,
      timeline: [...adjustedTrack0, ...otherTracks],
      undoStack: [...session.undoStack, { 
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot,
        actionType: 'REORDER' as const,
        details: { dropPosition: dragOverPosition }
      }],
      redoStack: []
    };
    
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
    
    setDraggedSegmentId(null);
    setDragOverPosition(null);
  };

  function getClipColor(index: number) {
    const colors = [
      '#2ecc71', // Green  
      '#e74c3c', // Red
      '#f39c12', // Orange
      '#9b59b6', // Purple
      '#1abc9c', // Teal
      '#e67e22', // Dark Orange
      '#16a085', // Dark Teal
      '#27ae60', // Dark Green
    ];
    const color = colors[index % colors.length];
    logger.debug(`Clip color assignment - Index ${index} -> Color ${color}`);
    return color;
  }

  // Generate colors for different asset types
  function getAssetColor(assetKind: string) {
    const assetColors = {
      photo: '#e67e22', // Orange
      video: '#9b59b6', // Purple
      audio: '#1abc9c', // Teal
    };
    return assetColors[assetKind as keyof typeof assetColors] || '#2ecc71';
  }

  const handleVolumeChange = (segmentId: string, volume: number) => {
    if (!sessionRef.current) return;
    const session = sessionRef.current;
    const safeVolume = Math.max(0, Math.min(5, volume));
    
    const previousSnapshot = saveFullSessionSnapshot(session);
    const updatedTimeline = session.timeline.map(seg => 
      seg.id === segmentId ? { ...seg, volume: safeVolume } : seg
    );
    const updatedSession = { 
      ...session, 
      timeline: updatedTimeline,
      undoStack: [...session.undoStack, { 
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot,
        actionType: 'VOLUME_CHANGE' as const
      }],
      redoStack: []
    };
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleWavelengthChange = (segmentId: string, wavelength: number) => {
    if (!sessionRef.current) return;
    const session = sessionRef.current;
    const updatedTimeline = session.timeline.map(seg => {
      if (seg.id !== segmentId) return seg;
      const track0Dur = session.timeline.filter(s => s.track === 0).reduce((sum, s) => sum + s.duration, 0) || 1;
      const maxDuration = (seg.originalDuration && seg.originalDuration > 0) ? seg.originalDuration : track0Dur;
      const safeDuration = Math.max(0.5, Math.min(maxDuration, wavelength));
      const sourceStart = seg.sourceStart ?? 0;
      const sourceEnd = sourceStart + safeDuration;
      return {
        ...seg,
        duration: safeDuration,
        sourceEnd,
      };
    });
    const previousSnapshot = saveFullSessionSnapshot(session);
    const updatedSession = {
      ...session,
      timeline: updatedTimeline,
      undoStack: [...session.undoStack, {
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot,
        actionType: 'RESIZE' as const
      }],
      redoStack: []
    };
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleFrequencyChange = (segmentId: string, frequency: number) => {
    if (!sessionRef.current) return;
    const session = sessionRef.current;
    const updatedTimeline = session.timeline.map(seg => {
      if (seg.id !== segmentId) return seg;
      const safeFrequency = Math.max(0.5, Math.min(2.0, frequency));
      return {
        ...seg,
        frequency: safeFrequency,
      };
    });
    const previousSnapshot = saveFullSessionSnapshot(session);
    const updatedSession = {
      ...session,
      timeline: updatedTimeline,
      undoStack: [...session.undoStack, {
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot,
        actionType: 'FREQUENCY_CHANGE' as const
      }],
      redoStack: []
    };
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleGlobalVolumeChange = (volume: number) => {
    const safeVolume = Math.max(0, Math.min(5, volume));
    setGlobalVolume(safeVolume);
  };

  // Download transcript as .txt
  const handleDownloadTranscript = () => {
    if (!session?.transcript) return;
    const lines = session.transcriptSegments
      ? session.transcriptSegments.map(s => `[${formatTime(s.start)}]  ${s.text.trim()}`).join('\n')
      : session.transcript;
    const blob = new Blob([lines], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${sessionId.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleResizeMouseDown = (e: React.MouseEvent, segmentId: string, type: 'left' | 'right') => {
    e.stopPropagation();
    e.preventDefault();
    
    const segment = session?.timeline.find(s => s.id === segmentId);
    if (!segment) return;
    
    setResizingSegmentId(segmentId);
    setResizeType(type);
    setResizeInitialX(e.clientX);
    setResizeInitialStart(segment.timelineStart ?? 0);
    setResizeInitialDuration(segment.duration);
  };

  // Asset management functions

  const handleExport = async () => {
    logger.operation("Export process started");
    
    if (!session || session.timeline.length === 0) {
      alert('No clips to export.');
      return;
    }

    setIsExporting(true);

    try {
      // const exportClips = [...session.timeline]
      //   .sort((a, b) => (a.timelineStart ?? 0) - (b.timelineStart ?? 0))
      //   .map(c => ({
      //     ...c,
      //     start: c.timelineStart ?? 0,
      //     end: (c.timelineStart ?? 0) + (c.duration ?? 0),
      //   }));


      // Use cached fast export endpoint for performance.
      // Backend endpoint: POST /api/videos/{session_id}/export-fast
      const endpoint = 'export-fast';

      logger.operation('Using fast cached export');

      // Backend expects a timeline of clips, not a Remotion composition.
      // Cache signature is based on ordered timeline (so keep stable ordering).
      const timeline = [...session.timeline]
        .filter(c => c.track === 0) // export-fast only handles track 0 video segments
        .sort((a, b) => (a.timelineStart ?? 0) - (b.timelineStart ?? 0))
        .map(c => ({
          sourceStart: c.sourceStart ?? 0,
          duration: c.duration ?? 0,
          end: (c.sourceStart ?? 0) + (c.duration ?? 0),
        }));

      const res = await fetch(`/api/videos/${sessionId}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeline,
        }),
      });


      logger.debug("Export response status:", res.status, res.statusText);

      if (!res.ok) {
        let errMessage = 'Export failed';
        try {
          const errData = await res.json();
          errMessage = errData.detail?.message || errData.detail || res.statusText;
        } catch (e) {
          errMessage = res.statusText;
        }
        logger.error("Export failed:", errMessage);
        alert(`Export failed: ${errMessage}`);
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
      
      logger.operation(`Export completed successfully`);
      alert(`Successfully exported video!`);
    } catch (err) {
      logger.error("Export error:", err);
      alert(`Export failed: ${err instanceof Error ? err.message : 'Network error'}`);
    } finally {
      setIsExporting(false);
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
    <>
      <div className="editor-page" ref={editPanelRef}>
        <header className="editor-header">
          <div className="header-left">
            <h1>AutoEdit</h1>
          </div>
          <div className="header-right">
            <button className="btn btn-secondary" onClick={() => setShowResetDialog(true)}>
              Reset
            </button>
            <button className="btn btn-primary" onClick={handleExport} disabled={isExporting}>
              {isExporting ? 'Exporting...' : 'Export'}
            </button>
          </div>
        </header>

        <div className="editor-content">
          <main className="editor-main">
            {/* Video Player */}
            <div
              className="video-player"
              style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: '#000', minHeight: 0 }}
            >
            {showRemotionPreview && compositionSchema ? (
              <RemotionPreview
                composition={compositionSchema}
                currentTime={currentTime}
                onTimeUpdate={setCurrentTime}
              />
            ) : (
              <>
              <video
                key={sessionId}
                ref={videoRef}
                className="video-element"
                style={{ width: '100%', height: '100%', objectFit: 'contain', flex: 1 }}
                crossOrigin="anonymous"
                preload="auto"
                aria-label={isPlaying ? 'Video playing' : 'Video paused'}
              >
                Your browser does not support the video tag.
              </video>

              {/* Asset video overlay — no native controls, custom bar below handles play/pause */}
              <video
                ref={assetVideoRef}
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: '100%', height: '100%',
                  objectFit: 'contain',
                  zIndex: 4,
                  opacity: assetVideoOpacity,
transition: 'opacity 0.02s linear',
                  pointerEvents: 'none',
                  backgroundColor: '#000',
                }}
                crossOrigin="anonymous"
                preload="auto"
                playsInline
                muted
                onPlay={() => { setIsPlaying(true); isPlayingRef.current = true; }}
                onPause={() => { setIsPlaying(false); isPlayingRef.current = false; }}
              />

              <img
                ref={snapshotImgRef}
                alt="transition-snapshot"
                style={{
                  position: 'absolute',
                  top: 0, left: 0,
                  width: '100%', height: '100%',
                  objectFit: 'contain',
                  zIndex: 2,
                  pointerEvents: 'none',
                  opacity: 0,
                  transition: 'opacity 0.15s ease-out',
                  backgroundColor: 'transparent'
                }}
              />

              {/* Hidden audio element for track-1 audio clips */}
              <audio ref={audioRef} preload="auto" style={{ display: 'none' }} />

              </>
            )}

            {/* Overlay render logic for new Track 1 active visual assets */}
            {activeOverlayClip && activeOverlayClip.assetUrl && (
              <div className="video-photo-preview">
                {activeOverlayClip.assetKind === 'photo' ? (
                  <img src={getAssetPreviewUrl(activeOverlayClip.assetUrl)} alt={activeOverlayClip.name} className="video-photo-img" />
                ) : activeOverlayClip.assetKind === 'video' ? (
                  <video src={getAssetPreviewUrl(activeOverlayClip.assetUrl)} autoPlay muted loop className="video-photo-img" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                ) : null}
                <div className="video-photo-label">{getShortName(activeOverlayClip.name, activeOverlayClip.assetKind === 'photo' ? 'Photo' : 'Video')}</div>
              </div>
            )}
            
            {/* Photo overlay — click to pause/resume */}
            {!activeOverlayClip && photoOverlay && (
              <div
                className="video-photo-preview"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  if (isPlaying) {
                    if (photoTimerRef.current) { clearTimeout(photoTimerRef.current); photoTimerRef.current = null; }
                    setIsPlaying(false);
                    isPlayingRef.current = false;
                  } else {
                    setIsPlaying(true);
                    isPlayingRef.current = true;
                    // Resume with remaining duration (use full duration as safe fallback)
                    const clips = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
                    const clip = clips[currentClipIndexRef.current];
                    const remaining = clip ? Math.max(500, (clip.duration - photoElapsedRef.current) * 1000) : 3000;
                    photoTimerRef.current = setTimeout(() => {
                      // advance — trigger by seeking past end
                      const nextIdx = currentClipIndexRef.current + 1;
                      if (nextIdx < clips.length) {
                        currentClipIndexRef.current = nextIdx;
                        // loadClip is inside the useEffect closure, so we trigger via video play
                        // Simplest: just clear photo and let the rAF loop handle it
                        setPhotoOverlay(null);
                        setActiveAssetClip(null);
                      }
                    }, remaining);
                  }
                }}
              >
                <img src={photoOverlay.url} alt={photoOverlay.name} className="video-photo-img" />
                <div className="video-photo-label">{getShortName(photoOverlay.name, 'Photo')}</div>
              </div>
            )}

            {/* Video asset name label */}
            {!activeOverlayClip && !photoOverlay && activeAssetClip?.assetKind === 'video' && (
              <div className="asset-overlay-label" style={{ zIndex: 3 }}>
                Video: {getShortName(activeAssetClip?.name, 'Video')}
              </div>
            )}
          </div>

          {/* Custom video controls — shows total timeline duration including assets */}
          {(() => {
            const totalDur = Math.max(
              (session.timeline || []).filter(s => s.track === 0).reduce((sum, s) => sum + s.duration, 0),
              0.1
            );
            const pct = totalDur > 0 ? Math.min(100, (currentTime / totalDur) * 100) : 0;
            const hasAudioClip = (session.timeline || []).some(s => s.track === 1 && s.assetKind === 'audio');
            return (
              <div style={{ background: '#111', borderTop: '1px solid #222', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                {/* Play/Pause */}
                <button
                  className="btn btn-icon"
                  style={{ padding: '4px', flexShrink: 0 }}
                  onClick={() => {
                    const video = videoRef.current;
                    const av = assetVideoRef.current;
                    if (isPlaying) {
                      video?.pause();
                      av?.pause();
                    } else {
                      const clip = (session.timeline || []).filter(s => s.track === 0).sort((a, b) => a.order - b.order)[currentClipIndexRef.current];
                      if (clip?.assetKind === 'video' && clip.assetUrl && av) {
                        av.volume = 1;
                        av.play().catch(() => {});
                      } else {
                        if (video) video.volume = 1;
                        video?.play().catch(() => {});
                      }
                    }
                  }}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  )}
                </button>

                {/* Time */}
                <span style={{ fontSize: '0.72rem', fontFamily: 'monospace', color: '#9fc5ff', flexShrink: 0, minWidth: '80px' }}>
                  {formatTime(currentTime)} / {formatTime(totalDur)}
                </span>

                {/* Global Volume Control */}
                {hasAudioClip && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '10px', marginRight: '10px' }}>
                    <button
                      type="button"
                      onClick={() => handleGlobalVolumeChange(globalVolume > 0 ? 0 : 1)}
                      style={{ padding: '2px', background: 'transparent', border: 'none', cursor: 'pointer', color: '#9fc5ff' }}
                      title={globalVolume > 0 ? 'Mute' : 'Unmute'}
                    >
                      {globalVolume === 0 ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                          <line x1="23" y1="9" x2="17" y2="15"></line>
                          <line x1="17" y1="9" x2="23" y2="15"></line>
                        </svg>
                      ) : globalVolume < 0.3 ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                      ) : globalVolume < 0.7 ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                      )}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="500"
                      step="5"
                      value={Math.round(globalVolume * 100)}
                      onChange={(e) => handleGlobalVolumeChange(parseInt(e.target.value) / 100)}
                      title="Audio Volume (0-100%)"
                      style={{ width: '60px', cursor: 'pointer', accentColor: '#4a9eff' }}
                    />
                  </div>
                )}

                {/* Scrubber — spans full timeline including assets */}
                <div
                  style={{ flex: 1, height: '4px', background: '#333', borderRadius: '2px', cursor: 'pointer', position: 'relative' }}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pctClick = (e.clientX - rect.left) / rect.width;
                    void jumpToTimelineTime(pctClick * totalDur);
                  }}
                >
                  {/* Progress fill */}
                  <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: '#4a9eff', borderRadius: '2px', transition: 'width 0.05s linear' }} />
                  {/* Thumb */}
                  <div style={{ position: 'absolute', top: '50%', left: `${pct}%`, transform: 'translate(-50%, -50%)', width: '10px', height: '10px', borderRadius: '50%', background: '#fff', boxShadow: '0 0 4px rgba(0,0,0,0.5)' }} />
                </div>

                {/* Keyboard hint */}
                <span style={{ fontSize: '0.6rem', color: '#444', flexShrink: 0, whiteSpace: 'nowrap' }}>
                  
                </span>
              </div>
            );
          })()}

          {/* Editing Controls */}
          <div className="editing-controls">
            <button className="btn btn-icon" title="Cut at playhead position" onClick={handleCut}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>

            {/* Audio controls for selected audio segment - MAIN AUDIO FOCUS */}
            {selectedSegmentId && session.timeline.find(s => s.id === selectedSegmentId)?.assetKind === 'audio' && (() => {
              const seg = session.timeline.find(s => s.id === selectedSegmentId)!;
              const effectiveVol = Math.max(0, Math.min(5, seg.volume ?? 1));
              const vol = Math.round(effectiveVol * 100);
              const track0Dur = session.timeline.filter(s => s.track === 0).reduce((sum, s) => sum + s.duration, 0) || 1;
              const maxDur = (seg.originalDuration && seg.originalDuration > 0) ? seg.originalDuration : track0Dur;
              const duration = Math.round(seg.duration * 10) / 10;
              return (
              <div className="volume-control" style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto', gap: '14px', background: '#1a1a2e', padding: '10px 14px', borderRadius: '8px', border: '1px solid rgba(26,188,156,0.3)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.7rem', color: '#1abc9c', fontWeight: '500', minWidth: 'fit-content' }}>
                  📻 Audio Adjustments (Main Focus)
                </span>
                
                {/* Sound/Volume Control - OVERPOWERS VIDEO */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: 'rgba(26,188,156,0.1)', borderRadius: '4px' }}>
                  <button
                    type="button"
                    onClick={() => handleVolumeChange(selectedSegmentId, Math.max(0, effectiveVol - 0.2))}
                    style={{ width: '26px', height: '26px', borderRadius: '4px', border: '1px solid #333', background: '#111', color: '#1abc9c', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                    title="Decrease volume (−20%)"
                  >
                    −
                  </button>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" strokeWidth="2.5">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                  </svg>
                  <input
                    type="range"
                    min="0"
                    max="500"
                    step="5"
                    value={vol}
                    onChange={(e) => handleVolumeChange(selectedSegmentId, parseInt(e.target.value) / 100)}
                    title={`Audio volume: ${vol}% - ${vol >= 100 ? 'OVERPOWERS video background sound' : 'below video'}`}
                    style={{ width: '110px', cursor: 'pointer', accentColor: '#1abc9c' }}
                  />
                  <button
                    type="button"
                    onClick={() => handleVolumeChange(selectedSegmentId, Math.min(5, effectiveVol + 0.2))}
                    style={{ width: '26px', height: '26px', borderRadius: '4px', border: '1px solid #333', background: '#111', color: '#1abc9c', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                    title="Increase volume (+20%)"
                  >
                    +
                  </button>
                  <span style={{ fontSize: '0.72rem', color: '#1abc9c', minWidth: '55px', fontVariantNumeric: 'tabular-nums', fontWeight: '500' }}>
                    {vol}% {vol >= 100 && '🔊'}
                  </span>
                </div>

                {/* Duration Control - Audio Length */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: 'rgba(26,188,156,0.1)', borderRadius: '4px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      const newDur = Math.max(0.5, duration - 0.5);
                      handleWavelengthChange(selectedSegmentId, newDur);
                    }}
                    style={{ width: '26px', height: '26px', borderRadius: '4px', border: '1px solid #333', background: '#111', color: '#8fd8d2', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                    title="Decrease duration (−0.5s)"
                  >
                    −
                  </button>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8fd8d2" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                  </svg>
                  <input
                    type="range"
                    min="0.5"
                    max={maxDur}
                    step="0.1"
                    value={duration}
                    onChange={(e) => handleWavelengthChange(selectedSegmentId, parseFloat(e.target.value))}
                    title={`Audio duration: ${duration.toFixed(1)}s of ${maxDur.toFixed(1)}s`}
                    style={{ width: '130px', cursor: 'pointer', accentColor: '#8fd8d2' }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const newDur = Math.min(maxDur, duration + 0.5);
                      handleWavelengthChange(selectedSegmentId, newDur);
                    }}
                    style={{ width: '26px', height: '26px', borderRadius: '4px', border: '1px solid #333', background: '#111', color: '#8fd8d2', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                    title="Increase duration (+0.5s)"
                  >
                    +
                  </button>
                  <span style={{ fontSize: '0.72rem', color: '#8fd8d2', minWidth: '58px', fontVariantNumeric: 'tabular-nums', fontWeight: '500' }}>
                    {duration.toFixed(1)}s
                  </span>
                </div>

                {/* Pitch/Frequency Control */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: 'rgba(255,107,107,0.1)', borderRadius: '4px' }}>
                  <button
                    type="button"
                    onClick={() => handleFrequencyChange(selectedSegmentId, Math.max(0.5, (seg.frequency ?? 1) - 0.1))}
                    style={{ width: '26px', height: '26px', borderRadius: '4px', border: '1px solid #333', background: '#111', color: '#ff9999', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                    title="Lower pitch (−0.1x)"
                  >
                    −
                  </button>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ff9999" strokeWidth="2.5">
                    <path d="M9 12l2 2 4-4"/>
                    <path d="M21 12c-1 0-3-1-3-3s2-3 3-3 3 1 3 3-2 3-3 3"/>
                    <path d="M3 12c1 0 3-1 3-3s-2-3-3-3-3 1-3 3 2 3 3 3"/>
                  </svg>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={seg.frequency ?? 1}
                    onChange={(e) => handleFrequencyChange(selectedSegmentId, parseFloat(e.target.value))}
                    title={`Pitch: ${(seg.frequency ?? 1).toFixed(1)}x (0.5x = half speed, 2.0x = double speed)`}
                    style={{ width: '110px', cursor: 'pointer', accentColor: '#ff9999' }}
                  />
                  <button
                    type="button"
                    onClick={() => handleFrequencyChange(selectedSegmentId, Math.min(2.0, (seg.frequency ?? 1) + 0.1))}
                    style={{ width: '26px', height: '26px', borderRadius: '4px', border: '1px solid #333', background: '#111', color: '#ff9999', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                    title="Raise pitch (+0.1x)"
                  >
                    +
                  </button>
                  <span style={{ fontSize: '0.72rem', color: '#ff9999', minWidth: '42px', fontVariantNumeric: 'tabular-nums', fontWeight: '500' }}>
                    {(seg.frequency ?? 1).toFixed(1)}x
                  </span>
                </div>

                {/* Info Display */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: 'rgba(52,73,94,0.2)', borderRadius: '4px', marginLeft: 'auto' }}>
                  <span style={{ fontSize: '0.65rem', color: '#7f8c8d', whiteSpace: 'nowrap' }}>
                    📊 {seg.duration.toFixed(1)}s / {maxDur.toFixed(1)}s
                  </span>
                </div>
              </div>
              );
            })()}
          </div>

{/* Timeline — Clip Section */}
          <div className="timeline">
            <div className="timeline-inner">
              {/* Total timeline duration = sum of all clip durations (includes assets on track 0) */}
              {(() => {
                const track0Segments = (session.timeline || []).filter(s => s.track === 0);
                const totalDur = track0Segments.reduce((sum, s) => sum + (s.duration || 0), 0) || 1;
                const MIN_PX_PER_SEC = 1.5;
                const MIN_CLIP_PX = 35;
                const totalPx = Math.max(
                  track0Segments.reduce((sum, s) => sum + Math.max(MIN_CLIP_PX, s.duration * MIN_PX_PER_SEC), 0),
                  200
                );
                return (
                  <>
                    <div className="timeline-header">
                      <span className="timeline-time">{formatTime(currentTime)} / {formatTime(totalDur)}</span>
                    </div>

                    {/* Scrollable area: ruler + video track + playhead */}
                    <div style={{ position: 'relative' }}>
                    <div
                      className={`timeline-content ${isDraggingPlayhead ? 'dragging' : ''}`}
                      ref={timelineRef}
                      style={{ overflowX: 'auto', overflowY: 'hidden', position: 'relative' }}
                      onClick={(e) => {
                        if (!videoRef.current || isDraggingPlayhead) return;
                        const container = e.currentTarget;
                        const rect = container.getBoundingClientRect();
                        // Account for scroll offset and pixel container width
                        const clickPx = (e.clientX - rect.left) + container.scrollLeft;
                        const clickTime = (clickPx / totalPx) * totalDur;
                        void jumpToTimelineTime(clickTime);
                      }}
                      onDragOver={handleTimelineDragOver}
                      onDrop={handleTimelineDrop}
                    >
                      {/* Inner container — pixel-based so it grows and scrolls */}
                      <div style={{ width: `${totalPx}px`, minWidth: '100%', position: 'relative' }}>
                      {/* Timeline Ruler (Timestamps) */}
                      <div className="timeline-ruler" style={{ position: 'relative', height: '14px', borderBottom: '1px solid #333', marginBottom: '4px' }}>
                        {[...Array(11)].map((_, i) => {
                          const pct = i * 10;
                          const timeAtMark = (totalDur * pct) / 100;
                          const transform = i === 0 ? 'translateX(0)' : i === 10 ? 'translateX(-100%)' : 'translateX(-50%)';
                          const align = i === 0 ? 'flex-start' : i === 10 ? 'flex-end' : 'center';
                          return (
                            <div key={`ruler-${i}`} style={{ position: 'absolute', left: `${pct}%`, transform, fontSize: '0.65rem', color: '#888', display: 'flex', flexDirection: 'column', alignItems: align }}>
                              <span style={{ userSelect: 'none' }}>{formatTime(timeAtMark)}</span>
                              <div style={{ height: '6px', width: '1px', background: '#555', marginTop: '2px' }} />
                            </div>
                          );
                        })}
                      </div>

                      {/* Single clip track (track 0) — pixel widths */}
                      <div
                        className="timeline-track"
                        data-track={0}
                        style={{ position: 'relative', height: '44px', background: 'rgba(10, 10, 20, 0.4)', borderRadius: '6px', border: '1px solid #2a2a3e', overflow: 'hidden', marginTop: '4px', display: 'flex', width: '100%' }}
                        onDragOver={handleTrackDragOver}
                        onDrop={(e) => handleTrackDrop(0, e)}
                      >
                        {/* All segments on track 0 */}
                        {track0Segments.length === 0 ? (
                          <div className="timeline-track-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666', fontSize: '0.75rem', fontStyle: 'italic' }}>No clips - add from Assets tab</div>
                        ) : (
                          track0Segments
                            .sort((a, b) => a.order - b.order)
                            .map((segment, index) => {
                              const clipPx = Math.max(MIN_CLIP_PX, segment.duration * MIN_PX_PER_SEC);
                              
                              const clipLabel = segment.assetKind === 'photo'
                                ? 'Photo'
                                : segment.assetKind === 'video'
                                  ? 'Video'
                                  : segment.assetKind === 'audio'
                                    ? 'Audio'
                                    : `Clip ${index + 1}`;

                              return (
                                <div
                                  key={segment.id}
                                  className={`timeline-segment${selectedSegmentId === segment.id ? ' selected' : ''}${draggedSegmentId === segment.id ? ' dragging' : ''}`}
                                  title={getShortName(segment.name, clipLabel)}
                                  style={{
                                    position: 'relative',
                                    height: '100%',
                                    flex: `0 0 ${clipPx}px`,
                                    width: `${clipPx}px`,
                                    backgroundColor: segment.assetKind
                                      ? getAssetColor(segment.assetKind)
                                      : (segment.color || getClipColor(segment.order)),
                                    boxSizing: 'border-box',
                                    borderRight: '1px solid #000',
                                    borderTop: selectedSegmentId === segment.id ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)',
                                    borderBottom: selectedSegmentId === segment.id ? '2px solid #fff' : '1px solid rgba(0,0,0,0.5)',
                                    borderLeft: dragOverSegmentId === segment.id && dragOverSide === 'left'
                                      ? '3px solid #4a9eff'
                                      : selectedSegmentId === segment.id ? '2px solid #fff' : 'none',
                                    cursor: 'grab',
                                    transition: draggedSegmentId ? 'none' : 'all 0.3s ease',
                                    zIndex: selectedSegmentId === segment.id ? 10 : 2,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    overflow: 'hidden',
                                    outline: dragOverSegmentId === segment.id && dragOverSide === 'right'
                                      ? '3px solid #4a9eff'
                                      : 'none',
                                    outlineOffset: '-1px',
                                  }}
                                  onClick={(e) => handleSegmentClick(segment.id, e)}
                                  draggable={true}
                                  onDragStart={(e) => handleSegmentDragStart(segment.id, e)}
                                  onDragEnd={handleSegmentDragEnd}
                                  onDragOver={(e) => handleSegmentDragOver(segment.id, e)}
                                  onDragLeave={(e) => handleSegmentDragLeave(segment.id, e)}
                                  onDrop={(e) => handleSegmentDrop(segment.id, e)}
                                >
                                  <span className="segment-label" style={{ fontWeight: 600, textAlign: 'center', fontSize: '0.7rem', color: '#fff', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', maxWidth: '100%', display: 'block', padding: '0 4px', textShadow: '0 1px 2px rgba(0,0,0,0.8)', zIndex: 3 }}>
                                    {getShortName(segment.name, clipLabel)}
                                  </span>
                                </div>
                              );
                            })
                        )}
                      </div>

                      {/* Audio track — inside scroll so it aligns with video clips */}
                      <div
                        className="timeline-track audio-track"
                        data-track={1}
                        style={{ position: 'relative', background: 'rgba(26,188,156,0.06)', borderRadius: '4px', border: '1px solid rgba(26,188,156,0.18)', height: '34px', overflow: 'visible', marginTop: '3px' }}
                        onDragOver={handleTrackDragOver}
                        onDrop={(e) => handleTrackDrop(1, e)}
                      >
                        {(session.timeline || []).filter(s => s.track === 1).length === 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#3a5a54', fontSize: '0.65rem', fontStyle: 'italic', gap: '4px', pointerEvents: 'none' }}>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                            audio
                          </div>
                        )}
                        {(session.timeline || []).filter(s => s.track === 1).map((segment) => {
                          const leftPx = ((segment.timelineStart ?? 0) / Math.max(totalDur, 1)) * totalPx;
                          const widthPx = Math.max(4, (Math.max(segment.duration || 0, 0) / Math.max(totalDur, 1)) * totalPx);
                          const vol = segment.volume ?? 1;
                          const isActive = currentTime >= (segment.timelineStart ?? 0) && currentTime < (segment.timelineStart ?? 0) + segment.duration;
                          // Color intensity increases with volume - green at 100%, yellow-orange-red as it gets louder
                          let bgColor = '#1abc9c';
                          if (vol > 2) bgColor = '#ff6b6b'; // Red for very loud (200%+)
                          else if (vol > 1.5) bgColor = '#ffa500'; // Orange for loud (150%+)
                          else if (vol > 1) bgColor = '#f1c40f'; // Yellow for high (100%+)
                          return (
                            <div
                              key={segment.id}
                              className={`timeline-segment${selectedSegmentId === segment.id ? ' selected' : ''}${draggedSegmentId === segment.id ? ' dragging' : ''}`}
                              title={`${getShortName(segment.name, 'Audio')} • Volume: ${Math.round(vol * 100)}% ${vol > 1 ? '(overpowers video background sound)' : ''} • Pitch: ${(segment.frequency ?? 1).toFixed(1)}x • Scroll to adjust, Ctrl+Scroll for pitch`}
                              style={{
                                position: 'absolute', top: 0, height: '100%',
                                left: `${leftPx}px`, width: `${widthPx}px`,
                                backgroundColor: bgColor,
                                boxSizing: 'border-box',
                                border: selectedSegmentId === segment.id ? '2px solid #fff' : isActive ? `2px solid ${bgColor}` : '1px solid rgba(26,188,156,0.5)',
                                cursor: resizingSegmentId === segment.id ? 'ew-resize' : 'grab',
                                borderRadius: '3px', display: 'flex', alignItems: 'center', overflow: 'hidden',
                                zIndex: selectedSegmentId === segment.id ? 10 : isActive ? 5 : 1,
                                opacity: isActive ? 1 : 0.85,
                                boxShadow: isActive ? `0 0 8px ${bgColor}80` : 'none',
                                transition: 'all 0.2s ease',
                              }}
                              onClick={(e) => handleSegmentClick(segment.id, e)}
                              draggable={resizingSegmentId !== segment.id}
                              onDragStart={(e) => handleSegmentDragStart(segment.id, e)}
                              onDragEnd={handleSegmentDragEnd}
                              onWheel={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                // Scroll up = increase, scroll down = decrease, step 10%
                                const delta = e.deltaY < 0 ? 0.1 : -0.1;
                                if (e.ctrlKey || e.metaKey) {
                                  // Ctrl+scroll adjusts frequency/pitch
                                  const currentFreq = segment.frequency ?? 1;
                                  const newFreq = Math.min(2.0, Math.max(0.5, currentFreq + delta));
                                  handleFrequencyChange(segment.id, Math.round(newFreq * 10) / 10);
                                } else {
                                  // Regular scroll adjusts volume
                                  const newVol = Math.min(5, Math.max(0, vol + delta));
                                  handleVolumeChange(segment.id, Math.round(newVol * 10) / 10);
                                }
                              }}
                            >
                              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '6px', cursor: 'ew-resize', zIndex: 2 }} onMouseDown={(e) => handleResizeMouseDown(e, segment.id, 'left')} />
                              <span style={{ fontSize: '0.6rem', color: '#fff', padding: '0 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, textShadow: '0 1px 2px rgba(0,0,0,0.8)', zIndex: 1, textAlign: 'center', fontWeight: vol > 1 ? '600' : '500' }}>
                                {getShortName(segment.name, 'Audio')} {Math.round(vol * 100)}% {vol > 1 && '🔊'}
                              </span>
                              <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '6px', cursor: 'ew-resize', zIndex: 2 }} onMouseDown={(e) => handleResizeMouseDown(e, segment.id, 'right')} />
                            </div>
                          );
                        })}
                      </div>

                      {/* Playhead — inside pixel container, aligned with clips */}
                      <div
                        className={`timeline-playhead ${isDraggingPlayhead ? 'dragging' : ''}`}
                        style={{
                          position: 'absolute',
                          left: `${(currentTime / totalDur) * totalPx}px`,
                          top: 0,
                          bottom: 0,
                          zIndex: 20,
                          pointerEvents: 'auto',
                        }}
                        onMouseDown={handlePlayheadMouseDown}
                      />
                      </div>{/* end inner pixel-width container */}
                    </div>{/* end scrollable timeline-content */}
                    </div>{/* end position:relative wrapper */}
                  </>
                );
              })()}
            </div>
          </div>
        </main>
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
            AI Edits
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
            <div className="clips-tab">
              <div style={{ marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff' }}>Timeline Clips</h3>
              </div>
              {/* Hidden file input for per-clip local insert */}
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept="video/*,image/*,audio/*"
                onChange={handleLocalFileInsert}
              />
              {session.timeline.filter(s => s.track === 0).length === 0 ? (
                <div style={{ color: '#666', textAlign: 'center', padding: '2rem 1rem' }}>
                  No clips yet. Add from Assets tab.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {session.timeline
                    .filter(s => s.track === 0)
                    .sort((a, b) => a.order - b.order)
                    .map((clip, i) => (
                      <div
                        key={clip.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', clip.id);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.currentTarget.style.borderTop = `2px solid #4a9eff`;
                        }}
                        onDragLeave={(e) => {
                          e.currentTarget.style.borderTop = '';
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.currentTarget.style.borderTop = '';
                          const draggedId = e.dataTransfer.getData('text/plain');
                          if (!draggedId || draggedId === clip.id) return;
                          const track0 = session.timeline
                            .filter(s => s.track === 0)
                            .sort((a, b) => a.order - b.order);
                          const fromIdx = track0.findIndex(s => s.id === draggedId);
                          const toIdx = track0.findIndex(s => s.id === clip.id);
                          if (fromIdx < 0 || toIdx < 0) return;
                          const reordered = [...track0];
                          const [moved] = reordered.splice(fromIdx, 1);
                          reordered.splice(toIdx, 0, moved);
                          let t = 0;
                          const adjusted = reordered.map((s, idx) => {
                            const r = { ...s, order: idx, timelineStart: t };
                            t += s.duration;
                            return r;
                          });
                          const others = session.timeline.filter(s => s.track !== 0);
                        const previousSnapshot = saveFullSessionSnapshot(session);
                          const updatedSession = {
                            ...session,
                            timeline: [...adjusted, ...others],
                          undoStack: [...session.undoStack, { 
                            type: 'FULL_SNAPSHOT' as const, 
                            previousSnapshot, 
                            actionType: 'REORDER' as const 
                          }],
                            redoStack: [],
                          };
                          setSession(updatedSession);
                          void sessionManager.saveSession(sessionId, updatedSession);
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.6rem',
                          padding: '0.6rem 0.75rem', background: selectedSegmentId === clip.id ? '#1e2a3a' : '#2a2a2a', borderRadius: '8px',
                          borderLeft: `4px solid ${clip.color || getClipColor(i)}`,
                          cursor: 'grab', userSelect: 'none',
                          transition: 'background 0.15s',
                          outline: selectedSegmentId === clip.id ? '1px solid #4a9eff' : 'none',
                        }}
                        onClick={() => {
                          isJumpingRef.current = true; // block rAF from overwriting currentTime
                          setSelectedSegmentId(clip.id);
                          setCurrentTime(clip.timelineStart ?? 0);
                          currentClipIndexRef.current = i;
                          void jumpToTimelineTime((clip.timelineStart ?? 0) + 0.001).then(() => {
                            const video = videoRef.current;
                            const av = assetVideoRef.current;
                            if (clip.assetKind === 'video' && clip.assetUrl && av) {
                              av.play().catch(() => {});
                            } else if (clip.assetKind !== 'photo') {
                              video?.play().catch(() => {});
                            }
                          });
                        }}
                      >
                        {/* Drag handle */}
                        <svg width="12" height="16" viewBox="0 0 12 16" fill="#555" style={{ flexShrink: 0 }}>
                          <circle cx="4" cy="3" r="1.5"/><circle cx="8" cy="3" r="1.5"/>
                          <circle cx="4" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>
                          <circle cx="4" cy="13" r="1.5"/><circle cx="8" cy="13" r="1.5"/>
                        </svg>
                        {/* Color dot */}
                        <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: clip.color || getClipColor(i), flexShrink: 0 }} />
                        {/* Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {clip.name || `Clip ${i + 1}`}
                          </div>
                          <div style={{ fontSize: '0.7rem', color: '#777' }}>
                            {clip.duration.toFixed(1)}s
                          </div>
                        </div>
                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '3px', alignItems: 'center', flexShrink: 0 }}>
                          {/* Jump */}
                          <button
                            className="btn btn-icon"
                            style={{ padding: '4px' }}
                            title="Jump to clip"
                            onClick={(e) => { e.stopPropagation(); jumpToTimelineTime(clip.timelineStart ?? 0); }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                          </button>
                          {/* Insert local file after this clip */}
                          <button
                            className="btn btn-icon"
                            style={{ padding: '4px', color: '#4a9eff' }}
                            title="Insert file after this clip"
                            disabled={isUploadingAsset}
                            onClick={(e) => {
                              e.stopPropagation();
                              insertAfterClipIdRef.current = clip.id;
                              fileInputRef.current?.click();
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="17 8 12 3 7 8" />
                              <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                          </button>
                          {/* Delete */}
                          <button
                            className="btn btn-icon"
                            style={{ padding: '4px', color: '#e74c3c' }}
                            title="Delete clip"
                          onClick={(e) => { e.stopPropagation(); handleDelete(); }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
          {activeTab === 'assets' && session && (
            <AssetsTab onAddToTimeline={(asset, photoDuration) => {
              const assetName = (asset as any).name || asset.tags || 'Asset';
              const assetDuration = photoDuration || (asset._kind === 'video' ? (asset as any).duration : asset._kind === 'audio' ? (asset as any).duration : 5);
              const isAudio = asset._kind === 'audio';

              // For audio: resolve preview URL from freesound previews
              // For video: use proxied small video URL
              // For photo: use proxied preview URL
              let assetUrl = '';
              if (isAudio) {
                const previews = (asset as any).previews || {};
                assetUrl = getAssetPreviewUrl(previews['preview-hq-mp3'] || previews['preview-lq-mp3'] || '');
              } else if (asset._kind === 'video') {
                assetUrl = getAssetPreviewUrl((asset as any).videos?.small?.url || (asset as any).videos?.medium?.url || '');
              } else {
                assetUrl = getAssetPreviewUrl((asset as any).previewURL || (asset as any).webformatURL || '');
              }

              if (isAudio) {
                // Audio goes to track 1 at the current playhead position
                const track0Segments = session.timeline.filter(s => s.track === 0);
                const totalDur = track0Segments.reduce((sum, s) => sum + s.duration, 0);
                const insertAt = Math.min(currentTime, totalDur);

                const newSegment: TimelineSegment = {
                  id: `asset-${Date.now()}`,
                  name: assetName,
                  assetUrl,
                  assetKind: 'audio',
                  duration: assetDuration,
                  timelineStart: insertAt,
                  sourceStart: 0,
                  sourceEnd: assetDuration,
                  order: session.timeline.filter(s => s.track === 1).length,
                  track: 1,
                  color: getAssetColor('audio'),
                  volume: 1,
                  originalDuration: assetDuration,
                };
              // Phase 4.14: Capture FULL session snapshot BEFORE mutation
              const previousSnapshot = saveFullSessionSnapshot(session);

              setSession({
                ...session,
                timeline: [...session.timeline, newSegment],
                undoStack: [...session.undoStack, { 
                  type: 'FULL_SNAPSHOT' as const,
                  previousSnapshot,
                  actionType: 'ADD_ASSET' as const
                }],
                redoStack: [],
              });
              return;
              }

              const newSegment: TimelineSegment = {
                id: `asset-${Date.now()}`,
                name: assetName,
                assetUrl,
                assetKind: asset._kind as 'video' | 'photo',
                duration: assetDuration,
                timelineStart: 0,
                sourceStart: 0,
                sourceEnd: assetDuration,
                order: 0,
                track: 0,
                color: getAssetColor(asset._kind),
              };

              const track0Segments = session.timeline.filter(s => s.track === 0).sort((a, b) => a.order - b.order);
              let newTrack0: TimelineSegment[] = [];

              // Priority: selected clip → red line position
              if (selectedSegmentId) {
                // Insert after the selected clip
                const selIdx = track0Segments.findIndex(s => s.id === selectedSegmentId);
                const insertAfter = selIdx >= 0 ? selIdx : track0Segments.length - 1;
                newTrack0 = [
                  ...track0Segments.slice(0, insertAfter + 1),
                  newSegment,
                  ...track0Segments.slice(insertAfter + 1),
                ];
              } else {
                // Fall back to red line: split clip at currentTime or insert at boundary
                let cutMade = false;
                for (let i = 0; i < track0Segments.length; i++) {
                  const seg = track0Segments[i];
                  const start = seg.timelineStart ?? 0;
                  const end = start + seg.duration;
                  if (currentTime > start + 0.05 && currentTime < end - 0.05) {
                    const cutOffset = currentTime - start;
                    const sourceCutTime = (seg.sourceStart ?? 0) + cutOffset;
                    const segment1: TimelineSegment = { ...seg, id: `${seg.id}-1`, sourceEnd: sourceCutTime, duration: cutOffset };
                    const segment2: TimelineSegment = { ...seg, id: `${seg.id}-2`, sourceStart: sourceCutTime, duration: seg.duration - cutOffset };
                    newTrack0 = [...track0Segments.slice(0, i), segment1, newSegment, segment2, ...track0Segments.slice(i + 1)];
                    cutMade = true;
                    break;
                  }
                }
                if (!cutMade) {
                  // Insert after the last clip whose start <= currentTime
                  let insertAfter = track0Segments.length - 1;
                  for (let i = 0; i < track0Segments.length; i++) {
                    if (currentTime < (track0Segments[i].timelineStart ?? 0)) {
                      insertAfter = i - 1;
                      break;
                    }
                  }
                  newTrack0 = [
                    ...track0Segments.slice(0, insertAfter + 1),
                    newSegment,
                    ...track0Segments.slice(insertAfter + 1),
                  ];
                }
              }

              // Recalculate timelineStart
              let cumulativeTime = 0;
              const adjustedTrack0 = newTrack0.map((seg, idx) => {
                const s = { ...seg, order: idx, timelineStart: cumulativeTime };
                cumulativeTime += seg.duration;
                return s;
              });

              const otherTracks = session.timeline.filter(s => s.track !== 0);
              // Phase 4.14: Capture FULL session snapshot BEFORE mutation
              const previousSnapshot = saveFullSessionSnapshot(session);

              setSession({
                ...session,
                timeline: [...adjustedTrack0, ...otherTracks],
                undoStack: [...session.undoStack, { 
                  type: 'FULL_SNAPSHOT' as const,
                  previousSnapshot,
                  actionType: 'ADD_ASSET' as const
                }],
                redoStack: [],
              });
            }} />
          )}
          {activeTab === 'ai-edit' && (
            <div className="ai-edit-tab" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem' }}>
              {/* Top row: Transcribe | Show/Hide | Download */}
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  className="btn btn-secondary"
                  onClick={handleTranscribe}
                  disabled={isTranscribing}
                  style={{ flex: 1, padding: '0.5rem', fontSize: '0.82rem' }}
                >
                  {isTranscribing ? `Transcribing... (${transcribeTimer.toFixed(1)}s)` : 'Transcribe'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setShowTranscript(v => !v)}
                  title={showTranscript ? 'Hide transcript' : 'Show transcript'}
                  style={{ padding: '0.5rem 0.6rem', fontSize: '0.75rem', minWidth: '36px' }}
                >
                  {showTranscript ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={handleDownloadTranscript}
                  disabled={!session?.transcript}
                  title="Download transcript"
                  style={{ padding: '0.5rem 0.6rem', fontSize: '0.75rem', minWidth: '36px', opacity: session?.transcript ? 1 : 0.4 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
              </div>

              {/* Timestamped transcript segments — collapsible */}
              {showTranscript && (
                <div style={{ flex: 1, overflowY: 'auto', background: '#0d0d1a', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {session?.transcriptSegments && session.transcriptSegments.length > 0 ? (
                    session.transcriptSegments.map((seg, i) => (
                      <div
                        key={i}
                        style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', padding: '0.35rem 0.5rem', borderRadius: '5px', background: 'rgba(255,255,255,0.04)', cursor: 'pointer' }}
                        onClick={() => void jumpToTimelineTime(seg.start)}
                      >
                        <span style={{ fontSize: '0.7rem', color: '#4a9eff', minWidth: '42px', paddingTop: '2px', fontVariantNumeric: 'tabular-nums' }}>
                          {formatTime(seg.start)}
                        </span>
                        <span style={{ fontSize: '0.82rem', color: '#ddd', lineHeight: '1.4' }}>
                          {seg.text.trim()}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: '#444', fontSize: '0.78rem', textAlign: 'center', marginTop: '1rem' }}>
                      {isTranscribing ? `Transcribing... (${transcribeTimer.toFixed(1)}s)` : 'No transcript yet'}
                    </div>
                  )}
                </div>
              )}

              {/* Chat / AI Edit messaging */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: showTranscript ? 0 : 'auto' }}>
                <div ref={chatEndRef} style={{ maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {chatHistory.map((msg, i) => (
                    <div key={i} style={{ padding: '0.45rem 0.7rem', borderRadius: '6px', background: msg.role === 'user' ? '#2a2a3e' : '#1a1a2e', color: '#fff', fontSize: '0.82rem', alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '90%' }}>
                      {msg.content}
                    </div>
                  ))}
                  {isAiEditing && <div style={{ color: '#aaa', fontSize: '0.8rem', fontStyle: 'italic' }}>Thinking...</div>}
                </div>
                <form onSubmit={handleAiEditSubmit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (!isAiEditing && aiPrompt.trim() && session?.transcript) {
                          handleAiEditSubmit(e as any);
                        }
                      }
                    }}
                    placeholder="Type message."
                    disabled={isAiEditing || !session?.transcript}
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid #333', background: '#1a1a2e', color: '#fff', fontSize: '0.82rem', resize: 'vertical', minHeight: '40px', fontFamily: 'inherit' }}
                  />
                  <button type="submit" className="btn btn-primary" disabled={isAiEditing || !aiPrompt.trim() || !session?.transcript} style={{ fontSize: '0.82rem', alignSelf: 'stretch' }}>
                    Send
                  </button>
                </form>
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
  </>
);
}
