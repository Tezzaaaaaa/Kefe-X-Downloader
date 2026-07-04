import { Router, type IRouter } from "express";
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

  res.download(video.filePath, video.fileName);
});

export default router;
