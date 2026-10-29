import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Options, PreToolUseHookInput, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalManager } from '../src/approvals.js';
import { buildChildEnv } from '../src/childEnv.js';
import { ConfigError, loadConfig, type AppConfig } from '../src/config.js';
import { AppDb, DbLockedError } from '../src/db.js';
import { ImageError, validateUploads } from '../src/images.js';
import { createLogger } from '../src/logger.js';
import { Orchestrator } from '../src/orchestrator.js';
import { checkToolCall } from '../src/pathGuard.js';
import { ModelCatalog } from '../src/models.js';
import { Redactor } from '../src/redact.js';
import type { QueryFunction } from '../src/runner.js';
import { createServer } from '../src/server.js';
import type { SessionLookup } from '../src/types.js';
import { Hub, WebTransport } from '../src/webTransport.js';

// ── fixtures ──────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
fs.mkdirSync(path.join(TMP, 'ws'), { recursive: true });
const WS = fs.realpathSync(path.join(TMP, 'ws'));
const PROJ_A = path.join(WS, 'alpha');
const PROJ_B = path.join(WS, 'beta');
for (const d of [PROJ_A, PROJ_B]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PROJ_A, '.env'), 'X=1');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const SECRET = 'sk-ant-api03-SUPERSECRETVALUE1234567890';
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    webHost: '127.0.0.1',
    webPort: 0,
    workspaceRoot: WS,
    botDir: path.join(WS, 'bot'),
    projects: new Map([
      ['alpha', { name: 'alpha', path: PROJ_A }],
      ['beta', { name: 'beta', path: PROJ_B }],
    ]),
    dbPath: ':memory:',
    permissionMode: 'default',
    approvalTimeoutMs: 5_000,
    maxImageBytes: 1024 * 1024,
    maxImages: 2,
    maxPendingPerConversation: 3,
    settingSources: [],
    logLevel: 'error',
    ...over,
  };
}

// ── fake Agent SDK ────────────────────────────────────────

interface FakeCtx {
  options: Options;
  prompt: SDKUserMessage;
  interrupted: () => boolean;
  aborted: () => boolean;
  /** Resolves when interrupted or aborted. */
  stopped: Promise<void>;
  callTool(name: string, input: Record<string, unknown>): Promise<{ hook: unknown; perm?: unknown }>;
}
type Script = (ctx: FakeCtx) => AsyncGenerator<SDKMessage>;

const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid }) as unknown as SDKMessage;
const say = (text: string, sid: string, extra: object = {}) =>
  ({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { content: [{ type: 'text', text }] }, ...extra }) as unknown as SDKMessage;
const toolUse = (name: string, input: object, sid: string) =>
  ({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { content: [{ type: 'tool_use', id: 't', name, input }] } }) as unknown as SDKMessage;
const ok = (text: string, sid: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0.01 }) as unknown as SDKMessage;
const errResult = (errors: string[], sid: string) =>
  ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors, session_id: sid, total_cost_usd: 0 }) as unknown as SDKMessage;

class FakeSdk {
  calls: Options[] = [];
  running = 0;
  maxRunning = 0;
  constructor(public script: Script) {}

  readonly queryFn: QueryFunction = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const sdk = this;
    const options = params.options;
    sdk.calls.push(options);
    let interrupted = false;
    let wake: () => void = () => {};
    const stopped = new Promise<void>((r) => (wake = r));
    options.abortController?.signal.addEventListener('abort', () => wake());
    const promptIt = params.prompt[Symbol.asyncIterator]();
    async function* run(): AsyncGenerator<SDKMessage> {
      sdk.running++;
      sdk.maxRunning = Math.max(sdk.maxRunning, sdk.running);
      try {
        const first = (await promptIt.next()).value as SDKUserMessage;
        const ctx: FakeCtx = {
          options,
          prompt: first,
          interrupted: () => interrupted,
          aborted: () => !!options.abortController?.signal.aborted,
          stopped,
          async callTool(name, input) {
            const pre: PreToolUseHookInput = { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: options.cwd! };
            const hook = await options.hooks!.PreToolUse![0]!.hooks[0]!(pre, 't', { signal: new AbortController().signal });
            const decision = (hook as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
            if (decision === 'deny') return { hook };
            const perm = await options.canUseTool!(name, input, { signal: options.abortController!.signal, toolUseID: 't', requestId: 'r' } as never);
            return { hook, perm };
          },
        };
        for await (const m of sdk.script(ctx)) {
          if (options.abortController?.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          yield m;
        }
      } finally {
        sdk.running--;
        void promptIt.return?.();
      }
    }
    const gen = run();
    return Object.assign(gen, {
      interrupt: async () => {
        interrupted = true;
        wake();
        return undefined;
      },
      close: () => void gen.return(undefined),
    });
  }) as unknown as QueryFunction;
}

