# Start Video Editor with Real Whisper API

## Prerequisites
- Python 3.8+
- FFmpeg
- OpenAI API Key
- Node.js (already installed)

## Step 1: Setup Backend

```powershell
# Navigate to backend directory
cd backend

# Run setup script
.\setup.ps1

# Edit .env file and add your OpenAI API key
notepad .env
# Add: OPENAI_API_KEY=sk-your-actual-key-here
```

## Step 2: Start Backend Server

```powershell
# In backend directory
python main.py
```

Backend will run on: **http://localhost:8000**

## Step 3: Start Frontend (in a new terminal)

```powershell
# In project root directory
npm run dev
```

Frontend will run on: **http://localhost:5174** (or 5173)

## Step 4: Test Transcription

1. Open http://localhost:5174 in your browser
2. Upload a video file
3. Go to the Editor page
4. Click on "AI Edit" tab
5. Click "Transcribe Video" button
6. Wait for transcription to complete (may take 10-30 seconds depending on video length)
7. The real transcript from Whisper API will appear!

## Troubleshooting

### Backend won't start
- Check if Python is installed: `python --version`
- Check if FFmpeg is installed: `ffmpeg -version`
- Check if port 8000 is available

### Transcription fails
- Make sure backend is running on http://localhost:8000
- Check if OpenAI API key is set in backend/.env
- Check backend console for error messages
- Verify you have OpenAI API credits

### "Video file not found" error
- Currently, the video needs to be uploaded through the backend API
- For demo, you can manually copy a video to `backend/uploads/{session_id}.mp4`
- Or implement the upload endpoint integration in the frontend

## Current Limitations

1. **Video Upload**: The frontend currently stores videos in IndexedDB (browser storage). To use transcription, you need to:
   - Either manually copy the video to `backend/uploads/{session_id}.mp4`
   - Or integrate the upload endpoint to send videos to the backend

2. **File Size**: Whisper API has a 25MB limit. For larger files, you'll need to implement chunking.

## Next Steps to Fully Integrate

To make the upload flow work end-to-end:

1. Update UploadPage.tsx to upload to backend instead of just IndexedDB
2. Store the session ID returned from backend
3. Use the backend's video URL instead of blob URLs
4. Then transcription will work seamlessly!

For now, you can test transcription by:
1. Uploading a small video (< 25MB)
2. Note the session ID from the URL
3. Manually copy the video to `backend/uploads/{session_id}.mp4`
4. Click "Transcribe Video"
