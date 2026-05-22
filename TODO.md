# TODO

## Phase 1 — Quick transcription (<20s)
- [ ] Update backend `POST /api/videos/{session_id}/transcribe` to accept request body `{ quick?: boolean, max_seconds?: number, chunk_seconds?: number, max_chunks?: number }`.
- [ ] Implement `quick=true` mode using smaller chunks (default 10s) and early-stop after collecting transcript coverage for `max_seconds` (default 20s).
- [ ] Ensure endpoint remains backward compatible when called with no body.
- [ ] Update frontend `handleTranscribe` to send `{ quick: true, max_seconds: 20 }` by default.
- [ ] Keep existing full transcription behavior when user explicitly triggers full mode (if needed, wire a separate flag or keep a fallback).

## Phase 2 — Validate
- [ ] Run backend lint/typecheck if available.
- [ ] Smoke test: upload small video and click Transcribe; verify response arrives in <20s in quick mode.

