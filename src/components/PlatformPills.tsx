import React from 'react';
import { Youtube, Facebook, Music2, Instagram, Twitter, Radio, PlayCircle, Sparkles } from 'lucide-react';

interface PlatformPillsProps {
  onSelectSample: (sampleUrl: string) => void;
}

const PLATFORMS = [
  {
    name: '1-Click Sample Test',
    icon: <PlayCircle className="w-3.5 h-3.5" />,
    color: 'hover:border-emerald-500/60 hover:bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    sample: 'https://commons.wikimedia.org/wiki/File:Example.ogg',
    isTest: true,
  },
  {
    name: 'YouTube',
    icon: <Youtube className="w-3.5 h-3.5" />,
    color: 'hover:border-red-500/50 hover:bg-red-500/10 text-red-400',
    sample: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    name: 'TikTok',
    icon: <Music2 className="w-3.5 h-3.5" />,
    color: 'hover:border-cyan-500/50 hover:bg-cyan-500/10 text-cyan-300',
    sample: 'https://www.tiktok.com/@tiktok/video/7106594312292453678',
  },
  {
    name: 'Instagram',
    icon: <Instagram className="w-3.5 h-3.5" />,
    color: 'hover:border-pink-500/50 hover:bg-pink-500/10 text-pink-400',
    sample: 'https://www.instagram.com/reels/C8jKl2vOXxY/',
  },
  {
    name: 'Twitter / X',
    icon: <Twitter className="w-3.5 h-3.5" />,
    color: 'hover:border-sky-500/50 hover:bg-sky-500/10 text-sky-400',
    sample: 'https://twitter.com/NASA/status/1781014234567890123',
  },
  {
    name: 'Facebook',
    icon: <Facebook className="w-3.5 h-3.5" />,
    color: 'hover:border-blue-500/50 hover:bg-blue-500/10 text-blue-400',
    sample: 'https://www.facebook.com/watch/?v=10153231379946729',
  },
  {
    name: 'SoundCloud',
    icon: <Radio className="w-3.5 h-3.5" />,
    color: 'hover:border-orange-500/50 hover:bg-orange-500/10 text-orange-400',
    sample: 'https://soundcloud.com/octobersveryown/drake-gods-plan',
  },
];

export const PlatformPills: React.FC<PlatformPillsProps> = ({ onSelectSample }) => {
  return (
    <div className="w-full flex flex-col items-center gap-2.5">
      <div className="flex items-center gap-1.5 text-xs text-gray-400">
        <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
        <span>Supported Platforms & 1-Click Test Media:</span>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
        {PLATFORMS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onSelectSample(p.sample)}
            className={`px-3 py-1.5 rounded-full bg-gray-900/80 border border-gray-800 flex items-center gap-1.5 font-medium transition-all duration-200 active:scale-95 ${p.color}`}
            title={`Click to test with ${p.name}`}
          >
            {p.icon}
            <span>{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

