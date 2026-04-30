"""
FastAPI Backend for Video Editor
Provides endpoints for video upload, transcription, and exportop
"""

import os
from dotenv import load_dotenv

# Load .env file from the backend directory
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env'))
if not os.getenv("OPENAI_API_KEY"):
    print("❌ API Key not found")
else:
    print("✅ API Key loaded")

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

# Transcription cache — persisted to disk so transcriptions survive restarts
TRANSCRIPTION_CACHE_PATH = Path("uploads/.transcriptions.json")

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

def _load_transcription_cache() -> dict:
    """Load transcription cache from disk"""
    if TRANSCRIPTION_CACHE_PATH.exists():
        try:
            import json
            return json.loads(TRANSCRIPTION_CACHE_PATH.read_text())
        except Exception:
            return {}
    return {}

def _save_transcription_cache(cache: dict) -> None:
    """Save transcription cache to disk"""
    import json
    TRANSCRIPTION_CACHE_PATH.write_text(json.dumps(cache, indent=2))

def _get_cache_key(session_id: str, clips: list = None) -> str:
    """Generate a cache key for transcription based on session and clips"""
    import hashlib
    
    if clips and len(clips) > 0:
        # For edited mode, include clip timings in the cache key
        clips_str = str(sorted([(c.get('start', 0), c.get('end', 0)) for c in clips]))
        cache_key = f"{session_id}_edited_{hashlib.md5(clips_str.encode()).hexdigest()[:8]}"
    else:
        # For full mode, just use session_id
        cache_key = f"{session_id}_full"
    
    return cache_key

session_store: dict[str, str] = _load_session_store()
transcription_cache: dict[str, dict] = _load_transcription_cache()

# OpenAI client
client = OpenAI()

class TranscriptionResponse(BaseModel):
    transcript: str
    segments: Optional[list] = None

class GenerateClipsRequest(BaseModel):
    segments: list

class EditWithAIRequest(BaseModel):
    prompt: str
    segments: list

class PlanEditRequest(BaseModel):
    instruction: str
    clips: list  # [{id, start, end, label?}]
    transcript: list = []  # Optional transcript segments

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

class TranscribeRequest(BaseModel):
    clips: Optional[list] = None  # Optional: if provided, only transcribe these clips
    
    class Config:
        # Allow None values explicitly
        validate_assignment = True

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

@app.delete("/api/transcriptions/cache")
async def clear_transcription_cache():
    """Clear all cached transcriptions"""
    global transcription_cache
    transcription_cache.clear()
    _save_transcription_cache(transcription_cache)
    return JSONResponse({"message": "Transcription cache cleared"})

@app.get("/api/debug/transcription-cache/{session_id}")
async def debug_transcription_cache(session_id: str):
    """Debug endpoint to check transcription cache status for a session"""
    cache_keys = list(transcription_cache.keys())
    session_keys = [key for key in cache_keys if key.startswith(session_id)]
    
    result = {
        "session_id": session_id,
        "all_cache_keys": cache_keys,
        "session_cache_keys": session_keys,
        "has_full_transcript": f"{session_id}_full" in transcription_cache,
        "cache_details": {}
    }
    
    for key in session_keys:
        cache_entry = transcription_cache[key]
        result["cache_details"][key] = {
            "transcript_length": len(cache_entry.get("transcript", "")),
            "segments_count": len(cache_entry.get("segments", [])),
            "mode": cache_entry.get("mode", "unknown"),
            "timestamp": cache_entry.get("timestamp", "unknown")
        }
    
    return JSONResponse(result)


@app.get("/api/transcriptions/cache")
async def get_transcription_cache():
    """Get information about cached transcriptions"""
    cache_info = {}
    for key, value in transcription_cache.items():
        cache_info[key] = {
            "mode": value.get("mode", "unknown"),
            "timestamp": value.get("timestamp", "unknown"),
            "segments_count": len(value.get("segments", []))
        }
    return JSONResponse({
        "cache_count": len(transcription_cache),
        "cached_transcriptions": cache_info
    })

@app.options("/api/videos/{session_id}/transcribe")
async def transcribe_options(session_id: str):
    """Handle CORS preflight for transcribe endpoint"""
    return JSONResponse(content={}, status_code=200)

@app.get("/api/test/transcribe-test")
async def test_transcribe_endpoint():
    """Test endpoint to verify server is working"""
    print("[test] Test endpoint called")
    return JSONResponse({"status": "ok", "message": "Server is working"})