// ── harness ───────────────────────────────────────────────

interface Harness {
  db: AppDb;
  orch: Orchestrator;
  sdk: FakeSdk;
  approvals: ApprovalManager;
  /** decision applied to every approval card as it appears; null = leave it pending */
  decide: { value: 'allow' | 'deny' | null };
  msgs(convId: string): { kind: string; text: string }[];
}

function harness(script: Script, over: Partial<AppConfig> = {}, dbFile = ':memory:', sessions: Record<string, SessionLookup> = {}): Harness {
  const c = cfg({ ...over, dbPath: dbFile });
  const redactor = new Redactor([SECRET]);
  const log = createLogger(redactor, 'error', () => {});
  const db = new AppDb(dbFile);
  const hub = new Hub();
  const transport = new WebTransport(db, hub, redactor, log);
  const approvals = new ApprovalManager(transport, c.approvalTimeoutMs, log);
  const sdk = new FakeSdk(script);
  const decide: Harness['decide'] = { value: 'allow' };
  const orch = new Orchestrator({
    cfg: c,
    db,
    transport,
    approvals,
    queryFn: sdk.queryFn,
    findSession: async (id) => sessions[id] ?? 'missing',
    log,
    redactor,
    childEnv: {},
    stopGraceMs: 200,
    progressIntervalMs: 0,
  });
  transport.setStatusProvider((id) => orch.status(id));
  // Auto-answer approvals by watching every conversation's stream.
  const origSend = transport.postApproval.bind(transport);
  transport.postApproval = async (convId, token, text, jobId) => {
    const ref = await origSend(convId, token, text, jobId);
    if (decide.value) {
      const d = decide.value;
      setTimeout(() => orch.approve(convId, token, d), 5);
    }
    return ref;
  };
  return { db, orch, sdk, approvals, decide, msgs: (id) => db.listMessages(id).map((m) => ({ kind: m.kind, text: m.text })) };
}

async function start(h: Harness, project: string, text: string) {
  const r = await h.orch.createConversation(project, text, []);
  assert.ok(r.ok, (r as { message?: string }).message);
  await h.orch.idle();
  return r as { ok: true; convId: string; jobId: number };
}

// ── scenarios ─────────────────────────────────────────────

