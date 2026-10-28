import { stripAudioTags, type ReporterLine, type ServerMessage, type SessionState, type TurnTiming } from "@hot-seat/shared";
import type { JournalistBrain, ConversationTurn, BrainScenario } from "../journalist.js";
import type { SpeechToText, SttEvent, SttSession } from "../providers/speech-to-text.js";
import type { TextToSpeech } from "../providers/text-to-speech.js";

export interface ClientSink {
  send(message: ServerMessage): void;
  sendAudio(chunk: Uint8Array): void;
}

export interface OrchestratorDeps {
  stt: SpeechToText;
  brain: Pick<JournalistBrain, "openingQuestion" | "nextTurn">;
  tts: TextToSpeech;
  sink: ClientSink;
  scenario: BrainScenario;
  voiceId: string;
  /** Silence after the last final/partial before the turn ends. Default 1500. */
  turnEndSilenceMs?: number;
  /** Idle time before the server pushes silence to an open STT session. Default 300. */
  keepAliveIdleMs?: number;
  /** How often the keep-alive checks for idle STT ingress. Default 100. */
  keepAliveIntervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_TURN_END_SILENCE_MS = 1500;
export const STT_KEEPALIVE_IDLE_MS = 300;
export const STT_KEEPALIVE_INTERVAL_MS = 100;
/** 100 ms of PCM16 at 16 kHz. */
export const STT_SILENCE_FRAME_BYTES = 3200;
/** Reopen attempts in a row that may fail before the user sees an error. */
export const STT_MAX_CONSECUTIVE_OPEN_FAILURES = 2;

/**
 * Half-duplex voice loop: thinking -> speaking -> (playback_done) listening.
 * The STT session opens only when the client reports playback finished, and
 * is never left without audio: silence is pushed after 300 ms idle.
 */
export class SessionOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private state: SessionState = "listening";
  private sttSession: SttSession | null = null;
  private readonly history: ConversationTurn[] = [];
  private turnIndex = 0;
  private stopped = false;
  private speechEndAt: number | null = null;
  private sttLoop: Promise<void> | null = null;
  private startedAt: number | null = null;
  private speculative: { answer: string; controller: AbortController; promise: Promise<ReporterLine> } | null = null;
  private awaitingPlayback = false;
  private lastAudioAt = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.log = deps.log ?? (() => undefined);
  }

  get currentState(): SessionState {
    return this.state;
  }

  get conversation(): readonly ConversationTurn[] {
    return this.history;
  }

  /** Generate and speak the opening question, then wait for playback_done. */
  async start(): Promise<void> {
    this.stopped = false;
    const t0 = this.now();
    this.startedAt = t0;
    this.setState("thinking");
    try {
      const line = await this.deps.brain.openingQuestion(this.deps.scenario);
      const timing = await this.speak(line, t0, t0, t0);
      this.history.push({ role: "reporter", text: line.say });
      this.deps.sink.send({ type: "timing", timing });
    } catch (err) {
      this.fail(err);
      return;
    }
    // State stays "speaking" until the browser has really played the audio.
    this.awaitingPlayback = true;
  }

  /** Client finished playing the reporter audio: only now open STT. */
  async playbackDone(): Promise<void> {
    if (this.stopped || !this.awaitingPlayback) return;
    this.awaitingPlayback = false;
    await this.beginListening();
  }

  /** Forward one mic frame. Dropped unless listening (half duplex). */
  pushAudio(pcm: Uint8Array): void {
    if (this.state !== "listening" || !this.sttSession) return;
    this.lastAudioAt = this.now();
    this.sttSession.push(pcm);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.awaitingPlayback = false;
    this.abortSpeculative();
    this.stopKeepAlive();
    try {
      this.sttSession?.end();
      this.sttSession?.close();
    } catch {
      /* best effort */
    }
    this.sttSession = null;
  }

  private setState(state: SessionState): void {
    this.state = state;
    if (!this.stopped) this.deps.sink.send({ type: "state", state });
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (!this.stopped) this.deps.sink.send({ type: "error", message });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.lastAudioAt = this.now();
    const idleMs = this.deps.keepAliveIdleMs ?? STT_KEEPALIVE_IDLE_MS;
    const intervalMs = this.deps.keepAliveIntervalMs ?? STT_KEEPALIVE_INTERVAL_MS;
    this.keepAliveTimer = setInterval(() => {
      if (this.stopped || this.state !== "listening" || !this.sttSession) return;
      if (this.now() - this.lastAudioAt < idleMs) return;
      try {
        this.sttSession.push(new Uint8Array(STT_SILENCE_FRAME_BYTES));
      } catch {
        /* session teardown handles failures */
      }
      this.lastAudioAt = this.now();
    }, intervalMs);
    (this.keepAliveTimer as { unref?: () => void }).unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private teardownStt(endStream = false): void {
    this.stopKeepAlive();
    try {
      if (endStream) this.sttSession?.end();
      this.sttSession?.close();
    } catch {
      /* best effort */
    }
    this.sttSession = null;
  }

  /** Open a session, retrying once. Returns null after two failures in a row (error already shown). */
  private async openSttWithRetry(): Promise<SttSession | null> {
    let failures = 0;
    while (!this.stopped) {
      try {
        return await this.deps.stt.openSession();
      } catch (err) {
        failures += 1;
        this.log(`[stt] open failed (${failures}/${STT_MAX_CONSECUTIVE_OPEN_FAILURES}): ${err instanceof Error ? err.message : String(err)}`);
        if (failures >= STT_MAX_CONSECUTIVE_OPEN_FAILURES) {
          this.fail(err);
          return null;
        }
      }
    }
    return null;
  }

  private async beginListening(): Promise<void> {
    if (this.stopped) return;
    this.speechEndAt = null;
    const session = await this.openSttWithRetry();
    if (!session || this.stopped) {
      try {
        session?.close();
      } catch {
        /* best effort */
      }
      return;
    }
    this.sttSession = session;
    this.setState("listening");
    this.startKeepAlive();
    this.sttLoop = this.consumeStt();
    void this.sttLoop.catch((err: unknown) => this.fail(err));
  }

  private async consumeStt(): Promise<void> {
    const silenceMs = this.deps.turnEndSilenceMs ?? DEFAULT_TURN_END_SILENCE_MS;
    const parts: string[] = [];
    let lastFinalAt: number | null = null;
    let lastEndpointAt: number | null = null;
    // Consume sessions until the turn ends. A dead session is reopened in
    // place; `parts` (the answer collected so far) survives the reopen.
    while (!this.stopped) {
      if (!this.sttSession) {
        const reopened = await this.openSttWithRetry();
        if (!reopened || this.stopped) return;
        this.sttSession = reopened;
        this.startKeepAlive();
      }
      const iter = this.sttSession.events()[Symbol.asyncIterator]();
      let sessionDead = false;
      let turnEnded = false;
      while (!this.stopped && !sessionDead && !turnEnded) {
        const nextP = iter.next();
        let result: IteratorResult<SttEvent>;
        if (parts.length === 0) {
          result = await nextP;
        } else {
          const TIMEOUT = Symbol("silence");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const raced = await Promise.race([
            nextP,
            new Promise<typeof TIMEOUT>((resolve) => {
              timer = setTimeout(() => resolve(TIMEOUT), silenceMs);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (raced === TIMEOUT) {
            turnEnded = true;
            break;
          }
          result = raced as IteratorResult<SttEvent>;
        }
        if (result.done) {
          sessionDead = true;
          break;
        }
        const ev = result.value;
        if (this.stopped) return;
        if (ev.type === "endpoint") {
          lastEndpointAt = this.now();
          this.speechEndAt = lastEndpointAt;
        } else if (ev.type === "error") {
          this.log(`[stt] session error while listening: ${ev.message}; reopening`);
          sessionDead = true;
        } else if (ev.type === "partial") {
          if (parts.length > 0) this.abortSpeculative();
          continue;
        } else if (ev.type === "final") {
          const segment = ev.text.trim();
          if (!segment) continue;
          parts.push(segment);
          lastFinalAt = this.now();
          this.startSpeculative(parts.join(" "));
        }
      }
      if (this.stopped) return;
      if (turnEnded) break;
      if (sessionDead) {
        this.log(`[stt] session ended while listening; reopening (kept ${parts.length} answer segment(s))`);
        this.teardownStt();
        continue;
      }
      break;
    }
    if (this.stopped || parts.length === 0) return;
    const finalAt = lastFinalAt ?? this.now();
    const speechEndAt = lastEndpointAt ?? finalAt;
    await this.handleFinal(parts.join(" "), speechEndAt, finalAt);
  }

  private elapsedSeconds(): number {
    return this.startedAt === null ? 0 : Math.max(0, (this.now() - this.startedAt) / 1000);
  }

  /** Start the journalist LLM at once, during the turn-end silence window. */
  private startSpeculative(answer: string): void {
    this.speculative?.controller.abort();
    const controller = new AbortController();
    const history: ConversationTurn[] = [...this.history, { role: "user", text: answer }];
    const promise = Promise.resolve().then(() =>
      this.deps.brain.nextTurn(this.deps.scenario, history, answer, this.elapsedSeconds(), controller.signal),
    );
    promise.catch(() => undefined);
    this.speculative = { answer, controller, promise };
  }

  private abortSpeculative(): void {
    this.speculative?.controller.abort();
    this.speculative = null;
  }

  private async handleFinal(text: string, speechEndAt: number, finalAt: number): Promise<void> {
    this.teardownStt(true);
    this.turnIndex += 1;
    const userText = text.trim();
    this.deps.sink.send({ type: "transcript", role: "user", text: userText });
    this.history.push({ role: "user", text: userText });
    this.setState("thinking");
    let line: ReporterLine;
    try {
      // Never speak a reply generated from a shorter answer than the final one.
      if (this.speculative && this.speculative.answer === userText) {
        const pending = this.speculative.promise;
        this.speculative = null;
        line = await pending;
      } else {
        this.abortSpeculative();
        line = await this.deps.brain.nextTurn(this.deps.scenario, [...this.history], userText, this.elapsedSeconds());
      }
    } catch (err) {
      this.fail(err);
      await this.beginListening();
      return;
    }
    const llmAt = this.now();
    this.history.push({ role: "reporter", text: line.say });
    let timing: TurnTiming;
    try {
      timing = await this.speak(line, speechEndAt, finalAt, llmAt);
    } catch (err) {
      this.fail(err);
      await this.beginListening();
      return;
    }
    this.deps.sink.send({ type: "timing", timing });
    this.log(
      `[turn ${timing.turn}] speechEnd->final ${Math.round(timing.speechEndToFinalMs)}ms ` +
        `speechEnd->llm ${Math.round(timing.speechEndToLlmMs)}ms ` +
        `speechEnd->firstAudio ${Math.round(timing.speechEndToFirstAudioMs)}ms totalToVoice ${Math.round(timing.totalToFirstAudioMs)}ms`,
    );
    // Wait for playback_done before opening the next STT session.
    if (!this.stopped) this.awaitingPlayback = true;
  }

  /** Emit reporter_line, stream TTS audio, emit audio_end. Returns timing. */
  private async speak(line: ReporterLine, speechEndAt: number, finalAt: number, llmAt: number): Promise<TurnTiming> {
    this.deps.sink.send({ type: "reporter_line", line });
    this.deps.sink.send({ type: "transcript", role: "reporter", text: stripAudioTags(line.say) });
    this.setState("speaking");
    let firstAudioAt: number | null = null;
    for await (const chunk of this.deps.tts.synthesize(line.say, { voiceId: this.deps.voiceId })) {
      if (this.stopped) break;
      if (firstAudioAt === null) firstAudioAt = this.now();
      this.deps.sink.sendAudio(chunk);
    }
    const first = firstAudioAt ?? this.now();
    this.deps.sink.send({ type: "audio_end" });
    return {
      turn: this.turnIndex,
      speechEndToFinalMs: Math.max(0, finalAt - speechEndAt),
      speechEndToLlmMs: Math.max(0, llmAt - speechEndAt),
      speechEndToFirstAudioMs: Math.max(0, first - speechEndAt),
      totalToFirstAudioMs: Math.max(0, first - speechEndAt),
    };
  }
}
