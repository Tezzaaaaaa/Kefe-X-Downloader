import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  ListVideoFormatsBody,
  ListVideoFormatsResponse,
  CreateVideoDownloadBody,
  CreateVideoDownloadResponse,
  GetVideoFileParams,
} from "@workspace/api-zod";
import {
  downloadVideoFromPost,
  listVideoFormats,
  videoStore,
  InvalidUrlError,
  ExtractionFailedError,
} from "../lib/videoDownloader";

const router: IRouter = Router();

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
};

router.post("/videos/formats", async (req, res): Promise<void> => {
  const parsed = ListVideoFormatsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = await listVideoFormats(parsed.data.url);
    res.status(200).json(
      ListVideoFormatsResponse.parse({
        sourceUrl: result.sourceUrl,
        title: result.title,
        thumbnailUrl: result.thumbnailUrl,
        durationSeconds: result.durationSeconds,
        formats: result.formats,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidUrlError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ExtractionFailedError) {
      res.status(422).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Unexpected error listing video formats");
    res.status(422).json({
      error: "Something went wrong while checking that post. Please try again.",
    });
  }
});

router.post("/videos", async (req, res): Promise<void> => {
  const parsed = CreateVideoDownloadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const video = await downloadVideoFromPost(parsed.data.url, parsed.data.formatId);
    res.status(201).json(
      CreateVideoDownloadResponse.parse({
        id: video.id,
        sourceUrl: video.sourceUrl,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        durationSeconds: video.durationSeconds,
        fileSizeBytes: video.fileSizeBytes,
        downloadUrl: `/videos/${video.id}/file`,
        createdAt: video.createdAt.toISOString(),
      }),
    );
  } catch (err) {
    if (err instanceof InvalidUrlError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ExtractionFailedError) {
      res.status(422).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Unexpected error downloading video");
    res.status(422).json({
      error: "Something went wrong while fetching that video. Please try again.",
    });
  }
});

router.get("/videos/:id/file", (req, res): void => {
  const params = GetVideoFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const video = videoStore.get(params.data.id);
  if (!video) {
    res.status(404).json({ error: "Video not found or it has expired." });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(video.filePath);
  } catch {
    videoStore.delete(params.data.id);
    res.status(404).json({ error: "Video not found or it has expired." });
    return;
  }

  const totalSize = stat.size;
  const range = req.headers.range;
  const encodedFileName = encodeURIComponent(video.fileName);
  const ext = path.extname(video.fileName).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || "video/mp4";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(video.fileName)}"; filename*=UTF-8''${encodedFileName}`);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");

  if (!range) {
    res.setHeader("Content-Length", totalSize);
    fs.createReadStream(video.filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
    return;
  }

  const requestedStart = match[1] ? Number(match[1]) : null;
  const requestedEnd = match[2] ? Number(match[2]) : null;
  let start: number;
  let end: number;

  if (requestedStart === null && requestedEnd !== null) {
    const suffixLength = requestedEnd;
    if (suffixLength <= 0) {
      res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
      return;
    }
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = requestedStart ?? 0;
    end = requestedEnd ?? totalSize - 1;
  }

  if (
    start < 0 ||
    start >= totalSize ||
    end < start ||
    end >= totalSize
  ) {
    res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
    return;
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
  res.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(video.filePath, { start, end }).pipe(res);
});

export default router;
