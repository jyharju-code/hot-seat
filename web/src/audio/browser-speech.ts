import { stripAudioTags, tagProsody, type VoiceHint } from "@hot-seat/shared";

export interface BrowserVoiceLike { name: string; lang: string; localService: boolean; default?: boolean }
export interface VoiceConfigEntry { names?: string[]; langPrefix?: string; rate: number; pitch: number; gender?: "female" | "male" }

/** Base name before the first " (" or " [": browsers suffix quality and language differently. */
export function voiceBaseName(name: string): string {
  return name.split(/\s*[([]/)[0]!.trim();
}

/** Premium ranks above Enhanced, which ranks above a plain voice of the same base name. */
export function voiceQualityRank(name: string): number {
  if (/premium/i.test(name)) return 2;
  if (/enhanced/i.test(name)) return 1;
  return 0;
}

/** Novelty and Eloquence voices are never cast, not even as a last fallback. */
export const DENIED_VOICE_BASE_NAMES: readonly string[] = [
  // Eloquence
  "Eddy", "Flo", "Reed", "Rocko", "Sandy", "Shelley", "Grandma", "Grandpa",
  // Novelty
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Junior", "Kathy", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
];
const DENIED_SET = new Set(DENIED_VOICE_BASE_NAMES.map((n) => n.toLowerCase()));
export function isDeniedVoice(voice: BrowserVoiceLike): boolean {
  return DENIED_SET.has(voiceBaseName(voice.name).toLowerCase());
}

/** Voice choice as config, not code paths. Names are base names: quality suffixes are ranked, not matched literally. */
export const VOICE_CONFIG: Record<string, VoiceConfigEntry> = {
  "reporter:relentless:male": { names: ["Evan", "Arthur", "Daniel"], rate: 1.05, pitch: 0.95, gender: "male" },
  "reporter:relentless:female": { names: ["Ava", "Allison", "Samantha"], rate: 1.05, pitch: 1, gender: "female" },
  "reporter:precise:male": { names: ["Oliver", "Arthur", "Daniel"], rate: 0.98, pitch: 1, gender: "male" },
  "reporter:precise:female": { names: ["Serena", "Kate", "Karen"], rate: 0.98, pitch: 1.05, gender: "female" },
  "reporter:human:male": { names: ["Aaron", "Jamie", "Daniel"], rate: 0.95, pitch: 0.95, gender: "male" },
  "reporter:human:female": { names: ["Martha", "Stephanie", "Moira"], rate: 0.95, pitch: 1, gender: "female" },
  radio: { names: ["Jamie", "Arthur", "Daniel"], langPrefix: "en-GB", rate: 0.95, pitch: 0.95 },
  anchor: { names: ["Daniel", "Oliver"], langPrefix: "en-GB", rate: 0.95, pitch: 0.95 },
};

export function voiceConfigKey(hint?: VoiceHint): string {
  return hint?.role === "reporter" ? `reporter:${hint.temperament ?? "relentless"}:${hint.gender ?? "male"}` : (hint?.role ?? "reporter");
}

export function localEnglishVoices<T extends BrowserVoiceLike>(voices: readonly T[]): T[] {
  return voices.filter((v) => v.localService === true && /^en([-_]|$)/i.test(v.lang));
}

/** On-device English voices minus the deny list. */
export function allowedEnglishVoices<T extends BrowserVoiceLike>(voices: readonly T[]): T[] {
  return localEnglishVoices(voices).filter((v) => !isDeniedVoice(v));
}

function defaultEnglishVoice<T extends BrowserVoiceLike>(voices: readonly T[]): T | null {
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang) && !isDeniedVoice(v));
  return english.find((v) => v.default && v.localService) ?? english.find((v) => v.default) ?? null;
}

export interface PickVoiceOptions { excludeVoiceNames?: ReadonlySet<string> }

