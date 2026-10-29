import { stripAudioTags, tagProsody, type VoiceHint } from "@hot-seat/shared";

export interface BrowserVoiceLike { name: string; lang: string; localService: boolean; default?: boolean }
export interface VoiceConfigEntry { names?: string[]; langPrefix?: string; rate: number; pitch: number; gender?: "female" | "male" }

/** Voice choice as config, not code paths. Only on-device English voices are eligible. */
export const VOICE_CONFIG: Record<string, VoiceConfigEntry> = {
  "reporter:relentless:male": { names: ["Daniel (Enhanced)", "Daniel (Premium)", "Daniel", "Alex (Enhanced)", "Alex"], rate: 1.05, pitch: 0.95, gender: "male" },
  "reporter:relentless:female": { names: ["Samantha (Enhanced)", "Samantha (Premium)", "Samantha", "Karen (Enhanced)", "Karen"], rate: 1.05, pitch: 1, gender: "female" },
  "reporter:precise:male": { names: ["Daniel (Enhanced)", "Daniel", "Alex"], rate: 0.98, pitch: 1, gender: "male" },
  "reporter:precise:female": { names: ["Samantha (Enhanced)", "Samantha", "Moira (Enhanced)", "Moira"], rate: 0.98, pitch: 1.05, gender: "female" },
  "reporter:human:male": { names: ["Alex (Enhanced)", "Alex", "Daniel"], rate: 0.95, pitch: 0.95, gender: "male" },
  "reporter:human:female": { names: ["Samantha (Enhanced)", "Samantha", "Karen"], rate: 0.95, pitch: 1, gender: "female" },
  radio: { names: ["Daniel (Enhanced)", "Daniel (Premium)", "Daniel"], langPrefix: "en-GB", rate: 0.95, pitch: 0.95 },
  anchor: { names: ["Daniel (Enhanced)", "Daniel (Premium)", "Daniel"], langPrefix: "en-GB", rate: 0.95, pitch: 0.95 },
};

export function localEnglishVoices<T extends BrowserVoiceLike>(voices: readonly T[]): T[] {
  return voices.filter((v) => v.localService === true && /^en([-_]|$)/i.test(v.lang));
}
export function pickVoice<T extends BrowserVoiceLike>(voices: readonly T[], hint?: VoiceHint): { voice: T | null; rate: number; pitch: number } {
  const key = hint?.role === "reporter" ? `reporter:${hint.temperament ?? "relentless"}:${hint.gender ?? "male"}` : (hint?.role ?? "reporter");
  const cfg = VOICE_CONFIG[key] ?? VOICE_CONFIG["reporter:relentless:male"]!;
  const local = localEnglishVoices(voices);
  for (const name of cfg.names ?? []) { const v = local.find((x) => x.name === name); if (v) return { voice: v, rate: cfg.rate, pitch: cfg.pitch }; }
  const enhanced = local.find((v) => /\(Enhanced\)|\(Premium\)/i.test(v.name) && (!cfg.langPrefix || v.lang.toLowerCase().startsWith(cfg.langPrefix.toLowerCase())));
  if (enhanced) return { voice: enhanced, rate: cfg.rate, pitch: cfg.pitch };
  if (cfg.langPrefix) { const v = local.find((x) => x.lang.toLowerCase().startsWith(cfg.langPrefix!.toLowerCase())); if (v) return { voice: v, rate: cfg.rate, pitch: cfg.pitch }; }
  return { voice: local[0] ?? null, rate: cfg.rate, pitch: cfg.pitch };
}
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
    const picked = pickVoice(voices as unknown as BrowserVoiceLike[], item.hint);
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
