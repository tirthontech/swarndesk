import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Connections are the scarce resource on every managed Postgres plan — each backend
// costs the server several MB of RAM whether or not it is doing anything, and plans are
// priced by the connection ceiling. The defaults (max 10 per process, no connection
// timeout) scale badly in both directions: too many idle connections per instance when
// you run several app instances behind a load balancer, and an unbounded wait that turns
// a brief pool shortage into hung requests piling up instead of failing fast.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Per-process ceiling. Total connections = this x number of app instances, so keep it
  // low and scale out horizontally rather than letting one instance hoard the plan's
  // budget. Override with DB_POOL_MAX when running a single large instance.
  max: envInt("DB_POOL_MAX", 10),
  // Hand idle connections back so the database can free their memory during quiet
  // periods; a shop-hours workload like this one is idle most of the day.
  idleTimeoutMillis: envInt("DB_POOL_IDLE_MS", 30_000),
  // Without this, pg waits forever for a free connection: a slow query storm becomes an
  // unbounded queue of stuck requests instead of prompt 500s that shed load.
  connectionTimeoutMillis: envInt("DB_POOL_CONNECT_TIMEOUT_MS", 10_000),
  // Caps what any single runaway query can cost in DB CPU, which is what managed plans
  // actually bill for. Generous enough for the heaviest report here.
  statement_timeout: envInt("DB_STATEMENT_TIMEOUT_MS", 15_000),
  // A query that somehow outlives statement_timeout still can't hold its connection.
  idle_in_transaction_session_timeout: envInt("DB_IDLE_TX_TIMEOUT_MS", 20_000),
  // Stops NAT gateways and load balancers silently dropping pooled connections, which
  // otherwise shows up as intermittent ECONNRESET and forces reconnect churn.
  keepAlive: true,
});

// A pool-level error (e.g. the database restarting) is emitted on the pool, not on any
// one query. Without a listener Node treats it as an unhandled 'error' event and kills
// the process — an avoidable restart, and a cold start for every in-flight request.
pool.on("error", (err) => {
  console.error("[db] idle client error", err.message);
});

export { pool };
export const db = drizzle(pool, { schema });

export * from "./schema";
