import { randomBytes } from 'node:crypto';
import mysql, { type Connection, type Pool, type PoolOptions } from 'mysql2/promise';
import { connectionOptions, createPool } from '../src/db/pool.js';
import { loadDotEnv } from '../src/env.js';

loadDotEnv();

function adminOptions(): PoolOptions {
  const password = process.env.MARIADB_ROOT_PASSWORD;
  if (!password) {
    throw new Error(
      'Database tests need MARIADB_ROOT_PASSWORD. Run `pnpm env:init` and `pnpm db:up` first.',
    );
  }
  return {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3307),
    user: 'root',
    password,
    connectTimeout: 5_000,
  };
}

async function connectAdmin(): Promise<Connection> {
  try {
    return await mysql.createConnection(adminOptions());
  } catch (error) {
    throw new Error(
      `Cannot connect to MariaDB for tests. Is it running (\`pnpm db:up\`)? ${String(error)}`,
      { cause: error },
    );
  }
}

export interface TestDatabase {
  options: PoolOptions;
  createPool(): Pool;
  drop(): Promise<void>;
}

/** Creates an empty database with a random name. Nothing touches the development database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = await connectAdmin();
  const name = `emucat_test_${randomBytes(6).toString('hex')}`;
  try {
    await admin.query(`CREATE DATABASE \`${name}\``);
  } finally {
    await admin.end();
  }
  const base = adminOptions();
  const database = {
    host: base.host as string,
    port: base.port as number,
    user: base.user as string,
    password: base.password as string,
    name,
  };
  return {
    options: connectionOptions(database),
    createPool: () => createPool(database),
    drop: async () => {
      const connection = await connectAdmin();
      try {
        await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await connection.end();
      }
    },
  };
}
