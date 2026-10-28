import { describe, expect, it } from "vitest";
import { partAtTime, totalDurationMs } from "../src/NewsPlayer.js";

const timeline = [
  { part: "intro" as const, startMs: 0, endMs: 1000, text: "intro" },
  { part: "soundbite" as const, startMs: 1400, endMs: 2400, text: "quote" },
  { part: "outro" as const, startMs: 2800, endMs: 3600, text: "outro" },
];

describe("news player timeline", () => {
  it("picks the part at a time and the total duration", () => {
    expect(partAtTime(timeline, 0)?.part).toBe("intro");
    expect(partAtTime(timeline, 1500)?.part).toBe("soundbite");
    expect(partAtTime(timeline, 3000)?.part).toBe("outro");
    expect(partAtTime(timeline, 99999)?.part).toBe("outro");
    expect(totalDurationMs(timeline)).toBe(3600);
    expect(partAtTime([], 0)).toBeNull();
  });
});