describe('정상 대화 · 세션 저장 · 재개 · 재시작', () => {
  test('model picker comes from Claude Code and caches per project', async () => {
    let launches = 0;
    let closes = 0;
    const fake = (() => {
      launches++;
      return {
        supportedModels: async () => [
          { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: '' },
          { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: '' },
        ],
        close: () => { closes++; },
      };
    }) as unknown as QueryFunction;
    const catalog = new ModelCatalog(cfg(), {}, fake);
    assert.deepEqual((await catalog.list('alpha')).map((m) => m.value), ['default', 'claude-fable-5-1[1m]']);
    await catalog.list('alpha');
    assert.equal(launches, 1);
    assert.equal(closes, 1);
    await catalog.list('beta');
    assert.equal(launches, 2);
  });

  test('selected model persists across requests and invalid models are refused', async () => {
    const dbFile = path.join(TMP, 'model-persistence.sqlite');
    const script: Script = async function* () { yield init(S1); yield ok('done', S1); };
    let h = harness(script, {}, dbFile);
    const created = await h.orch.createConversation('alpha', '첫 요청', [], 'opus');
    assert.ok(created.ok);
    const convId = (created as { convId: string }).convId;
    await h.orch.idle();
    assert.equal(h.sdk.calls[0]!.model, 'opus');
    assert.ok((await h.orch.sendMessage(convId, '다음 요청', [])).ok);
    await h.orch.idle();
    assert.equal(h.sdk.calls[1]!.model, 'opus');
    assert.equal((await h.orch.createConversation('alpha', '잘못된 모델', [], 'bad/id')).ok, false);
    h.db.close();
    h = harness(script, {}, dbFile);
    assert.equal(h.db.getConv(convId)!.model, 'opus');
    assert.ok((await h.orch.sendMessage(convId, '재시작 후 요청', [])).ok);
    await h.orch.idle();
    assert.equal(h.sdk.calls[0]!.model, 'opus');
    h.db.close();
  });

  test('first job creates a session, follow-up resumes it, restart keeps it', async () => {
    const dbFile = path.join(TMP, 'resume.sqlite');
    const script: Script = async function* (ctx) {
      const sid = ctx.options.resume ?? S1;
      yield init(sid);
      yield toolUse('Read', { file_path: path.join(PROJ_A, 'a.ts') }, sid);
      yield ok(`answer for: ${(ctx.prompt.message.content as { text: string }[])[0]!.text}`, sid);
    };
    let h = harness(script, {}, dbFile);
    const { convId, jobId } = await start(h, 'alpha', '첫 요청');
    assert.equal(h.sdk.calls[0]!.resume, undefined);
    assert.equal(h.sdk.calls[0]!.permissionMode, 'default', 'permission mode must be explicit (CLI default is auto)');
    assert.equal(h.db.getConv(convId)!.session_id, S1);
    assert.equal(h.db.getJob(jobId)!.status, 'succeeded');
    assert.ok(h.msgs(convId).some((m) => m.kind === 'answer' && m.text.includes('첫 요청')));

    assert.ok((await h.orch.sendMessage(convId, '두번째', [])).ok);
    await h.orch.idle();
    assert.equal(h.sdk.calls[1]!.resume, S1);

    h.db.close(); // simulate restart
    h = harness(script, {}, dbFile);
    h.orch.recoverState();
    assert.ok((await h.orch.sendMessage(convId, '재시작 후', [])).ok);
    await h.orch.idle();
    assert.equal(h.sdk.calls[0]!.resume, S1, 'session survives a restart');
    h.db.close();
  });
});

