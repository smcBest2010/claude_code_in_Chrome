import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { AppDb } from './db.js';
import { ImageError, validateUploads } from './images.js';
import type { Logger } from './logger.js';
import type { ModelCatalog } from './models.js';
import type { Orchestrator } from './orchestrator.js';
import type { Redactor } from './redact.js';
import { toPublic, type Hub } from './webTransport.js';

const CONV_ID = '[0-9a-f-]{36}';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const STATIC: Record<string, { file: string; type: string }> = {
  '/static/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/static/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ServerDeps {
  cfg: AppConfig;
  db: AppDb;
  orch: Orchestrator;
  hub: Hub;
  log: Logger;
  redactor: Redactor;
  models: Pick<ModelCatalog, 'list'>;
  publicDir: string;
}

export function createServer(d: ServerDeps): http.Server & { closeStreams(): void } {
  const { cfg, orch, hub, log } = d;
  const files = new Map<string, Buffer>();
  for (const name of ['index.html', 'app.js', 'style.css', 'favicon.svg']) {
    files.set(name, fs.readFileSync(path.join(d.publicDir, name)));
  }
  const anyHost = cfg.webHost === '0.0.0.0' || cfg.webHost === '::';
  const allowedHosts = new Set([`127.0.0.1:${cfg.webPort}`, `localhost:${cfg.webPort}`, `[::1]:${cfg.webPort}`, `${cfg.webHost}:${cfg.webPort}`]);
  const streams = new Set<http.ServerResponse>();
  // Images are sent as base64 inside JSON.
  const maxBody = Math.ceil(cfg.maxImages * cfg.maxImageBytes * 1.4) + 256 * 1024;

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          reject(new HttpError(413, `요청이 너무 큽니다 (이미지는 장당 최대 ${(cfg.maxImageBytes / 1024 / 1024).toFixed(0)}MB, ${cfg.maxImages}장).`));
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => reject(new HttpError(400, '요청을 읽지 못했습니다.')));
    });

  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON 요청만 받습니다.');
    const raw = await readBody(req);
    try {
      const v = JSON.parse(raw || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
    }
  };

  const str = (v: unknown, max = 25_000): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const images = (v: unknown) => {
    try {
      return validateUploads(v, { maxBytes: cfg.maxImageBytes, maxCount: cfg.maxImages });
    } catch (e) {
      if (e instanceof ImageError) throw new HttpError(400, e.message);
      throw e;
    }
  };
  const result = (res: http.ServerResponse, r: { ok: boolean; message?: string } & Record<string, unknown>) => json(res, r.ok ? 200 : 409, r);

  const availableModels = async (projectName: string) => {
    if (!cfg.projects.has(projectName)) throw new HttpError(400, '알 수 없는 프로젝트입니다.');
    try { return await d.models.list(projectName); }
    catch (e) {
      log.warn('Claude 모델 목록을 가져오지 못했습니다', e);
      throw new HttpError(503, 'Claude Code 모델 목록을 가져오지 못했습니다. 로그인 상태를 확인하세요.');
    }
  };

  const chosenModel = async (projectName: string, raw: unknown): Promise<string | undefined> => {
    const value = str(raw, 80);
    if (!value || value === 'default') return undefined;
    const list = await availableModels(projectName);
    const match = list.find((m) => m.value === value)
      || list.find((m) => m.value !== 'default' && m.resolvedModel === value);
    if (!match) throw new HttpError(400, '이 프로젝트에서 선택할 수 없는 모델입니다. 목록을 새로고침하세요.');
    return match.value === 'default' ? undefined : match.value;
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (!anyHost && !allowedHosts.has(host)) throw new HttpError(421, 'Unknown host');
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      // CSRF: same-origin only.
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          /* "null" or garbage */
        }
        if (originHost !== host) throw new HttpError(403, 'Cross-origin request blocked');
      }
    }

    // ── public routes ──
    const st = STATIC[p];
    if (st && method === 'GET') return send(res, 200, files.get(st.file)!, st.type, { 'Cache-Control': 'no-cache' });
    if (method !== 'GET' && req.headers['x-ccw'] !== '1') throw new HttpError(403, 'Missing request header');

    if (method === 'GET' && (p === '/' || new RegExp(`^/c/${CONV_ID}$`).test(p))) {
      return send(res, 200, files.get('index.html')!, 'text/html; charset=utf-8');
    }
    if (p === '/api/bootstrap' && method === 'GET') {
      return json(res, 200, {
        projects: [...cfg.projects.values()].map((x) => ({ name: x.name })),
        workspaceRoot: cfg.workspaceRoot,
        permissionMode: cfg.permissionMode,
        maxImages: cfg.maxImages,
        maxImageBytes: cfg.maxImageBytes,
        recent: orch.recentConversations(8),
      });
    }
    if (p === '/api/models' && method === 'GET') {
      return json(res, 200, { models: await availableModels(url.searchParams.get('project') ?? '') });
    }
    if (p === '/api/conversations' && method === 'POST') {
      const b = await readJson(req);
      const project = str(b.project, 64);
      return result(res, await orch.createConversation(project, str(b.text), images(b.images), await chosenModel(project, b.model)));
    }
    if (p === '/api/resume' && method === 'POST') {
      const b = await readJson(req);
      return result(res, await orch.resumeSession(str(b.sessionId, 64), str(b.project, 64)));
    }

    const m = new RegExp(`^/api/conversations/(${CONV_ID})(?:/(events|messages|new|recheck|stop|approvals/([A-Za-z0-9_-]{8,64})))?$`).exec(p);
    if (!m) throw new HttpError(404, '찾을 수 없습니다.');
    const convId = m[1]!;
    const action = m[2];
    const status = orch.status(convId);
    if (!status) throw new HttpError(404, '대화를 찾을 수 없습니다.');

    if (!action && method === 'GET') return json(res, 200, { status, messages: d.db.listMessages(convId).map(toPublic) });
    if (action === 'events' && method === 'GET') return openStream(req, res, convId);
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const b = await readJson(req);
    if (action === 'messages') return result(res, await orch.sendMessage(convId, str(b.text), images(b.images)));
    if (action === 'new') return result(res, orch.newSession(convId, b.project ? str(b.project, 64) : undefined));
    if (action === 'recheck') return result(res, await orch.recheckSession(convId));
    if (action === 'stop') return result(res, orch.stop(convId));
    if (m[3]) {
      const decision = b.decision === 'allow' ? 'allow' : b.decision === 'deny' ? 'deny' : null;
      if (!decision) throw new HttpError(400, 'decision 은 allow 또는 deny 입니다.');
      return result(res, orch.approve(convId, m[3], decision));
    }
    throw new HttpError(404, '찾을 수 없습니다.');
  }

  function openStream(req: http.IncomingMessage, res: http.ServerResponse, convId: string): void {
    if (hub.connectionCount > 50) throw new HttpError(503, '연결이 너무 많습니다.');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    // Full snapshot on every (re)connect: edits made while disconnected are never lost.
    write('snapshot', { status: orch.status(convId), messages: d.db.listMessages(convId).map(toPublic) });
    const unsubscribe = hub.subscribe(convId, write);
    const ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 20_000);
    streams.add(res);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
      streams.delete(res);
    };
    req.on('close', close);
    res.on('error', close);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) return json(res, e.status, { ok: false, message: e.message });
      log.error(`${req.method} ${req.url?.split('?')[0]} failed`, e);
      json(res, 500, { ok: false, message: '서버 오류가 발생했습니다. 로그를 확인하세요.' });
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  return Object.assign(server, {
    closeStreams() {
      for (const r of streams) r.end();
      streams.clear();
    },
  });
}
