import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UrlInputBar } from './components/UrlInputBar';
import { PlatformPills } from './components/PlatformPills';
import { ResultCard } from './components/ResultCard';
import { DownloadHistory } from './components/DownloadHistory';
import { HowItWorks } from './components/HowItWorks';
import { MediaMetadata, DownloadJob, HistoryItem, MetadataInspectionResult } from './types';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { MetadataInspector } from './components/MetadataInspector';

export default function App() {
  const [url, setUrl] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [downloadJob, setDownloadJob] = useState<DownloadJob | null>(null);
  const [isBackendHealthy, setIsBackendHealthy] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Metadata Inspector State
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectionResult, setInspectionResult] = useState<MetadataInspectionResult | null>(null);


  // History state saved to localStorage
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('streamdrop_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const pollIntervalRef = useRef<any>(null);

  // Check health on mount
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          setIsBackendHealthy(true);
        }
      } catch {
        setIsBackendHealthy(false);
      }
    };
    checkHealth();
  }, []);

  // Save history
  useEffect(() => {
    try {
      localStorage.setItem('streamdrop_history', JSON.stringify(history));
    } catch {}
  }, [history]);

  // Clean up poll interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  const handleAnalyze = async () => {
    if (!url.trim()) return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsAnalyzing(true);
    setMetadata(null);
    setDownloadJob(null);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.detail || 'Failed to extract media information.');
      }

      setMetadata(data.data);
      setSuccessMessage(`Extracted "${data.data.title.slice(0, 45)}..." from ${data.data.platformName}`);
      setTimeout(() => setSuccessMessage(null), 4000);

      // Auto-trigger inspector in background for seamless UX
      handleInspect(data.data.resolvedUrl || data.data.url || url.trim());
    } catch (err: any) {
      console.error('Analyze error:', err);
      setErrorMessage(err.message || 'Unable to connect to stream extraction backend.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleInspect = async (overrideUrl?: string) => {
    const target = (overrideUrl || url).trim();
    if (!target) return;

    setIsInspecting(true);
    try {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.detail || 'Metadata inspection failed.');
      }

      setInspectionResult(data.data);
    } catch (err: any) {
      console.warn('Inspection notice:', err.message);
    } finally {
      setIsInspecting(false);
    }
  };


  const handleStartDownload = async (format: 'mp4' | 'mp3', quality = 'best') => {
    if (!metadata) return;

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    setErrorMessage(null);
    setDownloadJob({
      jobId: 'init',
      url: metadata.resolvedUrl || metadata.url,
      format,
      quality,
      status: 'downloading',
      progress: 5,
      speed: 'Initializing...',
      eta: '--',
    });

    try {
      const res = await fetch('/api/start-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: metadata.resolvedUrl || metadata.url,
          format,
          quality,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.detail || 'Failed to initialize download engine.');
      }

      const jobId = data.jobId || data.job_id;

      // Poll progress endpoint
      pollIntervalRef.current = setInterval(async () => {
        try {
          const pRes = await fetch(`/api/progress/${jobId}`);
          const pData = await pRes.json();
          if (!pRes.ok || !pData.success) return;

          const job = pData.job;
          const currentStatus = job.status;
          const currentProgress = job.progress;

          setDownloadJob({
            jobId: job.jobId || job.job_id,
            url: metadata.url,
            format,
            quality,
            status: currentStatus,
            progress: currentProgress,
            speed: job.speed,
            eta: job.eta,
            totalSize: job.totalSize || job.total_size,
            filename: job.filename,
            downloadUrl: job.downloadUrl || job.download_url,
            error: job.error,
          });

          if (currentStatus === 'completed') {
            clearInterval(pollIntervalRef.current);

            // Add to history
            const historyEntry: HistoryItem = {
              id: Date.now().toString(),
              url: metadata.url,
              title: metadata.title,
              thumbnail: metadata.thumbnail,
              platform: metadata.platform,
              format,
              timestamp: Date.now(),
              durationFormatted: metadata.durationFormatted,
            };

            setHistory((prev) => [
              historyEntry,
              ...prev.filter((item) => item.url !== metadata.url),
            ]);

            // Trigger robust asynchronous Blob download in browser
            const downloadUrl = `/api/file/${jobId}?name=${encodeURIComponent(
              metadata.title || 'StreamDrop_media'
            )}`;
            const safeFallbackName = `${(metadata.title || 'StreamDrop_media').replace(/[^\w\s.-]/gi, '_').substring(0, 80)}.${format}`;

            (async () => {
              try {
                const response = await fetch(downloadUrl);
                if (!response.ok) {
                  throw new Error(`Server returned HTTP ${response.status}: ${response.statusText || 'Download failed'}`);
                }
                const blob = await response.blob();
                if (!blob || blob.size === 0) {
                  throw new Error('Received an empty file stream from the server.');
                }
                const blobUrl = window.URL.createObjectURL(blob);

                let finalFilename = safeFallbackName;
                const disposition = response.headers.get('Content-Disposition');
                if (disposition && disposition.includes('filename=')) {
                  const matches = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                  if (matches && matches[1]) {
                    finalFilename = decodeURIComponent(matches[1].replace(/['"]/g, '').trim());
                  }
                }

                const link = document.createElement('a');
                link.style.display = 'none';
                link.href = blobUrl;
                link.download = finalFilename;
                document.body.appendChild(link);
                link.click();

                setTimeout(() => {
                  if (document.body.contains(link)) {
                    document.body.removeChild(link);
                  }
                  window.URL.revokeObjectURL(blobUrl);
                }, 1500);

                setSuccessMessage(`Download ready! "${metadata.title.slice(0, 35)}..." saved.`);
                setTimeout(() => setSuccessMessage(null), 5000);
              } catch (blobErr: any) {
                console.error('Blob download failed:', blobErr);
                setErrorMessage(`Failed to save file to device: ${blobErr.message || 'Network error'}`);
              }
            })();
          } else if (currentStatus === 'failed') {
            clearInterval(pollIntervalRef.current);
            setErrorMessage(job.error || 'Conversion encountered an error.');
          }
        } catch (pollErr) {
          console.warn('Poll error:', pollErr);
        }
      }, 1000);
    } catch (err: any) {
      console.error('Download error:', err);
      setErrorMessage(err.message || 'Failed to start download.');
      setDownloadJob(null);
    }
  };

  const handleSelectSample = (sampleUrl: string) => {
    setUrl(sampleUrl);
  };

  const handleClearHistory = () => {
    setHistory([]);
  };

  return (
    <div className="min-h-screen bg-[#030712] text-gray-100 flex flex-col items-center selection:bg-emerald-500 selection:text-black">
      {/* Background glow effects */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-72 bg-emerald-500/10 blur-[130px] pointer-events-none rounded-full" />
      <div className="fixed bottom-0 left-1/3 w-80 h-80 bg-teal-500/5 blur-[120px] pointer-events-none rounded-full" />

      {/* Header */}
      <Header isBackendHealthy={isBackendHealthy} />

      {/* Main Content Area */}
      <main className="w-full max-w-4xl px-4 sm:px-6 flex flex-col items-center gap-7 pb-16 relative z-10">
        {/* Hero Section */}
        <div className="text-center space-y-2.5 pt-2">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-gray-100 to-emerald-400 tracking-tight leading-tight">
            Universal Media Downloader
          </h2>
          <p className="text-sm sm:text-base text-gray-400 max-w-xl mx-auto font-normal">
            Effortlessly download videos or convert audio to <span className="text-emerald-400 font-semibold">192kbps MP3</span> from YouTube, TikTok, Facebook, Instagram, Twitter/X, and SoundCloud.
          </p>
        </div>

        {/* Supported Platforms Pill Bar */}
        <PlatformPills onSelectSample={handleSelectSample} />

        {/* URL Input Form */}
        <UrlInputBar
          url={url}
          onChange={setUrl}
          onAnalyze={handleAnalyze}
          isLoading={isAnalyzing}
        />

        {/* Error Alert Notification */}
        {errorMessage && (
          <div
            id="error-alert"
            className="w-full rounded-xl bg-red-950/40 border border-red-500/40 p-4 flex items-start gap-3 text-sm text-red-200 animate-in fade-in duration-200 shadow-lg"
          >
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-red-300">Extraction Notice</p>
              <p className="text-xs text-red-200/90 mt-0.5">{errorMessage}</p>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-red-400 hover:text-red-200 transition p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Success Alert Notification */}
        {successMessage && (
          <div
            id="success-alert"
            className="w-full rounded-xl bg-emerald-950/40 border border-emerald-500/40 p-4 flex items-center gap-3 text-sm text-emerald-200 animate-in fade-in duration-200 shadow-lg"
          >
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            <p className="flex-1 text-xs text-emerald-200/90 font-medium">{successMessage}</p>
            <button
              onClick={() => setSuccessMessage(null)}
              className="text-emerald-400 hover:text-emerald-200 transition p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Media Result Card */}
        {metadata && (
          <ResultCard
            metadata={metadata}
            onStartDownload={handleStartDownload}
            downloadJob={downloadJob}
          />
        )}

        {/* Web & Media Metadata Inspector (7 Dimensions) */}
        {(url.trim() || metadata) && (
          <MetadataInspector
            inspection={inspectionResult}
            isLoading={isInspecting}
            onInspect={() => handleInspect(metadata?.resolvedUrl || metadata?.url || url)}
            targetUrl={url}
          />
        )}

        {/* Recent Downloads History */}

        <DownloadHistory
          items={history}
          onClearHistory={handleClearHistory}
          onSelectItem={(selectedUrl) => {
            setUrl(selectedUrl);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />

        {/* Engine Architecture & How It Works */}
        <HowItWorks />
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-gray-800/80 py-6 text-center text-xs text-gray-500 bg-[#030712]/90 relative z-10">
        <p>© 2026 Nexversal Audio & Video Downloader • Fast, lossless extraction with FFmpeg 192kbps MP3 & MP4 conversion.</p>
      </footer>
    </div>
  );
}
