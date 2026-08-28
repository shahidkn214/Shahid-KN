import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UrlInputBar } from './components/UrlInputBar';
import { PlatformPills } from './components/PlatformPills';
import { ResultCard } from './components/ResultCard';
import { DownloadHistory } from './components/DownloadHistory';
import { HowItWorks } from './components/HowItWorks';
import { AuthModal } from './components/AuthModal';
import { MetadataInspector } from './components/MetadataInspector';
import { MediaMetadata, DownloadJob, HistoryItem, MetadataInspectionResult, AuthUser } from './types';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export default function App() {
  const [url, setUrl] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [downloadJob, setDownloadJob] = useState<DownloadJob | null>(null);
  const [isBackendHealthy, setIsBackendHealthy] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Authentication & Session State
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => {
    return localStorage.getItem('streamdrop_token') || null;
  });
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('login');

  // History State (In-Memory for Guest, Persistent DB for Logged-In User)
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Metadata Inspector State
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectionResult, setInspectionResult] = useState<MetadataInspectionResult | null>(null);

  const pollIntervalRef = useRef<any>(null);

  // Fetch /api/health and check Auth Token on startup
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

    // Verify Auth token & fetch user profile
    if (authToken) {
      fetchUserProfile(authToken);
    }
  }, []);

  const fetchUserProfile = async (token: string) => {
    try {
      const res = await fetch('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (res.ok && data.success && data.user) {
        setCurrentUser(data.user);
        fetchUserHistory(token);
      } else {
        // Invalid or expired token
        handleLogout();
      }
    } catch (err) {
      console.warn('Auth verification failed:', err);
    }
  };

  const fetchUserHistory = async (token: string) => {
    try {
      const res = await fetch('/api/history', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (res.ok && data.success && Array.isArray(data.data)) {
        const mappedHistory: HistoryItem[] = data.data.map((item: any) => ({
          id: String(item.id),
          url: item.source_url || item.url,
          title: item.media_title || item.title,
          thumbnail: item.media_thumbnail || item.thumbnail,
          platform: item.platform || 'generic',
          format: item.format_type || item.format || 'mp4',
          quality: item.quality,
          timestamp: item.created_at ? new Date(item.created_at).getTime() : Date.now(),
          durationFormatted: item.duration_formatted,
        }));
        setHistory(mappedHistory);
      }
    } catch (err) {
      console.warn('Failed to load user download history:', err);
    }
  };

  const handleAuthSuccess = (token: string, user: AuthUser) => {
    localStorage.setItem('streamdrop_token', token);
    setAuthToken(token);
    setCurrentUser(user);
    setSuccessMessage(`Welcome, ${user.username}! Your downloads are now synced to cloud.`);
    setTimeout(() => setSuccessMessage(null), 4000);
    fetchUserHistory(token);
  };

  const handleLogout = () => {
    localStorage.removeItem('streamdrop_token');
    setAuthToken(null);
    setCurrentUser(null);
    setHistory([]); // Clear in-memory history
    setSuccessMessage('Logged out. Switched to private guest session.');
    setTimeout(() => setSuccessMessage(null), 3000);
  };

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

      // Auto-trigger inspector in background for rich diagnostics
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

            // 1. Audit / Log to Backend Database (attaches user_id if logged in, NULL if guest)
            const authHeader: Record<string, string> = { 'Content-Type': 'application/json' };
            if (authToken) {
              authHeader['Authorization'] = `Bearer ${authToken}`;
            }

            fetch('/api/log-download', {
              method: 'POST',
              headers: authHeader,
              body: JSON.stringify({
                media_title: metadata.title,
                source_url: metadata.url,
                platform: metadata.platform,
                format_type: format,
                quality: quality,
                media_thumbnail: metadata.thumbnail,
              }),
            }).catch((logErr) => console.warn('Download audit logging notice:', logErr));

            // 2. Add to current in-memory UI history
            const historyEntry: HistoryItem = {
              id: Date.now().toString(),
              url: metadata.url,
              title: metadata.title,
              thumbnail: metadata.thumbnail,
              platform: metadata.platform,
              format,
              quality,
              timestamp: Date.now(),
              durationFormatted: metadata.durationFormatted,
            };

            setHistory((prev) => [
              historyEntry,
              ...prev.filter((item) => item.url !== metadata.url),
            ]);

            // 3. Trigger robust asynchronous Blob download with automatic direct-link fallback
            const safeCleanTitle = (metadata.title || 'Nexversal_media')
              .replace(/[^\w\s.-]/gi, '_')
              .replace(/\s+/g, '_')
              .substring(0, 80) || `media_${jobId}`;
            const downloadUrl = `/api/file/${jobId}?name=${encodeURIComponent(safeCleanTitle)}`;
            const safeFallbackName = `${safeCleanTitle}.${format}`;

            (async () => {
              try {
                const response = await fetch(downloadUrl);
                if (!response.ok) {
                  console.warn(`Blob fetch returned HTTP ${response.status}, triggering direct anchor fallback.`);
                  const fallbackLink = document.createElement('a');
                  fallbackLink.href = downloadUrl;
                  fallbackLink.setAttribute('download', safeFallbackName);
                  document.body.appendChild(fallbackLink);
                  fallbackLink.click();
                  setTimeout(() => {
                    if (document.body.contains(fallbackLink)) {
                      document.body.removeChild(fallbackLink);
                    }
                  }, 1500);
                  setSuccessMessage(`Download initiated! "${metadata.title.slice(0, 35)}..." is saving to device.`);
                  setTimeout(() => setSuccessMessage(null), 5000);
                  return;
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
                    try {
                      finalFilename = decodeURIComponent(matches[1].replace(/['"]/g, '').trim());
                    } catch {
                      finalFilename = matches[1].replace(/['"]/g, '').trim();
                    }
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
                }, 2000);

                setSuccessMessage(`Download ready! "${metadata.title.slice(0, 35)}..." saved.`);
                setTimeout(() => setSuccessMessage(null), 5000);
              } catch (blobErr: any) {
                console.warn('Blob fetch failed, triggering direct browser link:', blobErr);
                try {
                  const fallbackLink = document.createElement('a');
                  fallbackLink.href = downloadUrl;
                  fallbackLink.setAttribute('download', safeFallbackName);
                  document.body.appendChild(fallbackLink);
                  fallbackLink.click();
                  setTimeout(() => {
                    if (document.body.contains(fallbackLink)) {
                      document.body.removeChild(fallbackLink);
                    }
                  }, 1500);
                  setSuccessMessage(`Download initiated for "${metadata.title.slice(0, 35)}...".`);
                  setTimeout(() => setSuccessMessage(null), 5000);
                } catch (fallbackErr: any) {
                  console.error('All download methods failed:', fallbackErr);
                  setErrorMessage(`Failed to save file: ${blobErr.message || 'Download failed'}`);
                }
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

  // Soft-Delete Single Item
  const handleDeleteHistoryItem = async (id: string) => {
    // 1. Remove from local state immediately
    setHistory((prev) => prev.filter((item) => item.id !== id));

    // 2. If logged in, send soft-delete request to backend
    if (authToken) {
      try {
        await fetch(`/api/history/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
      } catch (err) {
        console.warn('Soft-delete failed on server:', err);
      }
    }
  };

  // Soft-Delete All History
  const handleClearHistory = async () => {
    // 1. Clear UI state immediately
    setHistory([]);

    // 2. If logged in, tell backend to soft-delete all records for this user
    if (authToken) {
      try {
        await fetch('/api/history', {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
        setSuccessMessage('Your cloud history has been cleared safely.');
        setTimeout(() => setSuccessMessage(null), 3000);
      } catch (err) {
        console.warn('Soft-delete clear all failed on server:', err);
      }
    }
  };

  const scrollToHistory = () => {
    const el = document.getElementById('download-history-section');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="min-h-screen bg-[#030712] text-gray-100 flex flex-col items-center selection:bg-emerald-500 selection:text-black">
      {/* Background glow effects */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-72 bg-emerald-500/10 blur-[130px] pointer-events-none rounded-full" />
      <div className="fixed bottom-0 left-1/3 w-80 h-80 bg-teal-500/5 blur-[120px] pointer-events-none rounded-full" />

      {/* Header */}
      <Header
        isBackendHealthy={isBackendHealthy}
        currentUser={currentUser}
        historyCount={history.length}
        onOpenAuth={(mode) => {
          setAuthModalMode(mode);
          setIsAuthModalOpen(true);
        }}
        onLogout={handleLogout}
        onScrollToHistory={scrollToHistory}
      />

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

        {/* Web & Media Metadata Inspector */}
        {(url.trim() || metadata) && (
          <MetadataInspector
            inspection={inspectionResult}
            isLoading={isInspecting}
            onInspect={() => handleInspect(metadata?.resolvedUrl || metadata?.url || url)}
            targetUrl={url}
          />
        )}

        {/* Recent Downloads History with Soft-Delete & Guest/User indicators */}
        <DownloadHistory
          items={history}
          currentUser={currentUser}
          onClearHistory={handleClearHistory}
          onDeleteItem={handleDeleteHistoryItem}
          onSelectItem={(selectedUrl) => {
            setUrl(selectedUrl);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />

        {/* Engine Architecture & How It Works */}
        <HowItWorks />
      </main>

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        initialMode={authModalMode}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
      />

      {/* Footer */}
      <footer className="w-full border-t border-gray-800/80 py-6 text-center text-xs text-gray-500 bg-[#030712]/90 relative z-10">
        <p>© 2026 Nexversal Audio & Video Downloader • Fast, lossless extraction with FFmpeg 192kbps MP3 & MP4 conversion.</p>
      </footer>
    </div>
  );
}
