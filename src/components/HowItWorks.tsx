import React from 'react';
import { ShieldCheck, RefreshCw, Zap, AudioLines, FileCheck } from 'lucide-react';

export const HowItWorks: React.FC = () => {
  return (
    <div className="w-full max-w-4xl rounded-2xl bg-gray-900/40 border border-gray-800/60 p-6 sm:p-8 space-y-6">
      <div className="text-center space-y-1">
        <h3 className="text-base font-bold text-white">StreamDrop Engine Architecture</h3>
        <p className="text-xs text-gray-400">Under the hood capabilities engineered for maximum compatibility</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-left">
        {/* Card 1 */}
        <div className="p-4 rounded-xl bg-gray-950/60 border border-gray-800/80 space-y-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
            <RefreshCw className="w-4 h-4" />
          </div>
          <h4 className="text-xs font-bold text-white">Redirect Resolution</h4>
          <p className="text-[11px] text-gray-400 leading-relaxed">
            Follows HTTP redirects for shortened mobile links (<code className="text-emerald-400">fb.watch</code>, <code className="text-emerald-400">vt.tiktok</code>, <code className="text-emerald-400">t.co</code>).
          </p>
        </div>

        {/* Card 2 */}
        <div className="p-4 rounded-xl bg-gray-950/60 border border-gray-800/80 space-y-2">
          <div className="w-8 h-8 rounded-lg bg-teal-500/10 text-teal-400 flex items-center justify-center">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <h4 className="text-xs font-bold text-white">Anti-Bot User-Agent</h4>
          <p className="text-[11px] text-gray-400 leading-relaxed">
            Integrates desktop browser headers to prevent Instagram and Facebook rate limiting and challenge screens.
          </p>
        </div>

        {/* Card 3 */}
        <div className="p-4 rounded-xl bg-gray-950/60 border border-gray-800/80 space-y-2">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
            <AudioLines className="w-4 h-4" />
          </div>
          <h4 className="text-xs font-bold text-white">192kbps MP3 Audio</h4>
          <p className="text-[11px] text-gray-400 leading-relaxed">
            Uses FFmpeg to extract high-fidelity MP3 audio on the fly with clean ID3 tags and stream normalization.
          </p>
        </div>

        {/* Card 4 */}
        <div className="p-4 rounded-xl bg-gray-950/60 border border-gray-800/80 space-y-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center">
            <FileCheck className="w-4 h-4" />
          </div>
          <h4 className="text-xs font-bold text-white">Auto Disk Cleanup</h4>
          <p className="text-[11px] text-gray-400 leading-relaxed">
            Temporary audio/video chunks are automatically wiped after serving to keep storage 100% ephemeral.
          </p>
        </div>
      </div>
    </div>
  );
};
