# TODO

## Goal: Make export download within ~5 seconds

### Step 1 (Backend)
- Add `POST /api/videos/{session_id}/export-fast` endpoint in `backend/main.py`.
- Implement cached export logic using code from `backend/export_fast_patch.py`.
- Cache exports under `uploads/export_cache/` and return immediately on cache hit.

### Step 2 (Frontend)
- Update `src/components/EditorPage.tsx` `handleExport()` to call `/api/videos/${sessionId}/export-fast`.
- Send the correct ordered `timeline` payload.

### Step 3 (Test)
- Run backend + frontend.
- Export twice for the same timeline:
  - 1st run: may take longer (cache miss)
  - 2nd run: must download quickly (cache hit)

