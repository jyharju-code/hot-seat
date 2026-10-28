import type { ReporterLine, ServerMessage, SessionState, TurnTiming } from "@hot-seat/shared";
import type { JournalistBrain, ConversationTurn } from "../journalist.js";
import type { SpeechToText, SttSession } from "../providers/speech-to-text.js";
import type { TextToSpeech } from "../providers/text-to-speech.js";
import type { DemoScenario } from "../scenarios/cafe.js";

export interface ClientSink {
  send(message: ServerMessage): void;
  sendAudio(chunk: Uint8Array): void;
}

export interface OrchestratorDeps {
  stt: SpeechToText;
  brain: Pick<JournalistBrain, "openingQuestion" | "nextTurn">;
  tts: TextToSpeech;
  sink: ClientSink;
  scenario: DemoScenario;
  voiceId: string;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Half-duplex voice loop: listening -> thinking -> speaking -> listening.
 * Mic audio is only forwarded to STT while listening.
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

  /** Generate and speak the opening question, then start listening. */
  async start(): Promise<void> {
    this.stopped = false;
    const t0 = this.now();
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
    await this.beginListening();
  }

  /** Forward one mic frame. Dropped unless listening (half duplex). */
  pushAudio(pcm: Uint8Array): void {
    if (this.state !== "listening" || !this.sttSession) return;
    this.sttSession.push(pcm);
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

  private async beginListening(): Promise<void> {
    if (this.stopped) return;
    this.speechEndAt = null;
    this.sttSession = await this.deps.stt.openSession();
    this.setState("listening");
    this.sttLoop = this.consumeStt(this.sttSession);
    void this.sttLoop.catch((err: unknown) => this.fail(err));
  }

  private async consumeStt(session: SttSession): Promise<void> {
    for await (const ev of session.events()) {
      if (this.stopped) return;
      if (ev.type === "endpoint") {
        if (this.speechEndAt === null) this.speechEndAt = this.now();
      } else if (ev.type === "error") {
        this.fail(new Error(ev.message));
        return;
      } else if (ev.type === "final") {
        await this.handleFinal(ev.text);
        return; // one turn per STT session; a fresh session starts after speaking
      }
      // partials are intentionally unused for now (interrupt feature later)
    }
  }

  private async handleFinal(text: string): Promise<void> {
    const finalAt = this.now();
    const speechEndAt = this.speechEndAt ?? finalAt;
    try {
      this.sttSession?.end();
      this.sttSession?.close();
    } catch {
      /* best effort */
    }
    this.sttSession = null;
    this.turnIndex += 1;
    const userText = text.trim();
    this.deps.sink.send({ type: "transcript", role: "user", text: userText });
    this.history.push({ role: "user", text: userText });
    this.setState("thinking");
    let line: ReporterLine;
    try {
      line = await this.deps.brain.nextTurn(this.deps.scenario, [...this.history], userText);
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
    await this.beginListening();
  }

  /** Emit reporter_line, stream TTS audio, emit audio_end. Returns timing. */
  private async speak(line: ReporterLine, speechEndAt: number, finalAt: number, llmAt: number): Promise<TurnTiming> {
    this.deps.sink.send({ type: "reporter_line", line });
    this.deps.sink.send({ type: "transcript", role: "reporter", text: line.say });
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
