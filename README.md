# StreamDrop - Decoupled Production Architecture

StreamDrop is a decoupled universal media downloader and high-performance FFmpeg 192kbps MP3 audio converter supporting YouTube, TikTok, Facebook, Instagram, Twitter/X, and SoundCloud.

---

## 📁 Project Structure

```text
├── backend/
│   ├── main.py              # Standalone FastAPI server with yt-dlp, FFmpeg, & CORS
│   └── requirements.txt     # Python backend dependencies
├── frontend/
│   └── index.html           # Standalone modern responsive HTML/Tailwind/JS client
├── src/                     # React + Vite fullstack application
├── server.ts                # Fullstack Node/Express engine
└── package.json
```

---

## 🚀 Running the Decoupled Architecture

### 1. Start the FastAPI Backend (`backend/main.py`)

1. Ensure Python 3.9+ and FFmpeg are installed:
   ```bash
   # Ubuntu / Debian
   sudo apt update && sudo apt install -y ffmpeg python3-pip

   # macOS (Homebrew)
   brew install ffmpeg python
   ```

2. Install dependencies:
   ```bash
   pip install -r backend/requirements.txt
   ```

3. Launch the FastAPI server:
   ```bash
   cd backend
   uvicorn main:app --host 0.0.0.0 --port 8000 --reload
   ```
   *The backend will be live at `http://127.0.0.1:8000` with CORS enabled for all origins.*

---

### 2. Run the Standalone Frontend (`frontend/index.html`)

You can open `frontend/index.html` directly in any web browser, or serve it with any static server:

```bash
# Using Python
python3 -m http.server 3000 --directory frontend

# Or using Node http-server / npx serve
npx serve frontend -p 3000
```

The frontend automatically connects to `http://127.0.0.1:8000` when served standalone, providing full extraction, MP4/MP3 conversion, real-time download progress tracking, and instant file saving.

---

## 🛡️ Security & API Specifications

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Service uptime and engine verification |
| `POST` | `/api/analyze` | Extracts stream metadata, resolutions, & thumbnail |
| `POST` | `/api/download` | Initiates MP4 video or 192kbps MP3 conversion job |
| `GET` | `/api/progress/{job_id}` | Real-time progress polling (speed, ETA, status) |
| `GET` | `/api/file/{job_id}` | Streams file to browser with automatic disk cleanup |
