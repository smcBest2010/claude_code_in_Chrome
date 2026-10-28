import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ACTIVE_STATUSES, type JobStatus, type MsgKind, type MsgMeta } from './types.js';

export interface ConvRow {
  conv_id: string;
  project: string;
  project_path: string;
  model: string | null;
  session_id: string | null;
  resume_broken: number;
  broken_reason: string | null;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface JobRow {
  id: number;
  conv_id: string;
  project: string;
  requester_id: string;
  status: JobStatus;
  prompt_preview: string;
  image_count: number;
  session_id: string | null;
  error: string | null;
  cost_usd: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface MessageRow {
  id: number;
  conv_id: string;
  kind: MsgKind;
  text: string;
  meta: MsgMeta | null;
  approval_token: string | null;
  approval_open: boolean;
  created_at: number;
  updated_at: number;
}

export class DbLockedError extends Error {
  constructor(file: string) {
    super(`DB가 다른 프로세스에서 사용 중입니다 (서버가 이미 실행 중인지 확인하세요): ${file}`);
    this.name = 'DbLockedError';
  }
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS conversations (
  conv_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  project_path TEXT NOT NULL,
  model TEXT,
  session_id TEXT,
  resume_broken INTEGER NOT NULL DEFAULT 0,
  broken_reason TEXT,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id TEXT NOT NULL,
  project TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_preview TEXT NOT NULL DEFAULT '',
  image_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  error TEXT,
  cost_usd REAL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  meta TEXT,
  approval_token TEXT,
  approval_open INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_conv ON jobs(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);
`;

const ACTIVE_SQL = `(${ACTIVE_STATUSES.map((s) => `'${s}'`).join(',')})`;

interface RawMessage extends Omit<MessageRow, 'meta' | 'approval_open'> {
  meta: string | null;
  approval_open: number;
}

function toMessage(r: RawMessage): MessageRow {
  let meta: MsgMeta | null = null;
  if (r.meta) {
    try {
      meta = JSON.parse(r.meta) as MsgMeta;
    } catch {
      meta = null;
    }
  }
  return { ...r, meta, approval_open: r.approval_open === 1 };
}

export class AppDb {
  private readonly db: Database.Database;

  constructor(readonly file: string, private readonly now: () => number = Date.now) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file, { timeout: 1500 });
    try {
      // Exclusive lock for the lifetime of the process: a second server on the same DB fails fast.
      this.db.pragma('locking_mode = EXCLUSIVE');
      this.db.pragma('journal_mode = WAL');
      this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
    } catch (e) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      if ((e as { code?: string }).code?.startsWith('SQLITE_BUSY')) throw new DbLockedError(file);
      throw e;
    }
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version < 1) {
      this.db.exec(SCHEMA_V1);
      this.db.pragma('user_version = 1');
    }
    if (version < 2) {
      if (version >= 1) this.db.exec('ALTER TABLE conversations ADD COLUMN model TEXT');
      this.db.pragma('user_version = 2');
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // ── conversations ───────────────────────────────────────

  getConv(convId: string): ConvRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE conv_id = ?').get(convId) as ConvRow | undefined;
  }

  listConvs(limit = 8): ConvRow[] {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit) as ConvRow[];
  }

  /** Create or rebind a conversation to a project + session. Clears the broken-resume flag. */
  bindConv(p: { convId: string; project: string; projectPath: string; sessionId: string | null; title?: string; model?: string }): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO conversations (conv_id, project, project_path, model, session_id, resume_broken, broken_reason, title, created_at, updated_at)
         VALUES (@convId, @project, @projectPath, @model, @sessionId, 0, NULL, @title, @t, @t)
         ON CONFLICT(conv_id) DO UPDATE SET project = excluded.project, project_path = excluded.project_path,
           model = COALESCE(excluded.model, conversations.model), session_id = excluded.session_id, resume_broken = 0, broken_reason = NULL,
           title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE conversations.title END, updated_at = excluded.updated_at`,
      )
      .run({ ...p, model: p.model ?? null, title: (p.title ?? '').slice(0, 120), t });
  }

  setTitleIfEmpty(convId: string, title: string): void {
    this.db.prepare(`UPDATE conversations SET title = ? WHERE conv_id = ? AND title = ''`).run(title.slice(0, 120), convId);
  }

  touchConv(convId: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE conv_id = ?').run(this.now(), convId);
  }

  setSession(convId: string, sessionId: string): void {
    this.db.prepare('UPDATE conversations SET session_id = ?, updated_at = ? WHERE conv_id = ?').run(sessionId, this.now(), convId);
  }

  /** The stored session id is kept on purpose: a failed resume never silently resets the conversation. */
  markResumeBroken(convId: string, reason: string): void {
    this.db
      .prepare('UPDATE conversations SET resume_broken = 1, broken_reason = ?, updated_at = ? WHERE conv_id = ?')
      .run(reason.slice(0, 500), this.now(), convId);
  }

  // ── jobs ────────────────────────────────────────────────

  createJob(p: { convId: string; project: string; requesterId: string; promptPreview: string; imageCount: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO jobs (conv_id, project, requester_id, status, prompt_preview, image_count, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(p.convId, p.project, p.requesterId, p.promptPreview.slice(0, 200), p.imageCount, this.now());
    return Number(r.lastInsertRowid);
  }

  getJob(id: number): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  /** Transition between active states only; a finished job never goes back to running. */
  setJobActiveStatus(id: number, status: 'running' | 'awaiting_approval', startedAt?: number): void {
    this.db
      .prepare(`UPDATE jobs SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ${ACTIVE_SQL}`)
      .run(status, startedAt ?? null, id);
  }

  finishJob(id: number, status: JobStatus, extra: { error?: string | null; costUsd?: number | null; sessionId?: string | null } = {}): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, error = ?, cost_usd = COALESCE(?, cost_usd), session_id = COALESCE(?, session_id), finished_at = ?
         WHERE id = ? AND status IN ${ACTIVE_SQL}`,
      )
      .run(status, extra.error ?? null, extra.costUsd ?? null, extra.sessionId ?? null, this.now(), id);
  }

  isJobActive(id: number): boolean {
    const row = this.getJob(id);
    return !!row && ACTIVE_STATUSES.includes(row.status);
  }

  /**
   * Startup recovery: jobs that were queued/running when the process died become `interrupted`
   * (never re-run), and approval cards left open are closed.
   */
  recoverUnfinished(): JobRow[] {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM jobs WHERE status IN ${ACTIVE_SQL} ORDER BY id`).all() as JobRow[];
      const t = this.now();
      this.db.prepare(`UPDATE jobs SET status = 'interrupted', error = 'server_restart', finished_at = ? WHERE status IN ${ACTIVE_SQL}`).run(t);
      this.db
        .prepare(`UPDATE messages SET approval_open = 0, text = text || char(10) || char(10) || '서버 재시작으로 무효화된 요청입니다', updated_at = ? WHERE approval_open = 1`)
        .run(t);
      return rows;
    });
    return tx();
  }

  lastJob(convId: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE conv_id = ? ORDER BY id DESC LIMIT 1').get(convId) as JobRow | undefined;
  }

  // ── messages ────────────────────────────────────────────

  insertMessage(p: { convId: string; kind: MsgKind; text: string; meta?: MsgMeta; approvalToken?: string }): MessageRow {
    const t = this.now();
    const r = this.db
      .prepare(
        `INSERT INTO messages (conv_id, kind, text, meta, approval_token, approval_open, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.convId, p.kind, p.text, p.meta ? JSON.stringify(p.meta) : null, p.approvalToken ?? null, p.approvalToken ? 1 : 0, t, t);
    return this.getMessage(Number(r.lastInsertRowid))!;
  }

  updateMessage(id: number, p: { text: string; meta?: MsgMeta; closeApproval?: boolean }): MessageRow | undefined {
    this.db
      .prepare(
        `UPDATE messages SET text = ?, meta = COALESCE(?, meta), approval_open = CASE WHEN ? THEN 0 ELSE approval_open END, updated_at = ? WHERE id = ?`,
      )
      .run(p.text, p.meta ? JSON.stringify(p.meta) : null, p.closeApproval ? 1 : 0, this.now(), id);
    return this.getMessage(id);
  }

  getMessage(id: number): MessageRow | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as RawMessage | undefined;
    return r ? toMessage(r) : undefined;
  }

  listMessages(convId: string, limit = 500): MessageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM (SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
      .all(convId, limit) as RawMessage[];
    return rows.map(toMessage);
  }
}
