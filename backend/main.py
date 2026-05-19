"""
FastAPI Backend for Video Editor
Provides endpoints for video upload, transcription, and exportop
"""

import os
import sys
# Force UTF-8 output on Windows to avoid emoji encoding errors
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
from dotenv import load_dotenv

# Load .env file from the backend directory FIRST before anything else
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env'))
if not os.getenv("OPENAI_API_KEY"):
    print("[INFO] API Key not found")
else:
    print("[INFO] API Key loaded")

from fastapi import FastAPI, File, UploadFile, HTTPException, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse
from openai import OpenAI
from pathlib import Path
import uuid
import tempfile
from typing import Optional
from pydantic import BaseModel
import subprocess
import mimetypes
from datetime import datetime
import socket

app = FastAPI(title="Video Editor API")

# Register routers AFTER app is created
from routes.pixabay import router as pixabay_router
from routes.freesound import router as freesound_router
app.include_router(pixabay_router)
app.include_router(freesound_router)

# Global fallback — ensures no unhandled exception leaks a raw 500 without a message
from fastapi import Request
from fastapi.responses import JSONResponse as _JSONResponse
from fastapi.exceptions import RequestValidationError

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    print(f"[validation] Validation error on {request.method} {request.url.path}")
    print(f"[validation] Errors: {exc.errors()}")
    return _JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"[global] Unhandled exception on {request.method} {request.url.path}: {exc}")
    import traceback
    traceback.print_exc()
    return _JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {str(exc)}"},
    )

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:3000", "http://127.0.0.1:5173", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)
os.makedirs("uploads", exist_ok=True)  # ensure exists via os as well

# Session → file path mapping — persisted to disk so server restarts don't lose it
SESSION_STORE_PATH = Path("uploads/.sessions.json")

def _load_session_store() -> dict:
    if SESSION_STORE_PATH.exists():
        try:
            import json
            return json.loads(SESSION_STORE_PATH.read_text())
        except Exception:
            return {}
    return {}

def _save_session_store(store: dict) -> None:
    import json
    SESSION_STORE_PATH.write_text(json.dumps(store))

session_store: dict[str, str] = _load_session_store()

# OpenAI client
client = OpenAI()

class GenerateClipsRequest(BaseModel):
    segments: list

class EditWithAIRequest(BaseModel):
    prompt: str
    segments: list

class PlanEditRequest(BaseModel):
    instruction: str
    clips: list  # [{id, start, end, label?}]
    transcript: list = []  # Optional transcript segments

class TranscribeRequest(BaseModel):
    clips: Optional[list] = None
    quick: Optional[bool] = False

# --- ADD THIS AFTER LINE 217 ---

def _ensure_clip_ids(clips: list) -> list:
    """Ensures every clip has a unique, stable ID for tracking."""
    for i, clip in enumerate(clips):
        if 'id' not in clip:
            clip['id'] = str(uuid.uuid4())[:8]
    return clips

def _apply_advanced_operations(clips: list, actions: list) -> list:
    """Logic to handle 'swap' and 'split' operations."""
    new_clips = [dict(c) for c in clips]
    
    for action in actions:
        atype = action.get("type")
        
        # 1. SWAP: Change the position of two clips in the timeline
        if atype == "swap":
            idx = action.get("clip_indexes", [])
            if len(idx) == 2:
                # Convert AI's 1-based index to Python's 0-based index
                i1, i2 = idx[0] - 1, idx[1] - 1
                if 0 <= i1 < len(new_clips) and 0 <= i2 < len(new_clips):
                    new_clips[i1], new_clips[i2] = new_clips[i2], new_clips[i1]

        # 2. SPLIT: Divide one clip into two parts at a specific second
        elif atype == "split":
            idx = action.get("clip_index", 0) - 1
            split_at = action.get("split_time")
            if 0 <= idx < len(new_clips) and split_at:
                target = new_clips[idx]
                if target['start'] < split_at < target['end']:
                    # Create the first half
                    c1 = target.copy()
                    c1['end'] = split_at
                    c1['id'] = str(uuid.uuid4())[:8]
                    
                    # Create the second half
                    c2 = target.copy()
                    c2['start'] = split_at
                    c2['id'] = str(uuid.uuid4())[:8]
                    
                    # Replace the old clip with the two new halves
                    new_clips[idx:idx+1] = [c1, c2]

    return new_clips
@app.get("/")
async def root():
    return {"message": "Video Editor API", "status": "running"}


class GenerateImageRequest(BaseModel):
    prompt: str

@app.post("/api/generate-image")
async def generate_image(body: GenerateImageRequest):
    """Generate an image using DALL-E 3 from a text prompt, then cache it locally."""
    if not body.prompt or not body.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    if not client.api_key:
        raise HTTPException(status_code=500, detail="OpenAI API key not configured")
    try:
        response = client.images.generate(
            model="dall-e-3",
            prompt=body.prompt.strip(),
            size="1024x1024",
            quality="standard",
            n=1,
        )
        dalle_url = response.data[0].url

        # Download and cache the image locally so it doesn't expire
        import httpx, uuid as _uuid
        img_id = str(_uuid.uuid4())[:8]
        img_path = UPLOAD_DIR / f"ai_img_{img_id}.jpg"
        async with httpx.AsyncClient(timeout=30.0) as hc:
            img_resp = await hc.get(dalle_url)
            img_resp.raise_for_status()
            img_path.write_bytes(img_resp.content)

        # Return a local API URL that won't expire
        local_url = f"/api/assets/ai-image/{img_id}"
        return JSONResponse({"url": local_url, "prompt": body.prompt.strip()})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image generation failed: {str(e)}")


@app.get("/api/assets/ai-image/{img_id}")
async def serve_ai_image(img_id: str):
    """Serve a cached AI-generated image."""
    img_path = UPLOAD_DIR / f"ai_img_{img_id}.jpg"
    if not img_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(str(img_path), media_type="image/jpeg")

@app.get("/test-export")
async def test_export_info():
    """
    Test endpoint to verify export endpoint configuration.
    Returns information about available export endpoints.
    """
    return {
        "message": "Export endpoint test",
        "available_endpoints": {
            "new_remotion_export": {
                "path": "POST /api/videos/{session_id}/export-with-clips",
                "description": "Uses Remotion for rendering with FFmpeg fallback",
                "body": {
                    "clips": [{"start": 0, "end": 10, "title": "Clip 1"}],
                    "options": {"fps": 30, "width": 1920, "height": 1080}
                }
            },
            "legacy_ffmpeg_export": {
                "path": "POST /api/videos/{session_id}/export",
                "description": "Legacy FFmpeg-only export (deprecated)",
                "body": {
                    "clips": [{"start": 0, "end": 10}]
                }
            }
        },
        "recommendation": "Use /export-with-clips for new implementations"
    }

@app.get("/api/test/connection")
async def test_connection():
    """Test internet connectivity and OpenAI API access"""
    import socket
    import requests
    
    results = {
        "internet": False,
        "dns": False,
        "openai_api": False,
        "api_key_configured": bool(client.api_key),
        "errors": []
    }
    
    try:
        # Test basic internet connectivity
        socket.create_connection(("8.8.8.8", 53), timeout=5)
        results["internet"] = True
        print("[test] Internet connectivity: OK")
    except Exception as e:
        results["errors"].append(f"Internet connectivity failed: {str(e)}")
        print(f"[test] Internet connectivity failed: {e}")
    
    try:
        # Test DNS resolution for OpenAI
        socket.gethostbyname("api.openai.com")
        results["dns"] = True
        print("[test] DNS resolution: OK")
    except Exception as e:
        results["errors"].append(f"DNS resolution failed: {str(e)}")
        print(f"[test] DNS resolution failed: {e}")
    
    if client.api_key:
        try:
            # Test OpenAI API access with a simple request
            models = client.models.list()
            results["openai_api"] = True
            print("[test] OpenAI API access: OK")
        except Exception as e:
            results["errors"].append(f"OpenAI API access failed: {str(e)}")
            print(f"[test] OpenAI API access failed: {e}")
    else:
        results["errors"].append("OpenAI API key not configured")
    
    return JSONResponse(results)

@app.post("/api/videos/{session_id}/transcribe")
async def transcribe_video(session_id: str, request_body: Optional[TranscribeRequest] = None):
    """
    Transcribe video audio using OpenAI Whisper API.
    Supports extracting audio directly from the assembled timeline if clips are provided.
    """
    print(f"[transcribe] Starting transcription for session_id={session_id}")
    
    # Check if OpenAI API key is configured
    if not client.api_key:
        raise HTTPException(
            status_code=500,
            detail="OpenAI API key not configured. Set OPENAI_API_KEY environment variable."
        )
    
    clips = request_body.clips if request_body else None
    
    try:
        import tempfile, shutil
        import concurrent.futures
        
        temp_transcribe_dir = Path(tempfile.mkdtemp(prefix=f"transcribe_{session_id}_"))
        
        if clips:
            print(f"[transcribe] Extracting audio for {len(clips)} timeline clips...")
            temp_dir = temp_transcribe_dir / "extraction"
            temp_dir.mkdir()
            valid_clips = []
            
            for i, clip in enumerate(clips):
                asset_url = clip.get("assetUrl")
                src_start = float(clip.get("start", 0))
                src_end = float(clip.get("end", 0))
                duration = src_end - src_start
                if duration <= 0:
                    continue
                
                src_file = None
                
                if asset_url:
                    if asset_url.startswith("/api/"):
                        if "assets" in asset_url and "stream" in asset_url:
                            asset_id = asset_url.split("/")[-2]
                            for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv", ".jpg", ".jpeg", ".png", ".webp"]:
                                candidate = UPLOAD_DIR / f"asset_{asset_id}{ext}"
                                if candidate.exists():
                                    src_file = candidate
                                    break
                else:
                    if session_id in session_store:
                        stored = Path(session_store[session_id])
                        if stored.exists():
                            src_file = stored
                    if not src_file:
                        for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
                            candidate = UPLOAD_DIR / f"{session_id}{ext}"
                            if candidate.exists():
                                src_file = candidate
                                break
                
                chunk_path = temp_dir / f"chunk_{i}.pcm"
                is_image = False
                if src_file and src_file.exists():
                    is_image = src_file.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp", ".gif"]
                else:
                    is_image = True # Fallback to silence if missing
                    
                if is_image:
                    cmd = [
                        "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                        "-t", str(duration), "-f", "s16le", "-acodec", "pcm_s16le",
                        str(chunk_path)
                    ]
                else:
                    cmd = [
                        "ffmpeg", "-y", "-ss", str(src_start), "-t", str(duration),
                        "-i", str(src_file), "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "16000",
                        "-ac", "1", str(chunk_path)
                    ]
                
                subprocess.run(cmd, capture_output=True, check=False)
                
                if not chunk_path.exists() or chunk_path.stat().st_size == 0:
                    cmd = [
                        "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                        "-t", str(duration), "-f", "s16le", "-acodec", "pcm_s16le",
                        str(chunk_path)
                    ]
                    subprocess.run(cmd, capture_output=True, check=True)
                    
                if chunk_path.exists():
                    valid_clips.append(chunk_path)
            
            if valid_clips:
                concat_pcm = temp_dir / "concat.pcm"
                with open(concat_pcm, "wb") as outfile:
                    for chunk in valid_clips:
                        with open(chunk, "rb") as infile:
                            outfile.write(infile.read())

                subprocess.run([
                    "ffmpeg", "-y", "-f", "s16le", "-ar", "16000", "-ac", "1",
                    "-i", str(concat_pcm),
                    "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", "120",
                    str(temp_transcribe_dir / "out_%03d.wav")
                ], capture_output=True, check=True)
                print(f"[transcribe] Audio segmented successfully from timeline clips")
            else:
                raise Exception("No valid audio clips could be generated")
            
        else:
            video_path = None
            if session_id in session_store:
                stored = Path(session_store[session_id])
                if stored.exists():
                    video_path = stored
            
            if video_path is None:
                for fname in os.listdir(str(UPLOAD_DIR)):
                    if fname.startswith(session_id) and not fname.endswith("_audio.mp3") and not fname.endswith("_export.mp4"):
                        video_path = UPLOAD_DIR / fname
                        break
            
            if video_path is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Video file not found for session {session_id}"
                )
            
            print(f"[transcribe] Found video: {video_path}")
            print(f"[transcribe] Extracting and segmenting audio...")
            
            result = subprocess.run([
                "ffmpeg", "-y",
                "-i", str(video_path),
                "-vn", 
                "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1",
                "-f", "segment", "-segment_time", "120",
                str(temp_transcribe_dir / "out_%03d.wav")
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"[transcribe] ffmpeg error: {result.stderr[-500:]}")
                raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
            
            print(f"[transcribe] Audio extracted and segmented successfully")
            
        # Parallel Transcription step
        chunk_files = sorted(list(temp_transcribe_dir.glob("out_*.wav")))
        if not chunk_files:
            raise Exception("No audio chunks were generated by FFmpeg.")
            
        print(f"[transcribe] Calling Whisper API in parallel for {len(chunk_files)} chunks...")
        
        def _transcribe_chunk(cf, offset_time):
            with open(cf, "rb") as af:
                resp = client.audio.transcriptions.create(
                    model="whisper-1",
                    file=af,
                    response_format="verbose_json",
                    language="en"
                )
            
            segs = []
            if hasattr(resp, 'segments') and resp.segments:
                for seg in resp.segments:
                    if isinstance(seg, dict):
                        segs.append({
                            "start": round(float(seg["start"]) + offset_time, 2),
                            "end": round(float(seg["end"]) + offset_time, 2),
                            "text": seg["text"].strip()
                        })
                    else:
                        segs.append({
                            "start": round(float(seg.start) + offset_time, 2),
                            "end": round(float(seg.end) + offset_time, 2),
                            "text": seg.text.strip()
                        })
            t_text = resp.text if hasattr(resp, 'text') else ""
            return t_text, segs

        transcript = ""
        segments = []
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = []
            for i, cf in enumerate(chunk_files):
                offset = i * 120.0
                futures.append(executor.submit(_transcribe_chunk, cf, offset))
            
            for future in futures:
                t_text, t_segs = future.result()
                transcript += t_text + " "
                segments.extend(t_segs)
        
        transcript = transcript.strip()
        print(f"[transcribe] Transcription complete")
        
        return JSONResponse({
            "transcript": transcript,
            "segments": segments
        })
        
    except FileNotFoundError as e:
        if "ffmpeg" in str(e):
            raise HTTPException(
                status_code=500,
                detail="ffmpeg not found. Please install ffmpeg and ensure it is on your PATH."
            )
        raise e
    except subprocess.CalledProcessError as e:
        error_output = e.stderr if isinstance(e.stderr, str) else str(e)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract audio: {error_output}"
        )
    except Exception as e:
        error_message = str(e)
        print(f"[transcribe] Error: {error_message}")
        if "Connection error" in error_message or "getaddrinfo failed" in error_message:
            raise HTTPException(status_code=503, detail="Unable to connect to OpenAI API.")
        elif "API key" in error_message or "authentication" in error_message.lower():
            raise HTTPException(status_code=401, detail="OpenAI API authentication failed.")
        else:
            raise HTTPException(status_code=500, detail=f"Transcription failed: {error_message}")
            
    finally:
        if 'temp_transcribe_dir' in locals() and temp_transcribe_dir.exists():
            shutil.rmtree(temp_transcribe_dir, ignore_errors=True)

