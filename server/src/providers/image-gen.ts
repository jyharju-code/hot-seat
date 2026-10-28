import { NotImplementedError } from "./errors.js";

export interface ImageEditInput {
  /** Source photo bytes (for example a webcam still for the front page). */
  image: Uint8Array;
  mimeType: string;
  prompt: string;
}

export interface ImageResult {
  image: Uint8Array;
  mimeType: string;
}

/** Edit a photo into a new image, or generate one from a prompt. Muse Image via Meta API. */
export interface ImageGen {
  editPhoto(input: ImageEditInput): Promise<ImageResult>;
  generateImage(prompt: string): Promise<ImageResult>;
}

/** Error from the image API with its HTTP status and provider code, when known. */
export class ImageApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ImageApiError";
    this.status = status;
    this.code = code;
  }
}

/** "filtered" for a content-policy or any other 4xx rejection, else "error". */
export function classifyImageError(err: unknown): "filtered" | "error" {
  if (err instanceof ImageApiError) {
    return err.code === "content_policy_violation" || (err.status >= 400 && err.status < 500)
      ? "filtered"
      : "error";
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("content_policy_violation")) return "filtered";
  const m = /:\s(4\d\d)\b/.exec(msg);
  return m ? "filtered" : "error";
}

export function isFilteredImageError(err: unknown): boolean {
  return classifyImageError(err) === "filtered";
}

export class StubImageGen implements ImageGen {
  async editPhoto(_input: ImageEditInput): Promise<ImageResult> {
    throw new NotImplementedError("ImageGen (Muse Image)");
  }
  async generateImage(_prompt: string): Promise<ImageResult> {
    throw new NotImplementedError("ImageGen (Muse Image)");
  }
}

export interface MetaImageGenOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/**
 * Muse Image adapter (https://api.meta.ai/v1, OpenAI-compatible images API).
 * Verified live 2026-10-28: generations take JSON {model, prompt} and edits
 * take multipart form fields model, prompt and image (the still file). Both
 * return data[0].b64_json as webp bytes.
 */
export class MetaImageGen implements ImageGen {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: MetaImageGenOptions) {
    if (!options.apiKey) throw new Error("MetaImageGen requires an apiKey (MODEL_API_KEY)");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    this.model = options.model ?? "muse-image-1.0";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async generateImage(prompt: string): Promise<ImageResult> {
    const res = await this.fetchFn(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, prompt }),
    });
    return this.parseResult(res, "generations");
  }

  async editPhoto(input: ImageEditInput): Promise<ImageResult> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("prompt", input.prompt);
    const ext = input.mimeType.includes("png") ? "png" : input.mimeType.includes("webp") ? "webp" : "jpg";
    form.append(
      "image",
      new Blob([input.image.buffer as ArrayBuffer], { type: input.mimeType }),
      `still.${ext}`,
    );
    const res = await this.fetchFn(`${this.baseUrl}/images/edits`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    return this.parseResult(res, "edits");
  }

  private async parseResult(res: Response, kind: string): Promise<ImageResult> {
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      const code = detail.includes("content_policy_violation") ? "content_policy_violation" : null;
      throw new ImageApiError(`Meta Muse Image ${kind} failed: ${res.status} ${detail}`, res.status, code);
    }
    const data = (await res.json()) as ImagesResponse;
    const first = data.data?.[0];
    if (first?.b64_json) {
      const image = new Uint8Array(Buffer.from(first.b64_json, "base64"));
      return { image, mimeType: sniffMime(image) };
    }
    if (first?.url) {
      const fetched = await this.fetchFn(first.url);
      if (!fetched.ok) throw new Error(`Meta Muse Image result download failed: ${fetched.status}`);
      const image = new Uint8Array(await fetched.arrayBuffer());
      return { image, mimeType: fetched.headers.get("content-type") ?? sniffMime(image) };
    }
    throw new Error("Meta Muse Image returned no image data");
  }
}

function sniffMime(bytes: Uint8Array): string {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return "image/webp";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return "image/webp";
}
