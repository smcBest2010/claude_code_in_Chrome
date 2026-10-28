import path from 'node:path';

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** Inline-code safe: strip backticks and newlines. */
export function inline(s: string, n = 120): string {
  return truncate(s.replace(/`/g, "'").replace(/\s*\n\s*/g, ' ').trim(), n);
}

/** Text to put inside a ``` block. */
export function block(s: string, n = 1200): string {
  return truncate(s.replace(/```/g, "'''"), n);
}

function rel(p: unknown, root: string): string {
  if (typeof p !== 'string' || !p) return '';
  const r = path.relative(root, path.resolve(root, p));
  return r && !r.startsWith('..') ? r : p;
}

/** One-line description of a tool call for the progress message. */
export function describeTool(name: string, input: Record<string, unknown>, root: string): string {
  switch (name) {
    case 'Read':
      return `읽기 ${inline(rel(input.file_path, root), 80)}`;
    case 'Write':
      return `작성 ${inline(rel(input.file_path, root), 80)}`;
    case 'Edit':
    case 'MultiEdit':
      return `수정 ${inline(rel(input.file_path, root), 80)}`;
    case 'NotebookEdit':
      return `노트북 수정 ${inline(rel(input.notebook_path, root), 80)}`;
    case 'Bash':
    case 'PowerShell':
      return `명령 실행 ${inline(String(input.command ?? ''), 90)}`;
    case 'Glob':
      return `파일 검색 ${inline(String(input.pattern ?? ''), 60)}`;
    case 'Grep':
      return `내용 검색 ${inline(String(input.pattern ?? ''), 60)}`;
    case 'WebFetch':
      return `웹 페이지 ${inline(String(input.url ?? ''), 80)}`;
    case 'WebSearch':
      return `웹 검색 ${inline(String(input.query ?? ''), 60)}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return '할 일 목록 갱신';
    case 'Agent':
    case 'Task':
      return `하위 에이전트: ${inline(String(input.description ?? ''), 60)}`;
    default:
      return `도구 ${inline(name, 60)}`;
  }
}

/** Body of the approval card (markdown). */
export function approvalBody(jobId: number, toolName: string, input: Record<string, unknown>, root: string, meta: { title?: string; decisionReason?: string; blockedPath?: string }, timeoutMs: number): string {
  const lines = [`**권한 요청** · 작업 #${jobId} · \`${inline(toolName, 60)}\``];
  if (meta.title) lines.push(inline(meta.title, 200));
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    if (typeof input.description === 'string' && input.description) lines.push(`설명: ${inline(input.description, 200)}`);
    lines.push('```sh', block(String(input.command ?? ''), 2000), '```');
  } else if (typeof input.file_path === 'string') {
    lines.push(`파일: \`${inline(rel(input.file_path, root), 200)}\``);
    if (typeof input.content === 'string') lines.push('```', block(input.content, 1500), '```');
    if (typeof input.new_string === 'string') lines.push('```diff', block(`- ${String(input.old_string ?? '').split('\n').join('\n- ')}\n+ ${input.new_string.split('\n').join('\n+ ')}`, 1500), '```');
  } else if (toolName === 'ExitPlanMode' && typeof input.plan === 'string') {
    lines.push('```md', block(input.plan, 2000), '```');
  } else if (typeof input.url === 'string') {
    lines.push(`URL: \`${inline(input.url, 300)}\``);
  } else {
    lines.push('```json', block(JSON.stringify(input, null, 1), 1500), '```');
  }
  if (meta.decisionReason) lines.push(`사유: ${inline(meta.decisionReason, 200)}`);
  if (meta.blockedPath) lines.push(`경로: \`${inline(meta.blockedPath, 200)}\``);
  lines.push(`${Math.round(timeoutMs / 60000)}분 안에 응답이 없으면 거절됩니다.`);
  return lines.join('\n');
}
