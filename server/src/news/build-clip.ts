import type { DebriefNews, NewsTimelinePart } from "@hot-seat/shared";
import type { TextToSpeech } from "../providers/text-to-speech.js";
import type { OwnerAudioBuffer } from "../session/owner-audio.js";
import type { TimedTurn } from "../session/store.js";
import { assembleClip, collectTts, CLIP_SAMPLE_RATE } from "./clip.js";
import {
  computeCut,
  extractPcmSegment,
  fuzzyFindQuote,
  resamplePcm16,
  snapCut,
  type Cut,
} from "./soundbite.js";

export const NEWS_CLIP_VOICE_ID = "3WqHLnw80rOZqJzW9YRB"; // Daniel, the existing news voice
export const NEWS_CLIP_TTS_MODEL = "eleven_v4_turbo";
export const SOUNDBITE_CONFIDENCE = 0.75;

export interface LocatedSoundbite {
  located: true;
  cut: Cut;
  segmentPcm16: Uint8Array;
  score: number;
}

export interface UnlocatedSoundbite {
  located: false;
  reason: string;
}

export type SoundbiteLocation = LocatedSoundbite | UnlocatedSoundbite;

/** Locate the debrief soundbite in the owner's recorded audio. */
export function locateSoundbite(
  buffer: OwnerAudioBuffer | undefined | null,
  turns: readonly TimedTurn[],
  news: DebriefNews,
): SoundbiteLocation {
  if (!buffer) return { located: false, reason: "no owner audio was kept for this session" };
  const ownerTurns = turns.filter((t) => t.role === "user");
  const recordTurn = ownerTurns[news.soundbite_turn - 1];
  if (!recordTurn) {
    return { located: false, reason: `soundbite_turn ${news.soundbite_turn} has no matching owner turn` };
  }
  const audioTurn = buffer.turns[news.soundbite_turn - 1];
  if (!audioTurn) return { located: false, reason: "owner turn was not timed in the audio" };
  if (!audioTurn.wordTimes.length) return { located: false, reason: "no word times for the owner turn" };
  const match = fuzzyFindQuote(recordTurn.text, news.soundbite);
  if (!match) return { located: false, reason: "quote not found in the owner turn transcript" };
  if (match.score < SOUNDBITE_CONFIDENCE) {
    return { located: false, reason: `quote match too weak (${match.score.toFixed(2)})` };
  }
  const pcm = buffer.pcm();
  const cut = snapCut(pcm, 16000, computeCut(audioTurn.wordTimes, match, audioTurn.endStreamMs));
  const segmentPcm16 = extractPcmSegment(pcm, 16000, cut);
  if (!segmentPcm16.length) return { located: false, reason: "soundbite segment is empty" };
  return { located: true, cut, segmentPcm16, score: match.score };
}

export interface BuiltNewsClip {
  wav: Uint8Array;
  timeline: NewsTimelinePart[];
  soundbiteLocated: boolean;
  reason: string | null;
  cut: Cut | null;
}

/** Anchor (Daniel, eleven_v4_turbo) around the owner's own voice, or a read quote. */
export async function buildNewsClipAudio(opts: {
  news: DebriefNews;
  buffer: OwnerAudioBuffer | undefined | null;
  turns: readonly TimedTurn[];
  tts: TextToSpeech;
  voiceId?: string;
  log?: (line: string) => void;
}): Promise<BuiltNewsClip> {
  const voiceId = opts.voiceId ?? NEWS_CLIP_VOICE_ID;
  const ttsOpts = { voiceId, model: NEWS_CLIP_TTS_MODEL, outputFormat: "pcm_24000" as const };
  const location = locateSoundbite(opts.buffer, opts.turns, opts.news);
  if (!location.located) opts.log?.(`[news-clip] soundbite not located: ${location.reason}`);

  const introPcm = await collectTts(opts.tts, opts.news.anchor_intro, ttsOpts);
  let soundbitePcm: Uint8Array;
  let soundbiteText: string;
  if (location.located) {
    soundbitePcm = resamplePcm16(location.segmentPcm16, 16000, CLIP_SAMPLE_RATE);
    soundbiteText = opts.news.soundbite;
  } else {
    soundbiteText = `The owner told us, quote, ${opts.news.soundbite}`;
    soundbitePcm = await collectTts(opts.tts, soundbiteText, ttsOpts);
  }
  const outroPcm = await collectTts(opts.tts, opts.news.anchor_outro, ttsOpts);
  const { wav, timeline } = assembleClip([
    { part: "intro", text: opts.news.anchor_intro, pcm: introPcm },
    { part: "soundbite", text: soundbiteText, pcm: soundbitePcm },
    { part: "outro", text: opts.news.anchor_outro, pcm: outroPcm },
  ]);
  return {
    wav,
    timeline,
    soundbiteLocated: location.located,
    reason: location.located ? null : location.reason,
    cut: location.located ? location.cut : null,
  };
}
