export type PlatformType = 'youtube' | 'facebook' | 'tiktok' | 'instagram' | 'twitter' | 'soundcloud' | 'generic';

export interface VideoResolutionOption {
  resolution: string; // e.g. "1080p", "720p"
  height: number;
  label: string;
  badge?: string;
  ext: 'mp4';
  filesizeApprox?: string;
  isRecommended?: boolean;
}

export interface AudioBitrateOption {
  bitrate: string; // "320k", "192k", "128k", "64k"
  kbps: number;
  label: string;
  badge?: string;
  ext: 'mp3';
  filesizeApprox?: string;
  isRecommended?: boolean;
}

export interface MediaFormatOption {
  formatId: string;
  ext: 'mp4' | 'mp3';
  label: string;
  resolution?: string;
  quality?: string;
  filesizeApprox?: number;
  isAudioOnly?: boolean;
}

export interface MediaMetadata {
  id: string;
  url: string;
  resolvedUrl: string;
  title: string;
  uploader?: string;
  uploaderUrl?: string;
  duration?: number;
  durationFormatted?: string;
  thumbnail?: string;
  platform: PlatformType;
  platformName: string;
  isAudioOnly: boolean;
  viewCount?: number;
  likeCount?: number;
  uploadDate?: string;
  formats?: MediaFormatOption[];
  videoResolutions?: VideoResolutionOption[];
  audioBitrates?: AudioBitrateOption[];
}

export interface DownloadJob {
  jobId: string;
  url: string;
  format: 'mp4' | 'mp3';
  quality?: string;
  selectedLabel?: string;
  status: 'queued' | 'downloading' | 'converting' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  eta?: string;
  speed?: string;
  totalSize?: string;
  filename?: string;
  downloadUrl?: string;
  error?: string;
}

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  platform: PlatformType;
  format: 'mp4' | 'mp3';
  quality?: string;
  timestamp: number;
  durationFormatted?: string;
}

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  createdAt?: string;
}


// ---------------------------------------------------------------------------
// Advanced Web & Media Metadata Inspector Types
// ---------------------------------------------------------------------------

export interface OpenGraphData {
  title?: string;
  description?: string;
  image?: string;
  video?: string;
  type?: string;
  url?: string;
  siteName?: string;
  locale?: string;
  twitterCard?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
  twitterCreator?: string;
  twitterSite?: string;
}

export interface JsonLdSchemaItem {
  context?: string;
  type: string;
  name?: string;
  description?: string;
  uploadDate?: string;
  author?: string | { name?: string };
  raw: Record<string, any>;
}

export interface StructuredDataInfo {
  schemas: JsonLdSchemaItem[];
  hasMicrodata: boolean;
  totalSchemasFound: number;
}

export interface HreflangTarget {
  lang: string;
  href: string;
}

export interface I18nData {
  htmlLang?: string;
  charset?: string;
  dir?: string;
  hreflangs: HreflangTarget[];
}

export interface RedirectStep {
  url: string;
  status: number;
}

export interface LinkAnalysisData {
  canonicalUrl?: string;
  robots?: string;
  statusCode: number;
  statusText?: string;
  redirectsCount: number;
  redirectChain: RedirectStep[];
  finalUrl: string;
  isHttps: boolean;
}

export interface MediaResourceItem {
  url: string;
  type: 'video' | 'audio' | 'image' | 'manifest' | 'other';
  mimeType?: string;
  dimensions?: string;
  filesizeApprox?: string;
  label?: string;
}

export interface ResourcesData {
  streams: MediaResourceItem[];
  posters: MediaResourceItem[];
  audioAssets: MediaResourceItem[];
  totalResources: number;
}

export interface HeadingItem {
  level: 'h1' | 'h2' | 'h3';
  text: string;
}

export interface DocumentStructureData {
  title?: string;
  metaDescription?: string;
  wordCount: number;
  charCount: number;
  h1Count: number;
  h2Count: number;
  h3Count: number;
  headings: HeadingItem[];
}

export interface SecurityIndicatorsData {
  isHttps: boolean;
  certificateIssuer?: string;
  contentSecurityPolicy?: string;
  xFrameOptions?: string;
  strictTransportSecurity?: string;
  xContentTypeOptions?: string;
  referrerPolicy?: string;
  permissionsPolicy?: string;
}

export interface MetadataInspectionResult {
  url: string;
  targetDomain: string;
  fetchedAt: string;
  responseTimeMs: number;
  openGraph: OpenGraphData;
  structuredData: StructuredDataInfo;
  i18n: I18nData;
  linkAnalysis: LinkAnalysisData;
  resources: ResourcesData;
  documentStructure: DocumentStructureData;
  security: SecurityIndicatorsData;
}

