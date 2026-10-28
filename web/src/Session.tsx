import { useEffect, useRef, useState } from "react";
import type { ReporterLine, ServerMessage, SessionState, TurnTiming } from "@hot-seat/shared";
import { serverMessageSchema, stripAudioTags } from "@hot-seat/shared";
import { PcmPlayer } from "./audio/pcm-player.js";

interface Entry { role: "user" | "reporter" | "news"; text: string; timing?: TurnTiming }
const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export interface CameraStill {
  base64: string;
  mime: string;
}

export function Session({
  scenarioId,
  onEnd,
}: {
  scenarioId: string;
  onEnd: (still: CameraStill | null) => void;
}) {
  const [live, setLive] = useState(false);
  const [state, setState] = useState<SessionState | null>(null);
  const [question, setQuestion] = useState("");
  const [lastAnswer, setLastAnswer] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [newsFlash, setNewsFlash] = useState("");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<SessionState | null>(null);
  const playingRef = useRef(false);
  const playCtxRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const endTimerRef = useRef<number | undefined>(undefined);
  const cleanupRef = useRef<(() => void) | null>(null);
  const stillRef = useRef<CameraStill | null>(null);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  useEffect(() => {
    let cancelled = false;
    const locals: Array<() => void> = [];
    cleanupRef.current = () => locals.forEach((f) => f());
    void (async () => {
      try {
        // Ask for camera together with the mic. Nothing of the video is
        // shown; one still is grabbed about 20 s in and kept in memory.
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: { width: 1280 },
          });
        } catch {
          // Camera denied (or absent): continue with the mic alone.
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        }
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        locals.push(() => stream.getTracks().forEach((t) => t.stop()));
        if (stream.getVideoTracks().length > 0) {
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.srcObject = stream;
          void video.play().catch(() => undefined);
          const stillTimer = window.setTimeout(() => {
            try {
              const width = video.videoWidth || 1280;
              const height = video.videoHeight || Math.round((width * 3) / 4);
              if (!width || !height) return;
              const canvas = document.createElement("canvas");
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext("2d");
              if (!ctx) return;
              ctx.drawImage(video, 0, 0, width, height);
              canvas.toBlob(
                (blob) => {
                  if (!blob) return;
                  void blob.arrayBuffer().then((buf) => {
                    let binary = "";
                    const bytes = new Uint8Array(buf);
                    for (let i = 0; i < bytes.length; i += 0x8000) {
                      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                    }
                    stillRef.current = { base64: btoa(binary), mime: "image/jpeg" };
                  });
                },
                "image/jpeg",
                0.85,
              );
            } catch {
              /* no still: the session continues without it */
            }
          }, 20_000);
          locals.push(() => window.clearTimeout(stillTimer));
        }
        const micCtx = new AudioContext();
        locals.push(() => void micCtx.close().catch(() => undefined));
        await micCtx.audioWorklet.addModule("/mic-worklet.js");
        const source = micCtx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(micCtx, "mic-downsampler");
        source.connect(node);
        const playCtx = new AudioContext({ sampleRate: 24000 });
        playCtxRef.current = playCtx;
        playerRef.current = new PcmPlayer(playCtx);
        locals.push(() => void playCtx.close().catch(() => undefined));
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${location.host}/ws`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;
        locals.push(() => ws.close());
        node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
          // Capture runs continuously; the server only opens STT after
          // playback_done, so "listening" already means really listening.
          if (ws.readyState === WebSocket.OPEN && stateRef.current === "listening") ws.send(ev.data);
        };
        ws.onopen = () => { if (!cancelled) { setLive(true); ws.send(JSON.stringify({ type: "start", scenarioId })); } };
        ws.onmessage = (ev: MessageEvent) => {
          if (ev.data instanceof ArrayBuffer) { playPcm(ev.data); return; }
          const parsed = serverMessageSchema.safeParse(JSON.parse(String(ev.data)) as unknown);
          if (!parsed.success) return;
          handleMessage(parsed.data);
        };
        ws.onerror = () => { if (!cancelled) setError("Connection to the server failed."); };
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Microphone unavailable.");
      }
    })();
    return () => { cancelled = true; locals.forEach((f) => f()); };
  }, []);

  function playPcm(data: ArrayBuffer) {
    if (!playerRef.current) return;
    playingRef.current = true;
    playerRef.current.push(data);
  }
  function handleMessage(msg: ServerMessage) {
    if (msg.type === "interrupt") {
      // Stop sending mic audio (state is no longer listening) and play the cut-in.
      setState("speaking");
      stateRef.current = "speaking";
      playerRef.current?.beginLine();
      setQuestion(stripAudioTags(msg.say));
    }
    else if (msg.type === "state") setState(msg.state);
    else if (msg.type === "news_flash") {
      setNewsFlash(msg.text);
      setEntries((e) => [...e, { role: "news", text: msg.text }]);
    }
    else if (msg.type === "transcript") {
      const display = stripAudioTags(msg.text);
      if (msg.role === "user") setLastAnswer(display);
      setEntries((e) => [...e, { role: msg.role, text: display }]);
    } else if (msg.type === "reporter_line") {
      playerRef.current?.beginLine();
      const line: ReporterLine = msg.line; setQuestion(stripAudioTags(line.say));
    } else if (msg.type === "audio_end") {
      const wait = playerRef.current ? playerRef.current.millisecondsUntilEnd() : 0;
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = window.setTimeout(() => {
        playingRef.current = false;
        playerRef.current?.reset();
        // Reporter audio has really finished playing: server may open STT now.
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "playback_done" }));
      }, wait + 50);
    } else if (msg.type === "timing") {
      setEntries((e) => { const c = [...e]; for (let i = c.length - 1; i >= 0; i--) { if (c[i]?.role === "reporter") { c[i] = { ...c[i]!, timing: msg.timing }; break; } } return c; });
    } else if (msg.type === "error") setError(msg.message);
  }
  function end() {
    try { wsRef.current?.send(JSON.stringify({ type: "stop" })); } catch { /* closed */ }
    const still = stillRef.current;
    cleanupRef.current?.(); setLive(false); onEnd(still);
  }
  const statusText = state === "thinking" ? "Thinking." : state === "speaking" ? "Speaking." : state === "listening" ? "Listening." : "Connecting.";
  return (
    <main>
      {newsFlash && <p className="news-flash"><strong>NEW</strong> {newsFlash}</p>}
      <h1 className="status-headline">{live ? <>Live. <span className="live-dot" aria-label="live" /></> : "Ready."} <span className="clock">{fmtClock(elapsed)}</span></h1>
      <p className="muted">{live ? statusText : "Starting microphone."}</p>
      {error && <p className="error">{error}</p>}
      <div className="qa">
        <section><h2>Reporter</h2><p className="headline-q">{question || "The reporter is preparing the first question."}</p></section>
        <section><h2>You</h2><p>{lastAnswer || "Your last answer will appear here."}</p></section>
      </div>
      <section className="paper transcript" aria-label="Transcript"><h2>Transcript</h2>
        {entries.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul>{entries.map((e, i) => (<li key={i} className="t-entry"><span><strong>{e.role === "reporter" ? "Reporter: " : e.role === "news" ? "News: " : "You: "}</strong>{e.text}{e.timing && <span className="timing">{` ${(e.timing.totalToFirstAudioMs / 1000).toFixed(1)} s to voice`}</span>}</span></li>))}</ul>
      </section>
      <p><button className="primary" type="button" onClick={end}>End</button></p>
    </main>
  );
}
