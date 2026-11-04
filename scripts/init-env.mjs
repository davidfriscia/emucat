// Creates .env from .env.example and fills in empty passwords with random values.
// Never overwrites an existing .env.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../.env', import.meta.url));
const example = fileURLToPath(new URL('../.env.example', import.meta.url));

if (existsSync(target)) {
  console.log('.env already exists; leaving it unchanged.');
  process.exit(0);
}

const content = readFileSync(example, 'utf8').replace(
  /^(DB_PASSWORD|MARIADB_ROOT_PASSWORD)=$/gm,
  (_, name) => `${name}=${randomBytes(24).toString('hex')}`,
);
writeFileSync(target, content, { mode: 0o600 });
console.log('Created .env with generated database passwords.');
