# Backend Setup Instructions

## Quick Start

1. **Navigate to backend directory:**
```powershell
cd backend
```

2. **Run setup script:**
```powershell
.\setup.ps1
```

3. **Add your OpenAI API key to `.env`:**
```
OPENAI_API_KEY=sk-your-actual-key-here
```

4. **Start the backend server:**
```powershell
python main.py
```

The backend will be available at: **http://localhost:8000**

---

## Manual Setup (if script fails)

### 1. Install Prerequisites

**Python 3.8+**
- Download from https://www.python.org/downloads/
- Make sure to check "Add Python to PATH" during installation

**FFmpeg**
- Download from https://ffmpeg.org/download.html
- Or install with Chocolatey: `choco install ffmpeg`
- Add to PATH

**OpenAI API Key**
- Get from https://platform.openai.com/api-keys

### 2. Install Python Dependencies

```powershell
cd backend
pip install -r requirements.txt
```

### 3. Configure Environment

Create `.env` file:
```powershell
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:
```
OPENAI_API_KEY=sk-your-actual-key-here
```

### 4. Start the Server

```powershell
python main.py
```

Or with uvicorn:
```powershell
uvicorn main:app --reload --port 8000
```

---

## Testing the Backend

### Check if server is running:
```powershell
curl http://localhost:8000
```

### Test transcription (after uploading a video):
```powershell
curl -X POST http://localhost:8000/api/videos/{session_id}/transcribe
```

---

## Troubleshooting

### "OpenAI API key not configured"
- Make sure you created `.env` file in the `backend/` directory
- Add your API key: `OPENAI_API_KEY=sk-...`
- Restart the backend server

### "FFmpeg not found"
- Install FFmpeg from https://ffmpeg.org/download.html
- Add FFmpeg to your system PATH
- Restart your terminal
- Verify with: `ffmpeg -version`

### "Video file not found"
- The video must be uploaded to the backend first
- Currently, videos are stored in `backend/uploads/`
- For demo purposes, you can manually copy a video file to `backend/uploads/{session_id}.mp4`

### "Connection failed"
- Make sure the backend server is running on port 8000
- Check if another process is using port 8000
- Try accessing http://localhost:8000 in your browser

---

## API Endpoints

### POST /api/videos/upload
Upload a video file and create a session.

**Response:**
```json
{
  "sessionId": "uuid",
  "videoUrl": "/api/videos/{sessionId}/stream",
  "duration": 120.5,
  "resolution": {
    "width": 1920,
    "height": 1080
  }
}
```

### POST /api/videos/{sessionId}/transcribe
Transcribe video audio using OpenAI Whisper API.

**Response:**
```json
{
  "transcript": "Full transcript text...",
  "segments": [
    {
      "start": 0.0,
      "end": 5.2,
      "text": "First segment text"
    }
  ]
}
```

### GET /api/videos/{sessionId}/stream
Stream the uploaded video file.

---

## Notes

- Whisper API supports files up to 25MB
- Audio is extracted as MP3 at 16kHz (Whisper requirement)
- Temporary audio files are automatically cleaned up
- Videos are stored in `backend/uploads/` directory
- Session IDs are UUIDs generated on upload
