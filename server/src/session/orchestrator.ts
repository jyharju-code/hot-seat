import { stripAudioTags, type Escalation, type ReporterFlag, type ReporterLine, type ServerMessage, type SessionState, type TurnTiming } from "@hot-seat/shared";
import { isGenerated, primaryJournalist, type JournalistBrain, type ConversationTurn, type BrainScenario } from "../journalist.js";
import type { InterruptDecider } from "../interrupt.js";
import type { SpeechToText, SttEvent, SttSession } from "../providers/speech-to-text.js";
import type { TextToSpeech } from "../providers/text-to-speech.js";
import type { SessionRecord } from "./store.js";

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
  /** When set, every turn is recorded with its timestamp and flags for the debrief. */
  record?: SessionRecord;
  /** Multiplier for escalation at_seconds (smoke only, outside production). Default 1. */
  escalationScale?: number;
  newsVoiceId?: string;
  newsTtsModel?: string;
  interruptDecider?: InterruptDecider;
  /** Default true when a decider is present. Env INTERRUPTS maps here. */
  interruptsEnabled?: boolean;
  /** Owner must speak this long before any decision. Default 8000. */
  interruptAfterMs?: number;
  /** Minimum gap between decisions. Default 1500. */
  interruptIntervalMs?: number;
}

export const NEWS_VOICE_ID = "3WqHLnw80rOZqJzW9YRB";
export const NEWS_TTS_MODEL = "eleven_v4_turbo";

