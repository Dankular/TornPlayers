import { createClient, type Client } from "@libsql/client";
import { mapWithConcurrency } from "./concurrency";
import type { TornHofCategory } from "./types";

export type Sql = Client;

let client: Sql | null | undefined; // undefined = not yet resolved, null = no DB configured
let schemaReady: Promise<void> | null = null;

// SQLite has no native TIMESTAMPTZ, so every stored timestamp is an ISO8601
// UTC string with an explicit 'Z' — `datetime('now')` alone omits it, and a
// space-separated (non-'T') string like that gets parsed as *local* time by
// JS's Date constructor, which would silently corrupt every "last shown" /
// "last scanned" comparison depending on the server's timezone.
const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Shared player cache, backed by Turso (hosted libSQL/SQLite). Entirely
 * optional — every function here is a no-op (or returns empty) when no
 * connection is configured, so the app works exactly as before without a
 * database attached.
 */
export function getSql(): Sql | null {
  if (client !== undefined) return client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  // A remote libsql:// URL is useless without its auth token — treat that
  // combination as "not configured" rather than letting every query fail.
  if (!url || (url.startsWith("libsql://") && !authToken)) {
    client = null;
    return null;
  }

  client = createClient({ url, authToken });
  return client;
}

async function createSchema(sql: Sql) {
  await sql.execute(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      level INTEGER NOT NULL,
      faction_id INTEGER,
      hof_categories TEXT NOT NULL DEFAULT '{}',
      fair_fight REAL,
      bs_estimate INTEGER,
      bs_estimate_human TEXT,
      hof_seen_at TEXT NOT NULL DEFAULT (${NOW_UTC}),
      stats_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_UTC})
    )
  `);
  await sql.execute(`CREATE INDEX IF NOT EXISTS players_level_idx ON players (level DESC)`);
  await sql.execute(`CREATE INDEX IF NOT EXISTS players_fair_fight_idx ON players (fair_fight)`);

  await sql.execute(`
    CREATE TABLE IF NOT EXISTS hof_scan_cursor (
      category TEXT PRIMARY KEY,
      next_offset INTEGER NOT NULL DEFAULT 0,
      last_scanned_at TEXT,
      total_known INTEGER
    )
  `);

  // Round-robin cursor for the 'user' -> 'search' background scan, one row
  // per level bucket (see LEVEL_SEARCH_BUCKETS) — the same pattern as
  // hof_scan_cursor, but paging through the whole playerbase in that band
  // instead of a single Hall of Fame category.
  await sql.execute(`
    CREATE TABLE IF NOT EXISTS user_search_cursor (
      bucket TEXT PRIMARY KEY,
      min_level INTEGER NOT NULL,
      max_level INTEGER NOT NULL,
      next_offset INTEGER NOT NULL DEFAULT 0,
      last_scanned_at TEXT,
      total_known INTEGER
    )
  `);

  // Per-searcher "already shown" history, so repeat searches from the same
  // Torn account rotate through the pool instead of always converging on
  // the same handful of best-ranked players.
  await sql.execute(`
    CREATE TABLE IF NOT EXISTS shown_matches (
      searcher_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      shown_at TEXT NOT NULL DEFAULT (${NOW_UTC}),
      PRIMARY KEY (searcher_id, player_id)
    )
  `);
  await sql.execute(`CREATE INDEX IF NOT EXISTS shown_matches_searcher_idx ON shown_matches (searcher_id, shown_at)`);
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
    await sql.execute({
      sql: `
        INSERT INTO players (id, name, level, faction_id, hof_categories, hof_seen_at)
        VALUES (?, ?, ?, ?, ?, ${NOW_UTC})
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          level = excluded.level,
          faction_id = excluded.faction_id,
          hof_categories = json_patch(players.hof_categories, excluded.hof_categories),
          hof_seen_at = ${NOW_UTC}
      `,
      args: [r.id, r.name, r.level, r.faction_id, JSON.stringify(r.categories)],
    });
  });
}

/**
 * Upserts players discovered via 'user' -> 'search' — they have no Hall of
 * Fame category, so unlike upsertHofEntries this never touches
 * hof_categories on conflict (leaving any HOF placements already on record
 * untouched rather than clobbering them with an empty object).
 */
export async function upsertPlayerBasics(
  sql: Sql,
  entries: { id: number; name: string; level: number; faction_id: number | null }[]
): Promise<void> {
  if (entries.length === 0) return;
  await mapWithConcurrency(entries, 10, async (r) => {
    await sql.execute({
      sql: `
        INSERT INTO players (id, name, level, faction_id, hof_categories, hof_seen_at)
        VALUES (?, ?, ?, ?, '{}', ${NOW_UTC})
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          level = excluded.level,
          faction_id = excluded.faction_id,
          hof_seen_at = ${NOW_UTC}
      `,
      args: [r.id, r.name, r.level, r.faction_id],
    });
  });
}

/** Refreshes cached fair-fight / battle-stat estimates for players already known to us. */
export async function upsertStats(
  sql: Sql,
  stats: { id: number; fair_fight: number | null; bs_estimate: number | null; bs_estimate_human: string | null }[]
): Promise<void> {
  if (stats.length === 0) return;
  await mapWithConcurrency(stats, 10, async (s) => {
    await sql.execute({
      sql: `
        UPDATE players
        SET fair_fight = ?, bs_estimate = ?, bs_estimate_human = ?, stats_updated_at = ${NOW_UTC}
        WHERE id = ?
      `,
      args: [s.fair_fight, s.bs_estimate, s.bs_estimate_human, s.id],
    });
  });
}

/**
 * The deep candidate pool built up over time by the background scanner (and
 * by opportunistic caching from live searches) — everyone at or above
 * minLevel with a known fair-fight estimate, best (level, fair fight) first.
 */
export async function queryCandidatePool(sql: Sql, minLevel: number, limit: number): Promise<CachedPlayer[]> {
  const res = await sql.execute({
    sql: `
      SELECT id, name, level, faction_id, hof_categories, fair_fight, bs_estimate, bs_estimate_human
      FROM players
      WHERE level >= ? AND fair_fight IS NOT NULL
      ORDER BY level DESC, fair_fight ASC
      LIMIT ?
    `,
    args: [minLevel, limit],
  });
  return res.rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    level: Number(row.level),
    faction_id: row.faction_id != null ? Number(row.faction_id) : null,
    hof_categories: JSON.parse(String(row.hof_categories)),
    fair_fight: row.fair_fight != null ? Number(row.fair_fight) : null,
    bs_estimate: row.bs_estimate != null ? Number(row.bs_estimate) : null,
    bs_estimate_human: row.bs_estimate_human != null ? String(row.bs_estimate_human) : null,
  }));
}

export interface ScanCursor {
  category: string;
  next_offset: number;
}

/**
 * Picks the category that's gone longest without a scan (round robin),
 * creating cursor rows as needed. No WHERE-category filter is needed here —
 * this table only ever holds rows for the exact category set callers pass
 * in, since every row is created by the INSERT loop right above the query.
 */
export async function pickScanCategory(sql: Sql, categories: readonly string[]): Promise<ScanCursor> {
  await mapWithConcurrency([...categories], categories.length, async (c) => {
    await sql.execute({
      sql: `INSERT INTO hof_scan_cursor (category) VALUES (?) ON CONFLICT (category) DO NOTHING`,
      args: [c],
    });
  });

  const res = await sql.execute(`
    SELECT category, next_offset FROM hof_scan_cursor
    ORDER BY last_scanned_at ASC
    LIMIT 1
  `);
  const row = res.rows[0];
  return { category: String(row.category), next_offset: Number(row.next_offset) };
}

export async function advanceScanCursor(sql: Sql, category: string, nextOffset: number, totalKnown: number): Promise<void> {
  await sql.execute({
    sql: `UPDATE hof_scan_cursor SET next_offset = ?, last_scanned_at = ${NOW_UTC}, total_known = ? WHERE category = ?`,
    args: [nextOffset, totalKnown, category],
  });
}

export interface SearchCursor {
  bucket: string;
  min_level: number;
  max_level: number;
  next_offset: number;
}

/** Picks the level bucket that's gone longest without a scan (round robin), creating cursor rows as needed. */
export async function pickSearchBucket(
  sql: Sql,
  buckets: { bucket: string; minLevel: number; maxLevel: number }[]
): Promise<SearchCursor> {
  await mapWithConcurrency(buckets, buckets.length, async (b) => {
    await sql.execute({
      sql: `INSERT INTO user_search_cursor (bucket, min_level, max_level) VALUES (?, ?, ?) ON CONFLICT (bucket) DO NOTHING`,
      args: [b.bucket, b.minLevel, b.maxLevel],
    });
  });

  const res = await sql.execute(`
    SELECT bucket, min_level, max_level, next_offset FROM user_search_cursor
    ORDER BY last_scanned_at ASC
    LIMIT 1
  `);
  const row = res.rows[0];
  return {
    bucket: String(row.bucket),
    min_level: Number(row.min_level),
    max_level: Number(row.max_level),
    next_offset: Number(row.next_offset),
  };
}

export async function advanceSearchCursor(sql: Sql, bucket: string, nextOffset: number, totalKnown: number | null): Promise<void> {
  await sql.execute({
    sql: `UPDATE user_search_cursor SET next_offset = ?, last_scanned_at = ${NOW_UTC}, total_known = ? WHERE bucket = ?`,
    args: [nextOffset, totalKnown, bucket],
  });
}

/** Every player this searcher has been shown before, newest-shown last. */
export async function getShownHistory(sql: Sql, searcherId: number): Promise<Map<number, number>> {
  const res = await sql.execute({
    sql: `SELECT player_id, shown_at FROM shown_matches WHERE searcher_id = ?`,
    args: [searcherId],
  });
  const map = new Map<number, number>();
  for (const row of res.rows) {
    map.set(Number(row.player_id), new Date(String(row.shown_at)).getTime());
  }
  return map;
}

/** Marks players as shown to this searcher just now, so they rotate out of near-term results. */
export async function recordShown(sql: Sql, searcherId: number, playerIds: number[]): Promise<void> {
  if (playerIds.length === 0) return;
  await mapWithConcurrency(playerIds, 10, async (id) => {
    await sql.execute({
      sql: `
        INSERT INTO shown_matches (searcher_id, player_id, shown_at)
        VALUES (?, ?, ${NOW_UTC})
        ON CONFLICT (searcher_id, player_id) DO UPDATE SET shown_at = ${NOW_UTC}
      `,
      args: [searcherId, id],
    });
  });
}
