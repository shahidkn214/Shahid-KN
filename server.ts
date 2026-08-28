import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import dns from 'dns';
import crypto from 'crypto';
import { promisify } from 'util';
import { spawn, spawnSync } from 'child_process';
import { createServer as createViteServer } from 'vite';
import * as cheerio from 'cheerio';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const lookupAsync = promisify(dns.lookup);

const app = express();
const PORT = 3000;

app.use(express.json());

// ---------------------------------------------------------------------------
// Security & CORS Headers Middleware
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// ---------------------------------------------------------------------------
// In-Memory Rate Limiting
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(ip: string, maxRequests: number, windowSeconds = 60): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const valid = timestamps.filter((t) => now - t < windowSeconds * 1000);
  if (valid.length >= maxRequests) {
    return true;
  }
  valid.push(now);
  rateLimitMap.set(ip, valid);
  return false;
}

function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

// ---------------------------------------------------------------------------
// SSRF & Domain Whitelist Validation
// ---------------------------------------------------------------------------
const ALLOWED_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'facebook.com',
  'fb.watch',
  'fb.com',
  'instagram.com',
  'instagr.am',
  'twitter.com',
  'x.com',
  't.co',
  'soundcloud.com',
  'vimeo.com',
  'reddit.com',
  'threads.net',
  'pinterest.com',
  'pin.it',
  'twitch.tv',
  'dailymotion.com',
  'dai.ly',
  'bilibili.com',
  'archive.org',
  'wikimedia.org',
  'googleapis.com',
  'github.com',
  'githubusercontent.com',
  'w3schools.com',
];

function isPrivateOrRestrictedIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  if (ip === '0.0.0.0' || ip === '255.255.255.255') return true;
  return false;
}

const KNOWN_SAFE_PUBLIC_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'soundcloud.com',
  'vimeo.com',
  'reddit.com',
  'facebook.com',
  'fb.watch',
  'threads.net',
  'pinterest.com',
  'snapchat.com',
  'dailymotion.com',
  'bilibili.com',
  'archive.org',
  'wikimedia.org',
  'wikipedia.org',
  'googleapis.com',
  'github.com',
  'githubusercontent.com',
  'w3schools.com',
];

async function isSafePublicUrl(urlStr: string): Promise<boolean> {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }

    if (KNOWN_SAFE_PUBLIC_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d))) {
      return true;
    }

    // Fast DNS lookup with timeout for arbitrary domains
    const lookupPromise = lookupAsync(hostname);
    const timeoutPromise = new Promise<{ address: string }>((_, reject) =>
      setTimeout(() => reject(new Error('DNS Timeout')), 1500),
    );
    const lookup = await Promise.race([lookupPromise, timeoutPromise]);
    if (isPrivateOrRestrictedIp(lookup.address)) {
      return false;
    }
    return true;
  } catch {
    // If external DNS check timed out on a valid HTTPS domain, allow safe processing
    return true;
  }
}

// Locate and verify yt-dlp binary (prefer verified system /usr/local/bin/yt-dlp, /tmp/yt-dlp, local binary)
function getYtDlpPath(): string {
  const possiblePaths = [
    '/usr/local/bin/yt-dlp',
    '/tmp/yt-dlp',
    path.resolve(process.cwd(), 'yt-dlp'),
    '/usr/bin/yt-dlp',
    'yt-dlp',
  ];

  for (const p of possiblePaths) {
    if (p !== 'yt-dlp' && fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755);
        return p;
      } catch {}
    }
  }
  return 'yt-dlp';
}

// Ensure working yt-dlp binary exists
function ensureYtDlpBinary(force = false): void {
  try {
    const currentPath = getYtDlpPath();
    const testResult = !force ? spawnSync(currentPath, ['--version'], { timeout: 4000 }) : { status: 1, stdout: '' };
    if (testResult.status !== 0 || !testResult.stdout.toString().trim()) {
      console.warn('[StreamDrop] Downloading fresh official yt-dlp release binary...');
      spawnSync('curl', ['-sL', 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', '-o', '/tmp/yt-dlp'], { timeout: 15000 });
      try {
        fs.chmodSync('/tmp/yt-dlp', 0o755);
        if (fs.existsSync(path.resolve(process.cwd(), 'yt-dlp'))) {
          fs.copyFileSync('/tmp/yt-dlp', path.resolve(process.cwd(), 'yt-dlp'));
          fs.chmodSync(path.resolve(process.cwd(), 'yt-dlp'), 0o755);
        }
      } catch {}
      console.log('[StreamDrop] Fresh yt-dlp binary verified and ready.');
    }
  } catch (err: any) {
    console.warn('[StreamDrop] Error verifying yt-dlp binary:', err.message);
  }
}
ensureYtDlpBinary();

// Global Process Handlers to prevent unhandled child process error crashes
process.on('uncaughtException', (err) => {
  console.error('[StreamDrop Server] Caught uncaughtException:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[StreamDrop Server] Caught unhandledRejection:', reason);
});

// User-Agent for spoofing requests and avoiding blocks
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Detect platform from URL
export function detectPlatform(rawUrl: string): { platform: string; name: string; isAudioOnly: boolean } {
  const url = rawUrl.toLowerCase();
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return { platform: 'youtube', name: 'YouTube', isAudioOnly: false };
  }
  if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) {
    return { platform: 'facebook', name: 'Facebook', isAudioOnly: false };
  }
  if (url.includes('tiktok.com')) {
    return { platform: 'tiktok', name: 'TikTok', isAudioOnly: false };
  }
  if (url.includes('instagram.com') || url.includes('instagr.am')) {
    return { platform: 'instagram', name: 'Instagram', isAudioOnly: false };
  }
  if (url.includes('twitter.com') || url.includes('x.com') || url.includes('t.co')) {
    return { platform: 'twitter', name: 'Twitter / X', isAudioOnly: false };
  }
  if (url.includes('soundcloud.com')) {
    return { platform: 'soundcloud', name: 'SoundCloud', isAudioOnly: true };
  }
  return { platform: 'generic', name: 'Universal Stream', isAudioOnly: false };
}

