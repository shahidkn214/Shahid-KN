"""
StreamDrop - Universal Media Downloader & Converter (Python + FastAPI)
======================================================================
A complete, self-contained single-file web application and REST API for downloading
and converting videos and audio from YouTube, Facebook, TikTok, Instagram, Twitter/X,
and SoundCloud.

Prerequisites & Installation:
-----------------------------
1. Install Python 3.9+
2. Install Python packages:
   pip install fastapi uvicorn yt-dlp httpx pydantic

3. Install FFmpeg (Required for MP3 conversion & video merging):
   - Ubuntu / Debian:  sudo apt update && sudo apt install -y ffmpeg
   - macOS (Homebrew): brew install ffmpeg
   - Windows (Winget): winget install Gyan.FFmpeg
   - Windows (Choco):  choco install ffmpeg

Running the Server:
-------------------
   python app.py
   # Or using uvicorn directly:
   uvicorn app:app --host 0.0.0.0 --port 8000 --reload

Open your browser at: http://localhost:8000
"""

import os
import re
import uuid
import asyncio
import tempfile
import urllib.parse
from typing import Optional, Dict, Any, List
from pathlib import Path

try:
    import httpx
except ImportError:
    httpx = None

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

from fastapi import FastAPI, BackgroundTasks, HTTPException, Query
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(
    title="StreamDrop - Universal Media Downloader",
    description="Download & convert media from YouTube, Facebook, TikTok, Instagram, Twitter/X, SoundCloud",
    version="1.0.0"
)

# Enable CORS for universal API access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Standard desktop User-Agent to prevent anti-bot blocking
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Active background jobs store for real-time progress
active_jobs: Dict[str, Dict[str, Any]] = {}


class AnalyzeRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    format: str = "mp4"  # "mp4" or "mp3"
    quality: Optional[str] = "best"


def detect_platform(url: str) -> Dict[str, Any]:
    """Detect platform archetype and media traits from the URL."""
    u = url.lower()
    if "youtube.com" in u or "youtu.be" in u:
        return {"platform": "youtube", "name": "YouTube", "is_audio_only": False, "color": "#ef4444"}
    if "facebook.com" in u or "fb.watch" in u or "fb.com" in u:
        return {"platform": "facebook", "name": "Facebook", "is_audio_only": False, "color": "#1877f2"}
    if "tiktok.com" in u:
        return {"platform": "tiktok", "name": "TikTok", "is_audio_only": False, "color": "#00f2fe"}
    if "instagram.com" in u or "instagr.am" in u:
        return {"platform": "instagram", "name": "Instagram", "is_audio_only": False, "color": "#ec4899"}
    if "twitter.com" in u or "x.com" in u or "t.co" in u:
        return {"platform": "twitter", "name": "Twitter / X", "is_audio_only": False, "color": "#38bdf8"}
    if "soundcloud.com" in u:
        return {"platform": "soundcloud", "name": "SoundCloud", "is_audio_only": True, "color": "#f97316"}
    return {"platform": "generic", "name": "Universal Stream", "is_audio_only": False, "color": "#10b981"}


async def resolve_redirect_url(url: str) -> str:
    """Follow HTTP redirects for shortened sharing links (e.g. fb.watch, vt.tiktok.com, t.co)."""
    if not httpx:
        return url
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
            resp = await client.head(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
            )
            return str(resp.url)
    except Exception:
        return url


def format_duration(seconds: Optional[float]) -> str:
    """Format duration in seconds to mm:ss or hh:mm:ss."""
    if not seconds or seconds <= 0:
        return "0:00"
    s = int(seconds)
    hrs = s // 3600
    mins = (s % 3600) // 60
    secs = s % 60
    if hrs > 0:
        return f"{hrs}:{mins:02d}:{secs:02d}"
    return f"{mins}:{secs:02d}"