export function pickVoice<T extends BrowserVoiceLike>(voices: readonly T[], hint?: VoiceHint, opts?: PickVoiceOptions): { voice: T | null; rate: number; pitch: number } {
  const cfg = VOICE_CONFIG[voiceConfigKey(hint)] ?? VOICE_CONFIG["reporter:relentless:male"]!;
  const allowed = allowedEnglishVoices(voices);
  const excluded = opts?.excludeVoiceNames;
  const byBase = (base: string, skipExcluded: boolean): T | null => {
    const candidates = allowed
      .filter((v) => voiceBaseName(v.name).toLowerCase() === base.toLowerCase())
      .filter((v) => !skipExcluded || !excluded?.has(v.name))
      .sort((a, b) => {
        const langRank = (v: T) => (cfg.langPrefix && v.lang.toLowerCase().startsWith(cfg.langPrefix.toLowerCase()) ? 1 : 0);
        return langRank(b) - langRank(a) || voiceQualityRank(b.name) - voiceQualityRank(a.name);
      });
    return candidates[0] ?? null;
  };
  const anyAllowed = (skipExcluded: boolean): T | null => {
    const candidates = allowed
      .filter((v) => !skipExcluded || !excluded?.has(v.name))
      .sort((a, b) => voiceQualityRank(b.name) - voiceQualityRank(a.name));
    return candidates[0] ?? null;
  };
  // First pass respects session exclusions, second pass reuses a voice rather than staying silent.
  for (const skipExcluded of excluded && excluded.size > 0 ? [true, false] : [false]) {
    for (const base of cfg.names ?? []) {
      const v = byBase(base, skipExcluded);
      if (v) return { voice: v, rate: cfg.rate, pitch: cfg.pitch };
    }
    if (skipExcluded) {
      const alt = anyAllowed(true);
      if (alt) return { voice: alt, rate: cfg.rate, pitch: cfg.pitch };
    }
    const fallback = defaultEnglishVoice(voices);
    if (fallback && (!skipExcluded || !excluded?.has(fallback.name))) return { voice: fallback, rate: cfg.rate, pitch: cfg.pitch };
    if (skipExcluded) continue;
    // No cast voice and no flagged default: null lets the browser use its own default English voice.
    return { voice: null, rate: cfg.rate, pitch: cfg.pitch };
  }
  return { voice: null, rate: cfg.rate, pitch: cfg.pitch };
}

export interface VoiceCast { reporter: ReturnType<typeof pickVoice>; radio: ReturnType<typeof pickVoice>; anchor: ReturnType<typeof pickVoice> }

/** Resolve reporter, radio and anchor for one session, distinct whenever an alternative exists. */
export function castVoices<T extends BrowserVoiceLike>(voices: readonly T[], reporterHint?: VoiceHint): { reporter: { voice: T | null; rate: number; pitch: number }; radio: { voice: T | null; rate: number; pitch: number }; anchor: { voice: T | null; rate: number; pitch: number } } {
  const used = new Set<string>();
  const take = (hint: VoiceHint) => {
    const picked = pickVoice(voices, hint, { excludeVoiceNames: used });
    if (picked.voice) used.add(picked.voice.name);
    return picked;
  };
  const reporter = take(reporterHint?.role === "reporter" ? reporterHint : { role: "reporter", temperament: "relentless", gender: "male" });
  const radio = take({ role: "radio" });
  const anchor = take({ role: "anchor" });
  return { reporter, radio, anchor };
}

/** Per-session casting shared by the live session and the evening news player on the same page. */
export class VoiceCasting {
  private readonly byKey = new Map<string, string | null>();
  resolve<T extends BrowserVoiceLike>(voices: readonly T[], hint?: VoiceHint): { voice: T | null; rate: number; pitch: number } {
    const key = voiceConfigKey(hint);
    const cfg = VOICE_CONFIG[key] ?? VOICE_CONFIG["reporter:relentless:male"]!;
    const cached = this.byKey.get(key);
    if (cached !== undefined) {
      const voice = cached ? (allowedEnglishVoices(voices).find((v) => v.name === cached) ?? null) : null;
      return { voice, rate: cfg.rate, pitch: cfg.pitch };
    }
    const role = hint?.role ?? "reporter";
    const excluded = new Set([...this.byKey.entries()].filter(([k]) => !k.startsWith(`${role}:`) && k !== role).map(([, name]) => name).filter((n): n is string => Boolean(n)));
    const picked = pickVoice(voices, hint, { excludeVoiceNames: excluded });
    this.byKey.set(key, picked.voice?.name ?? null);
    return picked;
  }
  reset(): void { this.byKey.clear(); }
}

/** Shared session casting: one page session keeps reporter, radio and anchor apart. */
export const sharedVoiceCasting = new VoiceCasting();