describe('권한 승인/거절', () => {
  test('deny ends only this job, Claude is told to stop, no retry, lock released', async () => {
    let permCalls = 0;
    const h = harness(async function* (ctx) {
      yield init(S1);
      if (ctx.prompt.message.content[0] && (ctx.prompt.message.content as { text: string }[])[0]!.text === 'next') {
        yield ok('next ok', S1);
        return;
      }
      yield toolUse('Bash', { command: 'rm -rf build' }, S1);
      const r = await ctx.callTool('Bash', { command: 'rm -rf build' });
      permCalls++;
      const perm = r.perm as { behavior: string; interrupt?: boolean };
      assert.equal(perm.behavior, 'deny');
      assert.equal(perm.interrupt, true);
      await ctx.stopped;
      yield errResult(['interrupted'], S1);
    });
    h.decide.value = 'deny';
    const { convId, jobId } = await start(h, 'alpha', 'delete build');
    assert.equal(h.db.getJob(jobId)!.status, 'denied');
    assert.equal(permCalls, 1);
    const last = h.msgs(convId).at(-1)!;
    assert.equal(last.kind, 'error');
    assert.match(last.text, /거절/);
    assert.match(last.text, /재시도하지 않습니다/);
    assert.match(last.text, /git status/, 'warns about partial modifications');
    const approval = h.db.listMessages(convId).find((m) => m.kind === 'approval')!;
    assert.equal(approval.approval_open, false);
    assert.equal(h.orch.status(convId)!.state, 'idle');
    assert.ok((await h.orch.sendMessage(convId, 'next', [])).ok);
    await h.orch.idle();
    assert.equal(h.db.lastJob(convId)!.status, 'succeeded');
  });

  test('approval timeout is treated as a refusal', async () => {
    const h = harness(
      async function* (ctx) {
        yield init(S1);
        await ctx.callTool('Bash', { command: 'npm publish' });
        await ctx.stopped;
        yield errResult(['interrupted'], S1);
      },
      { approvalTimeoutMs: 60 },
    );
    h.decide.value = null;
    const { convId, jobId } = await start(h, 'alpha', 'publish');
    assert.equal(h.db.getJob(jobId)!.status, 'denied');
    assert.match(h.msgs(convId).at(-1)!.text, /응답이 없어 거절/);
  });

  test('approve lets the tool run and the job succeed', async () => {
    const h = harness(async function* (ctx) {
      yield init(S1);
      const r = await ctx.callTool('Edit', { file_path: path.join(PROJ_A, 'x.ts'), old_string: 'a', new_string: 'b' });
      assert.equal((r.perm as { behavior: string }).behavior, 'allow');
      yield ok('edited', S1);
    });
    const { jobId } = await start(h, 'alpha', 'edit');
    assert.equal(h.db.getJob(jobId)!.status, 'succeeded');
  });

  test('approval token only works for its own conversation', async () => {
    const h = harness(async function* (ctx) {
      yield init(S1);
      await ctx.callTool('Bash', { command: 'ls' });
      await ctx.stopped;
      yield errResult(['x'], S1);
    });
    h.decide.value = null;
    const r = await h.orch.createConversation('alpha', 'ls', []);
    assert.ok(r.ok);
    await new Promise((res) => setTimeout(res, 30));
    const card = h.db.listMessages((r as { convId: string }).convId).find((m) => m.kind === 'approval')!;
    const other = await h.orch.createConversation('beta', 'other', []);
    assert.ok(other.ok);
    assert.equal(h.orch.approve((other as { convId: string }).convId, card.approval_token!, 'allow').ok, false);
    h.orch.stop((r as { convId: string }).convId);
    await h.orch.idle();
  });
});

