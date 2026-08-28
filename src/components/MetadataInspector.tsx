import React, { useState } from 'react';
import {
  Share2,
  Database,
  Globe,
  Link2,
  PackageOpen,
  FileCode,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Copy,
  Check,
  Sparkles,
  AlertTriangle,
  Lock,
  Search,
  Eye,
  Layers,
  Code2,
  Terminal,
  Activity
} from 'lucide-react';
import { MetadataInspectionResult } from '../types';

interface MetadataInspectorProps {
  inspection: MetadataInspectionResult | null;
  isLoading: boolean;
  onInspect: () => void;
  targetUrl: string;
}

export const MetadataInspector: React.FC<MetadataInspectorProps> = ({
  inspection,
  isLoading,
  onInspect,
  targetUrl,
}) => {
  // Accordion open states
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    og: true,
    schema: false,
    i18n: false,
    links: false,
    resources: false,
    structure: false,
    security: false,
  });

  const [socialPreviewTab, setSocialPreviewTab] = useState<'whatsapp' | 'twitter' | 'facebook'>('twitter');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text: string, key: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  if (!targetUrl.trim()) return null;

  return (
    <section
      id="metadata-inspector-card"
      className="w-full rounded-2xl bg-gray-900/80 backdrop-blur-xl border border-gray-800/90 shadow-2xl p-4 sm:p-6 space-y-5"
    >
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-800/80">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <Search className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-gray-100">Web & Media Metadata Inspector</h3>
              <span className="px-2 py-0.5 text-[11px] font-semibold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                7 Modules
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Deep-inspect Open Graph, JSON-LD Schemas, i18n, Stream Resources & Security Indicators
            </p>
          </div>
        </div>

        <button
          id="trigger-inspect-btn"
          type="button"
          onClick={onInspect}
          disabled={isLoading || !targetUrl}
          className="self-start sm:self-auto flex items-center gap-2 px-3.5 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-200 hover:text-white text-xs font-semibold border border-gray-700 transition active:scale-95 disabled:opacity-50 cursor-pointer shadow-sm"
        >
          {isLoading ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
              <span>Inspecting DOM...</span>
            </>
          ) : (
            <>
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              <span>{inspection ? 'Re-Inspect URL' : 'Inspect URL Metadata'}</span>
            </>
          )}
        </button>
      </div>

      {/* When no inspection has been run yet */}
      {!inspection && !isLoading && (
        <div className="py-8 px-4 text-center rounded-xl bg-gray-950/50 border border-dashed border-gray-800 space-y-3">
          <Layers className="w-8 h-8 text-gray-500 mx-auto" />
          <p className="text-sm text-gray-300 font-medium">Ready to Audit Media URL Metadata</p>
          <p className="text-xs text-gray-500 max-w-md mx-auto">
            Click &quot;Inspect URL Metadata&quot; above to inspect Open Graph headers, Microdata / JSON-LD, hreflang regional targets, and direct audio/video streams.
          </p>
          <button
            type="button"
            onClick={onInspect}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/40 transition cursor-pointer"
          >
            Launch Deep Inspection
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="py-12 text-center space-y-3">
          <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm font-medium text-gray-300">Parsing DOM, Headings, Schemas & Security Headers...</p>
          <p className="text-xs text-gray-500">Fetching raw target HTML across 7 audit dimensions</p>
        </div>
      )}

      {/* Inspection Results Accordions */}
      {inspection && !isLoading && (
        <div className="space-y-3">
          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3 rounded-xl bg-gray-950/60 border border-gray-800/80 text-xs">
            <div>
              <span className="text-gray-500 block">Response Time</span>
              <span className="font-semibold text-emerald-400">{inspection.responseTimeMs} ms</span>
            </div>
            <div>
              <span className="text-gray-500 block">HTTP Status</span>
              <span className={`font-semibold ${inspection.linkAnalysis.statusCode < 400 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {inspection.linkAnalysis.statusCode} {inspection.linkAnalysis.statusText}
              </span>
            </div>
            <div>
              <span className="text-gray-500 block">Schemas Extracted</span>
              <span className="font-semibold text-cyan-400">{inspection.structuredData.totalSchemasFound} Items</span>
            </div>
            <div>
              <span className="text-gray-500 block">Media Resources</span>
              <span className="font-semibold text-pink-400">{inspection.resources.totalResources} Assets</span>
            </div>
          </div>

          {/* 1. Open Graph & Social Cards */}
          <div className="rounded-xl bg-gray-950/70 border border-gray-800/90 overflow-hidden transition-all">
            <button
              id="accordion-og-toggle"
              type="button"
              onClick={() => toggleSection('og')}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-gray-900/50 transition text-left cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Share2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-sm font-bold text-gray-200">1. Open Graph & Social (OG Tags)</span>
                {inspection.openGraph.title && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium">
                    {inspection.openGraph.type || 'website'}
                  </span>
                )}
              </div>
              {openSections.og ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>

            {openSections.og && (
              <div className="p-4 pt-0 space-y-4 border-t border-gray-800/60 text-xs">
                {/* Social Card Live Preview Tabs */}
                <div className="space-y-2.5 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400 font-medium flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5 text-emerald-400" />
                      Live Social Card Preview
                    </span>
                    <div className="flex items-center gap-1 bg-gray-900 p-1 rounded-lg border border-gray-800">
                      <button
                        type="button"
                        onClick={() => setSocialPreviewTab('twitter')}
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${
                          socialPreviewTab === 'twitter' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        Twitter / X
                      </button>
                      <button
                        type="button"
                        onClick={() => setSocialPreviewTab('facebook')}
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${
                          socialPreviewTab === 'facebook' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        Facebook
                      </button>
                      <button
                        type="button"
                        onClick={() => setSocialPreviewTab('whatsapp')}
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${
                          socialPreviewTab === 'whatsapp' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        WhatsApp
                      </button>
                    </div>
                  </div>

                  {/* Render simulated social preview */}
                  <div className="p-3 bg-gray-900/90 rounded-xl border border-gray-800 flex justify-center">
                    {socialPreviewTab === 'twitter' && (
                      <div className="w-full max-w-sm rounded-2xl overflow-hidden border border-gray-700/80 bg-black text-gray-200 shadow-md">
                        {inspection.openGraph.image ? (
                          <div className="h-44 bg-gray-900 overflow-hidden relative">
                            <img
                              src={inspection.openGraph.image}
                              alt="Social Card"
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                          </div>
                        ) : (
                          <div className="h-28 bg-gray-900 flex items-center justify-center text-gray-600 text-xs">
                            No og:image detected
                          </div>
                        )}
                        <div className="p-3 space-y-1">
                          <p className="text-[11px] text-gray-400 truncate">{inspection.targetDomain}</p>
                          <p className="text-xs font-bold line-clamp-1 text-white">{inspection.openGraph.title || 'Untitled Webpage'}</p>
                          <p className="text-[11px] text-gray-400 line-clamp-2">
                            {inspection.openGraph.description || 'No description meta tag provided for this stream or page.'}
                          </p>
                        </div>
                      </div>
                    )}

                    {socialPreviewTab === 'facebook' && (
                      <div className="w-full max-w-sm overflow-hidden border border-gray-700/80 bg-[#242526] text-gray-200 shadow-md rounded-lg">
                        {inspection.openGraph.image && (
                          <div className="h-44 bg-gray-900 overflow-hidden">
                            <img
                              src={inspection.openGraph.image}
                              alt="Social Card"
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                          </div>
                        )}
                        <div className="p-3 space-y-1">
                          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">{inspection.targetDomain}</span>
                          <p className="text-xs font-bold line-clamp-1 text-white">{inspection.openGraph.title || 'Untitled Webpage'}</p>
                          <p className="text-[11px] text-gray-400 line-clamp-2">{inspection.openGraph.description || 'No description provided.'}</p>
                        </div>
                      </div>
                    )}

                    {socialPreviewTab === 'whatsapp' && (
                      <div className="w-full max-w-sm rounded-lg overflow-hidden border border-emerald-900/60 bg-[#1f2c34] text-gray-200 p-2.5 flex gap-3 shadow-md">
                        {inspection.openGraph.image && (
                          <img
                            src={inspection.openGraph.image}
                            alt="Social Card"
                            className="w-16 h-16 rounded object-cover shrink-0 bg-gray-900"
                            referrerPolicy="no-referrer"
                          />
                        )}
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <p className="text-xs font-semibold text-emerald-400 line-clamp-1">{inspection.openGraph.title || 'Link Preview'}</p>
                          <p className="text-[11px] text-gray-300 line-clamp-2">{inspection.openGraph.description || inspection.targetDomain}</p>
                          <p className="text-[10px] text-gray-500 truncate">{inspection.targetDomain}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Raw Open Graph Table */}
                <div className="space-y-1.5">
                  <span className="text-gray-400 font-medium">Extracted Tags Table</span>
                  <div className="divide-y divide-gray-800 rounded-lg border border-gray-800 overflow-hidden bg-gray-900/60">
                    {[
                      { key: 'og:title', val: inspection.openGraph.title },
                      { key: 'og:description', val: inspection.openGraph.description },
                      { key: 'og:image', val: inspection.openGraph.image, isLink: true },
                      { key: 'og:video', val: inspection.openGraph.video, isLink: true },
                      { key: 'og:type', val: inspection.openGraph.type },
                      { key: 'og:site_name', val: inspection.openGraph.siteName },
                      { key: 'twitter:card', val: inspection.openGraph.twitterCard },
                      { key: 'twitter:creator', val: inspection.openGraph.twitterCreator },
                    ].map((row) => (
                      <div key={row.key} className="p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <span className="font-mono text-emerald-400 font-medium text-[11px] shrink-0 sm:w-36">{row.key}</span>
                        <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
                          <span className="text-gray-300 text-[11px] truncate">{row.val || '<empty>'}</span>
                          {row.val && (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(row.val!, row.key)}
                              className="text-gray-500 hover:text-gray-200 transition p-1 shrink-0"
                              title="Copy"
                            >
                              {copiedKey === row.key ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 2. Structured Data (Schema.org JSON-LD / Microdata) */}
          <div className="rounded-xl bg-gray-950/70 border border-gray-800/90 overflow-hidden transition-all">
            <button
              id="accordion-schema-toggle"
              type="button"
              onClick={() => toggleSection('schema')}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-gray-900/50 transition text-left cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Database className="w-4 h-4 text-cyan-400 shrink-0" />
                <span className="text-sm font-bold text-gray-200">2. Structured Data (Schema.org JSON-LD / Microdata)</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-medium">
                  {inspection.structuredData.totalSchemasFound} Found
                </span>
              </div>
              {openSections.schema ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>

            {openSections.schema && (
              <div className="p-4 pt-0 space-y-3 border-t border-gray-800/60 text-xs">
                {inspection.structuredData.schemas.length === 0 ? (
                  <div className="p-4 text-center text-gray-500 rounded-lg bg-gray-900/40 border border-gray-800">
                    No embedded &lt;script type=&quot;application/ld+json&quot;&gt; schema blocks found on this URL.
                  </div>
                ) : (
                  inspection.structuredData.schemas.map((schema, idx) => (
                    <div key={idx} className="p-3 rounded-lg bg-gray-900/70 border border-gray-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Code2 className="w-3.5 h-3.5 text-cyan-400" />
                          <span className="font-mono font-bold text-cyan-300 text-xs">{schema.type}</span>
                        </div>
                        {schema.uploadDate && (
                          <span className="text-[11px] text-gray-400">Date: {schema.uploadDate}</span>
                        )}
                      </div>

                      {schema.name && <p className="text-gray-200 font-medium">Name: {schema.name}</p>}
                      {schema.description && <p className="text-gray-400 text-[11px] line-clamp-2">{schema.description}</p>}

                      {/* Raw JSON viewer */}
                      <details className="text-[11px] pt-1">
                        <summary className="cursor-pointer text-gray-400 hover:text-cyan-300 transition">View formatted schema tree</summary>
                        <pre className="mt-2 p-2.5 rounded bg-black/70 border border-gray-800 text-gray-300 font-mono text-[10px] overflow-x-auto max-h-48">
                          {JSON.stringify(schema.raw, null, 2)}
                        </pre>
                      </details>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 3. Internationalization (i18n & hreflang) */}
          <div className="rounded-xl bg-gray-950/70 border border-gray-800/90 overflow-hidden transition-all">
            <button
              id="accordion-i18n-toggle"
              type="button"
              onClick={() => toggleSection('i18n')}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-gray-900/50 transition text-left cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Globe className="w-4 h-4 text-purple-400 shrink-0" />
                <span className="text-sm font-bold text-gray-200">3. Internationalization (i18n & hreflang)</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 font-medium">
                  {inspection.i18n.htmlLang || 'Default'}
                </span>
              </div>
              {openSections.i18n ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>

            {openSections.i18n && (
              <div className="p-4 pt-0 space-y-3 border-t border-gray-800/60 text-xs">
                <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-gray-900/60 border border-gray-800">
                  <div>
                    <span className="text-gray-500 block">Document Lang</span>
                    <span className="font-semibold text-purple-300 font-mono">{inspection.i18n.htmlLang || 'Not specified'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Charset</span>
                    <span className="font-semibold text-gray-200 font-mono">{inspection.i18n.charset}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Direction</span>
                    <span className="font-semibold text-gray-200 font-mono">{inspection.i18n.dir}</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-gray-400 font-medium">hreflang Alternate Targets ({inspection.i18n.hreflangs.length})</span>
                  {inspection.i18n.hreflangs.length === 0 ? (
                    <p className="text-gray-500 text-[11px]">No &lt;link rel=&quot;alternate&quot; hreflang=&quot;...&quot;&gt; tags detected.</p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {inspection.i18n.hreflangs.map((h, i) => (
                        <div key={i} className="flex items-center justify-between p-2 rounded bg-gray-900/60 border border-gray-800/80">
                          <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono text-[10px] font-bold">{h.lang}</span>
                          <span className="text-gray-400 truncate max-w-xs text-[11px]">{h.href}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 4. Link Analysis */}
          <div className="rounded-xl bg-gray-950/70 border border-gray-800/90 overflow-hidden transition-all">
            <button
              id="accordion-links-toggle"
              type="button"
              onClick={() => toggleSection('links')}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-gray-900/50 transition text-left cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <Link2 className="w-4 h-4 text-blue-400 shrink-0" />
                <span className="text-sm font-bold text-gray-200">4. Link Analysis & Redirects</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 font-medium">
                  {inspection.linkAnalysis.redirectsCount} Redirects
                </span>
              </div>
              {openSections.links ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>

            {openSections.links && (
              <div className="p-4 pt-0 space-y-3 border-t border-gray-800/60 text-xs">
                <div className="space-y-2">
                  <div className="p-2.5 rounded-lg bg-gray-900/60 border border-gray-800">
                    <span className="text-gray-500 block text-[11px]">Canonical Target URL</span>
                    <span className="font-mono text-blue-300 text-[11px] break-all">{inspection.linkAnalysis.canonicalUrl || 'No canonical tag specified'}</span>
                  </div>

                  <div className="p-2.5 rounded-lg bg-gray-900/60 border border-gray-800">
                    <span className="text-gray-500 block text-[11px]">Robots Directives (meta name=&quot;robots&quot;)</span>
                    <span className="font-mono text-emerald-400 text-[11px]">{inspection.linkAnalysis.robots}</span>
                  </div>
                </div>

                {/* Redirect Hops Chain */}
                <div className="space-y-1.5">
                  <span className="text-gray-400 font-medium">HTTP Hop Chain Audit</span>
                  <div className="space-y-1">
                    {inspection.linkAnalysis.redirectChain.map((hop, i) => (
                      <div key={i} className="flex items-center justify-between p-2 rounded bg-gray-900/40 border border-gray-800 text-[11px]">
                        <span className="text-gray-300 truncate max-w-sm">{hop.url}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${hop.status < 300 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>
                          HTTP {hop.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 5. Resources (Streams, Posters, Audio Assets) */}
          <div className="rounded-xl bg-gray-950/70 border border-gray-800/90 overflow-hidden transition-all">
            <button
              id="accordion-resources-toggle"
              type="button"
              onClick={() => toggleSection('resources')}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-gray-900/50 transition text-left cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <PackageOpen className="w-4 h-4 text-pink-400 shrink-0" />
                <span className="text-sm font-bold text-gray-200">5. Resources (Media Streams & Assets)</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-pink-500/15 text-pink-300 font-medium">
                  {inspection.resources.totalResources} Assets
                </span>
              </div>
              {openSections.resources ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>

            {openSections.resources && (
              <div className="p-4 pt-0 space-y-3 border-t border-gray-800/60 text-xs">
                {inspection.resources.streams.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-gray-400 font-medium">Discovered Video Streams</span>
                    {inspection.resources.streams.map((st, i) => (
                      <div key={i} className="p-2 rounded bg-gray-900/60 border border-gray-800 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-pink-300 text-[11px]">{st.label || 'Stream Asset'}</p>
                          <p className="text-gray-400 text-[10px] font-mono truncate">{st.url}</p>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-pink-500/10 text-pink-300 text-[10px] font-mono">{st.mimeType}</span>
                      </div>
                    ))}
                  </div>
                )}

                {inspection.resources.posters.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-gray-400 font-medium">Posters & Cover Images</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {inspection.resources.posters.map((post, i) => (
                        <div key={i} className="p-2 rounded bg-gray-900/60 border border-gray-800 flex items-center gap-2">
                          <img src={post.url} alt="Cover" className="w-12 h-12 object-cover rounded bg-black shrink-0" referrerPolicy="no-referrer" />
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-200 text-[11px]">{post.label}</p>
                            <p className="text-gray-500 text-[10px] font-mono truncate">{post.mimeType}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 6. Document Structure */}
          <div className="rounded-xl bg-gray-950/70 border border-gray-800/90 overflow-hidden transition-all">
            <button
              id="accordion-structure-toggle"
              type="button"
              onClick={() => toggleSection('structure')}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-gray-900/50 transition text-left cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <FileCode className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="text-sm font-bold text-gray-200">6. Document Structure & Headings</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 font-medium">
                  {inspection.documentStructure.wordCount} Words
                </span>
              </div>
              {openSections.structure ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>

            {openSections.structure && (
              <div className="p-4 pt-0 space-y-3 border-t border-gray-800/60 text-xs">
                <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-gray-900/60 border border-gray-800">
                  <div>
                    <span className="text-gray-500 block">H1 Count</span>
                    <span className="font-bold text-amber-400 text-sm">{inspection.documentStructure.h1Count}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">H2 Count</span>
                    <span className="font-bold text-gray-200 text-sm">{inspection.documentStructure.h2Count}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block">Word Count</span>
                    <span className="font-bold text-gray-200 text-sm">{inspection.documentStructure.wordCount}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-gray-400 font-medium">Page Title & Meta Description</span>
                  <div className="p-2.5 rounded bg-gray-900/60 border border-gray-800 space-y-1">
                    <p className="text-gray-200 font-semibold">{inspection.documentStructure.title || '<No title tag>'}</p>
                    <p className="text-gray-400 text-[11px]">{inspection.documentStructure.metaDescription || '<No meta description>'}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 7. Security Indicators */}
          <div className="rounded-xl bg-gray-950/70 border border-gray-800/90 overflow-hidden transition-all">
            <button
              id="accordion-security-toggle"
              type="button"
              onClick={() => toggleSection('security')}
              className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-gray-900/50 transition text-left cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-sm font-bold text-gray-200">7. Security Indicators</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium">
                  {inspection.security.isHttps ? 'HTTPS / SSL Active' : 'Insecure'}
                </span>
              </div>
              {openSections.security ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>

            {openSections.security && (
              <div className="p-4 pt-0 space-y-2 border-t border-gray-800/60 text-xs">
                <div className="divide-y divide-gray-800 rounded-lg border border-gray-800 bg-gray-900/60 overflow-hidden">
                  {[
                    { label: 'SSL / HTTPS Certificate', val: inspection.security.isHttps ? 'Valid & Encrypted' : 'Missing SSL', isGood: inspection.security.isHttps },
                    { label: 'Strict-Transport-Security (HSTS)', val: inspection.security.strictTransportSecurity || 'Not Enforced', isGood: !!inspection.security.strictTransportSecurity },
                    { label: 'X-Frame-Options (Clickjacking)', val: inspection.security.xFrameOptions || 'None (Embeddable)', isGood: !!inspection.security.xFrameOptions },
                    { label: 'Content-Security-Policy (CSP)', val: inspection.security.contentSecurityPolicy ? 'Configured' : 'Missing Header', isGood: !!inspection.security.contentSecurityPolicy },
                    { label: 'X-Content-Type-Options', val: inspection.security.xContentTypeOptions || 'nosniff', isGood: true },
                  ].map((sec, i) => (
                    <div key={i} className="p-2.5 flex items-center justify-between">
                      <span className="text-gray-300 font-medium">{sec.label}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${sec.isGood ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400'}`}>
                        {sec.val}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
