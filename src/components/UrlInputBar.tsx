import React, { useEffect, useState } from 'react';
import { Link as LinkIcon, Clipboard, Sparkles, X, Youtube, Facebook, Music2, Instagram, Twitter, Radio, Check } from 'lucide-react';
import { PlatformType } from '../types';

interface UrlInputBarProps {
  url: string;
  onChange: (url: string) => void;
  onAnalyze: () => void;
  isLoading: boolean;
}

export function detectPlatformFromUrl(url: string): { type: PlatformType; name: string; badgeClass: string; icon: React.ReactNode } {
  const u = url.toLowerCase().trim();
  if (u.includes('youtube.com') || u.includes('youtu.be')) {
    return {
      type: 'youtube',
      name: 'YouTube',
      badgeClass: 'bg-red-500/15 text-red-400 border-red-500/30',
      icon: <Youtube className="w-3.5 h-3.5" />,
    };
  }
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) {
    return {
      type: 'facebook',
      name: 'Facebook',
      badgeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      icon: <Facebook className="w-3.5 h-3.5" />,
    };
  }
  if (u.includes('tiktok.com')) {
    return {
      type: 'tiktok',
      name: 'TikTok',
      badgeClass: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
      icon: <Music2 className="w-3.5 h-3.5" />,
    };
  }
  if (u.includes('instagram.com') || u.includes('instagr.am')) {
    return {
      type: 'instagram',
      name: 'Instagram',
      badgeClass: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
      icon: <Instagram className="w-3.5 h-3.5" />,
    };
  }
  if (u.includes('twitter.com') || u.includes('x.com') || u.includes('t.co')) {
    return {
      type: 'twitter',
      name: 'Twitter / X',
      badgeClass: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
      icon: <Twitter className="w-3.5 h-3.5" />,
    };
  }
  if (u.includes('soundcloud.com')) {
    return {
      type: 'soundcloud',
      name: 'SoundCloud',
      badgeClass: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
      icon: <Radio className="w-3.5 h-3.5" />,
    };
  }
  return {
    type: 'generic',
    name: 'Universal Media',
    badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    icon: <LinkIcon className="w-3.5 h-3.5" />,
  };
}

export const UrlInputBar: React.FC<UrlInputBarProps> = ({
  url,
  onChange,
  onAnalyze,
  isLoading,
}) => {
  const [copiedSuccess, setCopiedSuccess] = useState(false);
  const detected = url.trim() ? detectPlatformFromUrl(url) : null;

  const handlePaste = async () => {
    try {
      if (navigator?.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          onChange(text.trim());
          setCopiedSuccess(true);
          setTimeout(() => setCopiedSuccess(false), 2000);
        }
      }
    } catch (err) {
      console.warn('Clipboard read error:', err);
    }
  };

  const handleClear = () => {
    onChange('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isLoading && url.trim()) {
      onAnalyze();
    }
  };

  return (
    <div className="w-full relative rounded-2xl bg-gray-900/70 backdrop-blur-xl border border-gray-800/80 p-4 sm:p-6 shadow-2xl shadow-black/60 space-y-4">
      {/* Top Header inside Input Card */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-gray-400 font-medium">
          <LinkIcon className="w-3.5 h-3.5 text-emerald-400" />
          <span>Paste Media Stream Link</span>
        </div>

        {detected && detected.type !== 'generic' && (
          <div
            className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border transition-all duration-300 ${detected.badgeClass}`}
          >
            {detected.icon}
            <span>{detected.name} Detected</span>
          </div>
        )}
      </div>

      {/* Input Box with Action Buttons */}
      <div className="relative flex items-center">
        <input
          id="media-url-input"
          type="url"
          value={url}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Paste URL (e.g. https://www.youtube.com/watch?v=..., TikTok, Facebook, Instagram)"
          disabled={isLoading}
          className="w-full bg-gray-950/80 border border-gray-800/90 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 rounded-xl px-4 py-3.5 pr-28 sm:pr-32 text-sm text-gray-100 placeholder-gray-500 outline-none transition-all disabled:opacity-50"
        />

        <div className="absolute right-2 flex items-center gap-1.5">
          {url && (
            <button
              id="clear-url-btn"
              type="button"
              onClick={handleClear}
              disabled={isLoading}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition"
              title="Clear input"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          <button
            id="paste-clipboard-btn"
            type="button"
            onClick={handlePaste}
            disabled={isLoading}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-gray-800/90 hover:bg-gray-700 text-gray-300 hover:text-white text-xs font-semibold border border-gray-700/60 transition active:scale-95 shadow-sm"
            title="Paste from clipboard"
          >
            {copiedSuccess ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Pasted!</span>
              </>
            ) : (
              <>
                <Clipboard className="w-3.5 h-3.5 text-emerald-400" />
                <span>Paste</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Analyze Button */}
      <button
        id="analyze-stream-btn"
        type="button"
        onClick={onAnalyze}
        disabled={isLoading || !url.trim()}
        className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600 hover:from-emerald-400 hover:to-teal-400 text-gray-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 disabled:opacity-50 disabled:pointer-events-none transition-all active:scale-[0.99] cursor-pointer"
      >
        {isLoading ? (
          <>
            <div className="w-4 h-4 border-2 border-gray-950 border-t-transparent rounded-full animate-spin" />
            <span>Analyzing Media Streams...</span>
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4 text-gray-950" />
            <span>Fetch Stream & Download Options</span>
          </>
        )}
      </button>
    </div>
  );
};