def cleanup_file(filepath: str, job_id: Optional[str] = None):
    """Background task to remove temporary files and clean job entries."""
    try:
        if os.path.exists(filepath):
            os.remove(filepath)
            print(f"[Cleanup] Deleted temporary file: {filepath}")
    except Exception as e:
        print(f"[Cleanup Error] Could not delete {filepath}: {e}")
    if job_id and job_id in active_jobs:
        active_jobs.pop(job_id, None)


# ---------------------------------------------------------------------------
# REST API Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "StreamDrop FastAPI Media Engine",
        "yt_dlp_available": yt_dlp is not None,
    }


@app.post("/api/analyze")
async def analyze_media(req: AnalyzeRequest):
    """Extract stream metadata, title, thumbnail, duration, and supported formats."""
    raw_url = req.url.strip()
    if not raw_url or not re.match(r"^https?://", raw_url, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Please enter a valid HTTP/HTTPS URL.")

    # 1. Resolve redirect URLs
    resolved_url = await resolve_redirect_url(raw_url)
    platform_info = detect_platform(resolved_url)

    # 2. Extract metadata via yt-dlp
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "user_agent": USER_AGENT,
        "referer": "https://www.google.com/",
        "extractor_args": {
            "youtube": {"player_client": ["android", "web"]},
            "generic": {"impersonate": ["chrome"]}
        }
    }

    loop = asyncio.get_event_loop()

    def _extract():
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(resolved_url, download=False)

    try:
        info = await loop.run_in_executor(None, _extract)
    except Exception as e:
        err_str = str(e)
        user_msg = "Could not retrieve media info. Please verify the URL."
        if "Private video" in err_str or "login" in err_str.lower():
            user_msg = "This media is private or requires authentication."
        elif "Video unavailable" in err_str:
            user_msg = "This video is unavailable or has been removed."
        raise HTTPException(status_code=422, detail=f"{user_msg} ({err_str[:120]})")

    if not info:
        raise HTTPException(status_code=422, detail="No media stream detected at this address.")

    duration_sec = info.get("duration", 0)
    is_audio_only = (
        platform_info["is_audio_only"]
        or info.get("vcodec") == "none"
        or (info.get("_type") == "playlist" and not info.get("entries"))
    )

    # Choose best thumbnail
    thumbnail = info.get("thumbnail", "")
    thumbnails = info.get("thumbnails", [])
    if thumbnails:
        sorted_thumbs = sorted(
            thumbnails,
            key=lambda t: (t.get("width") or 0) * (t.get("height") or 0),
            reverse=True
        )
        if sorted_thumbs and sorted_thumbs[0].get("url"):
            thumbnail = sorted_thumbs[0]["url"]

    # Available formats list
    formats = []
    if not is_audio_only:
        formats.append({
            "format_id": "mp4-best",
            "ext": "mp4",
            "label": "MP4 Video (Best Quality)",
            "resolution": info.get("resolution") or (f"{info.get('height')}p" if info.get("height") else "HD"),
            "is_audio_only": False,
        })
        formats.append({
            "format_id": "mp4-720p",
            "ext": "mp4",
            "label": "MP4 Video (720p Fast)",
            "resolution": "720p",
            "is_audio_only": False,
        })
    formats.append({
        "format_id": "mp3-192k",
        "ext": "mp3",
        "label": "MP3 Audio (192 kbps)",
        "quality": "192 kbps",
        "is_audio_only": True,
    })

    return {
        "success": True,
        "data": {
            "id": info.get("id") or str(uuid.uuid4())[:8],
            "url": raw_url,
            "resolved_url": resolved_url,
            "title": info.get("title", "Untitled Media"),
            "uploader": info.get("uploader") or info.get("channel") or info.get("artist") or platform_info["name"],
            "uploader_url": info.get("uploader_url") or info.get("channel_url"),
            "duration": duration_sec,
            "duration_formatted": format_duration(duration_sec),
            "thumbnail": thumbnail,
            "platform": platform_info["platform"],
            "platform_name": platform_info["name"],
            "platform_color": platform_info["color"],
            "is_audio_only": is_audio_only,
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "formats": formats,
        }
    }