@app.post("/api/videos/upload")
async def upload_video(file: UploadFile = File(...), session_id: Optional[str] = None):
    """
    Upload a video file and create a session.
    Validates type, size, and saves safely.
    """
    import json

    # --- Step 1: Validate file is present ---
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="No file provided.")

    print(f"[upload] Uploading: {file.filename}")

    # --- Step 2: Validate file type ---
    ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm", ".avi", ".mkv"}
    raw_ext = os.path.splitext(file.filename)[1]
    file_ext = raw_ext.lower() if raw_ext else ""

    if file_ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{file_ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    # --- Step 3: Read content and enforce size limit (200 MB) ---
    MAX_SIZE_BYTES = 200 * 1024 * 1024  # 200 MB
    try:
        content = await file.read()
    except Exception as e:
        print(f"[upload] Failed to read file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to read uploaded file: {str(e)}")

    if len(content) > MAX_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large ({len(content) // (1024*1024)} MB). Maximum allowed size is 200 MB."
        )

    # --- Step 4: Ensure uploads folder exists ---
    os.makedirs("uploads", exist_ok=True)

    # --- Step 5: Generate session ID and build file path ---
    if not session_id:
        session_id = str(uuid.uuid4())

    file_path = UPLOAD_DIR / f"{session_id}{file_ext}"
    print(f"[upload] Saving to: {file_path}")

    # --- Step 6: Save file safely ---
    try:
        with open(file_path, "wb") as f:
            f.write(content)
    except Exception as e:
        print(f"[upload] Failed to save file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")

    # --- Step 7: Persist session → file path mapping (survives restarts) ---
    session_store[session_id] = str(file_path)
    _save_session_store(session_store)
    print(f"[upload] session_id={session_id} → file_path={file_path}")

    # --- Step 8: Extract metadata via ffprobe (non-fatal) ---
    duration = 0.0
    width = 0
    height = 0
    try:
        result = subprocess.run([
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration",
            "-of", "json",
            str(file_path)
        ], capture_output=True, text=True, check=True)
        metadata = json.loads(result.stdout)
        stream = metadata.get("streams", [{}])[0]
        duration = float(stream.get("duration", 0))
        width = stream.get("width", 0)
        height = stream.get("height", 0)
    except (FileNotFoundError, subprocess.CalledProcessError, KeyError, IndexError) as e:
        print(f"[upload] ffprobe unavailable or failed, using defaults: {e}")

    return JSONResponse({
        "sessionId": session_id,
        "message": "Upload successful",
        "videoUrl": f"/api/videos/{session_id}/stream",
        "duration": duration,
        "resolution": {
            "width": width,
            "height": height
        }
    })

@app.post("/api/assets/upload")
async def upload_asset(file: UploadFile = File(...)):
    """
    Upload an asset file (video or image) for use in editing.
    """
    # --- Step 1: Validate file is present ---
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="No file provided.")

    print(f"[asset-upload] Uploading: {file.filename}")

    # --- Step 2: Validate file type ---
    ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".avi", ".mkv"}
    ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
    ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
    ALLOWED_EXTENSIONS = ALLOWED_VIDEO_EXTENSIONS | ALLOWED_IMAGE_EXTENSIONS | ALLOWED_AUDIO_EXTENSIONS
    
    raw_ext = os.path.splitext(file.filename)[1]
    file_ext = raw_ext.lower() if raw_ext else ""

    if file_ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{file_ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    # --- Step 3: Read content and enforce size limit (50 MB for assets) ---
    MAX_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
    try:
        content = await file.read()
    except Exception as e:
        print(f"[asset-upload] Failed to read file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to read uploaded file: {str(e)}")

    if len(content) > MAX_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large ({len(content) // (1024*1024)} MB). Maximum allowed size is 50 MB."
        )

    # --- Step 4: Ensure uploads folder exists ---
    os.makedirs("uploads", exist_ok=True)

    # --- Step 5: Generate asset ID and build file path ---
    asset_id = str(uuid.uuid4())
    file_path = UPLOAD_DIR / f"asset_{asset_id}{file_ext}"
    print(f"[asset-upload] Saving to: {file_path}")

    # --- Step 6: Save file safely ---
    try:
        with open(file_path, "wb") as f:
            f.write(content)
    except Exception as e:
        print(f"[asset-upload] Failed to save file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")

    # --- Step 7: Determine asset type and URL ---
    is_video = file_ext in ALLOWED_VIDEO_EXTENSIONS
    is_audio = file_ext in ALLOWED_AUDIO_EXTENSIONS
    asset_type = "audio" if is_audio else ("video" if is_video else "photo")
    asset_url = f"/api/assets/{asset_id}/stream"

    # --- Step 8: Extract metadata if video/audio ---
    duration = 0.0
    width = 0
    height = 0
    if is_video or is_audio:
        try:
            import json
            if is_audio:
                result = subprocess.run([
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "json",
                    str(file_path)
                ], capture_output=True, text=True, check=True)
                metadata = json.loads(result.stdout)
                duration = float(metadata.get("format", {}).get("duration", 0))
            else:
                result = subprocess.run([
                    "ffprobe", "-v", "error",
                    "-select_streams", "v:0",
                    "-show_entries", "stream=width,height,duration",
                    "-of", "json",
                    str(file_path)
                ], capture_output=True, text=True, check=True)
                metadata = json.loads(result.stdout)
                stream = metadata.get("streams", [{}])[0]
                duration = float(stream.get("duration", 0))
                width = stream.get("width", 0)
                height = stream.get("height", 0)
        except (FileNotFoundError, subprocess.CalledProcessError, KeyError, IndexError) as e:
            print(f"[asset-upload] ffprobe unavailable or failed, using defaults: {e}")

    return JSONResponse({
        "assetId": asset_id,
        "assetType": asset_type,
        "assetUrl": asset_url,
        "duration": duration,
        "resolution": {
            "width": width,
            "height": height
        },
        "filename": file.filename
    })

@app.get("/api/assets/{asset_id}/stream")
async def stream_asset(asset_id: str, request: Request):
    """
    Stream asset file (video or image) with range request support
    """
    # Find the asset file
    for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]:
        asset_path = UPLOAD_DIR / f"asset_{asset_id}{ext}"
        if asset_path.exists():
            # For images, just return the file
            if ext in [".jpg", ".jpeg", ".png", ".gif", ".webp"]:
                return FileResponse(
                    asset_path,
                    media_type=mimetypes.guess_type(str(asset_path))[0] or "image/jpeg"
                )
            if ext in [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]:
                return FileResponse(
                    asset_path,
                    media_type=mimetypes.guess_type(str(asset_path))[0] or "audio/mpeg"
                )
            # For videos, use range streaming
            else:
                return await stream_video_with_range(asset_path, request)
    
    raise HTTPException(status_code=404, detail="Asset not found")


@app.get("/api/videos/{session_id}/stream")
async def stream_video(session_id: str, request: Request):
    """
    Stream video file with range request support for proper video loading
    """
    # First check session store for the exact file path
    if session_id in session_store:
        video_path = Path(session_store[session_id])
        if video_path.exists():
            return await stream_video_with_range(video_path, request)
    
    # Fallback: Find the video file by trying extensions
    for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
        video_path = UPLOAD_DIR / f"{session_id}{ext}"
        if video_path.exists():
            return await stream_video_with_range(video_path, request)
    
    raise HTTPException(status_code=404, detail="Video not found")


async def stream_video_with_range(video_path: Path, request: Request):
    """
    Stream video file with HTTP range request support
    """
    from fastapi.responses import StreamingResponse
    import mimetypes
    
    # Get file size
    file_size = video_path.stat().st_size
    
    # Determine content type
    content_type = mimetypes.guess_type(str(video_path))[0] or "video/mp4"
    
    # Parse range header
    range_header = request.headers.get("range")
    
    if range_header:
        # Parse range header (e.g., "bytes=0-1023")
        range_match = range_header.replace("bytes=", "").split("-")
        start = int(range_match[0]) if range_match[0] else 0
        end = int(range_match[1]) if range_match[1] else file_size - 1
        
        # Ensure valid range
        start = max(0, start)
        end = min(file_size - 1, end)
        content_length = end - start + 1
        
        def generate_chunk():
            with open(video_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)  # 8KB chunks
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
        
        return StreamingResponse(
            generate_chunk(),
            status_code=206,  # Partial Content
            headers={
                "Content-Type": content_type,
                "Content-Length": str(content_length),
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
            }
        )
    else:
        # No range request, return full file
        return FileResponse(
            video_path,
            media_type=content_type,
            headers={
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
            }
        )


@app.post("/api/videos/{session_id}/generate-clips")
async def generate_clips(session_id: str, body: GenerateClipsRequest):
    """
    Generate short titles for transcript segments using GPT-4o-mini.
    Sends all segments in a single batched prompt to minimise API calls.
    """
    import json as _json

    segments = body.segments

    if not segments:
        raise HTTPException(status_code=400, detail="No segments provided.")

    if not client.api_key:
        raise HTTPException(
            status_code=500,
            detail="OpenAI API key not configured. Set OPENAI_API_KEY environment variable."
        )

    print(f"[generate-clips] session_id={session_id}, segments={len(segments)}")

    # Build a single batched prompt — one API call for all segments
    numbered = "\n".join(
        f"{i + 1}. {seg.get('text', '').strip()}"
        for i, seg in enumerate(segments)
    )
    prompt = (
        "Generate a short, clear title (max 5 words) for each video segment below.\n"
        "Return ONLY a JSON array of strings, one title per segment, in the same order.\n"
        "Example: [\"Intro to the topic\", \"Key findings\", \"Conclusion\"]\n\n"
        f"Segments:\n{numbered}"
    )

    try:
        print(f"[generate-clips] calling GPT-4o-mini with {len(segments)} segments")
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        raw = response.choices[0].message.content.strip()
        print(f"[generate-clips] raw response: {raw}")

        # Parse the returned JSON array of titles
        titles = _json.loads(raw)
        if not isinstance(titles, list):
            raise ValueError("Expected a JSON array of titles")

    except _json.JSONDecodeError as e:
        print(f"[generate-clips] JSON parse error: {e}, raw={raw}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to parse titles from OpenAI response: {str(e)}"
        )
    except Exception as e:
        print(f"[generate-clips] exception: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Clip title generation failed: {str(e)}"
        )

    # Merge titles back into segments — pad with empty string if count mismatches
    clips = [
        {
            "start": seg.get("start", 0),
            "end": seg.get("end", 0),
            "text": seg.get("text", ""),
            "title": titles[i] if i < len(titles) else "",
        }
        for i, seg in enumerate(segments)
    ]

    print(f"[generate-clips] returning {len(clips)} clips")
    return JSONResponse({"clips": clips})


@app.post("/api/videos/{session_id}/edit-with-ai")
async def edit_with_ai(session_id: str, body: EditWithAIRequest):
    """
    Convert a natural language editing instruction into structured edit actions
    using GPT-4o-mini. Returns a JSON array of cut/keep/highlight actions.
    
    Enhanced with robustness layer: stable clip IDs, validation, auto-repair, operation logging.
    
    REQUIRES: Transcript must be generated before AI editing can be used.
    """
    import json as _json

    original_transcript = None

    # Validate prompt
    if not body.prompt or not body.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required.")

    # Validate segments
    if not body.segments:
        raise HTTPException(status_code=400, detail="segments are required.")
    
    # CRITICAL: Validate transcript exists in segments
    has_transcript_in_segments = any(
        seg.get('text') and seg.get('text').strip() 
        for seg in body.segments
    )
    
    has_transcript = has_transcript_in_segments
    
    total_transcript_length = sum(
        len(seg.get('text', '').strip()) 
        for seg in body.segments
    )
    
    print(f"[edit-with-ai] session_id={session_id}, prompt={body.prompt!r}, segments={len(body.segments)}")
    print(f"[edit-with-ai] Transcript check: has_transcript={has_transcript}, total_length={total_transcript_length}")
    
    # Check if this is a content-based command that requires transcript
    content_based_keywords = [
        'about', 'mention', 'discuss', 'talk', 'say', 'explain',
        'describe', 'topic', 'subject', 'content', 'word', 'phrase',
        'name clips from transcript', 'based on transcript'
    ]

    is_content_based = any(
        keyword in body.prompt.lower()
        for keyword in content_based_keywords
    )

    # Allow basic structural commands without transcript (including chapter division)
    basic_structural_keywords = [
        'delete', 'remove', 'merge', 'keep', 'reorder', 'move', 'swap',
        'chapters', 'divide', 'split', 'cut', 'break', 'rename', 'title', 'name'
    ]

    is_basic_structural = any(
        keyword in body.prompt.lower()
        for keyword in basic_structural_keywords
    )
    
    # Require transcript for content-based commands
    if is_content_based and not has_transcript:
        print(f"[edit-with-ai] ERROR: Content-based command requires transcript")
        
        raise HTTPException(
            status_code=400,
            detail={
                "error": "TRANSCRIPT_REQUIRED",
                "message": "Transcript required for content-based editing. Please generate transcript first by clicking 'Transcribe Video'.",
                "suggestion": "Please transcribe the video first by clicking 'Transcribe Video'.",
                "command_type": "content-based",
                "requires_transcript": True
            }
        )
    
    # Warn if transcript is missing for non-basic commands
    if not has_transcript and not is_basic_structural:
        print(f"[edit-with-ai] WARNING: No transcript available, AI may not understand content")

    # Validate OpenAI API key
    if not client.api_key:
        raise HTTPException(
            status_code=500,
            detail="OpenAI API key not configured. Set OPENAI_API_KEY environment variable."
        )

    print(f"[edit-with-ai] Segments received: {body.segments}")

    # ROBUSTNESS LAYER: Ensure all clips have stable IDs
    clips_with_ids = _ensure_clip_ids(body.segments)
    
    # Build numbered clip list with all info the AI needs to compute correct timestamps
    segments_text = "\n".join(
        (
            f"{i + 1}. Title:\"{seg.get('title', '').strip()}\" | "
            f"Timeline:{seg.get('timelineStart', 0):.2f}s-{seg.get('timelineStart', 0) + seg.get('duration', 0):.2f}s | "
            f"Source:{seg.get('start', 0):.2f}s-{seg.get('end', 0):.2f}s | "
            f"Duration:{seg.get('duration', seg.get('end', 0) - seg.get('start', 0)):.2f}s | "
            f"Transcript:{seg.get('detailedTranscript', seg.get('text', '')).strip()}"
        )
        for i, seg in enumerate(clips_with_ids)
    )

    # Extract requested chapter/clip count from prompt
    import re as _re
    # Match ranges like "7-8 clips" → use the higher number
    range_match = _re.search(r'\b(\d+)\s*[-–]\s*(\d+)\s*(?:chapters?|parts?|sections?|clips?|segments?)?\b', body.prompt.lower())
    if range_match:
        requested_chapters = int(range_match.group(2))  # use upper bound of range
    else:
        chapter_count_match = _re.search(r'\b(\d+)\s*(?:chapters?|parts?|sections?|pieces?|clips?|segments?|equal\s+parts?)\b', body.prompt.lower())
        # Also match "divide into 8" or "split into 7" without a unit word
        if not chapter_count_match:
            chapter_count_match = _re.search(r'(?:divide|split|break|cut)\s+(?:the\s+)?(?:video\s+)?into\s+(\d+)', body.prompt.lower())
        requested_chapters = int(chapter_count_match.group(1)) if chapter_count_match else None
    splits_needed = (requested_chapters - 1) if requested_chapters else None

    # Check if user explicitly asked for RENAMING (descriptive names from transcript)
    # "chapter" alone in a divide/split context means count, not rename
    is_rename_requested = any(word in body.prompt.lower() for word in [
        'rename', 'give names', 'name the clips', 'chapter names', 'descriptive', 'name them',
        'name from transcript', 'name according', 'title the clips', 'label the clips', 'name clips'
    ])
    is_content_based_split = any(word in body.prompt.lower() for word in ['transcript', 'topic', 'content', 'subject', 'say', 'theme'])

    # Only apply chapter instruction for whole-video division, NOT for specific clip splits
    is_specific_clip_split = bool(_re.search(r'clip\s*\d+', body.prompt.lower()))

    # NEW logic for dynamic splitting without a specific count
    is_dynamic_split = not requested_chapters and any(phrase in body.prompt.lower() for phrase in [
        'divide', 'split', 'create chapters', 'separate'
    ]) and not is_specific_clip_split

    # Build chapter-specific instruction
    chapter_instruction = ""
    if (requested_chapters and splits_needed and not is_specific_clip_split) or is_dynamic_split:
        total_duration = max((seg.get('end', 0) for seg in clips_with_ids), default=0)
        if total_duration > 0:
            if is_rename_requested or is_content_based_split:
                name_directive = "followed by a 'name_clips' action giving each part a short, descriptive title based on the transcript."
            else:
                name_directive = f"followed by a 'name_clips' action naming each part sequentially."

            if is_content_based_split or is_dynamic_split:
                count_text = f"EXACTLY {requested_chapters} parts" if requested_chapters else "logical parts"
                split_text = f"EXACTLY {splits_needed} split action(s)" if requested_chapters else "the appropriate number of split actions"
                chapter_instruction = (
                    f"\n\nCRITICAL: User wants {count_text} based on the transcript content. "
                    f"You MUST output {split_text}. "
                    f"Video is {total_duration}s. "
                    f"Analyze the transcript to find logical topic transitions and use those timestamps for split_time. "
                    f"Return ONLY a JSON object with an 'actions' array containing the split actions {name_directive}"
                )
            else:
                split_points = [round(total_duration * i / requested_chapters, 2) for i in range(1, requested_chapters)]
                chapter_instruction = (
                    f"\n\nCRITICAL: User wants EXACTLY {requested_chapters} equal parts. "
                    f"You MUST output EXACTLY {splits_needed} split action(s). "
                    f"Video is {total_duration}s. "
                    f"Use these EXACT split_time values: {', '.join(str(t) for t in split_points)}. "
                    f"Return ONLY a JSON object with an 'actions' array containing the split actions {name_directive}"
                )
    elif requested_chapters and splits_needed and is_specific_clip_split:
        # Specific clip split — find that clip and compute correct split points
        clip_num_match = _re.search(r'clip\s*(\d+)', body.prompt.lower())
        if clip_num_match:
            clip_num = int(clip_num_match.group(1))
            target_clip = next((s for s in clips_with_ids if s.get('index') == clip_num or s.get('id', '').endswith(f'-{clip_num}')), None)
            if not target_clip and clip_num <= len(clips_with_ids):
                target_clip = clips_with_ids[clip_num - 1]
            if target_clip:
                clip_start = target_clip.get('start', 0)
                clip_end = target_clip.get('end', 0)
                split_points = [round(clip_start + (clip_end - clip_start) * i / requested_chapters, 2) for i in range(1, requested_chapters)]
                split_points_str = ", ".join(f"{t}s" for t in split_points)
                
                if is_rename_requested:
                    name_directive = "After splitting, use name_clips to give each part a descriptive title based on the transcript."
                else:
                    name_directive = f"After splitting, use name_clips to name each part 'Clip 1', 'Clip 2', ... 'Clip {requested_chapters}'."
                
                chapter_instruction = (
                    f"\n\nCRITICAL SPLIT REQUIREMENT:\n"
                    f"Split clip {clip_num} (range: {clip_start}s to {clip_end}s) into EXACTLY {requested_chapters} parts.\n"
                    f"This requires EXACTLY {splits_needed} split action(s).\n"
                    f"Correct split_time values (within clip range): {split_points_str}\n"
                    f"Use clip_index: {clip_num} for all split actions.\n"
                    f"CRITICAL: split_time MUST be between {clip_start} and {clip_end}.\n"
                    f"{name_directive}"
                )

    system_prompt = (
        "You are an AI video editor. Convert instructions into JSON edit actions.\n\n"
        "CLIP DATA: Each line shows Index. Title | Timeline:START-END | Source:START-END | Duration:Ds\n"
        "- Source = timestamps in the ORIGINAL video file\n"
        "- split_time MUST be a Source timestamp (absolute seconds from original video start)\n"
        "- Timeline = position in the edited video (use for cut_time)\n"
        "- Transcript timestamps like [10.5s] indicate the Source time of that text.\n\n"
        "NAMING: After split/divide → Clip 1, Clip 2... After rename command → descriptive names.\n"
        "IMPORTANT: If renaming parts of a split clip, ALWAYS append the part number to the title (e.g., 'Intro (Part 1)', 'Main Content (Part 2)').\n\n"
        "SPLIT — CRITICAL EXAMPLES:\n"
        "Clip 1: Source 0-60s\n"
        "  'split at 10s' → [{\"type\":\"split\",\"clip_index\":1,\"split_time\":10}]\n"
        "  'first 10s and rest' → [{\"type\":\"split\",\"clip_index\":1,\"split_time\":10}]\n"
        "  'split into 2 parts where 10 sec as first half' → [{\"type\":\"split\",\"clip_index\":1,\"split_time\":10}]\n"
        "  'split first 20s as first half and rest as second half' → [\n"
        "    {\"type\":\"split\",\"clip_index\":1,\"split_time\":20},\n"
        "    {\"type\":\"name_clips\",\"clips\":[{\"index\":1,\"title\":\"First Half (Part 1)\"},{\"index\":2,\"title\":\"Second Half (Part 2)\"}]}\n"
        "  ]\n"
        "  'split into 3 equal parts' → [\n"
        "    {\"type\":\"split\",\"clip_index\":1,\"split_time\":20},\n"
        "    {\"type\":\"split\",\"clip_index\":1,\"split_time\":40}\n"
        "  ]\n"
        "  'split into 4 parts' → split_times: 15, 30, 45\n"
        "  FORMULA for N parts of clip with Source S-E:\n"
        "    split_times = [round(S + (E-S)*i/N, 2) for i in 1..N-1]\n"
        "    Use clip_index: same number for ALL splits (engine finds sub-clips by timestamp)\n\n"
        "Clip 2: Source 30-90s\n"
        "  'split clip 2 at 10s from start' → split_time = 30+10 = 40\n"
        "  'split clip 2 into first 20s and rest' → split_time = 30+20 = 50\n\n"
        "DELETE TIME RANGE (timeline seconds):\n"
        "  'delete first 10s of clip 1' → {\"type\":\"cut_time\",\"start\":clip1_tl_start,\"end\":clip1_tl_start+10}\n"
        "  'delete last 20s of clip 2' → {\"type\":\"cut_time\",\"start\":clip2_tl_end-20,\"end\":clip2_tl_end}\n"
        "  'delete 10 sec of last clip' → {\"type\":\"cut_time\",\"start\":last_clip_tl_end-10,\"end\":last_clip_tl_end}\n\n"
        "DELETE CLIP: {\"type\":\"delete\",\"clip_index\":N}\n"
        "DUPLICATE CLIP: {\"type\":\"duplicate\",\"clip_index\":N}\n"
        "RENAME CLIP: {\"type\":\"rename\",\"clip_index\":N,\"title\":\"New Name\"}\n"
        "RENAME MULTIPLE (after split): {\"type\":\"name_clips\",\"clips\":[{\"index\":N,\"title\":\"Name\"}]}\n"
        "MERGE (combine multiple clips): {\"type\":\"merge\",\"clip_indexes\":[N,M]}\n"
        "SWAP (exchange positions): {\"type\":\"swap\",\"clip_indexes\":[N,M]}\n\n"
        "COMBINED COMMANDS — put all actions in one actions array:\n"
        "  'swap clip 1 and 2' → [{\"type\":\"swap\",\"clip_indexes\":[1,2]}]\n"
        "  'merge clip 2 and 3' → [{\"type\":\"merge\",\"clip_indexes\":[2,3]}]\n"
        "  'rename clip 1 to Intro' → [{\"type\":\"rename\",\"clip_index\":1,\"title\":\"Intro\"}]\n"
        "  'split clip 1 at 10s and rename first part Intro' → [\n"
        "    {\"type\":\"split\",\"clip_index\":1,\"split_time\":10},\n"
        "    {\"type\":\"name_clips\",\"clips\":[{\"index\":1,\"title\":\"Intro\"},{\"index\":2,\"title\":\"Clip 2\"}]}\n"
        "  ]\n"
        "  'split into 3 parts and name them' → [\n"
        "    {\"type\":\"split\",\"clip_index\":1,\"split_time\":T1},\n"
        "    {\"type\":\"split\",\"clip_index\":1,\"split_time\":T2},\n"
        "    {\"type\":\"name_clips\",\"clips\":[{\"index\":1,\"title\":\"Part 1\"},{\"index\":2,\"title\":\"Part 2\"},{\"index\":3,\"title\":\"Part 3\"}]}\n"
        "  ]\n\n"
        "Return ONLY: {\"actions\":[...]}  No markdown, no explanation.\n"
        f"Currently {len(clips_with_ids)} clip(s). Total: {max((s.get('end',0) for s in clips_with_ids), default=0):.1f}s"
        + chapter_instruction
    )

    # INTELLIGENT PREPROCESSING: Handle common single-clip scenarios
    if len(clips_with_ids) == 1:
        # For single clip scenarios, interpret certain requests differently
        # BUT: Allow chapter division requests to proceed without transformation
        chapter_division_keywords = [
            'divide', 'split', 'break', 'separate', 'cut into', 'chapters', 'sections', 'main chapters'
        ]
        
        smart_trimming_keywords = [
            'cut into main', 'divide into main', 'extract main', 'keep only main', 'main chapters only'
        ]
        
        is_chapter_division = any(
            keyword in body.prompt.lower() 
            for keyword in chapter_division_keywords
        )
        
        is_smart_trimming = any(
            keyword in body.prompt.lower() 
            for keyword in smart_trimming_keywords
        )
        
        if not is_chapter_division and not is_smart_trimming:
            single_clip_patterns = {
                'make main chapter': 'rename this clip to describe the main content',
                'title this': 'rename this clip to describe the content',
                'name this': 'rename this clip to describe the content'
            }
            
            original_prompt = body.prompt.lower().strip()
            for pattern, replacement in single_clip_patterns.items():
                if pattern in original_prompt:
                    print(f"[edit-with-ai] Single clip detected: transforming '{body.prompt}' → '{replacement}'")
                    body.prompt = replacement
                    break
        else:
            if is_smart_trimming:
                print(f"[edit-with-ai] Smart trimming + chapter division request detected")
            else:
                print(f"[edit-with-ai] Chapter division request detected, allowing AI to analyze content for splitting")

    user_message = (
        f"Clips:\n{segments_text}\n\n"
        f"Instruction: {body.prompt.strip()}\n\n"
        f"State: {len(clips_with_ids)} clip(s). Total duration: {max((s.get('end',0) for s in clips_with_ids), default=0):.1f}s"
        + (f"\nREMINDER: produce EXACTLY {requested_chapters} parts using {splits_needed} split action(s)." if requested_chapters else "")
        + (f"\nREMINDER: divide the video based on logical transcript breaks." if is_dynamic_split else "")
    )

    try:
        print(f"[edit-with-ai] calling GPT-4o-mini")

        # ── PRE-PROCESSING: Inject computed split_times into the user message ──
        # This prevents the AI from making arithmetic errors on split_time values.
        import re as _re3
        enhanced_prompt = body.prompt.strip()

        # Pattern: "split clip N at Xs", "split first Xs as...", etc.
        split_at_match = _re3.search(
            r'(?:split(?:ting)?|divide|dividing|cut(?:ting)?)(?:\s+(?:the\s+)?(?:clip|part|video)\s+(?P<clip>\d+))?.*?(?:at|into\s+first|first|where|with)\s+(?:the\s+)?(?:first\s+half\s+(?:is|as)\s+)?(?P<time>\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?',
            enhanced_prompt, _re3.IGNORECASE
        )
        if not split_at_match:
            split_at_match = _re3.search(
                r'(?:split(?:ting)?|divide|dividing|cut(?:ting)?)(?:\s+(?:the\s+)?(?:clip|part|video)\s+(?P<clip>\d+))?.*?(?P<time>\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\s+(?:as\s+(?:the\s+)?first|for\s+(?:the\s+)?first)',
                enhanced_prompt, _re3.IGNORECASE
            )

        if split_at_match:
            clip_num_str = split_at_match.group('clip')
            clip_num = int(clip_num_str) if clip_num_str else 1
            offset_s = float(split_at_match.group('time'))
            if clip_num <= len(clips_with_ids):
                target = clips_with_ids[clip_num - 1]
                src_start = float(target.get('start', 0))
                computed_split = round(src_start + offset_s, 2)
                enhanced_prompt += f"\n[COMPUTED: split_time for clip {clip_num} at {offset_s}s from start = {computed_split}]"

        # Pattern: "delete Xs of clip N", "delete Xs of last clip", or "delete first/last Xs"
        delete_match = _re3.search(
            r'(?:delete|remove|cut)\s+(?:the\s+)?(?P<mod1>first|last)?\s*(?P<time>\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\s*(?:(?:of|from)\s+(?:the\s+)?(?:(?P<mod2>last|first)\s+clip|clip\s+(?P<clip>\d+)))?',
            enhanced_prompt, _re3.IGNORECASE
        )
        if delete_match:
            time_val = float(delete_match.group('time'))
            mod1 = delete_match.group('mod1')
            mod2 = delete_match.group('mod2')
            clip_num_str = delete_match.group('clip')
            
            if clip_num_str:
                target_idx = int(clip_num_str) - 1
            elif mod2 == 'last' or mod1 == 'last': 
                target_idx = -1
            else:
                target_idx = 0
                
            if clips_with_ids and (0 <= target_idx < len(clips_with_ids) or target_idx == -1):
                target = clips_with_ids[target_idx]
                tl_start = float(target.get('timelineStart', 0))
                tl_end = tl_start + float(target.get('duration', 0))
                
                # Default "delete Xs" is treated as deleting from the start unless "last" is specified
                if mod1 == 'last' or mod2 == 'last':
                    c_start = max(tl_start, tl_end - time_val)
                    c_end = tl_end
                else:
                    c_start = tl_start
                    c_end = min(tl_end, tl_start + time_val)
                
                c_start = round(c_start, 2)
                c_end = round(c_end, 2)
                
                clip_label = f"clip {target_idx+1}" if target_idx != -1 else "last clip"
                enhanced_prompt += f"\n[COMPUTED: delete {time_val}s of {clip_label} = cut_time start: {c_start}, end: {c_end}]"

        # Pattern: "split clip N into M parts/equal parts"
        split_parts_match = _re3.search(
            r'(?:split(?:ting)?|divide|dividing|cut(?:ting)?)(?:\s+(?:the\s+)?(?:clip|part|video)\s+(\d+))?\s+into\s+(\d+)\s+(?:equal\s+)?parts?',
            enhanced_prompt, _re3.IGNORECASE
        )
        if split_parts_match and not split_at_match:
            clip_num_str = split_parts_match.group(1)
            clip_num = int(clip_num_str) if clip_num_str else 1
            n_parts  = int(split_parts_match.group(2))
            if clip_num <= len(clips_with_ids) and n_parts >= 2:
                target = clips_with_ids[clip_num - 1]
                src_start = float(target.get('start', 0))
                src_end   = float(target.get('end', 0))
                split_pts = [round(src_start + (src_end - src_start) * i / n_parts, 2) for i in range(1, n_parts)]
                enhanced_prompt += f"\n[COMPUTED: split clip {clip_num} into {n_parts} parts → split_times: {split_pts}]"

        user_message_final = (
            f"Clips:\n{segments_text}\n\n"
            f"Instruction: {enhanced_prompt}\n\n"
            f"State: {len(clips_with_ids)} clip(s). Total: {max((s.get('end',0) for s in clips_with_ids), default=0):.1f}s"
            + (f"\nREMINDER: produce EXACTLY {requested_chapters} parts using {splits_needed} split action(s)." if requested_chapters else "")
            + (f"\nREMINDER: divide the video based on logical transcript breaks." if is_dynamic_split else "")
        )
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message_final},
            ],
            temperature=0.1,
            response_format={"type": "json_object"}
        )
        raw = response.choices[0].message.content.strip()
        print(f"[edit-with-ai] raw response: {raw}")

        # Strip markdown code fences or extract JSON block if there's text around it
        import re as _re_json
        json_match = _re_json.search(r'```(?:json)?\s*(.*?)\s*```', raw, _re_json.DOTALL)
        if json_match:
            raw = json_match.group(1).strip()
        else:
            # Fallback: find the first { or [ and the last } or ]
            start_obj = raw.find('{')
            start_arr = raw.find('[')
            first_idx = min(start_obj, start_arr) if start_obj != -1 and start_arr != -1 else max(start_obj, start_arr)
            
            if first_idx != -1:
                last_idx = raw.rfind('}') if raw[first_idx] == '{' else raw.rfind(']')
                if last_idx != -1 and last_idx >= first_idx:
                    raw = raw[first_idx:last_idx+1]

        # Robust JSON parsing — handle all malformed cases from the AI
        try:
            result = _json.loads(raw)
        except _json.JSONDecodeError:
            # Try wrapping as array if it looks like comma-separated objects
            # e.g. {"type":"split",...},{"type":"name_clips",...}
            wrapped = f"[{raw}]"
            try:
                items = _json.loads(wrapped)
                if isinstance(items, list) and all(isinstance(i, dict) for i in items):
                    result = {"actions": items}
                    print(f"[edit-with-ai] Recovered comma-separated objects as actions array")
                else:
                    raise ValueError("Could not recover JSON")
            except Exception:
                raise _json.JSONDecodeError(f"Failed to parse response", raw, 0)

        # Normalize: if model returned a bare action object instead of {"actions": [...]}
        if "actions" not in result:
            if "type" in result:
                result = {"actions": [result]}
                print(f"[edit-with-ai] Normalized bare action into actions array")
            elif isinstance(result, list):
                result = {"actions": result}
                print(f"[edit-with-ai] Normalized list into actions array")
            else:
                raise ValueError("Response missing 'actions' array and no 'type' field found")

        if not isinstance(result["actions"], list):
            raise ValueError("'actions' field is not a list")

        # Validate each action matches the supported types (added "delete")
        valid_types = {"name_clips", "rename", "cut", "delete", "cut_time", "split", "merge", "swap", "keep", "duplicate"}
        for action in result["actions"]:
            if action.get("type") not in valid_types:
                raise ValueError(f"Invalid action type: {action.get('type')!r}")

        # Fallback: if AI returned empty actions, generate name_clips for all segments
        if len(result["actions"]) == 0:
            print(f"[edit-with-ai] AI returned empty actions — applying name_clips fallback")
            result = {
                "actions": [{
                    "type": "name_clips",
                    "clips": [
                        {"index": i + 1, "title": "Main Topic"}
                        for i in range(len(clips_with_ids))
                    ]
                }]
            }

        # ROBUSTNESS LAYER: Parse AI output into structured operations
        operations, warnings = _parse_ai_actions_to_operations(result["actions"], clips_with_ids)
        
        # ROBUSTNESS LAYER: Apply operations and get final clips
        final_clips, apply_warnings = _apply_operations_with_validation(clips_with_ids, operations)
        warnings.extend(apply_warnings)

        # POST-PROCESSING: If user requested N clips but we got fewer, split manually
        if requested_chapters and not is_specific_clip_split and len(final_clips) < requested_chapters:
            print(f"[edit-with-ai] Need {requested_chapters} clips, have {len(final_clips)} — splitting manually")
            # Collect all source segments from all current clips
            all_source_segs = []
            for c in final_clips:
                if c.get("segments"):
                    all_source_segs.extend(c["segments"])
                else:
                    all_source_segs.append({
                        "sourceStart": c.get("sourceStart", c.get("start", 0)),
                        "sourceEnd":   c.get("sourceEnd",  c.get("end",   0)),
                    })
            total_dur = sum(s["sourceEnd"] - s["sourceStart"] for s in all_source_segs)
            if total_dur > 0:
                seg_dur = total_dur / requested_chapters
                new_clips = []
                seg_idx = 0
                seg_pos = all_source_segs[0]["sourceStart"] if all_source_segs else 0
                for chapter_i in range(requested_chapters):
                    remaining = seg_dur
                    chapter_segs = []
                    while remaining > 0.01 and seg_idx < len(all_source_segs):
                        s = all_source_segs[seg_idx]
                        available = s["sourceEnd"] - seg_pos
                        take = min(available, remaining)
                        chapter_segs.append({"sourceStart": seg_pos, "sourceEnd": seg_pos + take})
                        remaining -= take
                        seg_pos += take
                        if seg_pos >= s["sourceEnd"] - 0.01:
                            seg_idx += 1
                            if seg_idx < len(all_source_segs):
                                seg_pos = all_source_segs[seg_idx]["sourceStart"]
                    if chapter_segs:
                        dur = sum(float(s["sourceEnd"]) - float(s["sourceStart"]) for s in chapter_segs)
                        new_clips.append({
                            "id": f"chapter-{chapter_i + 1}",
                            "title": f"Clip {chapter_i + 1}",
                            "name":  f"Clip {chapter_i + 1}",
                            "start": chapter_segs[0]["sourceStart"],
                            "end":   chapter_segs[-1]["sourceEnd"],
                            "sourceStart": chapter_segs[0]["sourceStart"],
                            "sourceEnd":   chapter_segs[-1]["sourceEnd"],
                            "duration": dur
                        })
                if len(new_clips) == requested_chapters:
                    final_clips = new_clips
                    print(f"[edit-with-ai] Manual split produced {len(final_clips)} clips")

        # ROBUSTNESS LAYER: Normalize timeline
        normalized_clips = _normalize_timeline(final_clips)

        # ENFORCE NAMING:
        # - If this was a pure divide/split with NO prior custom names → Clip 1, 2, 3...
        # - If clips already had custom names (e.g. "Introduction") → preserve them,
        #   only assign "Clip N" to newly created clips that have no name.
        original_clip_count = len(clips_with_ids)
        clips_were_split = len(normalized_clips) > original_clip_count

        # Build a map of original custom names by clip id
        original_names = {c.get('id'): (c.get('title') or c.get('name') or '') for c in clips_with_ids}
        # Check if ANY original clip had a custom name (not just "Clip N")
        import re as _re2
        has_custom_names = any(
            name and not _re2.match(r'^clip\s*\d+$', name.strip(), _re2.IGNORECASE)
            for name in original_names.values()
        )

        if clips_were_split or requested_chapters is not None or is_dynamic_split:
            if has_custom_names:
                # Preserve existing custom names; only fill in blanks with "Clip N"
                for i, clip in enumerate(normalized_clips):
                    existing = clip.get('title') or clip.get('name') or ''
                    if not existing or _re2.match(r'^clip\s*\d+$', existing.strip(), _re2.IGNORECASE):
                        if not is_rename_requested:
                            clip['title'] = f'Clip {i + 1}'
                            clip['name']  = f'Clip {i + 1}'
            else:
                # No custom names — force sequential Clip 1, 2, 3...
                if not is_rename_requested:
                    for i, clip in enumerate(normalized_clips):
                        clip['title'] = f'Clip {i + 1}'
                        clip['name']  = f'Clip {i + 1}'
            print(f"[edit-with-ai] Names after enforcement: {[c['name'] for c in normalized_clips]}")
        
        # PRESERVE TRANSCRIPT: Ensure transcript data is maintained in final clips
        # Always map transcript from original if available, never lose it
        if original_transcript and original_transcript.get('segments'):
            print(f"[edit-with-ai] Preserving original transcript in final clips")
            for clip in normalized_clips:
                # Always ensure transcript is present, even if clip already has some
                clip_source_start = clip.get('sourceStart', clip.get('start', 0))
                clip_source_end = clip.get('sourceEnd', clip.get('end', 0))
                
                # Find overlapping transcript segments from original
                overlapping_text = []
                for orig_seg in original_transcript['segments']:
                    orig_start = orig_seg.get('start', 0)
                    orig_end = orig_seg.get('end', 0)
                    
                    # Check if original segment overlaps with current clip
                    if (orig_start < clip_source_end and orig_end > clip_source_start):
                        overlapping_text.append(orig_seg.get('text', '').strip())
                
                # Always set transcript from original (overwrite any existing)
                if overlapping_text:
                    clip['text'] = ' '.join(overlapping_text)
                    print(f"[edit-with-ai] Preserved transcript for clip {clip.get('id', '?')}: {len(clip['text'])} chars")
        
        # FINAL NAMING PASS — only if no custom names at all
        # (enforcement block above already handles the has_custom_names case)
        if not has_custom_names and (len(normalized_clips) > len(clips_with_ids) or requested_chapters is not None):
            for i, clip in enumerate(normalized_clips):
                clip['title'] = f'Clip {i + 1}'
                clip['name']  = f'Clip {i + 1}'

        # Build backward-compatible response with new fields
        enhanced_result = {
            "actions": result["actions"],
            "clips": normalized_clips,
            "operations": operations,
            "warnings": warnings,
            "transcript_preserved": original_transcript is not None,
            "requires_retranscription": False
        }

    except _json.JSONDecodeError as e:
        print(f"[edit-with-ai] JSON parse error: {e}, raw={raw}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to parse actions from OpenAI response: {str(e)}"
        )
    except Exception as e:
        print(f"[edit-with-ai] exception: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"AI edit failed: {str(e)}"
        )

    print(f"[edit-with-ai] returning {len(operations)} operations, {len(warnings)} warnings")
    return JSONResponse(enhanced_result)


