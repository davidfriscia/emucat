/**
 * Removes secrets from deployment output before it leaves the host. The log files themselves stay readable
 * only by the deployment account; this is what an administrator sees in the browser.
 */
export interface Sanitizer {
  (text: string): string;
}

const SECRET_KEY = /(PASSWORD|TOKEN|SECRET|KEY|CREDENTIAL)/;
const REDACTED = '[redacted]';

const PATTERNS: [RegExp, string][] = [
  // Terminal escapes and other control characters, which could also disguise text.
  // eslint-disable-next-line no-control-regex
  [/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''],
  // eslint-disable-next-line no-control-regex
  [/[\x00-\x08\x0b-\x1f\x7f]/g, ''],
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    REDACTED,
  ],
  // user:password@ in any URL, such as a Git remote with a token in it.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/(authorization\s*[:=]\s*)(bearer\s+|basic\s+)?[^\s,;]+/gi, `$1${REDACTED}`],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  [
    /\b([A-Z0-9_]*(PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi,
    `$1$3${REDACTED}`,
  ],
  [/(--password(?:=|\s+)|-p)(?!\s)([^\s]+)/g, `$1${REDACTED}`],
];

/** `secrets` are literal values to remove wherever they appear, such as the database password. */
export function createSanitizer(secrets: Iterable<string>): Sanitizer {
  const literals = [...new Set(secrets)]
    .filter((value) => value.length >= 4)
    // Longest first, so that a secret containing another is removed whole.
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let result = text;
    for (const literal of literals) result = result.split(literal).join(REDACTED);
    for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
    return result;
  };
}

/** The values in an environment file that look like secrets, by their names. */
export function secretValues(values: Map<string, string>): string[] {
  return [...values]
    .filter(([key, value]) => SECRET_KEY.test(key) && value !== '')
    .map(([, value]) => value);
}
