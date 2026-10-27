import { NotImplementedError } from "./errors.js";

export interface TextToSpeechOptions {
  voiceId?: string;
  model?: string;
}

/** Streaming text to speech. First adapter: ElevenLabs eleven_v4. */
export interface TextToSpeech {
  synthesize(text: string, options?: TextToSpeechOptions): AsyncIterable<Uint8Array>;
}

export class StubTextToSpeech implements TextToSpeech {
  // TODO: implement against ElevenLabs eleven_v4 streaming API.
  async *synthesize(_text: string, _options?: TextToSpeechOptions): AsyncIterable<Uint8Array> {
    throw new NotImplementedError("TextToSpeech (ElevenLabs eleven_v4)");
    yield new Uint8Array(); // unreachable
  }
}