@app.post("/api/videos/{session_id}/plan-edit")
async def plan_edit(session_id: str, body: PlanEditRequest):
    """
    NEW: Structured editing planner endpoint.
    Converts natural language instructions into precise, structured editing operations.
    Returns intent classification, operations, confidence score, and warnings.
    
    This is a planning-only endpoint - it does NOT execute operations.
    Use /edit-with-ai for execution or implement client-side execution.
    """
    import json as _json

    if not body.instruction or not body.instruction.strip():
        raise HTTPException(status_code=400, detail="instruction is required.")

    if not body.clips:
        raise HTTPException(status_code=400, detail="clips are required.")

    if not client.api_key:
        raise HTTPException(
            status_code=500,
            detail="OpenAI API key not configured. Set OPENAI_API_KEY environment variable."
        )

    print(f"[plan-edit] session_id={session_id}, instruction={body.instruction!r}, clips={len(body.clips)}")

    # Build clip context
    clips_text = "\n".join(
        f"- id: {clip.get('id', 'unknown')}, start: {clip.get('start', 0):.2f}s, end: {clip.get('end', 0):.2f}s"
        + (f", label: \"{clip.get('label', '')}\"" if clip.get('label') else "")
        for clip in body.clips
    )

    # Build transcript context if provided
    transcript_text = ""
    if body.transcript:
        transcript_text = "\n\nTranscript segments (summarized):\n" + "\n".join(
            f"[{seg.get('start', 0):.1f}s-{seg.get('end', 0):.1f}s]: {seg.get('text', '')[:100]}"
            for seg in body.transcript[:10]  # Limit to first 10 for context
        )

    system_prompt = """You are Kiro, an AI video editing planner.
You convert user instructions into precise, structured editing operations for a video editor.
You DO NOT execute actions. You DO NOT explain reasoning. You ONLY return valid JSON.

OUTPUT FORMAT (STRICT JSON ONLY):
{
  "intent": "DELETE" | "TRIM" | "SPLIT" | "MERGE" | "REORDER" | "HIGHLIGHT" | "CHAPTERIZE" | "UNKNOWN",
  "operations": [
    {
      "op": "DELETE_CLIP" | "TRIM_CLIP" | "SPLIT_CLIP" | "MERGE_CLIPS" | "KEEP_CLIP" | "RENAME_CLIP",
      "clip_id": "string",
      "start": number (optional),
      "end": number (optional),
      "time": number (for split),
      "clip_ids": [string] (for merge),
      "label": "string" (for rename)
    }
  ],
  "confidence": number (0–1),
  "warnings": [string]
}

HARD RULES (NON-NEGOTIABLE):
- Output MUST be valid JSON
- NO text outside JSON
- NEVER invent clip IDs
- NEVER produce invalid timestamps
- start < end ALWAYS
- Use ONLY provided clips
- If instruction is unclear → set intent = "UNKNOWN" and return empty operations

OPERATION RULES:
- DELETE: Remove entire clips (DELETE_CLIP)
- TRIM: Adjust start/end of a clip (must stay within original bounds)
- SPLIT: Split one clip into two at "time"
- MERGE: Only merge adjacent or logically connected clips (use clip_ids array)
- KEEP_CLIP: Used when user says "keep only X"
- RENAME: Assign meaningful labels

INTENT MAPPING:
- "delete clip 2" → DELETE
- "remove boring parts" → DELETE (select low-value clips)
- "shorten this" → TRIM
- "split at 30 seconds" → SPLIT
- "combine these clips" → MERGE
- "make highlights" → HIGHLIGHT (select best clips, mark KEEP_CLIP)
- "create chapters" → CHAPTERIZE (use RENAME_CLIP across clips)

BEHAVIOR:
- Prefer minimal operations
- Avoid redundant edits
- Preserve timeline continuity unless explicitly changed
- Use semantic meaning if transcript is provided
- Do not guess aggressively—be conservative

FAILURE HANDLING:
If instruction is vague, no clear mapping, or conflicting intent:
{
  "intent": "UNKNOWN",
  "operations": [],
  "confidence": 0.3,
  "warnings": ["Could not confidently interpret instruction"]
}"""

    user_message = f"""Clips:
{clips_text}{transcript_text}

User instruction: {body.instruction.strip()}"""

    try:
        print(f"[plan-edit] calling GPT-4o-mini")
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.1,  # Low temperature for deterministic planning
            response_format={"type": "json_object"}
        )
        raw = response.choices[0].message.content.strip()
        print(f"[plan-edit] raw response: {raw}")

        # Strip markdown code fences or extract JSON block if there's text around it
        import re as _re_json
        json_match = _re_json.search(r'```(?:json)?\s*(.*?)\s*```', raw, _re_json.DOTALL)
        if json_match:
            raw = json_match.group(1).strip()
        else:
            start_obj = raw.find('{')
            start_arr = raw.find('[')
            first_idx = min(start_obj, start_arr) if start_obj != -1 and start_arr != -1 else max(start_obj, start_arr)
            
            if first_idx != -1:
                last_idx = raw.rfind('}') if raw[first_idx] == '{' else raw.rfind(']')
                if last_idx != -1 and last_idx >= first_idx:
                    raw = raw[first_idx:last_idx+1]

        result = _json.loads(raw)

        # Validate response structure
        required_fields = ["intent", "operations", "confidence", "warnings"]
        for field in required_fields:
            if field not in result:
                raise ValueError(f"Missing required field: {field}")

        # Validate operations
        valid_ops = {"DELETE_CLIP", "TRIM_CLIP", "SPLIT_CLIP", "MERGE_CLIPS", "KEEP_CLIP", "RENAME_CLIP"}
        for op in result["operations"]:
            if op.get("op") not in valid_ops:
                raise ValueError(f"Invalid operation type: {op.get('op')}")

        print(f"[plan-edit] returning intent={result['intent']}, {len(result['operations'])} operations, confidence={result['confidence']}")
        return JSONResponse(result)

    except _json.JSONDecodeError as e:
        print(f"[plan-edit] JSON parse error: {e}, raw={raw}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to parse plan from OpenAI response: {str(e)}"
        )
    except Exception as e:
        print(f"[plan-edit] exception: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Edit planning failed: {str(e)}"
        )


