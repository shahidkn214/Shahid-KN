import React from 'react';
import { User, LogOut, History, ShieldCheck } from 'lucide-react';
import { AuthUser } from '../types';

interface HeaderProps {
  isBackendHealthy: boolean;
  currentUser: AuthUser | null;
  historyCount: number;
  onOpenAuth: (mode: 'login' | 'register') => void;
  onLogout: () => void;
  onScrollToHistory: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  isBackendHealthy,
  currentUser,
  historyCount,
  onOpenAuth,
  onLogout,
  onScrollToHistory,
}) => {
  return (
    <header className="w-full max-w-4xl flex flex-col sm:flex-row items-center justify-between gap-3 py-4 px-4 sm:px-6 border-b border-gray-800/60 mb-6 sm:mb-8 backdrop-blur-md sticky top-0 z-30 bg-[#030712]/80">
      <div className="flex items-center gap-3">
        <div className="relative group cursor-pointer">
          <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-xl blur opacity-40 group-hover:opacity-75 transition duration-300"></div>
          <div className="relative w-10 h-10 rounded-xl bg-[#030712] border border-emerald-500/30 flex items-center justify-center p-1.5 shadow-lg shadow-emerald-500/20">
            <img
              src="/favicon.svg"
              alt="Nexversal Logo"
              className="w-full h-full object-contain drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]"
              referrerPolicy="no-referrer"
            />
          </div>
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
        {/* History Quick Access */}
        <button
          type="button"
          onClick={onScrollToHistory}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gray-900/90 hover:bg-gray-800 text-gray-200 border border-gray-800 hover:border-gray-700 text-xs font-semibold transition-all shadow-sm active:scale-95"
          title="Scroll to Download History"
        >
          <History className="w-3.5 h-3.5 text-emerald-400" />
          <span>History</span>
          {historyCount > 0 && (
            <span className="text-[10px] font-extrabold px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              {historyCount}
            </span>
          )}
        </button>

        {/* Auth / Session State */}
        {currentUser ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1 rounded-xl bg-gray-900/90 border border-emerald-500/30 text-xs">
              <div className="w-5 h-5 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-400 text-gray-950 font-bold text-[11px] flex items-center justify-center">
                {currentUser.username ? currentUser.username.charAt(0).toUpperCase() : 'U'}
              </div>
              <div className="flex flex-col text-left">
                <span className="font-bold text-white leading-tight truncate max-w-[100px]">
                  {currentUser.username}
                </span>
                <span className="text-[9px] text-emerald-400 font-medium flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-emerald-400"></span> Synced
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="p-2 rounded-xl bg-gray-900/80 hover:bg-red-950/40 text-gray-400 hover:text-red-400 border border-gray-800 hover:border-red-500/30 transition-all"
              title="Sign Out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div
              className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] font-medium text-amber-400"
              title="Guest downloads are logged for analytics and temporary in this session"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
              <span>Guest Session</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenAuth('login')}
              className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-gray-950 text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 active:scale-95"
            >
              <User className="w-3.5 h-3.5 stroke-[2.5]" />
              <span>Sign In</span>
            </button>
          </div>
        )}

        {/* Engine Status Badge */}
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