@app.post("/api/videos/{session_id}/transcribe")
async def transcribe_video(session_id: str, request: Request):
    """
    Transcribe video audio using OpenAI Whisper API with caching.
    
    CRITICAL: If clips are provided, only transcribes the EDITED timeline.
    This ensures transcript reflects the current edited state, not the original video.
    
    Caches transcription results to avoid re-transcribing the same content.
    """
    import sys
    print(f"[transcribe] === ENDPOINT CALLED ===", flush=True)
    sys.stdout.flush()
    
    # Parse request body manually
    try:
        body = await request.json()
        print(f"[transcribe] session_id={session_id}", flush=True)
        print(f"[transcribe] body type: {type(body)}", flush=True)
        print(f"[transcribe] body content: {body}", flush=True)
    except Exception as e:
        print(f"[transcribe] Error parsing request body: {e}", flush=True)
        raise HTTPException(status_code=400, detail=f"Invalid request body: {str(e)}")
    
    try:
        print(f"[transcribe] Received request for session_id={session_id}", flush=True)
        print(f"[transcribe] Body type: {type(body)}", flush=True)
        print(f"[transcribe] Body content: {body}", flush=True)
        
        # Check if OpenAI API key is configured
        if not client.api_key:
            raise HTTPException(
                status_code=500,
                detail="OpenAI API key not configured. Set OPENAI_API_KEY environment variable."
            )
        
        # Parse body if provided - handle both None and empty body
        clips = None
        if body is not None and isinstance(body, dict):
            clips = body.get('clips', None)
        
        print(f"[transcribe] session_id={session_id}")
        print(f"[transcribe] clips provided: {len(clips) if clips else 0}")
        
        # Generate cache key based on session and clips
        cache_key = _get_cache_key(session_id, clips)
        print(f"[transcribe] cache_key={cache_key}")
        
        # Check if transcription is already cached
        if cache_key in transcription_cache:
            cached_result = transcription_cache[cache_key]
            print(f"[transcribe] CACHE HIT: Returning cached transcription")
            return JSONResponse({
                "transcript": cached_result["transcript"],
                "segments": cached_result["segments"],
                "mode": cached_result["mode"],
                "cached": True
            })
        
        print(f"[transcribe] CACHE MISS: Proceeding with transcription")
        
        if clips:
            print(f"[transcribe] EDITED MODE: Transcribing only edited clips")
            for i, clip in enumerate(clips):
                print(f"[transcribe]   Clip {i+1}: {clip.get('start', 0):.2f}s - {clip.get('end', 0):.2f}s")
        else:
            print(f"[transcribe] FULL MODE: Transcribing entire original video")
        print(f"[transcribe] Uploads folder contents: {os.listdir(str(UPLOAD_DIR))}")

        # Resolve video path: check session store first, then scan disk by prefix
        video_path = None

        # 1. Check in-memory session store (valid within same server process)
        if session_id in session_store:
            stored = Path(session_store[session_id])
            print(f"[transcribe] session_store hit → {stored}")
            print(f"[transcribe] File exists: {stored.exists()}")
            if stored.exists():
                video_path = stored

        # 2. Fallback: scan uploads dir for any file starting with session_id
        if video_path is None:
            for fname in os.listdir(str(UPLOAD_DIR)):
                if fname.startswith(session_id) and not fname.endswith("_audio.mp3"):
                    video_path = UPLOAD_DIR / fname
                    print(f"[transcribe] Matched file: {video_path}")
                    break

        # 3. Last resort: try known extensions explicitly
        if video_path is None:
            for ext in [".mp4", ".mov", ".webm", ".avi", ".mkv"]:
                candidate = UPLOAD_DIR / f"{session_id}{ext}"
                print(f"[transcribe] Searching for: {candidate}")
                if candidate.exists():
                    video_path = candidate
                    print(f"[transcribe] Matched file: {video_path}")
                    break

        if video_path is None:
            raise HTTPException(
                status_code=404,
                detail=f"Video file not found for session {session_id}"
            )
        
        # CRITICAL FIX: Extract audio based on edited clips if provided
        audio_path = UPLOAD_DIR / f"{session_id}_audio.mp3"
        print(f"[transcribe] audio_path={audio_path}")
        
        try:
            if clips and len(clips) > 0:
                # EDITED MODE: Extract and concatenate audio segments for each clip
                print(f"[transcribe] Extracting audio for {len(clips)} edited clips...")
                
                # Create temporary files for each clip's audio
                temp_audio_files = []
                concat_list_path = UPLOAD_DIR / f"{session_id}_concat_list.txt"
                
                try:
                    for i, clip in enumerate(clips):
                        clip_start = clip.get("start", 0)
                        clip_end = clip.get("end", 0)
                        clip_duration = clip_end - clip_start
                        
                        if clip_duration <= 0:
                            print(f"[transcribe] WARNING: Clip {i+1} has invalid duration, skipping")
                            continue
                        
                        # Extract this clip's audio segment
                        temp_clip_audio = UPLOAD_DIR / f"{session_id}_clip_{i+1}_audio.mp3"
                        temp_audio_files.append(temp_clip_audio)
                        
                        print(f"[transcribe] Extracting clip {i+1}: {clip_start:.2f}s - {clip_end:.2f}s (duration: {clip_duration:.2f}s)")
                        
                        result = subprocess.run([
                            "ffmpeg",
                            "-ss", str(clip_start),  # Start time
                            "-t", str(clip_duration),  # Duration
                            "-i", str(video_path),
                            "-vn",  # No video
                            "-acodec", "libmp3lame",  # MP3 codec
                            "-ar", "16000",  # 16kHz sample rate (Whisper requirement)
                            "-ac", "1",  # Mono
                            "-y",  # Overwrite output file
                            str(temp_clip_audio)
                        ], capture_output=True, text=True)
                        
                        if result.returncode != 0:
                            print(f"[transcribe] ffmpeg error for clip {i+1}:")
                            print(f"[transcribe] stderr: {result.stderr}")
                            raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
                        
                        print(f"[transcribe] Clip {i+1} audio extracted: {temp_clip_audio}")
                    
                    if len(temp_audio_files) == 0:
                        raise HTTPException(
                            status_code=400,
                            detail="No valid clips to transcribe"
                        )
                    
                    # Concatenate all clip audio files
                    print(f"[transcribe] Concatenating {len(temp_audio_files)} audio segments...")
                    
                    # Create concat list file for ffmpeg
                    with open(concat_list_path, 'w') as f:
                        for temp_file in temp_audio_files:
                            # Use forward slashes and escape special characters for ffmpeg
                            escaped_path = str(temp_file.absolute()).replace('\\', '/')
                            f.write(f"file '{escaped_path}'\n")
                    
                    # Concatenate using ffmpeg concat demuxer
                    result = subprocess.run([
                        "ffmpeg",
                        "-f", "concat",
                        "-safe", "0",
                        "-i", str(concat_list_path),
                        "-c", "copy",
                        "-y",
                        str(audio_path)
                    ], capture_output=True, text=True)
                    
                    if result.returncode != 0:
                        print(f"[transcribe] ffmpeg concat error:")
                        print(f"[transcribe] stderr: {result.stderr}")
                        raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
                    
                    print(f"[transcribe] Audio concatenation complete: {audio_path}")
                    
                finally:
                    # Clean up temporary files
                    for temp_file in temp_audio_files:
                        if temp_file.exists():
                            temp_file.unlink()
                            print(f"[transcribe] Cleaned up: {temp_file}")
                    if concat_list_path.exists():
                        concat_list_path.unlink()
                        print(f"[transcribe] Cleaned up: {concat_list_path}")
            
            else:
                # FULL MODE: Extract audio from entire original video
                print(f"[transcribe] Extracting audio from full video...")
                result = subprocess.run([
                    "ffmpeg", "-i", str(video_path),
                    "-vn",  # No video
                    "-acodec", "libmp3lame",  # MP3 codec
                    "-ar", "16000",  # 16kHz sample rate (Whisper requirement)
                    "-ac", "1",  # Mono
                    "-y",  # Overwrite output file
                    str(audio_path)
                ], capture_output=True, text=True)
                
                if result.returncode != 0:
                    print(f"[transcribe] ffmpeg full extraction error:")
                    print(f"[transcribe] stderr: {result.stderr}")
                    raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
                
                print(f"[transcribe] Full audio extraction complete")
        
        except FileNotFoundError:
            raise HTTPException(
                status_code=500,
                detail="ffmpeg not found. Please install ffmpeg and ensure it is on your PATH."
            )
        except subprocess.CalledProcessError as e:
            error_output = e.stderr.decode() if e.stderr else str(e)
            print(f"[transcribe] ffmpeg error: {error_output}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to extract audio: {error_output}"
            )
        
        # Transcribe using OpenAI Whisper API with retry logic
        print(f"[transcribe] calling OpenAI Whisper API")
        
        max_retries = 3
        retry_delay = 2  # seconds
        
        for attempt in range(max_retries):
            try:
                print(f"[transcribe] Attempt {attempt + 1}/{max_retries}")
                
                with open(audio_path, "rb") as audio_file:
                    transcript_response = client.audio.transcriptions.create(
                        model="whisper-1",
                        file=audio_file,
                        response_format="verbose_json"
                    )
                print(f"[transcribe] OpenAI call complete")
                break  # Success, exit retry loop
                
            except Exception as api_error:
                error_message = str(api_error)
                print(f"[transcribe] Attempt {attempt + 1} failed: {error_message}")
                
                # If this is the last attempt, clean up and raise error
                if attempt == max_retries - 1:
                    if audio_path.exists():
                        audio_path.unlink()
                        print(f"[transcribe] Cleaned up: {audio_path}")
                    
                    # Handle different types of API errors
                    if "Connection error" in error_message or "getaddrinfo failed" in error_message:
                        raise HTTPException(
                            status_code=503,
                            detail="Unable to connect to OpenAI API after multiple attempts. Please check your internet connection, firewall settings, or try again later. See NETWORK_TROUBLESHOOTING.md for detailed solutions."
                        )
                    elif "API key" in error_message or "authentication" in error_message.lower():
                        raise HTTPException(
                            status_code=401,
                            detail="OpenAI API authentication failed. Please check your API key in the .env file."
                        )
                    elif "quota" in error_message.lower() or "billing" in error_message.lower():
                        raise HTTPException(
                            status_code=402,
                            detail="OpenAI API quota exceeded or billing issue. Please check your OpenAI account at https://platform.openai.com/account/usage"
                        )
                    else:
                        raise HTTPException(
                            status_code=500,
                            detail=f"OpenAI API error: {error_message}"
                        )
                else:
                    # Wait before retrying
                    import time
                    print(f"[transcribe] Waiting {retry_delay} seconds before retry...")
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
        
        # Clean up audio file
        audio_path.unlink()
        print(f"[transcribe] Cleaned up: {audio_path}")
        
        # Extract transcript and segments
        transcript_text = transcript_response.text
        segments = []
        mode = "edited" if clips else "full"
        
        if hasattr(transcript_response, 'segments'):
            # CRITICAL: Adjust segment timestamps to match edited timeline
            if clips and len(clips) > 0:
                print(f"[transcribe] Adjusting segment timestamps for edited timeline...")
                
                # Build timeline mapping: transcription time → original video time
                timeline_offset = 0.0
                
                for seg in transcript_response.segments:
                    # Segment times are relative to the concatenated audio (edited timeline)
                    # We keep them as-is since they now represent the edited timeline
                    # Handle both dict and object formats for segments
                    if isinstance(seg, dict):
                        segments.append({
                            "start": seg["start"],
                            "end": seg["end"],
                            "text": seg["text"]
                        })
                    else:
                        segments.append({
                            "start": seg.start,
                            "end": seg.end,
                            "text": seg.text
                        })
                
                print(f"[transcribe] Adjusted {len(segments)} segments for edited timeline")
            else:
                # Full video mode: timestamps are already correct
                segments = []
                for seg in transcript_response.segments:
                    # Handle both dict and object formats for segments
                    if isinstance(seg, dict):
                        segments.append({
                            "start": seg["start"],
                            "end": seg["end"],
                            "text": seg["text"]
                        })
                    else:
                        segments.append({
                            "start": seg.start,
                            "end": seg.end,
                            "text": seg.text
                        })
                print(f"[transcribe] Extracted {len(segments)} segments from full video")
        
        # Cache the transcription result
        transcription_result = {
            "transcript": transcript_text,
            "segments": segments,
            "mode": mode,
            "timestamp": str(datetime.now())
        }
        
        transcription_cache[cache_key] = transcription_result
        _save_transcription_cache(transcription_cache)
        print(f"[transcribe] Cached transcription result with key: {cache_key}")
        
        return JSONResponse({
            "transcript": transcript_text,
            "segments": segments,
            "mode": mode,
            "cached": False
        })
        
    except HTTPException:
        raise
    except subprocess.CalledProcessError as e:
        error_output = e.stderr.decode() if e.stderr else str(e)
        print(f"[transcribe] subprocess error: {error_output}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract audio from video: {error_output}"
        )
    except Exception as e:
        print(f"[transcribe] exception: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )

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

    # Validate prompt
    if not body.prompt or not body.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required.")

    # Validate segments
    if not body.segments:
        raise HTTPException(status_code=400, detail="segments are required.")
    
    # CRITICAL: Always try to get the original full video transcript first
    # This ensures we always use the master transcript, never re-transcribe
    original_cache_key = f"{session_id}_full"  # Direct key for original video
    original_transcript = None
    
    # Also check for any cache key that starts with session_id and contains "full"
    for cache_key in transcription_cache.keys():
        if cache_key.startswith(session_id) and ("full" in cache_key or cache_key == f"{session_id}_full"):
            original_transcript = transcription_cache[cache_key]
            print(f"[edit-with-ai] Found original transcript in cache with key '{cache_key}' (length: {len(original_transcript.get('transcript', ''))})")
            break
    
    if original_transcript is None:
        print(f"[edit-with-ai] No original transcript found in cache. Available keys: {list(transcription_cache.keys())}")
        print(f"[edit-with-ai] Looking for keys starting with: {session_id}")
    
    # CRITICAL: Validate transcript exists - check segments OR original transcript
    has_transcript_in_segments = any(
        seg.get('text') and seg.get('text').strip() 
        for seg in body.segments
    )
    
    has_transcript = has_transcript_in_segments or original_transcript is not None
    
    total_transcript_length = sum(
        len(seg.get('text', '').strip()) 
        for seg in body.segments
    )
    
    # ALWAYS map original transcript to current segments if available
    if original_transcript and original_transcript.get('segments'):
        print(f"[edit-with-ai] Mapping original transcript to current segments")
        for segment in body.segments:
            # Only map if segment doesn't already have good transcript
            if not segment.get('text') or len(segment.get('text', '').strip()) < 50:
                segment_start = segment.get('sourceStart', segment.get('start', 0))
                segment_end = segment.get('sourceEnd', segment.get('end', 0))
                
                # Find overlapping transcript segments from original
                overlapping_text = []
                for orig_seg in original_transcript['segments']:
                    orig_start = orig_seg.get('start', 0)
                    orig_end = orig_seg.get('end', 0)
                    
                    # Check if original segment overlaps with current segment
                    if (orig_start < segment_end and orig_end > segment_start):
                        overlapping_text.append(orig_seg.get('text', '').strip())
                
                # Combine overlapping text
                if overlapping_text:
                    segment['text'] = ' '.join(overlapping_text)
                    print(f"[edit-with-ai] Mapped transcript to segment {segment.get('index', '?')}: {len(segment['text'])} chars")
        
        # Recalculate after mapping
        has_transcript = True
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
        'name the clips', 'title', 'label', 'chapters', 'divide', 'split'
    ]
    
    is_content_based = any(
        keyword in body.prompt.lower() 
        for keyword in content_based_keywords
    )
    
    # Allow basic structural commands without transcript
    basic_structural_keywords = [
        'delete clip', 'remove clip', 'merge clip', 'keep clip', 'reorder', 'move clip'
    ]
    
    is_basic_structural = any(
        keyword in body.prompt.lower() 
        for keyword in basic_structural_keywords
    )
    
    # Require transcript for content-based commands
    if is_content_based and not has_transcript:
        print(f"[edit-with-ai] ERROR: Content-based command requires transcript")
        
        # Provide helpful guidance based on cache state
        cache_info = f"Available cache keys: {list(transcription_cache.keys())}"
        if not transcription_cache:
            suggestion = "No transcripts found in cache. Please transcribe the video first by clicking 'Transcribe Video'."
        else:
            suggestion = f"Original transcript not found. {cache_info}. Please transcribe the full video first."
        
        raise HTTPException(
            status_code=400,
            detail={
                "error": "TRANSCRIPT_REQUIRED",
                "message": "Transcript required for content-based editing. Please generate transcript first by clicking 'Transcribe Video'.",
                "suggestion": suggestion,
                "command_type": "content-based",
                "requires_transcript": True,
                "debug_info": {
                    "session_id": session_id,
                    "cache_keys": list(transcription_cache.keys()),
                    "original_cache_key_attempted": f"{session_id}_full"
                }
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
    
    # Build numbered clip list — include title when present so AI can match by name
    segments_text = "\n".join(
        (
            f"{i + 1}. [{seg.get('start', 0):.2f}s - {seg.get('end', 0):.2f}s] "
            f"Title: \"{seg.get('title', '').strip()}\" | Transcript: {seg.get('text', '').strip()}"
            if seg.get('title')
            else
            f"{i + 1}. [{seg.get('start', 0):.2f}s - {seg.get('end', 0):.2f}s] {seg.get('text', '').strip()}"
        )
        for i, seg in enumerate(clips_with_ids)
    )

    system_prompt = (
        "You are an AI video editor.\n"
        "You are given clips with an index, a title, and a transcript excerpt.\n"
        "Your task: convert the user's instruction into structured JSON edit actions.\n\n"
        "IMPORTANT CAPABILITIES:\n"
        "- You can work with existing clips AND create new clips by splitting long clips into chapters/sections.\n"
        "- For chapter division: analyze the transcript to identify natural topic breaks and use split actions.\n"
        "- SMART TRIMMING: When dividing into chapters, automatically identify and remove unwanted content.\n"
        "- Use semantic meaning — if the user says 'reliance', match a clip whose title or text contains similar concepts.\n"
        "- Do NOT default to clip 1 unless it is genuinely the best match.\n\n"
        "CHAPTER DIVISION WITH SMART TRIMMING STRATEGY:\n"
        "- When user asks to 'divide into chapters' or 'cut into main chapters', analyze the transcript for:\n"
        "  1. MAIN CONTENT: Core scenarios, lessons, or topics\n"
        "  2. UNWANTED CONTENT: Intros, outros, transitions, repetitive content, channel promotions\n"
        "- Look for phrases that indicate main content vs. filler:\n"
        "  * KEEP: 'Scenario one', 'Scenario two', actual lesson content, examples, stories\n"
        "  * TRIM: 'Hey everyone', 'subscribe to my channel', 'like the video', 'check out the link', repetitive instructions\n"
        "- CRITICAL APPROACH FOR CLEAN CHAPTERS:\n"
        "  1. First use cut_time to remove intro/outro (e.g., cut_time 0-60 removes first 60s intro)\n"
        "  2. Then use MULTIPLE split actions to divide remaining content into clean chapters\n"
        "  3. Finally use name_clips to give descriptive titles\n"
        "- EXAMPLE WORKFLOW FOR 3 CHAPTERS:\n"
        "  * cut_time: {start: 0, end: 60} → Remove intro\n"
        "  * cut_time: {start: 700, end: 751} → Remove outro\n"
        "  * split: {clip_index: 1, split_time: 250} → Split at first boundary\n"
        "  * split: {clip_index: 1, split_time: 450} → Split at second boundary (system will find correct clip)\n"
        "  * Result: 3 clean chapters from original single clip\n"
        "  * name_clips: Give each chapter a proper title\n"
        "- CRITICAL: Use ABSOLUTE timestamps from the original video (0-751s range).\n"
        "- CRITICAL: Always use clip_index: 1 for splits - the system will find the right clip automatically.\n"
        "- For 3 chapters: Use 2 split operations with different absolute timestamps.\n"
        "- You must estimate timestamps based on text position in the transcript, not use the clip end time.\n"
        "- For a transcript of length N, if 'Scenario two' appears at roughly 1/3 through the text, estimate the timestamp as 1/3 of the total duration.\n"
        "- EXAMPLE: For 751s video with 3 scenarios, split at ~250s (1/3) and ~500s (2/3) to create 3 equal chapters.\n"
        "- NEVER split at the very end of a clip - splits must be at least 5 seconds before the end.\n\n"
        "SMART TRIMMING EXAMPLES:\n"
        "- If transcript starts with 'Hey everyone, I'm Alex...', consider trimming the intro\n"
        "- If transcript ends with 'subscribe to my channel...', consider trimming the outro\n"
        "- If there are repetitive instructions between scenarios, consider trimming transitions\n"
        "- Focus on keeping the core educational/entertainment content\n\n"
        "Return ONLY valid JSON. No explanation, no markdown, no code fences.\n"
        "Never return an empty actions array.\n\n"
        "AVAILABLE ACTIONS:\n"
        "- name_clips: {\"type\": \"name_clips\", \"clips\": [{\"index\": 1, \"title\": \"Specific Title\"}]}\n"
        "- cut:        {\"type\": \"cut\", \"clip_index\": <number>}\n"
        "- cut_time:   {\"type\": \"cut_time\", \"start\": <seconds>, \"end\": <seconds>}\n"
        "- split:      {\"type\": \"split\", \"clip_index\": <number>, \"split_time\": <seconds>}\n"
        "- merge:      {\"type\": \"merge\", \"clip_indexes\": [<number>, <number>]}\n"
        "- swap:       {\"type\": \"swap\", \"clip_indexes\": [<number>, <number>]}\n"
        "- keep:       {\"type\": \"keep\", \"clip_indexes\": [<number>]}\n\n"
        "TIME PARSING RULES:\n"
        "- Convert MM:SS expressions to total seconds: 0:10 → 10, 1:30 → 90, 2:05 → 125.\n"
        "- Use cut_time when you want to remove unwanted sections (e.g. 'cut_time from 0 to 30' removes first 30 seconds).\n"
        "- Use cut when the user refers to a clip by index or name.\n"
        "- Use split when the user wants to divide a clip into parts (e.g. 'split clip 1 at 2:30').\n"
        "- For smart chapter division: combine cut_time (to remove unwanted parts) + split (to create chapters) + name_clips.\n"
        "- ESTIMATE split times based on where topics change in the transcript relative to total duration.\n"
        "- Use swap when the user wants to change the order of two clips.\n\n"
        f"CRITICAL: Currently {len(clips_with_ids)} clip(s) exist. After splitting, you'll have more clips to work with."
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
        f"Segments:\n{segments_text}\n\n"
        f"User instruction: {body.prompt.strip()}\n\n"
        f"Current state: {len(clips_with_ids)} clip(s) exist. "
        f"For chapter division with smart trimming, analyze the transcript to:\n"
        f"1. Identify main content sections (scenarios, lessons, core topics)\n"
        f"2. Identify unwanted content (intros, outros, channel promotions, repetitive instructions)\n"
        f"3. Use cut_time to remove unwanted sections and split to create clean chapters\n"
        f"4. Estimate timestamps based on where content changes occur in the text relative to total duration\n"
        f"Example: If intro ends at 'Alright, let's practice' (10% through text), use cut_time to remove 0 to 10% of duration"
    )

    try:
        print(f"[edit-with-ai] calling GPT-4o-mini")
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
        )
        raw = response.choices[0].message.content.strip()
        print(f"[edit-with-ai] raw response: {raw}")

        # Strip markdown code fences if model wraps in ```json ... ```
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        result = _json.loads(raw)

        # Normalize: if model returned a bare action object instead of {"actions": [...]}
        if "actions" not in result:
            if "type" in result:
                # Single action returned at top level — wrap it
                result = {"actions": [result]}
                print(f"[edit-with-ai] Normalized bare action into actions array: {result}")
            else:
                raise ValueError("Response missing 'actions' array and no 'type' field found")

        if not isinstance(result["actions"], list):
            raise ValueError("'actions' field is not a list")

        # Validate each action matches the supported types
        valid_types = {"name_clips", "cut", "cut_time", "split", "merge", "swap", "keep"}
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
        
        # ROBUSTNESS LAYER: Normalize timeline
        normalized_clips = _normalize_timeline(final_clips)
        
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
        
        # Build backward-compatible response with new fields
        enhanced_result = {
            "actions": result["actions"],  # Keep original for backward compatibility
            "clips": normalized_clips,      # NEW: Final authoritative clips with preserved transcripts
            "operations": operations,       # NEW: Structured operations log
            "warnings": warnings,           # NEW: Non-fatal issues
            "transcript_preserved": original_transcript is not None,  # NEW: Indicates if transcript was preserved
            "requires_retranscription": False  # NEW: Always false since we preserve original transcript
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
        )
        raw = response.choices[0].message.content.strip()
        print(f"[plan-edit] raw response: {raw}")

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

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
            # Rename operations
            valid_renames = 0
            for clip_data in action.get("clips", []):
                idx = clip_data.get("index")
                title = clip_data.get("title", "")
                if idx in index_to_id:
                    operations.append({
                        "type": "rename",
                        "clipId": index_to_id[idx],
                        "params": {"title": title}
                    })
                    valid_renames += 1
                else:
                    warnings.append(f"name_clips: clip index {idx} out of range (valid: 1-{len(clips)}), skipped")
            
            # If no valid renames were made, create a fallback rename for the first clip
            if valid_renames == 0 and len(clips) > 0:
                operations.append({
                    "type": "rename",
                    "clipId": clips[0].get("id", "clip-1"),
                    "params": {"title": "Main Content"}
                })
                warnings.append("Applied fallback rename to first clip since no valid indexes were found")
        
        elif action_type == "cut":
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
    
    for op in operations:
        op_type = op.get("type")
        clip_id = op.get("clipId")
        params = op.get("params", {})
        
        if op_type == "rename":
            # Rename clip
            for clip in current_clips:
                if clip.get("id") == clip_id:
                    clip["title"] = params.get("title", "")
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
                clip_source_start = clip.get("start", 0)
                clip_source_end = clip.get("end", 0)
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
                    # Don't add to new_clips, don't advance timeline position
                    
                elif clip_timeline_start < cut_start and clip_timeline_end > cut_end:
                    # Cut in middle, split into two
                    print(f"[cut_time]   → Split (delete range in middle)")
                    
                    # Calculate how much to keep from start and end
                    keep_start_duration = cut_start - clip_timeline_start
                    keep_end_duration = clip_timeline_end - cut_end
                    
                    # Left segment (before delete range)
                    left = dict(clip)
                    left["id"] = f"{clip.get('id', 'clip')}a"
                    left["start"] = clip_source_start
                    left["end"] = clip_source_start + keep_start_duration
                    
                    # Right segment (after delete range)
                    right = dict(clip)
                    right["id"] = f"{clip.get('id', 'clip')}b"
                    right["start"] = clip_source_end - keep_end_duration
                    right["end"] = clip_source_end
                    
                    # Validate minimum duration
                    if keep_start_duration >= 0.5:
                        print(f"[cut_time]     → Keep left: {left['start']:.2f}-{left['end']:.2f} ({keep_start_duration:.2f}s)")
                        new_clips.append(left)
                        current_timeline_pos += keep_start_duration
                    else:
                        print(f"[cut_time]     → Drop left (< 0.5s)")
                        warnings.append(f"cut_time: left segment of {clip.get('id')} < 0.5s, dropped")
                    
                    if keep_end_duration >= 0.5:
                        print(f"[cut_time]     → Keep right: {right['start']:.2f}-{right['end']:.2f} ({keep_end_duration:.2f}s)")
                        new_clips.append(right)
                        current_timeline_pos += keep_end_duration
                    else:
                        print(f"[cut_time]     → Drop right (< 0.5s)")
                        warnings.append(f"cut_time: right segment of {clip.get('id')} < 0.5s, dropped")
                
                elif clip_timeline_start < cut_start:
                    # Trim end (delete range starts in middle of clip)
                    print(f"[cut_time]   → Trim end")
                    keep_duration = cut_start - clip_timeline_start
                    
                    trimmed = dict(clip)
                    trimmed["start"] = clip_source_start
                    trimmed["end"] = clip_source_start + keep_duration
                    
                    if keep_duration >= 0.5:
                        print(f"[cut_time]     → Keep: {trimmed['start']:.2f}-{trimmed['end']:.2f} ({keep_duration:.2f}s)")
                        new_clips.append(trimmed)
                        current_timeline_pos += keep_duration
                    else:
                        print(f"[cut_time]     → Drop (< 0.5s)")
                        warnings.append(f"cut_time: trimmed {clip.get('id')} < 0.5s, dropped")
                        
                else:
                    # Trim start (delete range ends in middle of clip)
                    print(f"[cut_time]   → Trim start")
                    
                    # Calculate how much to delete from the start of this clip
                    delete_duration = cut_end - clip_timeline_start
                    keep_duration = clip_timeline_end - cut_end
                    
                    trimmed = dict(clip)
                    # FIXED: Add delete_duration to source start (not subtract from end)
                    trimmed["start"] = clip_source_start + delete_duration
                    trimmed["end"] = clip_source_end
                    
                    if keep_duration >= 0.5:
                        print(f"[cut_time]     → Keep: {trimmed['start']:.2f}-{trimmed['end']:.2f} ({keep_duration:.2f}s, deleted {delete_duration:.2f}s from start)")
                        new_clips.append(trimmed)
                        current_timeline_pos += keep_duration
                    else:
                        print(f"[cut_time]     → Drop (< 0.5s)")
                        warnings.append(f"cut_time: trimmed {clip.get('id')} < 0.5s, dropped")
            
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
                        print(f"[split] Split time {split_time:.2f} not valid for this clip")
                        warnings.append(f"split: split_time {split_time:.2f} not within clip bounds, skipped")
                        continue
                
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
                        clip_a = dict(clip_to_split)
                        clip_a["id"] = f"{clip_to_split.get('id', 'clip')}-A"
                        clip_a["start"] = start  # Keep original timeline start
                        clip_a["end"] = start + duration_a  # Timeline end based on duration
                        clip_a["sourceStart"] = source_start
                        clip_a["sourceEnd"] = source_split_time  # Clean cut at split point
                        clip_a["title"] = f"{clip_to_split.get('title', 'Clip')} - Part 1"
                        
                        clip_b = dict(clip_to_split)
                        clip_b["id"] = f"{clip_to_split.get('id', 'clip')}-B"
                        clip_b["start"] = start + duration_a  # Continue timeline from where A ends
                        clip_b["end"] = start + duration_a + duration_b  # Timeline end
                        clip_b["sourceStart"] = source_split_time  # Start exactly where A ends
                        clip_b["sourceEnd"] = source_end
                        clip_b["title"] = f"{clip_to_split.get('title', 'Clip')} - Part 2"
                        
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
                    
                    # Rebuild timeline positions
                    print(f"[swap] Rebuilding timeline positions...")
                    current_time = 0.0
                    for i, clip in enumerate(current_clips):
                        duration = clip.get("end", 0) - clip.get("start", 0)
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
        
        elif op_type == "keep":
            # Keep only specified clips
            keep_ids = set(params.get("keepIds", []))
            initial_count = len(current_clips)
            current_clips = [c for c in current_clips if c.get("id") in keep_ids]
            if len(current_clips) == 0:
                warnings.append(f"keep: no clips matched keep list, operation skipped")
                current_clips = clips  # Restore original
    
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
    
    CRITICAL: Preserves sourceStart/sourceEnd (original video timestamps) separately
    from start/end (normalized timeline positions).
    """
    if not clips:
        return []
    
    # DO NOT SORT - preserve array order for user-defined sequencing (e.g., swaps)
    # Normalize timeline positions to remove gaps
    current_time = 0.0
    normalized_clips = []
    
    for clip in clips:
        original_start = clip.get("start", 0)
        original_end = clip.get("end", 0)
        duration = original_end - original_start
        
        # Create normalized clip with continuous timeline
        normalized_clip = dict(clip)
        
        # CRITICAL: Preserve or create sourceStart/sourceEnd (original video timestamps)
        # These must NEVER be modified - they represent the actual video segments to extract
        if "sourceStart" not in normalized_clip:
            normalized_clip["sourceStart"] = original_start
        if "sourceEnd" not in normalized_clip:
            normalized_clip["sourceEnd"] = original_end
        
        # Update start/end for normalized timeline (for sequencing/display)
        normalized_clip["start"] = round(current_time, 2)
        normalized_clip["end"] = round(current_time + duration, 2)
        
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
                "startFrom": current_frame,
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
            
            remotion_clip = {
                "id": clip.get("id", f"clip-{i + 1}"),
                "src": f"/api/videos/{session_id}/stream",
                "startFrom": current_frame,
                "durationInFrames": duration_frames,
                "sourceStart": source_start,
                "sourceEnd": source_end,
                "volume": 1.0
            }
        
        # Preserve external clip properties
        if clip.get("type"):
            remotion_clip["type"] = clip["type"]
        if clip.get("externalId"):
            remotion_clip["externalId"] = clip["externalId"]
        
        remotion_clips.append(remotion_clip)
        current_frame += duration_frames
        
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
    Simplified export endpoint: accepts clips array, builds composition, renders video.
    This is the main endpoint for exporting after AI editing.
    Uses Remotion for rendering with automatic FFmpeg fallback.
    """
    import json as _json
    from datetime import datetime
    
    timestamp = datetime.now().isoformat()
    
    # Enhanced debug logging
    print("=" * 80)
    print(f"[{timestamp}] [EXPORT] export-with-clips endpoint called")
    print(f"[{timestamp}] [EXPORT] session_id: {session_id}")
    print(f"[{timestamp}] [EXPORT] Number of clips: {len(body.clips)}")
    print(f"[{timestamp}] [EXPORT] Clips data: {body.clips}")
    print(f"[{timestamp}] [EXPORT] Options: {body.options}")
    print("=" * 80)
    
    # Validate clips
    if not body.clips or len(body.clips) == 0:
        raise HTTPException(
            status_code=400,
            detail="No clips provided. Please provide at least one clip with start and end times."
        )
    
    # Step 1: Build composition from clips
    print(f"[{timestamp}] [export-with-clips] Building composition...")
    composition_response = await build_composition(session_id, body)
    composition = _json.loads(composition_response.body)
    
    print(f"[{timestamp}] [export-with-clips] Composition built, starting render...")
    
    # Step 2: Export with Remotion
    remotion_request = RemotionExportRequest(
        composition=composition,
        options=body.options
    )
    
    return await export_video_remotion(session_id, remotion_request)


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
            # If src is a relative URL like /api/videos/{id}/stream, convert to absolute HTTP URL
            if src.startswith("/api/videos/") and "/stream" in src:
                # Convert to absolute HTTP URL that Remotion can access
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
    return await export_video(session_id, export_request)


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
    clips = body.clips
    
    # Debug: Log clip order before export
    print(f"[export] Clip order before export:")
    for i, clip in enumerate(clips):
        print(f"[export]   {i}: id={clip.get('id')}, sourceStart={clip.get('sourceStart')}, sourceEnd={clip.get('sourceEnd')}")

    # Build a temporary concat list using ffmpeg trim + concat filter
    # Strategy: trim each clip to a temp file, then concatenate
    tmp_dir = Path(tempfile.mkdtemp())
    segment_paths = []

    try:
        for i, clip in enumerate(clips):
            # CRITICAL: Use sourceStart/sourceEnd for extraction, NOT start/end
            # start/end are timeline positions, sourceStart/sourceEnd are original video positions
            source_start = float(clip.get("sourceStart", clip.get("start", 0)))
            source_end = float(clip.get("sourceEnd", clip.get("end", 0)))
            duration = source_end - source_start
            
            if duration <= 0:
                print(f"[export] Skipping clip {i} with zero/negative duration: {source_start}-{source_end}")
                continue

            seg_path = tmp_dir / f"seg_{i:04d}.mp4"
            print(f"[export] Trimming clip {i}: {source_start}s → {source_end}s → {seg_path}")

            result = subprocess.run([
                "ffmpeg", "-y",
                "-ss", str(source_start),
                "-i", str(video_path),
                "-t", str(duration),
                "-c:v", "libx264", "-c:a", "aac",
                "-avoid_negative_ts", "make_zero",
                str(seg_path)
            ], capture_output=True)

            if result.returncode != 0:
                err = result.stderr.decode()
                print(f"[export] ffmpeg trim failed for clip {i}: {err}")
                raise HTTPException(status_code=500, detail=f"Failed to trim clip {i}: {err[:200]}")

            segment_paths.append(seg_path)

        if not segment_paths:
            raise HTTPException(status_code=400, detail="No valid clips to export.")

        # Write concat list file
        concat_list = tmp_dir / "concat.txt"
        concat_list.write_text("\n".join(f"file '{p}'" for p in segment_paths))

        # Concatenate all segments
        output_path = UPLOAD_DIR / f"{session_id}_export.mp4"
        print(f"[export] Concatenating {len(segment_paths)} segments → {output_path}")

        result = subprocess.run([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_list),
            "-c", "copy",
            str(output_path)
        ], capture_output=True)

        if result.returncode != 0:
            err = result.stderr.decode()
            print(f"[export] ffmpeg concat failed: {err}")
            raise HTTPException(status_code=500, detail=f"Failed to concatenate clips: {err[:200]}")

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
    finally:
        # Clean up temp segment files
        for p in segment_paths:
            try:
                p.unlink()
            except Exception:
                pass
        try:
            (tmp_dir / "concat.txt").unlink()
            tmp_dir.rmdir()
        except Exception:
            pass


@app.get("/api/pixabay")
async def pixabay_proxy(
    type: str = "videos",
    q: str = "",
    per_page: int = 10,
    page: int = 1,
    safesearch: bool = True,
    image_type: Optional[str] = None,
):
    """
    Proxy endpoint for Pixabay API (Moulika's feature).
    Reads PIXABAY_API_KEY from environment so the key is never exposed to the frontend.
    """
    import httpx
    api_key = os.getenv("PIXABAY_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="PIXABAY_API_KEY not configured. Set it in backend/.env"
        )

    url = "https://pixabay.com/api/videos/" if type == "videos" else "https://pixabay.com/api/"
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
        async with httpx.AsyncClient(timeout=15.0) as client_http:
            response = await client_http.get(url, params=params)
            response.raise_for_status()
            return JSONResponse(content=response.json())
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Pixabay API error: {e.response.text}")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach Pixabay: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
