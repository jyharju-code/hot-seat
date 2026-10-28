import { NotImplementedError } from "./errors.js";

export interface TextToSpeechOptions {
  voiceId?: string;
  model?: string;
  outputFormat?: "pcm_24000" | "pcm_16000";
}

/** Streaming text to speech. First adapter: ElevenLabs eleven_v4. */
export interface TextToSpeech {
  synthesize(text: string, options?: TextToSpeechOptions): AsyncIterable<Uint8Array>;
}

export class StubTextToSpeech implements TextToSpeech {
  async *synthesize(_text: string, _options?: TextToSpeechOptions): AsyncIterable<Uint8Array> {
    throw new NotImplementedError("TextToSpeech (ElevenLabs eleven_v4)");
    yield new Uint8Array(); // unreachable
  }
}

export interface ElevenLabsTtsOptions {
  apiKey: string;
  defaultVoiceId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/** ElevenLabs streaming TTS. Inline audio tags pass through unchanged (v4 performs them). */
export class ElevenLabsTextToSpeech implements TextToSpeech {
  private readonly apiKey: string;
  private readonly defaultVoiceId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ElevenLabsTtsOptions) {
    if (!options.apiKey) throw new Error("ElevenLabsTextToSpeech requires an apiKey (ELEVENLABS_API_KEY)");
    this.apiKey = options.apiKey;
    this.defaultVoiceId = options.defaultVoiceId;
    this.baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io/v1").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async *synthesize(text: string, options?: TextToSpeechOptions): AsyncIterable<Uint8Array> {
    const voiceId = options?.voiceId ?? this.defaultVoiceId;
    const format = options?.outputFormat ?? "pcm_24000";
    const res = await this.fetchFn(
      `${this.baseUrl}/text-to-speech/${voiceId}/stream?output_format=${format}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": this.apiKey },
        body: JSON.stringify({
          text,
          model_id: options?.model ?? "eleven_v4",
          voice_settings: { stability: 0.3, similarity_boost: 0.85 },
        }),
      },
    );
    if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${(await safeText(res)).slice(0, 200)}`);
    if (!res.body) throw new Error("ElevenLabs TTS returned no body");
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) yield value;
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
