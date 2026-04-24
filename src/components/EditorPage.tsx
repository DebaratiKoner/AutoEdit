/**
 * Editor Page Component
 * Main editing interface with video player, timeline, and controls
 *
 * Playback engine design:
 * - A single <video> element is NEVER remounted (no key= on it).
 * - `timelinePos` is the master clock: total seconds elapsed across all segments.
 * - On every animationFrame tick the engine finds which segment owns that position,
 *   switches the video src imperatively (only when it actually changes), seeks to
 *   the right offset inside that segment, and keeps playing.
 * - React state is only used for UI rendering, never to drive src/currentTime.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { SessionManager, APIClient } from '../services';
import { formatTime } from '../utils';
import type { SessionData, TimelineSegment } from '../types';
import './EditorPage.css';

const PIXABAY_PROXY = 'http://localhost:8000/api/pixabay';

// ─── Types ────────────────────────────────────────────────────────────────────

type AssetFilter = 'all' | 'video' | 'photo' | 'audio' | 'ai-generate';

interface PixabayVideo {
  id: number; pageURL: string; type: string; tags: string; duration: number; picture_id: string;
  videos: {
    large: { url: string; width: number; height: number; size: number; thumbnail: string };
    medium: { url: string; width: number; height: number; size: number; thumbnail: string };
    small: { url: string; width: number; height: number; size: number; thumbnail: string };
    tiny: { url: string; width: number; height: number; size: number; thumbnail: string };
  };
  views: number; downloads: number; likes: number; user: string; userImageURL: string;
}

interface PixabayPhoto {
  id: number; pageURL: string; type: string; tags: string;
  previewURL: string; previewWidth: number; previewHeight: number;
  webformatURL: string; webformatWidth: number; webformatHeight: number;
  largeImageURL: string; imageWidth: number; imageHeight: number; imageSize: number;
  views: number; downloads: number; likes: number; user: string; userImageURL: string;
}

type PixabayAsset = (PixabayVideo & { _kind: 'video' }) | (PixabayPhoto & { _kind: 'photo' });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getVideoThumbnail(asset: PixabayVideo & { _kind: 'video' }): string {
  return (
    asset.videos.medium?.thumbnail ||
    asset.videos.small?.thumbnail ||
    asset.videos.tiny?.thumbnail ||
    `https://i.vimeocdn.com/video/${asset.picture_id}_295x166.jpg`
  );
}

/** Return total timeline duration (sum of all segment durations). */
function totalDuration(timeline: TimelineSegment[]): number {
  return timeline.reduce((s, seg) => s + seg.duration, 0);
}

/**
 * Given a timeline position (seconds from start of the whole sequence),
 * find which segment is active and how far into that segment we are.
 */
function resolveSegment(
  timeline: TimelineSegment[],
  pos: number,
): { segment: TimelineSegment; offsetInSegment: number } | null {
  const sorted = [...timeline].sort((a, b) => a.order - b.order);
  let elapsed = 0;
  for (const seg of sorted) {
    if (pos >= elapsed && pos < elapsed + seg.duration) {
      return { segment: seg, offsetInSegment: pos - elapsed };
    }
    elapsed += seg.duration;
  }
  return null;
}

/** Build a normalised timeline where timelineStart is always recalculated. */
function rebuildTimeline(segs: TimelineSegment[]): TimelineSegment[] {
  let t = 0;
  return segs.map((seg, i) => {
    const s = { ...seg, order: i, timelineStart: t };
    t += seg.duration;
    return s;
  });
}

// ─── AssetsTab ────────────────────────────────────────────────────────────────

interface AssetsTabProps {
  onAddToTimeline: (asset: PixabayAsset, photoDuration?: number) => void;
}

