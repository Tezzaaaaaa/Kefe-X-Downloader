import React, { useState } from "react";
import { Download, Link as LinkIcon, Loader2, PlayCircle, AlertCircle, RefreshCw, XCircle, Gauge } from "lucide-react";
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
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const formSchema = z.object({
  url: z.string().url("Please enter a valid video URL"),
});

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      url: "",
    },
  });

  const listVideoFormats = useListVideoFormats();
  const createVideoDownload = useCreateVideoDownload();

  function onSubmit(values: z.infer<typeof formSchema>) {
    setVideoResult(null);
    setFormatsResult(null);
    setRetryNotice(null);
    setSelectedLabel(null);
    setPostUrl(values.url);
    listVideoFormats.mutate(
      { data: { url: values.url } },
      {
        onSuccess: (data) => {
          setFormatsResult(data);
        },
      }
    );
  }

  // Attempts to download the given quality. If that specific quality fails
  // (e.g. a stale/broken CDN URL for that format), automatically falls back
  // to the next-best quality in the list, then finally to the server's
  // best-effort default (no formatId), so users rarely have to manually
  // retry themselves.
  function attemptDownload(remainingFormats: VideoFormat[], failedLabels: string[]) {
    const [next, ...rest] = remainingFormats;
    const formatId = next?.formatId;
    setSelectedLabel(next?.label ?? "best available");
    setRetryNotice(
      failedLabels.length > 0
        ? `${failedLabels[failedLabels.length - 1]} didn't work, trying ${next?.label ?? "best available"} instead...`
        : null
    );

    createVideoDownload.mutate(
      { data: { url: postUrl, formatId } },
      {
        onSuccess: (data) => {
          setVideoResult(data);
          setRetryNotice(null);
        },
        onError: () => {
          if (rest.length > 0) {
            attemptDownload(rest, [...failedLabels, next?.label ?? "that quality"]);
          } else {
            setRetryNotice(null);
          }
        },
      }
    );
  }

  function chooseFormat(format: VideoFormat | null) {
    const formats = formatsResult?.formats ?? [];
    // Build the fallback chain: chosen quality first, then every other
    // quality (best to worst) as automatic retries if it fails.
    const chain = format
      ? [format, ...formats.filter((f) => f.formatId !== format.formatId)]
      : formats;
    attemptDownload(chain.length > 0 ? chain : [format as VideoFormat], []);
  }

  const resetForm = () => {
    setVideoResult(null);
    setFormatsResult(null);
    setRetryNotice(null);
    setSelectedLabel(null);
    setPostUrl("");
    form.reset();
    listVideoFormats.reset();
    createVideoDownload.reset();
  };

  // The API server is a separate service mounted at the "/api" path prefix
  // (see artifacts/api-server/.replit-artifact/artifact.toml). It is NOT the
  // same as this frontend's own BASE_URL, which is "/". Using BASE_URL here
  // would point the download link at this SPA's own root, which falls back
  // to index.html for unmatched routes -- resulting in an HTML file being
  // downloaded instead of the actual video.
  const getDownloadHref = (downloadUrl: string) => {
    const path = downloadUrl.startsWith('/') ? downloadUrl : `/${downloadUrl}`;
    return `/api${path}`;
  };

  const isFormatsError = listVideoFormats.isError;
  const formatsErrorMessage = (listVideoFormats.error as any)?.error || "Failed to extract video. It might be private, deleted, or unsupported.";

  const isDownloadError = createVideoDownload.isError;
  const downloadErrorMessage = (createVideoDownload.error as any)?.error || "Failed to download that quality. Please try another one.";

  const showForm = !videoResult && !formatsResult && !listVideoFormats.isPending;
  const showFormatPicker = !videoResult && formatsResult && !createVideoDownload.isPending;

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center p-4 sm:p-8 relative overflow-hidden bg-background">
      {/* Decorative background shapes */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-accent/30 rounded-full blur-[120px] pointer-events-none" />
      
      <div className="w-full max-w-xl z-10 space-y-8">
        
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 mb-2">
            <Download size={32} strokeWidth={2.5} />
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-foreground" data-testid="heading-title">
            Grab That Video
          </h1>
          <p className="text-lg text-muted-foreground font-medium" data-testid="text-subtitle">
            Paste a link from a supported video site. Get the file. Fast and simple.
          </p>
        </div>

        {/* Main Content Area */}
        <div className="bg-card shadow-xl shadow-black/5 rounded-3xl border border-border p-6 sm:p-8">
          
          {/* Form State */}
          {showForm && (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                  control={form.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="relative">
                          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-muted-foreground">
                            <LinkIcon size={20} />
                          </div>
                          <Input 
                           placeholder="https://www.youtube.com/watch?v=..." 
                            className="pl-11 h-16 text-lg rounded-2xl bg-secondary/30 border-2 focus-visible:ring-offset-0 focus-visible:ring-primary/20 focus-visible:border-primary transition-all shadow-inner" 
                            {...field} 
                            data-testid="input-url"
                          />
                        </div>
                      </FormControl>
                      <FormMessage className="text-sm font-medium ml-1" data-testid="error-url" />
                    </FormItem>
                  )}
                />

                {isFormatsError && (
                  <Alert variant="destructive" className="rounded-xl border-2" data-testid="alert-error">
                    <AlertCircle className="h-5 w-5" />
                    <AlertTitle className="text-base font-bold">Oops!</AlertTitle>
                    <AlertDescription className="text-sm font-medium mt-1">
                      {formatsErrorMessage}
                    </AlertDescription>
                  </Alert>
                )}

                <Button 
                  type="submit" 
                  size="lg" 
                  className="w-full h-16 text-xl font-bold rounded-2xl shadow-lg shadow-primary/20 active:scale-[0.98] transition-transform"
                  data-testid="button-submit"
                >
                  Get Video
                </Button>
              </form>
            </Form>
          )}

          {/* Checking Formats Loading State */}
          {listVideoFormats.isPending && (
            <div className="py-12 flex flex-col items-center justify-center space-y-6 animate-in fade-in zoom-in duration-300">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full animate-pulse" />
                <Loader2 size={48} className="text-primary animate-spin relative z-10" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-xl font-bold text-foreground">Checking Post</h3>
                <p className="text-muted-foreground font-medium">Looking up available video qualities...</p>
              </div>
            </div>
          )}

          {/* Quality Picker State */}
          {showFormatPicker && (
            <div className="space-y-5 animate-in slide-in-from-bottom-4 fade-in duration-500" data-testid="format-picker-container">
              {formatsResult.thumbnailUrl && (
                <div className="aspect-video bg-black rounded-2xl overflow-hidden relative shadow-inner">
                  <img
                    src={formatsResult.thumbnailUrl}
                    alt="Video thumbnail"
                    className="w-full h-full object-cover opacity-80"
                    data-testid="img-format-thumbnail"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
                  <div className="absolute bottom-0 left-0 right-0 p-4 space-y-1 pointer-events-none">
                    <h3 className="text-white font-bold text-base line-clamp-2 leading-tight" data-testid="text-format-title">
                      {formatsResult.title || "Untitled Post"}
                    </h3>
                    {formatsResult.durationSeconds != null && (
                      <span className="inline-block bg-white/20 px-2 py-1 rounded-md backdrop-blur-sm text-white/80 text-xs font-medium">
                        {formatDuration(formatsResult.durationSeconds)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center gap-2 text-foreground font-bold">
                  <Gauge size={18} />
                  <span>Choose a quality</span>
                </div>

                {isDownloadError && (
                  <Alert variant="destructive" className="rounded-xl border-2" data-testid="alert-download-error">
                    <AlertCircle className="h-5 w-5" />
                    <AlertTitle className="text-base font-bold">Oops!</AlertTitle>
                    <AlertDescription className="text-sm font-medium mt-1">
                      {downloadErrorMessage}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {formatsResult.formats.map((format) => (
                    <button
                      key={format.formatId}
                      type="button"
                      onClick={() => chooseFormat(format)}
                      className="flex flex-col items-center justify-center gap-1 h-20 rounded-2xl border-2 border-border bg-secondary/30 hover:border-primary hover:bg-primary/10 active:scale-[0.97] transition-all font-bold text-foreground"
                      data-testid={`button-format-${format.formatId}`}
                    >
                      <span className="text-lg">{format.label}</span>
                      {format.fileSizeBytes != null && (
                        <span className="text-xs font-medium text-muted-foreground">
                          {formatBytes(format.fileSizeBytes)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <Button
                type="button"
                variant="secondary"
                onClick={resetForm}
                className="w-full h-14 text-base font-bold rounded-2xl active:scale-[0.98] transition-transform"
                data-testid="button-reset-from-formats"
              >
                <RefreshCw size={18} className="mr-2" />
                Try another link
              </Button>
            </div>
          )}

          {/* Downloading Selected Quality Loading State */}
          {createVideoDownload.isPending && (
            <div className="py-12 flex flex-col items-center justify-center space-y-6 animate-in fade-in zoom-in duration-300">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full animate-pulse" />
                <Loader2 size={48} className="text-primary animate-spin relative z-10" />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-xl font-bold text-foreground">Extracting Magic</h3>
                <p className="text-muted-foreground font-medium" data-testid="text-download-status">
                  {retryNotice ?? `Fetching ${selectedLabel ?? "your selected quality"}...`}
                </p>
              </div>
            </div>
          )}

          {/* Success State */}
          {videoResult && (
            <div className="space-y-6 animate-in slide-in-from-bottom-4 fade-in duration-500" data-testid="result-container">
              
              <div className="aspect-video bg-black rounded-2xl overflow-hidden relative shadow-inner group">
                {videoResult.thumbnailUrl ? (
                  <img 
                    src={videoResult.thumbnailUrl} 
                    alt="Video thumbnail" 
                    className="w-full h-full object-cover opacity-80"
                    data-testid="img-thumbnail"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-secondary">
                    <PlayCircle size={64} className="text-muted-foreground/50" />
                  </div>
                )}
                
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
                
                <div className="absolute bottom-0 left-0 right-0 p-4 sm:p-6 space-y-2 pointer-events-none">
                  <h3 className="text-white font-bold text-lg sm:text-xl line-clamp-2 leading-tight" data-testid="text-video-title">
                    {videoResult.title || "Untitled Post"}
                  </h3>
                  
                  <div className="flex items-center gap-3 text-white/80 text-sm font-medium">
                    {videoResult.durationSeconds != null && (
                      <span className="bg-white/20 px-2 py-1 rounded-md backdrop-blur-sm" data-testid="text-duration">
                        {formatDuration(videoResult.durationSeconds)}
                      </span>
                    )}
                    {videoResult.fileSizeBytes != null && (
                      <span className="bg-white/20 px-2 py-1 rounded-md backdrop-blur-sm" data-testid="text-size">
                        {formatBytes(videoResult.fileSizeBytes)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <a 
                  href={getDownloadHref(videoResult.downloadUrl)} 
                  className="flex-1 inline-flex items-center justify-center gap-2 h-16 bg-primary text-primary-foreground text-xl font-bold rounded-2xl shadow-lg shadow-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
                  data-testid="link-download"
                >
                  <Download size={24} strokeWidth={2.5} />
                  Save to Device
                </a>
                <Button 
                  type="button"
                  variant="secondary" 
                  onClick={resetForm}
                  className="h-16 px-6 text-lg font-bold rounded-2xl sm:flex-none active:scale-[0.98] transition-transform"
                  data-testid="button-reset"
                >
                  <RefreshCw size={20} className="mr-2" />
                  New
                </Button>
              </div>
              
              <p className="text-center text-sm text-muted-foreground font-medium px-4">
                On iPhone? The video will be saved directly to your Downloads folder.
              </p>
            </div>
          )}
        </div>
        
        {/* Footer info */}
        <div className="text-center text-sm font-medium text-muted-foreground/60">
          Downloads are processed server-side. No weird popups.
        </div>
      </div>
    </div>
  );
}
