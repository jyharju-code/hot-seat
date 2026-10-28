import type { SessionResult } from "./client.js";
import { mean, median, worst } from "./metrics.js";

export interface ProfileSummary {
  profile: string;
  sessions: number;
  turns: number;
  median_latency_ms: number | null;
  worst_latency_ms: number | null;
  splits: number;
  mean_wer: number | null;
  interrupts: number;
  repeats: number;
  errors: number;
  failures: number;
}

export function summarize(results: readonly SessionResult[]): ProfileSummary[] {
  const byProfile = new Map<string, SessionResult[]>();
  for (const r of results) {
    const list = byProfile.get(r.profile) ?? [];
    list.push(r);
    byProfile.set(r.profile, list);
  }
  return [...byProfile.entries()].map(([profile, sessions]) => {
    const turns = sessions.flatMap((s) => s.turns);
    const latencies = turns.map((t) => t.latency_ms).filter((v): v is number => v !== null);
    const wers = turns.map((t) => t.wer).filter((v): v is number => v !== null);
    return {
      profile,
      sessions: sessions.length,
      turns: turns.length,
      median_latency_ms: median(latencies),
      worst_latency_ms: worst(latencies),
      splits: turns.filter((t) => t.split).length,
      mean_wer: mean(wers),
      interrupts: turns.filter((t) => t.interrupted).length,
      repeats: turns.filter((t) => t.repeat).length,
      errors: sessions.reduce((sum, s) => sum + s.errors + s.turns.reduce((a, t) => a + t.errors, 0), 0),
      failures: sessions.filter((s) => s.failure !== null).length,
    };
  });
}

const fmt = (v: number | null, digits = 0): string =>
  v === null ? "n/a" : v.toFixed(digits);

export function summaryTable(summaries: readonly ProfileSummary[]): string {
  const header =
    "| profile | turns | median latency ms | worst latency ms | splits | mean WER | interrupts | repeats | errors | failures |\n" +
    "|---|---|---|---|---|---|---|---|---|---|";
  const rows = summaries.map(
    (s) =>
      `| ${s.profile} | ${s.turns} | ${fmt(s.median_latency_ms)} | ${fmt(s.worst_latency_ms)} | ${s.splits} | ${fmt(s.mean_wer, 3)} | ${s.interrupts} | ${s.repeats} | ${s.errors} | ${s.failures} |`,
  );
  return [header, ...rows].join("\n");
}

export function buildReport(results: readonly SessionResult[], meta: { preset: string; turns: number; at: string }): string {
  const summaries = summarize(results);
  const lines: string[] = [
    `# Sim report: ${meta.at}`,
    "",
    `Preset: ${meta.preset}. Requested turns per session: ${meta.turns}.`,
    "",
    summaryTable(summaries),
    "",
  ];
  for (const s of results) {
    if (s.debrief) {
      lines.push(
        `Debrief (${s.profile}): debrief ${s.debrief.debrief_ms ?? s.debrief.ms} ms, front page ${s.debrief.front_page_ms ?? "n/a"} ms (${s.debrief.front_page ? "ready" : "missing"})` +
          (s.debrief.headline ? `, headline: ${s.debrief.headline}` : "") +
          `, news clip ${s.debrief.news_clip_ms ?? "n/a"} ms (${s.debrief.news_clip ? "ready" : "missing"}, soundbite ${s.debrief.soundbite_located === null || s.debrief.soundbite_located === undefined ? "unknown" : s.debrief.soundbite_located ? "located" : "not located"})`,
        "",
      );
    }
  }
  for (const session of results) {
    lines.push(`## Session: ${session.profile} (${session.session_id ?? "no session id"})`, "");
    if (session.failure) lines.push(`Failure: ${session.failure}`, "");
    for (const turn of session.turns) {
      lines.push(
        `- turn ${turn.turn}: latency ${turn.latency_ms === null ? "n/a" : `${turn.latency_ms} ms`}, wer ${turn.wer === null ? "n/a" : turn.wer.toFixed(3)}, split ${turn.split}, interrupted ${turn.interrupted}, repeat ${turn.repeat}, errors ${turn.errors}, reporter words ${turn.reporter_words}`,
      );
    }
    lines.push("", "Transcript:", "");
    for (const line of session.transcript) lines.push(`- ${line.role}: ${line.text}`);
    lines.push("");
  }
  return lines.join("\n");
}
