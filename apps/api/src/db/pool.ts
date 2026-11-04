import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';
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