@app.post("/api/start-download")
async def start_download(req: DownloadRequest):
    """Start media download & conversion with real-time progress tracking."""
    raw_url = req.url.strip()
    target_format = req.format.lower()
    if target_format not in ["mp4", "mp3"]:
        target_format = "mp4"

    job_id = f"sd_{uuid.uuid4().hex[:8]}"
    temp_dir = tempfile.gettempdir()
    output_tmpl = os.path.join(temp_dir, f"streamdrop_{job_id}.%(ext)s")

    active_jobs[job_id] = {
        "job_id": job_id,
        "url": raw_url,
        "format": target_format,
        "status": "downloading",
        "progress": 0,
        "speed": "--",
        "eta": "--",
        "total_size": "--",
        "file_path": None,
        "filename": None,
        "error": None,
    }

    def progress_hook(d):
        if d["status"] == "downloading":
            total_bytes = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            if total_bytes > 0:
                pct = round((downloaded / total_bytes) * 98, 1)
                active_jobs[job_id]["progress"] = pct
            
            speed_bytes = d.get("speed") or 0
            if speed_bytes > 0:
                active_jobs[job_id]["speed"] = f"{speed_bytes / (1024 * 1024):.2f} MB/s"
            
            eta = d.get("eta")
            if eta is not None:
                active_jobs[job_id]["eta"] = f"{eta}s"
            
            if total_bytes > 0:
                active_jobs[job_id]["total_size"] = f"{total_bytes / (1024 * 1024):.1f} MB"

        elif d["status"] == "finished":
            active_jobs[job_id]["status"] = "converting"
            active_jobs[job_id]["progress"] = 98
            active_jobs[job_id]["file_path"] = d.get("filename")

    def run_download():
        ydl_opts = {
            "outtmpl": output_tmpl,
            "quiet": True,
            "no_warnings": True,
            "user_agent": USER_AGENT,
            "referer": "https://www.google.com/",
            "progress_hooks": [progress_hook],
        }

        if target_format == "mp3":
            ydl_opts.update({
                "format": "bestaudio/best",
                "postprocessors": [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }],
            })
        else:
            # MP4
            if req.quality == "720p":
                ydl_opts["format"] = "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best"
            else:
                ydl_opts["format"] = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best"
            ydl_opts["merge_output_format"] = "mp4"

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([raw_url])

            # Finalize file path
            expected_ext = ".mp3" if target_format == "mp3" else ".mp4"
            expected_path = os.path.join(temp_dir, f"streamdrop_{job_id}{expected_ext}")

            final_file = None
            if os.path.exists(expected_path):
                final_file = expected_path
            else:
                # Search for file starting with streamdrop_{job_id}
                for fname in os.listdir(temp_dir):
                    if fname.startswith(f"streamdrop_{job_id}"):
                        final_file = os.path.join(temp_dir, fname)
                        break

            if final_file and os.path.exists(final_file):
                active_jobs[job_id]["status"] = "completed"
                active_jobs[job_id]["progress"] = 100
                active_jobs[job_id]["file_path"] = final_file
                active_jobs[job_id]["filename"] = os.path.basename(final_file)
            else:
                active_jobs[job_id]["status"] = "failed"
                active_jobs[job_id]["error"] = "File conversion finalized without output."
        except Exception as err:
            active_jobs[job_id]["status"] = "failed"
            active_jobs[job_id]["error"] = str(err)

    asyncio.get_event_loop().run_in_executor(None, run_download)

    return {
        "success": True,
        "job_id": job_id,
        "status": "downloading",
        "message": "Download initiated."
    }


