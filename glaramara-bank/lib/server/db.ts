import "server-only";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var glaramaraPostgresPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required by the Glaramara server");
  }

  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    application_name: "glaramara-bank",
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
}

export function getPool(): Pool {
  globalThis.glaramaraPostgresPool ??= createPool();
  return globalThis.glaramaraPostgresPool;
}

export async function query<Row extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  return getPool().query<Row>(text, [...values]);
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
