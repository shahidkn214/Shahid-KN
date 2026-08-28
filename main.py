"""
Nexversal - Hardened Universal Media Extraction & Conversion Server
Universal video downloader and audio converter powered by FastAPI, yt-dlp, and FFmpeg.
Combines REST API endpoints (/api/...) and Frontend Single-Page App serving from a single port.
"""

import os
import re
import sys
import time
import json
import uuid
import shutil
import socket
import ipaddress
import urllib.parse
import asyncio
import logging
import sqlite3
import hashlib
import hmac
import base64
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from pathlib import Path
from collections import defaultdict

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("nexversal")

app = FastAPI(
    title="Nexversal Media Extraction & Conversion API",
    version="2.2.0",
    description="Decoupled high-performance secure media extractor and FFmpeg audio converter."
)

# ---------------------------------------------------------------------------
# 1. Security Middleware & Headers
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "Content-Length", "Content-Type"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# ---------------------------------------------------------------------------
# 2. In-Memory Sliding Window Rate Limiter
# ---------------------------------------------------------------------------
class SlidingWindowRateLimiter:
    def __init__(self):
        self.requests = defaultdict(list)
        self.cleanup_counter = 0

    def is_rate_limited(self, ip: str, max_requests: int, window_seconds: int = 60) -> bool:
        now = time.time()
        timestamps = self.requests[ip]
        valid_timestamps = [t for t in timestamps if now - t < window_seconds]
        self.requests[ip] = valid_timestamps

        if len(valid_timestamps) >= max_requests:
            return True

        self.requests[ip].append(now)
        self.cleanup_counter += 1
        if self.cleanup_counter > 500:
            self._cleanup_stale()
            self.cleanup_counter = 0
        return False

    def _cleanup_stale(self):
        now = time.time()
        stale_keys = [k for k, ts in self.requests.items() if not ts or (now - ts[-1] > 300)]
        for k in stale_keys:
            self.requests.pop(k, None)

rate_limiter = SlidingWindowRateLimiter()

def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"

# ---------------------------------------------------------------------------
# 3. Whitelist & SSRF Protection
# ---------------------------------------------------------------------------
ALLOWED_DOMAINS = {
    "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com",
    "facebook.com", "www.facebook.com", "web.facebook.com", "fb.watch", "m.facebook.com", "fb.com",
    "tiktok.com", "www.tiktok.com", "vt.tiktok.com", "vm.tiktok.com", "m.tiktok.com",
    "instagram.com", "www.instagram.com", "instagr.am",
    "twitter.com", "www.twitter.com", "x.com", "www.x.com", "mobile.twitter.com", "t.co",
    "soundcloud.com", "m.soundcloud.com", "www.soundcloud.com",
    "vimeo.com", "www.vimeo.com", "player.vimeo.com",
    "reddit.com", "www.reddit.com", "v.redd.it", "old.reddit.com",
    "threads.net", "www.threads.net",
    "pinterest.com", "www.pinterest.com", "pin.it",
    "twitch.tv", "www.twitch.tv", "clips.twitch.tv",
    "dailymotion.com", "www.dailymotion.com", "dai.ly",
    "bilibili.com", "www.bilibili.com",
    "archive.org", "wikimedia.org", "wikipedia.org", "googleapis.com"
}

def is_safe_public_url(url_str: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url_str)
        if parsed.scheme not in ("http", "https"):
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        
        hostname_clean = hostname.lower().strip(".")
        
        # Block localhost and internal names immediately
        if hostname_clean in ("localhost", "127.0.0.1", "::1") or hostname_clean.endswith(".local") or hostname_clean.endswith(".internal"):
            return False

        # Fast match for known public platforms
        if any(hostname_clean == d or hostname_clean.endswith("." + d) for d in ALLOWED_DOMAINS):
            return True

        # DNS Resolution check to prevent SSRF
        try:
            addr_info = socket.getaddrinfo(hostname_clean, None, proto=socket.IPPROTO_TCP)
            for _, _, _, _, sockaddr in addr_info:
                ip_str = sockaddr[0]
                ip_obj = ipaddress.ip_address(ip_str)
                if (
                    ip_obj.is_private or 
                    ip_obj.is_loopback or 
                    ip_obj.is_link_local or 
                    ip_obj.is_reserved or 
                    ip_obj.is_multicast or
                    ip_str.startswith("169.254.")
                ):
                    return False
            return True
        except Exception:
            return True
    except Exception as e:
        logger.warning(f"SSRF check rejected URL {url_str}: {e}")
        return False

