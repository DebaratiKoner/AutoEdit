/**
 * Editor Page Component
 * Main editing interface with video player, timeline, and controls
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatTime, logger } from '../utils';
import LZString from 'lz-string';
import type { SessionData, TimelineSegment, CompositionSchema } from '../types';
import { RemotionPreview } from './RemotionPreview';
import { AssetsTab } from './AssetsTab';
import { SessionManager, CompositionBuilder } from '../services';
import { useAuth } from '../auth/Auth';
import './EditorPage.css';

const TRANSCRIBE_MAX_ATTEMPTS = 2;
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 600_000;
const TIMELINE_MIN_PX_PER_SEC = 1.5;
const TIMELINE_MIN_CLIP_PX = 72;
const TIMELINE_MIN_WIDTH_PX = 200;
const TIMELINE_END_PADDING_PX = 0;

/**
 * CRITICAL: Preserve custom clip names across ALL mutations.
 * Returns seg.name if set (never overwrite with "Clip N").
 */
function preserveClipName(seg: TimelineSegment): string {
  // Never force-generate generic names here; if AI/backend produced a title it should win.
  // We only fall back to a short placeholder if absolutely missing.
  return (typeof seg.name === 'string' && seg.name.trim().length > 0) ? seg.name : 'Clip';
}

function getShortName(name: string | undefined | null, fallback: string) {
  if (!name || typeof name !== 'string') return fallback;
  const trimmed = name.trim();
  if (/^clip\s+\d+$/i.test(trimmed)) return trimmed;
  return trimmed || fallback;
}

function getAssetPreviewUrl(url?: string | null, kind?: string) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('/api/')) return url;

  const proxyType =
    kind === 'photo' || kind === 'image'
      ? 'proxy-image'
      : kind === 'audio'
        ? 'proxy-audio'
        : 'proxy-video';

  return `/api/${proxyType}?url=${encodeURIComponent(url)}`;
}


function getAssetColor(assetKind: string) {
  const assetColors = {
    photo: '#e67e22', // Orange
    video: '#9b59b6', // Purple
    audio: '#1abc9c', // Teal
  };
  return assetColors[assetKind as keyof typeof assetColors] || '#2ecc71';
}

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

