import React, { useState } from 'react';
import {
  Video,
  Headphones,
  Download,
  Clock,
  User,
  Eye,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Sparkles,
  Layers,
  Music,
  XCircle,
  StopCircle,
  X,
} from 'lucide-react';
import { MediaMetadata, DownloadJob } from '../types';

interface ResultCardProps {
  metadata: MediaMetadata;
  onStartDownload: (format: 'mp4' | 'mp3', quality?: string) => Promise<void>;
  onCancelDownload?: () => void;
  onDismissProgress?: () => void;
  downloadJob: DownloadJob | null;
}

export const ResultCard: React.FC<ResultCardProps> = ({
  metadata,
  onStartDownload,
  onCancelDownload,
  onDismissProgress,
  downloadJob,
}) => {
  const [activeTab, setActiveTab] = useState<'video' | 'audio'>(
    metadata.isAudioOnly ? 'audio' : 'video'
  );
  const [activeTargetKey, setActiveTargetKey] = useState<string | null>(null);

  const isDownloading =
    downloadJob &&
    (downloadJob.status === 'downloading' ||
      downloadJob.status === 'converting' ||
      downloadJob.status === 'queued');

  const handleDownload = async (format: 'mp4' | 'mp3', quality: string) => {
    setActiveTargetKey(`${format}-${quality}`);
    try {
      await onStartDownload(format, quality);
    } finally {
      // Key remains for progress tracking
    }
  };

  const videoResolutions = metadata.videoResolutions || [];
  const audioBitrates = metadata.audioBitrates || [
    { bitrate: '320k', kbps: 320, label: '320 kbps (Ultra High Quality MP3)', badge: 'Ultra HQ', filesizeApprox: '~8.2 MB', isRecommended: false, ext: 'mp3' as const },
    { bitrate: '192k', kbps: 192, label: '192 kbps (Standard Quality MP3)', badge: 'Standard', filesizeApprox: '~4.9 MB', isRecommended: true, ext: 'mp3' as const },
    { bitrate: '128k', kbps: 128, label: '128 kbps (Compact / Fast MP3)', badge: 'Fast', filesizeApprox: '~3.3 MB', isRecommended: false, ext: 'mp3' as const },
    { bitrate: '64k', kbps: 64, label: '64 kbps (Low Bandwidth Audio)', badge: 'Low Data', filesizeApprox: '~1.6 MB', isRecommended: false, ext: 'mp3' as const },
  ];

  return (
    <div
      id="media-result-card"
      className="w-full rounded-2xl bg-gray-900/90 backdrop-blur-xl border border-gray-800 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300"
    >
      {/* Top Banner / Stream Info */}
      <div className="p-5 sm:p-7 flex flex-col md:flex-row gap-6 items-start">
        {/* Thumbnail Box */}
        <div className="relative w-full md:w-56 aspect-video rounded-xl overflow-hidden bg-gray-950 shrink-0 border border-gray-800/80 shadow-md group">
          <img
            src={
              metadata.thumbnail ||
              'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500&q=80'
            }
            alt={metadata.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.target as HTMLImageElement).src =
                'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=500&q=80';
            }}
          />

          {/* Badges on Thumbnail */}
          {metadata.durationFormatted && (
            <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/85 backdrop-blur-sm text-[11px] font-bold text-white flex items-center gap-1 border border-white/10">
              <Clock className="w-3 h-3 text-emerald-400" />
              {metadata.durationFormatted}
            </span>
          )}

          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-emerald-500/90 text-gray-950 text-[10px] font-extrabold uppercase tracking-wider shadow-sm">
            {metadata.isAudioOnly ? 'Audio Stream' : 'Video Stream'}
          </span>
        </div>

        {/* Media Details */}
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              {metadata.platformName}
            </span>

            {metadata.uploader && (
              <span className="flex items-center gap-1 text-xs text-gray-400 font-medium truncate max-w-[200px]">
                <User className="w-3 h-3 text-gray-500 shrink-0" />
                {metadata.uploader}
              </span>
            )}

            {metadata.viewCount !== undefined && metadata.viewCount !== null && (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <Eye className="w-3 h-3 text-gray-500" />
                {metadata.viewCount.toLocaleString()} views
              </span>
            )}
          </div>

          <h3 className="text-lg sm:text-xl font-bold text-white leading-snug break-words">
            {metadata.title}
          </h3>

          <div className="flex items-center gap-2 pt-1">
            <a
              href={metadata.resolvedUrl || metadata.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 font-medium hover:underline transition"
            >
              <span>View Source Stream</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>

      {/* Action / Format Quality Selector Section */}
      <div className="bg-gray-950/80 border-t border-gray-800/80 p-5 sm:p-7 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Tab Selector Buttons */}
          <div className="inline-flex items-center p-1 bg-gray-900 border border-gray-800 rounded-xl">
            {!metadata.isAudioOnly && (
              <button
                type="button"
                onClick={() => setActiveTab('video')}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                  activeTab === 'video'
                    ? 'bg-emerald-500 text-gray-950 shadow-sm'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                <Video className="w-4 h-4 stroke-[2.5]" />
                <span>Video Resolutions ({videoResolutions.length || 'HD'})</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveTab('audio')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                activeTab === 'audio'
                  ? 'bg-teal-400 text-gray-950 shadow-sm'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              <Headphones className="w-4 h-4 stroke-[2.5]" />
              <span>Audio MP3 Bitrates ({audioBitrates.length})</span>
            </button>
          </div>

          <div className="text-xs text-gray-400 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            <span>Select target format & bitrate</span>
          </div>
        </div>

        {/* Video Resolutions Quality Grid */}
        {activeTab === 'video' && !metadata.isAudioOnly && (
          <div className="space-y-2 animate-in fade-in duration-200">
            {videoResolutions.length === 0 ? (
              <div className="p-4 rounded-xl bg-gray-900/60 border border-gray-800 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-white">Full HD Video (MP4)</p>
                  <p className="text-xs text-gray-400">Direct optimal video resolution stream</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDownload('mp4', 'best')}
                  disabled={Boolean(isDownloading)}
                  className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-bold text-xs flex items-center gap-1.5 transition disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download MP4</span>
                </button>
              </div>
            ) : (
              videoResolutions.map((res) => {
                const isSelected = activeTargetKey === `mp4-${res.resolution}` && isDownloading;
                const isRec = res.isRecommended;
                const badgeText = res.badge || res.resolution;

                return (
                  <div
                    key={res.resolution}
                    className={`flex items-center justify-between p-3 sm:p-3.5 rounded-xl border transition group ${
                      isRec
                        ? 'bg-emerald-950/15 border-emerald-500/40 hover:border-emerald-400'
                        : 'bg-gray-900/80 border-gray-800 hover:border-gray-700'
                    }`}
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                          isRec ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-800 text-gray-300'
                        }`}
                      >
                        <Video className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs sm:text-sm font-bold text-white">
                            {res.resolution}
                          </span>
                          <span
                            className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                              isRec
                                ? 'bg-emerald-500 text-gray-950'
                                : 'bg-gray-800 text-gray-300 border border-gray-700'
                            }`}
                          >
                            {badgeText}
                          </span>
                          {isRec && (
                            <span className="text-[10px] font-bold text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                              Recommended
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-gray-400 mt-0.5">
                          <span className="uppercase font-mono font-semibold text-gray-300">
                            .MP4
                          </span>
                          {res.filesizeApprox && <span>• ~{res.filesizeApprox}</span>}
                          <span className="hidden sm:inline text-gray-500">• {res.label}</span>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDownload('mp4', res.resolution)}
                      disabled={Boolean(isDownloading)}
                      className={`ml-3 px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-50 disabled:pointer-events-none active:scale-95 ${
                        isRec
                          ? 'bg-emerald-500 hover:bg-emerald-400 text-gray-950 shadow-md shadow-emerald-500/20'
                          : 'bg-gray-800 hover:bg-emerald-500 hover:text-gray-950 text-white'
                      }`}
                    >
                      {isSelected ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Downloading...</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-3.5 h-3.5" />
                          <span>Download</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Audio Bitrates Quality Grid */}
        {activeTab === 'audio' && (
          <div className="space-y-2 animate-in fade-in duration-200">
            {audioBitrates.map((aud) => {
              const isSelected = activeTargetKey === `mp3-${aud.bitrate}` && isDownloading;
              const isRec = aud.isRecommended;

              return (
                <div
                  key={aud.bitrate}
                  className={`flex items-center justify-between p-3 sm:p-3.5 rounded-xl border transition group ${
                    isRec
                      ? 'bg-teal-950/15 border-teal-500/40 hover:border-teal-400'
                      : 'bg-gray-900/80 border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                        isRec ? 'bg-teal-500/20 text-teal-300' : 'bg-gray-800 text-gray-300'
                      }`}
                    >
                      <Music className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs sm:text-sm font-bold text-white">
                          {aud.bitrate.toUpperCase()} MP3
                        </span>
                        <span
                          className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                            isRec
                              ? 'bg-teal-400 text-gray-950'
                              : 'bg-gray-800 text-gray-300 border border-gray-700'
                          }`}
                        >
                          {aud.badge || aud.bitrate}
                        </span>
                        {isRec && (
                          <span className="text-[10px] font-bold text-teal-300 border border-teal-500/30 px-1.5 py-0.5 rounded">
                            Optimal Quality
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-gray-400 mt-0.5">
                        <span className="uppercase font-mono font-semibold text-teal-400">
                          FFmpeg Transcoded
                        </span>
                        {aud.filesizeApprox && <span>• ~{aud.filesizeApprox}</span>}
                        <span className="hidden sm:inline text-gray-500">• {aud.label}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDownload('mp3', aud.bitrate)}
                    disabled={Boolean(isDownloading)}
                    className={`ml-3 px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-50 disabled:pointer-events-none active:scale-95 ${
                      isRec
                        ? 'bg-teal-400 hover:bg-teal-300 text-gray-950 shadow-md shadow-teal-500/20'
                        : 'bg-gray-800 hover:bg-teal-400 hover:text-gray-950 text-white'
                    }`}
                  >
                    {isSelected ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Transcoding...</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        <span>Download MP3</span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Live Download & FFmpeg Conversion Progress Section */}
        {downloadJob && (
          <div
            id="download-progress-container"
            className="p-4 sm:p-5 rounded-xl bg-gray-900/95 border border-emerald-500/30 space-y-3 animate-in fade-in duration-200 shadow-xl"
          >
            <div className="flex items-center justify-between text-xs font-semibold">
              <div className="flex items-center gap-2">
                {downloadJob.status === 'downloading' && (
                  <span className="flex items-center gap-1.5 text-emerald-400">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                    Downloading {downloadJob.quality} stream...
                  </span>
                )}
                {downloadJob.status === 'converting' && (
                  <span className="flex items-center gap-1.5 text-teal-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    FFmpeg transcoding {downloadJob.quality} MP3 audio...
                  </span>
                )}
                {downloadJob.status === 'cancelled' && (
                  <span className="flex items-center gap-1.5 text-amber-400 font-semibold">
                    <XCircle className="w-4 h-4 text-amber-400" />
                    Download cancelled.
                  </span>
                )}
                {downloadJob.status === 'completed' && (
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5 text-emerald-400 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Extraction complete!
                    </span>
                    <a
                      href={`/api/file/${downloadJob.jobId}?name=${encodeURIComponent(
                        (metadata.title || 'media').replace(/[^\w\s.-]/gi, '_').substring(0, 80)
                      )}`}
                      download
                      className="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-gray-950 text-[11px] font-bold inline-flex items-center gap-1 transition shadow-sm"
                    >
                      <Download className="w-3 h-3" />
                      <span>Save to Device</span>
                    </a>
                  </div>
                )}
                {downloadJob.status === 'failed' && (
                  <span className="flex items-center gap-1.5 text-red-400">
                    <AlertTriangle className="w-4 h-4 text-red-400" />
                    {downloadJob.error || 'Download failed.'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                {isDownloading && onCancelDownload && (
                  <button
                    type="button"
                    onClick={onCancelDownload}
                    className="px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 hover:text-red-100 text-[11px] font-bold inline-flex items-center gap-1.5 transition active:scale-95 cursor-pointer"
                    title="Cancel download at any time"
                  >
                    <StopCircle className="w-3.5 h-3.5 text-red-400" />
                    <span>Cancel</span>
                  </button>
                )}
                <span className="text-white font-mono font-bold">
                  {Math.round(downloadJob.progress)}%
                </span>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2.5 rounded-full bg-gray-950 overflow-hidden p-0.5 border border-gray-800">
              <div
                className={`h-full rounded-full transition-all duration-300 shadow-sm ${
                  downloadJob.status === 'cancelled'
                    ? 'bg-amber-500/50'
                    : downloadJob.status === 'failed'
                    ? 'bg-red-500'
                    : 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400 shadow-emerald-500/50'
                }`}
                style={{ width: `${Math.max(3, downloadJob.progress)}%` }}
              />
            </div>

            {/* Metrics */}
            <div className="flex items-center justify-between text-[11px] text-gray-400 font-mono">
              <span>Speed: {downloadJob.speed || '--'}</span>
              <span>Size: {downloadJob.totalSize || '--'}</span>
              <span>ETA: {downloadJob.eta || '--'}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
