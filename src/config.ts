import fs from 'node:fs';
import path from 'node:path';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { isInside } from './pathGuard.js';
import type { LogLevel } from './logger.js';
import type { ProjectConfig } from './types.js';

export type AllowedPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
const ALLOWED_MODES: AllowedPermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export interface AppConfig {
  webHost: string;
  webPort: number;
  webAccessToken: string;
  workspaceRoot: string;
  botDir: string;
  projects: Map<string, ProjectConfig>;
  dbPath: string;
  permissionMode: AllowedPermissionMode;
  approvalTimeoutMs: number;
  maxImageBytes: number;
  maxImages: number;
  maxPendingPerConversation: number;
  model?: string;
  maxTurns?: number;
  settingSources: SettingSource[];
  claudeExecutable?: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`설정 오류:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Env keys owned by the bot. They are stripped from the Claude Code child process environment. */
export const BOT_ENV_KEYS = [
  'WEB_HOST',
  'WEB_PORT',
  'WEB_ACCESS_TOKEN',
  'WORKSPACE_ROOT',
  'PROJECTS_FILE',
  'DB_PATH',
  'PERMISSION_MODE',
  'APPROVAL_TIMEOUT_SEC',
  'MAX_IMAGE_MB',
  'MAX_IMAGES',
  'MAX_PENDING_PER_CONVERSATION',
  'CLAUDE_MODEL',
  'CLAUDE_MAX_TURNS',
  'CLAUDE_SETTING_SOURCES',
  'CLAUDE_EXECUTABLE',
  'LOG_LEVEL',
];

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function intIn(raw: string | undefined, def: number, min: number, max: number, key: string, problems: string[]): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    problems.push(`${key} 는 ${min}~${max} 사이 숫자여야 합니다 (현재: ${raw})`);
    return def;
  }
  return n;
}

function realDir(p: string): string | null {
  try {
    const real = fs.realpathSync.native(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, botDir: string): AppConfig {
  const problems: string[] = [];
  const req = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) problems.push(`${k} 가 비어 있습니다`);
    return v ?? '';
  };

  const webAccessToken = req('WEB_ACCESS_TOKEN');
  if (webAccessToken && webAccessToken.length < 16) problems.push('WEB_ACCESS_TOKEN 은 16자 이상이어야 합니다 (예: openssl rand -hex 24)');
  const webHost = env.WEB_HOST?.trim() || '127.0.0.1';
  if (!/^[A-Za-z0-9.:-]+$/.test(webHost)) problems.push('WEB_HOST 형식이 올바르지 않습니다');
  const webPort = intIn(env.WEB_PORT, 3939, 1, 65535, 'WEB_PORT', problems);

  // Workspace root: every project must live under it.
  const wsRaw = req('WORKSPACE_ROOT');
  let workspaceRoot = '';
  if (wsRaw) {
    if (!path.isAbsolute(wsRaw)) problems.push('WORKSPACE_ROOT 는 절대 경로여야 합니다');
    else {
      const real = realDir(wsRaw);
      if (!real) problems.push(`WORKSPACE_ROOT 디렉터리가 없습니다: ${wsRaw}`);
      else if (path.parse(real).root === real) problems.push('WORKSPACE_ROOT 로 파일시스템 루트를 쓸 수 없습니다');
      else workspaceRoot = real;
    }
  }

  const realBotDir = realDir(botDir) ?? path.resolve(botDir);
  const projects = new Map<string, ProjectConfig>();
  const projectsFile = path.resolve(botDir, env.PROJECTS_FILE?.trim() || 'projects.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  } catch (e) {
    problems.push(`프로젝트 설정 파일을 읽을 수 없습니다 (${projectsFile}): ${(e as Error).message}`);
  }
  const entries = (parsed as { projects?: unknown } | undefined)?.projects;
  if (parsed !== undefined) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      problems.push('projects.json 형식: { "projects": { "이름": "경로" } }');
    } else {
      const list = Object.entries(entries as Record<string, unknown>);
      if (list.length === 0) problems.push('projects.json 에 프로젝트가 하나 이상 필요합니다');
      if (list.length > 25) problems.push('프로젝트는 최대 25개입니다 (디스코드 선택지 제한)');
      for (const [name, rawPath] of list) {
        if (!PROJECT_NAME.test(name)) {
          problems.push(`프로젝트 이름 "${name}" 은 영문/숫자/._- 1~32자여야 합니다`);
          continue;
        }
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
          problems.push(`프로젝트 "${name}" 경로가 문자열이 아닙니다`);
          continue;
        }
        if (!workspaceRoot) continue;
        const abs = path.resolve(workspaceRoot, rawPath);
        const real = realDir(abs);
        if (!real) {
          problems.push(`프로젝트 "${name}" 디렉터리가 없습니다: ${abs}`);
          continue;
        }
        if (!isInside(workspaceRoot, real)) {
          problems.push(`프로젝트 "${name}" 가 WORKSPACE_ROOT 밖에 있습니다 (심볼릭 링크 포함): ${real}`);
          continue;
        }
        if (isInside(realBotDir, real)) {
          problems.push(`앱 설정 폴더는 프로젝트로 선택할 수 없습니다: ${real}`);
          continue;
        }
        projects.set(name, { name, path: real });
      }
    }
  }

  const modeRaw = (env.PERMISSION_MODE?.trim() || 'default') as AllowedPermissionMode;
  if (!ALLOWED_MODES.includes(modeRaw)) {
    problems.push(`PERMISSION_MODE 는 ${ALLOWED_MODES.join(' | ')} 중 하나여야 합니다`);
  }

  let settingSources: SettingSource[] = ['project'];
  const ssRaw = env.CLAUDE_SETTING_SOURCES?.trim();
  if (ssRaw !== undefined && ssRaw !== '') {
    if (ssRaw === 'none') settingSources = [];
    else {
      const parts = ssRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = parts.filter((s) => !['user', 'project', 'local'].includes(s));
      if (bad.length) problems.push(`CLAUDE_SETTING_SOURCES 에 알 수 없는 값: ${bad.join(', ')} (user,project,local,none)`);
      settingSources = parts.filter((s) => !bad.includes(s)) as SettingSource[];
    }
  }

  const claudeExecutable = env.CLAUDE_EXECUTABLE?.trim() || undefined;
  if (claudeExecutable && (!path.isAbsolute(claudeExecutable) || !fs.existsSync(claudeExecutable))) {
    problems.push(`CLAUDE_EXECUTABLE 파일이 없습니다: ${claudeExecutable}`);
  }

  const logLevel = (env.LOG_LEVEL?.trim() || 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) problems.push('LOG_LEVEL 은 debug|info|warn|error');

  const maxTurnsRaw = env.CLAUDE_MAX_TURNS?.trim();
  const maxTurns = maxTurnsRaw ? intIn(maxTurnsRaw, 0, 1, 1000, 'CLAUDE_MAX_TURNS', problems) : undefined;

  const cfg: AppConfig = {
    webHost,
    webPort,
    webAccessToken,
    workspaceRoot,
    botDir: realBotDir,
    projects,
    dbPath: path.resolve(botDir, env.DB_PATH?.trim() || 'data/app.sqlite'),
    permissionMode: modeRaw,
    approvalTimeoutMs: intIn(env.APPROVAL_TIMEOUT_SEC, 600, 30, 3600, 'APPROVAL_TIMEOUT_SEC', problems) * 1000,
    maxImageBytes: Math.round(intIn(env.MAX_IMAGE_MB, 5, 1, 10, 'MAX_IMAGE_MB', problems) * 1024 * 1024),
    maxImages: intIn(env.MAX_IMAGES, 4, 1, 10, 'MAX_IMAGES', problems),
    maxPendingPerConversation: intIn(env.MAX_PENDING_PER_CONVERSATION, 3, 1, 20, 'MAX_PENDING_PER_CONVERSATION', problems),
    model: env.CLAUDE_MODEL?.trim() || undefined,
    maxTurns: maxTurns || undefined,
    settingSources,
    claudeExecutable,
    logLevel,
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