/** Human-readable casting summary for the dev helper. */
export function voiceCastSummary(voices: readonly BrowserVoiceLike[], reporterHint?: VoiceHint): Array<{ role: string; voice: string }> {
  const rows: Array<{ role: string; voice: string }> = [];
  const hints: Array<[string, VoiceHint]> = [
    ["reporter:relentless:male", { role: "reporter", temperament: "relentless", gender: "male" }],
    ["reporter:relentless:female", { role: "reporter", temperament: "relentless", gender: "female" }],
    ["reporter:precise:male", { role: "reporter", temperament: "precise", gender: "male" }],
    ["reporter:precise:female", { role: "reporter", temperament: "precise", gender: "female" }],
    ["reporter:human:male", { role: "reporter", temperament: "human", gender: "male" }],
    ["reporter:human:female", { role: "reporter", temperament: "human", gender: "female" }],
    ["radio", { role: "radio" }],
    ["anchor", { role: "anchor" }],
  ];
  for (const [role, hint] of hints) rows.push({ role, voice: pickVoice(voices, hint).voice?.name ?? "(browser default)" });
  const cast = castVoices(voices, reporterHint);
  rows.push(
    { role: "session reporter", voice: cast.reporter.voice?.name ?? "(browser default)" },
    { role: "session radio", voice: cast.radio.voice?.name ?? "(browser default)" },
    { role: "session anchor", voice: cast.anchor.voice?.name ?? "(browser default)" },
  );
  return rows;
}

/** Dev-only helper: open the app with ?voices or call window.__hotSeatVoices() in the console. No user UI. */
export function installVoiceDevHelper(): void {
  const g = globalThis as unknown as { window?: unknown; location?: { search?: string }; speechSynthesis?: SpeechSynthesis; __hotSeatVoices?: () => void };
  if (typeof g.window === "undefined" || !g.speechSynthesis) return;
  const log = () => { try { console.table(voiceCastSummary(g.speechSynthesis!.getVoices() as unknown as BrowserVoiceLike[])); } catch { /* helper only */ } };
  g.__hotSeatVoices = log;
  (g.window as { __hotSeatVoices?: () => void }).__hotSeatVoices = log;
  if (g.location?.search && new URLSearchParams(g.location.search).has("voices")) {
    if (g.speechSynthesis.getVoices().length) log();
    g.speechSynthesis.addEventListener?.("voiceschanged", log);
  }
}
installVoiceDevHelper();
export function splitSentences(text: string): string[] {
  return stripAudioTags(text).match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}
export function sentenceTimeoutMs(sentence: string, rate = 1): number {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  return Math.max(3000, Math.round((words / 2.6) * 1000 / Math.max(0.5, rate)) + 2500);
}

export type SpeechFailureReason = "no_start" | "error";

export interface SpeakCallbacks {
  onStart?: () => void;
  onDone?: () => void;
  /** Audio gave up on this line (no_start: never started; error: utterance error). onDone still follows. */
  onFailed?: (reason: SpeechFailureReason) => void;
}

export interface BrowserSpeechDeps {
  synth?: SpeechSynthesis | null;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  onStart?: () => void;
  onDone?: () => void;
  onFailed?: (reason: SpeechFailureReason) => void;
  /** Session casting shared across speakers. Defaults to the shared page-session casting. */
  casting?: VoiceCasting;
  /** ms without onstart before a sentence is retried once, then given up. Default 1500. */
  startWatchdogMs?: number;
  /** Chrome long-session workaround cadence while speaking. Default 10000. */
  keepAliveMs?: number;
  /** Silent reading speed for a line whose audio gave up, words per second. Default 2.6. */
  readingWordsPerSecond?: number;
  /** Cap on the silent reading wait. Default 6000. */
  readingMaxMs?: number;
}

/** ms without onstart before a sentence is cancelled and spoken once more. */
export const SPEECH_START_WATCHDOG_MS = 1500;
/** While speaking, pause/resume on this cadence (Chrome long-utterance workaround). */
export const SPEECH_KEEPALIVE_MS = 10_000;
/** Silent reading speed for a line whose audio gave up, words per second. */
export const SPEECH_READING_WPS = 2.6;
/** Cap on the silent reading wait for a line whose audio gave up. */
export const SPEECH_READING_MAX_MS = 6000;

/** Silent reading wait for text whose audio gave up: ~2.6 words/s, at most 6 s. Exported for tests. */
export function readingTimeMs(text: string, wps = SPEECH_READING_WPS, maxMs = SPEECH_READING_MAX_MS): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(maxMs, Math.round((words / Math.max(0.5, wps)) * 1000));
}

