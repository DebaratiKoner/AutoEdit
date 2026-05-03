from fastapi import APIRouter, Query, HTTPException
import httpx
import os

router = APIRouter()

@router.get("/api/pixabay")
async def get_assets(
    type: str = Query("videos"),
    q: str = Query(""),
    page: int = 1,
    per_page: int = 10,
    safesearch: str = "true",
    image_type: str = "photo",
):
    api_key = os.getenv("PIXABAY_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="PIXABAY_API_KEY not configured in backend/.env")

    if type == "videos":
        url = "https://pixabay.com/api/videos/"
    else:
        url = "https://pixabay.com/api/"

    params: dict = {
        "key": api_key,
        "q": q,
        "page": page,
        "per_page": per_page,
        "safesearch": safesearch,
    }
    if type == "images":
        params["image_type"] = image_type

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Pixabay error: {e.response.text}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach Pixabay: {str(e)}")
