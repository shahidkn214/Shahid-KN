import React from 'react';
import { History, Trash2, Video, Headphones, ExternalLink, Clock } from 'lucide-react';
import { HistoryItem } from '../types';

interface DownloadHistoryProps {
  items: HistoryItem[];
  onClearHistory: () => void;
  onSelectItem: (url: string) => void;
}

export const DownloadHistory: React.FC<DownloadHistoryProps> = ({
  items,
  onClearHistory,
  onSelectItem,
}) => {
  if (items.length === 0) return null;

  return (
    <div className="w-full rounded-2xl bg-gray-900/60 backdrop-blur-md border border-gray-800/80 p-5 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <History className="w-4 h-4 text-emerald-400" />
          <span>Recent Downloads & Conversions</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 font-normal">
            {items.length}
          </span>
        </div>

        <button
          type="button"
          onClick={onClearHistory}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-400 transition"
          title="Clear history"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Clear History</span>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.slice(0, 6).map((item) => (
          <div
            key={item.id}
            onClick={() => onSelectItem(item.url)}
            className="p-3 rounded-xl bg-gray-950/80 hover:bg-gray-900 border border-gray-800/80 hover:border-gray-700 transition cursor-pointer flex gap-3 items-center group"
          >
            {item.thumbnail ? (
              <img
                src={item.thumbnail}
                alt={item.title}
                className="w-14 h-10 object-cover rounded-lg bg-gray-900 shrink-0 border border-gray-800"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-14 h-10 rounded-lg bg-gray-900 flex items-center justify-center shrink-0 text-emerald-400">
                {item.format === 'mp3' ? <Headphones className="w-4 h-4" /> : <Video className="w-4 h-4" />}
              </div>
            )}

            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-gray-200 group-hover:text-emerald-400 truncate">
                {item.title}
              </p>
              <div className="flex items-center gap-2 text-[11px] text-gray-500 mt-1">
                <span className="uppercase font-bold text-gray-400 text-[10px]">
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
          </div>
        ))}
      </div>
    </div>
  );
};
