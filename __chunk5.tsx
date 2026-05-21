const x = (
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
            <div className="export-menu">
              <button
                className="btn btn-primary"
                onClick={() => setShowExportMenu(open => !open)}
                disabled={isExporting !== null}
                aria-haspopup="menu"
                aria-expanded={showExportMenu}
              >
                {isExporting ? 'Exporting...' : 'Export'}
                <span className="export-menu-caret">v</span>
              </button>
              {showExportMenu && (
                <div className="export-dropdown" role="menu">
                  <button type="button" role="menuitem" onClick={() => handleExport('whole')}>
                    Whole video
                  </button>
                  <button type="button" role="menuitem" onClick={() => handleExport('clips')}>
                    Clips format
                  </button>
                </div>
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
                      const isActive = currentTime >= (clip.timelineStart ?? 0) && currentTime < (clip.timelineStart ?? 0) + clip.duration;
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
                        const isActive = currentTime >= (clip.timelineStart ?? 0) && currentTime < (clip.timelineStart ?? 0) + clip.duration;
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
                        void jumpToTimelineTime(clickTime);
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
                              const clipPx = Math.max(TIMELINE_MIN_CLIP_PX, segment.duration * TIMELINE_MIN_PX_PER_SEC);
                              
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
                              const widthPx = Math.max(4, (Math.max(segment.duration || 0, 0) / Math.max(totalDur, 1)) * totalPx);
                              const topPx = 36 + (audioIndex * (audioRowHeight + audioGap));

                              const vol = segment.volume ?? 1;
                              const isActive = currentTime >= (segment.timelineStart ?? 0) && currentTime < (segment.timelineStart ?? 0) + segment.duration;
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
                                        {formatTime(segment.timelineStart ?? 0)} - {formatTime((segment.timelineStart ?? 0) + segment.duration)} ({segment.duration.toFixed(1)}s)
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
              {session.timeline.length === 0 ? (
                <div style={{ color: '#666', textAlign: 'center', padding: '2rem 1rem' }}>
                  No items yet. Add from Assets tab.
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
                <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: clip.color || getClipColor(clip.order), flexShrink: 0 }} />
                        {/* Info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.82rem', lineHeight: 1.35, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                            {clip.name || `${clip.assetKind ? clip.assetKind.charAt(0).toUpperCase() + clip.assetKind.slice(1) : 'Clip'} ${clip.order + 1}`}
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
);

