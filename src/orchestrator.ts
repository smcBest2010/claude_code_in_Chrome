import { randomUUID } from 'node:crypto';
import type { ApprovalManager } from './approvals.js';
import type { AppConfig } from './config.js';
import type { AppDb, ConvRow, JobRow } from './db.js';
import { fmtDuration, inline, truncate } from './format.js';
import type { Logger } from './logger.js';
import { ProgressReporter } from './progress.js';
import type { Redactor } from './redact.js';
import { JobRun, type QueryFunction, type RunOutcome, type Termination } from './runner.js';
import { LOCAL_USER, type ImageInput, type MsgKind, type MsgMeta, type SessionLookup, type Transport } from './types.js';

export interface OrchestratorDeps {
  cfg: AppConfig;
  db: AppDb;
  transport: Transport;
  approvals: ApprovalManager;
  queryFn: QueryFunction;
  findSession: (id: string, dir?: string) => Promise<SessionLookup>;
  log: Logger;
  redactor: Redactor;
  childEnv: Record<string, string | undefined>;
  stopGraceMs?: number;
  progressIntervalMs?: number;
}

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string };

export interface ConvStatus {
  convId: string;
  title: string;
  project: string;
  projectPath: string;
  model: string | null;
  sessionId: string | null;
  resumeBroken: boolean;
  brokenReason: string | null;
  state: 'idle' | 'running' | 'awaiting_approval' | 'queued';
  runningJobId: number | null;
  queuedJobIds: number[];
  lastJob: { id: number; status: string; error: string | null; costUsd: number | null } | null;
  permissionMode: string;
}

interface QueuedJob {
  id: number;
  convId: string;
  project: string;
  requesterId: string;
  text: string;
  images: ImageInput[];
  model?: string;
}

interface ActiveJob {
  job: QueuedJob;
  run: JobRun | null;
  cancel: Termination | null;
  done: Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 20_000;
const MODEL_VALUE = /^[a-zA-Z0-9._-]+(?:\[[a-zA-Z0-9]+\])?$/;

const PARTIAL_WARNING = '작업 도중 파일 수정이나 명령 실행이 있었을 수 있습니다. 일부 변경이 남아 있을 수 있으니 `git status` / `git diff` 로 확인하세요.';

const STATUS_LABEL: Record<RunOutcome['status'], string> = {
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소됨',
  denied: '권한 거절로 종료',
  blocked: '보안 정책으로 차단되어 종료',
  interrupted: '중단됨',
};

export class Orchestrator {
  private readonly queues = new Map<string, QueuedJob[]>();
  private readonly active = new Map<string, ActiveJob>();
  private accepting = true;
  private recovered: JobRow[] = [];

  constructor(private readonly d: OrchestratorDeps) {}

  // ── startup recovery ───────────────────────────────────

  /** Call once at startup, before serving requests. Never re-runs anything. */
  recoverState(): JobRow[] {
    this.recovered = this.d.db.recoverUnfinished();
    if (this.recovered.length) this.d.log.warn(`restart recovery: ${this.recovered.length} unfinished job(s) marked interrupted`);
    return this.recovered;
  }

  /** Post one notice per affected conversation. */
  async notifyRecovered(): Promise<void> {
    const byConv = new Map<string, JobRow[]>();
    for (const j of this.recovered) byConv.set(j.conv_id, [...(byConv.get(j.conv_id) ?? []), j]);
    this.recovered = [];
    for (const [convId, jobs] of byConv) {
      const list = jobs.map((j) => `#${j.id}(${j.status === 'queued' ? '대기 중' : j.status === 'awaiting_approval' ? '승인 대기 중' : '실행 중'})`).join(', ');
      const wasRunning = jobs.some((j) => j.status !== 'queued');
      const lines = [
        `서버가 재시작되어 작업 ${list} 이(가) 중단되었습니다. 자동으로 다시 실행하지 않습니다.`,
        wasRunning ? PARTIAL_WARNING : '',
        '세션은 그대로 유지됩니다. 이어서 진행하려면 다시 입력해 주세요.',
      ].filter(Boolean);
      await this.say(convId, lines.join('\n'), 'notice');
    }
  }

  // ── conversations ──────────────────────────────────────

