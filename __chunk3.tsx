const x = (<>
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
</>);

