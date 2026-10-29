import { NotImplementedError } from "./errors.js";
import { NEWS_TTS_TIMEOUT_MS, timeoutSignal } from "./timeout.js";

export interface TextToSpeechOptions {
  voiceId?: string;
  model?: string;
  outputFormat?: "pcm_24000" | "pcm_16000";
  /** Aborts the fetch / stream when the session stops. */
  signal?: AbortSignal;
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

/** Default re-chunk target: 100 ms of PCM16 at 24 kHz. */
export const TTS_CHUNK_BYTES = 4800;

/**
 * Re-chunk a PCM16 byte stream so every yielded chunk has an even length.
 * Bytes are preserved exactly; at most one trailing lone byte is dropped.
 * Full chunks of `chunkBytes` (rounded down to even) are emitted as they fill.
 */
export async function* rechunkPcm16(
  source: AsyncIterable<Uint8Array>,
  chunkBytes: number = TTS_CHUNK_BYTES,
): AsyncIterable<Uint8Array> {
  const size = Math.max(2, chunkBytes - (chunkBytes % 2));
  let pending = new Uint8Array(0);
  for await (const chunk of source) {
    if (!chunk.length) continue;
    const merged = new Uint8Array(pending.length + chunk.length);
    merged.set(pending, 0);
    merged.set(chunk, pending.length);
    let off = 0;
    while (merged.length - off >= size) {
      yield merged.subarray(off, off + size);
      off += size;
    }
    pending = merged.slice(off);
  }
  if (pending.length >= 2) yield pending.slice(0, pending.length - (pending.length % 2));
}

/** Guard: in browser mode no code path may call ElevenLabs. */
export function isElevenLabsUrl(url: string): boolean {
  try { return new URL(url).hostname === "api.elevenlabs.io"; } catch { return url.includes("api.elevenlabs.io"); }
}
export function assertElevenLabsAllowed(provider: "browser" | "elevenlabs" | undefined, url: string): void {
  if (provider === "browser" && isElevenLabsUrl(url)) throw new Error("ElevenLabs call blocked in browser TTS mode");
}
export function guardedFetch(provider: "browser" | "elevenlabs" | undefined, fetchFn: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    assertElevenLabsAllowed(provider, url);
    return fetchFn(input, init);
  }) as typeof fetch;
}

export interface ElevenLabsTtsOptions {
  apiKey: string;
  defaultVoiceId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** ElevenLabs streaming TTS. Inline audio tags pass through unchanged (v4 performs them). */
export class ElevenLabsTextToSpeech implements TextToSpeech {
  private readonly apiKey: string;
  private readonly defaultVoiceId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsTtsOptions) {
    if (!options.apiKey) throw new Error("ElevenLabsTextToSpeech requires an apiKey (ELEVENLABS_API_KEY)");
    this.apiKey = options.apiKey;
    this.defaultVoiceId = options.defaultVoiceId;
    this.baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io/v1").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? NEWS_TTS_TIMEOUT_MS;
  }

  async *synthesize(text: string, options?: TextToSpeechOptions): AsyncIterable<Uint8Array> {
    const voiceId = options?.voiceId ?? this.defaultVoiceId;
    const format = options?.outputFormat ?? "pcm_24000";
    const res = await this.fetchFn(
      `${this.baseUrl}/text-to-speech/${voiceId}/stream?output_format=${format}`,
      {
        method: "POST",
        signal: timeoutSignal(this.timeoutMs, options?.signal),
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
    const raw: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: async function* () {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) yield value;
          }
        } finally {
          // Consumer stopped early (or the stream ended): release the socket.
          try {
            await reader.cancel();
          } catch {
            /* already closed */
          }
        }
      },
    };
    yield* rechunkPcm16(raw);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
