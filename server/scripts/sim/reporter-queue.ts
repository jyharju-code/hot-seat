/** Reporter lines as a queue. The message handler fills lines; each turn
 *  consumes exactly one ended line and plays it back for its real duration. */

export interface ReporterLine {
  text: string;
  /** PCM bytes received for this line (24 kHz PCM16 server audio: 48 bytes/ms). */
  audioBytes: number;
  ended: boolean;
}

/** Playback duration: real PCM in ElevenLabs mode; estimated (2.6 wps) in browser mode (no audio). */
export function linePlaybackMs(line: ReporterLine): number {
  if (line.audioBytes > 0) return Math.round(line.audioBytes / 48);
  const words = line.text.replace(/\[[^\]]*\]/g, "").split(/\s+/).filter(Boolean).length;
  return Math.round((words / 2.6) * 1000);
}

export class ReporterLineQueue {
  private readonly lines: ReporterLine[] = [];
  private filling: ReporterLine | null = null;

  private ensureFilling(): ReporterLine {
    if (!this.filling) {
      this.filling = { text: "", audioBytes: 0, ended: false };
      this.lines.push(this.filling);
    }
    return this.filling;
  }

  /** A reporter transcript starts (or labels) the line being received. */
  noteText(text: string): void {
    const line = this.ensureFilling();
    line.text = text;
  }

  noteAudio(bytes: number): void {
    this.ensureFilling().audioBytes += Math.max(0, bytes);
  }

  noteAudioEnd(): void {
    const line = this.ensureFilling();
    line.ended = true;
    this.filling = null;
  }

  /** The oldest line, once fully received. Not consumed. */
  peekEnded(): ReporterLine | undefined {
    const head = this.lines[0];
    return head?.ended ? head : undefined;
  }

  hasEndedLine(): boolean {
    return this.peekEnded() !== undefined;
  }

  /** Consume exactly one ended line. Returns undefined until it has ended,
   *  so a line that finished early is still delivered exactly once. */
  consume(): ReporterLine | undefined {
    if (!this.hasEndedLine()) return undefined;
    return this.lines.shift();
  }

  get pendingCount(): number {
    return this.lines.length;
  }
}
