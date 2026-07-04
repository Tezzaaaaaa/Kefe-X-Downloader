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

interface YtDlpInfo {
  id?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  filesize?: number;
  filesize_approx?: number;
  ext?: string;
  requested_downloads?: Array<{
    filepath?: string;
    filesize?: number;
  }>;
}

async function downloadWithYtDlp(
  sourceUrl: string,
  id: string,
  outputTemplate: string,
): Promise<{ filePath: string; fileName: string; title: string | null; thumbnailUrl: string | null; durationSeconds: number | null }> {
  // Use `uvx yt-dlp` instead of the system `yt-dlp` binary: the Nix-provided
  // yt-dlp package is version-pinned and lags behind upstream, and X/Twitter
  // change their API often enough that an outdated yt-dlp frequently fails
  // to extract videos that a current version handles fine. `uvx` fetches
  // and caches the latest release. PYTHONPATH is stripped because the
  // ambient env injects the old Nix yt-dlp's site-packages dir, which
  // otherwise shadows the newer version inside uvx's isolated venv.
  const { PYTHONPATH: _unusedPythonPath, ...envWithoutPythonPath } = process.env;
  const result = await execFileAsync(
    "uvx",
    [
      "yt-dlp",
      "--no-playlist",
      "--no-warnings",
      "-f",
      "mp4/bestvideo*+bestaudio/best",
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

interface FxTwitterResponse {
  code?: number;
  tweet?: {
    text?: string;
    media?: {
      all?: Array<{
        url?: string;
        thumbnail_url?: string;
        duration?: number;
        type?: string;
      }>;
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

// Fallback for posts yt-dlp's Twitter extractor can't handle (e.g. some
// sensitive/NSFW-flagged posts fail yt-dlp's guest-token GraphQL flow even
// though the video is public). fxtwitter mirrors X's own oEmbed-like data
// and resolves a direct playable video URL we can download ourselves.
async function downloadViaFxTwitterFallback(
  parsed: URL,
  id: string,
): Promise<{ filePath: string; fileName: string; title: string | null; thumbnailUrl: string | null; durationSeconds: number | null }> {
  const statusPath = extractStatusPath(parsed);
  if (!statusPath) {
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  let data: FxTwitterResponse;
  try {
    const response = await fetch(`https://api.fxtwitter.com/${statusPath}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`fxtwitter responded with ${response.status}`);
    }
    data = (await response.json()) as FxTwitterResponse;
  } catch (err) {
    logger.warn({ err, sourceUrl: parsed.toString() }, "fxtwitter fallback lookup failed");
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  const media = data.tweet?.media?.all?.find((item) => item.type === "video" && item.url);
  if (!media?.url) {
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  const filePath = path.join(videosDir, `${id}.mp4`);
  const { PYTHONPATH: _unusedPythonPath, ...envWithoutPythonPath } = process.env;
  try {
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", media.url, "-c", "copy", filePath],
      {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: envWithoutPythonPath,
      },
    );
  } catch (err) {
    logger.warn({ err, sourceUrl: parsed.toString() }, "ffmpeg failed to download fxtwitter video URL");
    throw new ExtractionFailedError("The video file could not be saved.");
  }

  if (!fs.existsSync(filePath)) {
    throw new ExtractionFailedError("The video file could not be saved.");
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    title: data.tweet?.text ?? null,
    thumbnailUrl: media.thumbnail_url ?? null,
    durationSeconds: typeof media.duration === "number" ? media.duration : null,
  };
}

export async function downloadVideoFromPost(sourceUrl: string): Promise<StoredVideo> {
  const parsed = validatePostUrl(sourceUrl);

  const id = randomUUID();
  const outputTemplate = path.join(videosDir, `${id}.%(ext)s`);

  let result: { filePath: string; fileName: string; title: string | null; thumbnailUrl: string | null; durationSeconds: number | null };
  try {
    result = await downloadWithYtDlp(parsed.toString(), id, outputTemplate);
  } catch (err) {
    logger.warn({ err, sourceUrl }, "yt-dlp failed to extract video, trying fxtwitter fallback");
    result = await downloadViaFxTwitterFallback(parsed, id);
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
