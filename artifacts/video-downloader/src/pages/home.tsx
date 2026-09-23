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
    const href = getDownloadHref(videoResult.downloadUrl);
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    if (isiOS) {
      window.open(href, "_blank", "noopener");
    } else {
      const a = document.createElement("a");
      a.href = href;
      a.download = "video.mp4";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  const formatsError = (listVideoFormats.error as any)?.error || "Couldn't read that link. Try another.";
  const downloadError = (createVideoDownload.error as any)?.error || "That quality didn't work.";

  const showForm = !videoResult && !formatsResult && !listVideoFormats.isPending;
  const showFormats = !videoResult && formatsResult && !createVideoDownload.isPending;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">

        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight">Video Downloader</h1>
          <p className="text-sm text-muted-foreground mt-1">Paste a link. Get the file.</p>
        </header>

        {showForm && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        placeholder="https://..."
                        className="h-14 rounded-none border-0 border-b border-border bg-transparent px-0 text-base focus-visible:ring-0 focus-visible:border-foreground"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              {listVideoFormats.isError && (
                <p className="text-xs text-muted-foreground">{formatsError}</p>
              )}
              <Button
                type="submit"
                className="w-full h-12 rounded-none bg-foreground text-background hover:bg-foreground/90 font-medium"
              >
                Continue
              </Button>
            </form>
          </Form>
        )}

        {listVideoFormats.isPending && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Reading link...
          </div>
        )}

        {showFormats && (
          <div className="space-y-6">
            <div className="aspect-video bg-muted overflow-hidden">
              {formatsResult.thumbnailUrl ? (
                <img src={formatsResult.thumbnailUrl} alt="" className="w-full h-full object-cover" />
              ) : null}
            </div>

            <div>
              <p className="text-sm font-medium line-clamp-2">{formatsResult.title || "Untitled"}</p>
              {formatsResult.durationSeconds != null && (
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDuration(formatsResult.durationSeconds)}
                </p>
              )}
            </div>

            <div className="space-y-1">
              {formatsResult.formats.map((format) => (
                <button
                  key={format.formatId}
                  type="button"
                  onClick={() => chooseFormat(format)}
                  className="w-full flex items-center justify-between py-3 text-left text-sm border-b border-border hover:pl-1 transition-all"
                >
                  <span className="font-medium">{format.label}</span>
                  {format.fileSizeBytes != null && (
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(format.fileSizeBytes)}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {createVideoDownload.isError && (
              <p className="text-xs text-muted-foreground">{downloadError}</p>
            )}

            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
            >
              <ArrowLeft size={12} />
              Try another link
            </button>
          </div>
        )}

        {createVideoDownload.isPending && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Fetching {selectedLabel ?? "video"}...
          </div>
        )}

        {videoResult && (
          <div className="space-y-6">
            <div className="aspect-video bg-muted overflow-hidden">
              {videoResult.thumbnailUrl ? (
                <img src={videoResult.thumbnailUrl} alt="" className="w-full h-full object-cover" />
              ) : null}
            </div>

            <div>
              <p className="text-sm font-medium line-clamp-2">{videoResult.title || "Untitled"}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {videoResult.durationSeconds != null && formatDuration(videoResult.durationSeconds)}
                {videoResult.durationSeconds != null && videoResult.fileSizeBytes != null && " · "}
                {videoResult.fileSizeBytes != null && formatBytes(videoResult.fileSizeBytes)}
              </p>
            </div>

            <button
              type="button"
              onClick={downloadVideo}
              className="w-full h-12 bg-foreground text-background font-medium inline-flex items-center justify-center gap-2 hover:bg-foreground/90 transition-colors"
            >
              <Download size={16} />
              Save
            </button>

            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
            >
              <ArrowLeft size={12} />
              New download
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
