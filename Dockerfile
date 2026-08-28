# ==============================================================================
# Nexversal Media Downloader & Full Metadata Inspector - Production Dockerfile
# ==============================================================================

# Stage 1: Build modern React UI with Vite & Tailwind
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production Python server with FFmpeg & compiled React UI
FROM python:3.11-slim AS runner

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    TEMP_DIR=/tmp/nexversal_downloads

# Install system dependencies: FFmpeg, curl, libsm6, libxext6
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsm6 \
    libxext6 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p ${TEMP_DIR}

WORKDIR /app

# Install Python backend dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy backend Python code
COPY . .

# Copy compiled React UI into /app/dist (where main.py serves it)
COPY --from=frontend-builder /app/dist ./dist

# Expose cloud port
EXPOSE 8000

# Start unified production server
CMD ["python", "start.py"]
