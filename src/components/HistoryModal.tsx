import React, { useState } from 'react';
import { History, X, Trash2, Video, Headphones, Download, ExternalLink, ShieldCheck, AlertCircle } from 'lucide-react';
import { HistoryItem, AuthUser } from '../types';

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: HistoryItem[];
  currentUser: AuthUser | null;
  onClearHistory: () => void;
  onDeleteItem: (id: string) => void;
  onSelectItem: (url: string) => void;
  onOpenAuth: (mode: 'login' | 'register') => void;
}

export const HistoryModal: React.FC<HistoryModalProps> = ({
  isOpen,
  onClose,
  items,
  currentUser,
  onClearHistory,
  onDeleteItem,
  onSelectItem,
  onOpenAuth,
}) => {
  const [filterType, setFilterType] = useState<'all' | 'video' | 'audio'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  if (!isOpen) return null;

  const filteredItems = items.filter((item) => {
    if (filterType === 'video' && item.format === 'mp3') return false;
    if (filterType === 'audio' && item.format !== 'mp3') return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        item.title.toLowerCase().includes(q) ||
        item.platform.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl max-h-[85vh] rounded-2xl bg-[#080d1a] border border-emerald-500/30 shadow-2xl flex flex-col overflow-hidden text-gray-100 relative">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-gray-800/80 flex items-center justify-between bg-gray-900/40 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <History className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-extrabold text-white">
                  Download History
                </h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-bold border border-emerald-500/30">
                  {items.length}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                {currentUser ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 inline" /> Synced with your account database
                  </span>
                ) : (
                  <span>
                    Saved locally.{' '}
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenAuth('register');
                      }}
                      className="text-emerald-400 hover:underline font-semibold"
                    >
                      Sign up to sync
                    </button>
                  </span>
                )}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl bg-gray-900/80 hover:bg-gray-800 text-gray-400 hover:text-white transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters & Search */}
        <div className="p-3 sm:p-4 border-b border-gray-800/60 bg-[#060913] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
          <div className="flex items-center bg-gray-900/90 rounded-xl p-1 border border-gray-800 text-xs">
            <button
              type="button"
              onClick={() => setFilterType('all')}
              className={`px-3 py-1 rounded-lg font-semibold transition ${
                filterType === 'all' ? 'bg-emerald-500 text-gray-950 shadow-sm' : 'text-gray-400 hover:text-white'
              }`}
            >
              All ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType('video')}
              className={`px-3 py-1 rounded-lg font-semibold transition ${
                filterType === 'video' ? 'bg-emerald-500 text-gray-950 shadow-sm' : 'text-gray-400 hover:text-white'
              }`}
            >
              Videos ({items.filter((i) => i.format !== 'mp3').length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType('audio')}
              className={`px-3 py-1 rounded-lg font-semibold transition ${
                filterType === 'audio' ? 'bg-emerald-500 text-gray-950 shadow-sm' : 'text-gray-400 hover:text-white'
              }`}
            >
              Audio MP3 ({items.filter((i) => i.format === 'mp3').length})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search history..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-gray-900/90 border border-gray-800 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 w-36 sm:w-48"
            />
            {items.length > 0 && (
              <button
                type="button"
                onClick={onClearHistory}
                className="px-3 py-1.5 rounded-xl bg-red-950/30 hover:bg-red-950/60 text-red-300 border border-red-500/30 text-xs font-semibold flex items-center gap-1.5 transition"
                title="Clear all download history"
              >
                <Trash2 className="w-3.5 h-3.5 text-red-400" />
                <span className="hidden sm:inline">Clear All</span>
              </button>
            )}
          </div>
        </div>

        {/* Content list */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-3 flex-1">
          {items.length === 0 ? (
            <div className="py-12 text-center flex flex-col items-center justify-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-gray-900/80 border border-gray-800 flex items-center justify-center text-gray-500">
                <History className="w-7 h-7" />
              </div>
              <h4 className="text-base font-bold text-white">No Download History Yet</h4>
              <p className="text-xs text-gray-400 max-w-sm">
                Paste any YouTube, TikTok, Facebook, Instagram, Twitter, or SoundCloud link to download videos and convert MP3s.
              </p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="py-10 text-center text-xs text-gray-400">
              No history matches your search or filter.
            </div>
          ) : (
            filteredItems.map((item) => (
              <div
                key={item.id}
                className="p-3.5 rounded-xl bg-gray-900/70 hover:bg-gray-900 border border-gray-800/80 hover:border-gray-700 transition flex items-center justify-between gap-3 group"
              >
                <div
                  className="flex items-center gap-3 min-w-0 cursor-pointer flex-1"
                  onClick={() => {
                    onSelectItem(item.url);
                    onClose();
                  }}
                >
                  <div className="w-14 h-11 rounded-lg bg-gray-950 border border-gray-800 shrink-0 overflow-hidden flex items-center justify-center relative">
                    {item.thumbnail ? (
                      <img
                        src={item.thumbnail}
                        alt={item.title}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="text-emerald-400">
                        {item.format === 'mp3' ? (
                          <Headphones className="w-5 h-5" />
                        ) : (
                          <Video className="w-5 h-5" />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white group-hover:text-emerald-400 truncate">
                      {item.title}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-gray-400 mt-1">
                      <span className="uppercase font-extrabold text-emerald-400">
                        {item.format}
                      </span>
                      {item.quality && <span>({item.quality})</span>}
                      <span>•</span>
                      <span className="capitalize">{item.platform}</span>
                      {item.durationFormatted && (
                        <>
                          <span>•</span>
                          <span>{item.durationFormatted}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectItem(item.url);
                      onClose();
                    }}
                    className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition"
                    title="Load link into input"
                  >
                    Analyze
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteItem(item.id)}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition"
                    title="Delete item"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
