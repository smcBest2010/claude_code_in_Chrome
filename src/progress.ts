import { truncate } from './format.js';
import type { MsgMeta, MsgRef, Transport } from './types.js';

/**
 * One "작업 과정" card per job, updated in place (throttled).
 * text = one step per line; meta.status = current state shown on the card.
 */
export class ProgressReporter {
  private ref: MsgRef | null = null;
  private readonly lines: string[] = [];
  private status = '실행 중';
  private readonly t0 = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private lastEdit = 0;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: Transport,
    private readonly convId: string,
    private readonly jobId: number,
    private readonly minIntervalMs = 700,
  ) {}

  async begin(status: string): Promise<void> {
    this.status = status;
    this.ref = await this.transport.send(this.convId, '', 'progress', this.meta());
  }

  add(line: string): void {
    if (this.closed || this.lines[this.lines.length - 1] === line) return;
    this.lines.push(truncate(line.replace(/\n/g, ' '), 200));
    if (this.lines.length > 40) this.lines.shift();
    this.schedule();
  }

  setStatus(status: string): void {
    if (this.closed || this.status === status) return;
    this.status = status;
    this.schedule();
  }

  async end(status: string): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status = status;
    await this.flush(true, Date.now() - this.t0);
  }

  private meta(durationMs?: number): MsgMeta {
    return { jobId: this.jobId, status: this.status, durationMs };
  }

  private schedule(): void {
    if (this.closed || this.timer || !this.ref) return;
    const wait = Math.max(0, this.lastEdit + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush(false);
    }, wait);
    this.timer.unref?.();
  }

  private flush(final: boolean, durationMs?: number): Promise<unknown> {
    // Serialize edits so an older state never overwrites a newer one.
    this.chain = this.chain.then(async () => {
      if (!this.ref || (!final && this.closed)) return;
      this.lastEdit = Date.now();
      await this.transport.edit(this.ref, this.lines.join('\n'), this.meta(durationMs));
    });
    return this.chain;
  }
}
