import type { AppDb, MessageRow } from './db.js';
import type { Logger } from './logger.js';
import type { Redactor } from './redact.js';
import type { MsgKind, MsgMeta, MsgRef, Transport } from './types.js';

export interface PublicMessage {
  id: number;
  kind: MsgKind;
  text: string;
  meta: MsgMeta | null;
  /** Present only while the approval is still open. */
  approval: { token: string } | null;
  createdAt: number;
  updatedAt: number;
}

export function toPublic(m: MessageRow): PublicMessage {
  return {
    id: m.id,
    kind: m.kind,
    text: m.text,
    meta: m.meta,
    approval: m.kind === 'approval' && m.approval_open && m.approval_token ? { token: m.approval_token } : null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

type Listener = (event: string, data: unknown) => void;

/** Fan-out of conversation events to open browser tabs (SSE). */
export class Hub {
  private readonly subs = new Map<string, Set<Listener>>();

  subscribe(convId: string, fn: Listener): () => void {
    const set = this.subs.get(convId) ?? new Set<Listener>();
    set.add(fn);
    this.subs.set(convId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.subs.delete(convId);
    };
  }

  publish(convId: string, event: string, data: unknown): void {
    for (const fn of this.subs.get(convId) ?? []) {
      try {
        fn(event, data);
      } catch {
        /* a broken connection must not affect others */
      }
    }
  }

  get connectionCount(): number {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }
}

/** Stores every message in SQLite (so pages survive reloads/restarts) and pushes it live. Never throws. */
export class WebTransport implements Transport {
  private statusFn: (convId: string) => unknown = () => undefined;

  constructor(
    private readonly db: AppDb,
    private readonly hub: Hub,
    private readonly redactor: Redactor,
    private readonly log: Logger,
  ) {}

  setStatusProvider(fn: (convId: string) => unknown): void {
    this.statusFn = fn;
  }

  async send(convId: string, text: string, kind: MsgKind, meta?: MsgMeta): Promise<MsgRef | null> {
    try {
      const row = this.db.insertMessage({ convId, kind, text: this.redactor.redact(text), meta });
      this.hub.publish(convId, 'message', toPublic(row));
      return { convId, messageId: row.id };
    } catch (e) {
      this.log.error('store message failed', e);
      return null;
    }
  }

  async edit(ref: MsgRef, text: string, meta?: MsgMeta): Promise<boolean> {
    try {
      const row = this.db.updateMessage(ref.messageId, { text: this.redactor.redact(text), meta });
      if (!row) return false;
      this.hub.publish(ref.convId, 'message', toPublic(row));
      return true;
    } catch (e) {
      this.log.error('update message failed', e);
      return false;
    }
  }

  async postApproval(convId: string, token: string, text: string, jobId: number): Promise<MsgRef | null> {
    try {
      const row = this.db.insertMessage({ convId, kind: 'approval', text: this.redactor.redact(text), meta: { jobId }, approvalToken: token });
      this.hub.publish(convId, 'message', toPublic(row));
      return { convId, messageId: row.id };
    } catch (e) {
      this.log.error('store approval failed', e);
      return null;
    }
  }

  async closeApproval(ref: MsgRef, text: string): Promise<void> {
    try {
      const row = this.db.updateMessage(ref.messageId, { text: this.redactor.redact(text), closeApproval: true });
      if (row) this.hub.publish(ref.convId, 'message', toPublic(row));
    } catch (e) {
      this.log.error('close approval failed', e);
    }
  }

  statusChanged(convId: string): void {
    try {
      const s = this.statusFn(convId);
      if (s) this.hub.publish(convId, 'status', s);
    } catch (e) {
      this.log.warn('status publish failed', e);
    }
  }
}
