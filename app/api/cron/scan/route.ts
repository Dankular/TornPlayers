import { NextRequest, NextResponse } from "next/server";
import { advanceScanCursor, ensureSchema, getSql, pickScanCategory, upsertHofEntries, upsertStats } from "@/lib/db";
import { getFairFightStats } from "@/lib/ffscouter";
import { getHofPage } from "@/lib/torn";
import { TORN_HOF_CATEGORIES } from "@/lib/types";

export const maxDuration = 60;

// How many categories to advance (one HOF page each) per invocation. Kept
// small so a single run finishes comfortably within a serverless function's
// time budget; run this on a schedule and it steadily works through the
// entire Hall of Fame over many invocations, wrapping around and starting
// over once a category's depth is exhausted.
const CATEGORIES_PER_RUN = 3;
const PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET
  // is set on the project. Verify it if configured; otherwise this route is
  // still only doing read-only public-HOF scanning, so it's safe to leave
  // open for manual triggering while you're setting things up.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const sql = getSql();
  if (!sql) {
    return NextResponse.json({ skipped: "No database configured (DATABASE_URL / POSTGRES_URL not set)." });
  }

  const scanKey = process.env.TORN_SCAN_KEY;
  if (!scanKey) {
    return NextResponse.json({ skipped: "No TORN_SCAN_KEY configured — nothing to scan with." });
  }

  await ensureSchema(sql);

  const results: { category: string; offset: number; fetched: number; wrapped: boolean }[] = [];

  for (let i = 0; i < CATEGORIES_PER_RUN; i++) {
    const cursor = await pickScanCategory(sql, TORN_HOF_CATEGORIES);

    let entries;
    try {
      entries = await getHofPage(scanKey, cursor.category as (typeof TORN_HOF_CATEGORIES)[number], PAGE_SIZE, cursor.next_offset);
    } catch (err) {
      results.push({ category: cursor.category, offset: cursor.next_offset, fetched: 0, wrapped: false });
      console.error(`Scan of ${cursor.category}@${cursor.next_offset} failed:`, err);
      continue;
    }

    if (entries.length > 0) {
      await upsertHofEntries(
        sql,
        entries.map((e) => ({
          id: e.id,
          name: e.username,
          level: e.level,
          faction_id: e.faction_id,
          category: cursor.category as (typeof TORN_HOF_CATEGORIES)[number],
          value: e.value,
          rank: e.rank,
        }))
      );

      try {
        const stats = await getFairFightStats(scanKey, entries.map((e) => e.id));
        const statsRows = Array.from(stats.values())
          .filter((s) => s.fair_fight != null)
          .map((s) => ({ id: s.player_id, fair_fight: s.fair_fight, bs_estimate: s.bs_estimate, bs_estimate_human: s.bs_estimate_human }));
        if (statsRows.length > 0) await upsertStats(sql, statsRows);
      } catch (err) {
        // HOF placements are still useful on their own; stats just won't be
        // refreshed this round (e.g. TORN_SCAN_KEY isn't FFScouter-registered).
        console.error("FFScouter refresh during scan failed:", err);
      }
    }

    const wrapped = entries.length < PAGE_SIZE;
    const nextOffset = wrapped ? 0 : cursor.next_offset + PAGE_SIZE;
    await advanceScanCursor(sql, cursor.category, nextOffset, wrapped ? cursor.next_offset + entries.length : -1);

    results.push({ category: cursor.category, offset: cursor.next_offset, fetched: entries.length, wrapped });
  }

  return NextResponse.json({ scanned: results });
}
