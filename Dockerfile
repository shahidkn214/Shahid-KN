# ==============================================================================
# Nexversal Media Downloader & Converter - Production Dockerfile
# ==============================================================================

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    TEMP_DIR=/tmp/nexversal_downloads

# Install system dependencies: FFmpeg, libsm6, libxext6, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsm6 \
    libxext6 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p ${TEMP_DIR}

WORKDIR /app

# Copy dependency definition and install packages
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application source code and frontend assets
COPY . .

# Expose cloud port
EXPOSE 8000

# Start production server using Python runner (handles dynamic $PORT safely)
CMD ["python", "start.py"]
