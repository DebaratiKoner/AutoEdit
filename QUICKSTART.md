# Quick Start Guide

## For Your Mentor Demo

### Step 1: Enable PowerShell Scripts (One-time setup)

Open PowerShell as **Administrator** and run:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Start the Application

```bash
npm run dev
```

### Step 4: Open in Browser

Navigate to: `http://localhost:5173`

## Demo Flow

1. **Upload Page**: Drag and drop a video file (MP4, MOV, or WebM, 720p minimum)
2. **Editor Page**: See the video player, timeline, and editing controls
3. **Try Features**: 
   - Switch between tabs (Clips, AI Edit, Assets)
   - Click Transcribe button
   - Click Export button
   - Click Reset to return to upload

## What to Show Your Mentor

✅ **Professional UI** - Dark theme, clean design
✅ **File Validation** - Try uploading invalid files to see error messages
✅ **Navigation** - Smooth transition from upload to editor
✅ **Video Player** - HTML5 video player with controls
✅ **Timeline** - Visual representation of video segments
✅ **Sidebar Tabs** - Three functional tabs
✅ **Session Persistence** - Refresh the page, session is restored
✅ **Reset Dialog** - Confirmation before clearing session

## If Something Goes Wrong

- **Port in use**: Vite will use next available port
- **Video not loading**: Check internet connection (uses public sample video)
- **npm command fails**: Make sure you ran the PowerShell command in Step 1

That's it! Your demo is ready. 🎉
