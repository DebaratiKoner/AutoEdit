# AutoEdit Video Editor - Demo Instructions

## Overview

This is a web-based video editor with two main pages:
1. **Upload Page** - Drag-and-drop video upload with validation
2. **Editor Page** - Video editing interface with timeline and controls

## Setup Instructions

### 1. Install Dependencies

First, you need to enable script execution in PowerShell (run PowerShell as Administrator):

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Then install dependencies:

```bash
npm install
```

### 2. Start Development Server

```bash
npm run dev
```

The application will open at `http://localhost:5173`

## Features Implemented

### Upload Page (`/`)
- ✅ Dark-themed interface with "AI Video Editor" branding
- ✅ Drag-and-drop zone for video files
- ✅ Click to browse file selection
- ✅ Visual feedback on drag-over
- ✅ File format validation (MP4, MOV, WebM)
- ✅ Resolution validation (minimum 720p)
- ✅ Error messages with specific validation failures
- ✅ Automatic navigation to Editor Page on successful upload

### Editor Page (`/editor/:sessionId`)
- ✅ Session ID display in header
- ✅ Video player with HTML5 controls
- ✅ Timeline visualization showing video segments
- ✅ Editing controls (Cut, Delete, Undo, Redo buttons)
- ✅ Export button (green) in header
- ✅ Reset button with confirmation dialog
- ✅ Sidebar with three tabs: Clips, AI Edit, Assets
- ✅ Transcribe button in AI Edit tab
- ✅ Session persistence using IndexedDB/localStorage
- ✅ Mock video loaded for demo (Big Buck Bunny sample)

## Demo Flow

### 1. Upload a Video

1. Open the application at `http://localhost:5173`
2. You'll see the Upload Page with a drag-and-drop zone
3. Either:
   - Drag a video file (MP4, MOV, or WebM) onto the drop zone
   - Click the drop zone to browse and select a file
4. The file will be validated:
   - Format must be MP4, MOV, or WebM
   - Resolution must be at least 720p
5. If validation passes, you'll be redirected to the Editor Page

### 2. Editor Page

1. After upload, you'll see the Editor Page with:
   - Session ID in the header
   - Video player showing a sample video (Big Buck Bunny)
   - Timeline at the bottom showing video segments
   - Editing controls (Cut, Delete, Undo, Redo)
   - Sidebar with tabs (Clips, AI Edit, Assets)

2. Try the features:
   - **Play/Pause**: Use the video player controls
   - **Timeline**: See the video segment visualization
   - **Tabs**: Switch between Clips, AI Edit, and Assets tabs
   - **Transcribe**: Click the "Transcribe Video" button in AI Edit tab
   - **Export**: Click the green Export button (shows alert for now)
   - **Reset**: Click Reset button to see confirmation dialog

### 3. Session Persistence

1. Make some changes in the editor
2. Refresh the page
3. The session will be restored from browser storage

## Technical Stack

- **Frontend**: React 18 + TypeScript
- **Routing**: React Router v6
- **Build Tool**: Vite
- **Testing**: Vitest + React Testing Library + fast-check
- **Storage**: IndexedDB (primary) with localStorage fallback
- **Styling**: CSS with dark theme

## Project Structure

```
src/
├── components/          # UI components
│   ├── UploadPage.tsx   # Upload page component
│   ├── UploadPage.css   # Upload page styles
│   ├── EditorPage.tsx   # Editor page component
│   └── EditorPage.css   # Editor page styles
├── services/            # Business logic
│   ├── FileValidator.ts # File validation service
│   ├── APIClient.ts     # HTTP client for backend
│   └── SessionManager.ts # Browser storage manager
├── types/               # TypeScript definitions
│   └── index.ts         # Core data models
├── utils/               # Utility functions
│   └── timeFormat.ts    # Time formatting utilities
├── App.tsx              # Main app with routing
└── main.tsx             # React entry point
```

## What's Working

✅ **Upload Page**:
- Drag-and-drop file upload
- File format validation (MP4, MOV, WebM)
- Resolution validation (720p minimum)
- Error messages
- Navigation to editor

✅ **Editor Page**:
- Video player with sample video
- Timeline visualization
- Editing controls UI
- Sidebar with tabs
- Session management
- Reset functionality
- Export button

## What's Not Yet Implemented

⚠️ **Backend Integration**:
- Actual video upload to server
- Transcription service
- Export rendering
- Video processing

⚠️ **Advanced Features**:
- Cut/Delete operations
- Undo/Redo functionality
- Timeline editing
- FFmpeg.wasm integration

## Notes for Mentor

This demo shows the **frontend UI and user flow** for the video editor. The core pages are functional with:

1. **Professional UI**: Dark theme, clean design, responsive layout
2. **File Validation**: Client-side validation for format and resolution
3. **Navigation**: Smooth routing between upload and editor pages
4. **Session Management**: Browser storage for persistence
5. **Component Architecture**: Well-structured React components with TypeScript

The backend API integration and advanced editing features are planned for the next phase of development.

## Troubleshooting

### PowerShell Script Execution Error

If you see "running scripts is disabled", run PowerShell as Administrator and execute:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Port Already in Use

If port 5173 is in use, Vite will automatically try the next available port.

### Video Not Loading

The demo uses a public sample video (Big Buck Bunny). If it doesn't load, check your internet connection.

## Contact

For questions or issues, please contact the development team.
