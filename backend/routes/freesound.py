from fastapi import APIRouter, Query, HTTPException
import httpx
import os

router = APIRouter()

@router.get("/api/freesound")
async def get_audio_assets(
    q: str = Query(""),
    page: int = 1,
    page_size: int = 10,
):
    api_key = os.getenv("FREESOUND_API_KEY")
    client_id = os.getenv("FREESOUND_CLIENT_ID")
    if not api_key or not client_id:
        raise HTTPException(status_code=500, detail="FREESOUND_API_KEY or FREESOUND_CLIENT_ID not configured")

    url = "https://freesound.org/apiv2/search/text/"
    params = {
        "query": q,
        "page": page,
        "page_size": page_size,
        "fields": "id,name,tags,duration,previews,username,images",
        "token": api_key,
    }

    try:
        # trust_env=False bypasses system proxy env vars (HTTP_PROXY/HTTPS_PROXY/etc)
        # which can sometimes break DNS resolution in certain environments.
        async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            # Transform to match our asset format
            results = []
            for sound in data.get("results", []):
                results.append({
                    "id": sound["id"],
                    "name": sound["name"],
                    "tags": ",".join(sound.get("tags", [])),
                    "duration": sound["duration"],
                    "previews": sound["previews"],
                    "username": sound["username"],
                    "images": sound["images"],
                    "_kind": "audio"
                })
            return {
                "hits": results,
                "totalHits": data.get("count", 0)
            }
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Freesound error: {e.response.text}")
    except Exception as e:
        # Helpful hint: if you see getaddrinfo failures, it's often a proxy/DNS env issue.
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach Freesound (url={url}): {str(e)}"
        )

