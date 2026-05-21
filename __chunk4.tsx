const x = (
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
                assetUrl = getAssetPreviewUrl(previews['preview-hq-mp3'] || previews['preview-lq-mp3'] || '', 'audio');
              } else if (asset._kind === 'video') {
                assetUrl = getAssetPreviewUrl((asset as any).videos?.small?.url || (asset as any).videos?.medium?.url || '', 'video');
              } else {
                assetUrl = getAssetPreviewUrl((asset as any).previewURL || (asset as any).webformatURL || '', 'photo');
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
                assetKind: asset._kind as 'video' | 'photo',
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
                  const end = start + Number(seg.duration);
                  if (currentTime > start + 0.05 && currentTime < end - 0.05) {
                    const cutOffset = currentTime - start;
                    const sourceCutTime = (seg.sourceStart ?? 0) + cutOffset;
                    const { segments: _segments, ...segBase } = seg;
                    const segment1: TimelineSegment = { ...segBase, id: `${seg.id}-1`, sourceEnd: sourceCutTime, duration: cutOffset };
                    const segment2: TimelineSegment = { ...segBase, id: `${seg.id}-2`, sourceStart: sourceCutTime, duration: Number(seg.duration) - cutOffset };
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
                cumulativeTime += Number(seg.duration);
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
  </>
);
);

