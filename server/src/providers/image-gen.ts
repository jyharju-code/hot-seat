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

/** Edit a photo into a new image. First adapter: Muse Image /v1/images/edits. */
export interface ImageGen {
  editPhoto(input: ImageEditInput): Promise<ImageResult>;
}

export class StubImageGen implements ImageGen {
  // TODO: implement against Muse Image /v1/images/edits.
  async editPhoto(_input: ImageEditInput): Promise<ImageResult> {
    throw new NotImplementedError("ImageGen (Muse Image)");
  }
}