@app.get("/api/progress/{job_id}")
async def get_progress(job_id: str):
    """Poll download & conversion progress."""
    job = active_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")

    return {
        "success": True,
        "job": {
            "job_id": job["job_id"],
            "status": job["status"],
            "progress": job["progress"],
            "speed": job["speed"],
            "eta": job["eta"],
            "total_size": job["total_size"],
            "filename": job["filename"],
            "error": job["error"],
            "download_url": f"/api/file/{job_id}" if job["status"] == "completed" else None,
        }
    }


@app.get("/api/file/{job_id}")
async def download_file(
    job_id: str,
    background_tasks: BackgroundTasks,
    name: Optional[str] = None
):
    """Stream media file directly to user and trigger automatic cleanup."""
    job = active_jobs.get(job_id)
    if not job or not job.get("file_path") or not os.path.exists(job["file_path"]):
        raise HTTPException(status_code=404, detail="File expired or not found.")

    filepath = job["file_path"]
    ext = "mp3" if job["format"] == "mp3" else "mp4"
    media_type = "audio/mpeg" if ext == "mp3" else "video/mp4"

    raw_name = name or f"StreamDrop_{job_id}"
    safe_name = re.sub(r'[^\w\s.-]', '_', raw_name).strip() + f".{ext}"

    # Schedule background file cleanup after sending
    background_tasks.add_task(cleanup_file, filepath, job_id)

    return FileResponse(
        path=filepath,
        media_type=media_type,
        filename=safe_name,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'}
    )


