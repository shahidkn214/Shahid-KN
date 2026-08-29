import React, { useState } from 'react';
import { History, Trash2, Video, Headphones, ShieldCheck, AlertTriangle, Download, ExternalLink, Filter } from 'lucide-react';
import { HistoryItem, AuthUser } from '../types';

interface DownloadHistoryProps {
  items: HistoryItem[];
  currentUser: AuthUser | null;
  onClearHistory: () => void;
  onDeleteItem: (id: string) => void;
  onSelectItem: (url: string) => void;
}

export const DownloadHistory: React.FC<DownloadHistoryProps> = ({
  items,
  currentUser,
  onClearHistory,
  onDeleteItem,
  onSelectItem,
}) => {
  const [showConfirmClear, setShowConfirmClear] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'video' | 'audio'>('all');

  const filteredItems = items.filter((item) => {
    if (filterType === 'video') return item.format !== 'mp3';
    if (filterType === 'audio') return item.format === 'mp3';
    return true;
  });

  return (
    <div id="download-history-section" className="w-full rounded-2xl bg-gray-900/60 backdrop-blur-md border border-gray-800/80 p-5 sm:p-6 space-y-4 shadow-xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-800/60">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <History className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white">Download & Conversion History</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">
                {items.length}
              </span>
            </div>
            <p className="text-[11px] text-gray-400">
              {currentUser ? (
                <span className="text-emerald-400 font-medium flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 inline" /> Persistent Cloud Database (Auto-saved)
                </span>
              ) : (
                <span className="text-amber-400 font-medium">
                  Local Session History • Sign up to sync permanently
                </span>
              )}
            </p>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-gray-950/80 rounded-lg p-0.5 border border-gray-800 text-xs">
              <button
                type="button"
                onClick={() => setFilterType('all')}
                className={`px-2.5 py-1 rounded-md transition text-xs font-semibold ${
                  filterType === 'all' ? 'bg-emerald-500 text-gray-950' : 'text-gray-400 hover:text-white'
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setFilterType('video')}
                className={`px-2.5 py-1 rounded-md transition text-xs font-semibold ${
                  filterType === 'video' ? 'bg-emerald-500 text-gray-950' : 'text-gray-400 hover:text-white'
                }`}
              >
                Videos
              </button>
              <button
                type="button"
                onClick={() => setFilterType('audio')}
                className={`px-2.5 py-1 rounded-md transition text-xs font-semibold ${
                  filterType === 'audio' ? 'bg-emerald-500 text-gray-950' : 'text-gray-400 hover:text-white'
                }`}
              >
                Audio
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowConfirmClear(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-950/60 hover:bg-red-950/40 text-gray-400 hover:text-red-300 border border-gray-800 hover:border-red-500/30 text-xs font-semibold transition"
              title="Clear download history"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Clear</span>
            </button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="py-10 px-4 text-center rounded-xl bg-gray-950/40 border border-dashed border-gray-800 flex flex-col items-center justify-center gap-2.5">
          <div className="w-12 h-12 rounded-2xl bg-gray-900/80 border border-gray-800 flex items-center justify-center text-gray-500">
            <History className="w-6 h-6" />
          </div>
          <p className="text-sm font-semibold text-gray-300">No Download History Yet</p>
          <p className="text-xs text-gray-500 max-w-sm">
            Downloaded videos and MP3 audio files will automatically appear here for rapid re-access and tracking.
          </p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="py-8 text-center text-xs text-gray-500">
          No items found matching the selected filter.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredItems.map((item) => (
            <div
              key={item.id}
              className="p-3 rounded-xl bg-gray-950/80 hover:bg-gray-900 border border-gray-800/80 hover:border-gray-700 transition flex gap-3 items-center group relative overflow-hidden"
            >
              {/* Thumbnail or Format Icon */}
              <div
                onClick={() => onSelectItem(item.url)}
                className="w-14 h-11 object-cover rounded-lg bg-gray-900 shrink-0 border border-gray-800 flex items-center justify-center cursor-pointer overflow-hidden relative"
              >
                {item.thumbnail ? (
                  <img
                    src={item.thumbnail}
                    alt={item.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="text-emerald-400">
                    {item.format === 'mp3' ? <Headphones className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                  </div>
                )}
              </div>

              {/* Info details */}
              <div
                onClick={() => onSelectItem(item.url)}
                className="flex-1 min-w-0 cursor-pointer pr-6"
              >
                <p className="text-xs font-semibold text-gray-200 group-hover:text-emerald-400 truncate">
                  {item.title}
                </p>
                <div className="flex items-center gap-2 text-[10px] text-gray-500 mt-1">
                  <span className="uppercase font-bold text-gray-400">
                    {item.format}
                  </span>
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

              {/* Individual Item Delete Button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteItem(item.id);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition duration-150"
                title="Remove from history"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Clear Confirmation Modal */}
      {showConfirmClear && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#0b1120] border border-gray-800 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-amber-400">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h4 className="text-base font-bold text-white">Clear History?</h4>
                <p className="text-xs text-gray-400">
                  {currentUser
                    ? 'Your view will be cleared using secure soft-delete.'
                    : 'This will reset your download history.'}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirmClear(false)}
                className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onClearHistory();
                  setShowConfirmClear(false);
                }}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition shadow-lg shadow-red-600/30"
              >
                Confirm Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
