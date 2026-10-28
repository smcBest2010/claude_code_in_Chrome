import type {
  CanUseTool,
  HookCallback,
  Options,
  PreToolUseHookInput,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalManager } from './approvals.js';
import type { AppConfig } from './config.js';
import { approvalBody, describeTool, inline } from './format.js';
import type { Logger } from './logger.js';
import { checkToolCall, MODIFYING_TOOLS } from './pathGuard.js';
import type { Redactor } from './redact.js';
import type { ImageInput, ProjectConfig, SessionLookup } from './types.js';

export type QueryFunction = typeof sdkQuery;

export type TerminationKind = 'cancelled' | 'denied' | 'timeout' | 'blocked' | 'interrupted';
export interface Termination {
  kind: TerminationKind;
  reason: string;
}

export type FailureCategory = 'auth' | 'billing' | 'rate_limit' | 'overloaded' | 'max_turns' | 'budget' | 'resume' | 'sdk' | 'no_result' | 'api';

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'denied' | 'blocked' | 'interrupted';
  category?: FailureCategory;
  /** Succeeded: Claude's final answer. Otherwise: user-facing reason. */
  text: string;
  resumeFailed: boolean;
  sessionId: string | null;
  costUsd?: number;
  durationMs: number;
  /** A file-changing or command tool was requested at least once. */
  mayHaveModified: boolean;
}

export interface RunParams {
  jobId: number;
  convId: string;
  requesterId: string;
  project: ProjectConfig;
  resumeSessionId: string | null;
  text: string;
  images: ImageInput[];
  cfg: Pick<AppConfig, 'permissionMode' | 'model' | 'maxTurns' | 'settingSources' | 'claudeExecutable' | 'approvalTimeoutMs' | 'botDir'>;
  queryFn: QueryFunction;
  approvals: ApprovalManager;
  log: Logger;
  redactor: Redactor;
  childEnv: Record<string, string | undefined>;
  findSession: (id: string, dir?: string) => Promise<SessionLookup>;
  onSessionId: (id: string) => void;
  onState: (s: 'running' | 'awaiting_approval') => void;
  onProgress: (line: string) => void;
  /** Time between a graceful interrupt and a hard abort. */
  stopGraceMs?: number;
}

const SYSTEM_APPEND = [
  'You are being operated remotely by the project owner through a private local web page. They cannot see your terminal.',
  'Work only inside the current project directory.',
  'Finish with a concise summary in Korean: what you changed (file paths) and how to verify it.',
  'Never print secrets, tokens, API keys, or the contents of credential files.',
  'If a tool call is denied or blocked, stop and explain why; do not retry it or look for a workaround.',
].join('\n');

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']);
const NO_CONVERSATION = /No conversation found with session ID/i;

const STOP_MESSAGE_FOR_CLAUDE = 'The user did not approve this action. The task is being stopped now. Do not retry this action or attempt a workaround.';

export class JobRun {
  private readonly abort = new AbortController();
  private q: Query | null = null;
  private term: Termination | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private closeInput: () => void = () => {};
  private mayHaveModified = false;

  constructor(private readonly p: RunParams) {}

