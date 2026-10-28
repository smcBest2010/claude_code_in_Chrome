import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalManager } from './approvals.js';
import { buildChildEnv } from './childEnv.js';
import { ConfigError, loadConfig } from './config.js';
import { AppDb, DbLockedError } from './db.js';
import { createLogger } from './logger.js';
import { ModelCatalog } from './models.js';
import { Orchestrator } from './orchestrator.js';
import { Redactor } from './redact.js';
import { createServer } from './server.js';
import type { SessionLookup } from './types.js';
import { Hub, WebTransport } from './webTransport.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function findSession(id: string, dir?: string): Promise<SessionLookup> {
  try {
    if (dir) {
      if (await getSessionInfo(id, { dir })) return 'here';
      return (await getSessionInfo(id)) ? 'elsewhere' : 'missing';
    }
    return (await getSessionInfo(id)) ? 'here' : 'missing';
  } catch {
    return 'error';
  }
}

async function main(): Promise<void> {
  const envFile = path.join(appDir, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  let cfg;
  try {
    cfg = loadConfig(process.env, appDir);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  }

  const redactor = Redactor.fromEnv(process.env);
  const log = createLogger(redactor, cfg.logLevel);

  let db: AppDb;
  try {
    db = new AppDb(cfg.dbPath);
  } catch (e) {
    log.error(e instanceof DbLockedError ? e.message : 'DB를 열 수 없습니다', e instanceof DbLockedError ? undefined : e);
    process.exit(1);
  }

  const hub = new Hub();
  const transport = new WebTransport(db, hub, redactor, log);
  const approvals = new ApprovalManager(transport, cfg.approvalTimeoutMs, log);
  const childEnv = buildChildEnv(process.env);
  const orch = new Orchestrator({ cfg, db, transport, approvals, queryFn: query, findSession, log, redactor, childEnv });
  const models = new ModelCatalog(cfg, childEnv);
  transport.setStatusProvider((id) => orch.status(id));

  orch.recoverState();
  await orch.notifyRecovered();

  const server = createServer({ cfg, db, orch, hub, log, redactor, models, publicDir: path.join(appDir, 'public') });
  server.on('error', (e: NodeJS.ErrnoException) => {
    log.error(e.code === 'EADDRINUSE' ? `포트 ${cfg.webPort} 이(가) 이미 사용 중입니다 (WEB_PORT 변경)` : 'HTTP 서버 오류', e);
    process.exit(1);
  });
  server.listen(cfg.webPort, cfg.webHost, () => {
    log.info(`ready: http://${cfg.webHost === '0.0.0.0' ? 'localhost' : cfg.webHost}:${cfg.webPort}  (projects: ${[...cfg.projects.keys()].join(', ')}, permission mode: ${cfg.permissionMode})`);
    if (cfg.webHost !== '127.0.0.1' && cfg.webHost !== 'localhost' && cfg.webHost !== '::1') {
      log.warn(`WEB_HOST=${cfg.webHost}: 다른 기기에서 접속할 수 있습니다. 접근 토큰을 길게 유지하고 신뢰하는 네트워크에서만 사용하세요.`);
    }
  });

  // The server must survive anything a single job or request does.
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await orch.shutdown().catch((e) => log.error('shutdown', e));
    server.closeStreams();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
