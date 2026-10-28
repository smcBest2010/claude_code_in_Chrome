import { BOT_ENV_KEYS } from './config.js';

/**
 * Variables that bind a process to an existing Claude Code session. If the bot is started from inside a
 * Claude Code terminal, inheriting these would make every Discord job write into that terminal's session.
 */
const SESSION_BINDING_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
];

/** Environment for the Claude Code subprocess: the bot's own secrets and session-binding vars removed. */
export function buildChildEnv(src: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const drop = new Set([...BOT_ENV_KEYS, ...SESSION_BINDING_VARS]);
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!drop.has(k)) out[k] = v;
  }
  return out;
}
