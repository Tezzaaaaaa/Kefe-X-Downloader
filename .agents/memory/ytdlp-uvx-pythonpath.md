---
name: yt-dlp via uvx requires stripped PYTHONPATH
description: How to invoke yt-dlp reliably in this environment without silently falling back to a stale version
---

Run yt-dlp as `uvx yt-dlp ...` instead of the Nix-provided `yt-dlp` binary, and strip `PYTHONPATH` from the child process env before spawning it.

**Why:** The Nix package pins an old yt-dlp version. X/Twitter changes its extraction API often enough that an outdated yt-dlp frequently fails to extract videos a current version handles fine. `uvx` fetches/caches the latest release, but the ambient `PYTHONPATH` injects the old Nix yt-dlp's site-packages directory, which shadows the newer version inside uvx's isolated venv — causing it to silently resolve to the old version even though `uvx` was invoked.

**How to apply:** Any `execFile`/`execFileAsync` call that spawns `uvx yt-dlp` (or `ffmpeg` alongside it) should destructure `PYTHONPATH` out of `process.env` and pass the rest as the child's `env`. This is a recurring pattern needed at every call site, not just once.
