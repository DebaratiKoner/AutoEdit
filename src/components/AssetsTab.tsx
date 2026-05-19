/**
 * AssetsTab — Pixabay video/photo search + local file attach
 * In "All" mode: shows Videos, Photos, Audio as separate sections with individual Load More.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

const PIXABAY_PROXY = '/api/pixabay';
const FREESOUND_PROXY = '/api/freesound';
const imgProxy = (url: string) => url ? `/api/proxy-image?url=${encodeURIComponent(url)}` : '';
const vidProxy = (url: string) => url ? `/api/proxy-video?url=${encodeURIComponent(url)}` : '';
const audioProxy = (url: string) => url ? `/api/proxy-audio?url=${encodeURIComponent(url)}` : '';

export type AssetFilter = 'all' | 'video' | 'photo' | 'audio';

export interface PixabayVideoSize { url: string; width: number; height: number; size: number; thumbnail: string; }
export interface PixabayVideo {
  id: number; tags: string; duration: number; picture_id: string;
  videos: { large: PixabayVideoSize; medium: PixabayVideoSize; small: PixabayVideoSize; tiny: PixabayVideoSize };
  user: string; userImageURL: string;
}
export interface PixabayPhoto {
  id: number; tags: string;
  previewURL: string; webformatURL: string; largeImageURL: string;
  imageWidth: number; imageHeight: number;
  user: string; userImageURL: string;
}
export interface FreesoundAudio {
  id: number; name: string; tags: string; duration: number;
  previews: { 'preview-hq-mp3': string; 'preview-lq-mp3': string; 'preview-hq-ogg': string; 'preview-lq-ogg': string };
  username: string; images: { waveform_l: string; spectral_l: string; waveform_m: string; spectral_m: string };
}
export type PixabayAsset =
  | (PixabayVideo & { _kind: 'video' })
  | (PixabayPhoto & { _kind: 'photo' })
  | (FreesoundAudio & { _kind: 'audio' });

function bestThumb(v: PixabayVideo): string {
  return v.videos?.medium?.thumbnail || v.videos?.small?.thumbnail || v.videos?.tiny?.thumbnail || v.videos?.large?.thumbnail || '';
}
function bestVideoUrl(v: PixabayVideo): string {
  return v.videos?.small?.url || v.videos?.medium?.url || v.videos?.tiny?.url || v.videos?.large?.url || '';
}

export interface AssetsTabProps {
  onAddToTimeline: (asset: PixabayAsset, photoDuration?: number) => void;
}

const PER_PAGE = 8;
const MIN_AUDIO_SECONDS = 120; // 2 minutes
const TOPICS: Record<string, string[]> = {

  all:   ['nature', 'city', 'technology', 'travel', 'food', 'sports', 'music', 'animals'],
  video: ['nature', 'city', 'technology', 'travel', 'food', 'sports', 'music', 'animals'],
  photo: ['nature', 'architecture', 'people', 'travel', 'food', 'fashion', 'abstract', 'flowers'],
  audio: ['music', 'sound effect', 'nature', 'city', 'ambient', 'cinematic', 'beat', 'electronic'],
};
const FALLBACK = 'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%22160%22 height%3D%2290%22%3E%3Crect width%3D%22160%22 height%3D%2290%22 fill%3D%22%231a1a2e%22%2F%3E%3Cpolygon points%3D%2260%2C25 100%2C45 60%2C65%22 fill%3D%22%234a90e2%22%2F%3E%3C%2Fsvg%3E';

// Per-section state for "All" mode
interface SectionState {
  items: PixabayAsset[];
  page: number;
  total: number;
  loading: boolean;
}
const emptySec = (): SectionState => ({ items: [], page: 1, total: 0, loading: false });

export function AssetsTab({ onAddToTimeline }: AssetsTabProps) {
  const [filter, setFilter]       = useState<AssetFilter>('all');
  const [inputValue, setInputValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [addedIds, setAddedIds]   = useState<Set<number>>(new Set());
  const [photoDurs, setPhotoDurs] = useState<Record<number, string>>({});
  const [preview, setPreview]     = useState<(PixabayVideo & { _kind: 'video' }) | (FreesoundAudio & { _kind: 'audio' }) | null>(null);
  const videoPreviewRef           = useRef<HTMLVideoElement>(null);
  const audioPreviewRef           = useRef<HTMLAudioElement>(null);

  // Single-filter state (video / photo / audio tabs)
  const [singleItems, setSingleItems] = useState<PixabayAsset[]>([]);
  const [singlePage, setSinglePage]   = useState(1);
  const [singleTotal, setSingleTotal] = useState(0);
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);

  // All-mode per-section state
  const [videoSec, setVideoSec] = useState<SectionState>(emptySec());
  const [photoSec, setPhotoSec] = useState<SectionState>(emptySec());
  const [audioSec, setAudioSec] = useState<SectionState>(emptySec());
  const [allError, setAllError] = useState<string | null>(null);
  const [audioPreviewError, setAudioPreviewError] = useState<string | null>(null);

  const topics = TOPICS[filter] ?? [];

  // ── Fetch helpers ──────────────────────────────────────────────────────────
  const fetchVideos = useCallback(async (q: string, pg: number): Promise<{ items: PixabayAsset[]; total: number }> => {
    const p = new URLSearchParams({ type: 'videos', q, per_page: String(PER_PAGE), page: String(pg), safesearch: 'true' });
    const res = await fetch(`${PIXABAY_PROXY}?${p}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
    const data = await res.json();
    return { items: (data.hits ?? []).map((v: PixabayVideo) => ({ ...v, _kind: 'video' as const })), total: data.totalHits ?? 0 };
  }, []);

  const fetchPhotos = useCallback(async (q: string, pg: number): Promise<{ items: PixabayAsset[]; total: number }> => {
    const p = new URLSearchParams({ type: 'images', q, per_page: String(PER_PAGE), page: String(pg), safesearch: 'true', image_type: 'photo' });
    const res = await fetch(`${PIXABAY_PROXY}?${p}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
    const data = await res.json();
    return { items: (data.hits ?? []).map((ph: PixabayPhoto) => ({ ...ph, _kind: 'photo' as const })), total: data.totalHits ?? 0 };
  }, []);

  const fetchAudio = useCallback(async (q: string, pg: number): Promise<{ items: PixabayAsset[]; total: number }> => {
    const p = new URLSearchParams({ q, page: String(pg), page_size: String(PER_PAGE) });
    const res = await fetch(`${FREESOUND_PROXY}?${p}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
    const data = await res.json();
    return { items: (data.hits ?? []).map((a: FreesoundAudio) => ({ ...a, _kind: 'audio' as const })), total: data.totalHits ?? 0 };
  }, []);

  // ── Load all three sections ────────────────────────────────────────────────
  const loadAllSections = useCallback(async (q: string) => {
    if (!q.trim()) { setVideoSec(emptySec()); setPhotoSec(emptySec()); setAudioSec(emptySec()); return; }
    setAllError(null);
    setVideoSec(s => ({ ...s, loading: true }));
    setPhotoSec(s => ({ ...s, loading: true }));
    setAudioSec(s => ({ ...s, loading: true }));
    try {
      const [v, ph, au] = await Promise.all([fetchVideos(q, 1), fetchPhotos(q, 1), fetchAudio(q, 1)]);
      setVideoSec({ items: v.items, page: 1, total: v.total, loading: false });
      setPhotoSec({ items: ph.items, page: 1, total: ph.total, loading: false });
      // Front-load only long audio (>= 2 minutes). Load More will append everything.
      const longAudio = au.items.filter(a => {
        const dur = (a as FreesoundAudio).duration;
        return typeof dur === 'number' && dur >= MIN_AUDIO_SECONDS;
      });
      setAudioSec({ items: longAudio, page: 1, total: au.total, loading: false });

    } catch (e) {
      setAllError(e instanceof Error ? e.message : 'Failed to fetch');
      setVideoSec(s => ({ ...s, loading: false }));
      setPhotoSec(s => ({ ...s, loading: false }));
      setAudioSec(s => ({ ...s, loading: false }));
    }
  }, [fetchVideos, fetchPhotos, fetchAudio]);

  // ── Load single filter ─────────────────────────────────────────────────────
  const loadSingle = useCallback(async (q: string, f: AssetFilter, pg: number, append = false) => {
    if (!q.trim()) { setSingleItems([]); setSingleTotal(0); return; }
    setSingleLoading(true);
    setSingleError(null);
    try {
      let result: { items: PixabayAsset[]; total: number };
      if (f === 'video') result = await fetchVideos(q, pg);
      else if (f === 'photo') result = await fetchPhotos(q, pg);
      else result = await fetchAudio(q, pg);
      setSingleTotal(result.total);
      setSingleItems(prev => append ? [...prev, ...result.items] : result.items);
    } catch (e) {
      setSingleError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setSingleLoading(false);
    }
  }, [fetchVideos, fetchPhotos, fetchAudio]);

  useEffect(() => {
    if (filter === 'all') loadAllSections(searchQuery);
    else loadSingle(searchQuery, filter, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, filter]);

  const changeFilter = (f: AssetFilter) => {
    setFilter(f); setSingleItems([]); setSinglePage(1); setSearchQuery(''); setInputValue('');
    setVideoSec(emptySec()); setPhotoSec(emptySec()); setAudioSec(emptySec());
  };

  const submit = (e: React.FormEvent) => { e.preventDefault(); setSearchQuery(inputValue); };

  const addToTimeline = (asset: PixabayAsset, e: React.MouseEvent) => {
    e.stopPropagation();
    const dur = asset._kind !== 'video'
      ? Math.max(1, parseFloat(photoDurs[asset.id] || (asset._kind === 'audio' ? String((asset as FreesoundAudio).duration) : '5')) || 5)
      : undefined;
    onAddToTimeline(asset, dur);
    setAddedIds(prev => new Set(prev).add(asset.id));
  };

  const closePreview = () => {
    setPreview(null);
    videoPreviewRef.current?.pause();

    const a = audioPreviewRef.current;
    if (a) {
      a.pause();
      try { a.currentTime = 0; } catch {}
      try { a.load(); } catch {}
    }
  };


  useEffect(() => {
    setAudioPreviewError(null);
    if (preview?._kind !== 'audio') return;

    const audio = audioPreviewRef.current;
    if (!audio) return;

    // For audio previews, we want the preview button to play with sound
    // and stop at the specified duration.
    const specifiedDuration = Number(preview.duration ?? 0);
    const previewDuration = Number.isFinite(specifiedDuration) ? Math.max(0, specifiedDuration) : 0;

    let didCancel = false;

    const stopAtDuration = () => {
      if (previewDuration > 0 && audio.currentTime >= previewDuration) {
        audio.pause();
      }
    };

    audio.pause();
    try { audio.currentTime = 0; } catch {}

    audio.muted = false;
    audio.volume = 1;

    try { audio.load(); } catch {}

    audio.addEventListener('timeupdate', stopAtDuration);

    // Also stop at the duration using a timeout to match the video preview's deterministic stop.
    const timeoutId = previewDuration > 0 ? window.setTimeout(() => {
      try { audio.pause(); } catch {}
    }, previewDuration * 1000) : null;

    audio.play().catch(() => {
      // Autoplay may be blocked; user can press play via native controls.
    });

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      didCancel = true;
      audio.removeEventListener('timeupdate', stopAtDuration);
      if (didCancel) {
        try { audio.pause(); } catch {}
      }
    };
  }, [preview]);


  const playAudioPreview = () => {
    const audio = audioPreviewRef.current;
    if (!audio || preview?._kind !== 'audio') return;

    const specifiedDuration = Number(preview.duration ?? 0);
    const previewDuration = Number.isFinite(specifiedDuration) ? Math.max(0, specifiedDuration) : 0;

    // Reset and play from start.
    audio.pause();
    try { audio.currentTime = 0; } catch {}

    audio.muted = false;
    audio.volume = 1;

    // Stop exactly at the requested duration.
    const onTimeUpdate = () => {
      if (previewDuration > 0 && audio.currentTime >= previewDuration) {
        audio.pause();
        audio.removeEventListener('timeupdate', onTimeUpdate);
      }
    };

    // Ensure we don't accumulate listeners across preview reopens.
    audio.removeEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('timeupdate', onTimeUpdate);

    try {
      audio.load();
    } catch {}

    audio.play().catch(() => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      // Native controls let the user start playback if autoplay is blocked.
    });
  };


  // ── Asset card renderer ────────────────────────────────────────────────────
  const renderCard = (asset: PixabayAsset) => {
    const isVid   = asset._kind === 'video';
    const isAudio = asset._kind === 'audio';
    const thumb   = isVid
      ? imgProxy(bestThumb(asset as PixabayVideo))
      : isAudio
      ? imgProxy((asset as FreesoundAudio).images.waveform_m)
      : imgProxy((asset as PixabayPhoto).previewURL || (asset as PixabayPhoto).webformatURL);
    const isAdded = addedIds.has(asset.id);

    return (
      <div key={`${asset._kind}-${asset.id}`} className="asset-card" style={isAudio ? { marginBottom: '1rem', marginLeft: '0.5rem', marginRight: '0.5rem' } : undefined}>
        <div className="asset-card-thumb">
          <img src={thumb || FALLBACK} alt={isAudio ? (asset as FreesoundAudio).name : asset.tags}
            loading="lazy" onError={e => { (e.target as HTMLImageElement).src = FALLBACK; }} />
          <div className={`asset-card-badge ${isVid ? 'video' : isAudio ? 'audio' : 'photo'}`}>
            {isVid ? `${(asset as PixabayVideo).duration}s` : isAudio ? `${(asset as FreesoundAudio).duration}s` : 'Photo'}
          </div>
        </div>
        <div className="asset-card-info">
          <p className="asset-card-tags">
            {isAudio ? (asset as FreesoundAudio).name : asset.tags.split(',').slice(0, 3).join(', ')}
          </p>
          {!isVid && (
            <div className="asset-photo-duration">
              <label className="asset-photo-duration-label">Duration (s):</label>
              <input type="number" className="asset-photo-duration-input" min="1" max="300" step="1"
                value={photoDurs[asset.id] ?? (isAudio ? (asset as FreesoundAudio).duration : '5')}
                onClick={e => e.stopPropagation()}
                onChange={e => setPhotoDurs(prev => ({ ...prev, [asset.id]: e.target.value }))} />
            </div>
          )}
          <div className="asset-card-actions">
            {(isVid || isAudio) && (
              <button className="asset-preview-btn" style={{ fontSize: '0.65rem', padding: '2px 6px' }}
                onClick={e => { e.stopPropagation(); setPreview(asset as (PixabayVideo & { _kind: 'video' }) | (FreesoundAudio & { _kind: 'audio' })); }}>Preview</button>
            )}
            <button className={`asset-add-btn${isAdded ? ' added' : ''}`}
              style={{ fontSize: '0.65rem', padding: '2px 6px' }}
              onClick={e => addToTimeline(asset, e)} title="Insert at playhead">
              {isAdded ? 'Inserted' : 'Insert'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ── Section renderer (for All mode) ───────────────────────────────────────
  const renderSection = (
    title: string,
    sec: SectionState,
    onLoadMore: () => void,
    emptyMsg: string,
  ) => (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', borderBottom: '1px solid #2a2a3e', paddingBottom: '0.4rem' }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#9fc5ff', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</span>
        {sec.total > 0 && <span style={{ fontSize: '0.68rem', color: '#555' }}>{sec.items.length} / {sec.total}</span>}
      </div>
      {sec.loading && sec.items.length === 0 && (
        <div className="assets-loading"><div className="assets-spinner"/><span>Loading...</span></div>
      )}
      {!sec.loading && sec.items.length === 0 && searchQuery && (
        <p style={{ color: '#555', fontSize: '0.75rem', fontStyle: 'italic', margin: '0.5rem 0' }}>{emptyMsg}</p>
      )}
      {sec.items.length > 0 && (
        <div className="assets-grid">{sec.items.map(renderCard)}</div>
      )}
      {sec.items.length > 0 && sec.items.length < sec.total && (
        <button className="assets-load-more" onClick={onLoadMore} disabled={sec.loading} style={{ marginTop: '0.5rem' }}>
          {sec.loading ? 'Loading…' : `Load More ${title}`}
        </button>
      )}
    </div>
  );

  // ── Load more per section ──────────────────────────────────────────────────
  const loadMoreVideos = async () => {
    const next = videoSec.page + 1;
    setVideoSec(s => ({ ...s, loading: true }));
    try {
      const r = await fetchVideos(searchQuery, next);
      setVideoSec(s => ({ ...s, items: [...s.items, ...r.items], page: next, total: r.total, loading: false }));
    } catch { setVideoSec(s => ({ ...s, loading: false })); }
  };
  const loadMorePhotos = async () => {
    const next = photoSec.page + 1;
    setPhotoSec(s => ({ ...s, loading: true }));
    try {
      const r = await fetchPhotos(searchQuery, next);
      setPhotoSec(s => ({ ...s, items: [...s.items, ...r.items], page: next, total: r.total, loading: false }));
    } catch { setPhotoSec(s => ({ ...s, loading: false })); }
  };
  const loadMoreAudio = async () => {
    const next = audioSec.page + 1;
    setAudioSec(s => ({ ...s, loading: true }));
    try {
      const r = await fetchAudio(searchQuery, next);
      setAudioSec(s => ({ ...s, items: [...s.items, ...r.items], page: next, total: r.total, loading: false }));
    } catch { setAudioSec(s => ({ ...s, loading: false })); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="assets-tab">
      {/* Search + filters */}
      <div className="assets-header">
        <form className="assets-search-form" onSubmit={submit}>
          <div className="assets-search-wrapper">
            <input className="assets-search-input" placeholder="Search media..."
              value={inputValue} onChange={e => setInputValue(e.target.value)} />
            {inputValue && (
              <button type="button" className="assets-search-clear"
                onClick={() => { setInputValue(''); setSearchQuery(''); }}>×</button>
            )}
            <button type="submit" className="assets-search-btn" title="Search"
              onClick={() => setSearchQuery(inputValue)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
          </div>
        </form>

        <div className="assets-filters">
          <div className="assets-filters-row" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {(['all', 'video', 'photo', 'audio'] as AssetFilter[]).map(f => (
              <button key={f} className={`assets-filter-btn${filter === f ? ' active' : ''}`}
                onClick={() => changeFilter(f)}>
                {f === 'all' ? 'All' : f === 'video' ? 'Video' : f === 'photo' ? 'Photos' : f === 'audio' ? 'Audio' : '✨ AI Generated'}
              </button>
            ))}
          </div>
        </div>

        {topics.length > 0 && (
          <div className="assets-topics">
            {topics.map(t => (
              <button key={t} className={`assets-topic-chip${searchQuery === t ? ' active' : ''}`}
                onClick={() => { setInputValue(t); setSearchQuery(t); }}>{t}</button>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="assets-results" style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
        {/* ALL mode — three sections */}
        {filter === 'all' && (
          <>
            {allError && <div style={{ color: '#e74c3c', fontSize: '0.78rem', padding: '0.5rem 0' }}>{allError}</div>}
            {!searchQuery && (
              <div className="assets-empty">
                <p>Search for videos, photos & audio</p>
                <p className="assets-empty-hint">Type a keyword above or tap a topic</p>
              </div>
            )}
            {searchQuery && (
              <>
                {renderSection('Videos', videoSec, loadMoreVideos, 'No videos found')}
                {renderSection('Photos', photoSec, loadMorePhotos, 'No photos found')}
                {renderSection('Audio', audioSec, loadMoreAudio, 'No audio found')}
              </>
            )}
          </>
        )}

        {/* Single-filter mode */}
        {filter !== 'all' && (
          <>
            {singleLoading && singleItems.length === 0 && (
              <div className="assets-loading"><div className="assets-spinner"/><span>Searching...</span></div>
            )}
            {singleError && <div className="assets-error" style={{ padding: '1rem', color: '#e74c3c', fontSize: '0.8rem' }}>Warning: {singleError}</div>}
            {!singleLoading && !singleError && singleItems.length === 0 && (
              <div className="assets-empty">
                <p>Search for {filter === 'photo' ? 'photos' : filter === 'video' ? 'videos' : 'audio'}</p>
                <p className="assets-empty-hint">Type a keyword above or tap a topic</p>
              </div>
            )}
            {singleItems.length > 0 && (
              <div className="assets-grid">{singleItems.map(renderCard)}</div>
            )}
            {singleItems.length > 0 && singleItems.length < singleTotal && (
              <button className="assets-load-more" onClick={() => {
                const next = singlePage + 1; setSinglePage(next);
                loadSingle(searchQuery, filter, next, true);
              }} disabled={singleLoading}>
                {singleLoading ? 'Loading…' : `Load More (${singleItems.length} / ${singleTotal})`}
              </button>
            )}
          </>
        )}

      </div>

      {/* Media preview modal */}
      {preview && (
        <div className="asset-preview-overlay" onClick={closePreview}>
          <div className="asset-preview-panel" onClick={e => e.stopPropagation()}>
            <div className="asset-preview-header">
              <span className="asset-preview-title">{preview._kind === 'audio' ? preview.name : preview.tags.split(',')[0].trim()}</span>
              <button className="asset-preview-close" onClick={closePreview}>×</button>
            </div>
            <div className="asset-preview-video-wrap">
              {preview._kind === 'video' ? (
                <video ref={videoPreviewRef} src={vidProxy(bestVideoUrl(preview))} className="asset-preview-video" controls autoPlay loop />
              ) : (
                <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', background: '#1a1a2e' }}>
                  <img src={imgProxy(preview.images.waveform_m) || FALLBACK} alt="waveform" style={{ width: '100%', maxHeight: '150px', objectFit: 'contain', marginBottom: '2rem' }} />
                  <audio
                    key={preview.id}
                    ref={audioPreviewRef}
                    src={audioProxy(preview.previews['preview-hq-mp3'] || preview.previews['preview-lq-mp3'] || preview.previews['preview-hq-ogg'] || preview.previews['preview-lq-ogg'])}
                    controls
                    autoPlay
                    preload="auto"
                    onCanPlay={playAudioPreview}
                    onError={() => setAudioPreviewError('Audio preview could not be loaded.')}
                    style={{ width: '100%', maxWidth: '400px' }}
                  />
                  <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#aaa', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <span>Duration: {Number(photoDurs[preview.id] ?? preview.duration ?? 0).toFixed(1)}s</span>
                    <span style={{ color: '#9fc5ff' }}>Sound: Preview</span>
                  </div>
                  {audioPreviewError && (

                    <div style={{ marginTop: '0.5rem', fontSize: '0.72rem', color: '#ff7b7b' }}>
                      {audioPreviewError}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="asset-preview-controls">
              <button className={`asset-preview-add${addedIds.has(preview.id) ? ' added' : ''}`}
                onClick={e => { addToTimeline(preview, e); closePreview(); }}>
                {addedIds.has(preview.id) ? 'Inserted' : 'Insert into Timeline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
