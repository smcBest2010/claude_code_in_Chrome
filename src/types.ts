export type JobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'denied'
  | 'blocked'
  | 'interrupted';

export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running', 'awaiting_approval'];

/** The single local user. Access is gated by the web access token, so every authenticated request is this user. */
export const LOCAL_USER = 'local';

export interface ProjectConfig {
  name: string;
  /** Real (symlink-resolved) absolute path. */
  path: string;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageInput {
  name: string;
  mediaType: ImageMediaType;
  base64: string;
  bytes: number;
}

/** How a conversation message is rendered on the results page. */
export type MsgKind = 'user' | 'notice' | 'progress' | 'answer' | 'error' | 'approval';

export interface MsgMeta {
  jobId?: number;
  status?: string;
  durationMs?: number;
  costUsd?: number;
  imageCount?: number;
  mayHaveModified?: boolean;
}

export interface MsgRef {
  convId: string;
  messageId: number;
}

/**
 * Everything the core needs from the UI layer.
 * Implementations must never throw: failures are reported via null/false, so a broken
 * browser connection can never take a job (or the server) down.
 */
export interface Transport {
  send(convId: string, text: string, kind: MsgKind, meta?: MsgMeta): Promise<MsgRef | null>;
  edit(ref: MsgRef, text: string, meta?: MsgMeta): Promise<boolean>;
  postApproval(convId: string, token: string, text: string, jobId: number): Promise<MsgRef | null>;
  closeApproval(ref: MsgRef, text: string): Promise<void>;
  /** Conversation state (running/queued/broken…) changed; push it to open pages. */
  statusChanged(convId: string): void;
}

export type SessionLookup = 'here' | 'elsewhere' | 'missing' | 'error';
