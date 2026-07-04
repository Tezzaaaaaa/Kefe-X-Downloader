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

export async function downloadVideoFromPost(sourceUrl: string): Promise<StoredVideo> {
  const parsed = validatePostUrl(sourceUrl);

  const id = randomUUID();
  const outputTemplate = path.join(videosDir, `${id}.%(ext)s`);

  let stdout: string;
  try {
    const result = await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-warnings",
        "-f",
        "mp4/bestvideo*+bestaudio/best",
        "--merge-output-format",
        "mp4",
        "-o",
        outputTemplate,
        "--print-json",
        parsed.toString(),
      ],
      {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
  } catch (err) {
    logger.warn({ err, sourceUrl }, "yt-dlp failed to extract video");
    throw new ExtractionFailedError(
      "Couldn't find a downloadable video on that post. It may be private, deleted, or contain no video.",
    );
  }

  const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
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

  const stat = fs.statSync(filePath);

  const stored: StoredVideo = {
    id,
    title: info.title ?? null,
    thumbnailUrl: info.thumbnail ?? null,
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
    fileSizeBytes: stat.size,
    filePath,
    fileName: path.basename(filePath),
    sourceUrl,
    createdAt: new Date(),
  };

  videoStore.set(id, stored);
  scheduleCleanup(id);

  return stored;
}
