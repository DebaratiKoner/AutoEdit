# TODO - Export timeline + chapters + assets

- [ ] Add backend endpoint that exports:
  - [ ] main edited timeline mp4
  - [ ] one mp4 per chapter/clip (based on track-0 segments)
  - [ ] chapters metadata JSON (based on transcriptSegments / clip names)
  - [ ] packaging as a single downloadable ZIP so browser can trigger instant download of local artifacts.
- [ ] Implement asset fetching/resolution in backend export so clips include:
  - [ ] original local session video
  - [ ] local uploaded assets from /api/assets/{id}/stream
  - [ ] external asset URLs (download to local temp files before ffmpeg)
- [ ] Update frontend `EditorPage.tsx` export button:
  - [ ] call new endpoint
  - [ ] trigger download of ZIP (instant once backend finishes export)
- [ ] Sanity check file naming, durations, and that chapter clips match timeline order.
- [ ] Smoke test export end-to-end.

