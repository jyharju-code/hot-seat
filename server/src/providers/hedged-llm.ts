import type { Llm, LlmChatInput, LlmChatResult, LlmStructuredInput } from "./llm.js";

export const HEDGE_AFTER_MS = 1800;

export type HedgeProviderName = "meta" | "baseten";

export interface HedgedProvider {
  name: HedgeProviderName;
  llm: Llm;
  /** Model to use on this provider (providers name the same model differently). */
  model?: string;
}

export interface HedgedLlmOptions {
  primary: HedgedProvider;
  hedge?: HedgedProvider | null;
  hedgeAfterMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Turn LLM with a hedged tail: if the primary has not answered within
 * `hedgeAfterMs`, the same request goes to the other provider and the
 * first successful result wins; the loser is aborted. A primary failure
 * fires the hedge at once. Without a hedge provider this is a pass-through.
 */
export class HedgedLlm implements Llm {
  private readonly primary: HedgedProvider;
  private readonly hedge: HedgedProvider | null;
  private readonly hedgeAfterMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(options: HedgedLlmOptions) {
    this.primary = options.primary;
    this.hedge = options.hedge ?? null;
    this.hedgeAfterMs = options.hedgeAfterMs ?? HEDGE_AFTER_MS;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
  }

  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    const started = this.now();
    if (!this.hedge) {
      const result = await this.callProvider(this.primary, input, input.signal);
      this.log(`hedge: fired=false winner=${this.primary.name} ms=${Math.round(this.now() - started)}`);
      return result;
    }
    const hedge = this.hedge;
    return new Promise<LlmChatResult>((resolve, reject) => {
      let settled = false;
      let fired = false;
      let primaryFailed = false;
      let hedgeFailed = false;
      let primaryError: unknown;
      let hedgeError: unknown;
      const primaryCtl = new AbortController();
      const hedgeCtl = new AbortController();
      const onCallerAbort = () => {
        primaryCtl.abort();
        hedgeCtl.abort();
      };
      if (input.signal?.aborted) {
        reject(abortError());
        return;
      }
      input.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const cleanup = () => input.signal?.removeEventListener("abort", onCallerAbort);

      const win = (name: HedgeProviderName, result: LlmChatResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (name === this.primary.name) hedgeCtl.abort();
        else primaryCtl.abort();
        cleanup();
        this.log(`hedge: fired=${fired} winner=${name} ms=${Math.round(this.now() - started)}`);
        resolve(result);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(hedgeError ?? primaryError ?? new Error("Hedged LLM request failed"));
      };
      const startHedge = () => {
        if (settled || fired) return;
        fired = true;
        this.callProvider(hedge, input, hedgeCtl.signal).then(
          (r) => win(hedge.name, r),
          (err: unknown) => {
            if (settled) return;
            if (input.signal?.aborted) {
              fail();
              return;
            }
            hedgeFailed = true;
            hedgeError = err;
            if (primaryFailed) fail();
            // Otherwise the primary is still in flight: let it decide.
          },
        );
      };
      const timer = setTimeout(startHedge, this.hedgeAfterMs);
      (timer as { unref?: () => void }).unref?.();
      this.callProvider(this.primary, input, primaryCtl.signal).then(
        (r) => win(this.primary.name, r),
        (err: unknown) => {
          if (settled) return;
          if (input.signal?.aborted) {
            primaryError = err;
            fail();
            return;
          }
          primaryFailed = true;
          primaryError = err;
          if (hedgeFailed) fail();
          else startHedge();
        },
      );
    });
  }

  private callProvider(provider: HedgedProvider, input: LlmChatInput, signal?: AbortSignal): Promise<LlmChatResult> {
    return provider.llm.chat({
      ...input,
      ...(provider.model ? { model: provider.model } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async generateStructured<T>(input: LlmStructuredInput<T>): Promise<T> {
    // Structured calls (scenarios, debrief) are not latency-critical turn
    // calls: they stay on the primary provider.
    return this.primary.llm.generateStructured({
      ...input,
      ...(this.primary.model && !input.model ? { model: this.primary.model } : {}),
    });
  }
}
