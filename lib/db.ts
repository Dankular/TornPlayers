import postgres from "postgres";
import { mapWithConcurrency } from "./concurrency";
import type { TornHofCategory } from "./types";

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null | undefined; // undefined = not yet resolved, null = no DB configured
let schemaReady: Promise<void> | null = null;

/**
 * Shared player cache, backed by Postgres (Vercel Postgres / Neon, or any
 * standard connection string in DATABASE_URL / POSTGRES_URL). Entirely
 * optional — every function here is a no-op (or returns empty) when no
 * connection string is configured, so the app works exactly as before
 * without a database attached.
 */
export function getSql(): Sql | null {
  if (client !== undefined) return client;

  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    client = null;
    return null;
  }

  client = postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
  return client;
}

async function createSchema(sql: Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS players (
      id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      level INT NOT NULL,
      faction_id BIGINT,
      hof_categories JSONB NOT NULL DEFAULT '{}'::jsonb,
      fair_fight REAL,
      bs_estimate BIGINT,
      bs_estimate_human TEXT,
      hof_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      stats_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS players_level_idx ON players (level DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS players_fair_fight_idx ON players (fair_fight)`;

  await sql`
    CREATE TABLE IF NOT EXISTS hof_scan_cursor (
      category TEXT PRIMARY KEY,
      next_offset INT NOT NULL DEFAULT 0,
      last_scanned_at TIMESTAMPTZ,
      total_known INT
    )
  `;
}

/** Idempotent; safe to call on every cold start (cached per warm instance). */
export async function ensureSchema(sql: Sql): Promise<void> {
  if (!schemaReady) {
    schemaReady = createSchema(sql).catch((err) => {
      schemaReady = null; // allow retry on the next call if it failed
      throw err;
    });
  }
  return schemaReady;
}

export interface CachedPlayer {
  id: number;
  name: string;
  level: number;
  faction_id: number | null;
  hof_categories: Record<string, { value: number | string; rank: string }>;
  fair_fight: number | null;
  bs_estimate: number | null;
  bs_estimate_human: string | null;
}

/** Upserts HOF sightings, merging new category placements into any existing record. */
export async function upsertHofEntries(
  sql: Sql,
  entries: { id: number; name: string; level: number; faction_id: number | null; category: TornHofCategory; value: number | string; rank: string }[]
): Promise<void> {
  const merged = new Map<number, { id: number; name: string; level: number; faction_id: number | null; categories: Record<string, { value: number | string; rank: string }> }>();
  for (const e of entries) {
    let m = merged.get(e.id);
    if (!m) {
      m = { id: e.id, name: e.name, level: e.level, faction_id: e.faction_id, categories: {} };
      merged.set(e.id, m);
    }
    m.categories[e.category] = { value: e.value, rank: e.rank };
  }
  const rows = Array.from(merged.values());
  if (rows.length === 0) return;

  await mapWithConcurrency(rows, 10, async (r) => {
    await sql`
      INSERT INTO players (id, name, level, faction_id, hof_categories, hof_seen_at)
      VALUES (${r.id}, ${r.name}, ${r.level}, ${r.faction_id}, ${sql.json(r.categories)}, now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        level = EXCLUDED.level,
        faction_id = EXCLUDED.faction_id,
        hof_categories = players.hof_categories || EXCLUDED.hof_categories,
        hof_seen_at = now()
    `;
  });
}

/** Refreshes cached fair-fight / battle-stat estimates for players already known to us. */
export async function upsertStats(
  sql: Sql,
  stats: { id: number; fair_fight: number | null; bs_estimate: number | null; bs_estimate_human: string | null }[]
): Promise<void> {
  if (stats.length === 0) return;
  await mapWithConcurrency(stats, 10, async (s) => {
    await sql`
      UPDATE players
      SET fair_fight = ${s.fair_fight}, bs_estimate = ${s.bs_estimate}, bs_estimate_human = ${s.bs_estimate_human}, stats_updated_at = now()
      WHERE id = ${s.id}
    `;
  });
}

/**
 * The deep candidate pool built up over time by the background scanner (and
 * by opportunistic caching from live searches) — everyone at or above
 * minLevel with a known fair-fight estimate, best (level, fair fight) first.
 */
export async function queryCandidatePool(sql: Sql, minLevel: number, limit: number): Promise<CachedPlayer[]> {
  const rows = await sql<CachedPlayer[]>`
    SELECT id, name, level, faction_id, hof_categories, fair_fight, bs_estimate, bs_estimate_human
    FROM players
    WHERE level >= ${minLevel} AND fair_fight IS NOT NULL
    ORDER BY level DESC, fair_fight ASC
    LIMIT ${limit}
  `;
  return rows;
}

export interface ScanCursor {
  category: string;
  next_offset: number;
}

/** Picks the category that's gone longest without a scan (round robin), creating cursor rows as needed. */
export async function pickScanCategory(sql: Sql, categories: readonly string[]): Promise<ScanCursor> {
  await mapWithConcurrency([...categories], categories.length, async (c) => {
    await sql`INSERT INTO hof_scan_cursor (category) VALUES (${c}) ON CONFLICT DO NOTHING`;
  });

  const [row] = await sql<ScanCursor[]>`
    SELECT category, next_offset FROM hof_scan_cursor
    WHERE category = ANY(${sql.array(categories as string[])})
    ORDER BY last_scanned_at ASC NULLS FIRST
    LIMIT 1
  `;
  return row;
}

export async function advanceScanCursor(sql: Sql, category: string, nextOffset: number, totalKnown: number): Promise<void> {
  await sql`
    UPDATE hof_scan_cursor
    SET next_offset = ${nextOffset}, last_scanned_at = now(), total_known = ${totalKnown}
    WHERE category = ${category}
  `;
}
