// Builds the deployment service into dist/: the compiled sources and a package.json that makes Node.js
// treat them as ES modules. The result has no dependencies besides Node.js itself.
//
//   pnpm --filter @emucat/deployer build      (deploy/docker/deployer.Dockerfile runs this)
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(pkg, 'dist');
const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');

rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], {
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);

writeFileSync(
  join(dist, 'package.json'),
  `${JSON.stringify({ name: '@emucat/deployer-dist', private: true, type: 'module', main: 'main.js' }, null, 2)}\n`,
);
const files = readdirSync(dist).sort();
if (!files.includes('main.js') || files.some((file) => file.endsWith('.ts'))) {
  console.error(`Unexpected build output: ${files.join(', ')}`);
  process.exit(1);
}
console.log(`Built ${dist}: ${files.join(', ')}`);
