const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic API / OAuth tokens
  /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g, // Discord bot tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-[A-Za-z0-9]{32,}\b/g, // generic "sk-" API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const AUTH_HEADER = /(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

export const REDACTED = '[REDACTED]';

/** Masks known secret values and common token formats in any text that leaves the process. */
export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Iterable<string>) {
    this.secrets = [...new Set([...secrets].filter((s) => s && s.length >= 8))].sort((a, b) => b.length - a.length);
  }

  static fromEnv(env: NodeJS.ProcessEnv): Redactor {
    const values: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (v && SECRET_ENV_NAME.test(k)) values.push(v);
    }
    return new Redactor(values);
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const s of this.secrets) {
      if (out.includes(s)) out = out.split(s).join(REDACTED);
    }
    for (const re of PATTERNS) out = out.replace(re, REDACTED);
    out = out.replace(AUTH_HEADER, `$1${REDACTED}`);
    return out;
  }
}
