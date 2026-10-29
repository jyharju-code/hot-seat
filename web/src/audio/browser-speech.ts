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

export interface BrowserSpeechDeps {
  synth?: SpeechSynthesis | null;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  onStart?: () => void;
  onDone?: () => void;
  /** Session casting shared across speakers. Defaults to the shared page-session casting. */
  casting?: VoiceCasting;
}

/** Queue of browser speech. Splits long text, guards stuck Chrome onend with per-sentence timeout. */
export class BrowserSpeech {
  private queue: Array<{ text: string; hint?: VoiceHint; onStart?: () => void; onDone?: () => void }> = [];
  private speaking = false;
  private generation = 0;
  constructor(private readonly deps: BrowserSpeechDeps = {}) {}
  private get synth(): SpeechSynthesis | null { return this.deps.synth !== undefined ? this.deps.synth : (typeof speechSynthesis !== "undefined" ? speechSynthesis : null); }
  get isSpeaking(): boolean { return this.speaking; }
  speak(text: string, hint?: VoiceHint, cbs?: { onStart?: () => void; onDone?: () => void }): void { this.queue.push({ text, hint, onStart: cbs?.onStart, onDone: cbs?.onDone }); void this.pump(); }
  cancel(): void { this.generation++; this.queue = []; this.speaking = false; try { this.synth?.cancel(); } catch { /* ignore */ } }
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
    let started = false;
    for (const sentence of sentences.length ? sentences : [""]) {
      if (gen !== this.generation) return;
      await new Promise<void>((resolve) => {
        const u = this.deps.createUtterance ? this.deps.createUtterance(sentence) : new SpeechSynthesisUtterance(sentence);
        if (picked.voice) u.voice = picked.voice as unknown as SpeechSynthesisVoice;
        u.rate = Math.min(2, Math.max(0.5, picked.rate * prosody.rate)); u.pitch = Math.min(2, Math.max(0, picked.pitch * prosody.pitch));
        let done = false; const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(finish, sentenceTimeoutMs(sentence, u.rate));
        u.onstart = () => { if (!started) { started = true; item.onStart?.(); this.deps.onStart?.(); } };
        u.onend = finish; u.onerror = finish;
        try { synth.speak(u); } catch { finish(); }
      });
    }
    this.speaking = false;
    if (gen === this.generation) { item.onDone?.(); this.deps.onDone?.(); void this.pump(); }
  }
}
