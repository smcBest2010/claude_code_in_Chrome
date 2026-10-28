import { randomBytes } from 'node:crypto';
import type { Logger } from './logger.js';
import type { MsgRef, Transport } from './types.js';

export type ApprovalDecision = 'allow' | 'deny' | 'timeout' | 'aborted' | 'undeliverable';

interface Pending {
  token: string;
  jobId: number;
  convId: string;
  requesterId: string;
  text: string;
  ref: MsgRef | null;
  timer: NodeJS.Timeout;
  resolve: (d: ApprovalDecision) => void;
}

const LABEL: Record<ApprovalDecision, string> = {
  allow: '승인됨',
  deny: '거절됨 — 작업을 종료합니다',
  timeout: '응답 시간 초과로 거절 — 작업을 종료합니다',
  aborted: '작업이 종료되어 요청이 무효화되었습니다',
  undeliverable: '승인 요청을 표시하지 못해 거절 처리했습니다',
};

/**
 * One pending approval per tool call. Only the requester can answer; anything else
 * (timeout, cancel, undeliverable message) resolves as a refusal — never as an approval.
 */
export class ApprovalManager {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly transport: Transport,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {}

  request(p: { jobId: number; convId: string; requesterId: string; text: string; signal?: AbortSignal }): Promise<ApprovalDecision> {
    if (p.signal?.aborted) return Promise.resolve('aborted');
    const token = randomBytes(12).toString('base64url');
    const decided = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.settle(token, 'timeout'), this.timeoutMs);
      this.pending.set(token, { token, jobId: p.jobId, convId: p.convId, requesterId: p.requesterId, text: p.text, ref: null, timer, resolve });
    });
    p.signal?.addEventListener('abort', () => this.settle(token, 'aborted'), { once: true });

    void this.transport
      .postApproval(p.convId, token, p.text, p.jobId)
      .then(async (ref) => {
        const entry = this.pending.get(token);
        if (!entry) {
          // Settled (timeout/abort) while the message was being posted: disable the buttons.
          if (ref) await this.transport.closeApproval(ref, `${p.text}\n\n${LABEL.aborted}`);
          return;
        }
        if (!ref) {
          this.settle(token, 'undeliverable');
          return;
        }
        entry.ref = ref;
      })
      .catch((e) => {
        this.log.warn('postApproval failed', e);
        this.settle(token, 'undeliverable');
      });
    return decided;
  }

  /** Called from the approve/deny buttons. The token must belong to the conversation the click came from. */
  handleClick(token: string, userId: string, decision: 'allow' | 'deny', convId: string): { ok: boolean; message: string } {
    const entry = this.pending.get(token);
    if (!entry || entry.convId !== convId) return { ok: false, message: '이미 처리되었거나 만료된 승인 요청입니다.' };
    if (userId !== entry.requesterId) return { ok: false, message: '이 작업을 요청한 사용자만 승인·거절할 수 있습니다.' };
    this.settle(token, decision);
    return { ok: true, message: LABEL[decision] };
  }

  cancelJob(jobId: number): void {
    for (const e of [...this.pending.values()]) if (e.jobId === jobId) this.settle(e.token, 'aborted');
  }

  cancelAll(): void {
    for (const token of [...this.pending.keys()]) this.settle(token, 'aborted');
  }

  hasPending(jobId: number): boolean {
    for (const e of this.pending.values()) if (e.jobId === jobId) return true;
    return false;
  }

  private settle(token: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(token);
    if (!entry) return;
    this.pending.delete(token);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    if (entry.ref) {
      void this.transport.closeApproval(entry.ref, `${entry.text}\n\n${LABEL[decision]}`).catch((e) => this.log.warn('closeApproval failed', e));
    }
  }
}
