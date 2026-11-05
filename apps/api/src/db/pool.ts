import mysql, { type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise';
import type { Config } from '../config.js';

export function connectionOptions(database: Config['database']): PoolOptions {
  return {
    host: database.host,
    port: database.port,
    database: database.name,
    user: database.user,
    password: database.password,
    timezone: 'Z',
    dateStrings: false,
    charset: 'utf8mb4',
    connectTimeout: 5_000,
  };
}

/** Runs `work` in a transaction on one connection: commits if it resolves, rolls back if it throws. */
export async function withTransaction<T>(
  pool: Pool,
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export function createPool(database: Config['database']): Pool {
  const pool = mysql.createPool({
    ...connectionOptions(database),
    connectionLimit: 10,
    waitForConnections: true,
    // Fail readiness promptly instead of queueing while the database is unavailable.
    queueLimit: 50,
  });
  // Timestamps are stored in UTC whatever the server's default time zone is.
  pool.pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return pool;
}