  async createConversation(projectName: string, text: string, images: ImageInput[], model?: string): Promise<Result<{ convId: string; jobId: number }>> {
    if (!this.accepting) return { ok: false, message: '서버가 종료 중입니다.' };
    const project = this.d.cfg.projects.get(projectName);
    if (!project) return { ok: false, message: `알 수 없는 프로젝트입니다: ${inline(projectName, 40)}` };
    const invalid = this.validateInput(text, images);
    if (invalid) return { ok: false, message: invalid };
    if (model && (model.length > 80 || !MODEL_VALUE.test(model))) return { ok: false, message: '모델 이름 형식이 올바르지 않습니다.' };
    const convId = randomUUID();
    this.d.db.bindConv({ convId, project: project.name, projectPath: project.path, sessionId: null, title: titleOf(text, images), model });
    const r = await this.sendMessage(convId, text, images);
    return r.ok ? { ok: true, convId, jobId: r.jobId } : r;
  }

  async sendMessage(convId: string, rawText: string, images: ImageInput[]): Promise<Result<{ jobId: number }>> {
    const { db, cfg } = this.d;
    if (!this.accepting) return { ok: false, message: '서버가 종료 중입니다.' };
    const conv = db.getConv(convId);
    if (!conv) return { ok: false, message: '대화를 찾을 수 없습니다.' };
    const text = rawText.trim();
    const invalid = this.validateInput(text, images);
    if (invalid) return { ok: false, message: invalid };
    const blocker = this.convBlocker(conv);
    if (blocker) return { ok: false, message: blocker };
    if (this.pendingCount(convId) >= cfg.maxPendingPerConversation) {
      return { ok: false, message: `대기 중인 요청이 너무 많습니다 (최대 ${cfg.maxPendingPerConversation}개). 진행 중인 작업이 끝난 뒤 보내거나 중지하세요.` };
    }

    const jobId = db.createJob({ convId, project: conv.project, requesterId: LOCAL_USER, promptPreview: text, imageCount: images.length });
    db.setTitleIfEmpty(convId, titleOf(text, images));
    db.touchConv(convId);
    await this.say(convId, text, 'user', { jobId, imageCount: images.length });

    const job: QueuedJob = { id: jobId, convId, project: conv.project, requesterId: LOCAL_USER, text, images, model: conv.model ?? undefined };
    const queue = this.queues.get(job.project) ?? [];
    queue.push(job);
    this.queues.set(job.project, queue);
    const ahead = queue.length - 1 + (this.active.has(job.project) ? 1 : 0);
    if (ahead > 0) await this.say(convId, `작업 #${jobId} 대기열 등록 · 같은 프로젝트의 앞선 작업 ${ahead}개가 끝나면 시작합니다.`, 'notice');
    this.d.transport.statusChanged(convId);
    this.pump(job.project);
    return { ok: true, jobId };
  }

  /** Start a fresh Claude session in this conversation (explicit user action only). */
  newSession(convId: string, projectName?: string): Result {
    const { db, cfg } = this.d;
    const conv = db.getConv(convId);
    if (!conv) return { ok: false, message: '대화를 찾을 수 없습니다.' };
    if (this.pendingCount(convId) > 0) return { ok: false, message: '실행/대기 중인 작업이 있습니다. 중지한 뒤 다시 시도하세요.' };
    const project = cfg.projects.get(projectName ?? conv.project);
    if (!project) return { ok: false, message: `알 수 없는 프로젝트입니다: ${inline(projectName ?? conv.project, 40)}` };
    db.bindConv({ convId, project: project.name, projectPath: project.path, sessionId: null });
    const old = conv.session_id;
    void this.say(
      convId,
      [`새 Claude 세션을 시작합니다 · 프로젝트 \`${project.name}\`. 다음 입력부터 새 대화로 처리됩니다.`, old ? `이전 세션 ID: \`${old}\`` : ''].filter(Boolean).join('\n'),
      'notice',
    );
    this.d.transport.statusChanged(convId);
    return { ok: true };
  }

  /** Attach an existing Claude Code session (e.g. one started in the terminal) as a new conversation. */
  async resumeSession(sessionId: string, projectName: string): Promise<Result<{ convId: string }>> {
    if (!this.accepting) return { ok: false, message: '서버가 종료 중입니다.' };
    const sid = sessionId.trim();
    if (!UUID.test(sid)) return { ok: false, message: '세션 ID 형식이 올바르지 않습니다 (UUID).' };
    const project = this.d.cfg.projects.get(projectName);
    if (!project) return { ok: false, message: `알 수 없는 프로젝트입니다: ${inline(projectName, 40)}` };
    const check = await this.checkSession(sid, project.path, project.name);
    if (check) return { ok: false, message: check };
    const convId = randomUUID();
    this.d.db.bindConv({ convId, project: project.name, projectPath: project.path, sessionId: sid, title: `세션 ${sid.slice(0, 8)} 이어가기` });
    await this.say(convId, `세션 \`${sid}\` 을(를) 이어갑니다 · 프로젝트 \`${project.name}\`. 입력하면 이어서 작업합니다.`, 'notice');
    return { ok: true, convId };
  }