const getLocalVideoUrl = async (id: string): Promise<string | null> => {
  try {
    const db = await openVideoDatabase();
    return new Promise((resolve) => {
      const transaction = db.transaction(['videos'], 'readonly');
      const store = transaction.objectStore('videos');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result?.file ? URL.createObjectURL(request.result.file) : null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
};

interface EditorPageProps {
  sessionId: string;
  onReset?: () => void;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function fetchWithTranscribeRetry(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= TRANSCRIBE_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), TRANSCRIBE_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (response.ok || response.status < 500 || attempt === TRANSCRIBE_MAX_ATTEMPTS) {
        return response;
      }
    } catch (error: unknown) {
      const err = error as Error;
      lastError = err?.name === 'AbortError'
        ? new Error('Transcription request timed out. Please try a shorter edit or check the backend logs.')
        : error;

      if (attempt === TRANSCRIBE_MAX_ATTEMPTS) {
        throw lastError;
      }
    } finally {
      window.clearTimeout(timeoutId);
    }

    await delay(1000 * attempt);
  }

  throw lastError || new Error('Transcription failed');
}

export function EditorPage({ sessionId, onReset }: EditorPageProps) {
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuth();
  const [session, setSession] = useState<SessionData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeAssetClip, setActiveAssetClip] = useState<TimelineSegment | null>(null);
  const [activeOverlayClip, setActiveOverlayClip] = useState<TimelineSegment | null>(null);
  const [photoOpacity, setPhotoOpacity] = useState(0);
  const [photoName, setPhotoName] = useState<string>('');
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
  const [isUploadingAsset, setIsUploadingAsset] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertAfterClipIdRef = useRef<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeTimer, setTranscribeTimer] = useState(0);
  const [showTranscript, setShowTranscript] = useState(true);
  const [isAiEditing, setIsAiEditing] = useState(false);
  const [isExporting, setIsExporting] = useState<'whole' | 'clips' | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showExportClipsModal, setShowExportClipsModal] = useState(false);
  const [exportSelectedClipIds, setExportSelectedClipIds] = useState<string[]>([]);
  const [globalVolume] = useState(1); // Global audio volume control (0-1) - only affects audio tracks

  const [videoVolume, setVideoVolume] = useState(1); // Video playback volume (0-1)
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
      undoStack: [], // Do not clone undo/redo stacks to prevent O(2^N) memory exponential blow-up
      redoStack: [],
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
        undoStack: [],
        redoStack: [],
        lastModified: Date.now(), // Update timestamp
      };
    } catch (error) {
      logger.error('Failed to restore snapshot:', error);
      throw new Error(`Invalid snapshot: ${error}`);
    }
  }, []);

  const scrollTimelineToSegment = (segmentId: string, track0Segments: TimelineSegment[]) => {
    if (!timelineRef.current || track0Segments.length === 0) return;

    const targetSegment = track0Segments.find((s) => s.id === segmentId);
    if (!targetSegment) return;

    let cumulativePx = 0;
    for (const seg of track0Segments) {
      if (seg.id === targetSegment.id) break;
      cumulativePx += Math.max(TIMELINE_MIN_CLIP_PX, (seg.duration || 0) * TIMELINE_MIN_PX_PER_SEC);
    }

    const clipWidth = Math.max(TIMELINE_MIN_CLIP_PX, (targetSegment.duration || 0) * TIMELINE_MIN_PX_PER_SEC);
    const container = timelineRef.current;
    const scrollTo = Math.max(0, cumulativePx - (container.clientWidth / 2) + (clipWidth / 2));
    container.scrollTo({ left: scrollTo, behavior: 'smooth' });
  };

  const getTimePxMapping = useCallback((allSegments: TimelineSegment[]) => {
    const track0Segments = allSegments.filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    let t0Dur = 0;
    let t0Px = 0;
    for (const s of track0Segments) {
      t0Dur += Number(s.duration) || 0;
      t0Px += Math.max(TIMELINE_MIN_CLIP_PX, (Number(s.duration) || 0) * TIMELINE_MIN_PX_PER_SEC);
    }
    const pxPerSec = t0Dur > 0 ? t0Px / t0Dur : TIMELINE_MIN_PX_PER_SEC;
    
    const timeToPx = (time: number) => {
      let currentPx = 0;
      let currentTime = 0;
      for (const s of track0Segments) {
        const segDur = Number(s.duration) || 0;
        const segPx = Math.max(TIMELINE_MIN_CLIP_PX, segDur * TIMELINE_MIN_PX_PER_SEC);
        if (time <= currentTime + segDur) {
          const pct = segDur > 0 ? (time - currentTime) / segDur : 0;
          return currentPx + (pct * segPx);
        }
        currentPx += segPx;
        currentTime += segDur;
      }
      if (time > currentTime) currentPx += (time - currentTime) * pxPerSec;
      return currentPx;
    };

    const pxToTime = (px: number) => {
      let currentPx = 0;
      let currentTime = 0;
      for (const s of track0Segments) {
        const segDur = Number(s.duration) || 0;
        const segPx = Math.max(TIMELINE_MIN_CLIP_PX, segDur * TIMELINE_MIN_PX_PER_SEC);
        if (px <= currentPx + segPx) {
          const pct = segPx > 0 ? (px - currentPx) / segPx : 0;
          return currentTime + (pct * segDur);
        }
        currentPx += segPx;
        currentTime += segDur;
      }
      if (px > currentPx) return currentTime + (px - currentPx) / pxPerSec;
      return currentTime;
    };

    const maxEndTime = allSegments.reduce((max, s) => Math.max(max, Number(s.timelineStart ?? 0) + Number(s.duration || 0)), t0Dur);
    const totalDur = Math.max(maxEndTime, 0.1);
    const totalPx = Math.max(timeToPx(totalDur), TIMELINE_MIN_WIDTH_PX);

    return { timeToPx, pxToTime, totalDur, totalPx, pxPerSec };
  }, []);

  const scrollTimelineToTime = (targetTime: number, allSegments: TimelineSegment[], scrollToBottom: boolean = false) => {
    if (!timelineRef.current || allSegments.length === 0) return;

    const { timeToPx } = getTimePxMapping(allSegments);
    const targetPx = timeToPx(targetTime);
    const container = timelineRef.current;
    const scrollTo = Math.max(0, targetPx - container.clientWidth / 2);
    
    if (scrollToBottom) {
      container.scrollTo({ left: scrollTo, top: container.scrollHeight, behavior: 'smooth' });
    } else {
      container.scrollTo({ left: scrollTo, behavior: 'smooth' });
    }
  };

  // NOTE: audio lane-pinning helpers are currently unused.
  // const AUDIO_TRACKS = [1, 2, 3, 4] as const;
  // 
  // const rangesOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => {
  //   // Treat touching edges as non-overlapping: [start,end)
  //   return aStart < bEnd && bStart < aEnd;
  // };
  // 
  // const isAudioRangeFreeInLane = (timeline: TimelineSegment[], laneTrack: number, segId: string, start: number, duration: number) => {
  //   const end = start + duration;
  //   const audioInLane = timeline.filter(s => s.assetKind === 'audio' && s.track === laneTrack && s.id !== segId);
  //   return !audioInLane.some(s => {
  //     const sStart = s.timelineStart ?? 0;
  //     const sEnd = sStart + (s.duration ?? 0);
  //     return rangesOverlap(start, end, sStart, sEnd);
  //   });
  // };


  // NOTE: kept for potential future use; currently unused.
  // const findFirstFreeAudioLane = (timeline: TimelineSegment[], segId: string, start: number, duration: number, preferredLanes: readonly number[] = AUDIO_TRACKS) => {
  //   for (const lane of preferredLanes) {
  //     if (isAudioRangeFreeInLane(timeline, lane, segId, start, duration)) return lane;
  //   }
  //   return preferredLanes[0];
  // };


  const pinAudioToTimelineStart = useCallback((timeline: TimelineSegment[]) => (
    timeline.map(seg => seg.assetKind === 'audio'
      ? {
          ...seg,
          track: 1,
          // Do NOT pin audio to 0.00; keep timelineStart so audio can be positioned.
          // If older sessions were saved without timelineStart, fall back to 0.
          timelineStart: seg.timelineStart ?? 0,
          sourceStart: seg.sourceStart ?? 0,
          sourceEnd: seg.sourceEnd ?? seg.duration,
        }
      : seg
    )
  ), []);




  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const currentClipIndexRef = useRef<number>(0);
  const isJumpingRef = useRef<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const assetVideoRef = useRef<HTMLVideoElement>(null);  // dedicated element for asset clips
  const assetPhotoRef = useRef<HTMLImageElement>(null);  // dedicated element for asset photos
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map()); // pool of audio elements for simultaneous playback

  const timelineRef = useRef<HTMLDivElement>(null);
  // const audioTimelineRef = useRef<HTMLDivElement>(null);

  const editPanelRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionData | null>(null);
  const isSwitchingRef = useRef<boolean>(false);
  const currentSrcRef = useRef<string>('');
  const assetSrcRef = useRef<string>('');               // tracks current asset video src
  const [assetVideoOpacity, setAssetVideoOpacity] = useState(0);
  const [mainVideoOpacity, setMainVideoOpacity] = useState(1);
  const TRANSITION_FADE_MS = 250;

  // photo timer ref
  const photoTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemActionRef = useRef<boolean>(false);
  const isPlayingRef = useRef<boolean>(false);
  const wasPlayingBeforeDragRef = useRef<boolean>(false); // New ref to store playback state before dragging
  const photoElapsedRef = useRef<number>(0);
  const photoStartTimeRef = useRef<number>(0); // performance.now() when photo started playing

  const snapshotImgRef = useRef<HTMLImageElement>(null);

  const pausePhotoIfActive = useCallback(() => {
    if (!sessionRef.current) return;
    const sortedClips = [...(sessionRef.current.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    const clip = sortedClips[currentClipIndexRef.current];
    if (clip?.assetKind === 'photo' && photoTimerRef.current) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      photoElapsedRef.current += (performance.now() - photoStartTimeRef.current) / 1000;
      clearTimeout(photoTimerRef.current);
      photoTimerRef.current = null;
    }
  }, []);

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
        const insertAt = 0;

        const newSeg: TimelineSegment = {
          id: `local-${Date.now()}`, name: file.name,
          assetUrl, assetKind: 'audio',
          duration: assetDuration, timelineStart: insertAt,
          sourceStart: 0, sourceEnd: assetDuration,
          order: session.timeline.filter(s => s.assetKind === 'audio').length,
          track: 1, color: getAssetColor('audio'), volume: 1, originalDuration: assetDuration,
        };
        // Phase 4.14: Capture FULL session snapshot BEFORE mutation
        const previousSnapshot = saveFullSessionSnapshot(session);

        const updatedSession = { 
          ...session, 
          timeline: [...session.timeline, newSeg],
          undoStack: [...session.undoStack, { 
            type: 'FULL_SNAPSHOT' as const,
            previousSnapshot,
            actionType: 'ADD_ASSET' as const
          }],
          redoStack: [] 
        };
        setSession(updatedSession);
        void sessionManager.saveSession(sessionId, updatedSession);

        setTimeout(() => {
          scrollTimelineToTime(insertAt, [...session.timeline, newSeg], true);
        }, 100);

        return;
      }

      const track0Segs = session.timeline.filter(s => s.track === 0).sort((a, b) => a.order - b.order);
      let newTrack0: TimelineSegment[] = [];

      const newSeg: TimelineSegment = {
        id: `local-${Date.now()}`, name: file.name,
        assetUrl, assetKind: data.assetType === 'video' ? 'video' : 'photo',
        duration: assetDuration, timelineStart: 0,
        sourceStart: 0, sourceEnd: assetDuration,
        order: 0, track: 0, color: getClipColor(0),
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
          const end = start + Number(seg.duration || 0);
          
          if (currentTime > start + 0.05 && currentTime < end - 0.05) {
            const cutOffset = currentTime - start;
            const sourceCutTime = (seg.sourceStart ?? 0) + cutOffset;
            
            const segBase = { ...seg };
            delete (segBase as { segments?: unknown }).segments;
            const segment1: TimelineSegment = { ...segBase, id: `${seg.id}-1`, sourceEnd: sourceCutTime, duration: cutOffset };
            const segment2: TimelineSegment = { ...segBase, id: `${seg.id}-2`, sourceStart: sourceCutTime, duration: Number(seg.duration || 0) - cutOffset };
            
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
        name: preserveClipName(s),
        color: getClipColor(i)
      }; 
      t += Number(s.duration || 0); 
      return r; 
    });
      const others = session.timeline.filter(s => s.track !== 0);
      // Phase 4.14: Capture FULL session snapshot BEFORE mutation
      const previousSnapshot = saveFullSessionSnapshot(session);

      const updatedSession = { 
        ...session, 
        timeline: [...adjusted, ...others],
        undoStack: [...session.undoStack, { 
          type: 'FULL_SNAPSHOT' as const,
          previousSnapshot,
          actionType: 'ADD_ASSET' as const
        }],
        redoStack: [] 
      };
      setSession(updatedSession);
      void sessionManager.saveSession(sessionId, updatedSession);

      // Scroll timeline to show the newly added clip
      setTimeout(() => {
        scrollTimelineToSegment(newSeg.id, adjusted);
      }, 100);
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
      const response = await fetchWithTranscribeRetry(`/api/videos/${sessionId}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quick: false,
        })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || 'Transcription failed');
      }
      const data = await response.json();

      // No clips are sent here on purpose: AI Edit should use the transcript
      // for the entire uploaded source video, not just the current timeline.
      const latestSession = sessionRef.current || session;
      const updatedSession = {
        ...latestSession,
        transcript: data.transcript,
        transcriptSegments: data.segments || [],
      };
      setSession(updatedSession);
      void sessionManager.saveSession(sessionId, updatedSession);
      setChatHistory(prev => [...prev, { role: 'assistant', content: 'Transcription complete!' }]);
    } catch (e: unknown) {
      const err = e as Error;
      console.error(err);
      alert(`Failed to transcribe video: ${err.message}`);
    } finally {
      setIsTranscribing(false);
    }
  };

  const jumpToTranscriptSourceTime = (sourceTime: number) => {
    if (!session) return;
    const track0Clips = session.timeline
      .filter(s => s.track === 0 && !s.assetUrl)
      .sort((a, b) => a.order - b.order);
    const match = track0Clips.find((seg) => {
      const sourceStart = seg.sourceStart ?? 0;
      const sourceEnd = seg.sourceEnd ?? (sourceStart + Number(seg.duration || 0));
      return sourceTime >= sourceStart && sourceTime < sourceEnd;
    });

    const timelineTime = match
      ? (match.timelineStart ?? 0) + Math.max(0, sourceTime - (match.sourceStart ?? 0))
      : sourceTime;

    void jumpToTimelineTime(timelineTime, session, false, true);
  };

  const handleAiEditSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!session || !aiPrompt.trim()) return;

    const userInput = aiPrompt.trim();
    const currentPrompt = userInput.toLowerCase();
    
    // Add user message to chat
    setAiPrompt('');
    setChatHistory(prev => [...prev, { role: 'user', content: userInput }]);

    // Handle undo/redo typed as text commands
    if (currentPrompt === 'undo' || currentPrompt === 'undo last' || currentPrompt === 'go back' || currentPrompt.startsWith('undo')) {
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

    if (currentPrompt === 'redo' || currentPrompt === 'redo last' || currentPrompt === 'redo it' || currentPrompt.startsWith('redo')) {
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
              // Full-video transcripts use original source timestamps, so match
              // transcript context against each clip's source window.
              let text = '';
              let detailedTranscript = '';
              if (session.transcriptSegments) {
                const sourceStart = s.sourceStart ?? 0;
                const sourceEnd = s.sourceEnd ?? (sourceStart + s.duration);
                const overlappingSegs = session.transcriptSegments
                  .filter(ts => ts.start < sourceEnd && ts.end > sourceStart);
                text = overlappingSegs.map(ts => ts.text).join(' ').trim();
                
                // Build a detailed transcript with exact source timestamps for the AI to pick split_time from
                detailedTranscript = overlappingSegs.map(ts => {
                  return `[${Number(ts.start || 0).toFixed(1)}s] ${ts.text.trim()}`;
                }).join(' ');
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
                detailedTranscript,
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
      const track0 = (data.clips || []).map((clip: Record<string, any>, i: number) => {
        // Try to find the original segment by exact ID, or if the AI appended a suffix for a split
        const origSeg = session.timeline.find(s => 
          s.id === clip.id || 
          clip.originalId === s.id || 
          (typeof clip.id === 'string' && clip.id.startsWith(s.id + '-')) ||
          (typeof clip.id === 'string' && clip.id.startsWith(s.id + '_'))
        );
        const assetUrl = clip.assetUrl ?? origSeg?.assetUrl;
        const assetKind = clip.assetKind ?? origSeg?.assetKind;
        const srcStart = clip.sourceStart ?? clip.start ?? (origSeg?.sourceStart ?? 0);
        const srcEnd = clip.sourceEnd ?? clip.end ?? (origSeg?.sourceEnd ?? 0);
        const mergedSegments = clip.segments ?? (origSeg as { segments?: unknown[] })?.segments;
        const mergedDuration = Array.isArray(mergedSegments)
          ? mergedSegments.reduce((sum: number, segment: Record<string, any>) => (
              sum + ((segment.sourceEnd ?? segment.end ?? 0) - (segment.sourceStart ?? segment.start ?? 0))
            ), 0)
          : 0;
        const duration = clip.duration ?? (mergedDuration || (srcEnd - srcStart));
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
          color: getClipColor(i),
          name,
          assetUrl,
          assetKind,
          volume: clip.volume ?? origSeg?.volume,
          segments: mergedSegments,
        };
      });
      // Recalculate timelineStart for all clips
      let t = 0;
      const adjustedTrack0 = track0.map((seg: any) => {
        const s = { ...seg, timelineStart: t };
        t += Number(seg.duration || 0);
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

      // Scroll timeline to show the AI-edited clips
      // Determine a more specific message for the chat history
      let assistantMessage = 'Done';
      const hasRenameAction = data.operations?.some((op: any) => op.type === 'rename' || op.type === 'rename_by_position' || op.type === 'rename_by_transcript');
      const hasSplitAction = data.operations?.some((op: any) => op.type === 'split' || op.type === 'remove_silence');

      if (hasSplitAction && hasRenameAction) {
        assistantMessage = 'Done';
      } else if (hasRenameAction) {
        assistantMessage = 'Done';
      }

      setChatHistory(prev => [...prev, { role: 'assistant', content: assistantMessage }]);

      // Scroll to the beginning to show the AI-edited clips
      setTimeout(() => { 
        if (timelineRef.current) {
          // Scroll to the beginning to show the AI-edited clips
          const container = timelineRef.current;
          container.scrollTo({ left: 0, behavior: 'smooth' });
        }
      }, 100);

    } catch (e: unknown) {
      const err = e as Error;
      console.error(err);
      setChatHistory(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setIsAiEditing(false);
    }
  };

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
          const nextClip = sortedClips.find(c => !c.assetUrl && (c.sourceStart ?? 0) > t) || sortedClips[0];
          const wasPlaying = isPlayingRef.current;
          void jumpToTimelineTime(nextClip.timelineStart ?? 0, session, false, wasPlaying);
        } else {
          setCurrentTime(sortedClips[0].timelineStart ?? 0);
        }
      }
    } catch (e) {
      logger.error('Video sync error:', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.timeline, session?.sessionId]);

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    const chatScroll = chatScrollRef.current;
    if (!chatScroll) return;

    requestAnimationFrame(() => {
      chatScroll.scrollTo({
        top: chatScroll.scrollHeight,
        behavior: 'smooth',
      });
      chatEndRef.current?.scrollIntoView({ block: 'nearest' });
    });
  }, [chatHistory, isAiEditing]);

  // ── Audio and Video volume sync ──────
  useEffect(() => {
    const video = videoRef.current;
    const av = assetVideoRef.current;
    if (!session) return;

    const audioClips = session.timeline.filter(s => s.track >= 1 && s.assetKind === 'audio' && s.assetUrl);

    const activeVideo = session.timeline.find(s => s.track === 0 && currentTime >= (s.timelineStart ?? 0) && currentTime < (s.timelineStart ?? 0) + (s.duration || 0));
    const activeVideoVol = activeVideo?.volume ?? 1;

    let maxAudioVol = 0;

    // Sync and play/pause ALL active audio tracks simultaneously
    audioClips.forEach(clip => {
      const au = audioRefs.current.get(clip.id);
      if (!au) return;

      const isActive = currentTime >= (clip.timelineStart ?? 0) && currentTime < (clip.timelineStart ?? 0) + (clip.duration || 0);
      
      if (isActive) {
        const offsetInClip = currentTime - (clip.timelineStart ?? 0);
        const sourceOffset = (clip.sourceStart ?? 0) + offsetInClip;
        const vol = Math.max(0, clip.volume ?? 1);
        const freq = Math.max(0.5, Math.min(2.0, clip.frequency ?? 1));
        const volEffective = Math.max(0, Math.min(1, vol * globalVolume));
        
        au.volume = volEffective;
        au.playbackRate = freq;
        if (volEffective > maxAudioVol) maxAudioVol = volEffective;

        if (Math.abs(au.currentTime - sourceOffset) > 0.5) {
          try { au.currentTime = sourceOffset; } catch(e) {}
        }

        if (isPlaying && au.paused) au.play().catch(() => {});
        else if (!isPlaying && !au.paused) au.pause();
      } else {
        if (!au.paused) au.pause();
      }
    });

    const duckedVolume = Math.max(0.05, 1 - (maxAudioVol * 0.4));
    if (video) video.volume = Math.min(1, duckedVolume * videoVolume * activeVideoVol);
    if (av) av.volume = Math.min(1, duckedVolume * videoVolume * activeVideoVol);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, isPlaying, session?.timeline, globalVolume, videoVolume]);

  const preloadNextMedia = useCallback((currentIndex: number) => {
    if (!sessionRef.current) return;
    const sorted = [...(sessionRef.current.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    const currentClip = sorted[currentIndex];
    if (!currentClip) return;

    const video = videoRef.current;
    const av = assetVideoRef.current;

    // 1. Pre-seek main video if we are currently showing an asset
    if (currentClip.assetUrl && video) {
       const nextOriginal = sorted.find((s, i) => i > currentIndex && !s.assetUrl);
       if (nextOriginal) {
          setTimeout(() => {
              if (videoRef.current && videoRef.current.paused) {
                  try {
                      const target = nextOriginal.sourceStart ?? 0;
                      if (Math.abs(videoRef.current.currentTime - target) > 0.2) {
                          videoRef.current.currentTime = target;
                      }
                  } catch(e) {}
              }
          }, 100);
       }
    }

    // 2. Pre-load next asset video if we are currently showing Original or Photo
    if (currentClip.assetKind !== 'video' && av) {
       const nextAssetVid = sorted.find((s, i) => i > currentIndex && s.assetKind === 'video' && s.assetUrl);
       if (nextAssetVid && nextAssetVid.assetUrl) {
           if (assetSrcRef.current !== nextAssetVid.assetUrl) {
               av.src = nextAssetVid.assetUrl;
               assetSrcRef.current = nextAssetVid.assetUrl;
               av.load();
           }
       }
    }
  }, []);

  const advanceToNextClipRef = useRef<(shouldPlay?: boolean) => void>(() => {});

  const advanceToNextClip = useCallback((shouldPlay = false) => {
    advanceToNextClipRef.current(shouldPlay);
  }, []);

  // Pre-load the next media after timeline edits
  useEffect(() => {
    preloadNextMedia(currentClipIndexRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.timeline, preloadNextMedia]);

  // Pre-load all photo assets to ensure smooth transitions
  useEffect(() => {
    if (!session) return;
    session.timeline.forEach(clip => {
      if (clip.assetKind === 'photo' && clip.assetUrl) {
        const img = new Image();
        img.src = getAssetPreviewUrl(clip.assetUrl, clip.assetKind);
      }
    });
  }, [session?.timeline]);

  // Track which asset clip is currently active — based on clip index, not raw video time
  // This fires whenever currentTime changes (every RAF frame during playback)
  useEffect(() => {
    if (!session) { setActiveAssetClip(null); setPhotoOpacity(0); return; }
    const sorted = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    const idx = currentClipIndexRef.current;
    const activeSeg = sorted[idx] ?? null;

    if (activeSeg?.assetUrl) {
      setActiveAssetClip(activeSeg);
      if (activeSeg.assetKind === 'photo') {
        const newUrl = getAssetPreviewUrl(activeSeg.assetUrl, activeSeg.assetKind);
        if (assetPhotoRef.current && assetPhotoRef.current.src !== newUrl) {
          assetPhotoRef.current.src = newUrl;
        }
        setPhotoName(activeSeg.name ?? 'Photo');
        setPhotoOpacity(1);
      } else {
        setPhotoOpacity(0);
      }
    } else {
      setActiveAssetClip(null);
      setPhotoOpacity(0);
    }

    // Evaluate active free-positioned overlays on Track 1
    const track1Clips = (session.timeline || []).filter(s => s.track === 1 && s.assetKind !== 'audio');
    const activeOverlay = track1Clips.find(s => currentTime >= (s.timelineStart ?? 0) && currentTime < (s.timelineStart ?? 0) + (s.duration || 0)); // This was already safe, but good to be consistent
    
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
      if (video && !video.paused) {
        systemActionRef.current = true;
        video.pause();
      }
      if (av && !av.paused) av.pause();

      // PHOTO
      if (clip.assetKind === 'photo' && clip.assetUrl) {
        if (video) video.muted = true;
        const photoUrl = getAssetPreviewUrl(clip.assetUrl, clip.assetKind);
        if (assetPhotoRef.current && assetPhotoRef.current.src !== photoUrl) {
          assetPhotoRef.current.src = photoUrl;
        }
        setPhotoName(clip.name ?? 'Photo');
        setPhotoOpacity(1);
        setActiveAssetClip(clip);
        setAssetVideoOpacity(0);
        setMainVideoOpacity(0);

        photoElapsedRef.current = offset;
        photoStartTimeRef.current = performance.now();
        isSwitchingRef.current = false;
        isJumpingRef.current = false;
        
        preloadNextMedia(currentClipIndexRef.current);
        
        if (shouldPlay) {
          setIsPlaying(true);
          isPlayingRef.current = true;
          const remaining = (clip.duration || 0) - offset;
          photoTimerRef.current = setTimeout(() => {
            advanceToNextClip(isPlayingRef.current);
          }, remaining * 1000);
        }
        return;
      }

      // ASSET VIDEO
      if (clip.assetUrl && clip.assetKind === 'video' && av) {
        if (video) video.muted = true;
        setPhotoOpacity(0);
        setActiveAssetClip(clip);

        // Crossfade: original (videoRef) -> asset (assetVideoRef)
        setMainVideoOpacity(0);
        setAssetVideoOpacity(0);

        // Make the transition deterministic/instant:

        // 1) Switch src (if needed)
        // 2) Seek immediately to the segment offset
        // 3) Play on the next frame (after seek) so the browser starts right away
        if (assetSrcRef.current !== clip.assetUrl) {
          assetSrcRef.current = clip.assetUrl;
          av.src = clip.assetUrl;
          av.load();
        }

        const safeOffset = Math.max(0, Math.min(Number(clip.duration) || 0, offset));
        try { av.currentTime = safeOffset; } catch(e) {}

        av.volume = Math.min(1, (clip.volume ?? 1) * videoVolume);
        setAssetVideoOpacity(1);
        setMainVideoOpacity(0);
        isSwitchingRef.current = false;

        isJumpingRef.current = false;

        preloadNextMedia(currentClipIndexRef.current);

        if (shouldPlay) {
          setIsPlaying(true);
          isPlayingRef.current = true;

          // Play after currentTime is set, so the first frame renders immediately.
          requestAnimationFrame(() => {
            av.play().catch(() => {});
          });
        }
        return;
      }

      // ORIGINAL
      setPhotoOpacity(0);
      setActiveAssetClip(null);
      setAssetVideoOpacity(0);
      setMainVideoOpacity(1);

      if (av && !av.paused) av.pause();
      if (video) video.muted = false;

      const targetTime = (clip.sourceStart ?? 0) + offset;
      try { if (video) video.currentTime = targetTime; } catch(e) {}

      isSwitchingRef.current = false;
      isJumpingRef.current = false;
      
      preloadNextMedia(currentClipIndexRef.current);
      
      if (shouldPlay && video) {
        video.play().catch(() => {});
        setIsPlaying(true);
        isPlayingRef.current = true;
      }
    };

    const advanceToNextClip = (shouldPlay = false) => {
      if (isSwitchingRef.current || isJumpingRef.current) return;
      
      const next = currentClipIndexRef.current + 1;
      if (next < sortedClips.length) {
        currentClipIndexRef.current = next;
        loadClip(sortedClips[next], 0, shouldPlay);
      } else {
        currentClipIndexRef.current = 0;
        setIsPlaying(false);
        isPlayingRef.current = false;
        clearPhotoTimer();
        setPhotoOpacity(0);
        setActiveAssetClip(null);
        setAssetVideoOpacity(0);
        setCurrentTime(0);
        if (video) {
          video.pause();
          try { video.currentTime = sortedClips[0]?.sourceStart ?? 0; } catch(e) {}
        }
        if (av) av.pause();
        audioRefs.current.forEach(au => au.pause());
      }
    };

    advanceToNextClipRef.current = advanceToNextClip;

    const rafLoop = () => {
      if (isSwitchingRef.current || isJumpingRef.current) {
        rafId = requestAnimationFrame(rafLoop);
        return;
      }
      if (sortedClips.length === 0) return;

      const clip = sortedClips[currentClipIndexRef.current];
      if (!clip) {
        rafId = requestAnimationFrame(rafLoop);
        return;
      }

      if (clip.assetKind === 'photo') {
        // Update currentTime during photo display so the scrubber moves
        if (isPlayingRef.current) {
          const wallElapsed = (performance.now() - photoStartTimeRef.current) / 1000;
          const elapsed = photoElapsedRef.current + wallElapsed;
          const photoTime = Math.min(elapsed, Number(clip.duration || 0));
          setCurrentTime((clip.timelineStart ?? 0) + photoTime);
        }
        rafId = requestAnimationFrame(rafLoop);
        return;
      }

      if (clip.assetUrl && clip.assetKind === 'video' && av) {
        // Always update currentTime from asset video position (even if briefly paused during buffering)
        const t = av.currentTime;
        setCurrentTime((clip.timelineStart ?? 0) + t);
        if (!av.paused && t >= Number(clip.duration || 0) - EPS) advanceToNextClip(isPlayingRef.current);
        // Always keep rAF running for asset video
        rafId = requestAnimationFrame(rafLoop);
        return;
      }

      if (video && !video.paused) {
        const sourceOffset = video.currentTime - (clip.sourceStart ?? 0);
        setCurrentTime((clip.timelineStart ?? 0) + Math.max(0, sourceOffset));
        const clipEnd = (clip.sourceStart ?? 0) + Number(clip.duration || 0);
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

      // Unlock and play active audio tracks
      const audioClips = sessionRef.current?.timeline.filter(s => s.track >= 1 && s.assetKind === 'audio') || [];
      audioClips.forEach(clip => {
        const au = audioRefs.current.get(clip.id);
        if (!au) return;
        const isActive = currentTime >= (clip.timelineStart ?? 0) && currentTime < (clip.timelineStart ?? 0) + (clip.duration || 0);
        if (isActive) {
          const sourceOffset = (clip.sourceStart ?? 0) + (currentTime - (clip.timelineStart ?? 0));
          try { au.currentTime = Math.max(0, sourceOffset); } catch(e) {}
          au.play().catch(() => {});
        } else {
          au.play().then(() => au.pause()).catch(() => {}); // unlock
        }
      });
      
      if (clip?.assetKind === 'video' && clip.assetUrl && av) {
        av.play().catch(() => {});
      } else if (clip?.assetKind === 'photo') {


        if (video && !video.paused) {
          systemActionRef.current = true;
          video.pause();
        }
        const offset = photoElapsedRef.current;
        const remaining = (clip.duration || 0) - offset;
        photoStartTimeRef.current = performance.now(); // reset wall-clock start
        photoTimerRef.current = setTimeout(() => {
          advanceToNextClip(isPlayingRef.current);
        }, remaining * 1000);
      } else if (video) {
        video.play().catch(() => {});
      }
      
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(rafLoop);
    };

    const handleUnifiedPause = () => {
      if (systemActionRef.current) {
        systemActionRef.current = false;
        return;
      }
      setIsPlaying(false);
      isPlayingRef.current = false;
      cancelAnimationFrame(rafId);
      
      const clip = sortedClips[currentClipIndexRef.current];
      if (clip?.assetKind === 'photo' && photoTimerRef.current) {
        photoElapsedRef.current += (performance.now() - photoStartTimeRef.current) / 1000;
      }
      clearPhotoTimer();

      if (video && !video.paused) video.pause();
      if (av && !av.paused) av.pause();
      
      audioRefs.current.forEach(au => { if (!au.paused) au.pause(); });
    };

    const handleAssetPlay = () => {
      setIsPlaying(true);
      isPlayingRef.current = true;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(rafLoop);
    };

    const handleAssetPause = () => {
      // Don't stop rAF on asset pause — it may be a brief buffer pause
    };

    const handleAssetEnded = () => advanceToNextClip(isPlayingRef.current);

    video?.addEventListener('play', handleUnifiedPlay);
    video?.addEventListener('pause', handleUnifiedPause);
    av?.addEventListener('play', handleAssetPlay);
    av?.addEventListener('pause', handleAssetPause);
    av?.addEventListener('ended', handleAssetEnded);

    // Always start rAF loop — it self-throttles when paused
    rafId = requestAnimationFrame(rafLoop);

    return () => {
      cancelAnimationFrame(rafId);
      clearPhotoTimer();
      video?.removeEventListener('play', handleUnifiedPlay);
      video?.removeEventListener('pause', handleUnifiedPause);
      av?.removeEventListener('play', handleAssetPlay);
      av?.removeEventListener('pause', handleAssetPause);
      av?.removeEventListener('ended', handleAssetEnded);
    };
  }, [session?.timeline]);

  async function loadSession() {
    let localUrl = null;
    try {
      localUrl = await getLocalVideoUrl(sessionId);
    } catch (e) {
      logger.warn('Failed to get local video url', e);
    }

    // 1. Try to restore a previously saved session (survives refresh)
    const data = await sessionManager.loadSession(sessionId);
    if (data) {
      // Use the local blob URL if available, else fallback to backend stream URL
      const streamUrl = localUrl || `/api/videos/${sessionId}/stream`;
      
      // Migrate: assign colors and tracks to clips that don't have them
      const migratedTimeline = pinAudioToTimelineStart(data.timeline.map((seg, index) => ({
        ...seg,
        color: (seg.track === 0 || seg.track === undefined) ? getClipColor(seg.order ?? index) : (seg.color || getClipColor(index)),
        track: seg.track !== undefined ? seg.track : 0, // Default to track 0
      })));
      
      const restoredSession = { ...data, videoUrl: streamUrl, timeline: migratedTimeline };
      logger.debug('Restored session from storage, videoUrl:', streamUrl);
      setSession(restoredSession);
      
      // Save migrated session
      if (migratedTimeline.some((seg, i) => (
        seg.color !== data.timeline[i].color ||
        seg.timelineStart !== data.timeline[i].timelineStart ||
        seg.sourceStart !== data.timeline[i].sourceStart ||
        seg.sourceEnd !== data.timeline[i].sourceEnd
      ))) {
        void sessionManager.saveSession(sessionId, restoredSession);
      }
      return;
    }

    // 2. Fresh load — build session using backend stream URL directly
    const streamUrl = localUrl || `/api/videos/${sessionId}/stream`;
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
    wasPlayingBeforeDragRef.current = isPlayingRef.current; // Capture playback state before starting drag
    setIsDraggingPlayhead(true);
    if (isPlayingRef.current) { // Check isPlayingRef.current for current playback state
      pausePhotoIfActive(); 
      setIsPlaying(false);
      if (videoRef.current) videoRef.current.pause();
      if (assetVideoRef.current) assetVideoRef.current.pause();
      audioRefs.current.forEach(au => au.pause());
      isPlayingRef.current = false; // Correctly set to false when pausing
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!timelineRef.current || !sessionRef.current) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const session = sessionRef.current;

    if (isDraggingPlayhead && videoRef.current) {
      const mouseX = e.clientX - rect.left;
      const { pxToTime, totalPx } = getTimePxMapping(session.timeline);
      const scrollLeft = timelineRef.current?.scrollLeft ?? 0;
      const clickPx = Math.max(0, Math.min(totalPx, mouseX + scrollLeft));
      const newTime = pxToTime(clickPx);
      
      setCurrentTime(newTime);
      void jumpToTimelineTime(newTime, session, true);
    }

    if (resizingSegmentId && resizeType) {
      const session = sessionRef.current;
      const deltaX = e.clientX - resizeInitialX;
      const { timeToPx, pxToTime } = getTimePxMapping(session.timeline);

      const seg = session.timeline.find(s => s.id === resizingSegmentId);
      // Max = original file duration so you can't exceed it
      const maxDuration = (seg?.originalDuration && seg.originalDuration > 0)
        ? seg.originalDuration
        : (seg?.assetKind === 'audio' ? (seg.duration || 1) : ((seg?.sourceEnd ?? 0) - (seg?.sourceStart ?? 0)));

      let newStart = resizeInitialStart;
      let newDuration = resizeInitialDuration;

      if (resizeType === 'left') {
        const initialStartPx = timeToPx(resizeInitialStart);
        const newStartPx = initialStartPx + deltaX;
        newStart = pxToTime(Math.max(0, newStartPx));
        
        const effectiveDelta = newStart - resizeInitialStart;
        newDuration = Math.max(0.5, resizeInitialDuration - effectiveDelta);
      } else {
        const initialEndPx = timeToPx(resizeInitialStart + resizeInitialDuration);
        const newEndPx = initialEndPx + deltaX;
        const newEnd = pxToTime(Math.max(0, newEndPx));
        newDuration = Math.max(0.5, newEnd - resizeInitialStart);
      }


      if (maxDuration > 0) {
        newDuration = Math.min(maxDuration, newDuration);
        if (resizeType === 'left') {
          newStart = resizeInitialStart + (resizeInitialDuration - newDuration);
        }
      }

      const updatedTimeline = session.timeline.map(s => {
        if (s.id !== resizingSegmentId) return s;

        // Calculate new source window to maintain content alignment during trim
        const updatedTimelineStart = (s.track === 0 || resizeType === 'left') ? newStart : (s.timelineStart ?? 0);
        const delta = updatedTimelineStart - (s.timelineStart ?? 0);
        const updatedSourceStart = Math.max(0, (s.sourceStart ?? 0) + (resizeType === 'left' ? delta : 0));

        return {
          ...s,
          timelineStart: updatedTimelineStart,
          duration: newDuration,
          sourceStart: updatedSourceStart,
          sourceEnd: updatedSourceStart + newDuration,
        };
      });

      setSession({ ...session, timeline: updatedTimeline });
    }
  };

  const handleMouseUp = () => {
    if (isDraggingPlayhead) {
      setIsDraggingPlayhead(false);
      if (wasPlayingBeforeDragRef.current) { // Resume playback only if it was playing before the drag
        const video = videoRef.current;
        const av = assetVideoRef.current;
        if (video && video.paused) video.play().catch(() => {});
        if (av && av.src && av.paused) av.play().catch(() => {});
        audioRefs.current.forEach(au => { if (au.paused) au.play().catch(() => {}); });
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
         setSession(updatedSession);
         void sessionManager.saveSession(sessionId, updatedSession);
      }
      setResizingSegmentId(null);
      setResizeType(null);
    }
  };

  async function jumpToTimelineTime(timelineTime: number, sourceSession: SessionData = session!, isScrubbing: boolean = false, forcePlay: boolean = false) {
    if (!videoRef.current || !sourceSession) return;

    // Keep all timeline lanes (including the audio lane) horizontally aligned.
    // Because the audio lane is rendered inside the same scroll container,
    // we ensure scrollLeft is moved to the playhead position.
    // (This is intentionally done early, so UI updates feel immediate.)
    try {
      scrollTimelineToTime(timelineTime, sourceSession.timeline, false);
    } catch {
      // ignore
    }


    const video = videoRef.current;
    const av = assetVideoRef.current;
    const sorted = [...(sourceSession.timeline || [])]
      .filter(seg => seg.track === 0)
      .sort((a, b) => a.order - b.order);
    if (sorted.length === 0) return;

    const clampedTime = Math.max(0, Math.min(timelineTime, sorted.reduce((sum, seg) => sum + Number(seg.duration || 0), 0)));
    // Prefer the clip that STARTS at or after clampedTime over one that ends exactly at clampedTime
    const segmentIndex = sorted.findIndex(
      seg => clampedTime >= (seg.timelineStart ?? 0) && clampedTime < (seg.timelineStart ?? 0) + Number(seg.duration || 0)
    );
    const targetIndex = segmentIndex >= 0 ? segmentIndex : sorted.length - 1;
    const segment = sorted[targetIndex];
    const offset = Math.max(0, Math.min(Number(segment.duration || 0), clampedTime - (segment.timelineStart ?? 0)));

    currentClipIndexRef.current = targetIndex;
    setCurrentTime((segment.timelineStart ?? 0) + offset);
    isJumpingRef.current = true; // prevent rAF from overwriting currentTime during seek

    if (photoTimerRef.current) { clearTimeout(photoTimerRef.current); photoTimerRef.current = null; }

    const shouldPlayAfterJump = forcePlay || (!isScrubbing && isPlayingRef.current);

    // Photo
    if (segment.assetKind === 'photo' && segment.assetUrl) {
      if (video && !video.paused) {
        systemActionRef.current = true;
      }
      video.pause();
      if (av && !av.paused) av.pause();
      // Mute video to silence any audio when showing photo
      video.muted = true;
      setAssetVideoOpacity(0);
      const photoUrl = getAssetPreviewUrl(segment.assetUrl, segment.assetKind);
      if (assetPhotoRef.current && assetPhotoRef.current.src !== photoUrl) {
        assetPhotoRef.current.src = photoUrl;
      }
      setPhotoName(segment.name ?? 'Photo');
      setPhotoOpacity(1);
      setActiveAssetClip(segment);
      setMainVideoOpacity(0);
      setAssetVideoOpacity(0);
      photoElapsedRef.current = offset;

      isJumpingRef.current = false;
      
      preloadNextMedia(targetIndex);

      if (shouldPlayAfterJump) {
        setIsPlaying(true);
        isPlayingRef.current = true;
        const remaining = (segment.duration || 0) - offset;
        photoStartTimeRef.current = performance.now();
        photoTimerRef.current = setTimeout(() => {
          advanceToNextClip(true);
        }, remaining * 1000);
      }
      return;
    }

    // Asset video
    if (segment.assetKind === 'video' && segment.assetUrl && av) {
      if (video && !video.paused) {
        systemActionRef.current = true;
      }
      video.pause();
      video.muted = true; // Mute original video when showing asset video
      setPhotoOpacity(0);
      setActiveAssetClip(segment);
      setMainVideoOpacity(0);
      setAssetVideoOpacity(0);

      if (assetSrcRef.current !== segment.assetUrl) {
        av.src = segment.assetUrl;
        assetSrcRef.current = segment.assetUrl;
        av.load();
      }
      try { av.currentTime = offset; } catch(e) {}
      setAssetVideoOpacity(1);
      setMainVideoOpacity(0);
      isJumpingRef.current = false;

      
      preloadNextMedia(targetIndex);

      if (shouldPlayAfterJump) { av.play().catch(() => {}); setIsPlaying(true); isPlayingRef.current = true; }
      return;
    }

    // Original video clip
    setPhotoOpacity(0);
    setActiveAssetClip(null);
    setAssetVideoOpacity(0);
    setMainVideoOpacity(1);
    if (av && !av.paused) av.pause();
    video.muted = false; // Unmute when showing original video

    const targetTime = (segment.sourceStart ?? 0) + offset;
    try { video.currentTime = targetTime; } catch(e) { /* ignore */ }
    isJumpingRef.current = false;
    
    preloadNextMedia(targetIndex);

    if (shouldPlayAfterJump) {
      try { video.play().catch(() => {}); setIsPlaying(true); isPlayingRef.current = true; } catch {}
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
          pausePhotoIfActive();
          video?.pause();
          av?.pause();
          audioRefs.current.forEach(au => au.pause());
        } else {
          // Unlock audio elements
          audioRefs.current.forEach(au => au.play().catch(() => {}));

          const clips = (sessionRef.current?.timeline || []).filter(s => s.track === 0).sort((a, b) => a.order - b.order);
          const clip = clips[currentClipIndexRef.current];
          if (clip?.assetKind === 'video' && clip.assetUrl && av) {
            av.play().catch(() => {});
          } else { 
            video?.play().catch(() => {});
          }
          
          const audioClips = (sessionRef.current?.timeline || []).filter(s => s.track >= 1 && s.assetKind === 'audio');
          audioClips.forEach(clip => {
            const au = audioRefs.current.get(clip.id);
            if (!au) return;
                      const isActive = currentTime >= (clip.timelineStart ?? 0) && currentTime < (clip.timelineStart ?? 0) + (clip.duration || 0);
            if (!isActive) return;
            au.play().catch(() => {});
          });
        }
      } else if (e.code === 'ArrowLeft' || e.code === 'KeyJ') {
        e.preventDefault();
        const step = e.code === 'KeyJ' ? 10 : 5;
        void jumpToTimelineTime(Math.max(0, currentTime - step));
      } else if (e.code === 'ArrowRight' || e.code === 'KeyL') {
        e.preventDefault();
        const step = e.code === 'KeyL' ? 10 : 5;
        const totalDur = (sessionRef.current?.timeline || []).filter(s => s.track === 0).reduce((sum, s) => sum + Number(s.duration || 0), 0);
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
      .find(seg => currentTime >= (seg.timelineStart ?? 0) && currentTime < (seg.timelineStart ?? 0) + Number(seg.duration || 0));

    if (!segmentToCut) return;

    const cutOffset = currentTime - (segmentToCut.timelineStart ?? 0);
    const sourceCutTime = (segmentToCut.sourceStart ?? 0) + cutOffset;

    if (cutOffset <= 0.1 || cutOffset >= Number(segmentToCut.duration || 0) - 0.1) {
      alert('Playhead must be inside segment (not at edges)');
      return;
    }
    
    const baseName = segmentToCut.name || `Clip ${segmentToCut.order + 1}`;
    
    const segment1Name = `${baseName}-1`;
    const segment2Name = `${baseName}-2`;

    const segmentBase = { ...segmentToCut };
    delete (segmentBase as { segments?: unknown }).segments;
    
    const segment1: TimelineSegment = {
      ...segmentBase,
      id: `${segmentToCut.id}-1`,
      sourceEnd: sourceCutTime,
      duration: cutOffset,
      name: segment1Name,
    };
    
    const segment2: TimelineSegment = {
      ...segmentBase,
      id: `${segmentToCut.id}-2`,
      sourceStart: sourceCutTime,
      timelineStart: (segmentToCut.timelineStart ?? 0) + cutOffset,
      duration: Number(segmentToCut.duration || 0) - cutOffset,
      name: segment2Name,
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
      const adj = { ...seg, order: i, timelineStart: t, color: getClipColor(i) };
      t += Number(seg.duration || 0);
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

    // Scroll timeline to show the newly cut clips
    setTimeout(() => {
      scrollTimelineToSegment(segment2.id, adjusted);
    }, 100);
  };

  const handleDelete = (specificId?: string) => {
    if (!session) return;

    const previousSnapshot = saveFullSessionSnapshot(session);

    let targetId = typeof specificId === 'string' ? specificId : selectedSegmentId;

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
      .sort((a, b) => {
        if (a.track !== b.track) return a.track - b.track;
        return a.order - b.order;
      });
    
    // Recalculate timeline positions → STRICTLY PRESERVE custom names
    const track0 = newTimeline.filter(s => s.track === 0);
    const others = newTimeline.filter(s => s.track !== 0);
    let cumulativeTime = 0;
    const adjustedTrack0 = track0.map((seg, index) => {
      const adjusted = { 
        ...seg, 
        order: index, 
        timelineStart: cumulativeTime,
        name: preserveClipName(seg),
        color: getClipColor(index)
      };
      cumulativeTime += Number(seg.duration || 0);
      return adjusted;
    });
    const adjustedTimeline = [...adjustedTrack0, ...others];
    
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
    
    const wasPlaying = isPlayingRef.current;
    const deleteStartTime = segmentToDelete.timelineStart ?? 0;

    setSession(updatedSession);
    setSelectedSegmentId(null);
    void sessionManager.saveSession(sessionId, updatedSession);

    setTimeout(() => {
       const track0 = updatedSession.timeline.filter(s => s.track === 0);
       const totalDur = track0.reduce((sum, s) => sum + Number(s.duration || 0), 0);
       const nextTime = Math.min(deleteStartTime, totalDur > 0 ? totalDur - 0.1 : 0);
       void jumpToTimelineTime(nextTime, updatedSession, false, wasPlaying);
    }, 0);
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
        void sessionManager.saveSession(sessionId, updated);
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
        void sessionManager.saveSession(sessionId, updated);
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
    const newClipIndex = (session?.timeline || [])
      .filter(s => s.track === 0).sort((a, b) => a.order - b.order)
      .findIndex(s => s.id === segmentId);
    currentClipIndexRef.current = Math.max(0, newClipIndex); // Ensure currentClipIndexRef.current is never -1
    // Force play the segment after clicking it
    void jumpToTimelineTime((clip.timelineStart ?? 0) + 0.001, session!, false, true);
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
        name: preserveClipName(seg),
        color: getClipColor(idx)
      };
      t += Number(seg.duration || 0);
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
    
    // Only allow audio on the single audio track, and no audio on track 0
    if (trackNum >= 1 && draggedSegment.assetKind !== 'audio') return;
    if (trackNum === 0 && draggedSegment.assetKind === 'audio') return;
    
    e.stopPropagation();

    const finalTrack = draggedSegment.assetKind === 'audio' ? 1 : trackNum;

    // Move segment to new track
    const newTimeline = session.timeline.map(seg => {
      if (seg.id === draggedSegmentId) {
        return { ...seg, track: finalTrack, timelineStart: seg.assetKind === 'audio' ? 0 : seg.timelineStart };
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
      if (targetTrack >= 1 && draggedSegment.assetKind !== 'audio') return;
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
    const mouseX = (e.clientX - rect.left) + (timelineRef.current.scrollLeft ?? 0);
    
    const { pxToTime, totalPx } = getTimePxMapping(session.timeline);
    
    const timePosition = pxToTime(Math.max(0, Math.min(totalPx, mouseX)));
    
    setDragOverPosition(timePosition);
  };

  const handleTimelineDrop = (e: React.DragEvent) => {
    e.preventDefault();
    
    if (!draggedSegmentId || !session || !timelineRef.current || dragOverPosition === null) return;
    
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    if (!draggedSegment) return;
    
    if (draggedSegment.track >= 1) {
      // Audio segments: allow timeline drops to reposition them horizontally.
      const finalTrack = 1;
      const newStart = Math.max(0, dragOverPosition ?? 0);

      const updatedTimeline = session.timeline.map(seg => {
        if (seg.id === draggedSegmentId) {
          return { ...seg, timelineStart: newStart, track: finalTrack };
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
      if (dragOverPosition < (track0Segments[i].timelineStart ?? 0) + (Number(track0Segments[i].duration || 0) / 2)) {
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
      const adjusted = { 
        ...seg, 
        timelineStart: cumulativeTime,
        color: getClipColor(seg.order)
      };
      cumulativeTime += Number(seg.duration || 0);
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

  const handleVolumeChange = (segmentId: string, volume: number) => {
    if (!sessionRef.current) return;
    const session = sessionRef.current;
    const safeVolume = Math.max(0, Math.min(1, volume));
    
    const updatedTimeline = session.timeline.map(seg => 
      seg.id === segmentId ? { ...seg, volume: safeVolume } : seg
    );
    const updatedSession = { 
      ...session,
      timeline: updatedTimeline,
      undoStack: [...session.undoStack, {
        type: 'FULL_SNAPSHOT' as const,
        previousSnapshot: saveFullSessionSnapshot(session), // Capture state *before* this update
        actionType: 'VOLUME_CHANGE' as const
      }],
      redoStack: []
    };
    // Temporarily update session state for immediate UI feedback
    // The full snapshot is captured *before* this update, then the updated session
    // is saved with the snapshot in its undoStack.
    // This ensures that the undo stack correctly points to the state *before* the change.
    // The actual state update for the component happens after the snapshot is taken.
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



  const handleVideoVolumeChange = (volume: number) => {
    const safeVolume = Math.max(0, Math.min(1, volume));
    setVideoVolume(safeVolume);
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

  const filenameFromContentDisposition = (contentDisposition: string | null, fallback: string) => {
    if (!contentDisposition) return fallback;

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1].replace(/"/g, ''));
      } catch {
        return utf8Match[1].replace(/"/g, '');
      }
    }

    const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    return filenameMatch?.[1] || fallback;
  };

  const postExportDownload = async (payload: unknown, mode: 'whole' | 'clips') => {
    try {
      const endpoint = mode === 'whole' ? `/api/videos/${sessionId}/fast-export` : `/api/videos/${sessionId}/export-zip`;
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let message = `Export failed with status ${response.status}`;
        const errorText = await response.text();
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.detail) {
            message = typeof errorJson.detail === 'string'
              ? errorJson.detail
              : JSON.stringify(errorJson.detail);
          }
        } catch {
          if (errorText) message = errorText;
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const fallbackName = mode === 'clips'
        ? `autoedit_clips_${sessionId.slice(0, 8)}.zip`
        : `autoedit_whole_${sessionId.slice(0, 8)}.mp4`;
      const filename = filenameFromContentDisposition(
        response.headers.get('Content-Disposition'),
        fallbackName
      );

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Export error:', error);
      alert(error instanceof Error ? error.message : 'Failed to export video. Please try again.');
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportConfirm = async (mode: 'whole' | 'clips', selectedIds?: string[]) => {
    logger.operation(`Export started - Mode: ${mode}`);

    if (!session || session.timeline.length === 0) {
      alert("No clips to export");
      return;
    }

    setIsExporting(mode);
    setShowExportMenu(false);

    // Decode proxy URLs so the backend can fetch the actual asset, or make local URLs absolute
    const decodedFullTimeline = session.timeline.map(clip => {
      let url = clip.assetUrl;
      if (url) {
        if (url.includes('/api/proxy-')) {
          try {
            const urlObj = new URL(url, window.location.origin);
            const originalUrl = urlObj.searchParams.get('url');
            if (originalUrl) url = originalUrl;
          } catch (e) {
            // ignore
          }
        }
      }
      return { ...clip, assetUrl: url };
    });

    await postExportDownload({
      videoUrl: session.videoUrl,
      timeline: decodedFullTimeline,
      clips: decodedFullTimeline,
      selectedIds,
      transcriptSegments: session.transcriptSegments || [],
      mode,
      preset: 'ultrafast',
      timestamp_str: new Date().toISOString().replace(/[-T:\.Z]/g, '')
    }, mode);

    logger.operation(`${mode} export download requested`);
  };

  const handleGenerateShort = () => {
    if (!session) return;
    
    navigate('/shorts', {
      state: {
        fromEditor: true,
        serverSessionId: sessionId,
        instruction: aiPrompt,
        transcriptSegments: session.transcriptSegments || [],
        source: {
          filename: `Session ${sessionId.slice(0, 8)}.mp4`,
          duration: session.duration,
          width: session.resolution?.width || 1920,
          height: session.resolution?.height || 1080,
          fps: 30,
          url: session.videoUrl
        }
      }
    });
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
            {isAuthenticated ? (
              <button className="btn btn-secondary" onClick={() => { logout(); navigate('/auth?mode=login'); }}>Log out</button>
            ) : (
              <button className="btn btn-secondary" style={{ background: '#4a9eff', color: '#fff', border: 'none' }} onClick={() => navigate('/auth?mode=login')}>Log in</button>
            )}
            <button className="btn btn-secondary" onClick={() => setShowResetDialog(true)}>
              Reset
            </button>
            <button 
              className="btn btn-secondary" 
              onClick={handleGenerateShort}
              disabled={isExporting !== null}
            >
              Generate Short
            </button>
            <div className="export-menu" style={{ position: 'relative' }}>
              <button
                className="btn btn-primary"
                onClick={() => setShowExportMenu(!showExportMenu)}
                disabled={isExporting !== null}
              >
                {isExporting ? `Exporting ${isExporting}...` : 'Export ▼'}
              </button>
              {showExportMenu && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 999 }}
                    onClick={() => setShowExportMenu(false)}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      right: 0,
                      marginTop: '0.5rem',
                      backgroundColor: '#1e2a3a',
                      border: '1px solid #4a9eff',
                      borderRadius: '6px',
                      overflow: 'hidden',
                      zIndex: 1000,
                      minWidth: '200px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    }}
                  >
                    <button
                      className="btn"
                      style={{ width: '100%', textAlign: 'left', padding: '0.75rem 1rem', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.9rem' }}
                      onClick={() => handleExportConfirm('whole')}
                    >
                      Export as full video
                    </button>
                    <div style={{ height: '1px', background: '#2a2a3e' }} />
                    <button
                      className="btn"
                      style={{ width: '100%', textAlign: 'left', padding: '0.75rem 1rem', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '0.9rem' }}
                      onClick={() => {
                        setShowExportMenu(false);
                        setShowExportClipsModal(true);
                        if (session) {
                          setExportSelectedClipIds(session.timeline.filter(s => s.track === 0).map(s => s.id));
                        }
                      }}
                    >
                      Export as separate clips 
                    </button>
                  </div>
                </>
              )}
            </div>
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
                style={{ width: '100%', height: '100%', objectFit: 'contain', flex: 1, opacity: mainVideoOpacity, transition: `opacity ${TRANSITION_FADE_MS}ms linear` }}

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
                  transition: `opacity ${TRANSITION_FADE_MS}ms linear`,
                  pointerEvents: 'none',
                  backgroundColor: '#000',
                }}

                crossOrigin="anonymous"
                preload="auto"
                playsInline
                muted={false}
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
                  backgroundColor: 'transparent'
                }}
              />

              {/* Pool of hidden audio elements for simultaneous playback */}
              {session.timeline.filter(s => s.assetKind === 'audio' && s.assetUrl).map(clip => (
                <audio
                  key={clip.id}
                  ref={el => {
                    if (el) audioRefs.current.set(clip.id, el);
                    else audioRefs.current.delete(clip.id);
                  }}
                  src={clip.assetUrl}
                  preload="auto"
                  style={{ display: 'none' }}
                  muted={false}
                  playsInline
                />
              ))}

              </>
            )}

            {/* Overlay render logic for new Track 1 active visual assets */}
            {activeOverlayClip && activeOverlayClip.assetUrl && (
              <div className="video-photo-preview">
                {activeOverlayClip.assetKind === 'photo' ? (
                  <img src={getAssetPreviewUrl(activeOverlayClip.assetUrl, activeOverlayClip.assetKind)} alt={activeOverlayClip.name} className="video-photo-img" />
                ) : activeOverlayClip.assetKind === 'video' ? (
                  <video src={getAssetPreviewUrl(activeOverlayClip.assetUrl, activeOverlayClip.assetKind)} autoPlay muted loop className="video-photo-img" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                ) : null}
                <div className="video-photo-label">{getShortName(activeOverlayClip.name, activeOverlayClip.assetKind === 'photo' ? 'Photo' : 'Video')}</div>
              </div>
            )}
            
            {/* Photo overlay (Track 0) — click to pause/resume */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 3,
                  backgroundColor: '#000',
                  opacity: photoOpacity,
                  pointerEvents: photoOpacity > 0 ? 'auto' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  const video = videoRef.current;
                  const av = assetVideoRef.current;
                  if (isPlaying) {
                    pausePhotoIfActive();
                    video?.pause();
                    av?.pause();
                    audioRefs.current.forEach(au => au.pause());
                  } else {
                    const clip = (session.timeline || []).filter(s => s.track === 0).sort((a, b) => a.order - b.order)[currentClipIndexRef.current];
                    if (clip?.assetKind === 'video' && clip.assetUrl && av) {
                      av.volume = 1;
                      av.play().catch(() => {});
                    } else {
                      if (video) video.volume = 1;
                      video?.play().catch(() => {});
                    }
                    const audioClips = session.timeline?.filter(s => s.track >= 1 && s.assetKind === 'audio') || [];
                    audioClips.forEach(clip => {
                      const au = audioRefs.current.get(clip.id);
                      if (!au) return;
                      const isActive = currentTime >= (clip.timelineStart ?? 0) && currentTime < (clip.timelineStart ?? 0) + (clip.duration || 0);
                      if (!isActive) return;
                      au.play().catch(() => {});
                    });
                  }
                }}
              >
                <img ref={assetPhotoRef} className="video-photo-img" alt={photoName} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                {!activeOverlayClip && photoName && <div className="video-photo-label">{getShortName(photoName, 'Photo')}</div>}
              </div>

            {/* Video asset name label */}
            {!activeOverlayClip && photoOpacity === 0 && activeAssetClip?.assetKind === 'video' && (
              <div className="asset-overlay-label" style={{ zIndex: 3 }}>
                Video: {getShortName(activeAssetClip?.name, 'Video')}
              </div>
            )}
          </div>

          {/* Custom video controls — shows total timeline duration including assets */}
          {(() => {
            const { totalDur } = getTimePxMapping(session.timeline || []);
            const pct = totalDur > 0 ? Math.min(100, (currentTime / totalDur) * 100) : 0;
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
                      pausePhotoIfActive();
                      video?.pause();
                      av?.pause();
                      audioRefs.current.forEach(au => au.pause());
                    } else {
                      // Unlock audio elements
                      const clip = (session.timeline || []).filter(s => s.track === 0).sort((a, b) => a.order - b.order)[currentClipIndexRef.current];
                      if (clip?.assetKind === 'video' && clip.assetUrl && av) {
                        av.volume = 1;
                        av.play().catch(() => {});
                      } else {
                        if (video) video.volume = 1;
                        video?.play().catch(() => {});
                      }
                      
                      const audioClips = session.timeline?.filter(s => s.track >= 1 && s.assetKind === 'audio') || [];
                      audioClips.forEach(clip => {
                        const au = audioRefs.current.get(clip.id);
                        if (!au) return;
                        const isActive = currentTime >= (clip.timelineStart ?? 0) && currentTime < (clip.timelineStart ?? 0) + (clip.duration || 0);
                        if (!isActive) return;
                        au.play().catch(() => {});
                      });
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

                {/* Audio and Video Volume Controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: '10px', marginRight: '10px' }}>
                  {/* Video Volume Control */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      type="button"
                      onClick={() => handleVideoVolumeChange(videoVolume > 0 ? 0 : 1)}
                      style={{ padding: '2px', background: 'transparent', border: 'none', cursor: 'pointer', color: '#e74c3c' }}
                      title={videoVolume > 0 ? 'Mute video' : 'Unmute video'}
                    >
                      {videoVolume === 0 ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="23 7 16 12 23 17 23 7"></polygon>
                          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                          <line x1="23" y1="1" x2="17" y2="7"></line>
                          <line x1="17" y1="1" x2="23" y2="7"></line>
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="23 7 16 12 23 17 23 7"></polygon>
                          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                        </svg>
                      )}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={Math.round(videoVolume * 100)}
                      onChange={(e) => handleVideoVolumeChange(parseInt(e.target.value) / 100)}
                      title="Video Volume (0-100%)"
                      style={{ width: '60px', cursor: 'pointer', accentColor: '#e74c3c' }}
                    />
                  </div>
                </div>

                {/* Scrubber — spans full timeline including assets */}
                <div
                  style={{ flex: 1, height: '4px', background: '#333', borderRadius: '2px', cursor: 'pointer', position: 'relative' }}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pctClick = (e.clientX - rect.left) / rect.width;
                  void jumpToTimelineTime(pctClick * totalDur, session!, false, true);
                  }}
                >
                  {/* Progress fill */}
                  <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: '#4a9eff', borderRadius: '2px', transition: 'none' }} />
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
              onClick={() => handleDelete()}
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
          </div>

{/* Timeline — Clip Section */}
          <div className="timeline" style={{ display: 'flex', flexDirection: 'column', flex: '0 0 40%', minHeight: '200px', maxHeight: '400px', backgroundColor: '#141423', borderTop: '1px solid #2a2a3e' }}>
            <div className="timeline-inner" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {/* Total timeline duration = sum of all clip durations (includes assets on track 0) */}
              {(() => {
          const { timeToPx, pxToTime, totalDur, totalPx } = getTimePxMapping(session.timeline || []);
                const scrollableTimelinePx = totalPx + TIMELINE_END_PADDING_PX;
          const track0Segments = (session.timeline || []).filter(s => s.track === 0).sort((a, b) => a.order - b.order);

                return (
                  <>
                    <div className="timeline-header">
                      <span className="timeline-time">{formatTime(currentTime)} / {formatTime(totalDur)}</span>
                    </div>

                    {/* Scrollable area: ruler + video track + playhead */}
                    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                    <div
                      className={`timeline-content ${isDraggingPlayhead ? 'dragging' : ''}`}
                      ref={timelineRef}
                      style={{ overflow: 'auto', position: 'relative', flex: 1, minHeight: 0 }}
                      onClick={(e) => {
                        if (!videoRef.current || isDraggingPlayhead) return;
                        const container = e.currentTarget;
                        const rect = container.getBoundingClientRect();
                        const clickPx = Math.max(0, Math.min(totalPx, (e.clientX - rect.left) + container.scrollLeft));
                        const clickTime = pxToTime(clickPx);
                        void jumpToTimelineTime(clickTime, session!, false, true);
                      }}
                      onDragOver={handleTimelineDragOver}
                      onDrop={handleTimelineDrop}
                    >
                      {/* Inner container — pixel-based so it grows and scrolls, paddingBottom prevents scrollbar overlap */}
        
                      <div style={{ width: `${scrollableTimelinePx}px`, minWidth: '100%', position: 'relative', paddingBottom: '24px', paddingTop: '4px' }}>

                      {/* Timeline Ruler (Timestamps) */}
                      <div className="timeline-ruler" style={{ position: 'sticky', top: 0, zIndex: 30, backgroundColor: '#17191f', width: `${totalPx}px`, maxWidth: '100%', height: '18px', borderBottom: '1px solid #333' }}>
                        {[...Array(11)].map((_, i) => {
                          const pct = i * 10;
                          const timeAtMark = (totalDur * pct) / 100;
                          const leftPx = timeToPx(timeAtMark);
                          const transform = i === 0 ? 'translateX(0)' : i === 10 ? 'translateX(-100%)' : 'translateX(-50%)';
                          const align = i === 0 ? 'flex-start' : i === 10 ? 'flex-end' : 'center';
                          return (
                            <div key={`ruler-${i}`} style={{ position: 'absolute', left: `${leftPx}px`, transform, fontSize: '0.65rem', color: '#888', display: 'flex', flexDirection: 'column', alignItems: align }}>
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
                        style={{ position: 'sticky', top: '18px', zIndex: 25, height: '44px', backgroundColor: '#17191f', borderRadius: '6px', border: '1px solid #2a2a3e', overflow: 'hidden', marginTop: '4px', display: 'flex', width: `${totalPx}px`, maxWidth: '100%', boxShadow: '0 4px 10px rgba(0,0,0,0.5)' }}
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
                              const clipPx = Math.max(TIMELINE_MIN_CLIP_PX, (segment.duration || 0) * TIMELINE_MIN_PX_PER_SEC);
                              
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
                            backgroundColor: segment.color || getClipColor(segment.order),
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
                                  {selectedSegmentId === segment.id && segment.assetKind !== 'photo' && (
                                    <div style={{
                                      position: 'absolute',
                                      top: '50%',
                                      left: '100%',
                                      transform: 'translateY(-50%)',
                                      marginLeft: '8px',
                                      backgroundColor: '#1a1a2e',
                                      border: '1px solid #4a9eff',
                                      borderRadius: '4px',
                                      padding: '4px 8px',
                                      zIndex: 50,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '6px',
                                      boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                                      width: 'max-content'
                                    }} onWheel={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} draggable={true} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4a9eff" strokeWidth="2">
                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                                      </svg>
                                      <input
                                        type="range"
                                        min="0"
                                        max="100"
                                        step="1"
                                        value={Math.round((segment.volume ?? 1) * 100)}
                                        onChange={(e) => handleVolumeChange(segment.id, parseInt(e.target.value) / 100)}
                                        style={{ width: '60px', height: '4px', cursor: 'pointer', accentColor: '#4a9eff' }}
                                      />
                                      <span style={{ fontSize: '10px', color: '#fff', fontVariantNumeric: 'tabular-nums' }}>{Math.round((segment.volume ?? 1) * 100)}%</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })
                        )}
                      </div>

                      {/* Single scrollable audio track */}
                      {(() => {
                        const audioSegs = (session.timeline || []).filter(s => s.assetKind === 'audio').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                        const audioRowHeight = 40;
                        const audioGap = 22;
                        const audioTrackHeight = Math.max(72, 44 + (audioSegs.length * (audioRowHeight + audioGap)));

                        return (
                          <div className="audio-tracks-scroll" style={{ width: `${totalPx}px` }}>
                            <div
                              className="timeline-track audio-track"
                              data-track={1}
                              style={{ position: 'relative', background: 'rgba(255,255,255,0.035)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.08)', minHeight: `${audioTrackHeight}px`, overflow: 'visible', marginTop: '4px', marginBottom: '8px', width: `${totalPx}px`, transition: 'height 0.2s ease' }}
                              onDragOver={handleTrackDragOver}
                              onDrop={(e) => handleTrackDrop(1, e)}
                            >
                              <div style={{ position: 'sticky', left: '0px', top: '4px', width: 'fit-content', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: '10px', height: '32px', color: 'rgba(26,188,156,0.34)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.5px', gap: '6px', pointerEvents: 'none', zIndex: 1 }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                                AUDIO
                              </div>

                              {audioSegs.map((segment, audioIndex) => {
                              const leftPx = ((segment.timelineStart ?? 0) / Math.max(totalDur, 1)) * totalPx;
                              const widthPx = Math.max(4, (Math.max((segment.duration || 0), 0) / Math.max(totalDur, 1)) * totalPx);
                              const topPx = 36 + (audioIndex * (audioRowHeight + audioGap));

                              const vol = segment.volume ?? 1;
                              const isActive = currentTime >= (segment.timelineStart ?? 0) && currentTime < (segment.timelineStart ?? 0) + (segment.duration || 0);
                              const bgColor = '#1abc9c';
                              return (
                                <div
                                  key={segment.id}
                                  className={`timeline-segment${selectedSegmentId === segment.id ? ' selected' : ''}${draggedSegmentId === segment.id ? ' dragging' : ''}`}
                                  title={`${segment.name || 'Audio'}`}
                                  style={{
                                    position: 'absolute', top: `${topPx}px`, height: `${audioRowHeight}px`,
                                    left: `${leftPx}px`, width: `${widthPx}px`,
                                    backgroundColor: bgColor,
                                    boxSizing: 'border-box',
                                    border: selectedSegmentId === segment.id ? '2px solid #fff' : '1px solid rgba(255,255,255,0.22)',
                                    cursor: resizingSegmentId === segment.id ? 'ew-resize' : 'grab',
                                    borderRadius: '4px', display: 'flex', alignItems: 'center', overflow: selectedSegmentId === segment.id ? 'visible' : 'hidden',
                                    zIndex: selectedSegmentId === segment.id ? 10 : isActive ? 5 : 1,
                                    opacity: isActive ? 1 : 0.85,
                                    boxShadow: selectedSegmentId === segment.id ? '0 4px 10px rgba(0,0,0,0.25)' : 'none',
                                    transition: 'all 0.2s ease',
                                  }}
                                  onClick={(e) => handleSegmentClick(segment.id, e)}
                                  draggable={resizingSegmentId !== segment.id}
                                  onDragStart={(e) => handleSegmentDragStart(segment.id, e)}
                                  onDragEnd={handleSegmentDragEnd}
                                  onWheel={(e) => {
                                    if (e.ctrlKey || e.metaKey) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const delta = e.deltaY < 0 ? 0.1 : -0.1;
                                      const currentFreq = segment.frequency ?? 1;
                                      const newFreq = Math.min(2.0, Math.max(0.5, currentFreq + delta));
                                      handleFrequencyChange(segment.id, Math.round(newFreq * 10) / 10);
                                    } else if (e.altKey) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const delta = e.deltaY < 0 ? 0.1 : -0.1;
                                      const newVol = Math.min(5, Math.max(0, vol + delta));
                                      handleVolumeChange(segment.id, Math.round(newVol * 10) / 10);
                                    }
                                    // If no modifier is pressed, let the event bubble up so the timeline scrolls naturally
                                  }}
                                >
                                  {selectedSegmentId === segment.id && (
                                    <div style={{
                                      position: 'absolute',
                                      top: '50%',
                                      left: '100%',
                                      transform: 'translateY(-50%)',
                                      marginLeft: '8px',
                                      backgroundColor: '#1a1a2e',
                                      border: '1px solid #1abc9c',
                                      borderRadius: '4px',
                                      padding: '6px 10px',
                                      zIndex: 50,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '10px',
                                      boxShadow: '0 4px 8px rgba(0,0,0,0.4)',
                                      width: 'max-content',
                                    }} onWheel={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} draggable={true} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                                      <div style={{ fontSize: '0.65rem', color: '#aaa', whiteSpace: 'nowrap' }}>
                                        {formatTime(segment.timelineStart ?? 0)} - {formatTime((segment.timelineStart ?? 0) + (segment.duration || 0))} ({(segment.duration || 0).toFixed(1)}s)
                                      </div>
                                      <div style={{ width: '1px', height: '14px', backgroundColor: '#333' }} />
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" strokeWidth="2">
                                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                                        </svg>
                                        <input
                                          type="range"
                                          min="0"
                                          max="100"
                                          step="1"
                                          value={Math.round(vol * 100)}
                                          onChange={(e) => handleVolumeChange(segment.id, parseInt(e.target.value) / 100)}
                                          style={{ width: '60px', height: '3px', cursor: 'pointer', accentColor: '#1abc9c' }}
                                        />
                                        <span style={{ fontSize: '0.65rem', color: '#fff', fontVariantNumeric: 'tabular-nums', minWidth: '3ch' }}>{Math.round(vol * 100)}%</span>
                                      </div>
                                    </div>
                                  )}
                                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '10px', cursor: 'ew-resize', zIndex: 12, background: 'linear-gradient(90deg, rgba(0,0,0,0.5) 0%, transparent 100%)' }} onMouseDown={(e) => handleResizeMouseDown(e, segment.id, 'left')} />
                                  <span style={{ fontSize: '0.6rem', color: '#fff', padding: '0 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 2px rgba(0,0,0,0.8)', zIndex: 1, textAlign: 'center', fontWeight: '500', pointerEvents: 'none' }}>
                                    {segment.name || 'Audio'}
                                  </span>
                                  <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '10px', cursor: 'ew-resize', zIndex: 12, background: 'linear-gradient(270deg, rgba(0,0,0,0.5) 0%, transparent 100%)' }} onMouseDown={(e) => handleResizeMouseDown(e, segment.id, 'right')} />
                                </div>
                              );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Playhead — inside pixel container, aligned with clips */}
                      <div
                        className={`timeline-playhead ${isDraggingPlayhead ? 'dragging' : ''}`}
                        style={{
                          position: 'absolute',
                          left: `${timeToPx(currentTime)}px`,
                          top: 0,
                          bottom: 0,
                          zIndex: 35,
                          pointerEvents: 'auto',
                          transition: 'none',
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
        
        <div className="sidebar-content" style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
          {activeTab === 'clips' && (
            <div className="clips-tab">

              <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff' }}>Timeline Clips</h3>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '4px 8px', fontSize: '0.8rem', display: 'flex', gap: '4px', alignItems: 'center' }}
                  onClick={() => {
                    insertAfterClipIdRef.current = null;
                    fileInputRef.current?.click();
                  }}
                  disabled={isUploadingAsset}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  {isUploadingAsset ? 'Uploading...' : 'Upload Media'}
                </button>
              </div>
              {/* Hidden file input for per-clip local insert */}
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept="video/*,image/*,audio/*"
                onChange={handleLocalFileInsert}
              />
              {session.timeline.length === 0 ? (
                <div style={{ color: '#666', textAlign: 'center', padding: '2rem 1rem' }}>
                  No items yet. Click "Upload Media" or add from Assets tab.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '60vh', overflowY: 'auto', paddingRight: '4px' }}>
                  {session.timeline
                    .filter(clip => clip.track === 0)
                    .sort((a, b) => {
                      if (a.track !== b.track) return a.track - b.track;
                      return a.order - b.order;
                    })
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
                            const r = { ...s, order: idx, timelineStart: t, color: getClipColor(idx) };
                          t += Number(s.duration);
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
                  borderLeft: `4px solid ${clip.color || getClipColor(clip.order)}`,
                          cursor: 'grab', userSelect: 'none',
                          transition: 'background 0.15s',
                          outline: selectedSegmentId === clip.id ? '1px solid #4a9eff' : 'none',
                        }}
                        onClick={() => {
                          isJumpingRef.current = true; // block rAF from overwriting currentTime
                          setSelectedSegmentId(clip.id);
                          setCurrentTime(clip.timelineStart ?? 0);
                          currentClipIndexRef.current = i;
                          void jumpToTimelineTime((clip.timelineStart ?? 0) + 0.001, session!, false, true);
                        }}
                      >
                        {/* Drag handle */}
                        <svg width="12" height="16" viewBox="0 0 12 16" fill="#555" style={{ flexShrink: 0 }}>
                          <circle cx="4" cy="3" r="1.5"/><circle cx="8" cy="3" r="1.5"/>
                          <circle cx="4" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>
                          <circle cx="4" cy="13" r="1.5"/><circle cx="8" cy="13" r="1.5"/>
                        </svg>
                        {/* Color dot */}
                <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: clip.color || getClipColor(clip.order), flexShrink: 0 }} />
                        {/* Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.82rem', lineHeight: 1.35, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                            {clip.name || `${clip.assetKind ? clip.assetKind.charAt(0).toUpperCase() + clip.assetKind.slice(1) : 'Clip'} ${clip.order + 1}`}
                          </div>
                          <div style={{ fontSize: '0.7rem', color: '#777' }}>{(clip.duration || 0).toFixed(1)}s</div>
                        </div>
                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '3px', alignItems: 'center', flexShrink: 0 }}>
                          {/* Jump */}
                          <button
                            className="btn btn-icon"
                            style={{ padding: '4px' }}
                            title="Jump to clip"
                            onClick={(e) => { e.stopPropagation(); jumpToTimelineTime(clip.timelineStart ?? 0, session!, false, true); }}
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
                          onClick={(e) => { e.stopPropagation(); handleDelete(clip.id); }}
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
            </div>
          )}
          {activeTab === 'assets' && session && (
            <AssetsTab onAddToTimeline={(asset, photoDuration) => {
              const assetName = (asset as any).name || (asset as any).tags || 'Asset';
              const assetDuration = photoDuration || ((asset as any)._kind === 'video' ? (asset as any).duration : (asset as any)._kind === 'audio' ? (asset as any).duration : 5);
              const isAudio = (asset as any)._kind === 'audio';

              // For audio: resolve preview URL from freesound previews
              // For video: use proxied small video URL
              // For photo: use proxied preview URL
              let assetUrl = '';
              if (isAudio) {
                const previews = (asset as any).previews || {};
                assetUrl = getAssetPreviewUrl(previews['preview-hq-mp3'] || previews['preview-lq-mp3'] || '', 'audio');
              } else if ((asset as any)._kind === 'video') {
                assetUrl = getAssetPreviewUrl((asset as any).videos?.small?.url || (asset as any).videos?.medium?.url || '', 'video');
              } else {
                assetUrl = getAssetPreviewUrl((asset as any).largeImageURL || (asset as any).webformatURL || (asset as any).previewURL || '', 'photo');
              }

              if (isAudio) {
                const insertAt = 0;

                const newSegment: TimelineSegment = {
                  id: `asset-${Date.now()}`,
                  name: assetName,
                  assetUrl,
                  assetKind: 'audio',
                  duration: assetDuration,
                  timelineStart: insertAt,
                  sourceStart: 0,
                  sourceEnd: assetDuration,
                  order: session.timeline.filter(s => s.assetKind === 'audio').length,
                  track: 1,
                  color: getAssetColor('audio'),
                  volume: 1,
                  originalDuration: assetDuration,
                };

                // Phase 4.14: Capture FULL session snapshot BEFORE mutation
                const previousSnapshot = saveFullSessionSnapshot(session);

                const updatedSession: SessionData = {
                  ...session,
                  timeline: [...session.timeline, newSegment],
                  undoStack: [
                    ...session.undoStack,
                    {
                      type: 'FULL_SNAPSHOT' as const,
                      previousSnapshot,
                      actionType: 'ADD_ASSET' as const,
                    },
                  ],
                  redoStack: [],
                };

                setSession(updatedSession);
                void sessionManager.saveSession(sessionId, updatedSession);

                setTimeout(() => {
                  scrollTimelineToTime(newSegment.timelineStart ?? 0, updatedSession.timeline, true);
                }, 100);

                return;
              }


              const newSegment: TimelineSegment = {
                id: `asset-${Date.now()}`,
                name: assetName,
                assetUrl,
                assetKind: (asset as any)._kind as 'video' | 'photo',
                duration: assetDuration,
                timelineStart: 0,
                sourceStart: 0,
                sourceEnd: assetDuration,
                order: 0,
                track: 0,
        color: getClipColor(0),
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
                  const end = start + Number(seg.duration || 0);
                  if (currentTime > start + 0.05 && currentTime < end - 0.05) {
                    const cutOffset = currentTime - start;
                    const sourceCutTime = (seg.sourceStart ?? 0) + cutOffset;
                    const segBase = { ...seg };
                    delete (segBase as { segments?: unknown }).segments;
                    const segment1: TimelineSegment = { ...segBase, id: `${seg.id}-1`, sourceEnd: sourceCutTime, duration: cutOffset };
                    const segment2: TimelineSegment = { ...segBase, id: `${seg.id}-2`, sourceStart: sourceCutTime, duration: Number(seg.duration || 0) - cutOffset };
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
                const s = { ...seg, order: idx, timelineStart: cumulativeTime, color: getClipColor(idx) };
                cumulativeTime += Number(seg.duration || 0);
                return s;
              });

              const otherTracks = session.timeline.filter(s => s.track !== 0);
              // Phase 4.14: Capture FULL session snapshot BEFORE mutation
              const previousSnapshot = saveFullSessionSnapshot(session);

              const updatedSessionData: SessionData = {
                ...session,
                timeline: [...adjustedTrack0, ...otherTracks],
                undoStack: [...session.undoStack, { 
                  type: 'FULL_SNAPSHOT' as const,
                  previousSnapshot,
                  actionType: 'ADD_ASSET' as const
                }],
                redoStack: [],
              };
              
              setSession(updatedSessionData);
              void sessionManager.saveSession(sessionId, updatedSessionData);

              // Scroll timeline to show the newly added clip
              setTimeout(() => {
                scrollTimelineToSegment(newSegment.id, adjustedTrack0);
              }, 100);
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
                        onClick={() => jumpToTranscriptSourceTime(seg.start)}
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
                <div ref={chatScrollRef} style={{ maxHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.4rem', scrollBehavior: 'smooth' }}>
                  {chatHistory.map((msg, i) => (
                    <div key={i} style={{ padding: '0.45rem 0.7rem', borderRadius: '6px', background: msg.role === 'user' ? '#2a2a3e' : '#1a1a2e', color: '#fff', fontSize: '0.82rem', alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '90%' }}>
                      {msg.content}
                    </div>
                  ))}
                  {isAiEditing && <div style={{ color: '#aaa', fontSize: '0.8rem', fontStyle: 'italic' }}>Thinking...</div>}
                  <div ref={chatEndRef} style={{ height: 1, flexShrink: 0 }} />
                </div>
                <form onSubmit={handleAiEditSubmit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (!isAiEditing && aiPrompt.trim() && session?.transcript) {
                          handleAiEditSubmit();
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

      {/* Export Clips Selection Modal */}
      {showExportClipsModal && session && (
        <div className="dialog-overlay" onClick={() => setShowExportClipsModal(false)}>
          <div className="dialog" style={{ width: '400px', maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Select Clips to Export</h2>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem' }}>
              <button 
                className="btn btn-secondary" 
                style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                onClick={() => setExportSelectedClipIds(session.timeline.filter(s => s.track === 0).map(s => s.id))}
              >
                Select All
              </button>
              <button 
                className="btn btn-secondary" 
                style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                onClick={() => setExportSelectedClipIds([])}
              >
                Deselect All
              </button>
            </div>
            
            <div style={{ maxHeight: '300px', overflowY: 'auto', background: '#1a1a2e', border: '1px solid #2a2a3e', borderRadius: '6px', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {session.timeline
                .filter(clip => clip.track === 0)
                .sort((a, b) => a.order - b.order)
                .map((clip) => (
                  <label key={clip.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', padding: '0.25rem' }}>
                    <input 
                      type="checkbox" 
                      checked={exportSelectedClipIds.includes(clip.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setExportSelectedClipIds(prev => [...prev, clip.id]);
                        } else {
                          setExportSelectedClipIds(prev => prev.filter(id => id !== clip.id));
                        }
                      }}
                      style={{ accentColor: '#4a9eff', width: '16px', height: '16px', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#fff' }}>
                      {clip.name || `Clip ${clip.order + 1}`}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#888', fontVariantNumeric: 'tabular-nums' }}>
                      {(clip.duration || 0).toFixed(1)}s
                    </div>
                  </label>
                ))}
            </div>

            <div className="dialog-actions" style={{ marginTop: '1.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setShowExportClipsModal(false)}>
                Cancel
              </button>
              <button 
                className="btn btn-primary" 
                onClick={() => {
                  setShowExportClipsModal(false);
                  handleExportConfirm('clips', exportSelectedClipIds);
                }}
                disabled={exportSelectedClipIds.length === 0}
              >
                Export Selected ({exportSelectedClipIds.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
