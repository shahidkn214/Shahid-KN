"""
Nexversal - Hardened Universal Media Extraction & Conversion Server
Universal video downloader and audio converter powered by FastAPI, yt-dlp, and FFmpeg.
Combines full REST API endpoints (/api/...) and Frontend Single-Page App serving from a single port.
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
import urllib.request
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
    version="2.3.0",
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
    if request.method == "OPTIONS":
        return Response(status_code=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        })
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
    "bilibili.com", "www.bilibili.com", "archive.org", "wikimedia.org", "wikipedia.org"
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
        
        is_allowed = any(
            hostname_clean == domain or hostname_clean.endswith("." + domain)
            for domain in ALLOWED_DOMAINS
        )
        if is_allowed:
            return True

        # DNS Check for public IP
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
    except Exception as e:
        logger.warning(f"SSRF / Domain check rejected URL {url_str}: {e}")
        return False

# ---------------------------------------------------------------------------
# 4. Storage & Path Traversal Guard
# ---------------------------------------------------------------------------
TEMP_DIR = Path(os.environ.get("TEMP_DIR", "/tmp/nexversal_downloads"))
TEMP_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get("DATABASE_PATH", str(TEMP_DIR.parent / "nexversal.db")))

def is_safe_path(target_path: Path) -> bool:
    try:
        resolved = target_path.resolve()
        return str(resolved).startswith(str(TEMP_DIR.resolve())) or str(resolved).startswith("/tmp")
    except Exception:
        return False

active_jobs: Dict[str, Dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# 5. Database Manager & Soft-Delete Persistence
# ---------------------------------------------------------------------------
JWT_SECRET = os.environ.get("JWT_SECRET", "nexversal_jwt_super_secret_key_2026_x89a")

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
                user_id = cursor.lastrowid
                return {"id": user_id, "email": email.lower().strip(), "username": username.strip()}
            except sqlite3.IntegrityError:
                return None

    def authenticate_user(self, identifier: str, password: str) -> Optional[Dict[str, Any]]:
        clean_id = identifier.lower().strip()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, email, username, hashed_password FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?",
                (clean_id, clean_id)
            )
            row = cursor.fetchone()
            if not row:
                return None
            if self.verify_password(password, row["hashed_password"]):
                return {"id": row["id"], "email": row["email"], "username": row["username"]}
            return None

    def get_user_by_id(self, user_id: int) -> Optional[Dict[str, Any]]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, email, username, created_at FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            if row:
                return {"id": row["id"], "email": row["email"], "username": row["username"], "created_at": row["created_at"]}
            return None

    def log_download(
        self,
        media_title: str,
        source_url: str,
        format_type: str,
        media_thumbnail: Optional[str] = None,
        platform: Optional[str] = None,
        quality: Optional[str] = None,
        user_id: Optional[int] = None
    ) -> int:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO download_history (
                    user_id, media_title, media_thumbnail, source_url, platform, format_type, quality, is_deleted_by_user
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            """, (user_id, media_title, media_thumbnail, source_url, platform, format_type, quality))
            conn.commit()
            return cursor.lastrowid

    def get_user_history(self, user_id: int) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, user_id, media_title, media_thumbnail, source_url, platform, format_type, quality, created_at
                FROM download_history
                WHERE user_id = ? AND is_deleted_by_user = 0
                ORDER BY id DESC
                LIMIT 100
            """, (user_id,))
            rows = cursor.fetchall()
            return [
                {
                    "id": r["id"],
                    "media_title": r["media_title"],
                    "media_thumbnail": r["media_thumbnail"],
                    "source_url": r["source_url"],
                    "platform": r["platform"],
                    "format_type": r["format_type"],
                    "quality": r["quality"],
                    "created_at": r["created_at"]
                }
                for r in rows
            ]

    def soft_delete_item(self, user_id: int, history_id: int) -> bool:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE download_history
                SET is_deleted_by_user = 1
                WHERE id = ? AND user_id = ?
            """, (history_id, user_id))
            conn.commit()
            return cursor.rowcount > 0

    def soft_delete_all(self, user_id: int) -> int:
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE download_history
                SET is_deleted_by_user = 1
                WHERE user_id = ? AND is_deleted_by_user = 0
            """, (user_id,))
            conn.commit()
            return cursor.rowcount

db_manager = DatabaseManager(DB_PATH)

def generate_jwt_token(payload: dict) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = base64.urlsafe_b64encode(json.dumps(header).encode()).decode().rstrip("=")
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return f"{header_b64}.{payload_b64}.{sig_b64}"

def decode_jwt_token(token: str) -> Optional[dict]:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        header_b64, payload_b64, sig_b64 = parts
        signing_input = f"{header_b64}.{payload_b64}"
        expected_sig = hmac.new(JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
        expected_sig_b64 = base64.urlsafe_b64encode(expected_sig).decode().rstrip("=")
        if not hmac.compare_digest(sig_b64, expected_sig_b64):
            return None
        rem = len(payload_b64) % 4
        if rem > 0:
            payload_b64 += "=" * (4 - rem)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode()).decode())
        if "exp" in payload and payload["exp"] < time.time():
            return None
        return payload
    except Exception:
        return None

def get_auth_user_from_request(request: Request) -> Optional[dict]:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ")[1].strip()
    payload = decode_jwt_token(token)
    if not payload or "sub" not in payload:
        return None
    user_id = payload["sub"]
    return db_manager.get_user_by_id(user_id)

# ---------------------------------------------------------------------------
# 6. Request/Response Models
# ---------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    email: str
    username: str
    password: str

class LoginRequest(BaseModel):
    email: Optional[str] = None
    identifier: Optional[str] = None
    password: str

class LogDownloadRequest(BaseModel):
    media_title: str
    source_url: str
    format_type: str = "mp4"
    media_thumbnail: Optional[str] = None
    platform: Optional[str] = None
    quality: Optional[str] = None

class AnalyzeRequest(BaseModel):
    url: str

class DownloadRequest(BaseModel):
    url: str
    format: str = "mp4"
    quality: str = "best"

# ---------------------------------------------------------------------------
# 7. Helper Utilities
# ---------------------------------------------------------------------------
def detect_platform(url: str) -> Dict[str, str]:
    url_lower = url.lower()
    if "youtube.com" in url_lower or "youtu.be" in url_lower:
        return {"id": "youtube", "name": "YouTube", "color": "#ef4444"}
    elif "tiktok.com" in url_lower:
        return {"id": "tiktok", "name": "TikTok", "color": "#06b6d4"}
    elif "facebook.com" in url_lower or "fb.watch" in url_lower:
        return {"id": "facebook", "name": "Facebook", "color": "#3b82f6"}
    elif "instagram.com" in url_lower:
        return {"id": "instagram", "name": "Instagram", "color": "#ec4899"}
    elif "twitter.com" in url_lower or "x.com" in url_lower:
        return {"id": "twitter", "name": "Twitter / X", "color": "#14b8a6"}
    elif "soundcloud.com" in url_lower:
        return {"id": "soundcloud", "name": "SoundCloud", "color": "#f97316"}
    elif "vimeo.com" in url_lower:
        return {"id": "vimeo", "name": "Vimeo", "color": "#0ea5e9"}
    elif "reddit.com" in url_lower:
        return {"id": "reddit", "name": "Reddit", "color": "#ff4500"}
    return {"id": "generic", "name": "Web Stream", "color": "#10b981"}

def format_duration(seconds: Optional[int]) -> str:
    if not seconds or seconds <= 0:
        return "Live / Variable"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"

def sanitize_filename(name: str) -> str:
    clean = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "", name)
    clean = clean.strip().replace("..", "_")
    return clean[:120] if clean else "Nexversal_media"

def format_filesize(bytes_val: Optional[float]) -> Optional[str]:
    if not bytes_val or bytes_val <= 0:
        return None
    mb = bytes_val / (1024 * 1024)
    if mb >= 1000:
        return f"{mb / 1024:.2f} GB"
    return f"{mb:.1f} MB"

def extract_video_resolutions(info: Dict[str, Any]) -> list:
    duration = info.get("duration") or 0
    formats = info.get("formats") or []
    
    max_height = 0
    if info.get("height"):
        try:
            max_height = max(max_height, int(info["height"]))
        except (ValueError, TypeError):
            pass

    best_audio_sz = 0
    best_audio_rate = 128
    for f in formats:
        h = f.get("height")
        vcodec = f.get("vcodec")
        acodec = f.get("acodec")
        
        if h and vcodec != "none":
            try:
                max_height = max(max_height, int(h))
            except (ValueError, TypeError):
                pass
                
        if acodec != "none" and vcodec == "none":
            if f.get("filesize") or f.get("filesize_approx"):
                best_audio_sz = max(best_audio_sz, f.get("filesize") or f.get("filesize_approx") or 0)
            if f.get("abr"):
                best_audio_rate = max(best_audio_rate, f.get("abr"))

    if max_height == 0:
        max_height = 1080

    tier_definitions = [
        {"height": 2160, "resolution": "2160p", "label": "4K Ultra HD (2160p)", "badge": "4K UHD", "video_bitrate": 15000},
        {"height": 1440, "resolution": "1440p", "label": "2K Quad HD (1440p)", "badge": "2K QHD", "video_bitrate": 8000},
        {"height": 1080, "resolution": "1080p", "label": "1080p Full HD", "badge": "1080p FHD", "video_bitrate": 3500},
        {"height": 720, "resolution": "720p", "label": "720p HD High Definition", "badge": "720p HD", "video_bitrate": 1800},
        {"height": 480, "resolution": "480p", "label": "480p Standard Definition", "badge": "480p SD", "video_bitrate": 900},
        {"height": 360, "resolution": "360p", "label": "360p Medium Quality", "badge": "360p", "video_bitrate": 500},
        {"height": 240, "resolution": "240p", "label": "240p Low Quality", "badge": "240p", "video_bitrate": 300},
        {"height": 144, "resolution": "144p", "label": "144p Compact / Data Saver", "badge": "144p", "video_bitrate": 150},
    ]

    detected = []
    for tier in tier_definitions:
        th = tier["height"]
        if th <= max_height:
            dur = duration if duration > 0 else 150
            total_bitrate = tier["video_bitrate"] + best_audio_rate
            comp_bytes = (total_bitrate * 1000 * dur) / 8
            detected.append({
                "resolution": tier["resolution"],
                "height": th,
                "label": tier["label"],
                "badge": tier["badge"],
                "ext": "mp4",
                "filesizeApprox": format_filesize(comp_bytes),
                "isRecommended": False
            })

    if not detected:
        dur = duration if duration > 0 else 150
        detected = [
            {"resolution": "1080p", "height": 1080, "label": "1080p Full HD", "badge": "1080p FHD", "ext": "mp4", "isRecommended": True, "filesizeApprox": format_filesize((3628 * 1000 * dur) / 8)},
            {"resolution": "720p", "height": 720, "label": "720p HD High Definition", "badge": "720p HD", "ext": "mp4", "isRecommended": False, "filesizeApprox": format_filesize((1928 * 1000 * dur) / 8)},
            {"resolution": "480p", "height": 480, "label": "480p Standard Definition", "badge": "480p SD", "ext": "mp4", "isRecommended": False, "filesizeApprox": format_filesize((1028 * 1000 * dur) / 8)},
        ]

    has_1080 = False
    for res in detected:
        if res["resolution"] == "1080p":
            res["isRecommended"] = True
            has_1080 = True
            break
    if not has_1080 and detected:
        detected[0]["isRecommended"] = True

    return detected

def extract_audio_bitrates(info: Dict[str, Any]) -> list:
    duration = info.get("duration") or 0
    duration_calc = duration if duration > 0 else 180
    presets = [
        {"bitrate": "320k", "kbps": 320, "label": "320 kbps (Ultra High Quality MP3)", "badge": "Ultra HQ", "isRecommended": False},
        {"bitrate": "192k", "kbps": 192, "label": "192 kbps (Standard Quality MP3)", "badge": "Standard (Recommended)", "isRecommended": True},
        {"bitrate": "128k", "kbps": 128, "label": "128 kbps (Compact / Fast MP3)", "badge": "Fast", "isRecommended": False},
        {"bitrate": "64k", "kbps": 64, "label": "64 kbps (Low Bandwidth Audio)", "badge": "Low Data", "isRecommended": False},
    ]

    result = []
    for p in presets:
        sz_bytes = (p["kbps"] * 1000 / 8) * duration_calc
        result.append({
            "bitrate": p["bitrate"],
            "kbps": p["kbps"],
            "label": p["label"],
            "badge": p["badge"],
            "ext": "mp3",
            "filesizeApprox": format_filesize(sz_bytes),
            "isRecommended": p["isRecommended"]
        })
    return result

def find_ffmpeg_binary() -> Optional[str]:
    path_bin = shutil.which("ffmpeg")
    if path_bin:
        return path_bin
    common_locations = [
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        os.path.join(os.getcwd(), "ffmpeg"),
    ]
    for loc in common_locations:
        if os.path.exists(loc):
            return loc
    return None

async def run_ytdlp_process(cmd: list, job: dict, progress_re: re.Pattern) -> tuple[int, list[str]]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    stderr_output = []

    async def capture_stderr():
        try:
            while True:
                err_line = await proc.stderr.readline()
                if not err_line:
                    break
                decoded = err_line.decode("utf-8", errors="ignore").strip()
                if decoded:
                    stderr_output.append(decoded)
        except Exception:
            pass

    asyncio.create_task(capture_stderr())

    while True:
        line_bytes = await proc.stdout.readline()
        if not line_bytes:
            break
        line = line_bytes.decode("utf-8", errors="ignore").strip()

        match = progress_re.search(line)
        if match:
            pct = float(match.group(1))
            job["progress"] = min(95, max(10, int(pct)))
            job["total_size"] = match.group(2)
            job["speed"] = match.group(3)
            job["eta"] = match.group(4)
            job["status"] = "downloading"
        elif "[ExtractAudio]" in line or "[ffmpeg]" in line or "Post-process" in line or "[Merger]" in line:
            job["status"] = "converting"
            job["progress"] = 94
            job["speed"] = "Encoding & FFmpeg processing..."

    await proc.wait()
    return proc.returncode, stderr_output

async def execute_download_job(job_id: str, url: str, fmt: str, quality: str):
    job = active_jobs.get(job_id)
    if not job:
        return

    output_template = str(TEMP_DIR / f"{job_id}.%(ext)s")
    job["status"] = "downloading"
    job["progress"] = 10
    job["speed"] = "Connecting to stream..."

    ffmpeg_bin = find_ffmpeg_binary()

    base_args = [
        "yt-dlp",
        "--no-warnings",
        "--no-playlist",
        "--socket-timeout", "20",
        "--max-filesize", "500M",
        "--geo-bypass",
        "--no-check-certificates",
        "--extractor-retries", "5",
        "--fragment-retries", "10",
        "--retry-sleep", "1",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "--referer", "https://www.google.com/",
        "--add-header", "Accept-Language:en-US,en;q=0.9",
        "--add-header", "Sec-Fetch-Mode:navigate",
        "-o", output_template,
        "--newline"
    ]

    if ffmpeg_bin:
        base_args.extend(["--ffmpeg-location", ffmpeg_bin])

    # Player client strategies to bypass 403 Forbidden
    client_strategies = [
        "youtube:player_client=android,ios,web;player_skip=configs;generic:impersonate=chrome",
        "youtube:player_client=ios,web;player_skip=configs",
        "youtube:player_client=android,web;player_skip=configs",
        "youtube:player_client=web;player_skip=configs"
    ]

    progress_re = re.compile(r"\[download\]\s+([0-9\.]+)%\s+of\s+~?([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)")

    for attempt, extractor_arg in enumerate(client_strategies):
        cmd = list(base_args)
        cmd.extend(["--extractor-args", extractor_arg])

        if fmt == "mp3":
            audio_bitrate = str(quality).lower().replace("k", "")
            if audio_bitrate not in ["320", "192", "128", "64"]:
                audio_bitrate = "192"

            cmd.extend([
                "-f", "bestaudio/best",
                "-x",
                "--audio-format", "mp3",
                "--audio-quality", audio_bitrate,
                "--embed-thumbnail",
                "--add-metadata"
            ])
        else:
            target_height = 720
            match = re.search(r"(\d{3,4})", str(quality))
            if match:
                target_height = int(match.group(1))

            if attempt > 0:
                format_ladder = (
                    f"bestvideo[height<={target_height}]+bestaudio/"
                    f"best[height<={target_height}]/"
                    f"best"
                )
            else:
                format_ladder = (
                    f"bestvideo[height<={target_height}][ext=mp4]+bestaudio[ext=m4a]/"
                    f"bestvideo[height<={target_height}]+bestaudio/"
                    f"best[height<={target_height}]/"
                    f"bestvideo+bestaudio/"
                    f"best"
                )

            cmd.extend([
                "-f", format_ladder,
                "--merge-output-format", "mp4",
            ])

        cmd.append(url)
        logger.info(f"Executing secure job {job_id} (attempt {attempt+1}) on {url}")

        try:
            returncode, stderr_output = await run_ytdlp_process(cmd, job, progress_re)

            if returncode == 0:
                ext = "mp3" if fmt == "mp3" else "mp4"
                final_file = TEMP_DIR / f"{job_id}.{ext}"

                if not final_file.exists():
                    matched = list(TEMP_DIR.glob(f"{job_id}.*"))
                    if matched:
                        final_file = matched[0]
                        ext = final_file.suffix.lstrip(".")

                if final_file.exists() and is_safe_path(final_file):
                    job["status"] = "completed"
                    job["progress"] = 100
                    job["speed"] = "Done"
                    job["file_path"] = str(final_file)
                    job["file_size"] = final_file.stat().st_size
                    job["download_url"] = f"/api/file/{job_id}"
                    logger.info(f"Job {job_id} completed successfully on attempt {attempt+1}: {final_file}")
                    return

            # Check if 403 or client error occurred, retry with next client
            full_err = "\n".join(stderr_output)
            logger.warning(f"Job {job_id} attempt {attempt+1} failed ({returncode}): {full_err}")

            if "403" in full_err or "Forbidden" in full_err or "bot" in full_err.lower():
                job["speed"] = f"Switching client strategy ({attempt+2}/{len(client_strategies)})..."
                await asyncio.sleep(1)
                continue
            else:
                # If not a client/403 issue and last attempt, break
                if attempt == len(client_strategies) - 1:
                    break

        except Exception as e:
            logger.exception(f"Unexpected error in job {job_id} attempt {attempt+1}: {e}")
            if attempt == len(client_strategies) - 1:
                break

    # If all attempts failed
    meaningful_err = "Media stream returned 403 Forbidden or is restricted by the platform. Please try another video or copy the full direct URL."
    if 'stderr_output' in locals():
        for l in reversed(stderr_output):
            if "ERROR:" in l or "error" in l.lower():
                meaningful_err = l.replace("ERROR:", "").strip()
                break

    job["status"] = "failed"
    job["error"] = meaningful_err

# ---------------------------------------------------------------------------
# 8. Complete API Routes & Aliases
# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "service": "Nexversal Media Server",
        "timestamp": int(time.time() * 1000)
    }

@app.post("/api/analyze")
async def analyze_url(payload: AnalyzeRequest, request: Request):
    client_ip = get_client_ip(request)
    if rate_limiter.is_rate_limited(client_ip, max_requests=25, window_seconds=60):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Please wait a moment before analyzing another link."
        )

    url = payload.url.strip()
    if not is_safe_public_url(url):
        raise HTTPException(status_code=400, detail="Requested domain is restricted or invalid.")

    logger.info(f"Analyzing URL from {client_ip}: {url}")
    cmd = [
        "yt-dlp",
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        "--socket-timeout", "12",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "--referer", "https://www.google.com/",
        "--extractor-args", "youtube:player_client=android,web;tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;generic:impersonate=chrome",
        url
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            err_text = stderr.decode("utf-8", errors="ignore")
            clean_err = "\n".join([
                line for line in err_text.splitlines()
                if not line.startswith("Deprecated Feature:")
                and "Support for Python version" not in line
                and "yt-dlp -U" not in line
            ])
            logger.warning(f"Analysis failed for {url}: {clean_err or err_text}")

            detail_msg = "Could not extract stream. Make sure the link is public and accessible."
            if "rehydration" in clean_err or "universal data" in clean_err:
                detail_msg = "TikTok anti-bot verification was encountered. Please try copying the web link directly."
            elif "Private video" in clean_err or "login" in clean_err:
                detail_msg = "This media is private or requires login to view."
            elif "Video unavailable" in clean_err:
                detail_msg = "This video is unavailable or has been removed."

            raise HTTPException(status_code=400, detail=detail_msg)

        info = json.loads(stdout.decode("utf-8"))
        duration = info.get("duration") or 0
        platform_info = detect_platform(url)

        is_audio_only = (
            platform_info["id"] == "soundcloud"
            or info.get("vcodec") == "none"
            or (info.get("_type") == "playlist" and not info.get("entries", [{}])[0].get("vcodec"))
        )

        video_resolutions = [] if is_audio_only else extract_video_resolutions(info)
        audio_bitrates = extract_audio_bitrates(info)

        return {
            "success": True,
            "data": {
                "id": info.get("id", str(uuid.uuid4())[:8]),
                "url": url,
                "resolvedUrl": info.get("webpage_url", url),
                "title": info.get("title", "Untitled Stream"),
                "thumbnail": info.get("thumbnail", ""),
                "duration": duration,
                "durationFormatted": format_duration(duration),
                "uploader": info.get("uploader") or info.get("channel") or info.get("artist") or platform_info["name"],
                "uploaderUrl": info.get("uploader_url") or info.get("channel_url"),
                "platform": platform_info["id"],
                "platformName": platform_info["name"],
                "platformColor": platform_info["color"],
                "viewCount": info.get("view_count", 0),
                "likeCount": info.get("like_count", 0),
                "isAudioOnly": is_audio_only,
                "videoResolutions": video_resolutions,
                "audioBitrates": audio_bitrates
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error during analysis: {e}")
        raise HTTPException(status_code=500, detail="Failed to parse media stream.")

@app.post("/api/inspect")
async def inspect_url(payload: AnalyzeRequest, request: Request):
    url = payload.url.strip()
    start_time = time.time()
    parsed_url = urllib.parse.urlparse(url)
    target_domain = parsed_url.hostname or "unknown"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1"
    }

    html_content = ""
    status_code = 200
    status_text = "OK"
    redirect_chain = []
    response_headers: Dict[str, str] = {}
    final_url = url

    try:
        import httpx
        async with httpx.AsyncClient(follow_redirects=True, timeout=10.0, verify=False) as client:
            resp = await client.get(url, headers=headers)
            status_code = resp.status_code
            status_text = resp.reason_phrase or "OK"
            final_url = str(resp.url)
            html_content = resp.text
            response_headers = {k.lower(): v for k, v in resp.headers.items()}
            for r in resp.history:
                redirect_chain.append({"url": str(r.url), "status": r.status_code})
            redirect_chain.append({"url": final_url, "status": status_code})
    except Exception as e:
        logger.warning(f"Inspection fetch failed for {url}: {e}")

    response_time_ms = int((time.time() - start_time) * 1000)

    og_data: Dict[str, Any] = {
        "title": None,
        "description": None,
        "image": None,
        "video": None,
        "type": "website",
        "url": final_url,
        "siteName": target_domain,
        "locale": "en_US",
        "twitterCard": "summary_large_image",
        "twitterTitle": None,
        "twitterDescription": None,
        "twitterImage": None,
        "twitterCreator": None,
        "twitterSite": None
    }

    structured_schemas: List[Dict[str, Any]] = []
    has_microdata = False
    hreflangs: List[Dict[str, str]] = []
    html_lang = None
    charset = "UTF-8"
    html_dir = "ltr"
    canonical_url = None
    robots_meta = response_headers.get("x-robots-tag", "index, follow")
    streams = []
    posters = []
    audio_assets = []
    doc_title = None
    meta_desc = None
    h1_list = []
    h2_list = []
    h3_list = []
    headings = []
    word_count = 0
    char_count = 0

    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, "html.parser")
        html_tag = soup.find("html")
        if html_tag:
            html_lang = html_tag.get("lang")
            html_dir = html_tag.get("dir", "ltr")

        title_el = soup.find("title")
        if title_el:
            doc_title = title_el.get_text(strip=True)

        meta_desc_el = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)})
        if meta_desc_el:
            meta_desc = meta_desc_el.get("content")

        for m in soup.find_all("meta"):
            prop = m.get("property", "") or m.get("name", "")
            content = m.get("content", "")
            if not prop or not content:
                continue
            prop_l = prop.lower()
            if prop_l == "og:title": og_data["title"] = content
            elif prop_l == "og:description": og_data["description"] = content
            elif prop_l in ("og:image", "og:image:secure_url"): og_data["image"] = content
            elif prop_l in ("og:video", "og:video:url", "og:video:secure_url"): og_data["video"] = content
            elif prop_l == "og:type": og_data["type"] = content
            elif prop_l == "og:url": og_data["url"] = content
            elif prop_l == "og:site_name": og_data["siteName"] = content
            elif prop_l == "twitter:card": og_data["twitterCard"] = content
            elif prop_l == "twitter:title": og_data["twitterTitle"] = content
            elif prop_l == "twitter:description": og_data["twitterDescription"] = content
            elif prop_l in ("twitter:image", "twitter:image:src"): og_data["twitterImage"] = content

        if not og_data["title"]: og_data["title"] = doc_title
        if not og_data["description"]: og_data["description"] = meta_desc

        for h in soup.find_all(["h1", "h2", "h3"]):
            tag = h.name.lower()
            txt = h.get_text(strip=True)
            if txt and len(headings) < 20:
                headings.append({"level": tag, "text": txt[:100]})

        body = soup.find("body")
        if body:
            for s in body(["script", "style", "noscript", "svg", "nav", "footer"]):
                s.extract()
            body_text = body.get_text(separator=" ", strip=True)
            words = body_text.split()
            word_count = len(words)
            char_count = len(body_text)

    except Exception:
        pass

    security_data = {
        "isHttps": final_url.startswith("https://"),
        "certificateIssuer": "SSL / TLS Active" if final_url.startswith("https://") else "Insecure (HTTP)",
        "contentSecurityPolicy": response_headers.get("content-security-policy"),
        "xFrameOptions": response_headers.get("x-frame-options"),
        "strictTransportSecurity": response_headers.get("strict-transport-security"),
        "xContentTypeOptions": response_headers.get("x-content-type-options"),
        "referrerPolicy": response_headers.get("referrer-policy"),
        "permissionsPolicy": response_headers.get("permissions-policy")
    }

    return {
        "success": True,
        "data": {
            "url": url,
            "targetDomain": target_domain,
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "responseTimeMs": response_time_ms,
            "openGraph": og_data,
            "structuredData": {
                "schemas": structured_schemas,
                "hasMicrodata": has_microdata,
                "totalSchemasFound": len(structured_schemas)
            },
            "i18n": {
                "htmlLang": html_lang,
                "charset": charset,
                "dir": html_dir,
                "hreflangs": hreflangs
            },
            "linkAnalysis": {
                "canonicalUrl": canonical_url,
                "robots": robots_meta,
                "statusCode": status_code,
                "statusText": status_text,
                "redirectsCount": max(0, len(redirect_chain) - 1),
                "redirectChain": redirect_chain,
                "finalUrl": final_url,
                "isHttps": final_url.startswith("https://")
            },
            "resources": {
                "streams": streams,
                "posters": posters,
                "audioAssets": audio_assets,
                "totalResources": len(streams) + len(posters) + len(audio_assets)
            },
            "documentStructure": {
                "title": doc_title,
                "metaDescription": meta_desc,
                "wordCount": word_count,
                "charCount": char_count,
                "h1Count": len(h1_list),
                "h2Count": len(h2_list),
                "h3Count": len(h3_list),
                "headings": headings
            },
            "security": security_data
        }
    }

@app.post("/api/download")
@app.post("/api/start-download")
async def start_download(payload: DownloadRequest, request: Request, background_tasks: BackgroundTasks):
    client_ip = get_client_ip(request)
    if rate_limiter.is_rate_limited(client_ip, max_requests=10, window_seconds=60):
        raise HTTPException(
            status_code=429,
            detail="Download rate limit reached. Please wait a moment."
        )

    url = payload.url
    fmt = payload.format
    quality = payload.quality or "best"
    job_id = str(uuid.uuid4())[:12]

    active_jobs[job_id] = {
        "job_id": job_id,
        "jobId": job_id,
        "url": url,
        "format": fmt,
        "quality": quality,
        "status": "queued",
        "progress": 5,
        "speed": "Queueing...",
        "eta": "--",
        "created_at": time.time()
    }

    background_tasks.add_task(execute_download_job, job_id, url, fmt, quality)

    return {
        "success": True,
        "job_id": job_id,
        "jobId": job_id,
        "status": "queued",
        "download_url": f"/api/file/{job_id}",
        "status_url": f"/api/progress/{job_id}",
        "message": f"Conversion started ({fmt.upper()})"
    }

@app.get("/api/progress/{job_id}")
@app.get("/api/download-status/{job_id}")
async def get_progress(job_id: str):
    job = active_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or expired.")

    return {
        "success": True,
        "job": job,
        "job_id": job.get("job_id", job_id),
        "jobId": job.get("jobId", job_id),
        "status": job.get("status"),
        "progress": job.get("progress", 0),
        "speed": job.get("speed"),
        "eta": job.get("eta"),
        "totalSize": job.get("total_size"),
        "downloadUrl": job.get("download_url"),
        "error": job.get("error")
    }

@app.get("/api/file/{job_id}")
@app.get("/api/download-file/{job_id}")
async def download_file(job_id: str, background_tasks: BackgroundTasks, name: Optional[str] = None):
    job = active_jobs.get(job_id)
    if not job or job.get("status") != "completed":
        raise HTTPException(status_code=404, detail="File is not ready or has expired.")

    file_path = job.get("file_path")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Requested file no longer exists.")

    p = Path(file_path)
    if not is_safe_path(p):
        raise HTTPException(status_code=403, detail="Path verification failed.")

    ext = job.get("format", "mp4")
    clean_title = sanitize_filename(name or f"nexversal_{job_id}")
    download_filename = f"{clean_title}.{ext}"
    media_type = "audio/mpeg" if ext == "mp3" else "video/mp4"

    def cleanup_file():
        try:
            if os.path.exists(file_path):
                os.remove(file_path)
            active_jobs.pop(job_id, None)
            logger.info(f"Cleaned up temporary job: {job_id}")
        except Exception as e:
            logger.warning(f"Failed to cleanup file {file_path}: {e}")

    background_tasks.add_task(cleanup_file)

    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=download_filename,
        headers={
            "Content-Disposition": f'attachment; filename="{download_filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Type",
            "X-Content-Type-Options": "nosniff"
        }
    )

# ---------------------------------------------------------------------------
# 9. Auth & History APIs
# ---------------------------------------------------------------------------
@app.post("/api/auth/register")
async def register_user(req: RegisterRequest):
    user = db_manager.create_user(req.email, req.username, req.password)
    if not user:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")

    token = generate_jwt_token({
        "sub": user["id"],
        "email": user["email"],
        "username": user["username"],
        "exp": int(time.time()) + (30 * 24 * 3600)
    })

    return {
        "success": True,
        "token": token,
        "user": user,
        "message": "Account created successfully."
    }

@app.post("/api/auth/login")
async def login_user(req: LoginRequest):
    ident = req.email or req.identifier or ""
    user = db_manager.authenticate_user(ident, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    token = generate_jwt_token({
        "sub": user["id"],
        "email": user["email"],
        "username": user["username"],
        "exp": int(time.time()) + (30 * 24 * 3600)
    })

    return {
        "success": True,
        "token": token,
        "user": user,
        "message": "Logged in successfully."
    }

@app.get("/api/auth/me")
async def get_me(request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Unauthenticated or token expired.")

    return {
        "success": True,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "username": user["username"]
        }
    }

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

    return {
        "success": True,
        "record_id": record_id,
        "is_guest": user_id is None,
        "user_id": user_id,
        "message": "Download logged for analytics and history tracking."
    }

@app.get("/api/history")
async def get_history(request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        return {"success": True, "is_guest": True, "history": []}

    history = db_manager.get_user_history(user["id"])
    return {
        "success": True,
        "is_guest": False,
        "user_id": user["id"],
        "history": history
    }

@app.delete("/api/history/{history_id}")
async def soft_delete_single_history(history_id: int, request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required to modify history.")

    success = db_manager.soft_delete_item(user["id"], history_id)
    if not success:
        raise HTTPException(status_code=404, detail="History record not found or already removed.")

    return {
        "success": True,
        "history_id": history_id,
        "message": "History item removed from your view (soft deleted)."
    }

@app.delete("/api/history")
@app.delete("/api/history/clear-all")
async def soft_delete_all_history(request: Request):
    user = get_auth_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required to clear history.")

    count = db_manager.soft_delete_all(user["id"])
    return {
        "success": True,
        "count": count,
        "message": f"Successfully cleared {count} items from your history."
    }

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

assets_dir = STATIC_ROOT / "assets"
if assets_dir.exists() and assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

@app.api_route("/{full_path:path}", methods=["GET", "HEAD", "OPTIONS"])
async def serve_frontend(full_path: str):
    if full_path.startswith("api/") or full_path == "api":
        raise HTTPException(status_code=404, detail="API endpoint not found")

    target = STATIC_ROOT / full_path
    if target.is_file():
        return FileResponse(target)

    index_file = STATIC_ROOT / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)

    if (FRONTEND_DIR / "index.html").is_file():
        return FileResponse(FRONTEND_DIR / "index.html")

    return HTMLResponse("<h1>Nexversal Server Active</h1><p>Frontend is ready.</p>")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"🚀 Nexversal Server starting at http://0.0.0.0:{port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
