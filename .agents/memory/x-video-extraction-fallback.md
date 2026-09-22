---
name: X/Twitter video extraction fallback chain
description: Why fxtwitter is needed alongside yt-dlp for extracting videos from X/Twitter posts, and what it provides
---

yt-dlp's Twitter extractor fails on some posts (e.g. sensitive/NSFW-flagged tweets) even when the video is public, because its guest-token GraphQL flow gets blocked. The fallback is the fxtwitter API, which mirrors X's own data and exposes direct playable video URLs. Some posts return 404 from `/<user>/status/<id>` but work from `/status/<id>`, so both endpoint forms are needed.

**Why:** Relying on yt-dlp alone leaves a meaningful fraction of real-world posts unextractable. fxtwitter's `tweet.media.all[].formats[]` array also conveniently exposes multiple mp4 bitrate/resolution variants (plus an m3u8 for adaptive streaming), which is useful not just as a fallback but as a source of per-quality download options.

**How to apply:** Try yt-dlp first; on failure, extract both the `user/status/id` path and the numeric status ID, then query `https://api.fxtwitter.com/<user>/status/<id>` followed by `https://api.fxtwitter.com/status/<id>`. When exposing fxtwitter-sourced URLs back to a client (e.g. as a selectable "format ID"), validate the decoded URL's host against an allowlist (e.g. `video.twimg.com`, `pbs.twimg.com`) before using it server-side — the ID round-trips through the client, so this is an SSRF boundary.
