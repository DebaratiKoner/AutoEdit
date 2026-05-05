/**
 * AssetsTab — Pixabay video/photo search + local file attach
 * Videos and photos are proxied through the backend to avoid CORS.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── Backend proxy helpers ────────────────────────────────────────────────────
const PIXABAY_PROXY = '/api/pixabay';
const FREESOUND_PROXY = '/api/freesound';
const imgProxy  = (url: string) => url ? `/api/proxy-image?url=${encodeURIComponent(url)}` : '';
const vidProxy  = (url: string) => url ? `/api/proxy-video?url=${encodeURIComponent(url)}` : '';

// ── Pixabay types ────────────────────────────────────────────────────────────
export type AssetFilter = 'all' | 'video' | 'photo' | 'audio';

export interface PixabayVideoSize {
  url: string; width: number; height: number; size: number; thumbnail: string;
}
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function bestThumb(v: PixabayVideo): string {
  return v.videos?.medium?.thumbnail || v.videos?.small?.thumbnail ||
         v.videos?.tiny?.thumbnail   || v.videos?.large?.thumbnail || '';
}
function bestVideoUrl(v: PixabayVideo): string {
  return v.videos?.small?.url  || v.videos?.medium?.url ||
         v.videos?.tiny?.url   || v.videos?.large?.url  || '';
}

// ── Props ────────────────────────────────────────────────────────────────────
export interface AssetsTabProps {
  onAddToTimeline: (asset: PixabayAsset, photoDuration?: number) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────
const PER_PAGE = 10;
const TOPICS: Record<string, string[]> = {
  all:   ['nature', 'city', 'technology', 'travel', 'food', 'sports', 'music', 'animals'],
  video: ['nature', 'city', 'technology', 'travel', 'food', 'sports', 'music', 'animals', 'education'],
  photo: ['nature', 'architecture', 'people', 'travel', 'food', 'fashion', 'abstract', 'flowers', 'sky'],
  audio: ['music', 'sound effect', 'nature', 'city', 'ambient', 'cinematic', 'beat', 'electronic'],
};
const FALLBACK = 'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 width%3D%22160%22 height%3D%2290%22%3E%3Crect width%3D%22160%22 height%3D%2290%22 fill%3D%22%231a1a2e%22%2F%3E%3Cpolygon points%3D%2260%2C25 100%2C45 60%2C65%22 fill%3D%22%234a90e2%22%2F%3E%3C%2Fsvg%3E';

// ── Component ────────────────────────────────────────────────────────────────
export function AssetsTab({ onAddToTimeline }: AssetsTabProps) {
  const [filter, setFilter]           = useState<AssetFilter>('all');
  const [inputValue, setInputValue]   = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [assets, setAssets]           = useState<PixabayAsset[]>([]);
  const [isLoading, setIsLoading]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [page, setPage]               = useState(1);
  const [totalHits, setTotalHits]     = useState(0);
  const [addedIds, setAddedIds]       = useState<Set<number>>(new Set());
  const [photoDurs, setPhotoDurs]     = useState<Record<number, string>>({});
  const [preview, setPreview]         = useState<(PixabayVideo & { _kind: 'video' }) | null>(null);
  const previewRef                    = useRef<HTMLVideoElement>(null);

  const topics = TOPICS[filter] ?? [];

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchAssets = useCallback(async (
    q: string, f: AssetFilter, pg: number, append = false,
  ) => {
    if (!q.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      let results: PixabayAsset[] = [];
      let hits = 0;

      if (f === 'video' || f === 'all') {
        const p = new URLSearchParams({ type: 'videos', q, per_page: String(PER_PAGE), page: String(pg), safesearch: 'true' });
        const res = await fetch(`${PIXABAY_PROXY}?${p}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
        const data = await res.json();
        hits = data.totalHits ?? 0;
        results = [...results, ...(data.hits ?? []).map((v: PixabayVideo) => ({ ...v, _kind: 'video' as const }))];
      }

      if (f === 'photo' || f === 'all') {
        const p = new URLSearchParams({ type: 'images', q, per_page: String(PER_PAGE), page: String(pg), safesearch: 'true', image_type: 'photo' });
        const res = await fetch(`${PIXABAY_PROXY}?${p}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
        const data = await res.json();
        if (f === 'photo') hits = data.totalHits ?? 0;
        results = [...results, ...(data.hits ?? []).map((p: PixabayPhoto) => ({ ...p, _kind: 'photo' as const }))];
      }

      if (f === 'audio' || f === 'all') {
        const p = new URLSearchParams({ q, page: String(pg), page_size: String(PER_PAGE) });
        const res = await fetch(`${FREESOUND_PROXY}?${p}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
        const data = await res.json();
        if (f === 'audio') hits = data.totalHits ?? 0;
        results = [...results, ...(data.hits ?? []).map((a: FreesoundAudio) => ({ ...a, _kind: 'audio' as const }))];
      }

      setTotalHits(hits);
      setAssets(prev => append ? [...prev, ...results] : results);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (searchQuery.trim()) { setPage(1); fetchAssets(searchQuery, filter, 1); }
    else { setAssets([]); setTotalHits(0); }
  }, [searchQuery, filter, fetchAssets]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const changeFilter = (f: AssetFilter) => {
    setFilter(f); setAssets([]); setSearchQuery(''); setInputValue('');
  };

  const submit = (e: React.FormEvent) => { e.preventDefault(); setSearchQuery(inputValue); };

  const loadMore = () => {
    const next = page + 1; setPage(next);
    fetchAssets(searchQuery, filter, next, true);
  };

  const addToTimeline = (asset: PixabayAsset, e: React.MouseEvent) => {
    e.stopPropagation();
    const dur = asset._kind !== 'video'
      ? Math.max(1, parseFloat(photoDurs[asset.id] || (asset._kind === 'audio' ? String((asset as FreesoundAudio).duration) : '5')) || 5)
      : undefined;
    onAddToTimeline(asset, dur);
    setAddedIds(prev => new Set(prev).add(asset.id));
  };


  const closePreview = () => { setPreview(null); previewRef.current?.pause(); };

// ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="assets-tab">

      {/* ── Status banner ── */}
      {/* ── Search + filters ── */}
      <div className="assets-header">
        <form className="assets-search-form" onSubmit={submit}>
          <div className="assets-search-wrapper">
            <input
              className="assets-search-input"
              placeholder="Search media..."
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
            />
            {inputValue && (
              <button type="button" className="assets-search-clear"
                onClick={() => { setInputValue(''); setSearchQuery(''); }}>×</button>
            )}
            <button
              type="submit"
              className="assets-search-btn"
              title="Search"
              onClick={() => setSearchQuery(inputValue)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
          </div>
        </form>

        <div className="assets-filters">
          <div className="assets-filters-row" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
{[
              { key: 'all',   label: 'All' },
              { key: 'video', label: 'Video' },
              { key: 'audio', label: 'Audio' },
              { key: 'photo', label: 'Photos' },
            ].map(f => (
              <button key={f.key}
                className={`assets-filter-btn${filter === f.key ? ' active' : ''}`}
                onClick={() => changeFilter(f.key as AssetFilter)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {topics.length > 0 && (
          <div className="assets-topics">
            {topics.map(t => (
              <button key={t}
                className={`assets-topic-chip${searchQuery === t ? ' active' : ''}`}
                onClick={() => { setInputValue(t); setSearchQuery(t); }}>
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Results ── */}
      <div className="assets-results">

        {/* Pixabay Results */}
        {isLoading && assets.length === 0 && (
          <div className="assets-loading">
            <div className="assets-spinner"/>
            <span>Searching...</span>
          </div>
        )}

{error && (
          <div className="assets-error" style={{ padding: '1rem', color: '#e74c3c', fontSize: '0.8rem' }}>
            Warning: {error}
          </div>
        )}

        {filter === 'audio' && !isLoading && !error && assets.length === 0 && (
          <div className="assets-empty">
            <p>Search for audio</p>
            <p className="assets-empty-hint">Type a keyword above or tap a topic</p>
          </div>
        )}

        {filter !== 'audio' && !isLoading && !error && assets.length === 0 && (
          <div className="assets-empty">
            <p>Search for {filter === 'photo' ? 'photos' : filter === 'video' ? 'videos' : 'videos & photos'}</p>
            <p className="assets-empty-hint">Type a keyword above or tap a topic</p>
          </div>
        )}

        {assets.length > 0 && (
          <div className="assets-grid">
            {assets.map(asset => {
              const isVid   = asset._kind === 'video';
              const isAudio = asset._kind === 'audio';
              const thumb   = isVid
                ? imgProxy(bestThumb(asset as PixabayVideo))
                : isAudio
                ? imgProxy((asset as FreesoundAudio).images.waveform_m)
                : imgProxy((asset as PixabayPhoto).previewURL || (asset as PixabayPhoto).webformatURL);
              const isAdded = addedIds.has(asset.id);

              return (
                <div key={`${asset._kind}-${asset.id}`} className="asset-card">
                  {/* Thumbnail */}
                  <div className="asset-card-thumb">
                    <img
                      src={thumb || FALLBACK}
                      alt={isAudio ? (asset as FreesoundAudio).name : asset.tags}
                      loading="lazy"
                      onError={e => { (e.target as HTMLImageElement).src = FALLBACK; }}
                    />
                    <div className={`asset-card-badge ${isVid ? 'video' : isAudio ? 'audio' : 'photo'}`}>
                      {isVid ? `${(asset as PixabayVideo).duration}s` : isAudio ? `${(asset as FreesoundAudio).duration}s` : 'Photo'}
                    </div>
                  </div>

                  {/* Info */}
                  <div className="asset-card-info">
                    <p className="asset-card-tags">
                      {isAudio ? (asset as FreesoundAudio).name : asset.tags.split(',').slice(0, 3).join(', ')}
                    </p>

                    {/* Photo/Audio duration input */}
                    {!isVid && (
                      <div className="asset-photo-duration">
                        <label className="asset-photo-duration-label">Duration (s):</label>
                        <input
                          type="number" className="asset-photo-duration-input"
                          min="1" max="300" step="1"
                          value={photoDurs[asset.id] ?? (isAudio ? (asset as FreesoundAudio).duration : '5')}
                          onClick={e => e.stopPropagation()}
                          onChange={e => setPhotoDurs(prev => ({ ...prev, [asset.id]: e.target.value }))}
                        />
                      </div>
                    )}

                    <div className="asset-card-actions">
                      {/* Preview button for videos */}
                      {isVid && (
                        <button className="asset-preview-btn"
                          style={{ fontSize: '0.7rem', padding: '3px 7px' }}
                          onClick={e => { e.stopPropagation(); setPreview(asset as PixabayVideo & { _kind: 'video' }); }}>
                          ▶
                        </button>
                      )}
                      {/* Insert button */}
                      <button
                        className={`asset-add-btn${isAdded ? ' added' : ''}`}
                        style={{ fontSize: '0.7rem', padding: '3px 7px' }}
                        onClick={e => addToTimeline(asset, e)}
                        title="Insert at playhead">
                        {isAdded ? '✓' : '+'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {assets.length > 0 && assets.length < totalHits && (
          <button className="assets-load-more" onClick={loadMore} disabled={isLoading}>
            {isLoading ? 'Loading…' : `Load More (${assets.length} / ${totalHits})`}
          </button>
        )}
      </div>

      {/* ── Video preview modal ── */}
      {preview && (
        <div className="asset-preview-overlay" onClick={closePreview}>
          <div className="asset-preview-panel" onClick={e => e.stopPropagation()}>
            <div className="asset-preview-header">
              <span className="asset-preview-title">{preview.tags.split(',')[0].trim()}</span>
              <button className="asset-preview-close" onClick={closePreview}>×</button>
            </div>
            <div className="asset-preview-video-wrap">
              <video
                ref={previewRef}
                src={vidProxy(bestVideoUrl(preview))}
                className="asset-preview-video"
                controls autoPlay loop
              />
            </div>
            <div className="asset-preview-controls">
              <button
                className={`asset-preview-add${addedIds.has(preview.id) ? ' added' : ''}`}
                onClick={e => { addToTimeline(preview, e); closePreview(); }}>
                {addedIds.has(preview.id) ? '✓ Added to Timeline' : '+ Insert into Timeline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