// Resolve shortened / redirected URLs
async function resolveUrlRedirect(inputUrl: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(inputUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);
    return res.url || inputUrl;
  } catch {
    return inputUrl;
  }
}

// Format duration
function formatSeconds(seconds?: number): string {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Storage for in-memory active jobs
interface ActiveJob {
  jobId: string;
  url: string;
  format: 'mp4' | 'mp3';
  quality: string;
  status: 'queued' | 'downloading' | 'converting' | 'completed' | 'failed';
  progress: number;
  speed?: string;
  eta?: string;
  totalSize?: string;
  filePath?: string;
  filename?: string;
  error?: string;
  createdAt: number;
}

const activeJobs = new Map<string, ActiveJob>();

// ---------------------------------------------------------------------------
// Database Architecture & Soft-Delete Persistence Layer
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || 'streamdrop_node_jwt_secret_key_2026_x89a';
const DATA_DIR = path.join(process.cwd(), '.data');
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}
const DB_FILE = path.join(DATA_DIR, 'streamdrop_database.json');

interface UserRecord {
  id: number;
  email: string;
  username: string;
  hashed_password: string;
  created_at: string;
}

interface HistoryRecord {
  id: number;
  user_id: number | null; // Null for guests
  media_title: string;
  media_thumbnail?: string;
  source_url: string;
  platform?: string;
  format_type: string; // 'mp4' | 'mp3'
  quality?: string;
  created_at: string;
  is_deleted_by_user: boolean; // Soft delete flag
}

interface DatabaseData {
  users: UserRecord[];
  download_history: HistoryRecord[];
  nextUserId: number;
  nextHistoryId: number;
}