  /** Stop this job only. Graceful interrupt first, hard abort after the grace period. First reason wins. */
  stop(t: Termination): void {
    if (!this.term) this.term = t;
    this.p.approvals.cancelJob(this.p.jobId);
    if (!this.q) return; // start() checks `term` right after the query is created
    const q = this.q;
    setImmediate(() => {
      q.interrupt().catch(() => {});
      this.closeInput();
    });
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => this.abort.abort(), this.p.stopGraceMs ?? 15_000);
    }
  }

  get termination(): Termination | null {
    return this.term;
  }

  private buildOptions(): Options {
    const { p } = this;
    const guard: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const pre = input as PreToolUseHookInput;
      if (this.term) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Task is being stopped.' } };
      }
      const verdict = checkToolCall(pre.tool_name, pre.tool_input, p.project.path, pre.cwd || p.project.path, p.cfg.botDir);
      if (verdict.kind === 'deny') {
        p.log.warn(`job #${p.jobId} security block: ${verdict.reason}`);
        this.stop({ kind: 'blocked', reason: verdict.reason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${verdict.reason}. This task is stopped by the security policy; do not retry.`,
          },
        };
      }
      if (verdict.kind === 'ask' && p.cfg.permissionMode !== 'bypassPermissions') {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: verdict.reason } };
      }
      return {};
    };

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      if (this.term) return { behavior: 'deny', message: 'Task is being stopped.', interrupt: true };
      if (MODIFYING_TOOLS.has(toolName)) this.mayHaveModified = true;
      if (p.cfg.permissionMode === 'bypassPermissions') {
        const verdict = checkToolCall(toolName, input, p.project.path, p.project.path, p.cfg.botDir);
        if (verdict.kind === 'deny') {
          this.stop({ kind: 'blocked', reason: verdict.reason });
          return { behavior: 'deny', message: verdict.reason, interrupt: true };
        }
        return { behavior: 'allow', updatedInput: input };
      }
      p.onState('awaiting_approval');
      const text = p.redactor.redact(
        approvalBody(p.jobId, toolName, input, p.project.path, { title: opts.title, decisionReason: opts.decisionReason, blockedPath: opts.blockedPath }, p.cfg.approvalTimeoutMs),
      );
      const decision = await p.approvals.request({ jobId: p.jobId, convId: p.convId, requesterId: p.requesterId, text, signal: opts.signal });
      if (this.term) return { behavior: 'deny', message: 'Task is being stopped.', interrupt: true };
      p.onState('running');
      if (decision === 'allow') return { behavior: 'allow', updatedInput: input };

      const tool = inline(toolName, 40);
      const t: Termination =
        decision === 'timeout'
          ? { kind: 'timeout', reason: `\`${tool}\` 권한 요청에 ${Math.round(p.cfg.approvalTimeoutMs / 60000)}분 동안 응답이 없어 거절했습니다` }
          : decision === 'undeliverable'
            ? { kind: 'denied', reason: `\`${tool}\` 권한 요청을 화면에 표시하지 못해 안전하게 거절했습니다` }
            : decision === 'aborted'
              ? { kind: 'cancelled', reason: '작업이 취소되었습니다' }
              : { kind: 'denied', reason: `\`${tool}\` 사용을 거절했습니다` };
      this.stop(t);
      return { behavior: 'deny', message: STOP_MESSAGE_FOR_CLAUDE, interrupt: true };
    };

    return {
      cwd: p.project.path,
      resume: p.resumeSessionId ?? undefined,
      permissionMode: p.cfg.permissionMode,
      allowDangerouslySkipPermissions: p.cfg.permissionMode === 'bypassPermissions',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [guard] }] },
      // Clarifying questions come back as plain text; the user replies in the thread.
      disallowedTools: ['AskUserQuestion'],
      settingSources: p.cfg.settingSources,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
      env: p.childEnv,
      abortController: this.abort,
      model: p.cfg.model,
      maxTurns: p.cfg.maxTurns,
      pathToClaudeCodeExecutable: p.cfg.claudeExecutable,
      stderr: (d: string) => p.log.debug(`[claude stderr] ${d.trim().slice(0, 500)}`),
    };
  }

  async start(): Promise<RunOutcome> {
    const { p } = this;
    const t0 = Date.now();
    let inputClosed = false;
    let releaseInput!: () => void;
    const inputDone = new Promise<void>((r) => (releaseInput = r));
    this.closeInput = () => {
      if (!inputClosed) {
        inputClosed = true;
        releaseInput();
      }
    };

    const content: SDKUserMessage['message']['content'] = [
      { type: 'text', text: p.text || '첨부한 이미지를 확인해 주세요.' },
      ...p.images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 } })),
    ];

    const closeInput = () => this.closeInput();
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
      // Keep stdin open until the result arrives: permission prompts travel over this stream.
      await inputDone;
    }

    let initSessionId: string | null = null;
    let sessionMismatch = false;
    let result: SDKResultMessage | null = null;
    let assistantError: string | undefined;
    let authStatusError: string | undefined;
    let rateLimitResetsAt: number | undefined;
    let rateLimited = false;
    let lastText = '';
    let thrown: unknown;

    try {
      this.q = p.queryFn({ prompt: input(), options: this.buildOptions() });
      if (this.term) this.stop(this.term); // stop() arrived before the query existed
      for await (const m of this.q as AsyncIterable<SDKMessage>) {
        switch (m.type) {
          case 'system':
            if (m.subtype === 'init') {
              initSessionId = m.session_id;
              if (p.resumeSessionId && m.session_id !== p.resumeSessionId) {
                // The CLI would start a different conversation: never let that happen silently.
                sessionMismatch = true;
                p.log.warn(`job #${p.jobId}: resume ${p.resumeSessionId} produced session ${m.session_id}; aborting`);
                this.abort.abort();
              } else {
                p.onSessionId(m.session_id);
              }
            }
            break;
          case 'assistant': {
            if (m.error) assistantError = m.error;
            if (m.parent_tool_use_id === null) {
              const texts: string[] = [];
              for (const b of m.message.content) {
                if (b.type === 'text' && b.text.trim()) texts.push(b.text);
                if (b.type === 'tool_use') {
                  if (MODIFYING_TOOLS.has(b.name)) this.mayHaveModified = true;
                  p.onProgress(p.redactor.redact(describeTool(b.name, (b.input ?? {}) as Record<string, unknown>, p.project.path)));
                }
              }
              if (texts.length) lastText = texts.join('\n');
            } else {
              for (const b of m.message.content) if (b.type === 'tool_use' && MODIFYING_TOOLS.has(b.name)) this.mayHaveModified = true;
            }
            break;
          }
          case 'rate_limit_event':
            if (m.rate_limit_info.status === 'rejected') {
              rateLimited = true;
              rateLimitResetsAt = m.rate_limit_info.resetsAt;
            }
            break;
          case 'auth_status':
            if (m.error) authStatusError = m.error;
            break;
          case 'result':
            result = m;
            closeInput();
            break;
          default:
            break;
        }
      }
    } catch (e) {
      thrown = e;
    } finally {
      closeInput();
      if (this.killTimer) clearTimeout(this.killTimer);
      try {
        this.q?.close();
      } catch {
        /* already closed */
      }
    }

    const base = {
      durationMs: Date.now() - t0,
      mayHaveModified: this.mayHaveModified,
      sessionId: sessionMismatch ? p.resumeSessionId : (initSessionId ?? p.resumeSessionId),
      costUsd: result?.total_cost_usd,
    };
    const errorText = p.redactor.redact(
      [
        ...(result && result.subtype !== 'success' ? result.errors : []),
        thrown instanceof Error ? thrown.message : thrown !== undefined ? String(thrown) : '',
      ]
        .filter(Boolean)
        .join(' / '),
    );

    // 1) Resume produced a different session id → refuse, keep the stored id.
    if (sessionMismatch) {
      return { ...base, status: 'failed', category: 'resume', resumeFailed: true, text: resumeFailedText(p.resumeSessionId!) };
    }

    // 2) Explicit termination (user stop, denial, timeout, security block, shutdown).
    if (this.term) {
      const status = this.term.kind === 'timeout' ? 'denied' : this.term.kind;
      return { ...base, status, resumeFailed: false, text: this.term.reason };
    }

    // 3) Resume target missing.
    if (p.resumeSessionId && !initSessionId && (thrown !== undefined || result?.is_error)) {
      let missing = NO_CONVERSATION.test(errorText);
      if (!missing) missing = (await p.findSession(p.resumeSessionId).catch(() => 'error' as const)) === 'missing';
      if (missing) return { ...base, status: 'failed', category: 'resume', resumeFailed: true, text: resumeFailedText(p.resumeSessionId) };
    }

    // 4) Success.
    if (result && result.subtype === 'success' && !result.is_error) {
      return { ...base, status: 'succeeded', resumeFailed: false, text: result.result?.trim() || lastText || '(응답 텍스트 없음)' };
    }

    // 5) Classified failures. Nothing is retried automatically.
    const fail = (category: FailureCategory, text: string): RunOutcome => ({ ...base, status: 'failed', category, resumeFailed: false, text });
    if (assistantError === 'billing_error') return fail('billing', '결제/크레딧 문제로 요청이 거부되었습니다. Anthropic 계정의 결제 상태를 확인하세요.');
    if (authStatusError || (assistantError && AUTH_ERRORS.has(assistantError))) {
      return fail('auth', '인증에 실패했습니다. 봇이 실행 중인 PC에서 Claude Code 인증 상태(`claude` 로그인 또는 `ANTHROPIC_API_KEY`)를 확인하세요.');
    }
    if (rateLimited || assistantError === 'rate_limit') {
      const when = rateLimitResetsAt
        ? ` 재설정 시각: ${new Date(rateLimitResetsAt > 1e12 ? rateLimitResetsAt : rateLimitResetsAt * 1000).toLocaleString('ko-KR', { hour12: false })}.`
        : '';
      return fail('rate_limit', `사용량 한도에 도달했습니다.${when} 자동으로 재시도하지 않습니다. 한도가 풀린 뒤 다시 요청하세요.`);
    }
    if (assistantError === 'overloaded' || assistantError === 'server_error') {
      return fail('overloaded', 'Anthropic API가 일시적으로 응답하지 않습니다(과부하/서버 오류). 잠시 후 다시 요청하세요.');
    }
    if (result?.subtype === 'error_max_turns') return fail('max_turns', `최대 턴 수에 도달해 중단되었습니다 (CLAUDE_MAX_TURNS=${p.cfg.maxTurns ?? '기본값'}).`);
    if (result?.subtype === 'error_max_budget_usd') return fail('budget', '설정된 예산 한도에 도달해 중단되었습니다.');
    if (!result && thrown !== undefined) {
      const msg = errorText.split('\n')[0] ?? '';
      if (/ENOENT|spawn|not found.*claude|executable/i.test(msg)) {
        return fail('sdk', `Claude Code 실행 파일을 시작하지 못했습니다: ${inline(msg, 300)}`);
      }
      return fail('sdk', `Claude Code 실행 중 오류가 발생했습니다: ${inline(msg || '알 수 없는 오류', 300)}`);
    }
    if (!result) return fail('no_result', 'Claude Code가 결과 없이 종료되었습니다.');
    return fail('api', `작업이 오류로 끝났습니다: ${inline(errorText || result.subtype, 400)}`);
  }
}

function resumeFailedText(sessionId: string): string {
  return [
    `저장된 세션 \`${sessionId}\` 을(를) 이어갈 수 없습니다. 대화를 임의로 초기화하지 않았습니다.`,
    '새로 시작하려면 **새 세션** 버튼을, 세션을 다시 확인하려면 **세션 다시 확인** 버튼을 누르세요.',
  ].join('\n');
}
