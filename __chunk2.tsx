function test() {
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
}

