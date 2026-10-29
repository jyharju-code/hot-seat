import WebSocket from "ws";
import { isWrapUpLine, type GeneratedScenario, type ServerMessage } from "@hot-seat/shared";
import type { OwnerAgent } from "./owner.js";
import { estimateTtsChars } from "./owner.js";
import { detectSplit, isRepeat, stripCutOff, wordCount, wordErrorRate } from "./metrics.js";
import { FRAME_BYTES, pcmDurationMs } from "./pacing.js";
import { ReporterLineQueue, linePlaybackMs } from "./reporter-queue.js";
import { synthesizeAnswer } from "./voice.js";
import type { TextToSpeech } from "../../src/providers/text-to-speech.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Browser mode has no binary audio: speech starts when the reporter_line
 *  arrives, plus the client-reported speechStartMs delay. */
export function browserFirstAudioAt(arrivalMs: number, speechStartMs?: number | null): number {
  return arrivalMs + Math.max(0, speechStartMs ?? 0);
}

/** A session_complete ending is a normal end: it satisfies waits for a listening state. */
export function listeningWaitSatisfied(lastState: string | null, ended: boolean): boolean {
  return ended || lastState === "listening";
}

export interface TurnMetric {
  turn: number;
  latency_ms: number | null;
  split: boolean;
  wer: number | null;
  interrupted: boolean;
  errors: number;
  reporter_words: number;
  repeat: boolean;
  spoken_text: string;
  transcript_text: string;
  reporter_text: string;
}

export interface TranscriptLine {
  role: string;
  text: string;
}

export interface DebriefOutcome {
  /** Debrief POST time (kept as `ms` for older report readers). */
  ms: number;
  debrief_ms: number;
  front_page_ms: number | null;
  front_page: boolean;
  headline: string | null;
  news_clip_ms?: number | null;
  news_clip?: boolean;
  soundbite_located?: boolean | null;
}

export interface NewsClipPollResult {
  ms: number;
  news_clip: boolean;
  soundbite_located: boolean | null;
}

