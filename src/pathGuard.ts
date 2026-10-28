import fs from 'node:fs';
import path from 'node:path';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Resolve symlinks for the longest existing prefix of `p` and append the
 * non-existent remainder. This catches "write to link/../outside" and
 * "create a new file inside a symlinked dir that points outside the project".
 */
export function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const a = CASE_INSENSITIVE_FS ? root.toLowerCase() : root;
  const b = CASE_INSENSITIVE_FS ? target.toLowerCase() : target;
  const rel = path.relative(a, b);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

const SECRET_BASENAMES: RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$|defaults$).+$/i,
  /^\.envrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|pgpass)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
  /^service[-_]?account.*\.json$/i,
];
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.azure', 'gcloud']);

/** Files that typically hold credentials. Reading or editing them is blocked even inside the project. */
export function isSecretPath(p: string): boolean {
  const base = path.basename(p);
  if (SECRET_BASENAMES.some((r) => r.test(base))) return true;
  const parts = p.split(/[\\/]+/).map((s) => s.toLowerCase());
  return parts.some((seg) => SECRET_DIRS.has(seg));
}

export type GuardVerdict =
  | { kind: 'pass' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string };

/** Tools that take filesystem paths, and the input fields that hold them. */
const PATH_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  NotebookRead: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
};

/** Tools whose effect can't be scoped by path inspection: always routed to the approval buttons. */
const ALWAYS_ASK = new Set(['Bash', 'PowerShell', 'WebFetch', 'BashOutput', 'KillShell', 'KillBash']);

/** Tools that can change files or run code. Used to warn about partial modifications. */
export const MODIFYING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);

function staticGlobPrefix(pattern: string): string {
  const idx = pattern.search(/[*?[{]/);
  const prefix = idx === -1 ? pattern : pattern.slice(0, idx);
  return idx === -1 ? prefix : path.dirname(prefix + 'x');
}

function checkPath(raw: string, root: string, cwd: string, blockedDir?: string): GuardVerdict | null {
  const abs = path.resolve(cwd, raw);
  const real = realpathLoose(abs);
  if (!isInside(root, real)) {
    return { kind: 'deny', reason: `프로젝트 경로 밖 접근 차단: ${raw}` };
  }
  if (blockedDir && isInside(blockedDir, real)) {
    return { kind: 'deny', reason: `앱 설정 폴더 접근 차단: ${raw}` };
  }
  if (isSecretPath(path.relative(root, real) || path.basename(real))) {
    return { kind: 'deny', reason: `인증정보로 보이는 파일 접근 차단: ${path.basename(real)}` };
  }
  return null;
}

/**
 * Decide what to do with a tool call before Claude Code's own permission flow.
 * - deny: outside the project root or a credential file (security block, job is stopped)
 * - ask:  force the Discord approval buttons even if a settings allow-rule or read-only heuristic would auto-approve
 * - pass: let the normal permission flow (mode, rules, canUseTool) decide
 */
export function checkToolCall(toolName: string, rawInput: unknown, root: string, cwd: string = root, blockedDir?: string): GuardVerdict {
  const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
  const fields = PATH_FIELDS[toolName];
  if (fields) {
    for (const f of fields) {
      const v = input[f];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string') return { kind: 'deny', reason: `${toolName}: 경로 형식이 올바르지 않습니다` };
      const verdict = checkPath(v, root, cwd, blockedDir);
      if (verdict) return verdict;
    }
    for (const g of ['pattern', 'glob'] as const) {
      const v = input[g];
      if ((toolName === 'Glob' || toolName === 'Grep') && typeof v === 'string' && (path.isAbsolute(v) || v.includes('..'))) {
        const verdict = checkPath(staticGlobPrefix(v), root, cwd, blockedDir);
        if (verdict) return verdict;
      }
    }
    if (blockedDir && (toolName === 'Glob' || toolName === 'Grep')) {
      const searchRoot = realpathLoose(path.resolve(cwd, typeof input.path === 'string' && input.path ? input.path : '.'));
      if (isInside(searchRoot, blockedDir)) {
        return { kind: 'deny', reason: '앱 설정 폴더를 포함하는 광역 검색은 차단됩니다. 하위 폴더를 지정하세요.' };
      }
    }
    return { kind: 'pass' };
  }
  if (ALWAYS_ASK.has(toolName) || toolName.startsWith('mcp__')) {
    return { kind: 'ask', reason: `${toolName} 은(는) 항상 사용자 승인이 필요합니다` };
  }
  return { kind: 'pass' };
}
