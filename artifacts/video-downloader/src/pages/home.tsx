import { useState } from "react";
import { Download, Loader2, ArrowLeft } from "lucide-react";
import { useCreateVideoDownload, useListVideoFormats } from "@workspace/api-client-react";
import type { Video, VideoFormat, VideoFormatsResponse } from "@workspace/api-client-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";

const formSchema = z.object({
  url: z.string().url("Enter a valid URL"),
});

function formatBytes(bytes: number) {
  if (!bytes) return null;
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const primaryBtn =
  "w-full h-12 rounded-full border-transparent bg-white text-black text-sm font-medium tracking-wide " +
  "shadow-[0_0_40px_-10px_rgba(190,210,255,0.55)] transition-all duration-300 hover:bg-white hover:-translate-y-px " +
  "hover:shadow-[0_0_50px_-8px_rgba(190,210,255,0.75)] active:translate-y-0 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090b]";

const ghostBtn =
  "text-xs tracking-wide text-white/40 hover:text-white transition-colors duration-300 inline-flex items-center gap-1.5 " +
  "focus-visible:outline-none focus-visible:text-white";

const stage = "animate-in fade-in slide-in-from-bottom-2 duration-700";

export default function Home() {
  const [videoResult, setVideoResult] = useState<Video | null>(null);
  const [formatsResult, setFormatsResult] = useState<VideoFormatsResponse | null>(null);
  const [postUrl, setPostUrl] = useState<string>("");
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { url: "" },
  });

  const listVideoFormats = useListVideoFormats();
  const createVideoDownload = useCreateVideoDownload();

  function onSubmit(values: z.infer<typeof formSchema>) {
    setVideoResult(null);
    setFormatsResult(null);
    setPostUrl(values.url);
    listVideoFormats.mutate(
      { data: { url: values.url } },
      { onSuccess: (data) => setFormatsResult(data) }
    );
  }

  function attemptDownload(remainingFormats: VideoFormat[]) {
    const [next, ...rest] = remainingFormats;
    setSelectedLabel(next?.label ?? "best available");
    createVideoDownload.mutate(
      { data: { url: postUrl, formatId: next?.formatId } },
      {
        onSuccess: (data) => setVideoResult(data),
        onError: () => {
          if (rest.length > 0) attemptDownload(rest);
        },
      }
    );
  }

  function chooseFormat(format: VideoFormat) {
    const formats = formatsResult?.formats ?? [];
    const chain = [format, ...formats.filter((f) => f.formatId !== format.formatId)];
    attemptDownload(chain);
  }

  function resetForm() {
    setVideoResult(null);
    setFormatsResult(null);
    setSelectedLabel(null);
    setPostUrl("");
    form.reset();
    listVideoFormats.reset();
    createVideoDownload.reset();
  }

  function getDownloadHref(url: string) {
    const path = url.startsWith("/") ? url : `/${url}`;
    return `/api${path}`;
  }

  function downloadVideo() {
    if (!videoResult?.downloadUrl) return;
    const a = document.createElement("a");
    a.href = getDownloadHref(videoResult.downloadUrl);
    a.download = "video.mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const formatsError = (listVideoFormats.error as any)?.error || "Couldn't read that link. Try another.";
  const downloadError = (createVideoDownload.error as any)?.error || "That quality didn't work.";

  const showForm = !videoResult && !formatsResult && !listVideoFormats.isPending;
  const showFormats = !videoResult && formatsResult && !createVideoDownload.isPending;

  return (
    <div className="kefe-stage min-h-[100dvh] text-white selection:bg-white selection:text-black flex flex-col items-center justify-center px-5 py-12">
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-white/[0.03] p-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_40px_100px_-40px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-10">
        <header className="mb-10">
          <h1
            className="font-serif text-5xl font-normal leading-[1.05] tracking-tight"
            style={{ fontFamily: '"Instrument Serif", Georgia, serif' }}
          >
            Video Downloader
          </h1>
          <p className="mt-3 text-sm tracking-wide text-white/45">Paste a link. Get the file.</p>
        </header>

        {showForm && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className={`space-y-6 ${stage}`}>
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        placeholder="https://..."
                        className="h-14 rounded-2xl border border-white/10 bg-white/[0.04] px-5 text-base text-white placeholder:text-white/30 shadow-none transition-all duration-300 hover:border-white/20 focus-visible:border-white/40 focus-visible:bg-white/[0.06] focus-visible:ring-4 focus-visible:ring-white/[0.06]"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="pl-1 text-xs text-white/60" />
                  </FormItem>
                )}
              />
              {listVideoFormats.isError && (
                <p className="text-xs text-white/50">{formatsError}</p>
              )}
              <Button type="submit" className={primaryBtn} disabled={listVideoFormats.isPending}>
                Continue
              </Button>
            </form>
          </Form>
        )}

        {listVideoFormats.isPending && (
          <div className="flex items-center gap-3 text-sm text-white/50">
            <Loader2 size={16} className="animate-spin" />
            Reading link...
          </div>
        )}

        {showFormats && (
          <div className={`space-y-8 ${stage}`}>
            <div className="aspect-video overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              {formatsResult.thumbnailUrl ? (
                <img
                  src={formatsResult.thumbnailUrl}
                  alt=""
                  className="h-full w-full object-cover grayscale-[0.6] transition duration-700 hover:scale-[1.03] hover:grayscale-0"
                />
              ) : null}
            </div>

            <div>
              <p className="line-clamp-2 text-base font-medium leading-snug">
                {formatsResult.title || "Untitled"}
              </p>
              {formatsResult.durationSeconds != null && (
                <p className="text-xs text-white/50 mt-1.5">
                  {formatDuration(formatsResult.durationSeconds)}
                </p>
              )}
            </div>

            <div className="space-y-2">
              {formatsResult.formats.map((format) => (
                <button
                  key={format.formatId}
                  type="button"
                  onClick={() => chooseFormat(format)}
                  className="group flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4 text-left text-sm transition-all duration-300 hover:border-white/30 hover:bg-white/[0.07] focus-visible:border-white/40 focus-visible:bg-white/[0.07] focus-visible:outline-none"
                >
                  <span className="font-medium transition-transform duration-300 group-hover:translate-x-1 group-focus-visible:translate-x-1">
                    {format.label}
                  </span>
                  {format.fileSizeBytes != null && (
                    <span className="text-xs tabular-nums text-white/40 transition-colors group-hover:text-white/80">
                      {formatBytes(format.fileSizeBytes)}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {createVideoDownload.isError && (
              <p className="text-xs text-white/50">{downloadError}</p>
            )}

            <button type="button" onClick={resetForm} className={ghostBtn}>
              <ArrowLeft size={12} />
              Try another link
            </button>
          </div>
        )}

        {createVideoDownload.isPending && (
          <div className="flex items-center gap-3 text-sm text-white/50">
            <Loader2 size={16} className="animate-spin" />
            Fetching {selectedLabel ?? "video"}...
          </div>
        )}

        {videoResult && (
          <div className={`space-y-8 ${stage}`}>
            <div className="aspect-video overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              {videoResult.thumbnailUrl ? (
                <img
                  src={videoResult.thumbnailUrl}
                  alt=""
                  className="h-full w-full object-cover grayscale-[0.6] transition duration-700 hover:scale-[1.03] hover:grayscale-0"
                />
              ) : null}
            </div>

            <div>
              <p className="line-clamp-2 text-base font-medium leading-snug">
                {videoResult.title || "Untitled"}
              </p>
              <p className="text-xs text-white/50 mt-1.5">
                {videoResult.durationSeconds != null && formatDuration(videoResult.durationSeconds)}
                {videoResult.durationSeconds != null && videoResult.fileSizeBytes != null && " · "}
                {videoResult.fileSizeBytes != null && formatBytes(videoResult.fileSizeBytes)}
              </p>
            </div>

            <button
              type="button"
              onClick={downloadVideo}
              className={primaryBtn + " inline-flex items-center justify-center gap-2"}
            >
              <Download size={16} />
              Save
            </button>

            <button type="button" onClick={resetForm} className={ghostBtn}>
              <ArrowLeft size={12} />
              New download
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