  /** Re-validate the stored session after a resume failure; clears the broken flag only if the session exists. */
  async recheckSession(convId: string): Promise<Result> {
    const { db, cfg } = this.d;
    const conv = db.getConv(convId);
    if (!conv) return { ok: false, message: '대화를 찾을 수 없습니다.' };
    if (this.pendingCount(convId) > 0) return { ok: false, message: '실행/대기 중인 작업이 있습니다.' };
    if (!conv.session_id) return { ok: false, message: '이어갈 세션이 없습니다. 새 세션으로 시작하세요.' };
    const project = cfg.projects.get(conv.project);
    if (!project) return { ok: false, message: `프로젝트 \`${conv.project}\` 가 설정에서 제거되었습니다. 새 세션으로 시작하세요.` };
    const check = await this.checkSession(conv.session_id, project.path, project.name);
    if (check) return { ok: false, message: check };
    db.bindConv({ convId, project: project.name, projectPath: project.path, sessionId: conv.session_id });
    await this.say(convId, `세션 \`${conv.session_id}\` 을(를) 확인했습니다. 다음 입력부터 이어서 진행합니다.`, 'notice');
    this.d.transport.statusChanged(convId);
    return { ok: true };
  }

  private async checkSession(sid: string, dir: string, projectName: string): Promise<string | null> {
    const found = await this.d.findSession(sid, dir).catch(() => 'error' as const);
    if (found === 'error') return '세션 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요.';
    if (found === 'missing') return `세션 \`${sid}\` 을(를) 이 PC에서 찾을 수 없습니다. 새 세션으로 시작하세요.`;
    if (found === 'elsewhere') return `세션 \`${sid}\` 은(는) 프로젝트 \`${projectName}\` 에서 만든 세션이 아닙니다.`;
    return null;
  }

  stop(convId: string): Result<{ runningId: number | null; removed: number[] }> {
    if (!this.d.db.getConv(convId)) return { ok: false, message: '대화를 찾을 수 없습니다.' };
    const r = this.cancelConvJobs(convId, { kind: 'cancelled', reason: '중지 버튼으로 작업을 취소했습니다' });
    if (r.runningId === null && r.removed.length === 0) return { ok: false, message: '취소할 작업이 없습니다.' };
    if (r.removed.length) void this.say(convId, `대기 중이던 작업 ${r.removed.map((id) => `#${id}`).join(', ')} 을(를) 취소했습니다.`, 'notice');
    this.d.transport.statusChanged(convId);
    return { ok: true, ...r };
  }

  approve(convId: string, token: string, decision: 'allow' | 'deny'): Result {
    const r = this.d.approvals.handleClick(token, LOCAL_USER, decision, convId);
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  }

  status(convId: string): ConvStatus | undefined {
    const { db, cfg } = this.d;
    const conv = db.getConv(convId);
    if (!conv) return undefined;
    const activeEntry = [...this.active.values()].find((a) => a.job.convId === convId);
    const queued = [...this.queues.values()].flat().filter((j) => j.convId === convId);
    const last = db.lastJob(convId);
    let state: ConvStatus['state'] = 'idle';
    if (activeEntry) state = db.getJob(activeEntry.job.id)?.status === 'awaiting_approval' ? 'awaiting_approval' : 'running';
    else if (queued.length) state = 'queued';
    return {
      convId,
      title: conv.title,
      project: conv.project,
      projectPath: conv.project_path,
      model: conv.model,
      sessionId: conv.session_id,
      resumeBroken: conv.resume_broken === 1,
      brokenReason: conv.broken_reason,
      state,
      runningJobId: activeEntry?.job.id ?? null,
      queuedJobIds: queued.map((j) => j.id),
      lastJob: last ? { id: last.id, status: last.status, error: last.error, costUsd: last.cost_usd } : null,
      permissionMode: cfg.permissionMode,
    };
  }

  recentConversations(limit = 8): { convId: string; title: string; project: string; updatedAt: number; busy: boolean }[] {
    return this.d.db.listConvs(limit).map((c) => ({ convId: c.conv_id, title: c.title || '(제목 없음)', project: c.project, updatedAt: c.updated_at, busy: this.pendingCount(c.conv_id) > 0 }));
  }

  // ── validation helpers ─────────────────────────────────

  private validateInput(text: string, images: ImageInput[]): string | null {
    if (!text.trim() && images.length === 0) return '내용을 입력하거나 이미지를 첨부하세요.';
    if (text.length > MAX_TEXT) return `입력이 너무 깁니다 (최대 ${MAX_TEXT.toLocaleString()}자).`;
    return null;
  }

  private convBlocker(conv: ConvRow): string | null {
    if (conv.resume_broken) {
      return `이 대화의 세션 \`${conv.session_id ?? '?'}\` 을(를) 이어갈 수 없는 상태입니다. 새 세션으로 시작하거나 세션을 다시 확인하세요.`;
    }
    const project = this.d.cfg.projects.get(conv.project);
    if (!project) return `프로젝트 \`${conv.project}\` 가 설정에서 제거되었습니다. 새 세션으로 다른 프로젝트를 지정하세요.`;
    if (project.path !== conv.project_path) {
      return `프로젝트 \`${conv.project}\` 의 경로가 바뀌었습니다 (${conv.project_path} → ${project.path}). 기존 세션과 맞지 않으므로 새 세션으로 시작하거나 세션을 다시 확인하세요.`;
    }
    return null;
  }

  private pendingCount(convId: string): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.filter((j) => j.convId === convId).length;
    for (const a of this.active.values()) if (a.job.convId === convId) n += 1;
    return n;
  }

