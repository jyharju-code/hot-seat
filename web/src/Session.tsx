import { useEffect, useRef, useState } from "react";
import type { ReporterLine, ServerMessage, SessionState, TurnTiming } from "@hot-seat/shared";
import { serverMessageSchema } from "@hot-seat/shared";

interface Entry { role: "user" | "reporter"; text: string; timing?: TurnTiming }
const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function Session({ onEnd }: { onEnd: () => void }) {
  const [live, setLive] = useState(false);
  const [state, setState] = useState<SessionState | null>(null);
  const [question, setQuestion] = useState("");
  const [lastAnswer, setLastAnswer] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<SessionState | null>(null);
  const playingRef = useRef(false);
  const playCtxRef = useRef<AudioContext | null>(null);
  const nextTimeRef = useRef(0);
  const endTimerRef = useRef<number | undefined>(undefined);
  const cleanupRef = useRef<(() => void) | null>(null);

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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        locals.push(() => stream.getTracks().forEach((t) => t.stop()));
        const micCtx = new AudioContext();
        locals.push(() => void micCtx.close().catch(() => undefined));
        await micCtx.audioWorklet.addModule("/mic-worklet.js");
        const source = micCtx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(micCtx, "mic-downsampler");
        source.connect(node);
        const playCtx = new AudioContext({ sampleRate: 24000 });
        playCtxRef.current = playCtx;
        locals.push(() => void playCtx.close().catch(() => undefined));
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${location.host}/ws`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;
        locals.push(() => ws.close());
        node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
          if (ws.readyState === WebSocket.OPEN && stateRef.current === "listening" && !playingRef.current) ws.send(ev.data);
        };
        ws.onopen = () => { if (!cancelled) { setLive(true); ws.send(JSON.stringify({ type: "start" })); } };
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
    const ctx = playCtxRef.current; if (!ctx) return;
    playingRef.current = true;
    const pcm = new Int16Array(data);
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i] ?? 0) / 32768;
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    const start = Math.max(nextTimeRef.current, ctx.currentTime);
    src.start(start); nextTimeRef.current = start + buf.duration;
  }
  function handleMessage(msg: ServerMessage) {
    if (msg.type === "state") setState(msg.state);
    else if (msg.type === "transcript") {
      if (msg.role === "user") setLastAnswer(msg.text);
      setEntries((e) => [...e, { role: msg.role, text: msg.text }]);
    } else if (msg.type === "reporter_line") {
      const line: ReporterLine = msg.line; setQuestion(line.say);
    } else if (msg.type === "audio_end") {
      const ctx = playCtxRef.current;
      const wait = ctx ? Math.max(0, (nextTimeRef.current - ctx.currentTime) * 1000) : 0;
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = window.setTimeout(() => { playingRef.current = false; nextTimeRef.current = 0; }, wait + 50);
    } else if (msg.type === "timing") {
      setEntries((e) => { const c = [...e]; for (let i = c.length - 1; i >= 0; i--) { if (c[i]?.role === "reporter") { c[i] = { ...c[i]!, timing: msg.timing }; break; } } return c; });
    } else if (msg.type === "error") setError(msg.message);
  }
  function end() {
    try { wsRef.current?.send(JSON.stringify({ type: "stop" })); } catch { /* closed */ }
    cleanupRef.current?.(); setLive(false); onEnd();
  }
  const statusText = state === "thinking" ? "Thinking." : state === "speaking" ? "Speaking." : state === "listening" ? "Listening." : "Connecting.";
  return (
    <main>
      <h1 className="status-headline">{live ? <>Live. <span className="live-dot" aria-label="live" /></> : "Ready."} <span className="clock">{fmtClock(elapsed)}</span></h1>
      <p className="muted">{live ? statusText : "Starting microphone."}</p>
      {error && <p className="error">{error}</p>}
      <div className="qa">
        <section><h2>Reporter</h2><p className="headline-q">{question || "The reporter is preparing the first question."}</p></section>
        <section><h2>You</h2><p>{lastAnswer || "Your last answer will appear here."}</p></section>
      </div>
      <section className="paper transcript" aria-label="Transcript"><h2>Transcript</h2>
        {entries.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul>{entries.map((e, i) => (<li key={i} className="t-entry"><span><strong>{e.role === "reporter" ? "Reporter: " : "You: "}</strong>{e.text}{e.timing && <span className="timing">{` ${(e.timing.totalToFirstAudioMs / 1000).toFixed(1)} s to voice`}</span>}</span></li>))}</ul>
      </section>
      <p><button className="primary" type="button" onClick={end}>End</button></p>
    </main>
  );
}
