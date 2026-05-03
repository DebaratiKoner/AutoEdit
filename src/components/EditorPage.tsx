  /**
 * Editor Page Component
 * Main editing interface with video player, timeline, and controls
 */

import React, { useState, useEffect, useRef } from 'react';
import { SessionManager, CompositionBuilder } from '../services';
import { formatTime, logger } from '../utils';
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
  const [aiPrompt, setAiPrompt] = useState('');
  const [chatHistory, setChatHistory] = useState<Array<{role: 'user' | 'assistant', content: string}>>([]);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const currentClipIndexRef = useRef<number>(0);
  const isJumpingRef = useRef<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const assetVideoRef = useRef<HTMLVideoElement>(null);  // dedicated element for asset clips
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
  const lastFrameTimeRef = useRef<number>(performance.now());
  const snapshotImgRef = useRef<HTMLImageElement>(null);

  const takeTransitionSnapshot = () => {
    if (!snapshotImgRef.current || !videoRef.current) return;
    const video = videoRef.current;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1920;
      canvas.height = video.videoHeight || 1080;
      const ctx = canvas.getContext('2d');
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        snapshotImgRef.current.src = canvas.toDataURL('image/jpeg');
        snapshotImgRef.current.style.opacity = '1';
      }
    } catch(e) {
      // Ignore cross-origin errors
    }
  };

  const clearTransitionSnapshot = () => {
    if (!snapshotImgRef.current) return;
    snapshotImgRef.current.style.opacity = '0';
    // Let transition finish before clearing src to avoid flash
    setTimeout(() => {
      if (snapshotImgRef.current && snapshotImgRef.current.style.opacity === '0') {
        snapshotImgRef.current.src = '';
      }
    }, 200);
  };

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
      const assetDuration = data.assetType === 'video' ? (data.duration || 5) : 5;
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
          track: 1, color: getAssetColor('audio'), volume: 1,
        };
        setSession({ ...session, timeline: [...session.timeline, newSeg],
          undoStack: [...session.undoStack, { type: 'ADD_ASSET' as const, previousTimeline: session.timeline, asset: newSeg }],
          redoStack: [] });
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
        const i = track0Segs.findIndex(s => s.id === insertAfterClipIdRef.current);
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
      const adjusted = newTrack0.map((s, i) => { const r = { ...s, order: i, timelineStart: t }; t += s.duration; return r; });
      const others = session.timeline.filter(s => s.track !== 0);
      setSession({ ...session, timeline: [...adjusted, ...others],
        undoStack: [...session.undoStack, { type: 'ADD_ASSET' as const, previousTimeline: session.timeline, asset: newSeg }],
        redoStack: [] });
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
    setIsAiEditing(true);
    const currentPrompt = aiPrompt;
    setAiPrompt('');
    setChatHistory(prev => [...prev, { role: 'user', content: currentPrompt }]);

    try {
      const response = await fetch(`/api/videos/${sessionId}/edit-with-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: currentPrompt,
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
        const srcStart = clip.sourceStart ?? origSeg?.sourceStart ?? 0;
        const srcEnd   = clip.sourceEnd   ?? origSeg?.sourceEnd   ?? 0;
        // Duration from source times (always reliable); fall back to backend duration field
        const duration = clip.duration ?? (srcEnd - srcStart);
        return {
          id: clip.id || origSeg?.id || `ai-clip-${i}`,
          sourceStart: srcStart,
          sourceEnd:   srcEnd,
          timelineStart: clip.timelineStart ?? 0,
          duration,
          order: i,
          track: 0,
          color: assetUrl ? getAssetColor(assetKind || 'video') : getClipColor(i),
          name: clip.name || clip.title || `Clip ${i + 1}`,
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
      
      const updatedSession = {
         ...session,
         timeline: newTimeline,
         undoStack: [...session.undoStack, { 
           type: 'AI_EDIT' as const, 
           previousTimeline: session.timeline, 
           previousTranscript: session.transcript, 
           previousTranscriptSegments: session.transcriptSegments 
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

  const sessionManager = new SessionManager();

  const getShortName = (name: string | undefined | null, fallback: string) => {
    if (!name || typeof name !== 'string') return fallback;
    const trimmed = name.trim();
    if (/^clip\s+\d+$/i.test(trimmed)) return trimmed;
    const firstWord = trimmed.split(/[\s_-]+/)[0];
    return firstWord || fallback;
  };

  const getAssetPreviewUrl = (url?: string | null) => {
    if (!url || typeof url !== 'string') return '';
    return url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('/api/') ? url : `/api/proxy-image?url=${encodeURIComponent(url)}`;
  };

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

  useEffect(() => {
    // ── Single-video playback engine ──────────────────────────────────────────
    // Uses ONE <video> element. When an asset clip is active, we swap its src.
    // When done, we swap back to the original video src.
    if (!session || !videoRef.current) return;

    const video = videoRef.current;
    const sortedClips = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order);
    const EPS = 0.03; // Tighter tolerance for precise playback transitions

    let rafId = 0;
    let rafRunning = false;

    const clearPhotoTimer = () => {
      if (photoTimerRef.current) { clearTimeout(photoTimerRef.current); photoTimerRef.current = null; }
    };

    // ── Load a clip into the video element ────────────────────────────────────
    const loadClip = async (clip: typeof sortedClips[0], shouldPlay: boolean) => {
      isSwitchingRef.current = true;
      clearPhotoTimer();

      // ── PHOTO: show as overlay, keep original video paused ──────────────────
      if (clip.assetKind === 'photo' && clip.assetUrl) {
        // Pause original video but keep its position
        systemActionRef.current = true;
        video.pause();
        setPhotoOverlay({ url: getAssetPreviewUrl(clip.assetUrl), name: clip.name ?? 'Photo' });
        setActiveAssetClip(clip);
        setAssetVideoOpacity(0);
        isSwitchingRef.current = false;
        photoElapsedRef.current = 0;
        if (shouldPlay) {
          setIsPlaying(true);
          isPlayingRef.current = true;
          photoTimerRef.current = setTimeout(() => {
            advanceToNextClip(true);
          }, clip.duration * 1000);
        }
        return;
      }

      // ── ASSET VIDEO: play in the overlay video element ──────────────────────
      if (clip.assetUrl && clip.assetKind === 'video') {
        const av = assetVideoRef.current;
        if (!av) { isSwitchingRef.current = false; return; }

        // Pause original video, keep its position
        systemActionRef.current = true;
        video.pause();
        setPhotoOverlay(null);
        setActiveAssetClip(clip);

        // Pre-seek the original video to the NEXT clip's start position
        // so when we return to it after the asset, there's no seek delay
        const nextIdx = currentClipIndexRef.current + 1;
        if (nextIdx < sortedClips.length) {
          const nextClip = sortedClips[nextIdx];
          if (!nextClip.assetUrl) {
            try { video.currentTime = nextClip.sourceStart ?? 0; } catch(e) {}
          }
        }

        // Load asset into the overlay video
        if (assetSrcRef.current !== clip.assetUrl) {
          av.src = clip.assetUrl;
          assetSrcRef.current = clip.assetUrl;
          av.load();
          await new Promise<void>(resolve => {
            const onMeta = () => { av.removeEventListener('loadedmetadata', onMeta); resolve(); };
            av.addEventListener('loadedmetadata', onMeta);
            setTimeout(() => { av.removeEventListener('loadedmetadata', onMeta); resolve(); }, 3000);
          });
        }
        av.currentTime = 0;

        // Wait for canplay then fade in
        await new Promise<void>(resolve => {
          const onReady = () => { av.removeEventListener('canplay', onReady); resolve(); };
          av.addEventListener('canplay', onReady);
          setTimeout(() => { av.removeEventListener('canplay', onReady); resolve(); }, 2000);
        });

        setAssetVideoOpacity(1);  // fade in asset video
        isSwitchingRef.current = false;
        lastFrameTimeRef.current = performance.now();

        if (shouldPlay) {
          av.play().catch(() => {});
          setIsPlaying(true);
          isPlayingRef.current = true;
          // Ensure rAF loop is running to track asset video time
          if (!rafRunning) {
            rafRunning = true;
            rafId = requestAnimationFrame(rafLoop);
          }
        }
        return;
      }

      // ── ORIGINAL VIDEO CLIP ─────────────────────────────────────────────────
      const targetTime = clip.sourceStart ?? 0;

      // Fade out asset video overlay
      setAssetVideoOpacity(0);
      setPhotoOverlay(null);
      setActiveAssetClip(null);

      // Stop asset video
      const av = assetVideoRef.current;
      if (av && !av.paused) {
        av.pause();
      }

      // Seek original video to the correct position (may already be pre-seeked)
      if (Math.abs(video.currentTime - targetTime) > 0.15) {
        takeTransitionSnapshot();
        try {
          video.currentTime = targetTime;
          await new Promise<void>(resolve => {
            const onSeeked = () => { video.removeEventListener('seeked', onSeeked); clearTransitionSnapshot(); resolve(); };
            video.addEventListener('seeked', onSeeked);
            setTimeout(() => { video.removeEventListener('seeked', onSeeked); clearTransitionSnapshot(); resolve(); }, 800);
          });
        } catch(e) { clearTransitionSnapshot(); }
      }

      isSwitchingRef.current = false;
      lastFrameTimeRef.current = performance.now();

      if (shouldPlay) {
        systemActionRef.current = true;
        video.play().catch(() => {});
        setIsPlaying(true);
        isPlayingRef.current = true;
      }
    };

    const advanceToNextClip = (shouldPlay: boolean) => {
      const next = currentClipIndexRef.current + 1;
      if (next < sortedClips.length) {
        currentClipIndexRef.current = next;
        loadClip(sortedClips[next], shouldPlay);
      } else {
        // End of timeline — reset to start
        currentClipIndexRef.current = 0;
        systemActionRef.current = true;
        video.pause();
        clearPhotoTimer();
        setPhotoOverlay(null);
        setActiveAssetClip(null);
        setAssetVideoOpacity(0);
        setIsPlaying(false);
        isPlayingRef.current = false;
        // Stop asset video
        const av = assetVideoRef.current;
        if (av && !av.paused) av.pause();
        // Seek original video back to first clip start
        const firstClip = sortedClips[0];
        if (firstClip && !firstClip.assetUrl) {
          video.currentTime = firstClip.sourceStart ?? 0;
        }
        setCurrentTime(sortedClips[0].timelineStart ?? 0);
      }
    };

    // ── rAF enforce loop ──────────────────────────────────────────────────────
    const enforce = () => {
      if (isSwitchingRef.current) {
        lastFrameTimeRef.current = performance.now();
        return;
      }
      if (sortedClips.length === 0) return;

      const idx = currentClipIndexRef.current;
      const clip = sortedClips[idx];
      if (!clip) return;

      lastFrameTimeRef.current = performance.now();

      // Photo clips are handled by timer — skip
      if (clip.assetKind === 'photo') return;

      // Asset video clip — track time from the asset video element
      if (clip.assetKind === 'video' && clip.assetUrl) {
        const av = assetVideoRef.current;
        if (!av || av.paused || isJumpingRef.current) return;
        const t = av.currentTime;
        setCurrentTime((clip.timelineStart ?? 0) + Math.max(0, t));
        if (t >= clip.duration - EPS) {
          advanceToNextClip(true);
        }
        return;
      }

      // Original video clip
      if (video.paused || isJumpingRef.current) return;
      const t = video.currentTime;
      const clipSourceStart = clip.sourceStart ?? 0;
      setCurrentTime((clip.timelineStart ?? 0) + Math.max(0, t - clipSourceStart));

      const clipEnd = clip.sourceEnd ?? 0;
      if (t >= clipEnd - EPS) {
        advanceToNextClip(true);
      }
    };

    const rafLoop = () => {
      enforce();
      if (rafRunning) rafId = requestAnimationFrame(rafLoop);
    };

    const handlePlayEvent = () => {
      if (systemActionRef.current) {
        systemActionRef.current = false;
        return;
      }
      setIsPlaying(true);
      isPlayingRef.current = true;
      lastFrameTimeRef.current = performance.now();

      // If current clip is an asset, load it now (user pressed play)
      const idx = currentClipIndexRef.current;
      const clip = sortedClips[idx];
      if (clip && clip.assetUrl) {
        loadClip(clip, true);
        return;
      }

      if (!rafRunning) {
        rafRunning = true;
        rafId = requestAnimationFrame(rafLoop);
      }
    };

    const handlePauseEvent = () => {
      if (systemActionRef.current) {
        systemActionRef.current = false;
        return;
      }
      // Only stop rAF if we're not in the middle of asset playback
      const idx = currentClipIndexRef.current;
      const clip = sortedClips[idx];
      const isAssetPlaying = clip?.assetUrl && assetVideoRef.current && !assetVideoRef.current.paused;
      if (!isAssetPlaying) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        rafRunning = false;
        cancelAnimationFrame(rafId);
        clearPhotoTimer();
      }
    };

    const handleEndedEvent = () => {
      advanceToNextClip(true);
    };

    // Asset video ended → advance to next clip
    const handleAssetEnded = () => {
      advanceToNextClip(true);
    };

    const av = assetVideoRef.current;

    video.addEventListener('timeupdate', enforce);
    video.addEventListener('play', handlePlayEvent);
    video.addEventListener('pause', handlePauseEvent);
    video.addEventListener('ended', handleEndedEvent);
    if (av) av.addEventListener('ended', handleAssetEnded);

    if (!video.paused || isPlayingRef.current) {
      rafRunning = true;
      rafId = requestAnimationFrame(rafLoop);
    }

    return () => {
      rafRunning = false;
      cancelAnimationFrame(rafId);
      clearPhotoTimer();
      video.removeEventListener('timeupdate', enforce);
      video.removeEventListener('play', handlePlayEvent);
      video.removeEventListener('pause', handlePauseEvent);
      video.removeEventListener('ended', handleEndedEvent);
      if (av) av.removeEventListener('ended', handleAssetEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  };

  const handlePlayheadMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDraggingPlayhead(true);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!timelineRef.current || !sessionRef.current) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const track0Segments = sessionRef.current.timeline.filter(s => s.track === 0);
    const totalDur = Math.max(
      track0Segments.reduce((sum, s) => sum + s.duration, 0),
      sessionRef.current.duration || 1
    );

    if (isDraggingPlayhead && videoRef.current) {
      const mouseX = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, mouseX / rect.width));
      const newTime = percentage * totalDur;
      
      void jumpToTimelineTime(newTime, sessionRef.current);
    }

    if (resizingSegmentId && resizeType) {
      const session = sessionRef.current;
      const deltaX = e.clientX - resizeInitialX;
      const deltaTime = (deltaX / rect.width) * totalDur;
      
      let newStart = resizeInitialStart;
      let newDuration = resizeInitialDuration;
      
      if (resizeType === 'left') {
        newStart = Math.max(0, resizeInitialStart + deltaTime);
        const effectiveDelta = newStart - resizeInitialStart;
        newDuration = Math.max(0.5, resizeInitialDuration - effectiveDelta);
        if (newDuration === 0.5) {
          newStart = resizeInitialStart + (resizeInitialDuration - 0.5);
        }
      } else {
        newDuration = Math.max(0.5, resizeInitialDuration + deltaTime);
      }
      
      const updatedTimeline = session.timeline.map(seg => 
        seg.id === resizingSegmentId 
          ? { ...seg, timelineStart: newStart, duration: newDuration, sourceEnd: (seg.sourceStart ?? 0) + newDuration } 
          : seg
      );
      
      setSession({ ...session, timeline: updatedTimeline });
    }
  };

  const handleMouseUp = () => {
    if (isDraggingPlayhead) {
      setIsDraggingPlayhead(false);
    }
    if (resizingSegmentId) {
      if (sessionRef.current) {
         const updatedSession = {
            ...sessionRef.current,
            undoStack: [...sessionRef.current.undoStack, { type: 'RESIZE' as const, previousTimeline: sessionRef.current.timeline }],
            redoStack: []
         };
         void sessionManager.saveSession(sessionId, updatedSession);
      }
      setResizingSegmentId(null);
      setResizeType(null);
    }
  };

  const jumpToTimelineTime = async (timelineTime: number, sourceSession: SessionData = session!) => {
    if (!videoRef.current || !sourceSession) return;

    const video = videoRef.current;
    const av = assetVideoRef.current;
    const sorted = [...(sourceSession.timeline || [])]
      .filter(seg => seg.track === 0)
      .sort((a, b) => a.order - b.order);
    if (sorted.length === 0) return;

    const clampedTime = Math.max(0, Math.min(timelineTime, sorted.reduce((sum, seg) => sum + seg.duration, 0)));
    const segmentIndex = sorted.findIndex(
      seg => clampedTime >= (seg.timelineStart ?? 0) && clampedTime <= (seg.timelineStart ?? 0) + seg.duration
    );
    const targetIndex = segmentIndex >= 0 ? segmentIndex : sorted.length - 1;
    const segment = sorted[targetIndex];
    const offset = Math.max(0, Math.min(segment.duration, clampedTime - (segment.timelineStart ?? 0)));

    currentClipIndexRef.current = targetIndex;
    setSelectedSegmentId(segment.id);
    setCurrentTime((segment.timelineStart ?? 0) + offset);

    if (photoTimerRef.current) { clearTimeout(photoTimerRef.current); photoTimerRef.current = null; }

    // Photo
    if (segment.assetKind === 'photo' && segment.assetUrl) {
      video.pause();
      if (av && !av.paused) av.pause();
      setAssetVideoOpacity(0);
      setPhotoOverlay({ url: getAssetPreviewUrl(segment.assetUrl), name: segment.name ?? 'Photo' });
      setActiveAssetClip(segment);
      return;
    }

    // Asset video
    if (segment.assetKind === 'video' && segment.assetUrl && av) {
      const wasPlaying = !video.paused || (av && !av.paused);
      video.pause();
      setPhotoOverlay(null);
      setActiveAssetClip(segment);
      if (assetSrcRef.current !== segment.assetUrl) {
        av.src = segment.assetUrl;
        assetSrcRef.current = segment.assetUrl;
        av.load();
        await new Promise<void>(resolve => {
          const onMeta = () => { av.removeEventListener('loadedmetadata', onMeta); resolve(); };
          av.addEventListener('loadedmetadata', onMeta);
          setTimeout(() => { av.removeEventListener('loadedmetadata', onMeta); resolve(); }, 2000);
        });
      }
      av.currentTime = offset;
      setAssetVideoOpacity(1);
      if (wasPlaying) { av.play().catch(() => {}); setIsPlaying(true); }
      return;
    }

    // Original video clip
    setPhotoOverlay(null);
    setActiveAssetClip(null);
    setAssetVideoOpacity(0);
    if (av && !av.paused) av.pause();

    const targetTime = (segment.sourceStart ?? 0) + offset;
    const wasPlaying = !video.paused;
    takeTransitionSnapshot();
    video.pause();
    try {
      video.currentTime = targetTime;
      await new Promise<void>(resolve => {
        const onSeeked = () => { video.removeEventListener('seeked', onSeeked); clearTransitionSnapshot(); resolve(); };
        video.addEventListener('seeked', onSeeked);
        setTimeout(() => { video.removeEventListener('seeked', onSeeked); clearTransitionSnapshot(); resolve(); }, 1000);
      });
    } catch(e) { clearTransitionSnapshot(); }

    if (wasPlaying) {
      try { await video.play(); setIsPlaying(true); } catch {}
    }
  };

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

  const handleCut = () => {
    if (!session) return;
    
    // Only cut track 0 (main video) segments
    const segmentToCut = session.timeline
      .filter(seg => seg.track === 0)
      .find(seg => currentTime >= (seg.timelineStart ?? 0) && currentTime < (seg.timelineStart ?? 0) + seg.duration);

    if (!segmentToCut) return;

    const cutOffset = currentTime - (segmentToCut.timelineStart ?? 0);
    const sourceCutTime = (segmentToCut.sourceStart ?? 0) + cutOffset;

    if (cutOffset <= 0 || cutOffset >= segmentToCut.duration) {
      alert('Cannot cut at segment boundaries. Please position the playhead within a segment.');
      return;
    }
    
    // Get next available color for the second segment only
    const existingColors = session.timeline.map(seg => seg.color).filter(c => c !== undefined) as string[];
    const availableColors = [
      '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6',
      '#1abc9c', '#e67e22', '#16a085', '#27ae60'
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
      sourceStart: segmentToCut.sourceStart ?? 0,
      sourceEnd: sourceCutTime,
      timelineStart: segmentToCut.timelineStart ?? 0,
      duration: cutOffset,
      order: segmentToCut.order,
      track: segmentToCut.track, // Preserve track
      color: color1, // Assign new unique color
      name: `Clip ${segmentToCut.order + 1}`, // Sequential naming: Clip 1, Clip 2, etc.
    };
    
    const segment2: TimelineSegment = {
      id: `${segmentToCut.id}-2`,
      sourceStart: sourceCutTime,
      sourceEnd: segmentToCut.sourceEnd ?? 0,
      timelineStart: (segmentToCut.timelineStart ?? 0) + segment1.duration,
      duration: segmentToCut.duration - cutOffset,
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
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleDelete = (idToDelete?: string | React.MouseEvent) => {
    if (!session) return;

    let targetId = selectedSegmentId;
    if (typeof idToDelete === 'string') {
      targetId = idToDelete;
    }

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
    
    // Remove segment and reorder with sequential naming
    const newTimeline = session.timeline
      .filter(seg => seg.id !== targetId)
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
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleUndo = () => {
    if (!session || session.undoStack.length === 0) return;

    const lastAction = session.undoStack[session.undoStack.length - 1];
    let newTimeline = [...session.timeline];
    let newTranscript = session.transcript;
    let newTranscriptSegments = session.transcriptSegments;

    // Snapshot the current (post-action) state so redo can restore it
    const postActionTimeline = [...session.timeline];
    const postActionTranscript = session.transcript;
    const postActionTranscriptSegments = session.transcriptSegments;

    if (lastAction.type === 'CUT') {
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
          track: seg1.track,
          color: seg1.color,
          name: seg1.name,
        };
        newTimeline = newTimeline
          .filter(s => s.id !== seg1.id && s.id !== seg2.id)
          .concat([merged])
          .sort((a, b) => a.order - b.order)
          .map((seg, index) => ({ ...seg, order: index }));
      }
    } else if (lastAction.type === 'DELETE') {
      newTimeline = [...newTimeline, lastAction.segment]
        .sort((a, b) => a.order - b.order)
        .map((seg, index) => ({ ...seg, order: index }));
      let t = 0;
      newTimeline = newTimeline.map(seg => { const s = { ...seg, timelineStart: t }; t += seg.duration; return s; });
    } else if (lastAction.type === 'AI_EDIT') {
      newTimeline = lastAction.previousTimeline;
      newTranscript = lastAction.previousTranscript;
      newTranscriptSegments = lastAction.previousTranscriptSegments;
    } else if (lastAction.type === 'REORDER') {
      newTimeline = lastAction.previousTimeline;
    } else if (lastAction.type === 'ADD_ASSET') {
      newTimeline = lastAction.previousTimeline;
    }

    // Store the post-action snapshot in the redo action so redo can restore it
    const redoAction = {
      ...lastAction,
      // Attach post-action state for redo to use
      _postTimeline: postActionTimeline,
      _postTranscript: postActionTranscript,
      _postTranscriptSegments: postActionTranscriptSegments,
    } as (typeof lastAction & {
      _postTimeline: TimelineSegment[];
      _postTranscript: string | null;
      _postTranscriptSegments: Array<{ start: number; end: number; text: string }> | null;
    });

    const updatedSession = {
      ...session,
      timeline: newTimeline,
      transcript: newTranscript,
      transcriptSegments: newTranscriptSegments,
      undoStack: session.undoStack.slice(0, -1),
      redoStack: [...session.redoStack, redoAction as unknown as (typeof session.redoStack)[0]],
    };

    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleRedo = () => {
    if (!session || session.redoStack.length === 0) return;

    const actionToRedo = session.redoStack[session.redoStack.length - 1] as (typeof session.redoStack)[0] & {
      _postTimeline?: TimelineSegment[];
      _postTranscript?: string | null;
      _postTranscriptSegments?: Array<{ start: number; end: number; text: string }> | null;
    };

    // Use the post-action snapshot stored by handleUndo (most reliable approach)
    const newTimeline: TimelineSegment[] = actionToRedo._postTimeline ?? session.timeline;
    const newTranscript: string | null = actionToRedo._postTranscript ?? session.transcript;
    const newTranscriptSegments = actionToRedo._postTranscriptSegments ?? session.transcriptSegments;

    const updatedSession = {
      ...session,
      timeline: newTimeline,
      transcript: newTranscript,
      transcriptSegments: newTranscriptSegments,
      undoStack: [...session.undoStack, actionToRedo],
      redoStack: session.redoStack.slice(0, -1),
    };

    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
  };

  const handleSegmentClick = (segmentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedSegmentId(segmentId);
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
      const totalDur = Math.max(track0Segments.reduce((sum, s) => sum + s.duration, 0), session.duration || 1);
      
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
    const insertAt = insertBefore ? targetIdx : targetIdx + 1;

    // Splice dragged into new position
    const reordered = [
      ...without.slice(0, insertAt),
      draggedSegment,
      ...without.slice(insertAt),
    ];

    let t = 0;
    const adjustedTrack0 = reordered.map((seg, idx) => {
      const s = { ...seg, order: idx, timelineStart: t };
      t += seg.duration;
      return s;
    });

    const otherTracks = session.timeline.filter(s => s.track !== 0);
    const updatedSession = {
      ...session,
      timeline: [...adjustedTrack0, ...otherTracks],
      undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
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
    
    const updatedSession = {
      ...session,
      timeline: newTimeline,
      undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
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
    const totalDur = Math.max(
      track0Segments.reduce((sum, s) => sum + s.duration, 0),
      session.duration || 1
    );
    
    const timePosition = percentage * totalDur;
    
    setDragOverPosition(timePosition);
  };

  const handleTimelineDrop = (e: React.DragEvent) => {
    e.preventDefault();
    
    if (!draggedSegmentId || !session || !timelineRef.current || dragOverPosition === null) return;
    
    const draggedSegment = session.timeline.find(seg => seg.id === draggedSegmentId);
    if (!draggedSegment) return;
    
    if (draggedSegment.track === 1) {
      // It's an audio segment being dropped at a specific absolute position
      const newStart = Math.max(0, dragOverPosition - dragOffset);
      const updatedTimeline = session.timeline.map(seg => {
        if (seg.id === draggedSegmentId) {
          return { ...seg, timelineStart: newStart };
        }
        return seg;
      });
      const updatedSession = {
        ...session,
        timeline: updatedTimeline,
        undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
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
    
    const updatedSession = {
      ...session,
      timeline: [...adjustedTrack0, ...otherTracks],
      undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
      redoStack: [],
    };
    
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
    
    setDraggedSegmentId(null);
    setDragOverPosition(null);
  };

  const getClipColor = (index: number) => {
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
  };

  // Generate colors for different asset types
  const getAssetColor = (assetKind: string) => {
    const assetColors = {
      photo: '#e67e22', // Orange
      video: '#9b59b6', // Purple
      audio: '#1abc9c', // Teal
    };
    return assetColors[assetKind as keyof typeof assetColors] || '#2ecc71';
  };

  const handleVolumeChange = (segmentId: string, volume: number) => {
    if (!sessionRef.current) return;
    const updatedTimeline = sessionRef.current.timeline.map(seg => 
      seg.id === segmentId ? { ...seg, volume } : seg
    );
    const updatedSession = { ...sessionRef.current, timeline: updatedTimeline };
    setSession(updatedSession);
    void sessionManager.saveSession(sessionId, updatedSession);
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
      const clip: Record<string, any> = {
        start: seg.timelineStart ?? 0,     // Timeline position (for sequencing)
        end: (seg.timelineStart ?? 0) + seg.duration,  // Timeline position (for sequencing)
        title: seg.name || `Clip ${index + 1}`,
        id: seg.id,
        assetUrl: seg.assetUrl,
        assetKind: seg.assetKind,
        volume: seg.volume ?? 1.0,
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
            <button className="btn btn-primary" onClick={handleExport}>
              Export
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
                controls
                className="video-element"
                style={{ width: '100%', height: '100%', objectFit: 'contain', flex: 1 }}
                crossOrigin="anonymous"
                preload="auto"
                onLoadedMetadata={() => {
                  const video = videoRef.current;
                  if (!video || !session.timeline.length) return;
                  // Only snap to the first clip's start on the very first load (empty src ref).
                  // During playback, loadClip handles seeking — don't interfere.
                  if (currentSrcRef.current === '') {
                    const first = [...(session.timeline || [])].filter(s => s.track === 0).sort((a, b) => a.order - b.order)[0];
                    if (first && !first.assetUrl) {
                      isJumpingRef.current = true;
                      video.currentTime = first.sourceStart ?? 0;
                      setCurrentTime(first.timelineStart ?? 0);
                      setTimeout(() => { isJumpingRef.current = false; }, 150);
                    }
                  }
                }}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                aria-label={isPlaying ? 'Video playing' : 'Video paused'}
              >
                Your browser does not support the video tag.
              </video>

              {/* Asset video overlay — fades in over the original video */}
              <video
                ref={assetVideoRef}
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: '100%', height: '100%',
                  objectFit: 'contain',
                  zIndex: 4,
                  opacity: assetVideoOpacity,
                  transition: 'opacity 0.18s ease',
                  pointerEvents: 'none',
                  backgroundColor: '#000',
                }}
                crossOrigin="anonymous"
                preload="auto"
                playsInline
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
            
            {/* Fallback legacy Photo overlay */}
            {!activeOverlayClip && photoOverlay && (
              <div className="video-photo-preview">
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

            {/* Volume Control for selected audio segment */}
            {selectedSegmentId && session.timeline.find(s => s.id === selectedSegmentId)?.assetKind === 'audio' && (
              <div className="volume-control" style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto', gap: '8px', background: '#1a1a2e', padding: '4px 12px', borderRadius: '6px', border: '1px solid #333' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
                <input 
                  type="range" 
                  min="0" 
                  max="2" 
                  step="0.05" 
                  value={session.timeline.find(s => s.id === selectedSegmentId)?.volume ?? 1} 
                  onChange={(e) => handleVolumeChange(selectedSegmentId, parseFloat(e.target.value))}
                  title="Volume"
                  style={{ width: '90px', cursor: 'pointer', accentColor: '#1abc9c' }}
                />
                <span style={{ fontSize: '0.7rem', color: '#1abc9c', minWidth: '36px', fontVariantNumeric: 'tabular-nums' }}>
                  {Math.round((session.timeline.find(s => s.id === selectedSegmentId)?.volume ?? 1) * 100)}%
                </span>
              </div>
            )}
          </div>

{/* Timeline — Clip Section */}
          <div className="timeline">
            <div className="timeline-inner">
              {/* Total timeline duration = sum of all clip durations (includes assets on track 0) */}
              {(() => {
                const track0Segments = (session.timeline || []).filter(s => s.track === 0);
                const totalDur = Math.max(
                  track0Segments.reduce((sum, s) => sum + (s.duration || 0), 0),
                  1
                );
                return (
                  <>
                    <div className="timeline-header">
                      <span className="timeline-time">{formatTime(currentTime)} / {formatTime(totalDur)}</span>
                    </div>
                    <div
                      className={`timeline-content ${isDraggingPlayhead ? 'dragging' : ''}`}
                      ref={timelineRef}
                      onClick={(e) => {
                        if (!videoRef.current || isDraggingPlayhead) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const pct = (e.clientX - rect.left) / rect.width;
                        const clickTime = pct * totalDur;
                        void jumpToTimelineTime(clickTime);
                      }}
                      onDragOver={handleTimelineDragOver}
                      onDrop={handleTimelineDrop}
                    >
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

                      {/* Single clip track (track 0) */}
                      <div
                        className="timeline-track"
                        data-track={0}
                        style={{ position: 'relative', height: '44px', background: 'rgba(10, 10, 20, 0.4)', borderRadius: '6px', border: '1px solid #2a2a3e', overflow: 'hidden', marginTop: '4px', display: 'flex' }}
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
                              const widthPercent = (Math.max(segment.duration || 0, 0) / Math.max(totalDur, 1)) * 100;
                              
                              // Use "clip 1", "clip 2" format (lowercase)
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
                                    flex: `0 0 ${widthPercent}%`,
                                    width: `${widthPercent}%`,
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

                      {/* Audio track — flush below video track, same width, no wrapper div */}
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
                          const leftPercent = ((segment.timelineStart ?? 0) / Math.max(totalDur, 1)) * 100;
                          const widthPercent = (Math.max(segment.duration || 0, 0) / Math.max(totalDur, 1)) * 100;
                          const vol = segment.volume ?? 1;
                          return (
                            <div
                              key={segment.id}
                              className={`timeline-segment${selectedSegmentId === segment.id ? ' selected' : ''}${draggedSegmentId === segment.id ? ' dragging' : ''}`}
                              title={`${getShortName(segment.name, 'Audio')} — ${Math.round(vol * 100)}% vol`}
                              style={{
                                position: 'absolute', top: 0, height: '100%',
                                left: `${leftPercent}%`, width: `${widthPercent}%`,
                                backgroundColor: '#1abc9c', boxSizing: 'border-box',
                                border: selectedSegmentId === segment.id ? '2px solid #fff' : '1px solid rgba(26,188,156,0.5)',
                                cursor: resizingSegmentId === segment.id ? 'ew-resize' : 'grab',
                                borderRadius: '3px', display: 'flex', alignItems: 'center', overflow: 'hidden',
                                zIndex: selectedSegmentId === segment.id ? 10 : 1,
                              }}
                              onClick={(e) => handleSegmentClick(segment.id, e)}
                              draggable={resizingSegmentId !== segment.id}
                              onDragStart={(e) => handleSegmentDragStart(segment.id, e)}
                              onDragEnd={handleSegmentDragEnd}
                            >
                              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '6px', cursor: 'ew-resize', zIndex: 2 }} onMouseDown={(e) => handleResizeMouseDown(e, segment.id, 'left')} />
                              <span style={{ fontSize: '0.6rem', color: '#fff', padding: '0 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, textShadow: '0 1px 2px rgba(0,0,0,0.8)', zIndex: 1 }}>
                                {getShortName(segment.name, 'Audio')}{vol !== 1 ? ` ${Math.round(vol * 100)}%` : ''}
                              </span>
                              <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '6px', cursor: 'ew-resize', zIndex: 2 }} onMouseDown={(e) => handleResizeMouseDown(e, segment.id, 'right')} />
                            </div>
                          );
                        })}
                      </div>

                      {/* Playhead */}
                      <div
                        className={`timeline-playhead ${isDraggingPlayhead ? 'dragging' : ''}`}
                        style={{ left: `${(currentTime / totalDur) * 100}%`, top: 0, height: '100%', zIndex: 10 }}
                        onMouseDown={handlePlayheadMouseDown}
                      />
                    </div>
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
                          const updatedSession = {
                            ...session,
                            timeline: [...adjusted, ...others],
                            undoStack: [...session.undoStack, { type: 'REORDER' as const, previousTimeline: session.timeline }],
                            redoStack: [],
                          };
                          setSession(updatedSession);
                          void sessionManager.saveSession(sessionId, updatedSession);
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.6rem',
                          padding: '0.6rem 0.75rem', background: '#2a2a2a', borderRadius: '8px',
                          borderLeft: `4px solid ${clip.color || getClipColor(i)}`,
                          cursor: 'grab', userSelect: 'none',
                          transition: 'background 0.15s',
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
                };
                setSession({
                  ...session,
                  timeline: [...session.timeline, newSegment],
                  undoStack: [...session.undoStack, { type: 'ADD_ASSET' as const, previousTimeline: session.timeline, asset: newSegment }],
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
                  
                  newTrack0 = [
                    ...track0Segments.slice(0, i),
                    segment1,
                    newSegment,
                    segment2,
                    ...track0Segments.slice(i + 1),
                  ];
                  cutMade = true;
                  break;
                }
              }

              if (!cutMade) {
                let insertIdx = track0Segments.length;
                for (let i = 0; i < track0Segments.length; i++) {
                  if (currentTime <= (track0Segments[i].timelineStart ?? 0) + 0.05) {
                    insertIdx = i;
                    break;
                  }
                }
                newTrack0 = [
                  ...track0Segments.slice(0, insertIdx),
                  newSegment,
                  ...track0Segments.slice(insertIdx),
                ];
              }

              // Recalculate timelineStart
              let cumulativeTime = 0;
              const adjustedTrack0 = newTrack0.map((seg, idx) => {
                const s = { ...seg, order: idx, timelineStart: cumulativeTime };
                cumulativeTime += seg.duration;
                return s;
              });

              const otherTracks = session.timeline.filter(s => s.track !== 0);
              setSession({
                ...session,
                timeline: [...adjustedTrack0, ...otherTracks],
                undoStack: [...session.undoStack, { type: 'ADD_ASSET' as const, previousTimeline: session.timeline, asset: newSegment }],
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
                <form onSubmit={handleAiEditSubmit} style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="text"
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Type message..."
                    disabled={isAiEditing || !session?.transcript}
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid #333', background: '#1a1a2e', color: '#fff', fontSize: '0.82rem' }}
                  />
                  <button type="submit" className="btn btn-primary" disabled={isAiEditing || !aiPrompt.trim() || !session?.transcript} style={{ fontSize: '0.82rem' }}>
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