function AssetsTab({ onAddToTimeline }: AssetsTabProps) {
  const [filter, setFilter] = useState<AssetFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [assets, setAssets] = useState<PixabayAsset[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalHits, setTotalHits] = useState(0);
  const [previewAsset, setPreviewAsset] = useState<(PixabayVideo & { _kind: 'video' }) | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [addedAssetIds, setAddedAssetIds] = useState<Set<number>>(new Set());
  const [photoDurations, setPhotoDurations] = useState<Record<number, string>>({});
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const PER_PAGE = 10;

  // Topic suggestions shown after a filter is selected
  const TOPIC_SUGGESTIONS: Record<string, string[]> = {
    video:  ['nature', 'technology', 'business', 'travel', 'food', 'sports', 'music', 'city', 'animals', 'education'],
    photo:  ['nature', 'architecture', 'people', 'travel', 'food', 'fashion', 'abstract', 'animals', 'flowers', 'sky'],
    audio:  ['ambient', 'music', 'sound effects', 'nature sounds', 'background', 'cinematic'],
  };
  const topics = TOPIC_SUGGESTIONS[filter] ?? [];

  const fetchAssets = useCallback(async (
    query: string, currentFilter: AssetFilter, currentPage: number, append = false,
  ) => {
    if (!query.trim() && currentFilter === 'all') return;
    setIsLoading(true);
    setError(null);
    try {
      const q = query.trim() || currentFilter;
      let results: PixabayAsset[] = [];
      let hits = 0;

      if (currentFilter === 'video' || currentFilter === 'all') {
        const params = new URLSearchParams({
          type: 'videos', q, per_page: String(PER_PAGE),
          page: String(currentPage), safesearch: 'true',
        });
        const res = await fetch(`${PIXABAY_PROXY}?${params}`);
        if (!res.ok) { const e = await res.json().catch(() => ({ detail: `HTTP ${res.status}` })); throw new Error(e.detail); }
        const data = await res.json();
        hits = data.totalHits ?? 0;
        results = [...results, ...(data.hits ?? []).map((v: PixabayVideo) => ({ ...v, _kind: 'video' as const }))];
      }

      if (currentFilter === 'photo' || currentFilter === 'all') {
        const params = new URLSearchParams({
          type: 'images', q, per_page: String(PER_PAGE),
          page: String(currentPage), safesearch: 'true', image_type: 'photo',
        });
        const res = await fetch(`${PIXABAY_PROXY}?${params}`);
        if (!res.ok) { const e = await res.json().catch(() => ({ detail: `HTTP ${res.status}` })); throw new Error(e.detail); }
        const data = await res.json();
        if (currentFilter === 'photo') hits = data.totalHits ?? 0;
        results = [...results, ...(data.hits ?? []).map((p: PixabayPhoto) => ({ ...p, _kind: 'photo' as const }))];
      }

      setTotalHits(hits);
      setAssets(prev => append ? [...prev, ...results] : results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch assets');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (searchQuery.trim() || filter !== 'all') {
      setPage(1);
      fetchAssets(searchQuery, filter, 1, false);
    } else {
      setAssets([]);
      setTotalHits(0);
    }
  }, [searchQuery, filter, fetchAssets]);

  const handleFilterClick = (f: AssetFilter) => {
    setFilter(f);
    if (f !== 'all' && f !== 'ai-generate') {
      const label = f === 'photo' ? 'Photos' : f.charAt(0).toUpperCase() + f.slice(1);
      setInputValue(label);
      setSearchQuery(label);
    } else if (f === 'all') {
      setInputValue('');
      setSearchQuery('');
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => { e.preventDefault(); setSearchQuery(inputValue); };
  const handleLoadMore = () => { const next = page + 1; setPage(next); fetchAssets(searchQuery, filter, next, true); };
  const handleVideoClick = (asset: PixabayVideo & { _kind: 'video' }) => {
    setSelectedAssetId(asset.id); setPreviewAsset(asset); setIsPreviewPlaying(true);
  };
  const handleClosePreview = () => {
    setPreviewAsset(null); setIsPreviewPlaying(false); previewVideoRef.current?.pause();
  };
  const handlePreviewPlayPause = () => {
    if (!previewVideoRef.current) return;
    if (isPreviewPlaying) { previewVideoRef.current.pause(); } else { previewVideoRef.current.play(); }
    setIsPreviewPlaying(!isPreviewPlaying);
  };
  const handleAddToTimeline = (asset: PixabayAsset, e: React.MouseEvent) => {
    e.stopPropagation();
    const photoDuration = asset._kind === 'photo'
      ? Math.max(1, parseFloat(photoDurations[asset.id] || '5') || 5)
      : undefined;
    onAddToTimeline(asset, photoDuration);
    setAddedAssetIds(prev => new Set(prev).add(asset.id));
  };

  const filters: { key: AssetFilter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'video', label: 'Video' }, { key: 'audio', label: 'Audio' },
    { key: 'photo', label: 'Photos' }, { key: 'ai-generate', label: '+ AI Generate' },
  ];

  const FALLBACK_SVG = 'data:image/svg+xml,%3Csvg xmlns%3D"http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg" width%3D"295" height%3D"166"%3E%3Crect width%3D"295" height%3D"166" fill%3D"%231a1a2e"%2F%3E%3Cpolygon points%3D"118%2C55 177%2C83 118%2C111" fill%3D"%234a90e2"%2F%3E%3C%2Fsvg%3E';

  return (
    <div className="assets-tab">
      <div className="assets-header">
        <form className="assets-search-form" onSubmit={handleSearchSubmit}>
          <div className="assets-search-wrapper">
            <svg className="assets-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input type="text" className="assets-search-input" placeholder="Search assets..."
              value={inputValue} onChange={e => setInputValue(e.target.value)} />
            {inputValue && (
              <button type="button" className="assets-search-clear"
                onClick={() => { setInputValue(''); setSearchQuery(''); setFilter('all'); }}>✕</button>
            )}
          </div>
        </form>
        <div className="assets-filters">
          {filters.map(f => (
            <button key={f.key}
              className={`assets-filter-btn${filter === f.key ? ' active' : ''}${f.key === 'ai-generate' ? ' ai-generate' : ''}`}
              onClick={() => handleFilterClick(f.key)}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Topic suggestion chips — shown when a filter with known topics is active */}
        {topics.length > 0 && (
          <div className="assets-topics">
            {topics.map(topic => (
              <button
                key={topic}
                className={`assets-topic-chip${searchQuery === topic ? ' active' : ''}`}
                onClick={() => { setInputValue(topic); setSearchQuery(topic); }}
              >
                {topic}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="assets-results">
        {isLoading && assets.length === 0 && (
          <div className="assets-loading"><div className="assets-spinner"/><span>Fetching assets…</span></div>
        )}
        {error && (
          <div className="assets-error">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>{error}</span>
          </div>
        )}
        {!isLoading && !error && assets.length === 0 && (searchQuery || filter !== 'all') && (
          <div className="assets-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p>No results found</p><p className="assets-empty-hint">Try a different search term</p>
          </div>
        )}
        {!isLoading && !error && assets.length === 0 && !searchQuery && filter === 'all' && (
          <div className="assets-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <p>Search for assets</p>
            <p className="assets-empty-hint">Use the search bar or select a filter above</p>
          </div>
        )}

        {assets.length > 0 && (
          <div className="assets-grid">
            {assets.map(asset => (
              <div key={`${asset._kind}-${asset.id}`}
                className={`asset-card${selectedAssetId === asset.id ? ' selected' : ''}`}
                onClick={() => asset._kind === 'video'
                  ? handleVideoClick(asset as PixabayVideo & { _kind: 'video' })
                  : setSelectedAssetId(asset.id)}>
                <div className="asset-card-thumb">
                  {asset._kind === 'video' ? (
                    <>
                      <img src={getVideoThumbnail(asset as PixabayVideo & { _kind: 'video' })}
                        alt={asset.tags} loading="lazy"
                        onError={e => {
                          const img = e.target as HTMLImageElement;
                          if (!img.dataset.fb) {
                            img.dataset.fb = '1';
                            img.src = `https://i.vimeocdn.com/video/${(asset as PixabayVideo).picture_id}_295x166.jpg`;
                          } else { img.src = FALLBACK_SVG; }
                        }}/>
                      <div className="asset-card-play-overlay">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                      </div>
                      <div className="asset-card-badge video">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                        {(asset as PixabayVideo).duration}s
                      </div>
                    </>
                  ) : (
                    <>
                      <img src={(asset as PixabayPhoto).previewURL} alt={asset.tags} loading="lazy"/>
                      <div className="asset-card-badge photo">Photo</div>
                    </>
                  )}
                  {selectedAssetId === asset.id && (
                    <div className="asset-card-selected-overlay">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </div>
                  )}
                </div>
                <div className="asset-card-info">
                  <p className="asset-card-tags">{asset.tags.split(',').slice(0, 3).join(', ')}</p>
                  {asset._kind === 'photo' && (
                    <div className="asset-photo-duration">
                      <label className="asset-photo-duration-label">Duration (s):</label>
                      <input type="number" className="asset-photo-duration-input" min="1" max="60" step="1"
                        value={photoDurations[asset.id] ?? '5'}
                        onClick={e => e.stopPropagation()}
                        onChange={e => {
                          e.stopPropagation();
                          setPhotoDurations(prev => ({ ...prev, [asset.id]: e.target.value }));
                          setAddedAssetIds(prev => { const s = new Set(prev); s.delete(asset.id); return s; });
                        }}/>
                    </div>
                  )}
                  <div className="asset-card-actions">
                    {asset._kind === 'video' && (
                      <button className="asset-preview-btn"
                        onClick={e => { e.stopPropagation(); handleVideoClick(asset as PixabayVideo & { _kind: 'video' }); }}
                        title="Preview video">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                        Preview
                      </button>
                    )}
                    <button className={`asset-add-btn${addedAssetIds.has(asset.id) ? ' added' : ''}`}
                      onClick={e => handleAddToTimeline(asset, e)} title="Add to timeline">
                      {addedAssetIds.has(asset.id)
                        ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Added</>
                        : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add</>}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {assets.length > 0 && assets.length < totalHits && (
          <button className="assets-load-more" onClick={handleLoadMore} disabled={isLoading}>
            {isLoading
              ? <><div className="assets-spinner-sm"/>Loading…</>
              : `Load More (${assets.length} out of ${totalHits})`}
          </button>
        )}
      </div>

      {previewAsset && (
        <div className="asset-preview-overlay" onClick={handleClosePreview}>
          <div className="asset-preview-panel" onClick={e => e.stopPropagation()}>
            <div className="asset-preview-header">
              <span className="asset-preview-title">{previewAsset.tags.split(',')[0].trim()}</span>
              <button className="asset-preview-close" onClick={handleClosePreview}>✕</button>
            </div>
            <div className="asset-preview-video-wrap">
              <video ref={previewVideoRef}
                src={previewAsset.videos.small?.url || previewAsset.videos.tiny?.url}
                className="asset-preview-video" autoPlay loop
                onPlay={() => setIsPreviewPlaying(true)}
                onPause={() => setIsPreviewPlaying(false)}/>
            </div>
            <div className="asset-preview-controls">
              <button className="asset-preview-playpause" onClick={handlePreviewPlayPause}>
                {isPreviewPlaying
                  ? <><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause</>
                  : <><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>Play</>}
              </button>
              <button className={`asset-preview-add${addedAssetIds.has(previewAsset.id) ? ' added' : ''}`}
                onClick={e => handleAddToTimeline(previewAsset, e)}>
                {addedAssetIds.has(previewAsset.id)
                  ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>Added to Timeline</>
                  : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add to Timeline</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EditorPage ───────────────────────────────────────────────────────────────

interface EditorPageProps {
  sessionId: string;
  onReset?: () => void;
}

export function EditorPage({ sessionId, onReset }: EditorPageProps) {
  const [session, setSession] = useState<SessionData | null>(null);

  // timelinePos = master clock in "timeline seconds" (0 … totalDuration)
  const [timelinePos, setTimelinePos] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [activeTab, setActiveTab] = useState<'clips' | 'ai-edit' | 'assets'>('clips');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [seekingSegmentId, setSeekingSegmentId] = useState<string | null>(null);

  // The segment currently loaded into the <video> element
  const [displaySegId, setDisplaySegId] = useState<string | null>(null);
  // When showing a photo asset we overlay an <img> instead
  const [photoOverlay, setPhotoOverlay] = useState<{ url: string; name: string } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const sessionManager = new SessionManager();

  // Refs used inside the RAF loop (avoid stale closures)
  const sessionRef = useRef<SessionData | null>(null);
  const timelinePosRef = useRef(0);
  const isPlayingRef = useRef(false);
  const currentSrcRef = useRef<string>('');   // src currently loaded in <video>
  const isSwitchingRef = useRef(false);        // true while we're loading a new src

  // Keep refs in sync
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { timelinePosRef.current = timelinePos; }, [timelinePos]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // ── Session loading ──────────────────────────────────────────────────────────

  useEffect(() => { loadSession(); }, [sessionId]);

  const loadSession = async () => {
    const data = await sessionManager.loadSession(sessionId);
    if (data) { setSession(data); return; }
    try {
      const db = await openVideoDatabase();
      const tx = db.transaction(['videos'], 'readonly');
      const req = tx.objectStore('videos').get(sessionId);
      req.onsuccess = async () => {
        const result = req.result;
        if (result?.file) {
          const videoUrl = URL.createObjectURL(result.file);
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.onloadedmetadata = async () => {
            const s: SessionData = {
              sessionId, videoUrl, duration: v.duration,
              resolution: { width: v.videoWidth, height: v.videoHeight },
              timeline: [{ id: '1', sourceStart: 0, sourceEnd: v.duration, timelineStart: 0, duration: v.duration, order: 0 }],
              transcript: null, undoStack: [], redoStack: [], lastModified: Date.now(),
            };
            setSession(s);
            await sessionManager.saveSession(sessionId, s);
          };
          v.src = videoUrl;
        } else { loadSampleVideo(); }
      };
      req.onerror = () => loadSampleVideo();
    } catch { loadSampleVideo(); }
  };

  const loadSampleVideo = async () => {
    const s: SessionData = {
      sessionId,
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      duration: 596, resolution: { width: 1920, height: 1080 },
      timeline: [{ id: '1', sourceStart: 0, sourceEnd: 596, timelineStart: 0, duration: 596, order: 0 }],
      transcript: null, undoStack: [], redoStack: [], lastModified: Date.now(),
    };
    setSession(s);
    await sessionManager.saveSession(sessionId, s);
  };

  const openVideoDatabase = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('VideoEditorDB', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = e => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
      };
    });

  // ── Playback engine ──────────────────────────────────────────────────────────
  //
  // A single requestAnimationFrame loop runs for the entire lifetime of the
  // component. It always re-queues itself — there is no start/stop logic.
  //
  // activeSegIdRef  — ID of the segment currently playing.
  // segStartTimeRef — video.currentTime that maps to offset=0 of this segment.
  // photoModeRef    — true while a photo segment is the active segment.
  // advancingRef    — guard: true while advanceToNextSegment is in-flight,
  //                   prevents the RAF tick from firing it multiple times.

  const activeSegIdRef    = useRef<string>('');
  const segStartTimeRef   = useRef<number>(0);
  const photoModeRef      = useRef<boolean>(false);
  const photoStartWallRef = useRef<number>(0);
  const photoStartPosRef  = useRef<number>(0);
  const photoDurationRef  = useRef<number>(0);
  const rafRef            = useRef<number | null>(null);
  const advancingRef      = useRef<boolean>(false); // guard against double-advance

  const advanceToNextSegmentRef = useRef<(segId: string) => void>(() => {});

  // The RAF tick — always running, reads only refs, never stale.
  const rafTick = useCallback(() => {
    rafRef.current = requestAnimationFrame(rafTick); // always re-queue first

    const video = videoRef.current;
    const sess  = sessionRef.current;
    if (!video || !sess) return;

    const sorted = [...sess.timeline].sort((a, b) => a.order - b.order);
    const activeSeg = sorted.find(s => s.id === activeSegIdRef.current);
    if (!activeSeg) return;

    if (photoModeRef.current) {
      // ── Photo: wall-clock drives position ──────────────────────────────────
      const elapsed = (Date.now() - photoStartWallRef.current) / 1000;
      const newPos  = Math.min(
        photoStartPosRef.current + elapsed,
        activeSeg.timelineStart + activeSeg.duration,
      );
      timelinePosRef.current = newPos;
      setTimelinePos(newPos);

      if (elapsed >= photoDurationRef.current && !advancingRef.current) {
        advancingRef.current = true;
        photoModeRef.current = false;
        advanceToNextSegmentRef.current(activeSeg.id);
      }
    } else {
      // ── Video: video.currentTime drives position ───────────────────────────
      if (isSwitchingRef.current) return; // mid-switch, skip this frame

      const offsetInSeg = video.currentTime - segStartTimeRef.current;
      if (offsetInSeg < 0) return; // seeking backwards

      // Clamp so timelinePos never exceeds total duration
      const tlTotal = sorted.reduce((s, seg) => s + seg.duration, 0);
      const newPos  = Math.min(activeSeg.timelineStart + offsetInSeg, tlTotal);
      timelinePosRef.current = newPos;
      setTimelinePos(newPos);

      // Segment boundary — fire once per boundary using advancingRef guard
      if (!video.paused && offsetInSeg >= activeSeg.duration - 0.08 && !advancingRef.current) {
        advancingRef.current = true;
        advanceToNextSegmentRef.current(activeSeg.id);
      }
    }
  }, []); // zero deps — everything read from refs

  // Start the loop once on mount; it never stops until unmount.
  useEffect(() => {
    rafRef.current = requestAnimationFrame(rafTick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [rafTick]);

  /**
   * Switch the active segment. Loads a new src if needed, seeks, then plays.
   * For photos: pauses the video, shows the overlay, starts wall-clock tracking.
   */
  const switchToSegment = useCallback(async (
    seg: TimelineSegment,
    offsetInSegment: number,
    shouldPlay: boolean,
  ) => {
    const video = videoRef.current;
    if (!video) return;

    // ── Photo segment ────────────────────────────────────────────────────────
    if (seg.assetKind === 'photo' && seg.assetUrl) {
      video.pause();
      isSwitchingRef.current = false;

      activeSegIdRef.current    = seg.id;
      photoModeRef.current      = true;
      photoStartPosRef.current  = seg.timelineStart + offsetInSegment;
      photoDurationRef.current  = seg.duration - offsetInSegment;
      photoStartWallRef.current = Date.now();
      advancingRef.current      = false; // ready for next boundary

      setDisplaySegId(seg.id);
      setPhotoOverlay({ url: seg.assetUrl, name: seg.name ?? 'Photo' });

      if (shouldPlay) {
        setIsPlaying(true);
        isPlayingRef.current = true;
      }
      return;
    }

    // ── Video segment ────────────────────────────────────────────────────────
    photoModeRef.current = false;
    setPhotoOverlay(null);
    isSwitchingRef.current = true;

    const targetSrc  = seg.assetUrl ?? sessionRef.current?.videoUrl ?? '';
    const srcStart   = seg.assetUrl ? 0 : seg.sourceStart;
    const targetTime = srcStart + offsetInSegment;

    if (video.src !== targetSrc) {
      // Temporarily suppress onPause so it doesn't clear isPlayingRef
      isSwitchingRef.current = true;
      video.pause();
      video.src = targetSrc;
      currentSrcRef.current = targetSrc;
      video.load();
      await new Promise<void>(resolve => {
        const onReady = () => { video.removeEventListener('canplay', onReady); resolve(); };
        video.addEventListener('canplay', onReady);
        setTimeout(resolve, 3000);
      });
    }

    if (Math.abs(video.currentTime - targetTime) > 0.15) {
      video.currentTime = targetTime;
      await new Promise<void>(resolve => {
        const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
        video.addEventListener('seeked', onSeeked);
        setTimeout(resolve, 1000);
      });
    }

    activeSegIdRef.current  = seg.id;
    segStartTimeRef.current = srcStart;
    isSwitchingRef.current  = false;
    advancingRef.current    = false; // ready for next boundary
    setDisplaySegId(seg.id);

    if (shouldPlay) {
      video.play().catch(() => {});
    }
  }, []); // no deps — reads everything from refs

  // Wire advanceToNextSegmentRef after switchToSegment is stable
  useEffect(() => {
    advanceToNextSegmentRef.current = (segId: string) => {
      const sess = sessionRef.current;
      if (!sess) return;
      const sorted = [...sess.timeline].sort((a, b) => a.order - b.order);
      const cur    = sorted.find(s => s.id === segId);
      if (!cur) return;
      const next = sorted.find(s => s.order === cur.order + 1);
      if (next) {
        // Pass the captured playing state — don't read isPlayingRef here
        // because onPause may have already cleared it during src switch
        switchToSegment(next, 0, true);
      } else {
        // End of timeline
        photoModeRef.current = false;
        advancingRef.current = false;
        videoRef.current?.pause();
        setIsPlaying(false);
        isPlayingRef.current = false;
        setPhotoOverlay(null);
      }
    };
  }, [switchToSegment]);

  // Keep isPlaying state in sync with the video element.
  // isSwitchingRef guards against onPause clearing the flag during src changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay  = () => { setIsPlaying(true);  isPlayingRef.current = true; };
    const onPause = () => {
      // Ignore pause events that come from our own src-switch or photo handling
      if (isSwitchingRef.current || photoModeRef.current) return;
      setIsPlaying(false);
      isPlayingRef.current = false;
    };
    video.addEventListener('play',  onPlay);
    video.addEventListener('pause', onPause);
    return () => { video.removeEventListener('play', onPlay); video.removeEventListener('pause', onPause); };
  }, []);

  // Prime the video when the session first loads
  useEffect(() => {
    if (!session) return;
    const sorted = [...session.timeline].sort((a, b) => a.order - b.order);
    const first  = sorted[0];
    if (!first) return;

    const src      = first.assetUrl ?? session.videoUrl;
    const srcStart = first.assetUrl ? 0 : first.sourceStart;

    activeSegIdRef.current  = first.id;
    segStartTimeRef.current = srcStart;
    photoModeRef.current    = false;
    advancingRef.current    = false;
    setDisplaySegId(first.id);

    const video = videoRef.current;
    if (video && currentSrcRef.current !== src) {
      video.src = src;
      currentSrcRef.current = src;
      video.load();
      video.addEventListener('canplay', () => { video.currentTime = srcStart; }, { once: true });
    }
  }, [session?.sessionId]);

  // ── Timeline click / drag ────────────────────────────────────────────────────

  const seekToTimelinePos = useCallback(async (pos: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const clamped = Math.max(0, Math.min(pos, totalDuration(sess.timeline)));
    const resolved = resolveSegment(sess.timeline, clamped);
    if (!resolved) return;
    timelinePosRef.current = clamped;
    setTimelinePos(clamped);
    await switchToSegment(resolved.segment, resolved.offsetInSegment, isPlayingRef.current);
  }, [switchToSegment]);

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!session || isDraggingPlayhead) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seekToTimelinePos(pct * totalDuration(session.timeline));
  };

  const handlePlayheadMouseDown = (e: React.MouseEvent) => { e.stopPropagation(); setIsDraggingPlayhead(true); };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingPlayhead || !session || !timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekToTimelinePos(pct * totalDuration(session.timeline));
  }, [isDraggingPlayhead, session, seekToTimelinePos]);

  const handleMouseUp = useCallback(() => setIsDraggingPlayhead(false), []);

  useEffect(() => {
    if (isDraggingPlayhead) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp); };
    }
  }, [isDraggingPlayhead, handleMouseMove, handleMouseUp]);

  // ── Edit operations ──────────────────────────────────────────────────────────

  const handleCut = () => {
    if (!session) return;
    const pos = timelinePosRef.current;
    const resolved = resolveSegment(session.timeline, pos);
    if (!resolved || resolved.offsetInSegment < 0.05 || resolved.offsetInSegment > resolved.segment.duration - 0.05) {
      alert('Position the playhead inside a segment to cut.'); return;
    }
    const { segment: seg, offsetInSegment } = resolved;
    const s1: TimelineSegment = {
      ...seg, id: `${seg.id}-1`,
      sourceEnd: seg.assetUrl ? seg.sourceEnd : seg.sourceStart + offsetInSegment,
      duration: offsetInSegment,
    };
    const s2: TimelineSegment = {
      ...seg, id: `${seg.id}-2`,
      sourceStart: seg.assetUrl ? seg.sourceStart : seg.sourceStart + offsetInSegment,
      duration: seg.duration - offsetInSegment,
    };
    const newTimeline = rebuildTimeline(
      session.timeline.filter(s => s.id !== seg.id).concat([s1, s2]).sort((a, b) => a.order - b.order),
    );
    const updated = {
      ...session, timeline: newTimeline,
      undoStack: [...session.undoStack, { type: 'CUT' as const, segmentId: seg.id, cutTime: pos, newSegmentId: s2.id }],
      redoStack: [],
    };
    setSession(updated);
    sessionManager.saveSession(sessionId, updated);
  };

  const handleDelete = () => {
    if (!session || !selectedSegmentId) { alert('Select a segment to delete.'); return; }
    if (session.timeline.length === 1) { alert('Cannot delete the last segment.'); return; }
    const seg = session.timeline.find(s => s.id === selectedSegmentId);
    if (!seg) return;
    const newTimeline = rebuildTimeline(session.timeline.filter(s => s.id !== selectedSegmentId));
    const updated = {
      ...session, timeline: newTimeline,
      undoStack: [...session.undoStack, { type: 'DELETE' as const, segment: seg }],
      redoStack: [],
    };
    setSession(updated);
    setSelectedSegmentId(null);
    sessionManager.saveSession(sessionId, updated);
  };

  const handleUndo = () => {
    if (!session || session.undoStack.length === 0) return;
    const last = session.undoStack[session.undoStack.length - 1];
    let tl = [...session.timeline];
    if (last.type === 'CUT') {
      const s1 = tl.find(s => s.id === `${last.segmentId}-1`);
      const s2 = tl.find(s => s.id === `${last.segmentId}-2`);
      if (s1 && s2) {
        const merged: TimelineSegment = {
          ...s1, id: last.segmentId,
          sourceEnd: s2.sourceEnd, duration: s1.duration + s2.duration,
        };
        tl = rebuildTimeline(tl.filter(s => s.id !== s1.id && s.id !== s2.id).concat([merged]).sort((a, b) => a.order - b.order));
      }
    } else if (last.type === 'DELETE') {
      tl = rebuildTimeline([...tl, last.segment].sort((a, b) => a.order - b.order));
    }
    const updated = { ...session, timeline: tl, undoStack: session.undoStack.slice(0, -1), redoStack: [...session.redoStack, last] };
    setSession(updated);
    sessionManager.saveSession(sessionId, updated);
  };

  const handleRedo = () => {
    if (!session || session.redoStack.length === 0) return;
    const action = session.redoStack[session.redoStack.length - 1];
    let tl = [...session.timeline];
    if (action.type === 'CUT') {
      const seg = tl.find(s => s.id === action.segmentId);
      if (seg) {
        const offset = action.cutTime - seg.timelineStart;
        const s1: TimelineSegment = { ...seg, id: `${seg.id}-1`, sourceEnd: seg.sourceStart + offset, duration: offset };
        const s2: TimelineSegment = { ...seg, id: `${seg.id}-2`, sourceStart: seg.sourceStart + offset, duration: seg.duration - offset };
        tl = rebuildTimeline(tl.filter(s => s.id !== seg.id).concat([s1, s2]).sort((a, b) => a.order - b.order));
      }
    } else if (action.type === 'DELETE') {
      tl = rebuildTimeline(tl.filter(s => s.id !== action.segment.id).sort((a, b) => a.order - b.order));
    }
    const updated = { ...session, timeline: tl, undoStack: [...session.undoStack, action], redoStack: session.redoStack.slice(0, -1) };
    setSession(updated);
    sessionManager.saveSession(sessionId, updated);
  };

  const handleSegmentClick = (segmentId: string, e: React.MouseEvent) => { e.stopPropagation(); setSelectedSegmentId(segmentId); };

  const handleClipRename = (segmentId: string, newName: string) => {
    if (!session) return;
    const updated = { ...session, timeline: session.timeline.map(s => s.id === segmentId ? { ...s, name: newName } : s) };
    setSession(updated);
    sessionManager.saveSession(sessionId, updated);
  };

  const handleSegmentJump = async (segment: TimelineSegment) => {
    setSeekingSegmentId(segment.id);
    setSelectedSegmentId(segment.id);
    await seekToTimelinePos(segment.timelineStart);
    setSeekingSegmentId(null);
  };

  // ── Add asset to timeline ────────────────────────────────────────────────────
  //
  // Key invariant: after inserting, the master clock (timelinePos) stays at the
  // same logical position — the start of the newly inserted segment — and the
  // video continues playing from there without any restart.

  const handleAddAssetToTimeline = useCallback((asset: PixabayAsset, photoDuration?: number) => {
    const sess = sessionRef.current;
    const video = videoRef.current;
    if (!sess || !video) return;

    const wasPlaying = !video.paused;
    // Pause while we restructure the timeline
    video.pause();

    const assetUrl = asset._kind === 'video'
      ? (asset.videos.small?.url || asset.videos.medium?.url || asset.videos.tiny?.url || '')
      : (asset as PixabayPhoto).webformatURL;
    const assetDuration = asset._kind === 'video' ? (asset as PixabayVideo).duration : (photoDuration ?? 5);

    const insertPos = timelinePosRef.current; // where the playhead is right now

    // Build the new segment
    const newSeg: TimelineSegment = {
      id: `asset-${asset._kind}-${asset.id}-${Date.now()}`,
      sourceStart: 0, sourceEnd: assetDuration,
      timelineStart: insertPos, // will be recalculated by rebuildTimeline
      duration: assetDuration,
      order: 0, // will be recalculated
      name: asset.tags.split(',')[0].trim() || `${asset._kind} asset`,
      assetUrl,
      assetKind: asset._kind,
    };

    let newTimeline: TimelineSegment[];

    if (asset._kind === 'photo') {
      // Photos always go at the end
      newTimeline = rebuildTimeline([...sess.timeline, { ...newSeg, order: sess.timeline.length }]);
    } else {
      // Videos: insert at insertPos, splitting the host segment if needed
      const resolved = resolveSegment(sess.timeline, insertPos);

      if (!resolved) {
        // Inserting at the very end
        newTimeline = rebuildTimeline([...sess.timeline, { ...newSeg, order: sess.timeline.length }]);
      } else {
        const { segment: host, offsetInSegment } = resolved;
        const beforeHost = sess.timeline.filter(s => s.order < host.order);
        const afterHost  = sess.timeline.filter(s => s.order > host.order);

        if (offsetInSegment < 0.05) {
          // Insert right before the host segment
          newTimeline = rebuildTimeline([
            ...beforeHost,
            { ...newSeg, order: host.order },
            ...afterHost.concat([host]).map((s, i) => ({ ...s, order: host.order + 1 + i })),
          ]);
        } else if (offsetInSegment > host.duration - 0.05) {
          // Insert right after the host segment
          newTimeline = rebuildTimeline([
            ...beforeHost,
            host,
            { ...newSeg, order: host.order + 1 },
            ...afterHost.map((s, i) => ({ ...s, order: host.order + 2 + i })),
          ]);
        } else {
          // Split the host segment and insert in the middle
          const hostBefore: TimelineSegment = {
            ...host, id: `${host.id}-b`,
            sourceEnd: host.assetUrl ? host.sourceEnd : host.sourceStart + offsetInSegment,
            duration: offsetInSegment,
          };
          const hostAfter: TimelineSegment = {
            ...host, id: `${host.id}-a`,
            sourceStart: host.assetUrl ? host.sourceStart : host.sourceStart + offsetInSegment,
            duration: host.duration - offsetInSegment,
          };
          newTimeline = rebuildTimeline([
            ...beforeHost,
            hostBefore,
            { ...newSeg, order: host.order + 1 },
            hostAfter,
            ...afterHost.map((s, i) => ({ ...s, order: host.order + 3 + i })),
          ]);
        }
      }
    }

    // The new total duration
    const newTotal = totalDuration(newTimeline);

    const updatedSession: SessionData = {
      ...sess,
      timeline: newTimeline,
      // Keep session.duration in sync so the ruler is correct
      duration: newTotal,
      undoStack: [...sess.undoStack, {
        type: 'CUT' as const,
        segmentId: '',
        cutTime: insertPos,
        newSegmentId: newSeg.id,
      }],
      redoStack: [],
    };

    // 1. Update React state AND the ref immediately so the engine sees the new timeline
    setSession(updatedSession);
    sessionRef.current = updatedSession;
    sessionManager.saveSession(sessionId, updatedSession);

    // 2. Imperatively switch the video to the new segment at insertPos.
    //    For a video asset inserted at insertPos, that segment starts at insertPos
    //    in the new timeline, so offset = 0.
    const newResolved = resolveSegment(newTimeline, insertPos);
    if (newResolved) {
      switchToSegment(newResolved.segment, newResolved.offsetInSegment, wasPlaying).then(() => {
        timelinePosRef.current = insertPos;
        setTimelinePos(insertPos);
        if (wasPlaying) setIsPlaying(true);
      });
    }
  }, [switchToSegment, sessionId]);

  // ── Misc handlers ────────────────────────────────────────────────────────────

  const handleExport = () => alert('Export functionality will be implemented');

  const handleTranscribe = async () => {
    if (!session) return;
    setIsTranscribing(true);
    try {
      const apiClient = new APIClient('http://localhost:8000/api');
      const response = await apiClient.transcribeVideo(session.sessionId);
      let formatted = response.transcript;
      if (response.segments?.length > 0) {
        formatted = response.segments.map((seg: { start: number; end: number; text: string }) =>
          `[${formatTime(seg.start)} - ${formatTime(seg.end)}] ${seg.text}`
        ).join('\n\n');
      }
      const updated = { ...session, transcript: formatted };
      setSession(updated);
      await sessionManager.saveSession(sessionId, updated);
    } catch (error) {
      let msg = 'Transcription failed. ';
      if (error instanceof Error) {
        if (error.message.includes('OpenAI API key')) msg += 'OpenAI API key not configured.';
        else if (error.message.includes('Video file not found')) msg += 'Video file not found on backend.';
        else if (error.message.includes('Connection failed')) msg += 'Cannot connect to backend.';
        else msg += error.message;
      }
      alert(msg);
    } finally { setIsTranscribing(false); }
  };

  const handleTranscriptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!session) return;
    const updated = { ...session, transcript: e.target.value };
    setSession(updated);
    sessionManager.saveSession(sessionId, updated);
  };

  const handleResetConfirm = async () => {
    if (session) await sessionManager.clearSession(session.sessionId);
    setShowResetDialog(false);
    if (onReset) onReset();
  };

  // ── Derived values for rendering ─────────────────────────────────────────────

  const tlTotal = session ? totalDuration(session.timeline) : 0;
  const playheadPct = tlTotal > 0 ? (timelinePos / tlTotal) * 100 : 0;

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!session) {
    return <div className="editor-page"><div className="loading">Loading session…</div></div>;
  }

  return (
    <div className="editor-page">
      <header className="editor-header">
        <div className="header-left">
          <h1>AutoEdit</h1>
        </div>
        <div className="header-right">
          <button className="btn btn-secondary" onClick={() => setShowResetDialog(true)}>Reset</button>
          <button className="btn btn-primary" onClick={handleExport}>Export</button>
        </div>
      </header>

      <div className="editor-content">
        <main className="editor-main">
          <div className="video-player">
            {/* Single <video> element — never remounted, no native controls */}
            <video
              ref={videoRef}
              className="video-element"
              crossOrigin="anonymous"
              preload="auto"
            />
            {/* Photo overlay rendered on top when active segment is a photo */}
            {photoOverlay && (
              <div className="video-photo-preview">
                <img src={photoOverlay.url} alt={photoOverlay.name} className="video-photo-img"/>
                <div className="video-photo-label">{photoOverlay.name}</div>
              </div>
            )}
          </div>

          {/* ── Custom player controls showing MERGED timeline time ── */}
          <div className="player-controls">
            <button
              className="player-btn"
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                if (isPlayingRef.current || photoModeRef.current) {
                  // ── Pause ──────────────────────────────────────────────────
                  // Stop the video FIRST, then freeze all state.
                  video.pause();

                  const frozenPos = timelinePosRef.current;
                  photoModeRef.current = false;
                  advancingRef.current = false;
                  isPlayingRef.current = false;

                  // Keep the video-mode formula stable at frozenPos after pause:
                  // newPos = activeSeg.timelineStart + (video.currentTime - segStartTimeRef)
                  // Adjust segStartTimeRef so this always equals frozenPos.
                  const sess = sessionRef.current;
                  if (sess) {
                    const activeSeg = sess.timeline.find(s => s.id === activeSegIdRef.current);
                    if (activeSeg) {
                      segStartTimeRef.current = video.currentTime - (frozenPos - activeSeg.timelineStart);
                    }
                  }

                  setIsPlaying(false);
                  setTimelinePos(frozenPos);
                  timelinePosRef.current = frozenPos;
                } else {
                  // ── Play ───────────────────────────────────────────────────
                  const sess = sessionRef.current;
                  if (!sess) return;
                  const resolved = resolveSegment(sess.timeline, timelinePosRef.current);
                  if (resolved) {
                    switchToSegment(resolved.segment, resolved.offsetInSegment, true);
                  }
                }
              }}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>}
            </button>

            <span className="player-time">
              {formatTime(timelinePos)} / {formatTime(tlTotal)}
            </span>

            {/* Scrubber — maps to merged timeline, not raw video time */}
            <div
              className="player-scrubber"
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                seekToTimelinePos(pct * tlTotal);
              }}
            >
              <div className="player-scrubber-track">
                <div
                  className="player-scrubber-fill"
                  style={{ width: `${tlTotal > 0 ? (timelinePos / tlTotal) * 100 : 0}%` }}
                />
                <div
                  className="player-scrubber-thumb"
                  style={{ left: `${tlTotal > 0 ? (timelinePos / tlTotal) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>

          <div className="editing-controls">
            <button className="btn btn-icon" title="Cut at playhead" onClick={handleCut}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
                <line x1="20" y1="4" x2="8.12" y2="15.88"/>
                <line x1="14.47" y1="14.48" x2="20" y2="20"/>
                <line x1="8.12" y1="8.12" x2="12" y2="12"/>
              </svg>
            </button>
            <button className="btn btn-icon" title="Delete selected segment" onClick={handleDelete} disabled={!selectedSegmentId}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
            <button className="btn btn-icon" title="Undo" onClick={handleUndo} disabled={session.undoStack.length === 0}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            </button>
            <button className="btn btn-icon" title="Redo" onClick={handleRedo} disabled={session.redoStack.length === 0}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
          </div>

          <div className="timeline">
            <div className="timeline-header">
              <span>Timeline</span>
              <span className="timeline-time">{formatTime(timelinePos)} / {formatTime(tlTotal)}</span>
            </div>
            <div
              className={`timeline-content${isDraggingPlayhead ? ' dragging' : ''}`}
              ref={timelineRef}
              onClick={handleTimelineClick}
            >
              <div className="timeline-ruler">
                {Array.from({ length: 11 }).map((_, i) => (
                  <div key={i} className="timeline-tick" style={{ left: `${i * 10}%` }}>
                    <span className="timeline-tick-label">{formatTime((tlTotal / 10) * i)}</span>
                  </div>
                ))}
              </div>
              <div className="timeline-track">
                {[...session.timeline].sort((a, b) => a.order - b.order).map(seg => {
                  const left  = tlTotal > 0 ? (seg.timelineStart / tlTotal) * 100 : 0;
                  const width = tlTotal > 0 ? (seg.duration / tlTotal) * 100 : 0;
                  const isActive = displaySegId === seg.id;
                  return (
                    <div key={seg.id}
                      className={[
                        'timeline-segment',
                        selectedSegmentId === seg.id ? 'selected' : '',
                        seg.assetKind === 'video' ? 'asset-video' : '',
                        seg.assetKind === 'photo' ? 'asset-photo' : '',
                        isActive ? 'active' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
                      onClick={e => handleSegmentClick(seg.id, e)}>
                      <span className="segment-label">{seg.name || `Clip ${seg.order + 1}`}</span>
                    </div>
                  );
                })}
                {/* Playhead */}
                <div
                  className={`timeline-playhead${isDraggingPlayhead ? ' dragging' : ''}`}
                  style={{ left: `${playheadPct}%` }}
                  onMouseDown={handlePlayheadMouseDown}
                />
              </div>
            </div>
          </div>
        </main>

        <aside className="editor-sidebar">
          <div className="sidebar-tabs">
            <button className={`tab${activeTab === 'clips' ? ' active' : ''}`} onClick={() => setActiveTab('clips')}>Clips</button>
            <button className={`tab${activeTab === 'ai-edit' ? ' active' : ''}`} onClick={() => setActiveTab('ai-edit')}>AI Edit</button>
            <button className={`tab${activeTab === 'assets' ? ' active' : ''}`} onClick={() => setActiveTab('assets')}>Assets</button>
          </div>
          <div className="sidebar-content">
            {activeTab === 'clips' && (
              <div className="tab-panel">
                <h3 className="panel-title">Video Clips</h3>
                <p className="panel-description">
                  {session.timeline.length} clip{session.timeline.length !== 1 ? 's' : ''} · {formatTime(tlTotal)} total
                </p>
                <div className="clips-list">
                  {[...session.timeline].sort((a, b) => a.order - b.order).map(seg => (
                    <div key={seg.id}
                      className={`clip-item${selectedSegmentId === seg.id ? ' selected' : ''}`}
                      onClick={() => handleSegmentJump(seg)}>
                      <div className="clip-header">
                        <input type="text" className="clip-name-input"
                          value={seg.name || `Clip ${seg.order + 1}`}
                          onChange={e => { e.stopPropagation(); handleClipRename(seg.id, e.target.value); }}
                          onClick={e => e.stopPropagation()}
                          placeholder={`Clip ${seg.order + 1}`}/>
                        <span className="clip-duration">{formatTime(seg.duration)}</span>
                      </div>
                      <div className="clip-time-range">
                        {seg.assetKind
                          ? <span className={`clip-kind-badge ${seg.assetKind}`}>{seg.assetKind}</span>
                          : `${formatTime(seg.sourceStart)} – ${formatTime(seg.sourceEnd)}`}
                      </div>
                      <div className="clip-actions">
                        <button className="btn-small"
                          onClick={e => { e.stopPropagation(); handleSegmentJump(seg); }}
                          disabled={seekingSegmentId === seg.id}>
                          {seekingSegmentId === seg.id ? 'Seeking…' : 'Jump to'}
                        </button>
                        <button className="btn-small btn-danger-small"
                          onClick={e => { e.stopPropagation(); setSelectedSegmentId(seg.id); handleDelete(); }}
                          disabled={seekingSegmentId !== null}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'ai-edit' && (
              <div className="tab-panel">
                <h3 className="panel-title">AI Transcription</h3>
                <p className="panel-description">Generate and edit video transcript</p>
                <button className="btn btn-secondary btn-full" onClick={handleTranscribe} disabled={isTranscribing}>
                  {isTranscribing ? 'Transcribing…' : 'Transcribe Video'}
                </button>
                <div className="transcript-area">
                  {session.transcript ? (
                    <>
                      <label className="transcript-label">Transcript:</label>
                      <textarea className="transcript-text" value={session.transcript}
                        onChange={handleTranscriptChange} placeholder="Edit your transcript here…"/>
                      <p className="transcript-hint">Edit the transcript to modify your video content</p>
                    </>
                  ) : (
                    <div className="empty-state">
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ margin: '0 auto 1rem', opacity: 0.5 }}>
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                      </svg>
                      <p>No transcript yet</p>
                      <p className="empty-state-hint">Click "Transcribe Video" to generate a transcript using AI</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'assets' && (
              <AssetsTab onAddToTimeline={handleAddAssetToTimeline}/>
            )}
          </div>
        </aside>
      </div>

      {showResetDialog && (
        <div className="dialog-overlay" onClick={() => setShowResetDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h2>Reset Session?</h2>
            <p>This will clear all editing data and return to the upload page.</p>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => setShowResetDialog(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleResetConfirm}>Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
