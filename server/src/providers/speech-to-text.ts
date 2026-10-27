import { NotImplementedError } from "./errors.js";

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  startMs?: number;
  endMs?: number;
}

export interface SpeechToTextOptions {
  language?: "en" | "fi";
}

/** Streaming speech to text. First adapter: Meta Muse Voice Transcribe. */
export interface SpeechToText {
  transcribe(audio: AsyncIterable<Uint8Array>, options?: SpeechToTextOptions): AsyncIterable<TranscriptEvent>;
}

export class StubSpeechToText implements SpeechToText {
  // TODO: implement against wss://api.meta.ai/v1/asr/realtime (Muse Voice Transcribe).
  async *transcribe(_audio: AsyncIterable<Uint8Array>, _options?: SpeechToTextOptions): AsyncIterable<TranscriptEvent> {
    throw new NotImplementedError("SpeechToText (Muse Voice Transcribe)");
    yield { text: "", isFinal: true }; // unreachable, keeps the generator shape explicit
  }
}
