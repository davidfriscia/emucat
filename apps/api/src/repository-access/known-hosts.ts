import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * OpenSSH `known_hosts`, read the way `ssh -o StrictHostKeyChecking=yes` reads it (decision 0055). A key is trusted
 * only if a line for this host names exactly this key. Nothing is ever added: trust on first use is exactly the
 * window in which an impostor would be believed.
 *
 * Supported: plain and hashed (`|1|salt|hash`) host names, `[host]:port` for other ports, comma-separated patterns,
 * `*` and `?` wildcards, `!` negation, and `@revoked`. `@cert-authority` lines are ignored, so a host certificate is
 * never accepted: nothing configures a trusted CA.
 */

export type HostKeyVerdict = 'trusted' | 'unknown' | 'changed' | 'revoked';

interface KnownHostLine {
  marker: 'revoked' | 'cert-authority' | null;
  patterns: string[];
  keyType: string;
  key: Buffer;
}

export interface KnownHosts {
  lines: KnownHostLine[];
}

export function parseKnownHosts(text: string): KnownHosts {
  const lines: KnownHostLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    let marker: KnownHostLine['marker'] = null;
    if (fields[0]?.startsWith('@')) {
      const name = fields.shift();
      if (name === '@revoked') marker = 'revoked';
      else if (name === '@cert-authority') marker = 'cert-authority';
      else continue;
    }
    const [hosts, keyType, keyText] = fields;
    if (!hosts || !keyType || !keyText) continue;
    const key = Buffer.from(keyText, 'base64');
    if (key.length === 0) continue;
    lines.push({ marker, patterns: hosts.split(','), keyType, key });
  }
  return { lines };
}

/** How OpenSSH names a host in known_hosts: bare on port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function wildcardMatch(pattern: string, name: string): boolean {
  const expression = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  );
  return expression.test(name);
}

function hashedMatch(pattern: string, name: string): boolean {
  const parts = pattern.split('|');
  // |1|salt|hash
  if (parts.length !== 4 || parts[1] !== '1') return false;
  const salt = Buffer.from(parts[2] ?? '', 'base64');
  const expected = Buffer.from(parts[3] ?? '', 'base64');
  const actual = createHmac('sha1', salt).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hostMatches(patterns: string[], name: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('|')) {
      if (hashedMatch(pattern, name)) matched = true;
      continue;
    }
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (wildcardMatch(body, name)) {
      // A negated match excludes the line, whatever else matched.
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

/** The type named inside an SSH public key blob: its first length-prefixed string. */
export function keyTypeOf(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > 64 || 4 + length > blob.length) return null;
  return blob.subarray(4, 4 + length).toString('ascii');
}

/** `SHA256:…`, as `ssh-keygen -lf` prints it. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Decides about one presented host key. Only `trusted` lets a connection go on. */
export function verifyHostKey(
  knownHosts: KnownHosts,
  host: string,
  port: number,
  blob: Buffer,
): HostKeyVerdict {
  const name = knownHostsName(host, port);
  const type = keyTypeOf(blob);
  const matching = knownHosts.lines.filter((line) => hostMatches(line.patterns, name));
  if (matching.some((line) => line.marker === 'revoked' && line.key.equals(blob))) return 'revoked';
  const plain = matching.filter((line) => line.marker === null);
  if (plain.some((line) => line.key.equals(blob))) return 'trusted';
  // Another key of the same type is on record: the server is not who it was, or was reinstalled.
  if (plain.some((line) => line.keyType === type)) return 'changed';
  return 'unknown';
}

/**
 * The host key algorithms to offer, in preference order, limited to the types known_hosts has for this host. The
 * server then presents a key that can be checked, as OpenSSH arranges, instead of one of a type nobody recorded.
 */
export function hostKeyAlgorithmsFor(knownHosts: KnownHosts, host: string, port: number): string[] {
  const name = knownHostsName(host, port);
  const types = new Set(
    knownHosts.lines
      .filter((line) => line.marker === null && hostMatches(line.patterns, name))
      .map((line) => line.keyType),
  );
  const preference: [string, string[]][] = [
    ['ssh-ed25519', ['ssh-ed25519']],
    ['ecdsa-sha2-nistp256', ['ecdsa-sha2-nistp256']],
    ['ecdsa-sha2-nistp384', ['ecdsa-sha2-nistp384']],
    ['ecdsa-sha2-nistp521', ['ecdsa-sha2-nistp521']],
    ['ssh-rsa', ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']],
  ];
  return preference.filter(([type]) => types.has(type)).flatMap(([, algorithms]) => algorithms);
}