describe('보안 차단', () => {
  test('automatic mode allows tools without approval cards while retaining path blocks', async () => {
    const h = harness(async function* (ctx) {
      yield init(S1);
      const command = await ctx.callTool('Bash', { command: 'pwd' });
      assert.notEqual((command.hook as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'ask');
      assert.equal((command.perm as { behavior: string }).behavior, 'allow');
      const blocked = await ctx.callTool('Read', { file_path: '/etc/passwd' });
      assert.equal((blocked.hook as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
      await ctx.stopped;
      yield errResult(['stopped'], S1);
    }, { permissionMode: 'bypassPermissions' });
    const { convId } = await start(h, 'alpha', '자동 실행');
    assert.equal(h.sdk.calls[0]!.allowDangerouslySkipPermissions, true);
    assert.equal(h.msgs(convId).some((m) => m.kind === 'approval'), false);
    h.db.close();
  });

  test('outside-project access stops the job as blocked', async () => {
    const h = harness(async function* (ctx) {
      yield init(S1);
      const r = await ctx.callTool('Read', { file_path: '/etc/passwd' });
      assert.equal((r.hook as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
      await ctx.stopped;
      yield errResult(['stopped'], S1);
    });
    const { convId, jobId } = await start(h, 'alpha', 'read passwd');
    assert.equal(h.db.getJob(jobId)!.status, 'blocked');
    assert.match(h.msgs(convId).at(-1)!.text, /프로젝트 경로 밖/);
  });

  test('path guard rules', () => {
    fs.mkdirSync(path.join(PROJ_A, 'src'), { recursive: true });
    fs.symlinkSync('/etc', path.join(PROJ_A, 'link-out'));
    assert.equal(checkToolCall('Read', { file_path: 'src/a.ts' }, PROJ_A).kind, 'pass');
    assert.equal(checkToolCall('Read', { file_path: '../beta/x' }, PROJ_A).kind, 'deny');
    assert.equal(checkToolCall('Write', { file_path: path.join(PROJ_A, 'link-out', 'evil') }, PROJ_A).kind, 'deny', 'symlink escape');
    assert.equal(checkToolCall('Read', { file_path: path.join(PROJ_A, '.env') }, PROJ_A).kind, 'deny', '.env blocked');
    assert.equal(checkToolCall('Read', { file_path: path.join(PROJ_A, '.env.example') }, PROJ_A).kind, 'pass');
    assert.equal(checkToolCall('Edit', { file_path: path.join(PROJ_A, 'certs', 'server.key') }, PROJ_A).kind, 'deny');
    assert.equal(checkToolCall('Glob', { pattern: '/etc/**' }, PROJ_A).kind, 'deny');
    assert.equal(checkToolCall('Grep', { pattern: 'x', path: '/' }, PROJ_A).kind, 'deny');
    assert.equal(checkToolCall('Bash', { command: 'ls' }, PROJ_A).kind, 'ask', 'Bash always goes to the buttons');
    assert.equal(checkToolCall('mcp__x__y', {}, PROJ_A).kind, 'ask');
    assert.equal(checkToolCall('Read', { file_path: 123 }, PROJ_A).kind, 'deny');
    const botDir = path.join(WS, 'beta', 'app');
    assert.equal(checkToolCall('Read', { file_path: path.join(botDir, '.env') }, WS, WS, botDir).kind, 'deny');
    assert.equal(checkToolCall('Read', { file_path: path.join(PROJ_A, 'src', 'a.ts') }, WS, WS, botDir).kind, 'pass');
    assert.equal(checkToolCall('Grep', { pattern: 'TOKEN' }, WS, WS, botDir).kind, 'deny');
    assert.equal(checkToolCall('Grep', { pattern: 'x', path: PROJ_A }, WS, WS, botDir).kind, 'pass');
  });
});

describe('취소', () => {
  test('stop cancels the running job and the next queued job of that conversation', async () => {
    const h = harness(async function* (ctx) {
      yield init(S1);
      yield toolUse('Write', { file_path: path.join(PROJ_A, 'w.ts') }, S1);
      await ctx.stopped;
      yield errResult(['interrupted'], S1);
    });
    const r = (await h.orch.createConversation('alpha', 'long', [])) as { ok: true; convId: string; jobId: number };
    const second = (await h.orch.sendMessage(r.convId, 'queued', [])) as { ok: true; jobId: number };
    await new Promise((res) => setTimeout(res, 20));
    const s = h.orch.stop(r.convId);
    assert.ok(s.ok);
    await h.orch.idle();
    assert.equal(h.db.getJob(r.jobId)!.status, 'cancelled');
    assert.equal(h.db.getJob(second.jobId)!.status, 'cancelled');
    assert.match(h.msgs(r.convId).filter((m) => m.kind === 'error').at(-1)!.text, /git status/);
    assert.equal(h.orch.status(r.convId)!.state, 'idle');
  });

  test('a hung SDK is hard-aborted after the grace period', async () => {
    const h = harness(async function* (ctx) {
      yield init(S1);
      await new Promise((r) => ctx.options.abortController!.signal.addEventListener('abort', () => r(null)));
      yield ok('never', S1);
    });
    const r = (await h.orch.createConversation('alpha', 'hang', [])) as { ok: true; convId: string; jobId: number };
    await new Promise((res) => setTimeout(res, 20));
    const t0 = Date.now();
    h.orch.stop(r.convId);
    await h.orch.idle();
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(h.db.getJob(r.jobId)!.status, 'cancelled');
  });
});

describe('재시작 복구', () => {
  test('unfinished jobs become interrupted, are announced, and never re-run', async () => {
    const dbFile = path.join(TMP, 'recover.sqlite');
    {
      const db = new AppDb(dbFile);
      db.bindConv({ convId: 'c-1', project: 'alpha', projectPath: PROJ_A, sessionId: S1, title: 't' });
      const running = db.createJob({ convId: 'c-1', project: 'alpha', requesterId: 'local', promptPreview: 'x', imageCount: 0 });
      db.setJobActiveStatus(running, 'running');
      db.createJob({ convId: 'c-1', project: 'alpha', requesterId: 'local', promptPreview: 'y', imageCount: 0 });
      db.insertMessage({ convId: 'c-1', kind: 'approval', text: 'perm', approvalToken: 'tok-123456789' });
      db.close(); // "crash"
    }
    const h = harness(async function* () {
      throw new Error('must not run');
    }, {}, dbFile);
    const rec = h.orch.recoverState();
    assert.equal(rec.length, 2);
    await h.orch.notifyRecovered();
    await h.orch.idle();
    assert.equal(h.sdk.calls.length, 0, 'nothing re-run');
    assert.ok(h.db.lastJob('c-1')!.status === 'interrupted');
    const msgs = h.db.listMessages('c-1');
    assert.equal(msgs.find((m) => m.kind === 'approval')!.approval_open, false, 'stale approval closed');
    assert.match(msgs.at(-1)!.text, /자동으로 다시 실행하지 않습니다/);
    assert.equal(h.db.getConv('c-1')!.session_id, S1, 'session kept');
    h.db.close();
  });
});

describe('세션 재개 실패', () => {
  test('missing session: no silent reset, conversation blocked until new/recheck', async () => {
    const h = harness(async function* (ctx) {
      if (ctx.options.resume) {
        yield errResult([`No conversation found with session ID: ${ctx.options.resume}`], ctx.options.resume);
        throw new Error('Claude Code returned an error result');
      }
      yield init(S2);
      yield ok('fresh', S2);
    });
    const convId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    h.db.bindConv({ convId, project: 'alpha', projectPath: PROJ_A, sessionId: S1, title: 't' });
    assert.ok((await h.orch.sendMessage(convId, 'continue', [])).ok);
    await h.orch.idle();
    const conv = h.db.getConv(convId)!;
    assert.equal(conv.resume_broken, 1);
    assert.equal(conv.session_id, S1, 'stored session id is NOT replaced');
    assert.match(h.msgs(convId).at(-1)!.text, /새 세션/);
    const blocked = await h.orch.sendMessage(convId, 'again', []);
    assert.equal(blocked.ok, false);
    assert.match((blocked as { message: string }).message, /새 세션/);
    assert.equal((await h.orch.recheckSession(convId)).ok, false, 'recheck fails while the session is missing');
    assert.ok(h.orch.newSession(convId).ok);
    assert.ok((await h.orch.sendMessage(convId, 'fresh start', [])).ok);
    await h.orch.idle();
    assert.equal(h.db.getConv(convId)!.session_id, S2);
  });

  test('a resume that comes back with a different session id is refused', async () => {
    const h = harness(async function* () {
      yield init(S2); // CLI tried to start a new conversation
      yield ok('should not be reported', S2);
    });
    const convId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    h.db.bindConv({ convId, project: 'alpha', projectPath: PROJ_A, sessionId: S1, title: 't' });
    await h.orch.sendMessage(convId, 'x', []);
    await h.orch.idle();
    assert.equal(h.db.getConv(convId)!.session_id, S1);
    assert.equal(h.db.getConv(convId)!.resume_broken, 1);
    assert.ok(!h.msgs(convId).some((m) => m.kind === 'answer'));
  });

  test('resume API validates the session before creating a conversation', async () => {
    const h = harness(async function* () {}, {}, ':memory:', { [S1]: 'here', [S2]: 'elsewhere' });
    assert.equal((await h.orch.resumeSession('not-a-uuid', 'alpha')).ok, false);
    assert.equal((await h.orch.resumeSession('33333333-3333-4333-8333-333333333333', 'alpha')).ok, false);
    assert.equal((await h.orch.resumeSession(S2, 'alpha')).ok, false);
    const r = await h.orch.resumeSession(S1, 'alpha');
    assert.ok(r.ok);
    assert.equal(h.db.getConv((r as { convId: string }).convId)!.session_id, S1);
  });
});

describe('SDK 오류 처리', () => {
  const cases: [string, Script, RegExp][] = [
    [
      'auth failure',
      async function* () {
        yield init(S1);
        yield say('Invalid API key', S1, { error: 'authentication_failed' });
        yield { ...(errResult(['auth'], S1) as object), subtype: 'success', is_error: true, result: 'Invalid API key' } as unknown as SDKMessage;
      },
      /인증에 실패/,
    ],
    [
      'rate limit',
      async function* () {
        yield init(S1);
        yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000 }, session_id: S1 } as unknown as SDKMessage;
        yield say('limit', S1, { error: 'rate_limit' });
        yield errResult(['rate limited'], S1);
      },
      /사용량 한도.*재설정 시각/s,
    ],
    [
      'spawn failure',
      async function* () {
        throw new Error('spawn claude ENOENT');
      },
      /실행 파일을 시작하지 못했습니다/,
    ],
    [
      'process crash',
      async function* () {
        yield init(S1);
        throw new Error('Claude Code process exited with code 1');
      },
      /실행 중 오류/,
    ],
    [
      'max turns',
      async function* () {
        yield init(S1);
        yield { ...(errResult([], S1) as object), subtype: 'error_max_turns' } as unknown as SDKMessage;
      },
      /최대 턴 수/,
    ],
  ];
  for (const [name, script, re] of cases) {
    test(name, async () => {
      const h = harness(script);
      const { convId, jobId } = await start(h, 'alpha', name);
      assert.equal(h.db.getJob(jobId)!.status, 'failed');
      assert.match(h.msgs(convId).at(-1)!.text, re);
      assert.equal(h.orch.status(convId)!.state, 'idle', 'lock released');
    });
  }

  test('secrets in Claude output are redacted before storage', async () => {
    const h = harness(async function* () {
      yield init(S1);
      yield ok(`key is ${SECRET} and ghp_${'a'.repeat(36)}`, S1);
    });
    const { convId } = await start(h, 'alpha', 'leak');
    const text = h.msgs(convId).at(-1)!.text;
    assert.ok(!text.includes(SECRET) && !text.includes('ghp_aaa'));
    assert.match(text, /\[REDACTED\]/);
  });
});

describe('순차 실행', () => {
  test('one job at a time per project, projects run in parallel', async () => {
    const h = harness(async function* () {
      yield init(S1);
      await new Promise((r) => setTimeout(r, 40));
      yield ok('done', S1);
    });
    await Promise.all([h.orch.createConversation('alpha', 'a1', []), h.orch.createConversation('alpha', 'a2', [])]);
    await h.orch.idle();
    assert.equal(h.sdk.maxRunning, 1, 'same project is sequential');
    h.sdk.maxRunning = 0;
    await Promise.all([h.orch.createConversation('alpha', 'a3', []), h.orch.createConversation('beta', 'b1', [])]);
    await h.orch.idle();
    assert.equal(h.sdk.maxRunning, 2, 'different projects in parallel');
  });

  test('per-conversation pending limit', async () => {
    const h = harness(async function* (ctx) {
      yield init(S1);
      await ctx.stopped;
      yield errResult(['x'], S1);
    }, { maxPendingPerConversation: 2 });
    const r = (await h.orch.createConversation('alpha', '1', [])) as { convId: string };
    assert.ok((await h.orch.sendMessage(r.convId, '2', [])).ok);
    assert.equal((await h.orch.sendMessage(r.convId, '3', [])).ok, false);
    h.orch.stop(r.convId);
    await h.orch.idle();
  });
});

describe('입력 검증 · 설정 · 환경', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  test('image uploads', () => {
    assert.equal(validateUploads([{ name: 'a.png', data: `data:image/png;base64,${PNG}` }], { maxBytes: 1024, maxCount: 2 })[0]!.mediaType, 'image/png');
    assert.throws(() => validateUploads([{ name: 'a.txt', data: Buffer.from('hello').toString('base64') }], { maxBytes: 1024, maxCount: 2 }), ImageError);
    assert.throws(() => validateUploads([{ name: 'big.png', data: PNG.repeat(200) }], { maxBytes: 64, maxCount: 2 }), /너무 큽니다/);
    assert.throws(() => validateUploads([{}, {}, {}], { maxBytes: 64, maxCount: 2 }), /최대 2장/);
    assert.throws(() => validateUploads([{ name: 'x', data: '###' }], { maxBytes: 64, maxCount: 2 }), /손상/);
  });

  test('second server on the same DB is refused', () => {
    const f = path.join(TMP, 'lock.sqlite');
    const a = new AppDb(f);
    assert.throws(() => new AppDb(f), DbLockedError);
    a.close();
    new AppDb(f).close();
  });

  test('child env drops bot secrets and session-binding vars', () => {
    const env = buildChildEnv({ CLAUDE_CODE_SESSION_ID: 'y', CLAUDECODE: '1', PATH: '/bin', ANTHROPIC_API_KEY: 'k' });
    assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'PATH']);
  });

  test('config allows automatic mode and refuses project escapes while allowing a guarded home project', () => {
    const appDir = path.join(PROJ_B, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'projects.json'), JSON.stringify({ projects: { beta: 'beta', out: '/tmp', ok: 'alpha' } }));
    const base = { WORKSPACE_ROOT: WS };
    try {
      loadConfig({ ...base, PERMISSION_MODE: 'bypassPermissions' }, appDir);
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      const all = e.problems.join('\n');
      assert.match(all, /WORKSPACE_ROOT 밖/);
    }
    fs.writeFileSync(path.join(appDir, 'projects.json'), JSON.stringify({ projects: { home: '.' } }));
    const loaded = loadConfig(base, appDir);
    assert.equal(loaded.projects.get('home')?.path, WS);
    assert.equal(loadConfig({ ...base, PERMISSION_MODE: 'bypassPermissions' }, appDir).permissionMode, 'bypassPermissions');
    assert.equal(loaded.botDir, appDir);
    fs.writeFileSync(path.join(appDir, 'projects.json'), JSON.stringify({ projects: { self: 'beta/app' } }));
    assert.throws(() => loadConfig(base, appDir), /앱 설정 폴더/);
  });
});

