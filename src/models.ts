import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from './config.js';

export type ModelChoice = Pick<ModelInfo, 'value' | 'resolvedModel' | 'displayName'>;

/** Ask the installed Claude Code CLI for the model picker shown to this account and project. */
export class ModelCatalog {
  private readonly cache = new Map<string, { until: number; models: ModelChoice[] }>();
  private readonly pending = new Map<string, Promise<ModelChoice[]>>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly childEnv: Record<string, string | undefined>,
    private readonly queryFn: typeof query = query,
  ) {}

  async list(projectName: string): Promise<ModelChoice[]> {
    const project = this.cfg.projects.get(projectName);
    if (!project) throw new Error('알 수 없는 프로젝트입니다.');
    const cached = this.cache.get(project.path);
    if (cached && cached.until > Date.now()) return cached.models;
    const running = this.pending.get(project.path);
    if (running) return running;

    const request = this.fetch(project.path)
      .then((models) => {
        this.cache.set(project.path, { until: Date.now() + 5 * 60_000, models });
        return models;
      })
      .finally(() => this.pending.delete(project.path));
    this.pending.set(project.path, request);
    return request;
  }

  private async fetch(cwd: string): Promise<ModelChoice[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    // The CLI initializes and returns its model catalog before any user prompt is sent.
    const prompt = (async function* () { await new Promise<void>(() => {}); })();
    let session: ReturnType<typeof query> | null = null;
    try {
      session = this.queryFn({
        prompt,
        options: {
          cwd,
          permissionMode: this.cfg.permissionMode,
          allowDangerouslySkipPermissions: this.cfg.permissionMode === 'bypassPermissions',
          settingSources: this.cfg.settingSources,
          pathToClaudeCodeExecutable: this.cfg.claudeExecutable,
          env: this.childEnv,
          abortController: controller,
        },
      });
      const raw = await session.supportedModels();
      const seen = new Set<string>();
      const models = raw
        .filter((m) => typeof m.value === 'string' && /^[a-zA-Z0-9._\[\]-]{1,80}$/.test(m.value))
        .filter((m) => !seen.has(m.value) && !!seen.add(m.value))
        .slice(0, 30)
        .map((m) => ({ value: m.value, resolvedModel: m.resolvedModel, displayName: m.displayName.slice(0, 100) }));
      if (!models.length) throw new Error('Claude Code에서 사용할 수 있는 모델이 없습니다.');
      return models;
    } finally {
      session?.close();
      clearTimeout(timeout);
    }
  }
}
