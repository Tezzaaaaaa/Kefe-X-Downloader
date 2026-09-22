import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server"))
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();

export const videosDir = path.resolve(workspaceRoot, "artifacts/api-server/data/videos");

fs.mkdirSync(videosDir, { recursive: true });

const ALLOWED_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.x.com",
]);

export class InvalidUrlError extends Error {}
export class ExtractionFailedError extends Error {}

export interface DownloadedVideo {
  id: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  filePath: string;
  fileName: string;
}

export interface StoredVideo extends DownloadedVideo {
  sourceUrl: string;
  createdAt: Date;
}

export const videoStore = new Map<string, StoredVideo>();

const FILE_TTL_MS = 30 * 60 * 1000;

function scheduleCleanup(id: string): void {
  setTimeout(() => {
    const entry = videoStore.get(id);
    if (!entry) return;
    fs.rm(entry.filePath, { force: true }, () => {});
    videoStore.delete(id);
  }, FILE_TTL_MS).unref();
}

export function validatePostUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidUrlError("That doesn't look like a valid URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidUrlError("URL must start with http:// or https://.");
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new InvalidUrlError(
      "Please paste a link to a post on x.com or twitter.com.",
    );
  }

  return parsed;
}

interface YtDlpFormat {
  format_id?: string;
  ext?: string;
  height?: number;
  width?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
}

interface YtDlpInfo {
  id?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  filesize?: number;
  filesize_approx?: number;
  ext?: string;
  formats?: YtDlpFormat[];
  requested_downloads?: Array<{
    filepath?: string;
    filesize?: number;
  }>;
}

export interface VideoFormatOption {
  formatId: string;
  label: string;
  height: number | null;
  width: number | null;
  ext: string | null;
  fileSizeBytes: number | null;
}

export interface VideoFormatsResult {
  sourceUrl: string;
  title: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  formats: VideoFormatOption[];
}

const FXURL_PREFIX = "fxurl:";
const ALLOWED_MEDIA_HOSTS = new Set(["video.twimg.com", "pbs.twimg.com"]);

async function runYtDlpJson(sourceUrl: string): Promise<YtDlpInfo> {
  const { PYTHONPATH: _unusedPythonPath, ...envWithoutPythonPath } = process.env;
  const result = await execFileAsync(
    "uvx",
    ["yt-dlp", "--no-playlist", "--no-warnings", "--skip-download", "-J", sourceUrl],
    {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: envWithoutPythonPath,
    },
  );
  return JSON.parse(result.stdout) as YtDlpInfo;
}

async function listFormatsWithYtDlp(sourceUrl: string): Promise<VideoFormatsResult> {
  const info = await runYtDlpJson(sourceUrl);

  const videoFormats = (info.formats ?? []).filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.format_id,
  );

  const byHeight = new Map<string, YtDlpFormat>();
  for (const f of videoFormats) {
    const key = `${f.height ?? "unknown"}-${f.ext ?? ""}`;
    const existing = byHeight.get(key);
    const size = f.filesize ?? f.filesize_approx ?? 0;
    const existingSize = existing ? (existing.filesize ?? existing.filesize_approx ?? 0) : -1;
    if (!existing || size > existingSize) {
      byHeight.set(key, f);
    }
  }

  const formats: VideoFormatOption[] = Array.from(byHeight.values())
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((f) => ({
      formatId: f.format_id as string,
      label: f.height ? `${f.height}p` : (f.format_note ?? "Video"),
      height: f.height ?? null,
      width: f.width ?? null,
      ext: f.ext ?? null,
      fileSizeBytes: f.filesize ?? f.filesize_approx ?? null,
    }));

  if (formats.length === 0) {
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  return {
    sourceUrl,
    title: info.title ?? null,
    thumbnailUrl: info.thumbnail ?? null,
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
    formats,
  };
}

