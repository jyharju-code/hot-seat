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
  /** "race" (default when a second provider exists in production wiring):
   *  both providers start at once. "hedge": the second starts late. */
  mode?: "hedge" | "race";
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
  private readonly mode: "hedge" | "race";
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private lastWinnerValue: HedgeProviderName | null = null;

  constructor(options: HedgedLlmOptions) {
    this.primary = options.primary;
    this.hedge = options.hedge ?? null;
    this.hedgeAfterMs = options.hedgeAfterMs ?? HEDGE_AFTER_MS;
    this.mode = options.mode ?? "hedge";
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
  }

  /** Winner of the most recent chat call, or null before any call. */
  get lastWinner(): HedgeProviderName | null {
    return this.lastWinnerValue;
  }

  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    if (this.mode === "race" && this.hedge) return this.chatRace(input);
    const started = this.now();
    if (!this.hedge) {
      const result = await this.callProvider(this.primary, input, input.signal);
      this.lastWinnerValue = this.primary.name;
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
        this.lastWinnerValue = name;
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

  /** Both providers start at once; the first successful result wins. */
  private async chatRace(input: LlmChatInput): Promise<LlmChatResult> {
    const second = this.hedge!;
    const started = this.now();
    if (input.signal?.aborted) throw abortError();
    return new Promise<LlmChatResult>((resolve, reject) => {
      let settled = false;
      let failures = 0;
      let firstError: unknown;
      let loserMs: number | null = null;
      const ctls: Record<HedgeProviderName, AbortController> = {
        meta: new AbortController(),
        baseten: new AbortController(),
      };
      const onCallerAbort = () => {
        ctls.meta.abort();
        ctls.baseten.abort();
      };
      input.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const cleanup = () => input.signal?.removeEventListener("abort", onCallerAbort);
      const win = (name: HedgeProviderName, result: LlmChatResult) => {
        if (settled) return;
        settled = true;
        const other = name === this.primary.name ? second : this.primary;
        ctls[other.name].abort();
        cleanup();
        this.lastWinnerValue = name;
        this.log(
          `race: winner=${name} ms=${Math.round(this.now() - started)} loser_ms=${loserMs === null ? "aborted" : Math.round(loserMs)}`,
        );
        resolve(result);
      };
      const failOne = (err: unknown) => {
        if (settled) return;
        if (loserMs === null) loserMs = this.now() - started;
        if (firstError === undefined) firstError = err;
        failures += 1;
        if (input.signal?.aborted) {
          settled = true;
          cleanup();
          reject(abortError());
          return;
        }
        if (failures >= 2) {
          settled = true;
          cleanup();
          reject(firstError ?? new Error("Raced LLM request failed"));
        }
      };
      for (const provider of [this.primary, second]) {
        this.callProvider(provider, input, ctls[provider.name].signal).then(
          (r) => win(provider.name, r),
          failOne,
        );
      }
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