interface ActiveSentence {
  watchdog: ReturnType<typeof setTimeout> | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  keepAlive: ReturnType<typeof setInterval> | null;
}

/** Queue of browser speech. Splits long text, guards stuck Chrome onend with per-sentence timeout,
 *  rescues a stalled Chrome queue with a start watchdog (cancel + one retry, then silent reading
 *  time so the interview continues), and nudges long utterances with pause/resume. */
export class BrowserSpeech {
  private queue: Array<{ text: string; hint?: VoiceHint; onStart?: () => void; onDone?: () => void; onFailed?: (reason: SpeechFailureReason) => void }> = [];
  private speaking = false;
  private generation = 0;
  private active: ActiveSentence = { watchdog: null, endTimer: null, keepAlive: null };
  constructor(private readonly deps: BrowserSpeechDeps = {}) {}
  private get synth(): SpeechSynthesis | null { return this.deps.synth !== undefined ? this.deps.synth : (typeof speechSynthesis !== "undefined" ? speechSynthesis : null); }
  get isSpeaking(): boolean { return this.speaking; }
  speak(text: string, hint?: VoiceHint, cbs?: SpeakCallbacks): void { this.queue.push({ text, hint, onStart: cbs?.onStart, onDone: cbs?.onDone, onFailed: cbs?.onFailed }); void this.pump(); }
  cancel(): void { this.generation++; this.queue = []; this.speaking = false; this.clearActive(); try { this.synth?.cancel(); } catch { /* ignore */ } }
  private clearActive(): void {
    if (this.active.watchdog) clearTimeout(this.active.watchdog);
    if (this.active.endTimer) clearTimeout(this.active.endTimer);
    if (this.active.keepAlive) clearInterval(this.active.keepAlive);
    this.active = { watchdog: null, endTimer: null, keepAlive: null };
  }
  /** Pre-speak hygiene for a stalled Chrome queue: resume a paused synth, and
   *  cancel a stale utterance when nothing of ours should be speaking. */
  private preSpeak(synth: SpeechSynthesis): void {
    try {
      if (synth.paused) synth.resume();
      if (this.queue.length === 0 && (synth.speaking || synth.pending)) synth.cancel();
    } catch { /* hygiene is best effort */ }
  }
  private notifyFailed(item: { onFailed?: (reason: SpeechFailureReason) => void }, reason: SpeechFailureReason, notified: { value: boolean }): void {
    if (notified.value) return;
    notified.value = true;
    try { item.onFailed?.(reason); } catch { /* ignore */ }
    try { this.deps.onFailed?.(reason); } catch { /* ignore */ }
  }
  private async pump(): Promise<void> {
    if (this.speaking) return;
    const item = this.queue.shift(); if (!item) return;
    this.speaking = true; const gen = this.generation;
    const synth = this.synth;
    if (!synth) { this.speaking = false; item.onDone?.(); this.deps.onDone?.(); void this.pump(); return; }
    // voices may load late
    let voices = synth.getVoices();
    if (!voices.length) { await new Promise<void>((r) => { const t = setTimeout(r, 300); const h = () => { clearTimeout(t); r(); }; synth.addEventListener?.("voiceschanged", h, { once: true } as AddEventListenerOptions); }); voices = synth.getVoices(); }
    const picked = (this.deps.casting ?? sharedVoiceCasting).resolve(voices as unknown as BrowserVoiceLike[], item.hint);
    const prosody = tagProsody(item.text);
    const sentences = splitSentences(item.text);
    const list = sentences.length ? sentences : [""];
    let started = false;
    const failedNotified = { value: false };
    const fireStart = () => { if (!started) { started = true; try { item.onStart?.(); } catch { /* ignore */ } try { this.deps.onStart?.(); } catch { /* ignore */ } } };
    const finishItem = () => {
      this.clearActive();
      this.speaking = false;
      if (gen === this.generation) { try { item.onDone?.(); } catch { /* ignore */ } try { this.deps.onDone?.(); } catch { /* ignore */ } void this.pump(); }
    };
    for (let i = 0; i < list.length; i++) {
      if (gen !== this.generation) return;
      const sentence = list[i]!;
      const result = await this.speakSentence(synth, sentence, picked, prosody, fireStart, gen, i === 0);
      if (result === "error") {
        this.notifyFailed(item, "error", failedNotified);
        // Give up on audio for this line: keep the visible text, wait a
        // short reading time over what is left, then finish so the
        // interview continues.
        await this.waitReading(list.slice(i + 1).join(" ") || sentence);
        if (gen !== this.generation) return;
        finishItem();
        return;
      }
      if (result === "no_start") {
        this.notifyFailed(item, "no_start", failedNotified);
        await this.waitReading(list.slice(i).join(" ") || sentence);
        if (gen !== this.generation) return;
        finishItem();
        return;
      }
    }
    finishItem();
  }
  private waitReading(text: string): Promise<void> {
    const ms = readingTimeMs(text, this.deps.readingWordsPerSecond ?? SPEECH_READING_WPS, this.deps.readingMaxMs ?? SPEECH_READING_MAX_MS);
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => { if (this.active.endTimer === t) this.active.endTimer = null; resolve(); }, ms);
      this.active.endTimer = t;
    });
  }
  /**
   * Speak one sentence with a start watchdog: no onstart within the watchdog
   * cancels and retries once; a second miss (or an error before start) gives
   * up. Returns "ok", "no_start" or "error".
   */
  private speakSentence(
    synth: SpeechSynthesis,
    sentence: string,
    picked: { voice: unknown; rate: number; pitch: number },
    prosody: { rate: number; pitch: number },
    fireStart: () => void,
    gen: number,
    firstOfLine: boolean,
  ): Promise<"ok" | "no_start" | "error"> {
    const watchdogMs = this.deps.startWatchdogMs ?? SPEECH_START_WATCHDOG_MS;
    const keepAliveMs = this.deps.keepAliveMs ?? SPEECH_KEEPALIVE_MS;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v: "ok" | "no_start" | "error") => {
        if (settled || gen !== this.generation) return;
        settled = true;
        this.clearActive();
        resolve(v);
      };
      const attempt = (retry: boolean): void => {
        if (gen !== this.generation) return;
        if (firstOfLine && !retry) this.preSpeak(synth);
        else {
          try { if (synth.paused) synth.resume(); } catch { /* best effort */ }
        }
        const u = this.deps.createUtterance ? this.deps.createUtterance(sentence) : new SpeechSynthesisUtterance(sentence);
        if (picked.voice) u.voice = picked.voice as unknown as SpeechSynthesisVoice;
        u.rate = Math.min(2, Math.max(0.5, picked.rate * prosody.rate)); u.pitch = Math.min(2, Math.max(0, picked.pitch * prosody.pitch));
        let startedUtterance = false;
        // A retried attempt supersedes this one: its late events are ignored.
        let dead = false;
        const armEnd = () => {
          if (this.active.endTimer) clearTimeout(this.active.endTimer);
          const timer = setTimeout(() => settle("ok"), sentenceTimeoutMs(sentence, u.rate));
          this.active.endTimer = timer;
        };
        const armKeepAlive = () => {
          if (this.active.keepAlive) clearInterval(this.active.keepAlive);
          // The usual Chrome workaround for long utterances stalling.
          this.active.keepAlive = setInterval(() => {
            try { synth.pause(); synth.resume(); } catch { /* best effort */ }
          }, keepAliveMs);
        };
        if (this.active.watchdog) clearTimeout(this.active.watchdog);
        this.active.watchdog = setTimeout(() => {
          this.active.watchdog = null;
          if (startedUtterance) return;
          dead = true;
          try { synth.cancel(); } catch { /* best effort */ }
          if (!retry) attempt(true);
          else settle("no_start");
        }, watchdogMs);
        u.onstart = () => {
          if (dead) return;
          startedUtterance = true;
          if (this.active.watchdog) { clearTimeout(this.active.watchdog); this.active.watchdog = null; }
          fireStart();
          armKeepAlive();
          armEnd();
        };
        u.onend = () => { if (!dead) settle("ok"); };
        u.onerror = () => {
          if (dead) return;
          // An error before start gets the same one retry as a silent stall.
          if (!startedUtterance && !retry) {
            if (this.active.watchdog) { clearTimeout(this.active.watchdog); this.active.watchdog = null; }
            dead = true;
            try { synth.cancel(); } catch { /* best effort */ }
            attempt(true);
            return;
          }
          settle(startedUtterance ? "error" : "no_start");
        };
        try {
          synth.speak(u);
        } catch {
          if (!retry) {
            try { synth.cancel(); } catch { /* best effort */ }
            attempt(true);
            return;
          }
          settle("no_start");
        }
      };
      attempt(false);
    });
  }
}