# ---------------------------------------------------------------------------
# Embedded Frontend (Served at /)
# ---------------------------------------------------------------------------

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>StreamDrop - Universal Media Downloader & Converter</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background-color: #030712;
      color: #f3f4f6;
    }
    .glass-panel {
      background: rgba(17, 24, 39, 0.7);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .glow-emerald {
      box-shadow: 0 0 25px -5px rgba(16, 185, 129, 0.3);
    }
    @keyframes pulse-subtle {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .animate-pulse-subtle {
      animation: pulse-subtle 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
  </style>
</head>
<body class="min-h-screen flex flex-col items-center justify-between p-4 md:p-8 bg-[#030712] selection:bg-emerald-500 selection:text-black">

  <!-- Header / Nav -->
  <header class="w-full max-w-4xl flex items-center justify-between py-4 border-b border-gray-800/80 mb-8">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center text-gray-950 font-bold shadow-lg shadow-emerald-900/40">
        <i data-lucide="arrow-down-to-line" class="w-5 h-5 text-gray-950"></i>
      </div>
      <div>
        <h1 class="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          StreamDrop
          <span class="text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">v1.0</span>
        </h1>
        <p class="text-xs text-gray-400">Universal Media Downloader & Converter</p>
      </div>
    </div>
    <div class="flex items-center gap-2 text-xs text-gray-400">
      <span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
      <span>Engine Online</span>
    </div>
  </header>

  <!-- Main Container -->
  <main class="w-full max-w-3xl flex flex-col items-center gap-8">
    
    <!-- Hero Title -->
    <div class="text-center space-y-2">
      <h2 class="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white via-gray-200 to-emerald-400">
        Download & Convert Any Stream
      </h2>
      <p class="text-sm sm:text-base text-gray-400 max-w-xl mx-auto">
        Paste links from YouTube, TikTok, Facebook, Instagram, Twitter/X, and SoundCloud. Download as pristine MP4 video or 192kbps MP3 audio.
      </p>
    </div>

    <!-- Supported Platforms Pill Bar -->
    <div class="flex flex-wrap items-center justify-center gap-2 text-xs">
      <span class="px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 flex items-center gap-1.5 font-medium">
        <i data-lucide="youtube" class="w-3.5 h-3.5"></i> YouTube
      </span>
      <span class="px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center gap-1.5 font-medium">
        <i data-lucide="facebook" class="w-3.5 h-3.5"></i> Facebook
      </span>
      <span class="px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center gap-1.5 font-medium">
        <i data-lucide="music-2" class="w-3.5 h-3.5"></i> TikTok
      </span>
      <span class="px-3 py-1.5 rounded-full bg-pink-500/10 border border-pink-500/20 text-pink-400 flex items-center gap-1.5 font-medium">
        <i data-lucide="instagram" class="w-3.5 h-3.5"></i> Instagram
      </span>
      <span class="px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center gap-1.5 font-medium">
        <i data-lucide="twitter" class="w-3.5 h-3.5"></i> Twitter / X
      </span>
      <span class="px-3 py-1.5 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-400 flex items-center gap-1.5 font-medium">
        <i data-lucide="radio" class="w-3.5 h-3.5"></i> SoundCloud
      </span>
    </div>

    <!-- Input Form Section -->
    <div class="w-full glass-panel rounded-2xl p-4 sm:p-6 shadow-2xl space-y-4">
      <div class="flex items-center justify-between text-xs text-gray-400 px-1">
        <span class="font-medium flex items-center gap-1.5">
          <i data-lucide="link" class="w-3.5 h-3.5 text-emerald-400"></i> Media Stream URL
        </span>
        <div id="livePlatformBadge" class="hidden items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full"></div>
      </div>

      <div class="relative flex items-center">
        <input
          id="urlInput"
          type="url"
          placeholder="Paste link here (e.g. https://www.youtube.com/watch?v=...)"
          class="w-full bg-gray-900/90 border border-gray-700/70 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 rounded-xl px-4 py-3.5 pr-28 text-sm text-white placeholder-gray-500 outline-none transition-all"
        />
        <div class="absolute right-2 flex items-center gap-1.5">
          <button
            id="pasteBtn"
            type="button"
            class="px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs font-medium transition flex items-center gap-1 border border-gray-700/50"
            title="Paste from clipboard"
          >
            <i data-lucide="clipboard" class="w-3.5 h-3.5"></i> Paste
          </button>
        </div>
      </div>

      <button
        id="analyzeBtn"
        type="button"
        class="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-gray-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.99]"
      >
        <i data-lucide="sparkles" class="w-4 h-4"></i>
        <span>Analyze & Fetch Options</span>
      </button>
    </div>

    <!-- Error Alert Box -->
    <div id="errorBox" class="hidden w-full glass-panel border-red-500/30 bg-red-950/20 rounded-xl p-4 flex items-start gap-3 text-sm text-red-200">
      <i data-lucide="alert-circle" class="w-5 h-5 text-red-400 shrink-0 mt-0.5"></i>
      <div class="flex-1">
        <p class="font-semibold text-red-300">Extraction Error</p>
        <p id="errorMessage" class="text-xs text-red-200/80 mt-0.5"></p>
      </div>
      <button id="closeErrorBtn" class="text-red-400 hover:text-red-200"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>

    <!-- Loading Spinner / Status -->
    <div id="loadingBox" class="hidden w-full glass-panel rounded-xl p-6 flex flex-col items-center justify-center gap-3 text-center">
      <div class="w-10 h-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin"></div>
      <p id="loadingText" class="text-sm font-semibold text-gray-200">Resolving URL and extracting media streams...</p>
      <p class="text-xs text-gray-500">Applying User-Agent bypass and stream metadata analysis</p>
    </div>

    <!-- Result Card -->
    <div id="resultCard" class="hidden w-full glass-panel rounded-2xl overflow-hidden shadow-2xl border border-gray-800">
      <!-- Media Header Details -->
      <div class="p-4 sm:p-6 flex flex-col sm:flex-row gap-5 items-start">
        <!-- Thumbnail -->
        <div class="relative w-full sm:w-48 aspect-video rounded-xl overflow-hidden bg-gray-900 shrink-0 border border-gray-800">
          <img id="mediaThumbnail" src="" alt="Thumbnail" class="w-full h-full object-cover" />
          <span id="mediaDuration" class="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/80 text-[11px] font-semibold text-white"></span>
          <span id="mediaTypeBadge" class="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-emerald-500/90 text-black text-[10px] font-bold uppercase tracking-wider"></span>
        </div>

        <!-- Meta info -->
        <div class="flex-1 space-y-2">
          <div class="flex items-center gap-2">
            <span id="platformTag" class="text-xs font-semibold px-2.5 py-0.5 rounded-full"></span>
            <span id="mediaUploader" class="text-xs text-gray-400 truncate"></span>
          </div>
          <h3 id="mediaTitle" class="text-base sm:text-lg font-bold text-white leading-snug line-clamp-2"></h3>
          <p id="mediaStats" class="text-xs text-gray-500"></p>
        </div>
      </div>

      <!-- Action & Format Controls -->
      <div class="bg-gray-900/80 border-t border-gray-800 p-4 sm:p-6 space-y-4">
        <h4 class="text-xs font-bold uppercase tracking-wider text-gray-400">Select Output Format</h4>

        <div id="downloadButtonsContainer" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <!-- Populated dynamically via JS -->
        </div>

        <!-- Live Download / Conversion Progress Bar -->
        <div id="downloadProgressBox" class="hidden space-y-2 pt-3 border-t border-gray-800">
          <div class="flex items-center justify-between text-xs font-medium">
            <span id="progressStatus" class="text-emerald-400 flex items-center gap-1.5">
              <span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
              Downloading stream...
            </span>
            <span id="progressPercent" class="text-white font-bold">0%</span>
          </div>
          <div class="w-full h-2 rounded-full bg-gray-800 overflow-hidden">
            <div id="progressBar" class="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300" style="width: 0%"></div>
          </div>
          <div class="flex items-center justify-between text-[11px] text-gray-500">
            <span id="progressSpeed">Speed: --</span>
            <span id="progressEta">ETA: --</span>
          </div>
        </div>
      </div>
    </div>

  </main>

  <!-- Footer -->
  <footer class="w-full max-w-4xl text-center py-6 text-xs text-gray-500 border-t border-gray-900 mt-12">
    <p>StreamDrop Engine • yt-dlp & FFmpeg 192kbps MP3 on-the-fly stream extraction.</p>
  </footer>

  <script>
    lucide.createIcons();

    let currentMetadata = null;
    let pollInterval = null;

    const urlInput = document.getElementById('urlInput');
    const pasteBtn = document.getElementById('pasteBtn');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const livePlatformBadge = document.getElementById('livePlatformBadge');
    const errorBox = document.getElementById('errorBox');
    const errorMessage = document.getElementById('errorMessage');
    const closeErrorBtn = document.getElementById('closeErrorBtn');
    const loadingBox = document.getElementById('loadingBox');
    const resultCard = document.getElementById('resultCard');
    const downloadButtonsContainer = document.getElementById('downloadButtonsContainer');

    const downloadProgressBox = document.getElementById('downloadProgressBox');
    const progressStatus = document.getElementById('progressStatus');
    const progressPercent = document.getElementById('progressPercent');
    const progressBar = document.getElementById('progressBar');
    const progressSpeed = document.getElementById('progressSpeed');
    const progressEta = document.getElementById('progressEta');

    // Live URL Detector
    urlInput.addEventListener('input', () => {
      const val = urlInput.value.toLowerCase().trim();
      if (!val) {
        livePlatformBadge.classList.add('hidden');
        return;
      }
      let tag = null;
      if (val.includes('youtube.com') || val.includes('youtu.be')) tag = { name: 'YouTube', color: 'bg-red-500/20 text-red-400 border border-red-500/30' };
      else if (val.includes('facebook.com') || val.includes('fb.watch') || val.includes('fb.com')) tag = { name: 'Facebook', color: 'bg-blue-500/20 text-blue-400 border border-blue-500/30' };
      else if (val.includes('tiktok.com')) tag = { name: 'TikTok', color: 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' };
      else if (val.includes('instagram.com') || val.includes('instagr.am')) tag = { name: 'Instagram', color: 'bg-pink-500/20 text-pink-400 border border-pink-500/30' };
      else if (val.includes('twitter.com') || val.includes('x.com') || val.includes('t.co')) tag = { name: 'Twitter/X', color: 'bg-sky-500/20 text-sky-400 border border-sky-500/30' };
      else if (val.includes('soundcloud.com')) tag = { name: 'SoundCloud', color: 'bg-orange-500/20 text-orange-400 border border-orange-500/30' };

      if (tag) {
        livePlatformBadge.className = `flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full ${tag.color}`;
        livePlatformBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-current"></span> ${tag.name} Detected`;
        livePlatformBadge.classList.remove('hidden');
      } else {
        livePlatformBadge.classList.add('hidden');
      }
    });

    // Paste from clipboard
    pasteBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text.trim();
          urlInput.dispatchEvent(new Event('input'));
          analyzeMedia();
        }
      } catch (err) {
        console.warn('Clipboard read failed:', err);
      }
    });

    closeErrorBtn.addEventListener('click', () => {
      errorBox.classList.add('hidden');
    });

    analyzeBtn.addEventListener('click', analyzeMedia);
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') analyzeMedia();
    });

    async function analyzeMedia() {
      const url = urlInput.value.trim();
      if (!url) {
        showError('Please paste or enter a media stream URL.');
        return;
      }

      hideError();
      resultCard.classList.add('hidden');
      loadingBox.classList.remove('hidden');
      downloadProgressBox.classList.add('hidden');

      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.detail || data.error || 'Failed to analyze stream.');
        }

        currentMetadata = data.data;
        renderResult(currentMetadata);
      } catch (err) {
        showError(err.message || 'Unable to connect to stream extraction backend.');
      } finally {
        loadingBox.classList.add('hidden');
      }
    }

    function renderResult(item) {
      document.getElementById('mediaThumbnail').src = item.thumbnail || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&q=80';
      document.getElementById('mediaDuration').innerText = item.duration_formatted || '0:00';
      document.getElementById('mediaTypeBadge').innerText = item.is_audio_only ? 'Audio Stream' : 'Video Stream';
      document.getElementById('mediaTitle').innerText = item.title;
      document.getElementById('mediaUploader').innerText = item.uploader || item.platform_name;

      const pTag = document.getElementById('platformTag');
      pTag.className = `text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20`;
      pTag.innerText = item.platform_name;

      // Render Download Buttons
      downloadButtonsContainer.innerHTML = '';

      if (!item.is_audio_only) {
        // MP4 Best
        const mp4Btn = document.createElement('button');
        mp4Btn.className = 'w-full p-4 rounded-xl bg-gray-800/90 hover:bg-emerald-600 hover:text-gray-950 border border-gray-700/70 hover:border-emerald-500 transition-all flex items-center justify-between group';
        mp4Btn.innerHTML = `
          <div class="flex items-center gap-3 text-left">
            <div class="w-9 h-9 rounded-lg bg-emerald-500/20 group-hover:bg-gray-950/20 flex items-center justify-center text-emerald-400 group-hover:text-gray-950">
              <i data-lucide="video" class="w-5 h-5"></i>
            </div>
            <div>
              <p class="font-bold text-sm text-white group-hover:text-gray-950">Download MP4 Video</p>
              <p class="text-xs text-gray-400 group-hover:text-gray-900">Highest Available Quality</p>
            </div>
          </div>
          <i data-lucide="download" class="w-4 h-4 text-gray-400 group-hover:text-gray-950"></i>
        `;
        mp4Btn.onclick = () => triggerDownload(item.resolved_url || item.url, 'mp4', 'best');
        downloadButtonsContainer.appendChild(mp4Btn);
      }

      // MP3 Audio (Always available)
      const mp3Btn = document.createElement('button');
      mp3Btn.className = 'w-full p-4 rounded-xl bg-gray-800/90 hover:bg-teal-500 hover:text-gray-950 border border-gray-700/70 hover:border-teal-400 transition-all flex items-center justify-between group';
      mp3Btn.innerHTML = `
        <div class="flex items-center gap-3 text-left">
          <div class="w-9 h-9 rounded-lg bg-teal-500/20 group-hover:bg-gray-950/20 flex items-center justify-center text-teal-400 group-hover:text-gray-950">
            <i data-lucide="headphones" class="w-5 h-5"></i>
          </div>
          <div>
            <p class="font-bold text-sm text-white group-hover:text-gray-950">Convert to MP3 Audio</p>
            <p class="text-xs text-gray-400 group-hover:text-gray-900">192 kbps Crystal Clear Audio</p>
          </div>
        </div>
        <i data-lucide="download" class="w-4 h-4 text-gray-400 group-hover:text-gray-950"></i>
      `;
      mp3Btn.onclick = () => triggerDownload(item.resolved_url || item.url, 'mp3', '192k');
      downloadButtonsContainer.appendChild(mp3Btn);

      resultCard.classList.remove('hidden');
      lucide.createIcons();
    }

    async function triggerDownload(url, format, quality) {
      if (pollInterval) clearInterval(pollInterval);

      downloadProgressBox.classList.remove('hidden');
      progressBar.style.width = '2%';
      progressPercent.innerText = '0%';
      progressStatus.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Initializing stream engine...';

      try {
        const res = await fetch('/api/start-download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, format, quality })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.detail || 'Download initiation failed.');
        }

        const jobId = data.job_id;

        // Poll progress
        pollInterval = setInterval(async () => {
          try {
            const pRes = await fetch(`/api/progress/${jobId}`);
            const pData = await pRes.json();
            if (!pRes.ok) return;

            const job = pData.job;
            progressBar.style.width = `${job.progress}%`;
            progressPercent.innerText = `${job.progress}%`;

            if (job.status === 'downloading') {
              progressStatus.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Downloading media stream...';
              progressSpeed.innerText = `Speed: ${job.speed || '--'}`;
              progressEta.innerText = `ETA: ${job.eta || '--'}`;
            } else if (job.status === 'converting') {
              progressStatus.innerHTML = '<span class="inline-block w-2 h-2 rounded-full bg-teal-400 animate-spin"></span> Merging & FFmpeg MP3 encoding...';
            } else if (job.status === 'completed') {
              clearInterval(pollInterval);
              progressStatus.innerHTML = '<span class="text-emerald-400 font-bold">✓ Download Ready! Starting transfer...</span>';
              progressBar.style.width = '100%';
              progressPercent.innerText = '100%';
              
              // Trigger browser file save
              const link = document.createElement('a');
              link.href = `/api/file/${jobId}?name=${encodeURIComponent(currentMetadata?.title || 'media')}`;
              link.download = '';
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            } else if (job.status === 'failed') {
              clearInterval(pollInterval);
              showError(job.error || 'Conversion encountered a problem.');
              downloadProgressBox.classList.add('hidden');
            }
          } catch (pollErr) {
            console.warn('Poll error:', pollErr);
          }
        }, 1000);

      } catch (err) {
        showError(err.message);
        downloadProgressBox.classList.add('hidden');
      }
    }

    function showError(msg) {
      errorMessage.innerText = msg;
      errorBox.classList.remove('hidden');
      lucide.createIcons();
    }

    function hideError() {
      errorBox.classList.add('hidden');
    }
  </script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
async def serve_ui():
    """Serves the single-page Glassmorphism UI directly at /."""
    return HTMLResponse(content=HTML_TEMPLATE, status_code=200)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"\n=======================================================")
    print(f"🚀 StreamDrop Server running on http://0.0.0.0:{port}")
    print(f"=======================================================\n")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=True)
