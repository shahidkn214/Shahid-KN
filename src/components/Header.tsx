import React, { useState } from 'react';
import { ArrowDownToLine, ExternalLink, Check, Globe } from 'lucide-react';

interface HeaderProps {
  isBackendHealthy: boolean;
}

export const Header: React.FC<HeaderProps> = ({ isBackendHealthy }) => {
  const [copied, setCopied] = useState(false);
  const liveDevUrl = 'https://ais-dev-omg5ytlufyiqanqlfj3c52-74036481241.asia-southeast1.run.app/';

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(liveDevUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header className="w-full max-w-4xl flex flex-col sm:flex-row items-center justify-between gap-3 py-4 px-4 sm:px-6 border-b border-gray-800/60 mb-6 sm:mb-8 backdrop-blur-md sticky top-0 z-30 bg-[#030712]/80">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-700 flex items-center justify-center text-gray-950 font-black shadow-lg shadow-emerald-500/25 ring-1 ring-emerald-400/40">
          <ArrowDownToLine className="w-5 h-5 text-gray-950 stroke-[2.5]" />
        </div>
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-white flex items-center gap-2">
            Nexversal
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
              Downloader
            </span>
          </h1>
          <p className="text-xs text-gray-400 font-medium">Universal Audio & Video Downloader</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {/* Temporary Live App Verification Link */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs">
          <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <a
            href={liveDevUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-300 hover:text-emerald-200 font-medium flex items-center gap-1 hover:underline max-w-[200px] truncate"
            title="Open Live Cloud Website in New Tab"
          >
            <span>Live Cloud App</span>
            <ExternalLink className="w-3 h-3" />
          </a>
          <button
            type="button"
            onClick={handleCopyUrl}
            className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 transition"
            title="Copy URL"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : 'Copy'}
          </button>
        </div>

        <div
          id="engine-status-badge"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-900/80 border border-gray-800 text-xs shadow-inner"
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isBackendHealthy ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
            }`}
          />
          <span className="text-gray-300 font-medium">
            {isBackendHealthy ? 'Engine Active' : 'Connecting Engine...'}
          </span>
        </div>
      </div>
    </header>
  );
};


