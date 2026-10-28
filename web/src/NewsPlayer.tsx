import { useEffect, useRef, useState } from "react";
import type { DebriefNews, GeneratedScenario, NewsClipResponse, NewsTimelinePart } from "@hot-seat/shared";

export function partAtTime(timeline: readonly NewsTimelinePart[], ms: number): NewsTimelinePart | null {
  return timeline.find((p) => ms >= p.startMs && ms < p.endMs) ?? timeline[timeline.length - 1] ?? null;
}

export function totalDurationMs(timeline: readonly NewsTimelinePart[]): number {
  return timeline.length ? timeline[timeline.length - 1]!.endMs : 0;
}

const W = 1280;
const H = 720;

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  zoom: number,
  fallbackLabel: string,
) {
  ctx.fillStyle = "#101418";
  ctx.fillRect(0, 0, W, H);
  if (!img || !img.complete || img.naturalWidth === 0) {
    ctx.fillStyle = "#1d2733";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f2f0eb";
    ctx.font = "700 44px Archivo, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fallbackLabel, W / 2, H / 2);
    return;
  }
  const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight) * zoom;
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

export function NewsPlayer({
  sessionId,
  news,
  scenario,
  fallbackStillUrl,
}: {
  sessionId: string;
  news: DebriefNews;
  scenario: GeneratedScenario;
  fallbackStillUrl: string | null;
}) {
  const [clip, setClip] = useState<NewsClipResponse | null>(null);
  const [building, setBuilding] = useState(true);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const studioImgRef = useRef<HTMLImageElement | null>(null);
  const ownerImgRef = useRef<HTMLImageElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const startedAtRef = useRef<number>(performance.now());

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch(`/api/sessions/${sessionId}/news-clip`)
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 202) return;
          if (!res.ok) {
            setBuilding(false);
            setFailed(true);
            return;
          }
          const data = (await res.json()) as NewsClipResponse;
          if (cancelled) return;
          setClip(data);
          setBuilding(false);
        })
        .catch(() => {
          if (!cancelled) {
            setBuilding(false);
            setFailed(true);
          }
        });
    };
    poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!clip) return;
    const load = (url: string | null, ref: React.RefObject<HTMLImageElement | null>) => {
      if (!url) {
        ref.current = null;
        return;
      }
      const img = new Image();
      img.src = url;
      ref.current = img;
    };
    load(clip.studioImageUrl, studioImgRef);
    load(clip.ownerStillUrl ?? fallbackStillUrl, ownerImgRef);
  }, [clip, fallbackStillUrl]);

  useEffect(() => {
    if (!clip) return;
    let raf = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const audio = audioRef.current;
        const ms = audio ? audio.currentTime * 1000 : 0;
        const part = partAtTime(clip.timeline, ms);
        const partProgress = part
          ? Math.min(1, Math.max(0, (ms - part.startMs) / Math.max(1, part.endMs - part.startMs)))
          : 0;
        const zoom = reduced ? 1 : 1 + partProgress * 0.08;
        const isSoundbite = part?.part === "soundbite";
        drawCover(
          ctx,
          isSoundbite ? ownerImgRef.current : studioImgRef.current,
          zoom,
          isSoundbite ? scenario.company.name : clip.channel,
        );
        // Channel bug
        ctx.fillStyle = "rgba(8,10,12,0.78)";
        ctx.fillRect(W - 330, 24, 306, 46);
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 22px Archivo, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(clip.channel.toUpperCase(), W - 40, 55);
        ctx.textAlign = "left";
        if (isSoundbite) {
          // Lower third: owner role and company, plus the soundbite subtitle.
          ctx.fillStyle = "rgba(8,10,12,0.82)";
          ctx.fillRect(48, H - 190, 760, 92);
          ctx.fillStyle = "#ffffff";
          ctx.font = "800 30px Archivo, sans-serif";
          ctx.fillText(scenario.spokesperson_role, 72, H - 148);
          ctx.font = "400 24px 'Public Sans', sans-serif";
          ctx.fillText(scenario.company.name, 72, H - 114);
          ctx.font = "700 30px 'Public Sans', sans-serif";
          const lines = wrapText(ctx, `"${news.soundbite}"`, W - 160);
          lines.slice(0, 2).forEach((line, i) => {
            const y = H - 250 - (lines.length - 1 - i) * 38;
            const width = ctx.measureText(line).width;
            ctx.fillStyle = "rgba(8,10,12,0.72)";
            ctx.fillRect(64, y - 32, width + 28, 44);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(line, 78, y);
          });
        } else {
          ctx.fillStyle = "rgba(8,10,12,0.82)";
          ctx.fillRect(48, H - 150, 840, 56);
          ctx.fillStyle = "#ffffff";
          ctx.font = "800 26px Archivo, sans-serif";
          ctx.fillText(clip.chyron, 72, H - 112);
        }
        // Ticker
        ctx.fillStyle = "#b3202c";
        ctx.fillRect(0, H - 52, W, 52);
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 22px 'Public Sans', sans-serif";
        const tickerText = `${clip.ticker.join("   •   ")}   •   `;
        const speedMs = audio && !audio.paused ? ms : performance.now() - startedAtRef.current;
        const offset = (speedMs / 18) % Math.max(1, ctx.measureText(tickerText).width);
        ctx.fillText(tickerText, -offset, H - 18);
        ctx.fillText(tickerText, -offset + ctx.measureText(tickerText).width, H - 18);
      }
      raf = window.requestAnimationFrame(draw);
    };
    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [clip, news.soundbite, scenario.company.name, scenario.spokesperson_role]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const saveClip = async () => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio || recording) return;
    try {
      setRecording(true);
      audioCtxRef.current ??= new AudioContext();
      const ctx = audioCtxRef.current;
      await ctx.resume();
      if (!mediaSourceRef.current) {
        mediaSourceRef.current = ctx.createMediaElementSource(audio);
        mediaSourceRef.current.connect(ctx.destination);
      }
      const dest = ctx.createMediaStreamDestination();
      mediaSourceRef.current.connect(dest);
      const stream = new MediaStream([
        ...canvas.captureStream(30).getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      audio.currentTime = 0;
      recorder.start();
      await audio.play();
      setPlaying(true);
      await new Promise<void>((resolve) => {
        const onEnded = () => resolve();
        audio.addEventListener("ended", onEnded, { once: true });
      });
      recorder.stop();
      await stopped;
      mediaSourceRef.current.disconnect(dest);
      const blob = new Blob(chunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "evening-news.webm";
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      /* recording unsupported: playback still works */
    } finally {
      setPlaying(false);
      setRecording(false);
    }
  };

  if (building) {
    return (
      <section className="news-player" aria-label="Evening news">
        <h2>Evening news</h2>
        <p className="muted">Cutting tonight&apos;s news.</p>
        <p className="muted">Your recording is used only for this clip and is not kept.</p>
      </section>
    );
  }
  if (failed || !clip) {
    return (
      <section className="news-player" aria-label="Evening news">
        <h2>Evening news</h2>
        <p className="muted">Tonight&apos;s news could not be cut this time.</p>
        <p className="muted">Your recording is used only for this clip and is not kept.</p>
      </section>
    );
  }
  return (
    <section className="news-player" aria-label="Evening news">
      <h2>Evening news</h2>
      <div className="news-frame">
        <canvas ref={canvasRef} width={W} height={H} className="news-canvas" />
      </div>
      <audio
        ref={audioRef}
        src={clip.audioUrl}
        preload="auto"
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
      />
      <p>
        <button className="primary" type="button" onClick={togglePlay}>
          {playing ? "Pause" : "Play"}
        </button>{" "}
        <button className="linklike" type="button" onClick={() => void saveClip()} disabled={recording}>
          {recording ? "Recording." : "Save clip"}
        </button>
      </p>
      {!clip.soundbiteLocated && (
        <p className="muted">Your words are read by the anchor in this one.</p>
      )}
      <p className="muted">Your recording is used only for this clip and is not kept.</p>
    </section>
  );
}