# ---------------------------------------------------------------------------
# 4. Storage Directories & Path Traversal Guard
# ---------------------------------------------------------------------------
TEMP_DIR = Path(os.environ.get("TEMP_DIR", "/tmp/nexversal_downloads"))
TEMP_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get("DATABASE_PATH", str(TEMP_DIR.parent / "nexversal.db")))

def is_safe_path(target_path: Path) -> bool:
    try:
        resolved = target_path.resolve()
        return str(resolved).startswith(str(TEMP_DIR.resolve()))
    except Exception:
        return False

# In-memory download jobs
active_jobs: Dict[str, Dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# 5. Database Architecture & User Session Management
# ---------------------------------------------------------------------------
JWT_SECRET = os.environ.get("JWT_SECRET", "nexversal_jwt_secure_key_2026_x89a")
JWT_ALGORITHM = "HS256"

class DatabaseManager:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.init_db()

    def get_connection(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self):
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    username TEXT NOT NULL,
                    hashed_password TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS download_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NULL,
                    media_title TEXT NOT NULL,
                    media_thumbnail TEXT,
                    source_url TEXT NOT NULL,
                    platform TEXT,
                    format_type TEXT NOT NULL,
                    quality TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    is_deleted_by_user INTEGER DEFAULT 0,
                    FOREIGN KEY (user_id) REFERENCES users (id)
                );
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_history_user ON download_history(user_id, is_deleted_by_user);")
            conn.commit()

    @staticmethod
    def hash_password(password: str) -> str:
        salt = os.urandom(16).hex()
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
        return f"{salt}:{dk.hex()}"

    @staticmethod
    def verify_password(password: str, stored_hash: str) -> bool:
        try:
            salt, dk_hex = stored_hash.split(":")
            dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
            return hmac.compare_digest(dk.hex(), dk_hex)
        except Exception:
            return False

    def create_user(self, email: str, username: str, password: str) -> Optional[Dict[str, Any]]:
        hashed = self.hash_password(password)
        with self.get_connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "INSERT INTO users (email, username, hashed_password) VALUES (?, ?, ?)",
                    (email.lower().strip(), username.strip(), hashed)
                )
                conn.commit()
                return {"id": cursor.lastrowid, "email": email.lower().strip(), "username": username.strip()}
            except sqlite3.IntegrityError:
                return None

    def authenticate_user(self, identifier: str, password: str) -> Optional[Dict[str, Any]]:
        clean_id = identifier.lower().strip()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM users WHERE email = ? OR username = ?",
                (clean_id, clean_id)
            )
            row = cursor.fetchone()
            if row and self.verify_password(password, row["hashed_password"]):
                return {"id": row["id"], "email": row["email"], "username": row["username"]}
        return None

    def get_user_by_id(self, user_id: int) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, email, username, created_at FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            if row:
                return dict(row)
        return None

    def log_download(self, media_title: str, source_url: str, format_type: str,
                     media_thumbnail: Optional[str] = None, platform: Optional[str] = None,
                     quality: Optional[str] = None, user_id: Optional[int] = None) -> int:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO download_history
                (user_id, media_title, media_thumbnail, source_url, platform, format_type, quality, is_deleted_by_user)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (user_id, media_title, media_thumbnail, source_url, platform, format_type, quality)
            )
            conn.commit()
            return cursor.lastrowid

    def get_user_history(self, user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, media_title, media_thumbnail, source_url, platform, format_type, quality, created_at
                FROM download_history
                WHERE user_id = ? AND is_deleted_by_user = 0
                ORDER BY id DESC
                LIMIT ?
                """,
                (user_id, limit)
            )
            return [dict(row) for row in cursor.fetchall()]

    def soft_delete_item(self, user_id: int, history_id: int) -> bool:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE download_history SET is_deleted_by_user = 1 WHERE id = ? AND user_id = ?",
                (history_id, user_id)
            )
            conn.commit()
            return cursor.rowcount > 0

    def soft_delete_all(self, user_id: int) -> int:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE download_history SET is_deleted_by_user = 1 WHERE user_id = ?",
                (user_id,)
            )
            conn.commit()
            return cursor.rowcount

db_manager = DatabaseManager(DB_PATH)

# ---------------------------------------------------------------------------
# 6. JWT Utilities
# ---------------------------------------------------------------------------
def create_jwt_token(payload: Dict[str, Any]) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = base64.urlsafe_b64encode(json.dumps(header).encode()).decode().rstrip("=")
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    msg = f"{header_b64}.{payload_b64}".encode()
    signature = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return f"{header_b64}.{payload_b64}.{sig_b64}"

def verify_jwt_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        header_b64, payload_b64, sig_b64 = parts
        msg = f"{header_b64}.{payload_b64}".encode()
        expected_sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
        
        pad = len(sig_b64) % 4
        actual_sig = base64.urlsafe_b64decode(sig_b64 + ("=" * (4 - pad) if pad else ""))
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None
            
        p_pad = len(payload_b64) % 4
        payload_json = base64.urlsafe_b64decode(payload_b64 + ("=" * (4 - p_pad) if pad else "")).decode()
        return json.loads(payload_json)
    except Exception:
        return None

def get_auth_user_from_request(request: Request) -> Optional[Dict[str, Any]]:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ")[1].strip()
    data = verify_jwt_token(token)
    if not data or "user_id" not in data:
        return None
    return db_manager.get_user_by_id(data["user_id"])

# ---------------------------------------------------------------------------
# 7. Request Models
# ---------------------------------------------------------------------------
class AnalyzeRequest(BaseModel):
    url: str

    @field_validator("url")
    def validate_url(cls, v: str):
        v = v.strip()
        if not v.startswith("http://") and not v.startswith("https://"):
            raise ValueError("URL must start with http:// or https://")
        return v

class StartDownloadRequest(BaseModel):
    url: str
    format: str = "mp4" # mp4 | mp3
    quality: str = "1080p" # 1080p, 720p, 480p, 320k, 192k, 128k, etc.

class RegisterRequest(BaseModel):
    email: str
    username: str
    password: str

class LoginRequest(BaseModel):
    identifier: str
    password: str

class LogDownloadRequest(BaseModel):
    media_title: str
    source_url: str
    format_type: str
    media_thumbnail: Optional[str] = None
    platform: Optional[str] = None
    quality: Optional[str] = None

# ---------------------------------------------------------------------------
# 8. Core API Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "service": "Nexversal Media Server",
        "timestamp": int(time.time() * 1000)
    }

@app.post("/api/analyze")
async def analyze_url(req: AnalyzeRequest, request: Request):
    client_ip = get_client_ip(request)
    if rate_limiter.is_rate_limited(client_ip, max_requests=30, window_seconds=60):
        raise HTTPException(status_code=429, detail="Too many analysis requests. Please wait a moment.")

    target_url = req.url.strip()
    if not is_safe_public_url(target_url):
        raise HTTPException(status_code=400, detail="Requested domain is restricted or invalid.")

    cmd = [
        "yt-dlp",
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        "--no-check-certificates",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        target_url
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=25.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Media analysis timed out. The provider took too long to respond.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to analyze stream: {str(e)}")

    if proc.returncode != 0 or not stdout:
        err_msg = stderr.decode(errors="replace").strip()
        logger.warning(f"yt-dlp analysis failed for {target_url}: {err_msg}")
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": err_msg or "Could not extract stream metadata from URL."
            }
        )

    try:
        data = json.loads(stdout.decode(errors="replace"))
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid JSON response from extraction engine.")

    # Format resolutions and bitrates
    title = data.get("title") or "Unknown Media"
    duration = data.get("duration") or 0
    mins, secs = divmod(int(duration), 60)
    hrs, mins = divmod(mins, 60)
    dur_str = f"{hrs}:{mins:02d}:{secs:02d}" if hrs > 0 else f"{mins}:{secs:02d}"

    video_res = [
        {"resolution": "1080p", "height": 1080, "label": "1080p Full HD", "badge": "1080p FHD", "ext": "mp4", "isRecommended": True},
        {"resolution": "720p", "height": 720, "label": "720p HD", "badge": "720p HD", "ext": "mp4", "isRecommended": False},
        {"resolution": "480p", "height": 480, "label": "480p SD", "badge": "480p SD", "ext": "mp4", "isRecommended": False},
        {"resolution": "360p", "height": 360, "label": "360p Medium", "badge": "360p", "ext": "mp4", "isRecommended": False},
        {"resolution": "240p", "height": 240, "label": "240p Compact", "badge": "240p", "ext": "mp4", "isRecommended": False},
    ]

    audio_rates = [
        {"bitrate": "320k", "kbps": 320, "label": "320 kbps (Ultra HQ MP3)", "badge": "Ultra HQ", "ext": "mp3", "isRecommended": False},
        {"bitrate": "192k", "kbps": 192, "label": "192 kbps (Standard HQ MP3)", "badge": "Recommended", "ext": "mp3", "isRecommended": True},
        {"bitrate": "128k", "kbps": 128, "label": "128 kbps (Fast MP3)", "badge": "Fast", "ext": "mp3", "isRecommended": False},
        {"bitrate": "64k", "kbps": 64, "label": "64 kbps (Data Saver MP3)", "badge": "Data Saver", "ext": "mp3", "isRecommended": False},
    ]

    return {
        "success": True,
        "data": {
            "id": data.get("id") or str(uuid.uuid4())[:8],
            "url": target_url,
            "title": title,
            "uploader": data.get("uploader") or data.get("creator") or "Media Creator",
            "duration": duration,
            "durationFormatted": dur_str,
            "thumbnail": data.get("thumbnail") or "",
            "platform": data.get("extractor_key") or "Universal",
            "videoResolutions": video_res,
            "audioBitrates": audio_rates
        }
    }

async def process_media_download(job_id: str, url: str, fmt: str, quality: str):
    job = active_jobs.get(job_id)
    if not job:
        return

    output_tmpl = str(TEMP_DIR / f"{job_id}.%(ext)s")

    if fmt == "mp3":
        kbps = quality.replace("k", "") if "k" in quality else "192"
        cmd = [
            "yt-dlp",
            "--newline",
            "--no-playlist",
            "-f", "bestaudio/best",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", kbps,
            "--no-warnings",
            "--no-check-certificates",
            "-o", output_tmpl,
            url
        ]
    else:
        # Video MP4 format
        height = quality.replace("p", "") if "p" in quality else "1080"
        fmt_spec = f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/best[height<={height}]/best"
        cmd = [
            "yt-dlp",
            "--newline",
            "--no-playlist",
            "-f", fmt_spec,
            "--merge-output-format", "mp4",
            "--no-warnings",
            "--no-check-certificates",
            "-o", output_tmpl,
            url
        ]

    try:
        job["status"] = "processing"
        job["percent"] = 15
        job["statusMessage"] = "Downloading stream..."

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        async def read_stream(stream):
            while True:
                line = await stream.readline()
                if not line:
                    break
                text = line.decode(errors="replace")
                if "[download]" in text and "%" in text:
                    match = re.search(r"(\d+(?:\.\d+)?)%", text)
                    if match:
                        pct = min(int(float(match.group(1))), 95)
                        job["percent"] = pct
                        job["statusMessage"] = f"Downloading stream ({pct}%)..."
                elif "[ExtractAudio]" in text or "[Merger]" in text:
                    job["percent"] = 92
                    job["statusMessage"] = "Converting audio / merging formats..."

        await asyncio.gather(
            read_stream(proc.stdout),
            read_stream(proc.stderr),
            proc.wait()
        )

        if proc.returncode != 0:
            job["status"] = "failed"
            job["error"] = "Media conversion failed. Stream could not be processed."
            return

        # Find produced file
        produced = list(TEMP_DIR.glob(f"{job_id}.*"))
        if not produced:
            job["status"] = "failed"
            job["error"] = "Output file was not generated."
            return

        target_file = produced[0]
        job["status"] = "completed"
        job["percent"] = 100
        job["filename"] = target_file.name
        job["filesize"] = target_file.stat().st_size
        job["statusMessage"] = "File ready for download!"

    except Exception as e:
        logger.error(f"Download processing error: {e}")
        job["status"] = "failed"
        job["error"] = str(e)

@app.post("/api/start-download")
async def start_download(req: StartDownloadRequest, background_tasks: BackgroundTasks, request: Request):
    client_ip = get_client_ip(request)
    if rate_limiter.is_rate_limited(client_ip, max_requests=20, window_seconds=60):
        raise HTTPException(status_code=429, detail="Too many conversion requests. Please wait a moment.")

    if not is_safe_public_url(req.url):
        raise HTTPException(status_code=400, detail="Invalid target domain.")

    job_id = str(uuid.uuid4())
    active_jobs[job_id] = {
        "job_id": job_id,
        "url": req.url,
        "format": req.format,
        "quality": req.quality,
        "status": "queued",
        "percent": 5,
        "statusMessage": "Initializing task...",
        "created_at": time.time()
    }

    background_tasks.add_task(process_media_download, job_id, req.url, req.format, req.quality)

    return {
        "success": True,
        "job_id": job_id,
        "download_url": f"/api/download-file/{job_id}",
        "status_url": f"/api/download-status/{job_id}"
    }

@app.get("/api/download-status/{job_id}")
async def get_download_status(job_id: str):
    job = active_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@app.get("/api/download-file/{job_id}")
async def download_file(job_id: str):
    job = active_jobs.get(job_id)
    if not job or job.get("status") != "completed":
        raise HTTPException(status_code=400, detail="File is not ready or failed")

    produced = list(TEMP_DIR.glob(f"{job_id}.*"))
    if not produced:
        raise HTTPException(status_code=404, detail="Processed file not found")

    file_path = produced[0]
    ext = file_path.suffix.lstrip(".")
    mime_type = "audio/mpeg" if ext == "mp3" else "video/mp4"

    return FileResponse(
        path=str(file_path),
        media_type=mime_type,
        filename=f"nexversal_{job_id[:8]}.{ext}"
    )

# ---------------------------------------------------------------------------
# 9. Auth & History APIs
# ---------------------------------------------------------------------------
@app.post("/api/auth/register")
async def register(req: RegisterRequest):
    user = db_manager.create_user(req.email, req.username, req.password)
    if not user:
        raise HTTPException(status_code=400, detail="Email already registered.")
    token = create_jwt_token({"user_id": user["id"], "email": user["email"]})
    return {"success": True, "token": token, "user": user}

@app.post("/api/auth/login")
async def login(req: LoginRequest):
    user = db_manager.authenticate_user(req.identifier, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email/username or password.")
    token = create_jwt_token({"user_id": user["id"], "email": user["email"]})
    return {"success": True, "token": token, "user": user}

@app.get("/api/auth/me")
async def get_me(request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        return {"success": False, "is_authenticated": False}
    return {"success": True, "is_authenticated": True, "user": user}

@app.post("/api/log-download")
async def log_download_endpoint(req: LogDownloadRequest, request: Request):
    user = get_auth_user_from_request(request)
    user_id = user["id"] if user else None
    record_id = db_manager.log_download(
        media_title=req.media_title,
        source_url=req.source_url,
        format_type=req.format_type,
        media_thumbnail=req.media_thumbnail,
        platform=req.platform,
        quality=req.quality,
        user_id=user_id
    )
    return {"success": True, "record_id": record_id, "is_guest": user_id is None}

@app.get("/api/history")
async def get_history(request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        return {"success": True, "is_guest": True, "history": []}
    history = db_manager.get_user_history(user["id"])
    return {"success": True, "is_guest": False, "history": history}

@app.delete("/api/history/{history_id}")
async def delete_single_history(history_id: int, request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Auth required.")
    success = db_manager.soft_delete_item(user["id"], history_id)
    return {"success": success}

@app.delete("/api/history")
@app.delete("/api/history/clear-all")
async def clear_all_history(request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Auth required.")
    count = db_manager.soft_delete_all(user["id"])
    return {"success": True, "count": count}

# ---------------------------------------------------------------------------
# 10. Frontend Single-Page App (SPA) & Static Files Serving
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
DIST_DIR = Path(__file__).resolve().parent / "dist"

if DIST_DIR.exists() and (DIST_DIR / "index.html").exists():
    STATIC_ROOT = DIST_DIR
elif FRONTEND_DIR.exists() and (FRONTEND_DIR / "index.html").exists():
    STATIC_ROOT = FRONTEND_DIR
else:
    STATIC_ROOT = Path(__file__).resolve().parent

# Mount /assets if exists
assets_dir = STATIC_ROOT / "assets"
if assets_dir.exists() and assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    # Do not capture API routes
    if full_path.startswith("api/") or full_path == "api":
        raise HTTPException(status_code=404, detail="API endpoint not found")

    target = STATIC_ROOT / full_path
    if target.is_file():
        return FileResponse(target)

    index_file = STATIC_ROOT / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)

    # Fallback to frontend index if root was queried
    if (FRONTEND_DIR / "index.html").is_file():
        return FileResponse(FRONTEND_DIR / "index.html")

    return HTMLResponse("<h1>Nexversal Server Active</h1><p>Frontend index.html ready.</p>")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"🚀 Nexversal Server running on http://0.0.0.0:{port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
