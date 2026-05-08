"""Helper to replace/patch the legacy fast-export endpoint.

This file exists so the main.py diff stays small.
It is not imported automatically; it is meant to be copied into main.py
or used as a reference.

Endpoint behavior:
- Caches exports keyed by (session_id + ordered timeline)
- On cache hit: returns existing mp4 immediately
- On miss: re-encodes each segment with ultrafast preset, then concatenates
"""

from __future__ import annotations

from pathlib import Path
import hashlib
import json
import subprocess
import uuid

from fastapi import HTTPException
from fastapi.responses import FileResponse


def _export_signature(session_id: str, timeline: list[dict]) -> str:
    normalized: list[dict] = []
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


async def fast_export_with_cache(
    *,
    session_id: str,
    body: object,
    session_store: dict[str, str],
    UPLOAD_DIR: Path,
) -> FileResponse:
    """Drop-in implementation for /api/videos/{session_id}/fast-export."""

    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    video_path = Path(session_store[session_id])
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    timeline = getattr(body, "timeline", None) or []
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
    clip_files: list[Path] = []

    try:
        for i, clip in enumerate(timeline):
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
        except Exception:
            pass