export const DEFAULT_TURN_END_SILENCE_MS = 1500;
export const STT_KEEPALIVE_IDLE_MS = 300;
export const STT_KEEPALIVE_INTERVAL_MS = 100;
/** 100 ms of PCM16 at 16 kHz. */
export const STT_SILENCE_FRAME_BYTES = 3200;
/** Reopen attempts in a row that may fail before the user sees an error. */
export const STT_MAX_CONSECUTIVE_OPEN_FAILURES = 2;
export const INTERRUPT_AFTER_MS = 8000;
export const INTERRUPT_INTERVAL_MS = 1500;
export const INTERRUPT_TTS_MODEL = "eleven_v4_turbo";

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
  private readonly firedEscalations = new Set<number>();
  private readonly learnedEscalations: Escalation[] = [];
  private lastAnswerInterrupted = false;

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
      this.deps.record?.turns.push({
        role: "reporter",
        text: stripAudioTags(line.say),
        elapsedSeconds: 0,
        flags: [...line.flags],
      });
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
    // Interrupt decision state for this one answer.
    let latestPartial = "";
    let answerStartedAt: number | null = null;
    let lastDecisionAt: number | null = null;
    let lastDecisionText = "";
    let decisionInFlight = false;
    let listeningActive = true;
    let interruptReq: { text: string; say: string; reason: string; decisionAt: number; latencyMs: number } | null = null;
    const maybeDecide = (currentText: string): void => {
      const decider = this.deps.interruptDecider;
      if (!decider || !(this.deps.interruptsEnabled ?? true) || this.lastAnswerInterrupted) return;
      if (this.stopped || interruptReq || decisionInFlight || answerStartedAt === null) return;
      const nowMs = this.now();
      if (nowMs - answerStartedAt < (this.deps.interruptAfterMs ?? INTERRUPT_AFTER_MS)) return;
      if (lastDecisionAt !== null && nowMs - lastDecisionAt < (this.deps.interruptIntervalMs ?? INTERRUPT_INTERVAL_MS)) return;
      if (currentText.trim().length === 0 || currentText.length <= lastDecisionText.length) return;
      lastDecisionAt = nowMs;
      lastDecisionText = currentText;
      decisionInFlight = true;
      const snapshot = currentText;
      const started = nowMs;
      const scenario = this.deps.scenario;
      const persona = isGenerated(scenario)
        ? { name: primaryJournalist(scenario).name, outlet: primaryJournalist(scenario).outlet, facts: scenario.public_facts.join("; ") }
        : { name: scenario.reporter.name, outlet: scenario.reporter.outlet, facts: scenario.publicFacts.join("; ") };
      const question = [...this.history].reverse().find((t) => t.role === "reporter")?.text ?? "";
      void (async () => {
        try {
          const decision = await decider.decide({
            name: persona.name,
            outlet: persona.outlet,
            question,
            seconds: (started - (answerStartedAt ?? started)) / 1000,
            partial: snapshot,
            facts: persona.facts,
          });
          const latencyMs = this.now() - started;
          this.log(`[interrupt] decision latency ${Math.round(latencyMs)}ms interrupt=${decision.interrupt}`);
          if (this.stopped || interruptReq || !decision.interrupt) return;
          if (!listeningActive || this.state !== "listening") return;
          if (latestPartial !== snapshot) {
            this.log("[interrupt] stale decision dropped (answer moved on)");
            return;
          }
          interruptReq = { text: snapshot, say: decision.say, reason: decision.reason, decisionAt: this.now(), latencyMs };
          this.teardownStt();
        } catch (err) {
          this.log(`[interrupt] decision failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          decisionInFlight = false;
        }
      })();
    };
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
          const text = ev.text.trim();
          if (text) {
            if (answerStartedAt === null) answerStartedAt = this.now();
            latestPartial = [...parts, text].join(" ");
            maybeDecide(latestPartial);
          }
          continue;
        } else if (ev.type === "final") {
          const segment = ev.text.trim();
          if (!segment) continue;
          if (answerStartedAt === null) answerStartedAt = this.now();
          parts.push(segment);
          latestPartial = parts.join(" ");
          lastFinalAt = this.now();
          maybeDecide(latestPartial);
          this.startSpeculative(parts.join(" "));
        }
      }
      if (this.stopped) return;
      if (interruptReq) break;
      if (turnEnded) break;
      if (sessionDead) {
        this.log(`[stt] session ended while listening; reopening (kept ${parts.length} answer segment(s))`);
        this.teardownStt();
        continue;
      }
      break;
    }
    listeningActive = false;
    if (this.stopped) return;
    if (interruptReq) {
      await this.handleInterrupt(interruptReq);
      return;
    }
    if (parts.length === 0) return;
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
      this.deps.brain.nextTurn(
        this.deps.scenario,
        history,
        answer,
        this.elapsedSeconds(),
        controller.signal,
        [...this.learnedEscalations],
      ),
    );
    promise.catch(() => undefined);
    this.speculative = { answer, controller, promise };
  }

  private abortSpeculative(): void {
    this.speculative?.controller.abort();
    this.speculative = null;
  }

  /** Earliest unfired escalation whose (scaled) time has passed, if any. */
  private takeDueEscalation(): Escalation | null {
    const scenario = this.deps.scenario;
    if (!("escalations" in scenario)) return null;
    const scale = this.deps.escalationScale ?? 1;
    const elapsed = this.elapsedSeconds();
    const due = scenario.escalations
      .map((esc, index) => ({ esc, index }))
      .filter(({ esc, index }) => !this.firedEscalations.has(index) && esc.at_seconds * scale <= elapsed)
      .sort((a, b) => a.esc.at_seconds - b.esc.at_seconds || a.index - b.index)[0];
    if (!due) return null;
    this.firedEscalations.add(due.index);
    this.learnedEscalations.push(due.esc);
    return due.esc;
  }

  /** Stream the news flash in the radio voice. No audio_end: the reporter follows. */
  private async speakNews(text: string): Promise<void> {
    this.setState("speaking");
    for await (const chunk of this.deps.tts.synthesize(text, {
      voiceId: this.deps.newsVoiceId ?? NEWS_VOICE_ID,
      model: this.deps.newsTtsModel ?? NEWS_TTS_MODEL,
    })) {
      if (this.stopped) break;
      this.deps.sink.sendAudio(chunk);
    }
  }

  /** Cut the owner off: the partial is their answer, the cut-in is the next question. */
  private async handleInterrupt(req: { text: string; say: string; reason: string; decisionAt: number; latencyMs: number }): Promise<void> {
    this.abortSpeculative();
    this.teardownStt();
    this.turnIndex += 1;
    this.lastAnswerInterrupted = true;
    const cutText = req.text.trim();
    const display = `${cutText} (cut off)`;
    this.deps.sink.send({ type: "transcript", role: "user", text: display });
    this.history.push({ role: "user", text: cutText });
    this.deps.record?.turns.push({
      role: "user",
      text: display,
      elapsedSeconds: this.elapsedSeconds(),
      flags: [],
      interruptReason: req.reason || "interrupted",
    });
    this.deps.sink.send({ type: "interrupt", say: req.say });
    this.deps.sink.send({ type: "transcript", role: "reporter", text: stripAudioTags(req.say) });
    this.history.push({ role: "reporter", text: req.say });
    this.deps.record?.turns.push({
      role: "reporter",
      text: stripAudioTags(req.say),
      elapsedSeconds: this.elapsedSeconds(),
      flags: [],
    });
    this.setState("speaking");
    let firstAudioAt: number | null = null;
    try {
      for await (const chunk of this.deps.tts.synthesize(req.say, { voiceId: this.deps.voiceId, model: INTERRUPT_TTS_MODEL })) {
        if (this.stopped) break;
        if (firstAudioAt === null) {
          firstAudioAt = this.now();
          this.log(
            `[interrupt] decision->firstAudio ${Math.round(firstAudioAt - req.decisionAt)}ms decision latency ${Math.round(req.latencyMs)}ms reason: ${req.reason}`,
          );
        }
        this.deps.sink.sendAudio(chunk);
      }
    } catch (err) {
      this.fail(err);
      await this.beginListening();
      return;
    }
    this.deps.sink.send({ type: "audio_end" });
    if (!this.stopped) this.awaitingPlayback = true;
  }

  private async handleFinal(text: string, speechEndAt: number, finalAt: number): Promise<void> {
    this.teardownStt(true);
    this.lastAnswerInterrupted = false;
    this.turnIndex += 1;
    const userText = text.trim();
    this.deps.sink.send({ type: "transcript", role: "user", text: userText });
    this.history.push({ role: "user", text: userText });
    const userTurn: { role: "user"; text: string; elapsedSeconds: number; flags: ReporterFlag[] } = {
      role: "user",
      text: userText,
      elapsedSeconds: this.elapsedSeconds(),
      flags: [],
    };
    this.deps.record?.turns.push(userTurn);
    this.setState("thinking");
    // Turn boundary: at most one escalation fires here, before the reply.
    const escalation = this.takeDueEscalation();
    let line: ReporterLine;
    try {
      if (escalation) {
        // The speculative reply was generated without the new fact.
        this.abortSpeculative();
        this.history.push({ role: "news", text: escalation.news_flash });
        this.deps.record?.turns.push({
          role: "news",
          text: escalation.news_flash,
          elapsedSeconds: this.elapsedSeconds(),
          flags: [],
        });
        const linePromise = Promise.resolve().then(() =>
          this.deps.brain.nextTurn(
            this.deps.scenario,
            [...this.history],
            userText,
            this.elapsedSeconds(),
            undefined,
            [...this.learnedEscalations],
          ),
        );
        linePromise.catch(() => undefined);
        this.deps.sink.send({
          type: "news_flash",
          text: escalation.news_flash,
          atSeconds: this.elapsedSeconds(),
        });
        await this.speakNews(escalation.news_flash);
        line = await linePromise;
      } else if (this.speculative && this.speculative.answer === userText) {
        // Never speak a reply generated from a shorter answer than the final one.
        const pending = this.speculative.promise;
        this.speculative = null;
        line = await pending;
      } else {
        this.abortSpeculative();
        line = await this.deps.brain.nextTurn(
          this.deps.scenario,
          [...this.history],
          userText,
          this.elapsedSeconds(),
          undefined,
          [...this.learnedEscalations],
        );
      }
    } catch (err) {
      this.fail(err);
      await this.beginListening();
      return;
    }
    const llmAt = this.now();
    userTurn.flags = [...line.flags];
    this.deps.record?.turns.push({
      role: "reporter",
      text: stripAudioTags(line.say),
      elapsedSeconds: this.elapsedSeconds(),
      flags: [...line.flags],
    });
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
