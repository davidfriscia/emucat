import { loadConfig } from '../config.js';
import { loadDotEnv } from '../env.js';
import { migrate } from './migrate.js';
import { connectionOptions } from './pool.js';

try {
  loadDotEnv();
  const { database } = loadConfig();
  const { applied, alreadyApplied } = await migrate(connectionOptions(database));
  console.log(
    applied.length > 0
      ? `Applied ${applied.length} migration(s): ${applied.join(', ')}`
      : 'Database is up to date.',
  );
  console.log(`Previously applied: ${alreadyApplied.length}`);
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}