class ExportRequest(BaseModel):
    clips: list  # [{start, end}]


class RemotionExportRequest(BaseModel):
    composition: dict  # CompositionSchema
    options: dict = {}  # Rendering options (fps, width, height, etc.)


class ErrorResponse(BaseModel):
    errorType: str
    message: str
    suggestion: str
    statusCode: int


class BuildCompositionRequest(BaseModel):
    clips: list  # Simple clips array
    options: dict = {}  # Build options (fps, width, height, etc.)

class FastExportRequest(BaseModel):
    timeline: list = []
    clips: list = []

class ExportZipRequest(BaseModel):
    timeline: list
    transcriptSegments: list = []
    mode: str = "clips"


def _export_signature(session_id: str, timeline: list) -> str:
    import json
    import hashlib
    normalized = []
    for i, clip in enumerate(timeline or []):
        start = float(clip.get("sourceStart", clip.get("start", 0)) or 0)
        duration = clip.get("duration")
        end = clip.get("end")
        if duration is None and end is not None:
            duration = float(end) - start
        if duration is None:
            duration = float(clip.get("duration", 0) or 0)
        normalized.append({"i": i, "start": round(start, 3), "duration": round(float(duration), 3)})

    material = {"session_id": session_id, "timeline": normalized}
    return hashlib.md5(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()[:12]


def _export_zip_signature(session_id: str, timeline: list, transcript_segments: list) -> str:
    import json
    import hashlib
    material = {
        "session_id": session_id,
        "timeline": timeline or [],
        "transcriptSegments": transcript_segments or []
    }
    return hashlib.md5(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()[:12]

@app.post("/api/videos/{session_id}/fast-export")
async def fast_export_endpoint(session_id: str, body: FastExportRequest):
    """Fast export endpoint with caching."""
    video_path = None
    if session_id in session_store:
        stored = Path(session_store[session_id])
        if stored.exists():
            video_path = stored

    if video_path is None:
        for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
            candidate = UPLOAD_DIR / f"{session_id}{ext}"
            if candidate.exists():
                video_path = candidate
                break

    if video_path is None:
        raise HTTPException(status_code=404, detail="Video file not found")

    timeline = body.timeline if body.timeline else body.clips
    if not timeline:
        raise HTTPException(status_code=400, detail="No clips/timeline provided")

    signature = _export_signature(session_id, timeline)

    export_dir = UPLOAD_DIR / "export_cache"
    export_dir.mkdir(parents=True, exist_ok=True)
    output_path = export_dir / f"{session_id}_{signature}.mp4"

    if output_path.exists() and output_path.stat().st_size > 1024 * 1024:
        return FileResponse(
            path=str(output_path),
            filename=f"edited-{session_id[:8]}.mp4",
            media_type="video/mp4",
        )

    export_id = str(uuid.uuid4())[:8]
    temp_dir = UPLOAD_DIR / f"export_{export_id}"
    temp_dir.mkdir(exist_ok=True)

    concat_file = temp_dir / "concat.txt"
    clip_files = []

    try:
        # Flatten merged clips
        flattened_timeline = []
        for clip in timeline:
            if clip.get("segments"):
                for seg in clip["segments"]:
                    flat = dict(clip)
                    flat["sourceStart"] = seg.get("sourceStart", seg.get("start", 0))
                    flat["sourceEnd"] = seg.get("sourceEnd", seg.get("end", 0))
                    flat.pop("segments", None)
                    flattened_timeline.append(flat)
            else:
                flattened_timeline.append(clip)

        for i, clip in enumerate(flattened_timeline):
            start = float(clip.get("sourceStart", clip.get("start", 0)) or 0)
            duration = clip.get("duration")
            end = clip.get("end")
            if duration is None and end is not None:
                duration = float(end) - start
            if duration is None:
                duration = float(clip.get("duration", 0) or 0)

            duration = float(duration or 0)
            if duration <= 0.05:
                continue

            clip_path = temp_dir / f"clip_{i}.mp4"
            clip_files.append(clip_path)

            cmd = [
                "ffmpeg",
                "-ss", str(start),
                "-t", str(duration),
                "-i", str(video_path),
                "-vf",
                "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "28",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "96k",
                "-ar", "44100",
                "-ac", "2",
                "-movflags", "+faststart",
                "-y",
                str(clip_path),
            ]
            subprocess.run(cmd, check=True, capture_output=True, text=True)

        if not clip_files:
            raise HTTPException(status_code=400, detail="No valid clips to export")

        with open(concat_file, "w", encoding="utf-8") as f:
            for c in clip_files:
                f.write(f"file '{c.absolute().as_posix()}'\n")

        tmp_final = temp_dir / "final.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-f", "concat",
                "-safe", "0",
                "-i", str(concat_file),
                "-c", "copy",
                "-movflags", "+faststart",
                "-y",
                str(tmp_final),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        tmp_final.replace(output_path)

        return FileResponse(
            path=str(output_path),
            filename=f"edited-{session_id[:8]}.mp4",
            media_type="video/mp4",
        )

    except subprocess.CalledProcessError as e:
        err = e.stderr[-300:] if e.stderr else str(e)
        raise HTTPException(status_code=500, detail=f"ffmpeg failed: {err}")
    finally:
        # best-effort cleanup
        try:
            for p in temp_dir.glob("*.mp4"):
                p.unlink(missing_ok=True)
            for p in temp_dir.glob("*.txt"):
                p.unlink(missing_ok=True)
            temp_dir.rmdir()
        except Exception:
            pass

@app.post("/api/videos/{session_id}/export-zip")
async def export_zip_endpoint(session_id: str, body: ExportZipRequest):
    import zipfile
    import tempfile
    import httpx
    import json
    import shutil
    from urllib.parse import urlparse, parse_qs
    from datetime import datetime

    video_path = None
    try:
        video_path = _get_video_path(session_id)
    except HTTPException:
        raise HTTPException(status_code=404, detail="Source video not found")
        
    zip_cache_dir = UPLOAD_DIR / "export_zip_cache"
    zip_cache_dir.mkdir(parents=True, exist_ok=True)
    cache_signature = _export_zip_signature(session_id, body.timeline, body.transcriptSegments)
    zip_path = zip_cache_dir / f"{session_id}_{cache_signature}.zip"
    whole_video_cache_path = zip_cache_dir / f"{session_id}_{cache_signature}.mp4"

    if body.mode == "clips" and zip_path.exists() and zip_path.stat().st_size > 1024:
        return FileResponse(
            str(zip_path),
            media_type="application/zip",
            filename=f"autoedit_{session_id[:8]}.zip"
        )
    if body.mode == "whole" and whole_video_cache_path.exists() and whole_video_cache_path.stat().st_size > 1024:
        return FileResponse(
            str(whole_video_cache_path),
            media_type="video/mp4",
            filename=f"autoedit_{session_id[:8]}.mp4"
        )

    temp_dir = Path(tempfile.mkdtemp(prefix=f"export_{session_id}_"))
    clips_dir = temp_dir / "clips"
    clips_dir.mkdir(exist_ok=True)
    
    try:
        clip_files = []
        chapters_meta = []
        top_level_clips = [clip for clip in body.timeline if clip.get("track", 0) == 0]

        for i, clip in enumerate(top_level_clips):
            title = clip.get("title", clip.get("name", f"Clip_{i+1}"))
            safe_title = "".join([c if c.isalnum() or c in " _-" else "_" for c in title])
            out_path = clips_dir / f"{i+1:02d}_{safe_title}.mp4"

            segments = clip.get("segments") if isinstance(clip.get("segments"), list) and clip.get("segments") else [clip]
            segment_paths = []
            clip_duration = 0.0

            for j, segment in enumerate(segments):
                asset_url = segment.get("assetUrl") or clip.get("assetUrl")
                if asset_url and asset_url.startswith("/api/proxy-"):
                    asset_url = parse_qs(urlparse(asset_url).query).get("url", [asset_url])[0]
                src_start = float(segment.get("sourceStart", segment.get("start", 0)))
                src_end = float(segment.get("sourceEnd", segment.get("end", 0)))
                duration = float(segment.get("duration", max(0, src_end - src_start)))
                if duration <= 0:
                    continue

                clip_duration += duration
                segment_out = temp_dir / f"clip_{i+1:02d}_seg_{j+1:02d}.mp4"

                if asset_url:
                    if asset_url.startswith("/api/"):
                        local_asset = None
                        if "ai-image" in asset_url:
                            img_id = asset_url.split("/")[-1]
                            local_asset = UPLOAD_DIR / f"ai_img_{img_id}.jpg"
                        elif "assets" in asset_url and "stream" in asset_url:
                            asset_id = asset_url.split("/")[-2]
                            for ext in [".mp4", ".mov", ".jpg", ".jpeg", ".png", ".webp"]:
                                candidate = UPLOAD_DIR / f"asset_{asset_id}{ext}"
                                if candidate.exists():
                                    local_asset = candidate
                                    break

                        if local_asset and local_asset.exists():
                            if local_asset.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]:
                                subprocess.run([
                                    "ffmpeg", "-loop", "1", "-i", str(local_asset),
                                    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                                    "-t", str(duration), "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                                    "-c:a", "aac", "-b:a", "96k", "-shortest", "-y", str(segment_out)
                                ], capture_output=True, text=True, check=True)
                            else:
                                subprocess.run([
                                    "ffmpeg", "-ss", "0", "-t", str(duration), "-i", str(local_asset),
                                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-y", str(segment_out)
                                ], capture_output=True, text=True, check=True)
                        else:
                            print(f"Local asset not found: {asset_url}")
                            continue
                    else:
                        async with httpx.AsyncClient(timeout=30.0) as hc:
                            r = await hc.get(asset_url)
                            r.raise_for_status()
                            content = r.content
                        dl_path = temp_dir / f"dl_{i+1:02d}_{j+1:02d}.tmp"
                        dl_path.write_bytes(content)

                        is_image = dl_path.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"] or content[:8] == b'\xff\xd8\xff' or content[:4] == b'\x89PNG'
                        if is_image:
                            subprocess.run([
                                "ffmpeg", "-loop", "1", "-i", str(dl_path), "-t", str(duration),
                                "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                                "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                                "-c:a", "aac", "-b:a", "96k", "-shortest", "-y", str(segment_out)
                            ], capture_output=True, text=True, check=True)
                        else:
                            subprocess.run([
                                "ffmpeg", "-i", str(dl_path), "-t", str(duration),
                                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-y", str(segment_out)
                            ], capture_output=True, text=True, check=True)
                else:
                    # Try a fast stream-copy cut for the source video first.
                    # If copy fails, fallback to re-encoding only this segment.
                    copy_error = None
                    try:
                        subprocess.run([
                            "ffmpeg", "-ss", str(src_start), "-t", str(duration),
                            "-i", str(video_path),
                            "-c", "copy", "-avoid_negative_ts", "make_zero", "-y", str(segment_out)
                        ], capture_output=True, text=True, check=True)
                    except subprocess.CalledProcessError as err:
                        copy_error = err
                    if copy_error or not segment_out.exists():
                        subprocess.run([
                            "ffmpeg", "-ss", str(src_start), "-t", str(duration),
                            "-i", str(video_path),
                            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-y", str(segment_out)
                        ], capture_output=True, text=True, check=True)

                if segment_out.exists():
                    segment_paths.append(segment_out)

            if not segment_paths:
                continue

            if len(segment_paths) == 1:
                segment_paths[0].replace(out_path)
            else:
                clip_concat_path = temp_dir / f"clip_{i+1:02d}_concat.txt"
                with open(clip_concat_path, 'w') as f:
                    for sp in segment_paths:
                        f.write(f"file '{sp.absolute().as_posix()}'\n")

                subprocess.run([
                    "ffmpeg", "-f", "concat", "-safe", "0",
                    "-i", str(clip_concat_path),
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                    "-c:a", "aac", "-b:a", "128k", "-y", str(out_path)
                ], capture_output=True, text=True, check=True)

            if out_path.exists():
                clip_files.append(out_path)
                chapters_meta.append({
                    "index": len(clip_files),
                    "title": title,
                    "duration": round(clip_duration, 2),
                    "file": out_path.name
                })
                
        # Whole-video mode does the expensive concat/mix work.
        # Clips mode skips this so exporting separated clips stays fast.
        concat_list_path = temp_dir / "concat.txt"
        main_video_path = temp_dir / "main_edited_video.mp4"
        if body.mode == "whole" and clip_files:
            with open(concat_list_path, 'w') as f:
                for cf in clip_files:
                    f.write(f"file '{cf.absolute().as_posix()}'\n")
            
            subprocess.run([
                "ffmpeg", "-f", "concat", "-safe", "0",
                "-i", str(concat_list_path), "-c", "copy", "-y", str(main_video_path)
            ], capture_output=True, text=True, check=True)

        audio_clips = [
            clip for clip in body.timeline
            if clip.get("assetKind") == "audio" and (clip.get("assetUrl") or "").strip()
        ]

        if main_video_path.exists() and audio_clips:
            audio_inputs = []
            for idx, audio_clip in enumerate(audio_clips):
                asset_url = audio_clip.get("assetUrl", "")
                if asset_url and asset_url.startswith("/api/proxy-"):
                    asset_url = parse_qs(urlparse(asset_url).query).get("url", [asset_url])[0]
                audio_path = None

                if asset_url.startswith("/api/") and "assets" in asset_url and "stream" in asset_url:
                    asset_id = asset_url.split("/")[-2]
                    for ext in [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]:
                        candidate = UPLOAD_DIR / f"asset_{asset_id}{ext}"
                        if candidate.exists():
                            audio_path = candidate
                            break
                elif asset_url.startswith("http://") or asset_url.startswith("https://"):
                    async with httpx.AsyncClient(timeout=30.0) as hc:
                        r = await hc.get(asset_url)
                        r.raise_for_status()
                        audio_path = temp_dir / f"audio_{idx+1:02d}.tmp"
                        audio_path.write_bytes(r.content)

                if audio_path and Path(audio_path).exists():
                    audio_inputs.append((Path(audio_path), audio_clip))

            if audio_inputs:
                mixed_video_path = temp_dir / "main_edited_video_mixed.mp4"
                cmd = ["ffmpeg", "-y", "-i", str(main_video_path)]
                for audio_path, _audio_clip in audio_inputs:
                    cmd.extend(["-i", str(audio_path)])

                filters = []
                mix_inputs = ["[0:a]"]
                for idx, (_audio_path, audio_clip) in enumerate(audio_inputs, start=1):
                    duration = float(audio_clip.get("duration", 0) or 0)
                    volume = max(0.0, min(1.0, float(audio_clip.get("volume", 1) or 1)))
                    trim = f"atrim=start=0"
                    if duration > 0:
                        trim += f":duration={duration}"
                    filters.append(f"[{idx}:a]{trim},asetpts=PTS-STARTPTS,volume={volume}[aud{idx}]")
                    mix_inputs.append(f"[aud{idx}]")

                filters.append(f"{''.join(mix_inputs)}amix=inputs={len(mix_inputs)}:duration=first:dropout_transition=0[aout]")
                cmd.extend([
                    "-filter_complex", ";".join(filters),
                    "-map", "0:v",
                    "-map", "[aout]",
                    "-c:v", "copy",
                    "-c:a", "aac",
                    "-b:a", "192k",
                    "-movflags", "+faststart",
                    str(mixed_video_path)
                ])
                subprocess.run(cmd, capture_output=True, text=True, check=True)
                if mixed_video_path.exists():
                    main_video_path = mixed_video_path

        if body.mode == "whole":
            if not main_video_path.exists():
                raise HTTPException(status_code=400, detail="No clips could be processed for export.")
            final_video_path = whole_video_cache_path
            shutil.copyfile(main_video_path, final_video_path)
            return FileResponse(
                str(final_video_path),
                media_type="video/mp4",
                filename=f"autoedit_{session_id[:8]}.mp4"
            )
            
        # Write metadata
        meta_path = temp_dir / "chapters.json"
        metadata = {
            "session_id": session_id,
            "export_date": datetime.now().isoformat(),
            "chapters": chapters_meta,
            "transcript_segments": body.transcriptSegments,
            "timeline": body.timeline
        }
        with open(meta_path, "w") as f:
            json.dump(metadata, f, indent=2)
            
        timeline_path = temp_dir / "timeline.json"
        with open(timeline_path, "w") as f:
            json.dump(body.timeline, f, indent=2)

        # Create ZIP
        zip_path = UPLOAD_DIR / f"{session_id}_export.zip"
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            if body.mode != "clips" and main_video_path.exists():
                zipf.write(main_video_path, main_video_path.name)
            for cf in clip_files:
                if cf.exists():
                    zipf.write(cf, f"clips/{cf.name}")
            if meta_path.exists():
                zipf.write(meta_path, meta_path.name)
            if timeline_path.exists():
                zipf.write(timeline_path, timeline_path.name)
                
        return FileResponse(
            str(zip_path),
            media_type="application/zip",
            filename=f"autoedit_{session_id[:8]}.zip"
        )
    except subprocess.CalledProcessError as e:
        err = e.stderr if e.stderr else str(e)
        print(f"[export-zip] FFmpeg error: {err}")
        raise HTTPException(status_code=500, detail=f"FFmpeg error: {err}")
    except Exception as e:
        print(f"[export-zip] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

# ============================================================================
# ROBUSTNESS LAYER: Helper functions for AI editing validation and execution
# ============================================================================

def _get_video_path(session_id: str) -> Path:
    """
    Get video file path for a session.
    Raises HTTPException if not found.
    """
    video_path = None
    
    # Check session store
    if session_id in session_store:
        stored = Path(session_store[session_id])
        if stored.exists():
            return stored
    
    # Scan uploads directory
    for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
        candidate = UPLOAD_DIR / f"{session_id}{ext}"
        if candidate.exists():
            return candidate
    
    raise HTTPException(
        status_code=404,
        detail=f"Video file not found for session {session_id}"
    )


def _ensure_clip_ids(clips: list) -> list:
    """
    Ensure every clip has a stable ID and source timestamps.
    Generate IDs if missing.
    IDs follow pattern: clip-1, clip-2, etc.
    
    CRITICAL: Also ensures sourceStart/sourceEnd exist for video extraction.
    """
    result = []
    for i, clip in enumerate(clips):
        clip_copy = dict(clip)
        
        # Ensure clip has an ID
        if "id" not in clip_copy or not clip_copy["id"]:
            clip_copy["id"] = f"clip-{i + 1}"
        
        # CRITICAL: Ensure sourceStart/sourceEnd exist
        # These are the ORIGINAL video timestamps used for extraction
        if "sourceStart" not in clip_copy:
            clip_copy["sourceStart"] = clip_copy.get("start", 0)
            print(f"[ensure_clip_ids] Added sourceStart={clip_copy['sourceStart']} to clip {clip_copy['id']}")
        
        if "sourceEnd" not in clip_copy:
            clip_copy["sourceEnd"] = clip_copy.get("end", 0)
            print(f"[ensure_clip_ids] Added sourceEnd={clip_copy['sourceEnd']} to clip {clip_copy['id']}")
        
        result.append(clip_copy)
    
    return result


def _parse_ai_actions_to_operations(actions: list, clips: list) -> tuple[list, list]:
    """
    Convert AI-generated actions into structured operations.
    Returns (operations, warnings).
    
    Operations format:
    {
        "type": "rename" | "delete" | "split" | "merge" | "keep",
        "clipId": "clip-1",
        "params": {...}
    }
    """
    operations = []
    warnings = []
    
    # Build index -> clipId mapping
    index_to_id = {i + 1: clip.get("id", f"clip-{i + 1}") for i, clip in enumerate(clips)}
    
    print(f"[parse_actions] Building index_to_id mapping from {len(clips)} clips:")
    for idx, clip_id in index_to_id.items():
        clip = clips[idx - 1]  # Convert back to 0-based for lookup
        print(f"[parse_actions]   Index {idx} → ID '{clip_id}' (start={clip.get('start')}, end={clip.get('end')}, title={clip.get('title', 'Untitled')})")
    
    for action in actions:
        action_type = action.get("type")
        
        if action_type == "name_clips":
            # Rename operations — use position-based matching
            # name_clips indexes refer to the FINAL clip order after all splits
            # We store these as positional renames to be applied at the end
            valid_renames = 0
            for clip_data in action.get("clips", []):
                idx = clip_data.get("index")
                title = clip_data.get("title", "")
                if idx and title:
                    # Store as positional rename (index 1-based)
                    operations.append({
                        "type": "rename_by_position",
                        "clipId": None,
                        "params": {"position": idx, "title": title}
                    })
                    valid_renames += 1
                else:
                    warnings.append(f"name_clips: clip index {idx} missing title, skipped")
        
        elif action_type == "rename":
            idx = action.get("clip_index")
            title = action.get("title")
            if idx in index_to_id and title:
                clip_id = index_to_id[idx]
                operations.append({
                    "type": "rename",
                    "clipId": clip_id,
                    "params": {"title": title}
                })
            else:
                warnings.append(f"rename: clip index {idx} out of range or missing title")

        elif action_type in ("cut", "delete"):
            # Delete operation
            idx = action.get("clip_index")
            print(f"[parse_actions] cut action: clip_index={idx}")
            if idx in index_to_id:
                clip_id = index_to_id[idx]
                print(f"[parse_actions]   → Mapped to clip_id={clip_id}")
                operations.append({
                    "type": "delete",
                    "clipId": clip_id,
                    "params": {}
                })
            else:
                print(f"[parse_actions]   → Index {idx} out of range (valid: {list(index_to_id.keys())})")
                warnings.append(f"cut: clip index {idx} out of range, skipped")
        
        elif action_type == "cut_time":
            # Time-based delete operation
            start = action.get("start", 0)
            end = action.get("end", 0)
            operations.append({
                "type": "cut_time",
                "clipId": None,  # Applies to all clips in range
                "params": {"start": start, "end": end}
            })
        
        elif action_type == "split":
            # Split operation - ENHANCED: Handle sequential splits better
            idx = action.get("clip_index")
            split_time = action.get("split_time")
            if split_time is not None:
                # For sequential splits, always try to find the clip containing this timestamp
                # rather than relying on changing clip indexes
                if idx in index_to_id:
                    clip_id = index_to_id[idx]
                else:
                    # Use a placeholder - the split operation will find the right clip by timestamp
                    clip_id = f"clip-{idx}"
                
                operations.append({
                    "type": "split",
                    "clipId": clip_id,
                    "params": {"split_time": split_time}
                })
            else:
                warnings.append(f"split: missing split_time, skipped")
        
        elif action_type == "merge":
            # Merge operation
            indexes = action.get("clip_indexes", [])
            clip_ids = [index_to_id.get(idx) for idx in indexes if idx in index_to_id]
            if len(clip_ids) >= 2:
                operations.append({
                    "type": "merge",
                    "clipId": clip_ids[0],  # First clip ID preserved
                    "params": {"mergeIds": clip_ids}
                })
            else:
                warnings.append(f"merge: insufficient valid clip indexes, skipped")
        
        elif action_type == "swap":
            # Swap operation
            indexes = action.get("clip_indexes", [])
            if len(indexes) == 2:
                clip_ids = [index_to_id.get(idx) for idx in indexes if idx in index_to_id]
                if len(clip_ids) == 2:
                    operations.append({
                        "type": "swap",
                        "clipId": None,
                        "params": {"swapIds": clip_ids}
                    })
                else:
                    warnings.append(f"swap: one or more clip indexes invalid, skipped")
            else:
                warnings.append(f"swap: expected 2 clip indexes, got {len(indexes)}, skipped")
        
        elif action_type == "duplicate":
            # Duplicate operation
            idx = action.get("clip_index")
            if idx in index_to_id:
                operations.append({
                    "type": "duplicate",
                    "clipId": index_to_id[idx],
                    "params": {}
                })
            else:
                warnings.append(f"duplicate: clip index {idx} out of range, skipped")
        
        elif action_type == "keep":
            # Keep operation (delete all others)
            indexes = action.get("clip_indexes", [])
            keep_ids = [index_to_id.get(idx) for idx in indexes if idx in index_to_id]
            invalid_indexes = [idx for idx in indexes if idx not in index_to_id]
            
            if invalid_indexes:
                warnings.append(f"keep: clip indexes {invalid_indexes} out of range (valid: 1-{len(clips)}), skipped")
            
            if keep_ids:
                operations.append({
                    "type": "keep",
                    "clipId": None,
                    "params": {"keepIds": keep_ids}
                })
            else:
                warnings.append(f"keep: no valid clip indexes found, keeping all clips")
    
    return operations, warnings


def _apply_operations_with_validation(clips: list, operations: list) -> tuple[list, list]:
    """
    Apply operations to clips with validation and auto-repair.
    Returns (final_clips, warnings).
    """
    current_clips = [dict(c) for c in clips]  # Deep copy
    warnings = []
    
    # Separate operations to run rename_by_position last
    standard_operations = [op for op in operations if op.get("type") != "rename_by_position"]
    rename_operations = [op for op in operations if op.get("type") == "rename_by_position"]
    
    for op in standard_operations:
        op_type = op.get("type")
        clip_id = op.get("clipId")
        params = op.get("params", {})
        
        if op_type == "rename":
            # Rename clip by ID
            for clip in current_clips:
                if clip.get("id") == clip_id:
                    new_title = params.get("title", "")
                    clip["title"] = new_title
                    clip["name"] = new_title
                    print(f"[rename] Renamed clip {clip_id} to '{new_title}'")
                    break

        elif op_type == "delete":
            # Delete clip by ID
            initial_count = len(current_clips)
            clip_to_delete = None
            
            # Find the clip to delete
            for clip in current_clips:
                if clip.get("id") == clip_id:
                    clip_to_delete = clip
                    break
            
            if clip_to_delete:
                print(f"[delete] Deleting clip: id={clip_id}, start={clip_to_delete.get('start')}, end={clip_to_delete.get('end')}, sourceStart={clip_to_delete.get('sourceStart')}, sourceEnd={clip_to_delete.get('sourceEnd')}, title={clip_to_delete.get('title', 'Untitled')}")
                print(f"[delete] Clips before delete: {len(current_clips)}")
                for i, c in enumerate(current_clips):
                    print(f"[delete]   Clip {i+1}: id={c.get('id')}, start={c.get('start')}, end={c.get('end')}, sourceStart={c.get('sourceStart')}, sourceEnd={c.get('sourceEnd')}, title={c.get('title', 'Untitled')}")
                
                # Delete the clip
                current_clips = [c for c in current_clips if c.get("id") != clip_id]
                
                print(f"[delete] Clips after delete: {len(current_clips)}")
                for i, c in enumerate(current_clips):
                    print(f"[delete]   Clip {i+1}: id={c.get('id')}, start={c.get('start')}, end={c.get('end')}, sourceStart={c.get('sourceStart')}, sourceEnd={c.get('sourceEnd')}, title={c.get('title', 'Untitled')}")
            else:
                print(f"[delete] WARNING: Clip {clip_id} not found in current clips")
                warnings.append(f"delete: clip {clip_id} not found, skipped")
        
        elif op_type == "cut_time":
            # Delete time range - FIXED: Maps to current edited timeline
            cut_start = params.get("start", 0)
            cut_end = params.get("end", 0)
            
            print(f"[cut_time] Deleting timeline range: {cut_start}s - {cut_end}s")
            print(f"[cut_time] Current clips before operation: {len(current_clips)}")
            
            new_clips = []
            current_timeline_pos = 0.0  # Track position in edited timeline
            
            for i, clip in enumerate(current_clips):
                clip_source_start = clip.get("sourceStart", clip.get("start", 0))
                clip_source_end = clip.get("sourceEnd", clip.get("end", 0))
                clip_duration = clip_source_end - clip_source_start

                # Calculate this clip's position in the edited timeline
                clip_timeline_start = current_timeline_pos
                clip_timeline_end = current_timeline_pos + clip_duration

                print(f"[cut_time] Clip {i + 1}: source={clip_source_start}-{clip_source_end}, timeline={clip_timeline_start:.2f}-{clip_timeline_end:.2f}, duration={clip_duration:.2f}s")

                # Check if delete range overlaps with this clip's timeline position
                if clip_timeline_end <= cut_start or clip_timeline_start >= cut_end:
                    # Outside cut range, keep as-is
                    print(f"[cut_time]   → Keep (outside delete range)")
                    new_clips.append(clip)
                    current_timeline_pos = clip_timeline_end

                elif clip_timeline_start >= cut_start and clip_timeline_end <= cut_end:
                    # Fully inside cut range, delete
                    print(f"[cut_time]   → Delete (fully inside delete range)")

                elif clip_timeline_start < cut_start and clip_timeline_end > cut_end:
                    # Cut in middle, split into two
                    print(f"[cut_time]   → Split (delete range in middle)")
                    keep_start_duration = cut_start - clip_timeline_start
                    keep_end_duration = clip_timeline_end - cut_end

                    left = dict(clip)
                    left["id"] = f"{clip.get('id', 'clip')}a"
                    left["start"] = clip_source_start
                    left["end"] = clip_source_start + keep_start_duration
                    left["sourceStart"] = clip_source_start
                    left["sourceEnd"] = clip_source_start + keep_start_duration
                    left["duration"] = keep_start_duration
                    if "segments" in left:
                        del left["segments"]

                    right = dict(clip)
                    right["id"] = f"{clip.get('id', 'clip')}b"
                    right["start"] = clip_source_end - keep_end_duration
                    right["end"] = clip_source_end
                    right["sourceStart"] = clip_source_end - keep_end_duration
                    right["sourceEnd"] = clip_source_end
                    right["duration"] = keep_end_duration
                    if "segments" in right:
                        del right["segments"]

                    if keep_start_duration >= 0.5:
                        print(f"[cut_time]     → Keep left: {left['sourceStart']:.2f}-{left['sourceEnd']:.2f} ({keep_start_duration:.2f}s)")
                        new_clips.append(left)
                        current_timeline_pos += keep_start_duration
                    else:
                        warnings.append(f"cut_time: left segment < 0.5s, dropped")

                    if keep_end_duration >= 0.5:
                        print(f"[cut_time]     → Keep right: {right['sourceStart']:.2f}-{right['sourceEnd']:.2f} ({keep_end_duration:.2f}s)")
                        new_clips.append(right)
                        current_timeline_pos += keep_end_duration
                    else:
                        warnings.append(f"cut_time: right segment < 0.5s, dropped")

                elif clip_timeline_start < cut_start:
                    # Trim end (delete range starts in middle of clip)
                    print(f"[cut_time]   → Trim end")
                    keep_duration = cut_start - clip_timeline_start

                    trimmed = dict(clip)
                    trimmed["start"] = clip_source_start
                    trimmed["end"] = clip_source_start + keep_duration
                    trimmed["sourceStart"] = clip_source_start
                    trimmed["sourceEnd"] = clip_source_start + keep_duration
                    trimmed["duration"] = keep_duration
                    if "segments" in trimmed:
                        del trimmed["segments"]

                    if keep_duration >= 0.5:
                        print(f"[cut_time]     → Keep: {trimmed['sourceStart']:.2f}-{trimmed['sourceEnd']:.2f} ({keep_duration:.2f}s)")
                        new_clips.append(trimmed)
                        current_timeline_pos += keep_duration
                    else:
                        warnings.append(f"cut_time: trimmed clip < 0.5s, dropped")
                else:
                    # Trim start (delete range ends in middle of clip)
                    print(f"[cut_time]   → Trim start")
                    delete_duration = cut_end - clip_timeline_start
                    keep_duration = clip_timeline_end - cut_end

                    trimmed = dict(clip)
                    trimmed["start"] = clip_source_start + delete_duration
                    trimmed["end"] = clip_source_end
                    trimmed["sourceStart"] = clip_source_start + delete_duration
                    trimmed["sourceEnd"] = clip_source_end
                    trimmed["duration"] = keep_duration
                    if "segments" in trimmed:
                        del trimmed["segments"]

                    if keep_duration >= 0.5:
                        print(f"[cut_time]     → Keep: {trimmed['sourceStart']:.2f}-{trimmed['sourceEnd']:.2f} ({keep_duration:.2f}s, deleted {delete_duration:.2f}s from start)")
                        new_clips.append(trimmed)
                        current_timeline_pos += keep_duration
                    else:
                        warnings.append(f"cut_time: trimmed clip < 0.5s, dropped")
            
            print(f"[cut_time] Result: {len(new_clips)} clips remaining")
            current_clips = new_clips
        
        elif op_type == "split":
            # Split clip at specified time - ENHANCED: Support multiple sequential splits
            split_time = params.get("split_time")
            
            # ENHANCED: Find the clip that contains this split time (for sequential splits)
            clip_to_split = None
            
            # First try to find by exact clip_id
            for clip in current_clips:
                if clip.get("id") == clip_id:
                    clip_to_split = clip
                    break
            
            # If not found by ID, find the clip that contains this timestamp
            if not clip_to_split and split_time is not None:
                print(f"[split] Clip {clip_id} not found, searching by timestamp {split_time}")
                
                # Convert to float to avoid string comparison issues
                try:
                    split_time = float(split_time)
                except Exception: pass
                for clip in current_clips:
                    source_start = clip.get("sourceStart", clip.get("start", 0))
                    source_end = clip.get("sourceEnd", clip.get("end", 0))
                    if source_start <= split_time <= source_end:
                        clip_to_split = clip
                        clip_id = clip.get("id")  # Update clip_id for logging
                        print(f"[split] Found clip {clip_id} containing timestamp {split_time}")
                        break
            
            if clip_to_split and split_time is not None:
                start = clip_to_split.get("start", 0)
                end = clip_to_split.get("end", 0)
                
                # Use sourceStart/sourceEnd if available (for proper video extraction)
                source_start = clip_to_split.get("sourceStart", start)
                source_end = clip_to_split.get("sourceEnd", end)
                
                # ENHANCED: Better split time interpretation
                # Always treat split_time as absolute time from original video start
                source_split_time = split_time
                
                # Validate that split_time falls within this clip's source range
                if not (source_start <= source_split_time <= source_end):
                    print(f"[split] WARNING: split_time {source_split_time:.2f} outside clip source range [{source_start:.2f}, {source_end:.2f}]")
                    # Try to interpret as timeline-relative
                    if start <= split_time <= end:
                        timeline_offset = split_time - start
                        source_split_time = source_start + timeline_offset
                        print(f"[split] Converted timeline {split_time:.2f} to source {source_split_time:.2f}")
                    else:
                        # AUTO-CORRECT: use midpoint of the clip
                        source_split_time = (source_start + source_end) / 2.0
                        print(f"[split] AUTO-CORRECTED split_time to midpoint: {source_split_time:.2f}")
                
                # Validate split_time is within source bounds with better tolerance
                if source_start + 1.0 < source_split_time < source_end - 1.0:
                    # Calculate durations
                    duration_a = source_split_time - source_start
                    duration_b = source_end - source_split_time
                    
                    print(f"[split] Splitting clip {clip_id} at source time {source_split_time:.2f}s")
                    print(f"[split]   Original: source={source_start:.2f}-{source_end:.2f}, timeline={start:.2f}-{end:.2f}")
                    print(f"[split]   Part A: source={source_start:.2f}-{source_split_time:.2f} ({duration_a:.2f}s)")
                    print(f"[split]   Part B: source={source_split_time:.2f}-{source_end:.2f} ({duration_b:.2f}s)")
                    
                    # Check minimum duration for both parts (reduced threshold)
                    if duration_a >= 1.0 and duration_b >= 1.0:
                        # Find the position of the original clip in the array
                        clip_index = None
                        for i, c in enumerate(current_clips):
                            if c.get("id") == clip_id:
                                clip_index = i
                                break
                        
                        # Create two new clips with clean, non-overlapping source ranges
                        original_title = clip_to_split.get('title') or clip_to_split.get('name') or ''
                        clip_a = dict(clip_to_split)
                        clip_a["id"] = f"{clip_to_split.get('id', 'clip')}-A"
                        clip_a["start"] = start
                        clip_a["end"] = start + duration_a
                        clip_a["sourceStart"] = source_start
                        clip_a["sourceEnd"] = source_split_time
                        clip_a["duration"] = duration_a
                        if "segments" in clip_a:
                            del clip_a["segments"]
                        # Inherit parent name — preserves custom names through splits
                        clip_a["title"] = original_title
                        clip_a["name"]  = original_title

                        clip_b = dict(clip_to_split)
                        clip_b["id"] = f"{clip_to_split.get('id', 'clip')}-B"
                        clip_b["start"] = start + duration_a
                        clip_b["end"] = start + duration_a + duration_b
                        clip_b["sourceStart"] = source_split_time
                        clip_b["sourceEnd"] = source_end
                        clip_b["duration"] = duration_b
                        if "segments" in clip_b:
                            del clip_b["segments"]
                        clip_b["title"] = original_title
                        clip_b["name"]  = original_title
                        
                        # Preserve external clip properties
                        if clip_to_split.get("externalId"):
                            clip_a["externalId"] = clip_to_split["externalId"]
                            clip_a["type"] = clip_to_split.get("type", "external")
                            clip_b["externalId"] = clip_to_split["externalId"]
                            clip_b["type"] = clip_to_split.get("type", "external")
                        
                        # Preserve transcript data if available
                        if clip_to_split.get("text"):
                            # Keep original transcript for both parts (AI will handle content later)
                            clip_a["text"] = clip_to_split["text"]
                            clip_b["text"] = clip_to_split["text"]
                        
                        print(f"[split] Created clean split:")
                        print(f"[split]   Clip A: timeline={clip_a['start']:.2f}-{clip_a['end']:.2f}, source={clip_a['sourceStart']:.2f}-{clip_a['sourceEnd']:.2f}")
                        print(f"[split]   Clip B: timeline={clip_b['start']:.2f}-{clip_b['end']:.2f}, source={clip_b['sourceStart']:.2f}-{clip_b['sourceEnd']:.2f}")
                        
                        # CRITICAL: Replace original clip with split clips in the same position
                        if clip_index is not None:
                            # Remove original clip and insert split clips at the same position
                            current_clips.pop(clip_index)
                            current_clips.insert(clip_index, clip_a)
                            current_clips.insert(clip_index + 1, clip_b)
                        else:
                            # Fallback: remove original and append split clips
                            current_clips = [c for c in current_clips if c.get("id") != clip_id]
                            current_clips.extend([clip_a, clip_b])
                        
                        print(f"[split] Split successful: 1 clip → 2 clips (total clips: {len(current_clips)})")
                        print(f"[split] Current clip order: {[c.get('id') for c in current_clips]}")
                    else:
                        if duration_a < 1.0:
                            warnings.append(f"split: first part of {clip_id} would be < 1.0s, skipped")
                        if duration_b < 1.0:
                            warnings.append(f"split: second part of {clip_id} would be < 1.0s, skipped")
                else:
                    print(f"[split] WARNING: split_time {source_split_time:.2f} not within valid bounds [{source_start + 1.0:.2f}, {source_end - 1.0:.2f}]")
                    warnings.append(f"split: split_time {source_split_time:.2f} not within valid bounds, skipped")
            else:
                if not clip_to_split:
                    warnings.append(f"split: clip {clip_id} not found, skipped")
                else:
                    warnings.append(f"split: missing split_time, skipped")
        
        elif op_type == "merge":
            # Merge clips - creates a single merged clip while preserving other clips
            merge_ids = params.get("mergeIds", [])
            to_merge = [c for c in current_clips if c.get("id") in merge_ids]
            
            print(f"[merge] Merging {len(to_merge)} clips: {merge_ids}")
            for i, c in enumerate(to_merge):
                print(f"[merge]   Clip {i+1}: id={c.get('id')}, start={c.get('start')}, end={c.get('end')}, sourceStart={c.get('sourceStart')}, sourceEnd={c.get('sourceEnd')}")
            
            if len(to_merge) >= 2:
                # Sort by timeline start time to maintain order
                to_merge.sort(key=lambda c: c.get("start", 0))
                
                first_clip = to_merge[0]
                
                # Calculate total duration of all clips being merged
                total_duration = sum(c.get("end", 0) - c.get("start", 0) for c in to_merge)
                
                # Create merged clip
                # CRITICAL: Use segment-based approach to avoid reintroducing deleted content
                merged = dict(first_clip)
                merged["id"] = first_clip.get("id")  # Keep first clip's ID
                merged["start"] = first_clip.get("start", 0)
                merged["end"] = first_clip.get("start", 0) + total_duration
                
                # CRITICAL FIX: DO NOT set sourceStart/sourceEnd as continuous range!
                # This would reintroduce deleted clips between merged segments.
                # Instead, ONLY use the segments array for extraction.
                
                # Remove sourceStart/sourceEnd to prevent continuous range extraction
                if "sourceStart" in merged:
                    del merged["sourceStart"]
                if "sourceEnd" in merged:
                    del merged["sourceEnd"]
                
                # Store the individual clip ranges for proper extraction
                # This is the ONLY source of truth for what content to extract
                merged["segments"] = [
                    {
                        "sourceStart": c.get("sourceStart", c.get("start", 0)),
                        "sourceEnd": c.get("sourceEnd", c.get("end", 0)),
                        "duration": c.get("end", 0) - c.get("start", 0)
                    }
                    for c in to_merge
                ]
                
                merged["title"] = " + ".join(c.get("title", c.get("id", "")) for c in to_merge)
                
                print(f"[merge] Created merged clip:")
                print(f"[merge]   id={merged['id']}")
                print(f"[merge]   timeline: start={merged['start']}, end={merged['end']} (duration={total_duration}s)")
                print(f"[merge]   NO sourceStart/sourceEnd (segment-based only)")
                print(f"[merge]   title=\"{merged['title']}\"")
                print(f"[merge]   segments={len(merged['segments'])} (ONLY source of extraction)")
                for i, seg in enumerate(merged["segments"]):
                    print(f"[merge]     Segment {i+1}: {seg['sourceStart']}-{seg['sourceEnd']} ({seg['duration']}s)")
                
                # Preserve external IDs if present
                external_ids = [c.get("externalId") for c in to_merge if c.get("externalId")]
                if external_ids:
                    merged["externalId"] = external_ids[0]
                    merged["type"] = "external"
                    if len(external_ids) > 1:
                        merged["mergedExternalIds"] = external_ids[1:]
                
                # CRITICAL: Replace first clip with merged, remove other merged clips, keep all others
                merge_id_set = set(merge_ids)
                new_clips = []
                merged_added = False
                
                for clip in current_clips:
                    clip_id = clip.get("id")
                    if clip_id == first_clip.get("id"):
                        # Replace first merged clip with the merged result
                        new_clips.append(merged)
                        merged_added = True
                        print(f"[merge]   Replaced {clip_id} with merged clip")
                    elif clip_id in merge_id_set:
                        # Skip other clips that were merged
                        print(f"[merge]   Removed {clip_id} (merged into {merged['id']})")
                        continue
                    else:
                        # Keep all other clips
                        new_clips.append(clip)
                        print(f"[merge]   Kept {clip_id} (not part of merge)")
                
                current_clips = new_clips
                
                print(f"[merge] Result: {len(current_clips)} clips remaining")
                print(f"[merge] Final order: {[c.get('id') for c in current_clips]}")
            else:
                print(f"[merge] WARNING: Insufficient clips found for merge")
                warnings.append(f"merge: insufficient clips found for merge, skipped")
        
        elif op_type == "swap":
            # Swap two clips in the array
            swap_ids = params.get("swapIds", [])
            if len(swap_ids) == 2:
                # Find indices of clips to swap
                id1, id2 = swap_ids[0], swap_ids[1]
                idx1, idx2 = None, None
                
                for i, clip in enumerate(current_clips):
                    if clip.get("id") == id1:
                        idx1 = i
                    if clip.get("id") == id2:
                        idx2 = i
                
                if idx1 is not None and idx2 is not None:
                    print(f"[swap] Swapping clips: {id1} (index {idx1}) ↔ {id2} (index {idx2})")
                    
                    # Swap clips in array
                    current_clips[idx1], current_clips[idx2] = current_clips[idx2], current_clips[idx1]
                    
                    # Rebuild timeline positions using source durations
                    print(f"[swap] Rebuilding timeline positions...")
                    current_time = 0.0
                    for i, clip in enumerate(current_clips):
                        src_s = clip.get("sourceStart", clip.get("start", 0))
                        src_e = clip.get("sourceEnd",   clip.get("end",   0))
                        duration = max(0.0, src_e - src_s)
                        clip["start"] = current_time
                        clip["end"] = current_time + duration
                        current_time += duration
                        print(f"[swap]   Clip {i}: id={clip.get('id')}, start={clip['start']}, end={clip['end']}")
                    
                    print(f"[swap] Result: clips swapped successfully")
                    print(f"[swap] Final order: {[c.get('id') for c in current_clips]}")
                else:
                    if idx1 is None:
                        print(f"[swap] WARNING: Clip {id1} not found")
                        warnings.append(f"swap: clip {id1} not found, skipped")
                    if idx2 is None:
                        print(f"[swap] WARNING: Clip {id2} not found")
                        warnings.append(f"swap: clip {id2} not found, skipped")
            else:
                print(f"[swap] WARNING: Expected 2 clip IDs, got {len(swap_ids)}")
                warnings.append(f"swap: expected 2 clip IDs, got {len(swap_ids)}, skipped")
        
        elif op_type == "duplicate":
            # Duplicate clip by ID
            clip_to_duplicate = None
            insert_index = -1
            
            for i, clip in enumerate(current_clips):
                if clip.get("id") == clip_id:
                    clip_to_duplicate = clip
                    insert_index = i
                    break
            
            if clip_to_duplicate:
                import uuid
                duplicated_clip = dict(clip_to_duplicate)
                duplicated_clip["id"] = f"{clip_to_duplicate.get('id', 'clip')}-copy-{str(uuid.uuid4())[:4]}"
                current_clips.insert(insert_index + 1, duplicated_clip)
                print(f"[duplicate] Duplicated clip {clip_id}")
            else:
                print(f"[duplicate] WARNING: Clip {clip_id} not found in current clips")
                warnings.append(f"duplicate: clip {clip_id} not found, skipped")
        
        elif op_type == "keep":
            # Keep only specified clips
            keep_ids = set(params.get("keepIds", []))
            initial_count = len(current_clips)
            current_clips = [c for c in current_clips if c.get("id") in keep_ids]
            if len(current_clips) == 0:
                warnings.append(f"keep: no clips matched keep list, operation skipped")
                current_clips = clips  # Restore original
    
    # Apply positional renames AT THE END so they work on the post-split/merge timeline
    for op in rename_operations:
        params = op.get("params", {})
        pos = params.get("position", 1)
        title = params.get("title", "")
        idx = pos - 1  # convert to 0-based
        if 0 <= idx < len(current_clips):
            current_clips[idx]["title"] = title
            current_clips[idx]["name"] = title
            print(f"[rename_by_position] Renamed position {pos} to '{title}'")
        else:
            warnings.append(f"rename_by_position: position {pos} out of range (have {len(current_clips)} clips), skipped")

    # Validate all clips
    validated_clips, validation_warnings = _validate_and_repair_clips(current_clips)
    warnings.extend(validation_warnings)
    
    return validated_clips, warnings


def _validate_and_repair_clips(clips: list) -> tuple[list, list]:
    """
    Validate clips and auto-repair common issues.
    Returns (repaired_clips, warnings).
    
    Validation rules:
    - start < end
    - duration >= 0.5s
    - times are non-negative
    """
    repaired = []
    warnings = []
    
    for clip in clips:
        clip_id = clip.get("id", "unknown")
        start = clip.get("start", 0)
        end = clip.get("end", 0)
        
        # Clamp to non-negative
        if start < 0:
            warnings.append(f"clip {clip_id}: start < 0, clamped to 0")
            start = 0
        if end < 0:
            warnings.append(f"clip {clip_id}: end < 0, clamped to 0")
            end = 0
        
        # Ensure start < end
        if start >= end:
            warnings.append(f"clip {clip_id}: start >= end, skipped")
            continue
        
        # Ensure minimum duration
        duration = end - start
        if duration < 0.5:
            warnings.append(f"clip {clip_id}: duration {duration:.2f}s < 0.5s, skipped")
            continue
        
        # Validate external clips
        if clip.get("type") and not clip.get("externalId"):
            warnings.append(f"clip {clip_id}: external clip missing externalId, skipped")
            continue
        
        # Validate reverse: externalId without type
        if clip.get("externalId") and not clip.get("type"):
            warnings.append(f"clip {clip_id}: has externalId but missing type field, skipped")
            continue
        
        # Clip is valid, add to result
        repaired_clip = dict(clip)
        repaired_clip["start"] = round(start, 2)
        repaired_clip["end"] = round(end, 2)
        repaired.append(repaired_clip)
    
    return repaired, warnings


def _normalize_timeline(clips: list) -> list:
    """
    Normalize timeline: recalculate timeline positions to be continuous.
    PRESERVES ARRAY ORDER - does NOT sort clips.
    Duration is always computed from sourceStart/sourceEnd (source video times).
    """
    if not clips:
        return []

    current_time = 0.0
    normalized_clips = []

    for i, clip in enumerate(clips):
        normalized_clip = dict(clip)

        # Duration comes from source times — these are always correct
        src_start = normalized_clip.get("sourceStart", normalized_clip.get("start", 0))
        src_end   = normalized_clip.get("sourceEnd",   normalized_clip.get("end",   0))

        # For merged clips, compute duration from segments array
        if normalized_clip.get("segments"):
            duration = sum(
                s.get("sourceEnd", s.get("end", 0)) - s.get("sourceStart", s.get("start", 0))
                for s in normalized_clip["segments"]
            )
        else:
            duration = max(0.0, src_end - src_start)

        # Ensure sourceStart/sourceEnd are set
        if "sourceStart" not in normalized_clip:
            normalized_clip["sourceStart"] = src_start
        if "sourceEnd" not in normalized_clip:
            normalized_clip["sourceEnd"] = src_end

        # Timeline positions
        normalized_clip["timelineStart"] = round(current_time, 3)
        normalized_clip["start"]         = round(current_time, 3)
        normalized_clip["end"]           = round(current_time + duration, 3)
        normalized_clip["duration"]      = round(duration, 3)

        # Name: keep existing custom name, or assign sequential fallback
        existing_title = normalized_clip.get("title", "") or normalized_clip.get("name", "")
        if existing_title:
            normalized_clip["title"] = existing_title
            normalized_clip["name"]  = existing_title
        else:
            normalized_clip["title"] = f"Clip {i + 1}"
            normalized_clip["name"]  = f"Clip {i + 1}"

        normalized_clips.append(normalized_clip)
        current_time += duration

    return normalized_clips


# ============================================================================
# END ROBUSTNESS LAYER
# ============================================================================


@app.post("/api/videos/{session_id}/build-composition")
async def build_composition(session_id: str, body: BuildCompositionRequest):
    """
    Convert simple clips array to full Remotion CompositionSchema.
    This endpoint bridges AI editing output with Remotion rendering input.
    """
    import json as _json
    from datetime import datetime
    
    timestamp = datetime.now().isoformat()
    
    print("=" * 80)
    print(f"[{timestamp}] [build-composition] CALLED")
    print(f"[{timestamp}] [build-composition] session_id={session_id}")
    print(f"[{timestamp}] [build-composition] Number of clips received: {len(body.clips)}")
    print(f"[{timestamp}] [build-composition] Clips data:")
    for i, clip in enumerate(body.clips):
        print(f"[{timestamp}] [build-composition]   Clip {i + 1}: start={clip.get('start')}, end={clip.get('end')}, title=\"{clip.get('title', 'N/A')}\", id={clip.get('id', 'N/A')}")
    print("=" * 80)
    
    clips = body.clips
    options = body.options
    
    if not clips:
        raise HTTPException(status_code=400, detail="No clips provided")
    
    # Get video file path
    try:
        video_path = _get_video_path(session_id)
        print(f"[{timestamp}] [build-composition] video_path={video_path}")
    except HTTPException as e:
        raise e
    
    # Extract options
    fps = options.get("fps", 30)
    width = options.get("width", 1920)
    height = options.get("height", 1080)
    
    print(f"[{timestamp}] [build-composition] fps={fps}, resolution={width}x{height}")
    
    # Calculate total duration
    total_duration = sum(clip.get("end", 0) - clip.get("start", 0) for clip in clips)
    duration_in_frames = int(total_duration * fps)
    
    print(f"[{timestamp}] [build-composition] total_duration={total_duration}s, frames={duration_in_frames}")
    
    # Convert clips to Remotion format
    remotion_clips = []
    current_frame = 0
    
    print(f"[{timestamp}] [build-composition] FINAL CLIPS FOR EXPORT:")
    for i, clip in enumerate(clips):
        print(f"[{timestamp}] [build-composition]   Clip {i+1}: start={clip.get('start')}, end={clip.get('end')}, sourceStart={clip.get('sourceStart')}, sourceEnd={clip.get('sourceEnd')}, title=\"{clip.get('title', 'N/A')}\"")
    
    for i, clip in enumerate(clips):
        # Calculate Remotion start frame based on absolute timeline placement
        timeline_start = float(clip.get("start", 0))
        start_from_frame = int(timeline_start * fps)
        
        # Check if this is a merged clip with multiple segments
        if "segments" in clip and clip["segments"]:
            # This is a merged clip with segment-based extraction
            print(f"[{timestamp}] [build-composition] Processing merged clip {i + 1} with {len(clip['segments'])} segments")
            
            # Calculate total duration from all segments
            total_duration = sum(seg.get("duration", 0) for seg in clip["segments"])
            duration_frames = int(total_duration * fps)
            
            remotion_clip = {
                "id": clip.get("id", f"clip-{i + 1}"),
                "src": f"/api/videos/{session_id}/stream",
                "startFrom": start_from_frame,
                "durationInFrames": duration_frames,
                "volume": 1.0,
                "segments": clip["segments"]  # Pass through segments for extraction
            }
            
            print(f"[{timestamp}] [build-composition] Merged clip {i+1}: {len(clip['segments'])} segments, total duration={total_duration}s")
            for j, seg in enumerate(clip["segments"]):
                print(f"[{timestamp}] [build-composition]   Segment {j+1}: {seg['sourceStart']}-{seg['sourceEnd']} ({seg['duration']}s)")
        else:
            # Regular clip - single segment
            # CRITICAL: Use sourceStart/sourceEnd for video extraction (original timestamps)
            # NOT start/end (which are normalized timeline positions)
            source_start = clip.get("sourceStart", clip.get("start", 0))
            source_end = clip.get("sourceEnd", clip.get("end", 0))
            duration = source_end - source_start
            duration_frames = int(duration * fps)
            
            print(f"[{timestamp}] [build-composition] Processing clip {i + 1}: sourceStart={source_start}s, sourceEnd={source_end}s (duration: {duration}s, {duration_frames} frames)")
            
            asset_url = clip.get("assetUrl")
            if asset_url:
                # Proxy endpoints properly configured in rendering script later
                src = asset_url
            else:
                src = f"/api/videos/{session_id}/stream"
            
            remotion_clip = {
                "id": clip.get("id", f"clip-{i + 1}"),
                "src": src,
                "startFrom": start_from_frame,
                "durationInFrames": duration_frames,
                "sourceStart": source_start,
                "sourceEnd": source_end,
                "volume": clip.get("volume", 1.0),
                "assetKind": clip.get("assetKind")
            }
        
        # Preserve external clip properties
        if clip.get("type"):
            remotion_clip["type"] = clip["type"]
        if clip.get("externalId"):
            remotion_clip["externalId"] = clip["externalId"]
        
        remotion_clips.append(remotion_clip)
        
        print(f"[{timestamp}] [build-composition] clip {i+1}: frames {remotion_clip['startFrom']}-{remotion_clip['startFrom'] + remotion_clip['durationInFrames']}")
    
    # Build composition schema
    composition = {
        "id": f"composition-{session_id}",
        "fps": fps,
        "width": width,
        "height": height,
        "durationInFrames": duration_in_frames,
        "clips": remotion_clips,
        "subtitles": [],
        "transitions": {
            "enabled": False,
            "type": "none",
            "durationInFrames": 0
        }
    }
    
    print(f"[{timestamp}] [build-composition] composition built: {len(remotion_clips)} clips, {duration_in_frames} frames")
    
    return JSONResponse(composition)


@app.post("/api/videos/{session_id}/export-with-clips")
async def export_with_clips(session_id: str, body: BuildCompositionRequest):
    """
    Export endpoint: concatenates all timeline clips (original video + assets) using FFmpeg.
    Each clip is extracted/downloaded separately then concatenated in order.
    """
    import tempfile, httpx
    from datetime import datetime
    timestamp = datetime.now().isoformat()

    print(f"[{timestamp}] [export-with-clips] session_id={session_id}, clips={len(body.clips)}")

    if not body.clips:
        raise HTTPException(status_code=400, detail="No clips provided.")

    # Resolve original video path
    video_path = None
    if session_id in session_store:
        stored = Path(session_store[session_id])
        if stored.exists():
            video_path = stored
    if video_path is None:
        for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
            candidate = UPLOAD_DIR / f"{session_id}{ext}"
            if candidate.exists():
                video_path = candidate
                break
    if video_path is None:
        raise HTTPException(status_code=404, detail=f"Video file not found for session {session_id}")

    temp_files = []
    concat_list_path = UPLOAD_DIR / f"{session_id}_export_concat.txt"

    try:
        # Flatten clips that contain 'segments'
        flattened_clips = []
        for clip in body.clips:
            if clip.get("segments"):
                for seg in clip["segments"]:
                    flat = dict(clip)
                    flat["sourceStart"] = seg.get("sourceStart", seg.get("start", 0))
                    flat["sourceEnd"] = seg.get("sourceEnd", seg.get("end", 0))
                    flat.pop("segments", None)
                    flattened_clips.append(flat)
            else:
                flattened_clips.append(clip)

        for i, clip in enumerate(flattened_clips):
            asset_url = clip.get("assetUrl")
            src_start  = float(clip.get("sourceStart", clip.get("start", 0)))
            src_end    = float(clip.get("sourceEnd",   clip.get("end",   0)))
            duration   = src_end - src_start

            if duration <= 0:
                print(f"[export-with-clips] Skipping clip {i+1} with zero duration")
                continue

            out_path = UPLOAD_DIR / f"{session_id}_export_clip_{i+1}.mp4"
            temp_files.append(out_path)

            if asset_url:
                # Asset clip — download if external, or use local path
                if asset_url.startswith("/api/"):
                    # Local asset — serve directly via ffmpeg
                    local_asset = None
                    # Try to find the file
                    if "ai-image" in asset_url:
                        img_id = asset_url.split("/")[-1]
                        local_asset = UPLOAD_DIR / f"ai_img_{img_id}.jpg"
                    elif "assets" in asset_url and "stream" in asset_url:
                        asset_id = asset_url.split("/")[-2]
                        for ext in [".mp4", ".mov", ".jpg", ".jpeg", ".png", ".webp"]:
                            candidate = UPLOAD_DIR / f"asset_{asset_id}{ext}"
                            if candidate.exists():
                                local_asset = candidate
                                break

                    if local_asset and local_asset.exists():
                        # Photo: create a video from the image (must re-encode)
                        if local_asset.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]:
                            result = subprocess.run([
                                "ffmpeg", "-loop", "1", "-i", str(local_asset),
                                "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                                "-t", str(duration), "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", "-y", str(out_path)
                            ], capture_output=True, text=True)
                        else:
                            result = subprocess.run([
                                "ffmpeg", "-ss", "0", "-t", str(duration), "-i", str(local_asset),
                                "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
                                "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2", "-y", str(out_path)
                            ], capture_output=True, text=True)
                    else:
                        # Skip unknown local asset
                        print(f"[export-with-clips] Cannot find local asset for {asset_url}, skipping")
                        temp_files.pop()
                        continue
                else:
                    # External URL — download first
                    print(f"[export-with-clips] Downloading asset: {asset_url[:80]}")
                    try:
                        async with httpx.AsyncClient(timeout=30.0) as hc:
                            r = await hc.get(asset_url)
                            r.raise_for_status()
                            content = r.content
                        dl_path = UPLOAD_DIR / f"{session_id}_asset_dl_{i+1}.tmp"
                        dl_path.write_bytes(content)
                        temp_files.append(dl_path)
                        
                        # Detect if it's an image or video by checking content
                        is_image = dl_path.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"] or content[:8] == b'\xff\xd8\xff' or content[:4] == b'\x89PNG'
                        
                        if is_image:
                            result = subprocess.run([
                                "ffmpeg", "-loop", "1", "-i", str(dl_path),
                                "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                                "-t", str(duration), "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", "-y", str(out_path)
                            ], capture_output=True, text=True)
                        else:
                            result = subprocess.run([
                                "ffmpeg", "-ss", "0", "-t", str(duration), "-i", str(dl_path),
                                "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
                                "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2", "-y", str(out_path)
                            ], capture_output=True, text=True)
                    except Exception as e:
                        print(f"[export-with-clips] Failed to download asset: {e}, skipping")
                        temp_files.pop()
                        continue
            else:
                result = subprocess.run([
                    "ffmpeg",
                    "-ss", str(src_start), "-t", str(duration),
                    "-i", str(video_path),
                    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2",
                    "-y", str(out_path)
                ], capture_output=True, text=True)

            if result.returncode != 0:
                print(f"[export-with-clips] ffmpeg error clip {i+1}: {result.stderr[-300:]}")
                raise HTTPException(status_code=500, detail=f"Failed to process clip {i+1}: {result.stderr[-200:]}")

            print(f"[export-with-clips] Clip {i+1} ready: {out_path}")

        # Filter to only files that exist
        valid_clips = [f for f in temp_files if f.exists() and str(f).endswith(".mp4")]

        if not valid_clips:
            raise HTTPException(status_code=400, detail="No clips could be processed for export.")

        if len(valid_clips) == 1:
            # Single clip — return directly
            output_path = valid_clips[0]
        else:
            # Multiple clips — concatenate
            with open(concat_list_path, 'w') as f:
                for clip_file in valid_clips:
                    escaped = str(clip_file.absolute()).replace('\\', '/')
                    f.write(f"file '{escaped}'\n")

            output_path = UPLOAD_DIR / f"{session_id}_export_final.mp4"
            temp_files.append(output_path)

            result = subprocess.run([
                "ffmpeg", "-f", "concat", "-safe", "0",
                "-i", str(concat_list_path),
                "-c", "copy", "-y", str(output_path)
            ], capture_output=True, text=True)

            if result.returncode != 0:
                print(f"[export-with-clips] concat error: {result.stderr[-300:]}")
                raise HTTPException(status_code=500, detail=f"Failed to concatenate clips: {result.stderr[-200:]}")

        print(f"[export-with-clips] Export complete: {output_path}")
        return FileResponse(
            str(output_path),
            media_type="video/mp4",
            filename=f"export-{session_id[:8]}.mp4"
        )

    finally:
        # Clean up temp files (except the final output which FileResponse will serve)
        output_path_local = locals().get('output_path')
        for f in temp_files:
            try:
                if f.exists() and f != output_path_local:
                    f.unlink()
            except Exception:
                pass
        if concat_list_path.exists():
            try: concat_list_path.unlink()
            except Exception: pass


@app.post("/api/videos/{session_id}/export-remotion")
async def export_video_remotion(session_id: str, body: RemotionExportRequest):
    """
    Export video using Remotion renderer with automatic FFmpeg fallback.
    Accepts a CompositionSchema and rendering options.
    Returns the rendered mp4 as a downloadable file.
    """
    import json as _json
    import tempfile
    from datetime import datetime

    timestamp = datetime.now().isoformat()
    print(f"[{timestamp}] [export-remotion] session_id={session_id}")

    # Validate composition schema
    composition = body.composition
    if not composition:
        error = {
            "errorType": "VALIDATION_ERROR",
            "message": "Composition schema is required",
            "suggestion": "Provide a valid CompositionSchema object in the request body",
            "statusCode": 400
        }
        print(f"[{timestamp}] [export-remotion] Validation error: {error['message']}")
        raise HTTPException(status_code=400, detail=error)

    # Validate required composition fields
    required_fields = ["id", "fps", "width", "height", "durationInFrames", "clips"]
    missing_fields = [f for f in required_fields if f not in composition]
    if missing_fields:
        error = {
            "errorType": "VALIDATION_ERROR",
            "message": f"Missing required composition fields: {', '.join(missing_fields)}",
            "suggestion": "Ensure CompositionSchema includes all required fields: id, fps, width, height, durationInFrames, clips",
            "statusCode": 400
        }
        print(f"[{timestamp}] [export-remotion] Validation error: {error['message']}")
        raise HTTPException(status_code=400, detail=error)

    # Validate session exists
    video_path = None
    if session_id in session_store:
        stored = Path(session_store[session_id])
        if stored.exists():
            video_path = stored

    if video_path is None:
        for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
            candidate = UPLOAD_DIR / f"{session_id}{ext}"
            if candidate.exists():
                video_path = candidate
                break

    if video_path is None:
        error = {
            "errorType": "NOT_FOUND",
            "message": f"Video file not found for session {session_id}",
            "suggestion": "Verify the session ID is correct and the video was uploaded successfully",
            "statusCode": 404
        }
        print(f"[{timestamp}] [export-remotion] Not found error: {error['message']}")
        raise HTTPException(status_code=404, detail=error)

    print(f"[{timestamp}] [export-remotion] source video: {video_path}")

    # Prepare composition data
    options = body.options

    # Convert relative clip URLs to absolute HTTP URLs for Remotion
    try:
        for clip in composition.get("clips", []):
            src = clip.get("src", "")
            # Ensure ANY relative /api URL becomes an absolute URL for Remotion to access
            if src.startswith("/api/"):
                clip["src"] = f"http://localhost:8000{src}"
                print(f"[{timestamp}] [export-remotion] Converted clip src: {src} → {clip['src']}")
            elif src.startswith("http://") or src.startswith("https://"):
                # Already an absolute URL, keep as-is
                print(f"[{timestamp}] [export-remotion] Clip src already absolute: {src}")
            else:
                # Unknown format
                error = {
                    "errorType": "VALIDATION_ERROR",
                    "message": f"Invalid clip src format: {src}. Expected /api/videos/{{id}}/stream or http(s):// URL",
                    "suggestion": "Ensure clip src is a valid API endpoint or HTTP URL",
                    "statusCode": 400
                }
                print(f"[{timestamp}] [export-remotion] Validation error: {error['message']}")
                raise HTTPException(status_code=400, detail=error)
    except HTTPException:
        raise
    except Exception as e:
        error = {
            "errorType": "VALIDATION_ERROR",
            "message": f"Failed to process clip sources: {str(e)}",
            "suggestion": "Check that all clip src URLs are valid",
            "statusCode": 400
        }
        print(f"[{timestamp}] [export-remotion] Validation error: {error['message']}, stack: {e}")
        raise HTTPException(status_code=400, detail=error)

    # Prepare output path
    output_path = UPLOAD_DIR / f"{session_id}_remotion_export.mp4"
    print(f"[{timestamp}] [export-remotion] output path: {output_path}")

    # Write composition to temporary JSON file
    temp_composition_file = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            _json.dump(composition, f)
            temp_composition_file = f.name
        
        print(f"[{timestamp}] [export-remotion] Composition written to: {temp_composition_file}")

        # Prepare options JSON
        options_json = _json.dumps(options)

        # Spawn Node.js render process
        # Use absolute path to remotion_render.js to avoid path issues
        script_dir = Path(__file__).parent
        remotion_script = script_dir / "remotion_render.js"
        
        print(f"[{timestamp}] [export-remotion] Spawning Node.js render process...")
        print(f"[{timestamp}] [export-remotion] Script path: {remotion_script}")
        result = subprocess.run(
            [
                "node",
                str(remotion_script),
                temp_composition_file,
                str(output_path),
                options_json
            ],
            capture_output=True,
            text=True,
            timeout=600  # 10 minutes timeout
        )

        print(f"[{timestamp}] [export-remotion] Node.js process exit code: {result.returncode}")
        print(f"[{timestamp}] [export-remotion] stdout: {result.stdout}")
        if result.stderr:
            print(f"[{timestamp}] [export-remotion] stderr: {result.stderr}")

        # Check if rendering succeeded
        if result.returncode == 0 and output_path.exists():
            print(f"[{timestamp}] [export-remotion] ✓ REMOTION RENDER SUCCESSFUL")
            print(f"[{timestamp}] [export-remotion] Output file size: {output_path.stat().st_size} bytes")
            return FileResponse(
                path=str(output_path),
                media_type="video/mp4",
                filename=f"remotion_{session_id[:8]}.mp4",
                headers={
                    "Content-Disposition": f'attachment; filename="remotion_{session_id[:8]}.mp4"'
                }
            )
        else:
            # Remotion failed, fallback to FFmpeg
            print("=" * 80)
            print(f"[{timestamp}] [FALLBACK] ✗ REMOTION FAILED - Using FFmpeg instead")
            print(f"[{timestamp}] [FALLBACK] Return code: {result.returncode}")
            print(f"[{timestamp}] [FALLBACK] Output exists: {output_path.exists()}")
            print(f"[{timestamp}] [FALLBACK] Remotion stderr: {result.stderr}")
            print("=" * 80)
            return await _export_video_ffmpeg_fallback(session_id, composition)

    except subprocess.TimeoutExpired:
        error_msg = f"Render timeout after 600 seconds"
        print("=" * 80)
        print(f"[{timestamp}] [FALLBACK] ✗ REMOTION TIMEOUT - Using FFmpeg instead")
        print(f"[{timestamp}] [FALLBACK] {error_msg}")
        print("=" * 80)
        try:
            return await _export_video_ffmpeg_fallback(session_id, composition)
        except Exception as fallback_error:
            error = {
                "errorType": "TIMEOUT",
                "message": error_msg,
                "suggestion": "Try reducing video duration or resolution, or use FFmpeg export endpoint",
                "statusCode": 500
            }
            print(f"[{timestamp}] [export-remotion] FFmpeg fallback also failed: {fallback_error}")
            raise HTTPException(status_code=500, detail=error)
    
    except FileNotFoundError:
        error = {
            "errorType": "DEPENDENCY_MISSING",
            "message": "Node.js not found",
            "suggestion": "Install Node.js (v18 or later) to use Remotion rendering. FFmpeg export is still available at /api/videos/{session_id}/export",
            "statusCode": 503
        }
        print(f"[{timestamp}] [export-remotion] Dependency error: {error['message']}")
        raise HTTPException(status_code=503, detail=error)
    
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        print("=" * 80)
        print(f"[{timestamp}] [FALLBACK] ✗ REMOTION ERROR - Attempting FFmpeg fallback")
        print(f"[{timestamp}] [FALLBACK] {error_msg}")
        print("=" * 80)
        import traceback
        print(f"[{timestamp}] [export-remotion] Stack trace: {traceback.format_exc()}")
        
        # Try FFmpeg fallback
        try:
            print(f"[{timestamp}] [export-remotion] Attempting FFmpeg fallback")
            return await _export_video_ffmpeg_fallback(session_id, composition)
        except Exception as fallback_error:
            error = {
                "errorType": "RENDER_ERROR",
                "message": f"Both Remotion and FFmpeg export failed",
                "suggestion": "Check server logs for details. Remotion error: {str(e)}, FFmpeg error: {str(fallback_error)}",
                "statusCode": 500
            }
            print(f"[{timestamp}] [export-remotion] FFmpeg fallback also failed: {fallback_error}")
            raise HTTPException(status_code=500, detail=error)
    
    finally:
        # Clean up temporary composition file
        if temp_composition_file and Path(temp_composition_file).exists():
            try:
                Path(temp_composition_file).unlink()
                print(f"[{timestamp}] [export-remotion] Cleaned up temp file: {temp_composition_file}")
            except Exception as e:
                print(f"[{timestamp}] [export-remotion] Failed to clean up temp file: {e}")


async def _export_video_ffmpeg_fallback(session_id: str, composition: dict):
    """
    Fallback to FFmpeg export when Remotion fails.
    Converts Remotion composition to FFmpeg clip format.
    Handles merged clips with segments by extracting each segment separately.
    """
    print("=" * 80)
    print(f"[ffmpeg-fallback] ✓ FFMPEG FALLBACK ACTIVATED")
    print(f"[ffmpeg-fallback] Converting Remotion composition to FFmpeg format")
    print("=" * 80)
    
    # Extract clips from composition
    clips = []
    for clip in composition.get("clips", []):
        # Check if this is a merged clip with multiple segments
        if "segments" in clip and clip["segments"]:
            # This is a merged clip - extract each segment separately
            print(f"[ffmpeg-fallback] Detected merged clip with {len(clip['segments'])} segments")
            for i, segment in enumerate(clip["segments"]):
                clips.append({
                    "start": segment.get("sourceStart", 0),
                    "end": segment.get("sourceEnd", 0)
                })
                print(f"[ffmpeg-fallback]   Segment {i+1}: {segment['sourceStart']}-{segment['sourceEnd']}")
        else:
            # Regular clip - extract single segment
            # Only extract if sourceStart/sourceEnd exist
            if "sourceStart" in clip and "sourceEnd" in clip:
                source_start = clip.get("sourceStart", 0)
                source_end = clip.get("sourceEnd", 0)
                
                clips.append({
                    "start": source_start,
                    "end": source_end
                })
                print(f"[ffmpeg-fallback] Regular clip: {source_start}-{source_end}")
            else:
                print(f"[ffmpeg-fallback] WARNING: Clip {clip.get('id')} has no sourceStart/sourceEnd and no segments, skipping")
    
    if not clips:
        raise HTTPException(status_code=400, detail="No clips to export")
    
    print(f"[ffmpeg-fallback] Converted {len(clips)} clips, calling FFmpeg export")
    
    # Use existing FFmpeg export logic
    export_request = ExportRequest(clips=clips)
    result = await export_video(session_id, export_request)

    # Post-process: make exported audio very loud for the whole duration.
    # Aggressive but capped using ffmpeg's volume filter.
    loud_gain = 2.5
    try:
        if hasattr(result, "path") and result.path:
            in_path = Path(result.path)
            if in_path.exists():
                tmp_path = in_path.with_suffix(".loud.tmp.mp4")
                subprocess.run([
                    "ffmpeg",
                    "-y",
                    "-i", str(in_path),
                    "-af", f"volume={loud_gain}",
                    "-c:v", "copy",
                    "-c:a", "aac",
                    "-b:a", "192k",
                    "-movflags", "+faststart",
                    str(tmp_path)
                ], check=True, capture_output=True, text=True)
                tmp_path.replace(in_path)
    except Exception as e:
        print(f"[ffmpeg-fallback] loudness post-process failed (non-fatal): {e}")

    return result



@app.post("/api/videos/{session_id}/export")
async def export_video(session_id: str, body: ExportRequest):
    """
    DEPRECATED: Legacy FFmpeg-only export endpoint.
    
    For new implementations, use /api/videos/{session_id}/export-with-clips instead.
    That endpoint uses Remotion for rendering with automatic FFmpeg fallback.
    
    This endpoint exports edited video by concatenating only the clip segments using ffmpeg.
    Returns the rendered mp4 as a downloadable file.
    """
    import json as _json
    import tempfile
    from datetime import datetime
    
    timestamp = datetime.now().isoformat()
    print("=" * 80)
    print(f"[{timestamp}] [EXPORT-LEGACY] Old /export endpoint called")
    print(f"[{timestamp}] [EXPORT-LEGACY] Consider migrating to /export-with-clips for Remotion support")
    print(f"[{timestamp}] [EXPORT-LEGACY] session_id: {session_id}, clips: {len(body.clips)}")
    print("=" * 80)

    if not body.clips:
        raise HTTPException(status_code=400, detail="No clips provided.")

    # Resolve source video path
    video_path = None
    if session_id in session_store:
        stored = Path(session_store[session_id])
        if stored.exists():
            video_path = stored

    if video_path is None:
        for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
            candidate = UPLOAD_DIR / f"{session_id}{ext}"
            if candidate.exists():
                video_path = candidate
                break

    if video_path is None:
        raise HTTPException(status_code=404, detail=f"Video file not found for session {session_id}")

    print(f"[export] session_id={session_id}, clips={len(body.clips)}, source={video_path}")

    # DO NOT SORT - preserve array order for user-defined sequencing (e.g., swaps)
    # Flatten merged clips
    clips = []
    for clip in body.clips:
        if clip.get("segments"):
            for seg in clip["segments"]:
                flat = dict(clip)
                flat["sourceStart"] = seg.get("sourceStart", seg.get("start", 0))
                flat["sourceEnd"] = seg.get("sourceEnd", seg.get("end", 0))
                flat.pop("segments", None)
                clips.append(flat)
        else:
            clips.append(clip)
    
    # Debug: Log clip order before export
    print(f"[export] Clip order before export:")
    for i, clip in enumerate(clips):
        print(f"[export]   {i}: id={clip.get('id')}, sourceStart={clip.get('sourceStart')}, sourceEnd={clip.get('sourceEnd')}")

    # Build a single-pass filter_complex for maximum speed
    # Strategy: Do all trimming and concatenation in memory without temp files
    try:
        filter_chains = []
        concat_inputs = ""
        valid_clip_count = 0

        for i, clip in enumerate(clips):
            source_start = float(clip.get("sourceStart", clip.get("start", 0)))
            source_end = float(clip.get("sourceEnd", clip.get("end", 0)))
            duration = source_end - source_start
            
            if duration <= 0:
                print(f"[export] Skipping clip {i} with zero/negative duration: {source_start}-{source_end}")
                continue

            # Video trim
            filter_chains.append(f"[0:v]trim=start={source_start}:end={source_end},setpts=PTS-STARTPTS[v{valid_clip_count}];")
            # Audio trim
            filter_chains.append(f"[0:a]atrim=start={source_start}:end={source_end},asetpts=PTS-STARTPTS[a{valid_clip_count}];")
            
            concat_inputs += f"[v{valid_clip_count}][a{valid_clip_count}]"
            valid_clip_count += 1

        if valid_clip_count == 0:
            raise HTTPException(status_code=400, detail="No valid clips to export.")

        # Final concatenation node
        filter_chains.append(f"{concat_inputs}concat=n={valid_clip_count}:v=1:a=1[outv][outa]")
        filter_complex = "".join(filter_chains)

        output_path = UPLOAD_DIR / f"{session_id}_export.mp4"
        print(f"[export] Exporting {valid_clip_count} segments via single-pass filter_complex → {output_path}")

        result = subprocess.run([
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-filter_complex", filter_complex,
            "-map", "[outv]",
            "-map", "[outa]",
            "-c:v", "libx264", 
            "-c:a", "aac",
            "-preset", "fast",
            str(output_path)
        ], capture_output=True)

        if result.returncode != 0:
            err = result.stderr.decode()
            print(f"[export] ffmpeg single-pass export failed: {err}")
            raise HTTPException(status_code=500, detail=f"Failed to export video: {err[:200]}")

        print(f"[export] Export complete: {output_path}")
        return FileResponse(
            path=str(output_path),
            media_type="video/mp4",
            filename=f"edited_{session_id[:8]}.mp4",
            headers={
                "Content-Disposition": f'attachment; filename="edited_{session_id[:8]}.mp4"'
            }
        )

    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg not found. Please install ffmpeg and ensure it is on your PATH.")
    except Exception as e:
        print(f"[export] exception: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


@app.get("/api/proxy-image")
async def proxy_image(url: str):
    """
    Proxy external images (Pixabay CDN) to avoid CORS issues in the browser.
    """
    import httpx
    from fastapi.responses import Response
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            content_type = r.headers.get("content-type", "image/jpeg")
            return Response(content=r.content, media_type=content_type)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to proxy image: {str(e)}")


@app.get("/api/proxy-video")
async def proxy_video(url: str, request: Request):
    """
    Proxy external video files (Pixabay CDN) to avoid CORS issues.
    Streams chunk-by-chunk to support Range requests and fast seeking.
    """
    import httpx
    from fastapi.responses import StreamingResponse

    req_headers = {"User-Agent": "Mozilla/5.0"}
    range_header = request.headers.get("range")
    if range_header:
        req_headers["Range"] = range_header

    try:
        client_http = httpx.AsyncClient(timeout=60.0, follow_redirects=True)
        upstream_req = client_http.build_request("GET", url, headers=req_headers)
        upstream = await client_http.send(upstream_req, stream=True)

        content_type = upstream.headers.get("content-type", "video/mp4")
        resp_headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }
        for h in ("content-length", "content-range"):
            if h in upstream.headers:
                resp_headers[h.title()] = upstream.headers[h]

        status = upstream.status_code if upstream.status_code in (200, 206) else 200

        async def stream_gen():
            try:
                async for chunk in upstream.aiter_bytes(chunk_size=65536):
                    yield chunk
            finally:
                await upstream.aclose()
                await client_http.aclose()

        return StreamingResponse(
            stream_gen(), status_code=status,
            headers=resp_headers, media_type=content_type
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to proxy video: {str(e)}")




@app.get("/api/proxy-audio")
async def proxy_audio(url: str, request: Request):
    """
    Proxy external audio previews to avoid CORS issues in the browser.
    Supports Range requests so the native audio element can buffer and seek.
    """
    import httpx
    from fastapi.responses import StreamingResponse

    req_headers = {"User-Agent": "Mozilla/5.0"}
    range_header = request.headers.get("range")
    if range_header:
        req_headers["Range"] = range_header

    try:
        client_http = httpx.AsyncClient(timeout=60.0, follow_redirects=True)
        upstream_req = client_http.build_request("GET", url, headers=req_headers)
        upstream = await client_http.send(upstream_req, stream=True)

        content_type = upstream.headers.get("content-type", "audio/mpeg")
        resp_headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }
        for h in ("content-length", "content-range"):
            if h in upstream.headers:
                resp_headers[h.title()] = upstream.headers[h]

        status = upstream.status_code if upstream.status_code in (200, 206) else 200

        async def stream_gen():
            try:
                async for chunk in upstream.aiter_bytes(chunk_size=65536):
                    yield chunk
            finally:
                await upstream.aclose()
                await client_http.aclose()

        return StreamingResponse(
            stream_gen(), status_code=status,
            headers=resp_headers, media_type=content_type
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to proxy audio: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
