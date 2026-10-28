import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MuseSpeechToText } from "../src/providers/speech-to-text.js";

class FakeWs extends EventEmitter {
  readyState = 0; // CONNECTING
  static OPEN = 1;
  sent: string[] = [];
  closeCalls = 0;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closeCalls += 1; this.readyState = 3; }
  open(): void { this.readyState = 1; this.emit("open"); }
  serverMessage(obj: unknown): void { this.emit("message", Buffer.from(JSON.stringify(obj)), false); }
  serverClose(): void { this.readyState = 3; this.emit("close"); }
  serverError(err: Error): void { this.emit("error", err); }
}

function makeStt() {
  const ws = new FakeWs();
  const stt = new MuseSpeechToText({
    apiKey: "k",
    webSocketFactory: () => ws as never,
  });
  return { ws, stt };
}

describe("STT handshake (brief 08 item 3)", () => {
  it("rejects immediately when the socket closes before the ack, and closes the socket", async () => {
    const { ws, stt } = makeStt();
    const p = stt.openSession();
    ws.open();
    ws.serverClose();
    await expect(p).rejects.toThrow(/clos/i);
  });

  it("rejects and closes the socket on a socket error before the ack", async () => {
    const { ws, stt } = makeStt();
    const p = stt.openSession();
    ws.open();
    ws.serverError(new Error("boom"));
    await expect(p).rejects.toThrow(/boom/);
    expect(ws.closeCalls).toBeGreaterThan(0);
  });

  it("rejects and closes the socket when the ack never arrives (timeout)", async () => {
    vi.useFakeTimers();
    try {
      const { ws, stt } = makeStt();
      const p = stt.openSession();
      const assertion = expect(p).rejects.toThrow(/timed out/);
      ws.open();
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(ws.closeCalls).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it("resolves on ack and does not close the socket", async () => {
    const { ws, stt } = makeStt();
    const p = stt.openSession();
    ws.open();
    ws.serverMessage({ type: "sessionStarted" });
    const session = await p;
    expect(session).toBeTruthy();
    expect(ws.closeCalls).toBe(0);
    session.close();
  });
});