/** Poll the news-clip endpoint: 202 means building (wait 1 s), max 90 s. */
export async function pollNewsClip(
  httpBase: string,
  sessionId: string,
  opts: { fetchFn?: typeof fetch; intervalMs?: number; maxWaitMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<NewsClipPollResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const intervalMs = opts.intervalMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const sleepFn = opts.sleepFn ?? sleep;
  const started = performance.now();
  for (;;) {
    const res = await fetchFn(`${httpBase}/api/sessions/${sessionId}/news-clip`);
    const elapsed = Math.round(performance.now() - started);
    if (res.status === 202) {
      if (elapsed >= maxWaitMs) return { ms: elapsed, news_clip: false, soundbite_located: null };
      await sleepFn(Math.min(intervalMs, Math.max(0, maxWaitMs - elapsed)));
      continue;
    }
    if (!res.ok) return { ms: elapsed, news_clip: false, soundbite_located: null };
    const body = (await res.json()) as { soundbiteLocated?: boolean };
    return { ms: elapsed, news_clip: true, soundbite_located: body.soundbiteLocated ?? null };
  }
}

export interface FrontPagePollResult {
  ms: number;
  front_page: boolean;
}

/** Poll the front-page endpoint: 202 means printing (wait 1 s), max 90 s. */
export async function pollFrontPage(
  httpBase: string,
  sessionId: string,
  opts: { fetchFn?: typeof fetch; intervalMs?: number; maxWaitMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<FrontPagePollResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const intervalMs = opts.intervalMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const sleepFn = opts.sleepFn ?? sleep;
  const started = performance.now();
  for (;;) {
    const res = await fetchFn(`${httpBase}/api/sessions/${sessionId}/front-page`);
    const elapsed = Math.round(performance.now() - started);
    if (res.status === 202) {
      if (elapsed >= maxWaitMs) return { ms: elapsed, front_page: false };
      await sleepFn(Math.min(intervalMs, Math.max(0, maxWaitMs - elapsed)));
      continue;
    }
    if (!res.ok) return { ms: elapsed, front_page: false };
    const body = (await res.json()) as { frontPage?: unknown };
    return { ms: elapsed, front_page: body.frontPage != null };
  }
}

export interface SessionResult {
  profile: string;
  preset: string;
  session_id: string | null;
  turns: TurnMetric[];
  transcript: TranscriptLine[];
  errors: number;
  failure: string | null;
  debrief: DebriefOutcome | null;
  mode?: "hot_seat" | "profile";
  session_complete?: boolean;
  wrap_up_spoken?: boolean;
}

export interface SimSessionOptions {
  wsUrl: string;
  httpBase: string;
  presetId: string;
  presetDescription: string;
  profileName: string;
  profileText: string;
  turns: number;
  mode?: "hot_seat" | "profile";
  durationMinutes?: 5 | 10;
  owner: OwnerAgent;
  tts: TextToSpeech;
  voiceId: string;
  /** Shared live TTS character budget. Throws when the cap is exceeded. */
  chargeChars: (chars: number) => void;
  debrief: boolean;
  log?: (line: string) => void;
}

interface LiveState {
  sessionId: string | null;
  lastState: string | null;
  interrupted: boolean;
  ended: boolean;
  errorCount: number;
  reporterQueue: ReporterLineQueue;
  firstAudioAt: number | null;
  awaitingFirstAudio: boolean;
  transcript: TranscriptLine[];
  userTranscripts: Array<{ text: string; atMs: number }>;
  lastReporterText: string;
  sessionComplete: boolean;
  wrapUpSpoken: boolean;
  speechStartMs: number | null;
}

const freshState = (): LiveState => ({
  sessionId: null,
  lastState: null,
  interrupted: false,
  ended: false,
  errorCount: 0,
  reporterQueue: new ReporterLineQueue(),
  firstAudioAt: null,
  awaitingFirstAudio: false,
  transcript: [],
  userTranscripts: [],
  lastReporterText: "",
  sessionComplete: false,
  wrapUpSpoken: false,
  speechStartMs: null,
});

/** One synthetic-owner session against a running server, paced like a browser. */
export class SimSession {
  private readonly state = freshState();
  private ws: WebSocket | null = null;
  private ownerSpeaking = false;
  private micStopped = false;

  constructor(private readonly opts: SimSessionOptions) {}

  private log(line: string): void {
    this.opts.log?.(`[${this.opts.profileName}] ${line}`);
  }

  private async waitFor(cond: () => boolean, label: string, timeoutMs = 120_000): Promise<void> {
    const started = performance.now();
    while (!cond()) {
      if (performance.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
      await sleep(10);
    }
  }

  async run(): Promise<SessionResult> {
    const result: SessionResult = {
      profile: this.opts.profileName,
      preset: this.opts.presetId,
      session_id: null,
      turns: [],
      transcript: this.state.transcript,
      errors: 0,
      failure: null,
      debrief: null,
      mode: this.opts.mode ?? "hot_seat",
      session_complete: false,
      wrap_up_spoken: false,
    };
    try {
      const scenario = await this.createScenario();
      await this.connect(scenario.id);
      this.startMicLoop();
      result.session_id = this.state.sessionId;
      let previousReporter = "";
      for (let turn = 0; turn < this.opts.turns; turn++) {
        const metric = await this.playTurn(turn, scenario.scenario, previousReporter);
        result.turns.push(metric);
        previousReporter = metric.reporter_text || previousReporter;
        if (this.state.ended) break;
      }
      if (this.opts.debrief && this.state.sessionId) {
        result.debrief = await this.endAndDebrief(this.state.sessionId);
      } else {
        this.sendStop();
      }
    } catch (err) {
      result.failure = err instanceof Error ? err.message : String(err);
      this.sendStop();
    } finally {
      this.micStopped = true;
      result.session_complete = this.state.sessionComplete;
      result.wrap_up_spoken = this.state.wrapUpSpoken;
      result.errors = this.state.errorCount;
      try {
        this.ws?.close();
      } catch {
        /* already closed */
      }
    }
    return result;
  }

  private async createScenario(): Promise<{ id: string; scenario: GeneratedScenario }> {
    const res = await fetch(`${this.opts.httpBase}/api/scenarios`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: this.opts.presetDescription, language: "en", mode: this.opts.mode ?? "hot_seat", duration_minutes: this.opts.durationMinutes ?? 5 }),
    });
    if (!res.ok) throw new Error(`scenario creation failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as { id: string; scenario: GeneratedScenario };
  }

  private async connect(scenarioId: string): Promise<void> {
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.state.reporterQueue.noteAudio(data.length);
        if (this.state.awaitingFirstAudio && this.state.firstAudioAt === null) {
          this.state.firstAudioAt = performance.now();
          this.state.awaitingFirstAudio = false;
        }
        return;
      }
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "session_started") this.state.sessionId = msg.sessionId;
      else if (msg.type === "state") this.state.lastState = msg.state;
      else if (msg.type === "audio_end") this.state.reporterQueue.noteAudioEnd();
      else if (msg.type === "reporter_line") {
        if (isWrapUpLine(msg.line.say)) this.state.wrapUpSpoken = true;
        // Browser mode: no binary audio. Speech starts when this line
        // arrives (plus the client-reported speechStartMs, 0 in the sim).
        if (msg.voiceHint && this.state.awaitingFirstAudio && this.state.firstAudioAt === null) {
          this.state.firstAudioAt = browserFirstAudioAt(performance.now(), this.state.speechStartMs);
          this.state.awaitingFirstAudio = false;
        }
      }
      else if (msg.type === "interrupt") this.state.interrupted = true;
      else if (msg.type === "ended") this.state.ended = true;
      else if (msg.type === "session_complete") { this.state.ended = true; this.state.sessionComplete = true; }
      else if (msg.type === "error") {
        this.state.errorCount += 1;
        this.log(`server error: ${msg.message}`);
      } else if (msg.type === "transcript") {
        this.state.transcript.push({ role: msg.role, text: msg.text });
        if (msg.role === "user") this.state.userTranscripts.push({ text: msg.text, atMs: performance.now() });
        if (msg.role === "reporter") {
          this.state.lastReporterText = msg.text;
          if (isWrapUpLine(msg.text)) this.state.wrapUpSpoken = true;
          this.state.reporterQueue.noteText(msg.text);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "start", scenarioId }));
    await this.waitFor(() => this.state.sessionId !== null, "session_started", 30_000);
  }

  /** Like a real mic: silence frames at real-time pace whenever the server
   *  is listening and the owner is not speaking, including while the owner
   *  agent writes and voices its answer. */
  private startMicLoop(): void {
    const silence = new Uint8Array(FRAME_BYTES);
    void (async () => {
      let nextAt = performance.now();
      while (!this.micStopped) {
        if (this.state.lastState === "listening" && !this.ownerSpeaking && this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(silence);
          } catch {
            /* socket gone */
          }
        }
        nextAt += 100;
        const wait = nextAt - performance.now();
        if (wait > 0) await sleep(wait);
        else nextAt = performance.now();
      }
    })();
  }

  /** Wait out one reporter line (real playback), answer it, measure the reply. */
  private async playTurn(turn: number, scenario: GeneratedScenario, previousReporter: string): Promise<TurnMetric> {
    const errorsAtStart = this.state.errorCount;
    // 1) Consume exactly one reporter line (the opening question or the
    // previous reply/cut-in) and sit through its real playback duration.
    await this.waitFor(() => this.state.reporterQueue.hasEndedLine(), "reporter audio_end");
    const line = this.state.reporterQueue.consume()!;
    const playbackMs = linePlaybackMs(line);
    const reporterText = line.text;
    // 2) Generate the owner's answer during playback, before playback_done,
    // so listening is not left silent while the agent writes and voices it.
    // The mic loop streams silence from the moment listening starts until
    // the answer is ready and speaking begins.
    const answerPromise = (async () => {
      const segments = await this.opts.owner.nextAnswer({
        profile: this.opts.profileText,
        briefing: scenario.briefing_for_user,
        conversation: [...this.state.transcript],
        reporterLine: reporterText,
      });
      this.opts.chargeChars(estimateTtsChars(segments));
      const voiced = await synthesizeAnswer(this.opts.tts, segments, this.opts.voiceId);
      return { segments, voiced };
    })();
    void answerPromise.catch(() => undefined);
    if (line.audioBytes === 0) this.ws?.send(JSON.stringify({ type: "speech_started", speechStartMs: 0 }));
    await sleep(playbackMs);
    this.ws?.send(JSON.stringify({ type: "playback_done" }));
    await this.waitFor(() => listeningWaitSatisfied(this.state.lastState, this.state.ended), "listening state");
    if (this.state.ended) {
      // session_complete: a normal end. Return so the run loop breaks and the debrief still runs.
      return {
        turn: turn + 1, latency_ms: null, split: false, wer: null, interrupted: false,
        errors: this.state.errorCount - errorsAtStart, reporter_words: wordCount(reporterText),
        repeat: previousReporter ? isRepeat(previousReporter, reporterText) : false,
        spoken_text: "", transcript_text: "", reporter_text: reporterText,
      };
    }
    const { segments, voiced } = await answerPromise;
    const spokenText = segments.map((s) => s.text).join(" ");
    this.log(`turn ${turn + 1}: speaking ${(pcmDurationMs(voiced.pcm.length) / 1000).toFixed(1)}s: ${spokenText.slice(0, 90)}`);

    // 3) Stream mic frames at real time by absolute clock, 100 ms frames.
    this.state.interrupted = false;
    this.state.firstAudioAt = null;
    this.state.awaitingFirstAudio = true;
    this.ownerSpeaking = true;
    const transcriptsBefore = this.state.userTranscripts.length;
    const speechMs = pcmDurationMs(voiced.speechBytes);
    const t0 = performance.now();
    let frame = 0;
    const pace = async () => {
      frame += 1;
      const wait = t0 + frame * 100 - performance.now();
      if (wait > 0) await sleep(wait);
    };
    let stoppedForInterrupt = false;
    for (let off = 0; off < voiced.pcm.length; off += FRAME_BYTES) {
      if (this.state.interrupted) {
        stoppedForInterrupt = true;
        break;
      }
      this.ws?.send(new Uint8Array(voiced.pcm.subarray(off, off + FRAME_BYTES)));
      await pace();
    }
    const speechEndAt = t0 + speechMs;
    // Speaking is over: the mic loop resumes silence frames at once, which
    // is the trailing silence endpointing needs to close the turn.
    this.ownerSpeaking = false;
    if (this.state.interrupted) stoppedForInterrupt = true;

    // 4) Wait for the reporter's reply line (the cut-in, when interrupted).
    // It stays queued: the next turn consumes it. A reply that already
    // ended during the trailing silence is seen at once, not missed.
    await this.waitFor(
      () => this.state.reporterQueue.hasEndedLine() || this.state.ended,
      "reporter reply audio_end",
    );
    const interrupted = stoppedForInterrupt || this.state.interrupted;
    const turnTranscripts = this.state.userTranscripts.slice(transcriptsBefore);
    const transcriptText = stripCutOff(turnTranscripts.map((t) => t.text).join(" "));
    const nextReporter = this.state.reporterQueue.peekEnded()?.text ?? this.state.lastReporterText;
    return {
      turn: turn + 1,
      latency_ms:
        interrupted || this.state.firstAudioAt === null
          ? null
          : Math.max(0, Math.round(this.state.firstAudioAt - speechEndAt)),
      split: detectSplit({
        transcriptCount: turnTranscripts.length,
        firstTranscriptAtMs: turnTranscripts[0]?.atMs ?? null,
        speechEndMs: speechEndAt,
      }),
      wer: transcriptText ? wordErrorRate(spokenText, transcriptText) : null,
      interrupted,
      errors: this.state.errorCount - errorsAtStart,
      reporter_words: wordCount(nextReporter),
      repeat: previousReporter ? isRepeat(previousReporter, nextReporter) : false,
      spoken_text: spokenText,
      transcript_text: transcriptText,
      reporter_text: nextReporter,
    };
  }

  private sendStop(): void {
    try {
      this.ws?.send(JSON.stringify({ type: "stop" }));
    } catch {
      /* socket already gone */
    }
  }

  /** End the session the way the End button does. The debrief POST now
   *  returns before the front page exists, so poll its endpoint and
   *  report the two times separately. */
  private async endAndDebrief(sessionId: string): Promise<DebriefOutcome> {
    this.sendStop();
    await sleep(250);
    const started = performance.now();
    const res = await fetch(`${this.opts.httpBase}/api/sessions/${sessionId}/debrief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "en" }),
    });
    const debriefMs = Math.round(performance.now() - started);
    if (!res.ok) throw new Error(`debrief failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { debrief?: { front_page?: { headline?: string } }; frontPage?: unknown };
    if (body.frontPage != null) {
      const news = await pollNewsClip(this.opts.httpBase, sessionId);
      this.log(
        `news clip ${news.ms} ms (${news.news_clip ? "ready" : "missing"}, soundbite ${news.soundbite_located === null ? "unknown" : news.soundbite_located ? "located" : "not located"})`,
      );
      return {
        ms: debriefMs,
        debrief_ms: debriefMs,
        front_page_ms: 0,
        front_page: true,
        headline: body.debrief?.front_page?.headline ?? null,
        news_clip_ms: news.ms,
        news_clip: news.news_clip,
        soundbite_located: news.soundbite_located,
      };
    }
    const [polled, news] = await Promise.all([
      pollFrontPage(this.opts.httpBase, sessionId),
      pollNewsClip(this.opts.httpBase, sessionId),
    ]);
    this.log(
      `debrief ${debriefMs} ms, front page ${polled.ms} ms (${polled.front_page ? "ready" : "missing"}), news clip ${news.ms} ms (${news.news_clip ? "ready" : "missing"}, soundbite ${news.soundbite_located === null ? "unknown" : news.soundbite_located ? "located" : "not located"})`,
    );
    return {
      ms: debriefMs,
      debrief_ms: debriefMs,
      front_page_ms: polled.ms,
      front_page: polled.front_page,
      headline: body.debrief?.front_page?.headline ?? null,
      news_clip_ms: news.ms,
      news_clip: news.news_clip,
      soundbite_located: news.soundbite_located,
    };
  }
}
