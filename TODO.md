# Autoedit AI TODO

- [x] Inspect how video preview works (player/composition) and how audio preview is currently implemented.
- [x] Identify mismatch preventing audio preview from behaving like video preview.
- [ ] Implement fix in `src/components/AssetsTab.tsx` (audio preview play/stop syncing to preview duration, autoplay policy handling).
- [ ] Add minimal guards to ensure audio preview resets correctly on preview change.
- [ ] Test: open Assets modal → preview audio → verify it plays with sound, stops at chosen duration, and resets on reopen.

- [ ] Chapter name generation + clip rename handling for AI operations ("Done" messaging).
  - [ ] Fix backend edit-with-ai naming enforcement so "name_clips" results persist.
  - [ ] Ensure frontend preserves `timeline[].name` from AI and does not overwrite with placeholders.
  - [ ] Ensure chapter names use `name_clips` action and propagate into exported titles.
  - [ ] Add minimal tests / run manual check: rename clips + generate chapter names.

