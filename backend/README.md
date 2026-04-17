# Video Editor Backend

FastAPI backend for video transcription using OpenAI Whisper API.

## Prerequisites

1. **Python 3.8+**
2. **FFmpeg** - Required for audio extraction
   - Windows: Download from https://ffmpeg.org/download.html
   - Or use: `choco install ffmpeg` (if you have Chocolatey)
3. **OpenAI API Key** - Get from https://platform.openai.com/api-keys

## Setup

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. Install FFmpeg (if not already installed):
   - Download from https://ffmpeg.org/download.html
   - Add to PATH

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Add your OpenAI API key to `.env`:
```
OPENAI_API_KEY=sk-your-actual-key-here
```

## Running the Server

```bash
python main.py
```

Or with uvicorn directly:
```bash
uvicorn main:app --reload --port 8000
```

The API will be available at: http://localhost:8000

## API Endpoints

### POST /api/videos/upload
Upload a video file and create a session.

### POST /api/videos/{session_id}/transcribe
Transcribe video audio using OpenAI Whisper API.

### GET /api/videos/{session_id}/stream
Stream the uploaded video file.

## Testing

Test the transcription endpoint:
```bash
curl -X POST http://localhost:8000/api/videos/{session_id}/transcribe
```

## Notes

- Videos are stored in the `uploads/` directory
- Audio is temporarily extracted as MP3 for transcription
- Whisper API supports files up to 25MB
- For larger files, consider chunking the audio