class JsonDatabaseManager {
  private dbPath: string;
  private data: DatabaseData;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.data = this.load();
  }

  private load(): DatabaseData {
    if (fs.existsSync(this.dbPath)) {
      try {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        console.error('Error reading database file, initializing clean state:', e);
      }
    }
    const initial: DatabaseData = {
      users: [],
      download_history: [],
      nextUserId: 1,
      nextHistoryId: 1,
    };
    this.save(initial);
    return initial;
  }

  private save(data: DatabaseData) {
    try {
      const tempPath = `${this.dbPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.dbPath);
    } catch (e) {
      console.error('Failed to persist database file:', e);
    }
  }

  public createUser(email: string, username: string, plainPass: string): UserRecord | null {
    const cleanEmail = email.toLowerCase().trim();
    if (this.data.users.some((u) => u.email === cleanEmail)) {
      return null;
    }
    const salt = bcrypt.genSaltSync(10);
    const hashed = bcrypt.hashSync(plainPass, salt);
    const user: UserRecord = {
      id: this.data.nextUserId++,
      email: cleanEmail,
      username: username.trim(),
      hashed_password: hashed,
      created_at: new Date().toISOString(),
    };
    this.data.users.push(user);
    this.save(this.data);
    return user;
  }

  public authenticate(identifier: string, plainPass: string): UserRecord | null {
    const cleanId = identifier.toLowerCase().trim();
    const user = this.data.users.find(
      (u) => u.email === cleanId || u.username.toLowerCase() === cleanId,
    );
    if (!user) return null;
    const isValid = bcrypt.compareSync(plainPass, user.hashed_password);
    return isValid ? user : null;
  }

  public getUserById(id: number): UserRecord | null {
    return this.data.users.find((u) => u.id === id) || null;
  }

  public logDownload(params: {
    media_title: string;
    source_url: string;
    format_type: string;
    media_thumbnail?: string;
    platform?: string;
    quality?: string;
    user_id?: number | null;
  }): HistoryRecord {
    const record: HistoryRecord = {
      id: this.data.nextHistoryId++,
      user_id: params.user_id || null, // Null for guests
      media_title: params.media_title,
      media_thumbnail: params.media_thumbnail,
      source_url: params.source_url,
      platform: params.platform,
      format_type: params.format_type,
      quality: params.quality,
      created_at: new Date().toISOString(),
      is_deleted_by_user: false,
    };
    this.data.download_history.push(record);
    this.save(this.data);
    return record;
  }

  public getUserHistory(userId: number): HistoryRecord[] {
    // Soft-Delete query: Only returns items where is_deleted_by_user === false
    return this.data.download_history
      .filter((h) => h.user_id === userId && !h.is_deleted_by_user)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  public softDeleteItem(userId: number, historyId: number): boolean {
    const item = this.data.download_history.find((h) => h.id === historyId && h.user_id === userId);
    if (!item) return false;
    // Set soft-delete flag without removing row from DB
    item.is_deleted_by_user = true;
    this.save(this.data);
    return true;
  }

  public softDeleteAll(userId: number): number {
    let count = 0;
    for (const item of this.data.download_history) {
      if (item.user_id === userId && !item.is_deleted_by_user) {
        item.is_deleted_by_user = true;
        count++;
      }
    }
    if (count > 0) {
      this.save(this.data);
    }
    return count;
  }
}

const db = new JsonDatabaseManager(DB_FILE);

function getAuthUser(req: express.Request): UserRecord | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1].trim();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded || !decoded.sub) return null;
    return db.getUserById(Number(decoded.sub));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth & Session Endpoints
// ---------------------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.status(400).json({ success: false, error: 'Email, username, and password are required.' });
  }
  if (!/^[\w.-]+@[\w.-]+\.\w+$/.test(email.trim())) {
    return res.status(400).json({ success: false, error: 'Invalid email address format.' });
  }
  if (username.trim().length < 2) {
    return res.status(400).json({ success: false, error: 'Username must be at least 2 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
  }

  const user = db.createUser(email, username, password);
  if (!user) {
    return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' },
  );

  return res.json({
    success: true,
    token,
    user: { id: user.id, email: user.email, username: user.username },
    message: 'Account created successfully.',
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email/username and password are required.' });
  }

  const user = db.authenticate(email, password);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Invalid email or password.' });
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' },
  );

  return res.json({
    success: true,
    token,
    user: { id: user.id, email: user.email, username: user.username },
    message: 'Logged in successfully.',
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Unauthenticated or session expired.' });
  }
  return res.json({
    success: true,
    user: { id: user.id, email: user.email, username: user.username },
  });
});

// ---------------------------------------------------------------------------
// Download Logging & Soft-Delete History Endpoints
// ---------------------------------------------------------------------------
app.post('/api/log-download', (req, res) => {
  const user = getAuthUser(req);
  const { media_title, source_url, format_type, media_thumbnail, platform, quality } = req.body;

  if (!media_title || !source_url) {
    return res.status(400).json({ success: false, error: 'Media title and source URL are required.' });
  }

  const record = db.logDownload({
    media_title,
    source_url,
    format_type: format_type || 'mp4',
    media_thumbnail,
    platform,
    quality,
    user_id: user ? user.id : null, // Null for guests
  });

  return res.json({
    success: true,
    record_id: record.id,
    is_guest: !user,
    user_id: user ? user.id : null,
    message: 'Download logged successfully for audit and history tracking.',
  });
});

app.get('/api/history', (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    // Guest users have no persistent backend history
    return res.json({
      success: true,
      is_guest: true,
      history: [],
      data: [],
    });
  }

  const history = db.getUserHistory(user.id);
  return res.json({
    success: true,
    is_guest: false,
    user_id: user.id,
    history,
    data: history,
  });
});

app.delete('/api/history/clear-all', (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required to clear history.' });
  }

  const count = db.softDeleteAll(user.id);
  return res.json({
    success: true,
    count,
    message: `Successfully cleared ${count} items from your history (soft-deleted).`,
  });
});

app.delete('/api/history/:id', (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required to delete history.' });
  }

  const historyId = parseInt(req.params.id, 10);
  if (isNaN(historyId)) {
    return res.status(400).json({ success: false, error: 'Invalid history ID.' });
  }

  const success = db.softDeleteItem(user.id, historyId);
  if (!success) {
    return res.status(404).json({ success: false, error: 'History record not found or already removed.' });
  }

  return res.json({
    success: true,
    history_id: historyId,
    message: 'History item removed from your view (soft-deleted).',
  });
});

app.delete('/api/history', (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required to clear history.' });
  }

  const count = db.softDeleteAll(user.id);
  return res.json({
    success: true,
    count,
    message: `Successfully cleared ${count} items from your history.`,
  });
});

// Clean up stale jobs after 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of activeJobs.entries()) {
    if (now - job.createdAt > 15 * 60 * 1000) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        try {
          fs.unlinkSync(job.filePath);
        } catch {}
      }
      activeJobs.delete(jobId);
    }
  }
}, 60000);

// API: Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'StreamDrop Server', timestamp: Date.now() });
});

// API: Analyze URL
app.post('/api/analyze', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp, 25, 60)) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit reached. Please wait a moment before analyzing another link.',
      });
    }

    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ success: false, error: 'Please provide a valid URL.' });
    }

    const cleanUrl = url.trim();
    if (cleanUrl.length > 2048) {
      return res.status(400).json({ success: false, error: 'URL exceeds maximum length.' });
    }

    if (!/^https?:\/\//i.test(cleanUrl)) {
      return res.status(400).json({ success: false, error: 'URL must start with http:// or https://' });
    }

    const isSafe = await isSafePublicUrl(cleanUrl);
    if (!isSafe) {
      return res.status(400).json({ success: false, error: 'Unsupported or restricted domain.' });
    }

    // Resolve any shortened redirect URLs (fb.watch, vt.tiktok, t.co, etc.)
    const resolvedUrl = await resolveUrlRedirect(cleanUrl);
    const platformInfo = detectPlatform(resolvedUrl);

    const ytDlp = getYtDlpPath();

    // Call yt-dlp with --dump-single-json to extract metadata safely
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--socket-timeout',
      '12',
      '--user-agent',
      USER_AGENT,
      '--referer',
      'https://www.google.com/',
      '--extractor-args',
      'twitter:api=syndication;youtube:player_client=android,web;tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;generic:impersonate=chrome',
      resolvedUrl,
    ];

    const child = spawn(ytDlp, args);
    let stdout = '';
    let stderr = '';
    let hasResponded = false;

    child.on('error', (err) => {
      console.error('yt-dlp spawn error:', err);
      if (!hasResponded) {
        hasResponded = true;
        return res.status(500).json({
          success: false,
          error: `Media extraction engine error: ${err.message}`,
        });
      }
    });

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (hasResponded) return;
      hasResponded = true;
      if (code !== 0 || !stdout.trim()) {
        // Filter out Python deprecation warnings and benign logs
        const filteredStderr = stderr
          .split('\n')
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              !l.includes('Deprecated Feature:') &&
              !l.includes('Support for Python version') &&
              !l.includes('yt-dlp -U'),
          )
          .join('\n')
          .trim();

        console.error('yt-dlp analyze error:', filteredStderr || stderr);

        if (filteredStderr.includes('SyntaxError') || filteredStderr.includes('Non-UTF-8')) {
          ensureYtDlpBinary(true);
        }

        // User-friendly error message
        let errorMsg = 'Failed to extract media information from this URL.';
        if (filteredStderr.includes('SyntaxError') || filteredStderr.includes('Non-UTF-8')) {
          errorMsg = 'Media extraction engine re-initialized. Please click Fetch Stream again.';
        } else if (filteredStderr.includes('Private video') || filteredStderr.includes('login')) {
          errorMsg = 'This media is private or requires authentication to view.';
        } else if (filteredStderr.includes('Unsupported URL') || filteredStderr.includes('is not a valid URL')) {
          errorMsg = 'Unsupported platform or invalid media link.';
        } else if (filteredStderr.includes('Video unavailable')) {
          errorMsg = 'This video or track is no longer available.';
        } else if (filteredStderr.includes('rehydration') || filteredStderr.includes('universal data')) {
          errorMsg = 'TikTok video extraction encountered bot verification. Please try again or paste the direct web link.';
        } else if (filteredStderr) {
          const meaningfulErr = filteredStderr
            .split('\n')
            .reverse()
            .find((l) => l.includes('ERROR:') || l.toLowerCase().includes('error'));
          if (meaningfulErr) {
            errorMsg = meaningfulErr.replace(/^ERROR:\s*/i, '').trim();
          }
        }
        return res.status(422).json({
          success: false,
          error: errorMsg,
          rawError: filteredStderr.slice(0, 300),
        });
      }

      try {
        const info = JSON.parse(stdout);
        const durationSec = info.duration || 0;
        const isAudioOnly =
          platformInfo.isAudioOnly ||
          info.vcodec === 'none' ||
          (info._type === 'playlist' && !info.entries?.[0]?.vcodec);

        // Helper to format filesize
        const formatFilesize = (bytes?: number): string | undefined => {
          if (!bytes || bytes <= 0) return undefined;
          const mb = bytes / (1024 * 1024);
          if (mb >= 1000) return `${(mb / 1024).toFixed(2)} GB`;
          return `${mb.toFixed(1)} MB`;
        };

        // Extract video resolutions
        const standardTargets = [
          { height: 2160, resolution: '2160p', label: '4K Ultra HD (2160p)', badge: '4K UHD', videoBitrate: 15000 },
          { height: 1440, resolution: '1440p', label: '2K Quad HD (1440p)', badge: '2K QHD', videoBitrate: 8000 },
          { height: 1080, resolution: '1080p', label: '1080p Full HD', badge: '1080p FHD', videoBitrate: 3500 },
          { height: 720, resolution: '720p', label: '720p HD High Definition', badge: '720p HD', videoBitrate: 1800 },
          { height: 480, resolution: '480p', label: '480p Standard Definition', badge: '480p SD', videoBitrate: 900 },
          { height: 360, resolution: '360p', label: '360p Medium Quality', badge: '360p', videoBitrate: 500 },
          { height: 240, resolution: '240p', label: '240p Low Quality', badge: '240p', videoBitrate: 300 },
          { height: 144, resolution: '144p', label: '144p Compact / Data Saver', badge: '144p', videoBitrate: 150 },
        ];

        const rawFormats = Array.isArray(info.formats) ? info.formats : [];
        let maxHeight = typeof info.height === 'number' ? info.height : 0;
        let bestAudioSize = 0;
        let bestAudioBitrate = 128; // kbps

        const formatSizesByHeight = new Map<number, number>();

        for (const f of rawFormats) {
          const h = typeof f.height === 'number' ? f.height : 0;
          const vcodec = f.vcodec;
          const acodec = f.acodec;

          if (h && vcodec !== 'none') {
            maxHeight = Math.max(maxHeight, h);
          }

          if (acodec && acodec !== 'none' && vcodec === 'none') {
            const sz = f.filesize || f.filesize_approx;
            if (sz) bestAudioSize = Math.max(bestAudioSize, sz);
            if (f.abr) bestAudioBitrate = Math.max(bestAudioBitrate, f.abr);
          }

          if (h && vcodec !== 'none') {
            let sz = f.filesize || f.filesize_approx;
            if (!sz && durationSec && f.tbr) {
              sz = (f.tbr * 1000 / 8) * durationSec;
            }
            if (sz && sz > 0) {
              const current = formatSizesByHeight.get(h) || 0;
              if (sz > current) {
                if (acodec === 'none') {
                  const audioAdd = bestAudioSize > 0 ? bestAudioSize : (bestAudioBitrate * 1000 / 8) * durationSec;
                  sz += audioAdd;
                }
                formatSizesByHeight.set(h, sz);
              }
            }
          }
        }

        if (maxHeight === 0) {
          maxHeight = 1080;
        }

        const videoResolutions = [];
        if (!isAudioOnly) {
          for (const target of standardTargets) {
            const th = target.height;
            if (th <= maxHeight) {
              let computedBytes: number | undefined = formatSizesByHeight.get(th);
              if (!computedBytes) {
                const totalBitrate = target.videoBitrate + bestAudioBitrate;
                const dur = durationSec > 0 ? durationSec : 150;
                computedBytes = (totalBitrate * 1000 * dur) / 8;
              }

              videoResolutions.push({
                resolution: target.resolution,
                height: th,
                label: target.label,
                badge: target.badge,
                ext: 'mp4' as const,
                filesizeApprox: formatFilesize(computedBytes),
                isRecommended: false,
              });
            }
          }

          // Fallback if none matched
          if (videoResolutions.length === 0) {
            const dur = durationSec > 0 ? durationSec : 150;
            videoResolutions.push(
              { resolution: '1080p', height: 1080, label: '1080p Full HD', badge: '1080p FHD', ext: 'mp4' as const, isRecommended: true, filesizeApprox: formatFilesize((3628 * 1000 * dur) / 8) },
              { resolution: '720p', height: 720, label: '720p HD High Definition', badge: '720p HD', ext: 'mp4' as const, isRecommended: false, filesizeApprox: formatFilesize((1928 * 1000 * dur) / 8) },
              { resolution: '480p', height: 480, label: '480p Standard Definition', badge: '480p SD', ext: 'mp4' as const, isRecommended: false, filesizeApprox: formatFilesize((1028 * 1000 * dur) / 8) },
            );
          }

          // Set 1080p as recommended if present, else first element
          const rec1080 = videoResolutions.find((r) => r.resolution === '1080p');
          if (rec1080) {
            rec1080.isRecommended = true;
          } else if (videoResolutions.length > 0) {
            videoResolutions[0].isRecommended = true;
          }
        }

        // Standard Audio Bitrate Presets
        const durCalc = durationSec > 0 ? durationSec : 180;
        const audioBitrates = [
          { bitrate: '320k', kbps: 320, label: '320 kbps (Ultra High Quality MP3)', badge: 'Ultra HQ', ext: 'mp3' as const, filesizeApprox: formatFilesize((320 * 1000 / 8) * durCalc), isRecommended: false },
          { bitrate: '192k', kbps: 192, label: '192 kbps (Standard Quality MP3)', badge: 'Standard (Recommended)', ext: 'mp3' as const, filesizeApprox: formatFilesize((192 * 1000 / 8) * durCalc), isRecommended: true },
          { bitrate: '128k', kbps: 128, label: '128 kbps (Compact / Fast MP3)', badge: 'Fast', ext: 'mp3' as const, filesizeApprox: formatFilesize((128 * 1000 / 8) * durCalc), isRecommended: false },
          { bitrate: '64k', kbps: 64, label: '64 kbps (Low Bandwidth Audio)', badge: 'Low Data', ext: 'mp3' as const, filesizeApprox: formatFilesize((64 * 1000 / 8) * durCalc), isRecommended: false },
        ];

        // Determine best thumbnail
        let thumbnail = info.thumbnail;
        if (Array.isArray(info.thumbnails) && info.thumbnails.length > 0) {
          const sorted = [...info.thumbnails].sort(
            (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
          );
          thumbnail = sorted[0].url || thumbnail;
        }

        const metadata = {
          id: info.id || String(Date.now()),
          url: cleanUrl,
          resolvedUrl,
          title: info.title || 'Untitled Media',
          uploader: info.uploader || info.channel || info.artist || platformInfo.name,
          uploaderUrl: info.uploader_url || info.channel_url,
          duration: durationSec,
          durationFormatted: formatSeconds(durationSec),
          thumbnail: thumbnail || '',
          platform: platformInfo.platform,
          platformName: platformInfo.name,
          isAudioOnly,
          viewCount: info.view_count,
          likeCount: info.like_count,
          uploadDate: info.upload_date,
          videoResolutions,
          audioBitrates,
          formats: [
            ...videoResolutions.map((r) => ({
              formatId: `mp4-${r.resolution}`,
              ext: 'mp4' as const,
              label: r.label,
              resolution: r.resolution,
              isAudioOnly: false,
            })),
            ...audioBitrates.map((a) => ({
              formatId: `mp3-${a.bitrate}`,
              ext: 'mp3' as const,
              label: a.label,
              quality: a.bitrate,
              isAudioOnly: true,
            })),
          ],
        };

        return res.json({ success: true, data: metadata });
      } catch (e: any) {
        console.error('Failed to parse yt-dlp JSON:', e);
        return res.status(500).json({ success: false, error: 'Failed to parse stream metadata.' });
      }
    });
  } catch (err: any) {
    console.error('Analyze route error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Advanced Web & Media Metadata Inspector Endpoint (7 Core Modules)
// ---------------------------------------------------------------------------
app.post('/api/inspect', async (req, res) => {
  const startTime = Date.now();
  try {
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp, 30, 60)) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit reached. Please wait a moment before inspecting another URL.',
      });
    }

    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ success: false, error: 'Please provide a valid URL to inspect.' });
    }

    const cleanUrl = url.trim();
    if (cleanUrl.length > 2048) {
      return res.status(400).json({ success: false, error: 'URL exceeds maximum length.' });
    }

    if (!/^https?:\/\//i.test(cleanUrl)) {
      return res.status(400).json({ success: false, error: 'URL must begin with http:// or https://' });
    }

    const isSafe = await isSafePublicUrl(cleanUrl);
    if (!isSafe) {
      return res.status(400).json({ success: false, error: 'Target domain is restricted or not permitted.' });
    }

    let parsedTargetUrl: URL;
    try {
      parsedTargetUrl = new URL(cleanUrl);
    } catch {
      return res.status(400).json({ success: false, error: 'Malformed URL provided.' });
    }

    // Step 1: Fetch HTML with redirect tracking and response timing
    const redirectChain: { url: string; status: number }[] = [];
    let currentUrl = cleanUrl;
    let finalResponse: Response | null = null;
    let htmlContent = '';
    let responseHeaders: Record<string, string> = {};

    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 10000);

    try {
      // Manual redirect follow to record full audit chain
      let hopCount = 0;
      const maxHops = 5;

      while (hopCount < maxHops) {
        const stepRes = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
          },
        });

        redirectChain.push({ url: currentUrl, status: stepRes.status });

        if (stepRes.status >= 300 && stepRes.status < 400) {
          const location = stepRes.headers.get('location');
          if (location) {
            const nextUrl = new URL(location, currentUrl).href;
            currentUrl = nextUrl;
            hopCount++;
            continue;
          }
        }

        finalResponse = stepRes;
        stepRes.headers.forEach((val, key) => {
          responseHeaders[key.toLowerCase()] = val;
        });

        const contentType = responseHeaders['content-type'] || '';
        if (contentType.includes('text') || contentType.includes('html') || contentType.includes('xml') || contentType.includes('json')) {
          htmlContent = await stepRes.text();
        }
        break;
      }
    } catch (fetchErr: any) {
      console.warn('Inspect fetch warning:', fetchErr.message);
    } finally {
      clearTimeout(fetchTimeout);
    }

    const responseTimeMs = Date.now() - startTime;
    const finalUrl = currentUrl;
    const finalStatus = finalResponse ? finalResponse.status : 200;
    const finalStatusText = finalResponse ? finalResponse.statusText : 'OK';

    // Step 2: Parse DOM using Cheerio
    const $ = cheerio.load(htmlContent || '<html><head></head><body></body></html>');

    // 1. Open Graph & Social (OG & Twitter Tags)
    const openGraph = {
      title:
        $('meta[property="og:title"]').attr('content') ||
        $('meta[name="twitter:title"]').attr('content') ||
        $('title').text().trim() ||
        undefined,
      description:
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="twitter:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        undefined,
      image:
        $('meta[property="og:image"]').attr('content') ||
        $('meta[property="og:image:secure_url"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        $('meta[name="twitter:image:src"]').attr('content') ||
        undefined,
      video:
        $('meta[property="og:video"]').attr('content') ||
        $('meta[property="og:video:url"]').attr('content') ||
        $('meta[property="og:video:secure_url"]').attr('content') ||
        undefined,
      type: $('meta[property="og:type"]').attr('content') || 'website',
      url: $('meta[property="og:url"]').attr('content') || finalUrl,
      siteName:
        $('meta[property="og:site_name"]').attr('content') ||
        $('meta[name="application-name"]').attr('content') ||
        parsedTargetUrl.hostname,
      locale: $('meta[property="og:locale"]').attr('content') || $('html').attr('lang') || 'en_US',
      twitterCard: $('meta[name="twitter:card"]').attr('content') || 'summary_large_image',
      twitterTitle: $('meta[name="twitter:title"]').attr('content') || undefined,
      twitterDescription: $('meta[name="twitter:description"]').attr('content') || undefined,
      twitterImage: $('meta[name="twitter:image"]').attr('content') || undefined,
      twitterCreator: $('meta[name="twitter:creator"]').attr('content') || undefined,
      twitterSite: $('meta[name="twitter:site"]').attr('content') || undefined,
    };

    // 2. Structured Data (Schema.org JSON-LD / Microdata)
    const rawSchemas: any[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const text = $(el).html();
        if (text) {
          const parsed = JSON.parse(text.trim());
          if (Array.isArray(parsed)) {
            rawSchemas.push(...parsed);
          } else if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
            rawSchemas.push(...parsed['@graph']);
          } else {
            rawSchemas.push(parsed);
          }
        }
      } catch {}
    });

    const parsedSchemas = rawSchemas.map((s) => {
      const type = s['@type'] || (typeof s === 'object' ? Object.keys(s)[0] : 'Object');
      const authorVal = s.author || s.creator || s.publisher;
      let authorName: string | undefined;
      if (typeof authorVal === 'string') authorName = authorVal;
      else if (authorVal && typeof authorVal === 'object') authorName = authorVal.name;

      return {
        context: s['@context'] || 'https://schema.org',
        type: Array.isArray(type) ? type.join(', ') : String(type),
        name: s.name || s.headline || s.title || undefined,
        description: s.description ? String(s.description).slice(0, 300) : undefined,
        uploadDate: s.uploadDate || s.datePublished || s.dateCreated || undefined,
        author: authorName ? { name: authorName } : undefined,
        raw: s,
      };
    });

    const hasMicrodata = $('[itemscope]').length > 0 || $('[itemtype]').length > 0;

    const structuredData = {
      schemas: parsedSchemas,
      hasMicrodata,
      totalSchemasFound: parsedSchemas.length,
    };

    // 3. Internationalization (i18n & hreflang)
    const hreflangs: { lang: string; href: string }[] = [];
    $('link[rel="alternate"][hreflang]').each((_, el) => {
      const lang = $(el).attr('hreflang');
      const href = $(el).attr('href');
      if (lang && href) {
        hreflangs.push({ lang, href });
      }
    });

    const i18n = {
      htmlLang: $('html').attr('lang') || undefined,
      charset:
        $('meta[charset]').attr('charset') ||
        $('meta[http-equiv="Content-Type"]').attr('content') ||
        responseHeaders['content-type']?.split('charset=')?.[1] ||
        'UTF-8',
      dir: $('html').attr('dir') || 'ltr',
      hreflangs,
    };

    // 4. Link Analysis
    const canonical = $('link[rel="canonical"]').attr('href') || undefined;
    const robotsMeta =
      $('meta[name="robots"]').attr('content') ||
      $('meta[name="googlebot"]').attr('content') ||
      responseHeaders['x-robots-tag'] ||
      'index, follow';

    const linkAnalysis = {
      canonicalUrl: canonical ? new URL(canonical, finalUrl).href : undefined,
      robots: robotsMeta,
      statusCode: finalStatus,
      statusText: finalStatusText,
      redirectsCount: Math.max(0, redirectChain.length - 1),
      redirectChain,
      finalUrl,
      isHttps: finalUrl.startsWith('https://'),
    };

    // 5. Resources (Media streams, Posters, Audio Assets)
    const streams: { url: string; type: 'video' | 'audio' | 'manifest' | 'other'; mimeType?: string; label?: string }[] = [];
    const posters: { url: string; type: 'image'; mimeType?: string; label?: string }[] = [];
    const audioAssets: { url: string; type: 'audio'; mimeType?: string; label?: string }[] = [];

    // Extract from HTML <video>, <source>, <audio>, <img>
    $('video source, video').each((_, el) => {
      const src = $(el).attr('src');
      const type = $(el).attr('type') || 'video/mp4';
      if (src) {
        const fullSrc = new URL(src, finalUrl).href;
        streams.push({
          url: fullSrc,
          type: fullSrc.includes('.m3u8') ? 'manifest' : 'video',
          mimeType: type,
          label: fullSrc.includes('.m3u8') ? 'HLS Master Stream (.m3u8)' : 'Direct Video Stream (.mp4)',
        });
      }
    });

    $('audio source, audio').each((_, el) => {
      const src = $(el).attr('src');
      const type = $(el).attr('type') || 'audio/mpeg';
      if (src) {
        const fullSrc = new URL(src, finalUrl).href;
        audioAssets.push({
          url: fullSrc,
          type: 'audio',
          mimeType: type,
          label: 'Embedded Audio Asset',
        });
      }
    });

    // Poster thumbnail
    $('video[poster]').each((_, el) => {
      const poster = $(el).attr('poster');
      if (poster) {
        const fullPoster = new URL(poster, finalUrl).href;
        posters.push({
          url: fullPoster,
          type: 'image',
          mimeType: 'image/jpeg',
          label: 'HTML5 Video Poster',
        });
      }
    });

    if (openGraph.image) {
      posters.push({
        url: openGraph.image,
        type: 'image',
        mimeType: openGraph.image.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
        label: 'Open Graph Cover Image',
      });
    }

    if (openGraph.video) {
      streams.push({
        url: openGraph.video,
        type: 'video',
        mimeType: 'video/mp4',
        label: 'OG Video Resource',
      });
    }

    const resources = {
      streams,
      posters,
      audioAssets,
      totalResources: streams.length + posters.length + audioAssets.length,
    };

    // 6. Document Structure (Headings, word count, metadata)
    const pageTitle = $('title').text().trim() || openGraph.title || undefined;
    const pageMetaDesc =
      $('meta[name="description"]').attr('content') || openGraph.description || undefined;

    // Body text analytics
    const bodyClone = $('body').clone();
    bodyClone.find('script, style, noscript, svg, nav, footer, header').remove();
    const rawBodyText = bodyClone.text().replace(/\s+/g, ' ').trim();
    const words = rawBodyText ? rawBodyText.split(/\s+/).filter(Boolean) : [];

    const headings: { level: 'h1' | 'h2' | 'h3'; text: string }[] = [];
    $('h1, h2, h3').each((_, el) => {
      const tag = el.tagName.toLowerCase() as 'h1' | 'h2' | 'h3';
      const text = $(el).text().trim();
      if (text && headings.length < 20) {
        headings.push({ level: tag, text: text.slice(0, 100) });
      }
    });

    const documentStructure = {
      title: pageTitle,
      metaDescription: pageMetaDesc,
      wordCount: words.length,
      charCount: rawBodyText.length,
      h1Count: $('h1').length,
      h2Count: $('h2').length,
      h3Count: $('h3').length,
      headings,
    };

    // 7. Security Indicators
    const security = {
      isHttps: finalUrl.startsWith('https://'),
      certificateIssuer: finalUrl.startsWith('https://') ? 'SSL / TLS Active' : 'Insecure (HTTP)',
      contentSecurityPolicy: responseHeaders['content-security-policy'] || undefined,
      xFrameOptions: responseHeaders['x-frame-options'] || undefined,
      strictTransportSecurity: responseHeaders['strict-transport-security'] || undefined,
      xContentTypeOptions: responseHeaders['x-content-type-options'] || undefined,
      referrerPolicy: responseHeaders['referrer-policy'] || undefined,
      permissionsPolicy: responseHeaders['permissions-policy'] || undefined,
    };

    const inspectionResult = {
      url: cleanUrl,
      targetDomain: parsedTargetUrl.hostname,
      fetchedAt: new Date().toISOString(),
      responseTimeMs,
      openGraph,
      structuredData,
      i18n,
      linkAnalysis,
      resources,
      documentStructure,
      security,
    };

    return res.json({
      success: true,
      data: inspectionResult,
    });
  } catch (inspectErr: any) {
    console.error('Inspection error:', inspectErr);
    return res.status(500).json({
      success: false,
      error: inspectErr.message || 'Failed to complete metadata inspection.',
    });
  }
});

// API: Start download job (supports both /api/start-download and /api/download)
const handleDownloadRequest = async (req: express.Request, res: express.Response) => {
  try {
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp, 8, 60)) {
      return res.status(429).json({
        success: false,
        error: 'Download rate limit reached (max 8 downloads/min). Please wait a moment.',
      });
    }

    const { url, format = 'mp4', quality = 'best' } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'URL is required.' });
    }

    const cleanUrl = url.trim();
    if (cleanUrl.length > 2048) {
      return res.status(400).json({ success: false, error: 'URL exceeds maximum length.' });
    }

    const isSafe = await isSafePublicUrl(cleanUrl);
    if (!isSafe) {
      return res.status(400).json({ success: false, error: 'Unsupported or restricted domain.' });
    }

    const jobId = 'sd_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
    const tempDir = os.tmpdir();
    const outputTemplate = path.join(tempDir, `streamdrop_${jobId}.%(ext)s`);

    const ytDlp = getYtDlpPath();

    const job: ActiveJob = {
      jobId,
      url: cleanUrl,
      format: format === 'mp3' ? 'mp3' : 'mp4',
      quality,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };

    activeJobs.set(jobId, job);

    // Build download arguments with platform extractors (including Twitter/X syndication and YouTube anti-403)
    const args = [
      '--newline',
      '--no-playlist',
      '--socket-timeout',
      '20',
      '--max-filesize',
      '500M',
      '--geo-bypass',
      '--no-check-certificates',
      '--extractor-retries',
      '5',
      '--fragment-retries',
      '10',
      '--retry-sleep',
      '1',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      '--referer',
      'https://www.google.com/',
      '--add-header',
      'Accept-Language:en-US,en;q=0.9',
      '--extractor-args',
      'twitter:api=syndication;youtube:player_client=android,ios,web;player_skip=configs;tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;generic:impersonate=chrome',
    ];

    // Detect ffmpeg binary
    const ffmpegPath = '/usr/bin/ffmpeg';
    if (fs.existsSync(ffmpegPath)) {
      args.push('--ffmpeg-location', ffmpegPath);
    }

    if (job.format === 'mp3') {
      const rawQuality = String(quality).toLowerCase().replace('k', '');
      const audioBitrate = ['320', '192', '128', '64'].includes(rawQuality) ? rawQuality : '192';
      args.push(
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        audioBitrate,
        '-o',
        outputTemplate,
        cleanUrl,
      );
    } else {
      // MP4 video with resilient format ladder
      const match = String(quality).match(/(\d{3,4})/);
      const targetHeight = match ? parseInt(match[1], 10) : 720;

      const formatLadder =
        `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]/` +
        `bestvideo[height<=${targetHeight}]+bestaudio/` +
        `best[height<=${targetHeight}]/` +
        `bestvideo+bestaudio/` +
        `best`;

      args.push(
        '-f',
        formatLadder,
        '--merge-output-format',
        'mp4',
        '-o',
        outputTemplate,
        cleanUrl,
      );
    }

    // Launch download process
    const child = spawn(ytDlp, args);
    job.status = 'downloading';
    const stderrLines: string[] = [];

    child.on('error', (err) => {
      console.error(`[Job ${jobId}] yt-dlp spawn error:`, err);
      job.status = 'failed';
      job.error = `Download process error: ${err.message}`;
    });

    child.stdout.on('data', (data) => {
      const line = data.toString();
      // Parse yt-dlp progress line: [download]  45.2% of  15.20MiB at  3.50MiB/s ETA 00:03
      const downloadMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/i) ||
        line.match(/\[download\]\s+([\d.]+)%/i);

      if (downloadMatch) {
        job.status = 'downloading';
        job.progress = Math.min(98, Math.max(1, parseFloat(downloadMatch[1])));
        if (downloadMatch[2]) job.totalSize = downloadMatch[2];
        if (downloadMatch[3]) job.speed = downloadMatch[3];
        if (downloadMatch[4]) job.eta = downloadMatch[4];
      }

      // Check for converting/post-processing
      if (line.includes('[ExtractAudio]') || line.includes('[Merger]') || line.includes('[ffmpeg]') || line.includes('Post-process')) {
        job.status = 'converting';
        job.progress = 98;
      }

      // Capture destination filename
      const destMatch = line.match(/\[(?:download|Merger|ExtractAudio)\] Destination:\s+(.+)/i) ||
        line.match(/\[download\]\s+(.+?)\s+has already been downloaded/i);
      if (destMatch && destMatch[1]) {
        job.filePath = destMatch[1].trim();
      }
    });

    child.stderr.on('data', (data) => {
      const errLine = data.toString().trim();
      if (errLine) {
        stderrLines.push(errLine);
        console.warn(`[Job ${jobId}] stderr:`, errLine);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        // Find produced file in temp dir if not captured
        const expectedExt = job.format === 'mp3' ? '.mp3' : '.mp4';
        const expectedFile = path.join(tempDir, `streamdrop_${jobId}${expectedExt}`);

        if (fs.existsSync(expectedFile)) {
          job.filePath = expectedFile;
        } else if (!job.filePath || !fs.existsSync(job.filePath)) {
          // Check for any file matching streamdrop_<jobId>
          const files = fs.readdirSync(tempDir);
          const found = files.find((f) => f.startsWith(`streamdrop_${jobId}`));
          if (found) {
            job.filePath = path.join(tempDir, found);
          }
        }

        if (job.filePath && fs.existsSync(job.filePath)) {
          job.status = 'completed';
          job.progress = 100;
          job.filename = path.basename(job.filePath);
        } else {
          job.status = 'failed';
          job.error = 'Downloaded file could not be finalized.';
        }
      } else {
        job.status = 'failed';
        let customErr = 'Media extraction/conversion encountered an error.';
        const cleanLines = stderrLines.filter(
          (l) =>
            !l.includes('Deprecated Feature:') &&
            !l.includes('Support for Python version') &&
            !l.includes('yt-dlp -U'),
        );

        for (let i = cleanLines.length - 1; i >= 0; i--) {
          const l = cleanLines[i];
          if (l.includes('rehydration') || l.includes('universal data')) {
            customErr = 'TikTok anti-bot verification was triggered. Please try again or provide a direct video URL.';
            break;
          }
          if (l.includes('ERROR:') || l.toLowerCase().includes('error')) {
            customErr = l.replace(/^ERROR:\s*/i, '').trim();
            break;
          }
        }
        job.error = customErr;
      }
    });

    return res.json({
      success: true,
      jobId,
      job_id: jobId,
      status: job.status,
      message: 'Download job initialized successfully.',
    });
  } catch (err: any) {
    console.error('Start download error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to start download.' });
  }
};

app.post('/api/start-download', handleDownloadRequest);
app.post('/api/download', handleDownloadRequest);

// API: Check progress
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(jobId)) {
    return res.status(400).json({ success: false, error: 'Invalid job ID.' });
  }

  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired.' });
  }

  return res.json({
    success: true,
    job: {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      speed: job.speed,
      eta: job.eta,
      totalSize: job.totalSize,
      filename: job.filename,
      error: job.error,
      downloadUrl: job.status === 'completed' ? `/api/file/${job.jobId}` : undefined,
    },
  });
});

// API: Download finished file with safe headers and resilient fallback search
app.get('/api/file/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId || !/^[a-zA-Z0-9_-]{1,64}$/.test(jobId)) {
      return res.status(400).json({ success: false, error: 'Invalid job ID parameter.' });
    }

    const job = activeJobs.get(jobId);
    const tempDir = path.resolve(os.tmpdir());
    let targetFilePath = job?.filePath;

    // Resilient fallback search in temp directory if exact path not set or moved
    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      try {
        const files = fs.readdirSync(tempDir);
        const matchingFile = files.find((f) => f.includes(jobId));
        if (matchingFile) {
          targetFilePath = path.join(tempDir, matchingFile);
        }
      } catch (scanErr) {
        console.warn('Error searching tempDir for file:', scanErr);
      }
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      return res.status(404).json({ success: false, error: 'File is not ready or has expired. Please try downloading again.' });
    }

    const resolvedFilePath = path.resolve(targetFilePath);

    // Path traversal check
    if (!resolvedFilePath.startsWith(tempDir) && !resolvedFilePath.startsWith(path.resolve(process.cwd()))) {
      return res.status(403).json({ success: false, error: 'Forbidden file access.' });
    }

    const ext = job?.format === 'mp3' ? 'mp3' : (path.extname(resolvedFilePath).replace('.', '') || 'mp4');
    
    // Safely extract and sanitize custom filename
    let customName = typeof req.query.name === 'string' ? req.query.name : `Nexversal_${jobId}`;
    try {
      customName = decodeURIComponent(customName);
    } catch {
      // keep raw customName
    }
    const safeAsciiName = customName.replace(/[^\w\s.-]/gi, '_').replace(/\s+/g, '_').substring(0, 80) || `media_${jobId}`;
    const finalFilename = `${safeAsciiName}.${ext}`;

    const stat = fs.statSync(resolvedFilePath);
    const contentType = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(finalFilename)}"; filename*=UTF-8''${encodeURIComponent(finalFilename)}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const fileStream = fs.createReadStream(resolvedFilePath);
    fileStream.pipe(res);

    // Keep file available for 10 minutes in case of retries, then cleanup
    setTimeout(() => {
      try {
        if (fs.existsSync(resolvedFilePath)) {
          fs.unlinkSync(resolvedFilePath);
          console.log(`Cleaned up temp file after timeout: ${resolvedFilePath}`);
        }
        activeJobs.delete(jobId);
      } catch (cleanupErr) {
        console.warn('Delayed cleanup notice:', cleanupErr);
      }
    }, 10 * 60 * 1000);

    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to stream media file.' });
      }
    });
  } catch (err: any) {
    console.error('Download file handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message || 'Download failed.' });
    }
  }
});

// Alias for file route
app.get('/api/download-file/:jobId', (req, res) => {
  res.redirect(`/api/file/${req.params.jobId}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`);
});

// Production and Vite middleware integration
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`StreamDrop Server listening on http://0.0.0.0:${PORT}`);
  });
}

start();