async function downloadWithYtDlp(
  sourceUrl: string,
  id: string,
  outputTemplate: string,
  formatId?: string,
): Promise<{ filePath: string; fileName: string; title: string | null; thumbnailUrl: string | null; durationSeconds: number | null }> {
  // Use `uvx yt-dlp` instead of the system `yt-dlp` binary: the Nix-provided
  // yt-dlp package is version-pinned and lags behind upstream, and X/Twitter
  // change their API often enough that an outdated yt-dlp frequently fails
  // to extract videos that a current version handles fine. `uvx` fetches
  // and caches the latest release. PYTHONPATH is stripped because the
  // ambient env injects the old Nix yt-dlp's site-packages dir, which
  // otherwise shadows the newer version inside uvx's isolated venv.
  const { PYTHONPATH: _unusedPythonPath, ...envWithoutPythonPath } = process.env;
  // If a specific formatId is requested, fall back to it alone if bestaudio
  // merge isn't available for that format (e.g. it's already progressive).
  const formatSelector = formatId
    ? `${formatId}+bestaudio/${formatId}/best`
    : "mp4/bestvideo*+bestaudio/best";
  const result = await execFileAsync(
    "uvx",
    [
      "yt-dlp",
      "--no-playlist",
      "--no-warnings",
      "-f",
      formatSelector,
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      "--print-json",
      sourceUrl,
    ],
    {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: envWithoutPythonPath,
    },
  );

  const lastLine = result.stdout.trim().split("\n").filter(Boolean).pop();
  if (!lastLine) {
    throw new ExtractionFailedError("Couldn't read video information from that post.");
  }

  let info: YtDlpInfo;
  try {
    info = JSON.parse(lastLine);
  } catch (err) {
    logger.error({ err, sourceUrl }, "Failed to parse yt-dlp output");
    throw new ExtractionFailedError("Couldn't read video information from that post.");
  }

  const filePath =
    info.requested_downloads?.[0]?.filepath ??
    path.join(videosDir, `${id}.${info.ext ?? "mp4"}`);

  if (!fs.existsSync(filePath)) {
    throw new ExtractionFailedError("The video file could not be saved.");
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    title: info.title ?? null,
    thumbnailUrl: info.thumbnail ?? null,
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
  };
}

interface FxTwitterMediaVariant {
  url?: string;
  bitrate?: number;
  container?: string;
}

interface FxTwitterMediaItem {
  url?: string;
  thumbnail_url?: string;
  duration?: number;
  type?: string;
  width?: number;
  height?: number;
  formats?: FxTwitterMediaVariant[];
}

interface FxTwitterResponse {
  code?: number;
  tweet?: {
    text?: string;
    media?: {
      all?: FxTwitterMediaItem[];
    };
  };
}

function extractStatusPath(parsed: URL): string | null {
  // Matches "/<user>/status/<id>" regardless of extra trailing path segments
  // like "/video/1" or query strings like "?s=46".
  const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
  if (!match) return null;
  return `${match[1]}/status/${match[2]}`;
}

function extractStatusId(parsed: URL): string | null {
  const match = parsed.pathname.match(/\/status\/(\d+)/);
  return match?.[1] ?? null;
}

