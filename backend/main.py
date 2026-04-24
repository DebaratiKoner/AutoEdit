"""
FastAPI Backend for Video Editor
Provides endpoints for video upload, transcription, and export
"""

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
import openai
import os
from pathlib import Path
import uuid
import tempfile
from typing import Optional
from pydantic import BaseModel
import subprocess
import httpx
from dotenv import load_dotenv

# Load .env file from the backend directory
load_dotenv(dotenv_path=Path(__file__).parent / ".env")

app = FastAPI(title="Video Editor API")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# OpenAI API key from environment
openai.api_key = os.getenv("OPENAI_API_KEY")

class TranscriptionResponse(BaseModel):
    transcript: str
    segments: Optional[list] = None

@app.get("/")
async def root():
    return {"message": "Video Editor API", "status": "running"}

@app.post("/api/videos/{session_id}/transcribe")
async def transcribe_video(session_id: str):
    """
    Transcribe video audio using OpenAI Whisper API
    """
    try:
        # Check if OpenAI API key is configured
        if not openai.api_key:
            raise HTTPException(
                status_code=500,
                detail="OpenAI API key not configured. Set OPENAI_API_KEY environment variable."
            )
        
        # Find the video file for this session
        video_path = UPLOAD_DIR / f"{session_id}.mp4"
        if not video_path.exists():
            # Try other formats
            for ext in [".mov", ".webm", ".avi"]:
                alt_path = UPLOAD_DIR / f"{session_id}{ext}"
                if alt_path.exists():
                    video_path = alt_path
                    break
        
        if not video_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Video file not found for session {session_id}"
            )
        
        # Extract audio from video using ffmpeg
        audio_path = UPLOAD_DIR / f"{session_id}_audio.mp3"
        
        # Use ffmpeg to extract audio
        subprocess.run([
            "ffmpeg", "-i", str(video_path),
            "-vn",  # No video
            "-acodec", "libmp3lame",  # MP3 codec
            "-ar", "16000",  # 16kHz sample rate (Whisper requirement)
            "-ac", "1",  # Mono
            "-y",  # Overwrite output file
            str(audio_path)
        ], check=True, capture_output=True)
        
        # Transcribe using OpenAI Whisper API
        with open(audio_path, "rb") as audio_file:
            transcript_response = openai.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                response_format="verbose_json"
            )
        
        # Clean up audio file
        audio_path.unlink()
        
        # Extract transcript and segments
        transcript_text = transcript_response.text
        segments = []
        
        if hasattr(transcript_response, 'segments'):
            segments = [
                {
                    "start": seg.get("start", 0),
                    "end": seg.get("end", 0),
                    "text": seg.get("text", "")
                }
                for seg in transcript_response.segments
            ]
        
        return JSONResponse({
            "transcript": transcript_text,
            "segments": segments
        })
        
    except subprocess.CalledProcessError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract audio from video: {e.stderr.decode()}"
        )
    except openai.OpenAIError as e:
        raise HTTPException(
            status_code=500,
            detail=f"OpenAI API error: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )

@app.post("/api/videos/upload")
async def upload_video(file: UploadFile = File(...)):
    """
    Upload a video file and create a session
    """
    try:
        # Generate session ID
        session_id = str(uuid.uuid4())
        
        # Get file extension
        file_ext = Path(file.filename).suffix
        
        # Save uploaded file
        file_path = UPLOAD_DIR / f"{session_id}{file_ext}"
        
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)
        
        # Get video metadata using ffprobe
        result = subprocess.run([
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration",
            "-of", "json",
            str(file_path)
        ], capture_output=True, text=True, check=True)
        
        import json
        metadata = json.loads(result.stdout)
        stream = metadata["streams"][0]
        
        return JSONResponse({
            "sessionId": session_id,
            "videoUrl": f"/api/videos/{session_id}/stream",
            "duration": float(stream.get("duration", 0)),
            "resolution": {
                "width": stream.get("width", 0),
                "height": stream.get("height", 0)
            }
        })
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Upload failed: {str(e)}"
        )

@app.get("/api/videos/{session_id}/stream")
async def stream_video(session_id: str):
    """
    Stream video file
    """
    # Find the video file
    for ext in [".mp4", ".mov", ".webm", ".avi"]:
        video_path = UPLOAD_DIR / f"{session_id}{ext}"
        if video_path.exists():
            return FileResponse(video_path)
    
    raise HTTPException(status_code=404, detail="Video not found")

@app.get("/api/pixabay")
async def pixabay_proxy(
    type: str = Query("videos", description="'videos' or 'images'"),
    q: str = Query("", description="Search query"),
    per_page: int = Query(10, ge=3, le=200),
    page: int = Query(1, ge=1),
    safesearch: bool = Query(True),
    image_type: Optional[str] = Query(None),
):
    """
    Proxy endpoint for Pixabay API.
    Reads PIXABAY_API_KEY from environment so the key is never exposed to the frontend.
    """
    api_key = os.getenv("PIXABAY_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="PIXABAY_API_KEY not configured. Set it in backend/.env"
        )

    if type == "videos":
        url = "https://pixabay.com/api/videos/"
    else:
        url = "https://pixabay.com/api/"

    params: dict = {
        "key": api_key,
        "q": q,
        "per_page": per_page,
        "page": page,
        "safesearch": "true" if safesearch else "false",
    }
    if image_type:
        params["image_type"] = image_type

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            return JSONResponse(content=response.json())
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Pixabay API error: {e.response.text}"
        )
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach Pixabay: {str(e)}"
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
