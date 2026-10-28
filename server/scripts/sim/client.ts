import WebSocket from "ws";
import type { GeneratedScenario, ServerMessage } from "@hot-seat/shared";
import type { OwnerAgent } from "./owner.js";
import { estimateTtsChars } from "./owner.js";
import { detectSplit, isRepeat, stripCutOff, wordCount, wordErrorRate } from "./metrics.js";
import { FRAME_BYTES, pcmDurationMs } from "./pacing.js";
import { ReporterLineQueue, linePlaybackMs } from "./reporter-queue.js";
import { synthesizeAnswer } from "./voice.js";
import type { TextToSpeech } from "../../src/providers/text-to-speech.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  ms: number;
  front_page: boolean;
  headline: string | null;
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
}

export interface SimSessionOptions {
  wsUrl: string;
  httpBase: string;
  presetId: string;
  presetDescription: string;
  profileName: string;
  profileText: string;
  turns: number;
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
      body: JSON.stringify({ description: this.opts.presetDescription, language: "en" }),
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
      else if (msg.type === "interrupt") this.state.interrupted = true;
      else if (msg.type === "ended") this.state.ended = true;
      else if (msg.type === "error") {
        this.state.errorCount += 1;
        this.log(`server error: ${msg.message}`);
      } else if (msg.type === "transcript") {
        this.state.transcript.push({ role: msg.role, text: msg.text });
        if (msg.role === "user") this.state.userTranscripts.push({ text: msg.text, atMs: performance.now() });
        if (msg.role === "reporter") {
          this.state.lastReporterText = msg.text;
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
    await sleep(playbackMs);
    this.ws?.send(JSON.stringify({ type: "playback_done" }));
    await this.waitFor(() => this.state.lastState === "listening", "listening state");
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

  /** End the session the way the End button does, then time debrief + front page. */
  private async endAndDebrief(sessionId: string): Promise<DebriefOutcome> {
    this.sendStop();
    await sleep(250);
    const started = performance.now();
    const res = await fetch(`${this.opts.httpBase}/api/sessions/${sessionId}/debrief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "en" }),
    });
    const ms = Math.round(performance.now() - started);
    if (!res.ok) throw new Error(`debrief failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { debrief?: { front_page?: { headline?: string } }; frontPage?: unknown };
    return { ms, front_page: body.frontPage != null, headline: body.debrief?.front_page?.headline ?? null };
  }
}