describe('HTTP 보안', () => {
  let server: http.Server & { closeStreams(): void };
  let port = 0;
  const pub = path.join(TMP, 'public');
  before(async () => {
    fs.mkdirSync(pub, { recursive: true });
    for (const f of ['index.html', 'app.js', 'style.css', 'favicon.svg']) fs.writeFileSync(path.join(pub, f), f);
    const h = harness(async function* () {});
    const log = createLogger(new Redactor([]), 'error', () => {});
    server = createServer({ cfg: cfg({ webPort: 0 }), db: h.db, orch: h.orch, hub: new Hub(), log, redactor: new Redactor([]), models: { list: async () => [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' }] }, publicDir: pub });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.close());
  const req = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method: init.method ?? 'GET', headers: { Host: `127.0.0.1:0`, ...init.headers } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
      });
      r.on('error', reject);
      r.end(init.body);
    });
  test('local pages and read APIs are available without a login cookie', async () => {
    assert.equal((await req('/api/bootstrap')).status, 200);
    const r = await req('/');
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-security-policy']), /script-src 'self'/);
  });
  test('state changes need the custom header and same origin', async () => {
    const body = JSON.stringify({ project: 'alpha', text: 'x' });
    const h = { 'Content-Type': 'application/json' };
    assert.equal((await req('/api/conversations', { method: 'POST', headers: h, body })).status, 403);
    assert.equal((await req('/api/conversations', { method: 'POST', headers: { ...h, 'X-CCW': '1', Origin: 'http://evil.example' }, body })).status, 403);
    assert.equal((await req('/api/bootstrap')).status, 200);
  });
});
