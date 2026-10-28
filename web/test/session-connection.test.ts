import { describe, expect, it } from "vitest";
import { connectionLostUpdate, CONNECTION_LOST_MESSAGE } from "../src/session-connection.js";

describe("browser socket close (brief 08 item 7)", () => {
  it("shows Connection lost. with a Start again action and stops claiming Live", () => {
    const update = connectionLostUpdate();
    expect(CONNECTION_LOST_MESSAGE).toBe("Connection lost.");
    expect(update.error).toBe("Connection lost.");
    expect(update.live).toBe(false);
    expect(update.showStartAgain).toBe(true);
  });
});