  // ── queue (one job at a time per project) ──────────────

  private pump(project: string): void {
    if (this.active.has(project)) return;
    const job = this.queues.get(project)?.shift();
    if (!job) return;
    const entry: ActiveJob = { job, run: null, cancel: null, done: Promise.resolve() };
    this.active.set(project, entry);
    entry.done = this.execute(entry)
      .catch((e) => this.d.log.error(`job #${job.id} crashed`, e))
      .finally(() => {
        // Always release the project lock and make sure the job is final in the DB.
        this.d.approvals.cancelJob(job.id);
        try {
          if (this.d.db.isJobActive(job.id)) this.d.db.finishJob(job.id, 'failed', { error: 'internal_error' });
        } catch (e) {
          this.d.log.error('finalize job', e);
        }
        if (this.active.get(project) === entry) this.active.delete(project);
        this.d.transport.statusChanged(job.convId);
        setImmediate(() => this.pump(project));
      });
  }

  private async execute(entry: ActiveJob): Promise<void> {
    const { db, cfg, log } = this.d;
    const { job } = entry;
    const conv = db.getConv(job.convId);
    if (!conv) {
      db.finishJob(job.id, 'cancelled', { error: 'conversation_missing' });
      return;
    }
    if (entry.cancel) {
      db.finishJob(job.id, entry.cancel.kind === 'interrupted' ? 'interrupted' : 'cancelled', { error: entry.cancel.reason });
      return;
    }
    const blocker = this.convBlocker(conv);
    if (blocker) {
      db.finishJob(job.id, 'failed', { error: 'blocked_by_conversation_state' });
      await this.say(job.convId, `작업 #${job.id} 을(를) 실행하지 않았습니다. ${blocker}`, 'error', { jobId: job.id, status: 'failed' });
      return;
    }
    const project = cfg.projects.get(conv.project)!;

    db.setJobActiveStatus(job.id, 'running', Date.now());
    this.d.transport.statusChanged(job.convId);
    const resume = conv.session_id;
    const progress = new ProgressReporter(this.d.transport, job.convId, job.id, this.d.progressIntervalMs);
    await progress.begin(resume ? '세션 이어서 실행 중' : '새 세션으로 실행 중');

    const run = new JobRun({
      jobId: job.id,
      convId: job.convId,
      requesterId: job.requesterId,
      project,
      resumeSessionId: resume,
      text: job.text,
      images: job.images,
      cfg: { ...cfg, model: job.model || cfg.model },
      queryFn: this.d.queryFn,
      approvals: this.d.approvals,
      log,
      redactor: this.d.redactor,
      childEnv: this.d.childEnv,
      findSession: this.d.findSession,
      stopGraceMs: this.d.stopGraceMs,
      onSessionId: (id) => {
        try {
          db.setSession(job.convId, id);
        } catch (e) {
          log.error('setSession', e);
        }
        this.d.transport.statusChanged(job.convId);
      },
      onState: (s) => {
        try {
          db.setJobActiveStatus(job.id, s);
        } catch (e) {
          log.error('setJobActiveStatus', e);
        }
        progress.setStatus(s === 'awaiting_approval' ? '승인 대기 중' : '실행 중');
        this.d.transport.statusChanged(job.convId);
      },
      onProgress: (line) => progress.add(line),
    });
    entry.run = run;
    if (entry.cancel) run.stop(entry.cancel);

    let outcome: RunOutcome;
    try {
      outcome = await run.start();
    } catch (e) {
      log.error(`job #${job.id} runner threw`, e);
      outcome = { status: 'failed', category: 'sdk', text: '내부 오류로 작업이 중단되었습니다.', resumeFailed: false, sessionId: resume, durationMs: 0, mayHaveModified: true };
    } finally {
      this.d.approvals.cancelJob(job.id);
      entry.job.images = []; // release image buffers
    }

    if (outcome.resumeFailed) db.markResumeBroken(job.convId, outcome.text);
    db.finishJob(job.id, outcome.status, {
      error: outcome.status === 'succeeded' ? null : `${outcome.category ?? outcome.status}: ${truncate(outcome.text, 300)}`,
      costUsd: outcome.costUsd ?? null,
      sessionId: outcome.sessionId,
    });
    db.touchConv(job.convId);
    log.info(`job #${job.id} ${outcome.status}${outcome.category ? `/${outcome.category}` : ''} in ${fmtDuration(outcome.durationMs)}`);

    await progress.end(STATUS_LABEL[outcome.status]);
    const meta: MsgMeta = { jobId: job.id, status: outcome.status, durationMs: outcome.durationMs, costUsd: outcome.costUsd, mayHaveModified: outcome.mayHaveModified };
    if (outcome.status === 'succeeded') {
      await this.say(job.convId, outcome.text, 'answer', meta);
    } else {
      const lines = [`**작업 #${job.id} ${STATUS_LABEL[outcome.status]}**`, outcome.text];
      if (outcome.mayHaveModified) lines.push(PARTIAL_WARNING);
      if (outcome.status === 'denied' || outcome.status === 'blocked') lines.push('이 작업만 종료했습니다. 같은 요청을 자동으로 재시도하지 않습니다.');
      await this.say(job.convId, lines.join('\n\n'), 'error', meta);
    }
  }