async function fetchFxTwitterData(parsed: URL): Promise<FxTwitterResponse> {
  const statusPath = extractStatusPath(parsed);
  const statusId = extractStatusId(parsed);
  if (!statusPath || !statusId) {
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  const endpointPaths = [statusPath, `status/${statusId}`];
  let lastStatus: number | null = null;

  for (const endpointPath of endpointPaths) {
    try {
      const response = await fetch(`https://api.fxtwitter.com/${endpointPath}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        return (await response.json()) as FxTwitterResponse;
      }
      lastStatus = response.status;
    } catch (err) {
      logger.warn({ err, endpointPath }, "fxtwitter endpoint lookup failed");
    }
  }

  logger.warn(
    { sourceUrl: parsed.toString(), lastStatus },
    "fxtwitter lookup failed for all endpoint variants",
  );
  throw new ExtractionFailedError(
    "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
  );
}

function parseHeightFromUrl(url: string): number | null {
  const match = url.match(/\/(\d+)x(\d+)\//);
  return match ? Number(match[2]) : null;
}

function assertAllowedMediaUrl(rawUrl: string): void {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw new ExtractionFailedError("The video file could not be saved.");
  }
  if (!ALLOWED_MEDIA_HOSTS.has(host)) {
    throw new ExtractionFailedError("The video file could not be saved.");
  }
}

// Fallback for posts yt-dlp's Twitter extractor can't handle (e.g. some
// sensitive/NSFW-flagged posts fail yt-dlp's guest-token GraphQL flow even
// though the video is public). fxtwitter mirrors X's own oEmbed-like data
// and resolves direct playable video URLs (per quality) we can download
// ourselves with ffmpeg.
async function listFormatsWithFxTwitter(parsed: URL): Promise<VideoFormatsResult> {
  const data = await fetchFxTwitterData(parsed);
  const media = data.tweet?.media?.all?.find((item) => item.type === "video" && item.url);
  if (!media) {
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  const mp4Variants = (media.formats ?? []).filter(
    (v) => v.container === "mp4" && v.url,
  );

  const formats: VideoFormatOption[] = mp4Variants
    .map((v) => {
      const height = parseHeightFromUrl(v.url as string);
      return {
        formatId: `${FXURL_PREFIX}${encodeURIComponent(v.url as string)}`,
        label: height ? `${height}p` : "Video",
        height,
        width: null,
        ext: "mp4",
        fileSizeBytes: null,
      };
    })
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

  if (formats.length === 0 && media.url) {
    formats.push({
      formatId: `${FXURL_PREFIX}${encodeURIComponent(media.url)}`,
      label: media.height ? `${media.height}p` : "Video",
      height: media.height ?? null,
      width: media.width ?? null,
      ext: "mp4",
      fileSizeBytes: null,
    });
  }

  if (formats.length === 0) {
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  return {
    sourceUrl: parsed.toString(),
    title: data.tweet?.text ?? null,
    thumbnailUrl: media.thumbnail_url ?? null,
    durationSeconds: typeof media.duration === "number" ? media.duration : null,
    formats,
  };
}

async function downloadFxUrl(
  mediaUrl: string,
  id: string,
): Promise<{ filePath: string; fileName: string }> {
  assertAllowedMediaUrl(mediaUrl);

  const filePath = path.join(videosDir, `${id}.mp4`);
  const { PYTHONPATH: _unusedPythonPath, ...envWithoutPythonPath } = process.env;
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", mediaUrl, "-c", "copy", filePath],
      {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: envWithoutPythonPath,
      },
    );
  } catch (err) {
    logger.warn({ err, mediaUrl }, "ffmpeg failed to download video URL");
    throw new ExtractionFailedError("The video file could not be saved.");
  }

  if (!fs.existsSync(filePath)) {
    throw new ExtractionFailedError("The video file could not be saved.");
  }

  return { filePath, fileName: path.basename(filePath) };
}

// Downloads the video at the default/best quality, trying yt-dlp first and
// falling back to fxtwitter if yt-dlp's extractor can't handle the post.
async function downloadViaFxTwitterFallback(
  parsed: URL,
  id: string,
): Promise<{ filePath: string; fileName: string; title: string | null; thumbnailUrl: string | null; durationSeconds: number | null }> {
  const data = await fetchFxTwitterData(parsed);
  const media = data.tweet?.media?.all?.find((item) => item.type === "video" && item.url);
  if (!media?.url) {
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  const { filePath, fileName } = await downloadFxUrl(media.url, id);

  return {
    filePath,
    fileName,
    title: data.tweet?.text ?? null,
    thumbnailUrl: media.thumbnail_url ?? null,
    durationSeconds: typeof media.duration === "number" ? media.duration : null,
  };
}

export async function listVideoFormats(sourceUrl: string): Promise<VideoFormatsResult> {
  const parsed = validatePostUrl(sourceUrl);

  try {
    return await listFormatsWithYtDlp(parsed.toString());
  } catch (err) {
    logger.warn({ err, sourceUrl }, "yt-dlp failed to list formats, trying fxtwitter fallback");
    return await listFormatsWithFxTwitter(parsed);
  }
}

export async function downloadVideoFromPost(
  sourceUrl: string,
  formatId?: string | null,
): Promise<StoredVideo> {
  const parsed = validatePostUrl(sourceUrl);

  const id = randomUUID();
  const outputTemplate = path.join(videosDir, `${id}.%(ext)s`);

  let result: { filePath: string; fileName: string; title: string | null; thumbnailUrl: string | null; durationSeconds: number | null };

  if (formatId && formatId.startsWith(FXURL_PREFIX)) {
    const mediaUrl = decodeURIComponent(formatId.slice(FXURL_PREFIX.length));
    const { filePath, fileName } = await downloadFxUrl(mediaUrl, id);
    result = { filePath, fileName, title: null, thumbnailUrl: null, durationSeconds: null };
  } else {
    try {
      result = await downloadWithYtDlp(parsed.toString(), id, outputTemplate, formatId ?? undefined);
    } catch (err) {
      logger.warn({ err, sourceUrl }, "yt-dlp failed to extract video, trying fxtwitter fallback");
      result = await downloadViaFxTwitterFallback(parsed, id);
    }
  }

  const stat = fs.statSync(result.filePath);

  const stored: StoredVideo = {
    id,
    title: result.title,
    thumbnailUrl: result.thumbnailUrl,
    durationSeconds: result.durationSeconds,
    fileSizeBytes: stat.size,
    filePath: result.filePath,
    fileName: result.fileName,
    sourceUrl,
    createdAt: new Date(),
  };

  videoStore.set(id, stored);
  scheduleCleanup(id);

  return stored;
}
