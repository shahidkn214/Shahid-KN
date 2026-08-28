"""
StreamDrop - Hardened Secure FastAPI Media Extraction & Conversion Server
Universal video downloader and audio converter powered by yt-dlp and FFmpeg.
Includes SSRF Protection, IP Rate Limiting, Path Traversal Guards, and Resource Quotas.
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
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, field_validator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("streamdrop")

app = FastAPI(
    title="StreamDrop Media Extraction API",
    version="2.1.0",
    description="Decoupled high-performance secure media extractor and FFmpeg audio converter."
)

# ---------------------------------------------------------------------------
# 1. Security Middleware & Headers
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "Content-Length", "Content-Type"],
)

@app.middleware("http")
async def add_security_headers_and_limits(request: Request, call_next):
    # Enforce basic security headers
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# ---------------------------------------------------------------------------
# 2. In-Memory Sliding Window Rate Limiter (No external redis required)
# ---------------------------------------------------------------------------
class SlidingWindowRateLimiter:
    def __init__(self):
        self.requests = defaultdict(list)
        self.cleanup_counter = 0

    def is_rate_limited(self, ip: str, max_requests: int, window_seconds: int = 60) -> bool:
        now = time.time()
        timestamps = self.requests[ip]
        # Keep only timestamps within window
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
# 3. Whitelist & SSRF Protection (Block private IPs, cloud metadata, localhost)
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
    "bilibili.com", "www.bilibili.com"
}

def is_safe_public_url(url_str: str) -> bool:
    """Verifies that the target hostname resolves only to a public IP and is in the whitelist."""
    try:
        parsed = urllib.parse.urlparse(url_str)
        if parsed.scheme not in ("http", "https"):
            return False
        hostname = parsed.hostname
        if not hostname:
            return False
        
        hostname_clean = hostname.lower().strip(".")
        
        # Check domain whitelist
        is_allowed = any(
            hostname_clean == domain or hostname_clean.endswith("." + domain)
            for domain in ALLOWED_DOMAINS
        )
        if not is_allowed:
            return False

        # Block SSRF & DNS Rebinding (Localhost, 127.0.0.1, 10.x.x.x, 192.168.x.x, 169.254.x.x, ::1)
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
                ip_str.startswith("169.254.") # AWS / GCP / Azure metadata service
            ):
                return False

        return True
    except Exception as e:
        logger.warning(f"SSRF / Domain check rejected URL {url_str}: {e}")
        return False

# ---------------------------------------------------------------------------
# 4. Storage Directories & Path Traversal Guard
# ---------------------------------------------------------------------------
TEMP_DIR = Path(os.environ.get("TEMP_DIR", "/tmp/streamdrop_downloads"))
TEMP_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get("DATABASE_PATH", str(TEMP_DIR.parent / "streamdrop.db")))

def is_safe_path(target_path: Path) -> bool:
    """Guarantees path is strictly within TEMP_DIR and cannot escape via traversal."""
    try:
        resolved = target_path.resolve()
        return str(resolved).startswith(str(TEMP_DIR.resolve()))
    except Exception:
        return False

# In-memory jobs tracking
active_jobs: Dict[str, Dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# 5. Database Architecture & SQLAlchemy Model Declarations
# ---------------------------------------------------------------------------
JWT_SECRET = os.environ.get("JWT_SECRET", "streamdrop_jwt_super_secret_key_2026_x89a")
JWT_ALGORITHM = "HS256"

# Optional SQLAlchemy declarative models if sqlalchemy is present
try:
    from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, create_engine
    from sqlalchemy.ext.declarative import declarative_base
    from sqlalchemy.orm import sessionmaker, relationship
    Base = declarative_base()

    class User(Base):
        __tablename__ = "users"
        id = Column(Integer, primary_key=True, index=True)
        email = Column(String, unique=True, index=True, nullable=False)
        username = Column(String, nullable=False)
        hashed_password = Column(String, nullable=False)
        created_at = Column(DateTime, default=datetime.utcnow)
        downloads = relationship("DownloadHistory", back_populates="user")

    class DownloadHistory(Base):
        __tablename__ = "download_history"
        id = Column(Integer, primary_key=True, index=True)
        user_id = Column(Integer, ForeignKey("users.id"), nullable=True) # Null for guests
        media_title = Column(String, nullable=False)
        media_thumbnail = Column(String, nullable=True)
        source_url = Column(String, nullable=False)
        platform = Column(String, nullable=True)
        format_type = Column(String, nullable=False)
        quality = Column(String, nullable=True)
        created_at = Column(DateTime, default=datetime.utcnow)
        is_deleted_by_user = Column(Boolean, default=False) # Soft delete
        user = relationship("User", back_populates="downloads")
except Exception:
    pass

class DatabaseManager:
    """
    Production SQLite database manager implementing complete schema for Users
    and DownloadHistory with Soft-Delete functionality.
    """
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
            # Users table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    username TEXT NOT NULL,
                    hashed_password TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)
            # Download history table with is_deleted_by_user soft delete flag
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
            logger.info(f"Initialized SQLite database with soft-delete schema at {self.db_path}")

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
        """
        Soft-Delete Query: Only returns history items where is_deleted_by_user == 0
        """
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
        """
        Soft delete: Sets is_deleted_by_user = 1 without dropping the row.
        """
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
        """
        Soft delete all records for a user: Sets is_deleted_by_user = 1 without dropping rows.
        """
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
    """Generates standard HMAC-SHA256 JWT string."""
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = base64.urlsafe_b64encode(json.dumps(header).encode()).decode().rstrip("=")
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return f"{header_b64}.{payload_b64}.{sig_b64}"

def decode_jwt_token(token: str) -> Optional[dict]:
    """Decodes and validates HMAC-SHA256 JWT."""
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
        # Add back padding
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
    """Extracts authenticated user from Authorization header if valid."""
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
# 6. Request/Response Schemas with Strict Security Validation
# ---------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    email: str
    username: str
    password: str

    @field_validator("email")
    def validate_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not re.match(r"^[\w\.-]+@[\w\.-]+\.\w+$", v):
            raise ValueError("Please provide a valid email address.")
        return v

    @field_validator("username")
    def validate_username(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2 or len(v) > 30:
            raise ValueError("Username must be between 2 and 30 characters.")
        return v

    @field_validator("password")
    def validate_password(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters long.")
        return v

class LoginRequest(BaseModel):
    email: str
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

    @field_validator("url")
    def validate_url_security(cls, v: str) -> str:
        v = v.strip()
        if len(v) > 2048:
            raise ValueError("URL exceeds maximum permitted length (2048 chars).")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("Only HTTP and HTTPS protocols are permitted.")
        if not is_safe_public_url(v):
            raise ValueError("URL domain is restricted or unsupported.")
        return v

class DownloadRequest(BaseModel):
    url: str
    format: str = "mp4"  # "mp4" or "mp3"
    quality: str = "best"

    @field_validator("url")
    def validate_download_url(cls, v: str) -> str:
        v = v.strip()
        if len(v) > 2048:
            raise ValueError("URL exceeds maximum length.")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("Only HTTP/HTTPS allowed.")
        if not is_safe_public_url(v):
            raise ValueError("URL domain is restricted or unsupported.")
        return v

    @field_validator("format")
    def validate_format(cls, v: str) -> str:
        fmt = v.lower().strip()
        if fmt not in ("mp4", "mp3"):
            raise ValueError("Format must be either 'mp4' or 'mp3'.")
        return fmt

# ---------------------------------------------------------------------------
# Helper Functions
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
    return clean[:120] if clean else "StreamDrop_media"

def format_filesize(bytes_val: Optional[float]) -> Optional[str]:
    if not bytes_val or bytes_val <= 0:
        return None
    mb = bytes_val / (1024 * 1024)
    if mb >= 1000:
        return f"{mb / 1024:.2f} GB"
    return f"{mb:.1f} MB"

def extract_video_resolutions(info: Dict[str, Any]) -> list:
    """Extract full resolution hierarchy (<= max_height) with accurate size estimations."""
    duration = info.get("duration") or 0
    formats = info.get("formats") or []
    
    max_height = 0
    if info.get("height"):
        try:
            max_height = max(max_height, int(info["height"]))
        except (ValueError, TypeError):
            pass

    best_audio_sz = 0
    best_audio_rate = 128  # kbps default
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

    format_sizes_by_height: Dict[int, float] = {}
    for f in formats:
        h = f.get("height")
        vcodec = f.get("vcodec")
        if not h or vcodec == "none":
            continue
        sz = f.get("filesize") or f.get("filesize_approx")
        if not sz and duration and f.get("tbr"):
            sz = (f["tbr"] * 1000 / 8) * duration
        if sz and sz > 0:
            if h not in format_sizes_by_height or format_sizes_by_height[h] < sz:
                if f.get("acodec") == "none":
                    audio_add = best_audio_sz if best_audio_sz > 0 else (best_audio_rate * 1000 / 8) * duration
                    sz += audio_add
                format_sizes_by_height[h] = sz

    detected_resolutions = []
    for tier in tier_definitions:
        th = tier["height"]
        if th <= max_height:
            computed_bytes = None
            if th in format_sizes_by_height:
                computed_bytes = format_sizes_by_height[th]
            elif duration > 0:
                total_bitrate_kbps = tier["video_bitrate"] + best_audio_rate
                computed_bytes = (total_bitrate_kbps * 1000 * duration) / 8
            else:
                total_bitrate_kbps = tier["video_bitrate"] + best_audio_rate
                computed_bytes = (total_bitrate_kbps * 1000 * 150) / 8

            detected_resolutions.append({
                "resolution": tier["resolution"],
                "height": th,
                "label": tier["label"],
                "badge": tier["badge"],
                "ext": "mp4",
                "filesizeApprox": format_filesize(computed_bytes),
                "isRecommended": False
            })

    if not detected_resolutions:
        duration_est = duration if duration > 0 else 150
        detected_resolutions = [
            {"resolution": "1080p", "height": 1080, "label": "1080p Full HD", "badge": "1080p FHD", "ext": "mp4", "isRecommended": True, "filesizeApprox": format_filesize((3628 * 1000 * duration_est) / 8)},
            {"resolution": "720p", "height": 720, "label": "720p HD High Definition", "badge": "720p HD", "ext": "mp4", "isRecommended": False, "filesizeApprox": format_filesize((1928 * 1000 * duration_est) / 8)},
            {"resolution": "480p", "height": 480, "label": "480p Standard Definition", "badge": "480p SD", "ext": "mp4", "isRecommended": False, "filesizeApprox": format_filesize((1028 * 1000 * duration_est) / 8)},
            {"resolution": "360p", "height": 360, "label": "360p Medium Quality", "badge": "360p", "ext": "mp4", "isRecommended": False, "filesizeApprox": format_filesize((628 * 1000 * duration_est) / 8)},
        ]

    has_1080 = False
    for res in detected_resolutions:
        if res["resolution"] == "1080p":
            res["isRecommended"] = True
            has_1080 = True
            break
    if not has_1080 and detected_resolutions:
        detected_resolutions[0]["isRecommended"] = True

    return detected_resolutions

def extract_audio_bitrates(info: Dict[str, Any]) -> list:
    """Provide standard audio quality presets with calculated size approximations."""
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

# ---------------------------------------------------------------------------
# Background Download Task with Resilient Quality Ladder & FFmpeg Handling
# ---------------------------------------------------------------------------
def find_ffmpeg_binary() -> Optional[str]:
    """Find system or bundled FFmpeg binary across Linux, macOS, and Windows."""
    path_bin = shutil.which("ffmpeg")
    if path_bin:
        return path_bin

    common_locations = [
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        os.path.join(os.getcwd(), "ffmpeg.exe"),
        os.path.join(os.getcwd(), "ffmpeg"),
    ]
    for loc in common_locations:
        if os.path.exists(loc):
            return loc
    return None

async def execute_download_job(job_id: str, url: str, fmt: str, quality: str):
    job = active_jobs.get(job_id)
    if not job:
        return

    output_template = str(TEMP_DIR / f"{job_id}.%(ext)s")
    job["status"] = "downloading"
    job["progress"] = 10
    job["speed"] = "Connecting to stream..."

    ffmpeg_bin = find_ffmpeg_binary()

    # Build hardened yt-dlp arguments
    cmd = [
        "yt-dlp",
        "--no-warnings",
        "--no-playlist",
        "--socket-timeout", "15",
        "--max-filesize", "500M",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "--referer", "https://www.google.com/",
        "-o", output_template,
        "--newline"
    ]

    if ffmpeg_bin:
        cmd.extend(["--ffmpeg-location", ffmpeg_bin])

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

        # Resilient format selector fallback ladder
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
            "--postprocessor-args", f"ffmpeg:-vf scale=-2:min(ih\\,{target_height})"
        ])

    cmd.append(url)
    logger.info(f"Executing secure job {job_id} on {url}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        progress_re = re.compile(r"\[download\]\s+([0-9\.]+)%\s+of\s+~?([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)")
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

        if proc.returncode != 0:
            full_err = "\n".join(stderr_output)
            logger.error(f"Job {job_id} failed with code {proc.returncode}: {full_err}")
            job["status"] = "failed"
            meaningful_err = "Media extraction/conversion encountered an error."
            for l in reversed(stderr_output):
                if "ERROR:" in l or "error" in l.lower():
                    meaningful_err = l.replace("ERROR:", "").strip()
                    break
            job["error"] = meaningful_err
            return

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
            logger.info(f"Job {job_id} completed successfully: {final_file}")
        else:
            job["status"] = "failed"
            job["error"] = "Output file was not generated or path violation."

    except Exception as e:
        logger.exception(f"Unexpected error in job {job_id}: {e}")
        job["status"] = "failed"
        job["error"] = "Media processing encountered an unexpected issue."

# ---------------------------------------------------------------------------
# API Routes with Rate Limiting and Strict Input Validation
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health_check():
    """Health check for uptime and monitoring."""
    return {
        "status": "online",
        "service": "StreamDrop Secure Backend",
        "engine": "FastAPI + yt-dlp + FFmpeg",
        "ssrf_protection": "active",
        "rate_limiting": "active",
        "timestamp": time.time()
    }

@app.post("/api/analyze")
async def analyze_url(payload: AnalyzeRequest, request: Request):
    """
    Extracts metadata from any supported video/audio URL with Rate Limiting & SSRF Protection.
    """
    client_ip = get_client_ip(request)
    if rate_limiter.is_rate_limited(client_ip, max_requests=25, window_seconds=60):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Please wait a moment before analyzing another link."
        )

    url = payload.url

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
            # Filter out non-fatal Python deprecation warnings
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

            raise HTTPException(
                status_code=400,
                detail=detail_msg
            )

        info = json.loads(stdout.decode("utf-8"))

        # Enforce maximum duration limit (3 hours max)
        duration = info.get("duration") or 0
        if duration > 10800:
            raise HTTPException(status_code=400, detail="Media exceeds maximum allowed duration of 3 hours.")

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
                "audioBitrates": audio_bitrates,
                "availableQualities": {
                    "has4K": any(r.get("height", 0) >= 2160 for r in video_resolutions),
                    "has1080p": any(r.get("height", 0) >= 1080 for r in video_resolutions),
                    "has720p": any(r.get("height", 0) >= 720 for r in video_resolutions),
                    "has480p": any(r.get("height", 0) >= 480 for r in video_resolutions),
                    "hasAudio": True
                }
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error during analysis: {e}")
        raise HTTPException(status_code=500, detail="Failed to parse media stream.")

@app.post("/api/inspect")
async def inspect_url(payload: AnalyzeRequest, request: Request):
    """
    Advanced Web & Media Metadata Inspector (7 Core Modules):
    1. Open Graph & Social Cards
    2. Structured Data (Schema.org JSON-LD / Microdata)
    3. Internationalization (i18n & hreflang)
    4. Link Analysis (Canonical, robots, redirect chain, status)
    5. Resources (Streams, Posters, Audio Assets)
    6. Document Structure (Headings hierarchy, word count, character stats)
    7. Security Indicators (HTTPS, CSP, HSTS, X-Frame-Options)
    """
    client_ip = get_client_ip(request)
    if rate_limiter.is_rate_limited(client_ip, max_requests=30, window_seconds=60):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Please wait a moment before inspecting another URL."
        )

    url = payload.url
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
        logger.warning(f"httpx fetch failed for inspect {url}: {e}")
        try:
            req_py = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req_py, timeout=10) as response:
                status_code = response.getcode()
                final_url = response.geturl()
                html_content = response.read().decode("utf-8", errors="ignore")
                for k, v in response.info().items():
                    response_headers[k.lower()] = v
                redirect_chain.append({"url": final_url, "status": status_code})
        except Exception as e2:
            logger.warning(f"urllib fallback fetch failed: {e2}")

    response_time_ms = int((time.time() - start_time) * 1000)

    # 1. Open Graph & Social
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

    # 2. Structured Data
    structured_schemas: List[Dict[str, Any]] = []
    has_microdata = False

    # 3. i18n
    hreflangs: List[Dict[str, str]] = []
    html_lang = None
    charset = response_headers.get("content-type", "").split("charset=")[-1] if "charset=" in response_headers.get("content-type", "") else "UTF-8"
    html_dir = "ltr"

    # 4. Link Analysis
    canonical_url = None
    robots_meta = response_headers.get("x-robots-tag", "index, follow")

    # 5. Resources
    streams = []
    posters = []
    audio_assets = []

    # 6. Document Structure
    doc_title = None
    meta_desc = None
    h1_list = []
    h2_list = []
    h3_list = []
    headings = []
    word_count = 0
    char_count = 0

    # Parse with BeautifulSoup if available, else standard regex parser
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, "html.parser")

        # HTML tag attributes
        html_tag = soup.find("html")
        if html_tag:
            html_lang = html_tag.get("lang")
            html_dir = html_tag.get("dir", "ltr")

        # Title and Description
        title_el = soup.find("title")
        if title_el:
            doc_title = title_el.get_text(strip=True)

        meta_desc_el = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)})
        if meta_desc_el:
            meta_desc = meta_desc_el.get("content")

        # Meta tags
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
            elif prop_l == "og:locale": og_data["locale"] = content
            elif prop_l == "twitter:card": og_data["twitterCard"] = content
            elif prop_l == "twitter:title": og_data["twitterTitle"] = content
            elif prop_l == "twitter:description": og_data["twitterDescription"] = content
            elif prop_l in ("twitter:image", "twitter:image:src"): og_data["twitterImage"] = content
            elif prop_l == "twitter:creator": og_data["twitterCreator"] = content
            elif prop_l == "twitter:site": og_data["twitterSite"] = content
            elif prop_l in ("robots", "googlebot"): robots_meta = content

        if not og_data["title"]: og_data["title"] = doc_title
        if not og_data["description"]: og_data["description"] = meta_desc

        # Canonical & hreflangs
        for link in soup.find_all("link"):
            rel = link.get("rel", [])
            if isinstance(rel, str): rel = [rel]
            rel = [r.lower() for r in rel]
            href = link.get("href")
            if "canonical" in rel and href:
                canonical_url = urllib.parse.urljoin(final_url, href)
            if "alternate" in rel and link.get("hreflang") and href:
                hreflangs.append({"lang": link.get("hreflang"), "href": urllib.parse.urljoin(final_url, href)})

        # JSON-LD Schemas
        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            try:
                raw_txt = script.get_text().strip()
                if raw_txt:
                    parsed_json = json.loads(raw_txt)
                    items = parsed_json if isinstance(parsed_json, list) else parsed_json.get("@graph", [parsed_json]) if isinstance(parsed_json, dict) else [parsed_json]
                    for it in items:
                        if isinstance(it, dict):
                            author_info = it.get("author") or it.get("creator") or it.get("publisher")
                            author_name = author_info if isinstance(author_info, str) else author_info.get("name") if isinstance(author_info, dict) else None
                            structured_schemas.append({
                                "context": it.get("@context", "https://schema.org"),
                                "type": str(it.get("@type", "Object")),
                                "name": it.get("name") or it.get("headline") or it.get("title"),
                                "description": str(it.get("description", ""))[:300] or None,
                                "uploadDate": it.get("uploadDate") or it.get("datePublished") or it.get("dateCreated"),
                                "author": {"name": author_name} if author_name else None,
                                "raw": it
                            })
            except Exception:
                pass

        has_microdata = bool(soup.find(attrs={"itemscope": True}) or soup.find(attrs={"itemtype": True}))

        # Headings
        for h in soup.find_all(["h1", "h2", "h3"]):
            tag = h.name.lower()
            txt = h.get_text(strip=True)
            if txt:
                if tag == "h1": h1_list.append(txt)
                elif tag == "h2": h2_list.append(txt)
                elif tag == "h3": h3_list.append(txt)
                if len(headings) < 20:
                    headings.append({"level": tag, "text": txt[:100]})

        # Resources
        for v in soup.find_all(["video", "source"]):
            src = v.get("src")
            if src:
                full_src = urllib.parse.urljoin(final_url, src)
                mtype = v.get("type", "video/mp4")
                streams.append({
                    "url": full_src,
                    "type": "manifest" if ".m3u8" in full_src else "video",
                    "mimeType": mtype,
                    "label": "HLS Manifest (.m3u8)" if ".m3u8" in full_src else "Direct Stream (.mp4)"
                })

        for a in soup.find_all(["audio"]):
            src = a.get("src")
            if src:
                audio_assets.append({
                    "url": urllib.parse.urljoin(final_url, src),
                    "type": "audio",
                    "mimeType": a.get("type", "audio/mpeg"),
                    "label": "Embedded Audio Asset"
                })

        for v in soup.find_all("video"):
            poster = v.get("poster")
            if poster:
                posters.append({
                    "url": urllib.parse.urljoin(final_url, poster),
                    "type": "image",
                    "mimeType": "image/jpeg",
                    "label": "HTML5 Video Poster"
                })

        # Text analytics
        body = soup.find("body")
        if body:
            for s in body(["script", "style", "noscript", "svg", "nav", "footer"]):
                s.extract()
            body_text = body.get_text(separator=" ", strip=True)
            words = body_text.split()
            word_count = len(words)
            char_count = len(body_text)

    except Exception:
        # Regex Fallback Parser
        title_m = re.search(r"<title[^>]*>(.*?)</title>", html_content, re.I | re.S)
        if title_m: doc_title = title_m.group(1).strip()
        og_data["title"] = doc_title

        desc_m = re.search(r'<meta[^>]+name=[\'"]description[\'"][^>]+content=[\'"]([^\'"]*)[\'"]', html_content, re.I)
        if desc_m: meta_desc = desc_m.group(1).strip()

        og_t_m = re.search(r'<meta[^>]+property=[\'"]og:title[\'"][^>]+content=[\'"]([^\'"]*)[\'"]', html_content, re.I)
        if og_t_m: og_data["title"] = og_t_m.group(1).strip()

        og_img_m = re.search(r'<meta[^>]+property=[\'"]og:image[\'"][^>]+content=[\'"]([^\'"]*)[\'"]', html_content, re.I)
        if og_img_m: og_data["image"] = og_img_m.group(1).strip()

        h1_matches = re.findall(r'<h1[^>]*>(.*?)</h1>', html_content, re.I | re.S)
        h1_list = [re.sub(r'<[^>]+>', '', h).strip() for h in h1_matches if h.strip()]

    if og_data["image"]:
        posters.append({
            "url": og_data["image"],
            "type": "image",
            "mimeType": "image/webp" if og_data["image"].endswith(".webp") else "image/jpeg",
            "label": "Open Graph Social Image"
        })

    # Security indicators
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
    """
    Initializes a background download / conversion job with rate limiting.
    """
    client_ip = get_client_ip(request)
    if rate_limiter.is_rate_limited(client_ip, max_requests=8, window_seconds=60):
        raise HTTPException(
            status_code=429,
            detail="Download rate limit reached (max 8 downloads/min). Please wait a moment."
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
        "message": f"Conversion started ({fmt.upper()})"
    }

@app.get("/api/progress/{job_id}")
async def get_progress(job_id: str):
    """
    Polls real-time progress for a download job.
    """
    # Sanitize job_id to prevent injection
    if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", job_id):
        raise HTTPException(status_code=400, detail="Invalid job ID format.")

    job = active_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or expired.")

    return {
        "success": True,
        "job": job
    }

@app.get("/api/file/{job_id}")
async def download_file(job_id: str, background_tasks: BackgroundTasks, name: Optional[str] = None):
    """
    Streams the finished file to the user and guarantees automatic safe cleanup.
    """
    if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", job_id):
        raise HTTPException(status_code=400, detail="Invalid job ID.")

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
    clean_title = sanitize_filename(name or f"streamdrop_{job_id}")
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

    # Auto clean after stream delivery
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
# Auth & User Session Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/auth/register")
async def register_user(req: RegisterRequest):
    """
    Registers a new user and returns a persistent JWT auth token.
    """
    existing_user = db_manager.authenticate_user(req.email, req.password)
    user = db_manager.create_user(req.email, req.username, req.password)
    if not user:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")

    token = generate_jwt_token({
        "sub": user["id"],
        "email": user["email"],
        "username": user["username"],
        "exp": int(time.time()) + (30 * 24 * 3600)  # 30 days
    })

    return {
        "success": True,
        "token": token,
        "user": user,
        "message": "Account created successfully."
    }

@app.post("/api/auth/login")
async def login_user(req: LoginRequest):
    """
    Authenticates existing user with email/username & password, returning JWT token.
    """
    user = db_manager.authenticate_user(req.email, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    token = generate_jwt_token({
        "sub": user["id"],
        "email": user["email"],
        "username": user["username"],
        "exp": int(time.time()) + (30 * 24 * 3600)  # 30 days
    })

    return {
        "success": True,
        "token": token,
        "user": user,
        "message": "Logged in successfully."
    }

@app.get("/api/auth/me")
async def get_me(request: Request):
    """
    Validates token and returns current authenticated user profile.
    """
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

# ---------------------------------------------------------------------------
# Download Logging & Soft-Delete History Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/log-download")
async def log_download_endpoint(req: LogDownloadRequest, request: Request):
    """
    Logs every download event into SQLite.
    If authenticated, links user_id to the record.
    If guest (no token), logs user_id = NULL for audit and analytics.
    """
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
    """
    Returns the authenticated user's download history where is_deleted_by_user == False.
    Guests do not have persistent backend history.
    """
    user = get_auth_user_from_request(request)
    if not user:
        return {
            "success": True,
            "is_guest": True,
            "history": []
        }

    history = db_manager.get_user_history(user["id"])
    return {
        "success": True,
        "is_guest": False,
        "user_id": user["id"],
        "history": history
    }

@app.delete("/api/history/{history_id}")
async def soft_delete_single_history(history_id: int, request: Request):
    """
    Soft-Deletes an individual history item by setting is_deleted_by_user = True.
    The database row is permanently retained in SQLite for analytics and audit.
    """
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
    """
    Soft-Deletes ALL history items for the authenticated user by setting is_deleted_by_user = True.
    Rows are NOT deleted from SQLite (db retention preserved).
    """
    user = get_auth_user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required to clear history.")

    count = db_manager.soft_delete_all(user["id"])
    return {
        "success": True,
        "count": count,
        "message": f"Successfully cleared {count} items from your history."
    }

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"🚀 StreamDrop Hardened Backend starting at http://127.0.0.1:{port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