  private cancelConvJobs(convId: string, t: Termination): { runningId: number | null; removed: number[] } {
    const removed: number[] = [];
    for (const [project, q] of this.queues) {
      this.queues.set(
        project,
        q.filter((j) => {
          if (j.convId !== convId) return true;
          removed.push(j.id);
          this.d.db.finishJob(j.id, t.kind === 'interrupted' ? 'interrupted' : 'cancelled', { error: t.reason });
          return false;
        }),
      );
    }
    let runningId: number | null = null;
    for (const a of this.active.values()) {
      if (a.job.convId !== convId) continue;
      runningId = a.job.id;
      if (!a.cancel) a.cancel = t;
      a.run?.stop(t);
    }
    return { runningId, removed };
  }

  // ── lifecycle ──────────────────────────────────────────

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.accepting = false;
    const t: Termination = { kind: 'interrupted', reason: '서버가 종료되어 작업을 중단했습니다' };
    for (const q of this.queues.values()) for (const j of q) this.d.db.finishJob(j.id, 'interrupted', { error: 'shutdown' });
    this.queues.clear();
    const running = [...this.active.values()];
    for (const a of running) {
      if (!a.cancel) a.cancel = t;
      a.run?.stop(t);
    }
    this.d.approvals.cancelAll();
    await Promise.race([Promise.allSettled(running.map((a) => a.done)), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
  }

  /** Resolves when nothing is running or queued (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.active.values()].map((a) => a.done);
      if (!pending.length && [...this.queues.values()].every((q) => q.length === 0)) return;
      await Promise.allSettled(pending);
      await new Promise((r) => setImmediate(r));
    }
  }

  private async say(convId: string, text: string, kind: MsgKind, meta?: MsgMeta): Promise<void> {
    const r = await this.d.transport.send(convId, this.d.redactor.redact(text), kind, meta);
    if (!r) this.d.log.warn(`could not store a message for conversation ${convId}`);
  }
}

function titleOf(text: string, images: ImageInput[]): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return truncate(t || `이미지 ${images.length}장`, 60);
}
