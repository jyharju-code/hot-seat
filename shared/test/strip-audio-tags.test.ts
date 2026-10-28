import { describe, expect, it } from "vitest";
import { stripAudioTags } from "../src/index.js";

describe("stripAudioTags", () => {
  it("strips a leading tag", () => {
    expect(stripAudioTags("[sharply] Did you know about the case?")).toBe("Did you know about the case?");
  });
  it("strips multiple and inline tags", () => {
    expect(stripAudioTags("[impatient] [sighs] Look, [hesitates] when did you know?")).toBe("Look, when did you know?");
  });
  it("leaves untagged text unchanged", () => {
    expect(stripAudioTags("We take this extremely seriously.")).toBe("We take this extremely seriously.");
  });
  it("handles empty and tag-only text", () => {
    expect(stripAudioTags("")).toBe("");
    expect(stripAudioTags("[sighs]")).toBe("");
  });
});
