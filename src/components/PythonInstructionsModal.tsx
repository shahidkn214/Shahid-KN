import React, { useState } from 'react';
import { X, Copy, Check, Terminal, Play, Download, ShieldCheck, Sparkles } from 'lucide-react';

interface PythonInstructionsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PythonInstructionsModal: React.FC<PythonInstructionsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [copiedPip, setCopiedPip] = useState(false);
  const [copiedRun, setCopiedRun] = useState(false);

  if (!isOpen) return null;

  const pipCommand = 'pip install fastapi uvicorn yt-dlp httpx pydantic';
  const runCommand = 'python app.py';

  const copyText = (text: string, type: 'pip' | 'run') => {
    navigator.clipboard.writeText(text);
    if (type === 'pip') {
      setCopiedPip(true);
      setTimeout(() => setCopiedPip(false), 2000);
    } else {
      setCopiedRun(true);
      setTimeout(() => setCopiedRun(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-gray-800 flex items-center justify-between bg-gray-950/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-white text-base">Python + FastAPI Standalone Server</h3>
              <p className="text-xs text-gray-400">Run StreamDrop natively with `app.py`</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-6 text-sm text-gray-300">
          {/* Overview */}
          <p className="text-xs text-gray-300 leading-relaxed">
            The entire StreamDrop application is packaged inside <code className="px-1.5 py-0.5 rounded bg-gray-800 text-emerald-400 font-mono text-xs">/app.py</code>.
            FastAPI serves the REST APIs (<code className="text-emerald-400 font-mono text-[11px]">/api/analyze</code>, <code className="text-emerald-400 font-mono text-[11px]">/api/start-download</code>, <code className="text-emerald-400 font-mono text-[11px]">/api/file/:id</code>) and embeds the entire Glassmorphism frontend directly at <code className="text-emerald-400 font-mono text-[11px]">/</code>.
          </p>

          {/* Step 1 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-white font-semibold text-xs uppercase tracking-wider">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs">1</span>
              <span>Install Python Dependencies</span>
            </div>
            <div className="relative flex items-center bg-gray-950 border border-gray-800 rounded-xl p-3 font-mono text-xs text-emerald-400">
              <span className="flex-1 select-all">{pipCommand}</span>
              <button
                onClick={() => copyText(pipCommand, 'pip')}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs transition"
              >
                {copiedPip ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedPip ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-white font-semibold text-xs uppercase tracking-wider">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs">2</span>
              <span>Ensure FFmpeg is Installed</span>
            </div>
            <div className="bg-gray-950/80 border border-gray-800 rounded-xl p-3.5 text-xs text-gray-400 space-y-1.5 font-mono">
              <p><span className="text-gray-500"># Ubuntu / Debian:</span> sudo apt install ffmpeg</p>
              <p><span className="text-gray-500"># macOS:</span> brew install ffmpeg</p>
              <p><span className="text-gray-500"># Windows:</span> winget install Gyan.FFmpeg</p>
            </div>
          </div>

          {/* Step 3 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-white font-semibold text-xs uppercase tracking-wider">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs">3</span>
              <span>Launch the Server</span>
            </div>
            <div className="relative flex items-center bg-gray-950 border border-gray-800 rounded-xl p-3 font-mono text-xs text-emerald-400">
              <span className="flex-1 select-all">{runCommand}</span>
              <button
                onClick={() => copyText(runCommand, 'run')}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs transition"
              >
                {copiedRun ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedRun ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              Open <span className="text-emerald-400 font-mono">http://localhost:8000</span> in your browser.
            </p>
          </div>

          {/* Features check */}
          <div className="p-3.5 rounded-xl bg-emerald-950/20 border border-emerald-500/20 text-xs text-emerald-300/90 space-y-1">
            <p className="font-semibold text-emerald-300 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              Built-in Anti-Bot & Automatic Cleanup
            </p>
            <p className="text-emerald-400/70 text-[11px]">
              Includes Chrome desktop User-Agent headers to prevent IP blocks and FastAPI BackgroundTasks to delete temporary files immediately after download.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800 bg-gray-950/80 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-bold text-xs transition"
          >
            Close Guide
          </button>
        </div>
      </div>
    </div>
  );
};
