import { after } from "next/server";
import { mapWithConcurrency } from "./concurrency";
import { ensureSchema, getSql, queryCandidatePool, upsertHofEntries, upsertStats } from "./db";
import { getFairFightStats } from "./ffscouter";
import { getHofPage, getOutgoingAttackHistory, getOwnProfile, getPlayerStatus, TornApiError } from "./torn";
import type { FfScouterStats, MatchedPlayer, SearchOptions, SearchResponse, TornHofCategory, TornHofEntry } from "./types";

const ATTACKABLE_STATE = "Okay";
// Total live status-check budget for a single search, spent across however
// many fair-fight tiers it takes to fill the result list. Keeps the request
// within a serverless function's execution/rate-limit budget.
const MAX_STATUS_CHECKS = 80;
const STATUS_CHECK_CONCURRENCY = 8;
const HOF_PAGE_CONCURRENCY = 4;

// How far back (and how many pages of 100) to look when checking prior
// attack history for the "Previously attacked" exclusion filter.
const ATTACK_HISTORY_LOOKBACK_DAYS = 180;
const ATTACK_HISTORY_MAX_PAGES = 5;

// How many players to pull from the shared database cache (built up by the
// background scanner and by prior searches) on top of this request's own
// live HOF pages. This is what lets later searches reach further into the
// Hall of Fame than a single request's live scan budget ever could.
const DB_POOL_LIMIT = 3000;

// There's no meaningful "right" fair fight cutoff to ask the user for up
// front — the whole point is to find *something* attackable. So instead of a
// fixed range, widen the fair-fight ceiling in steps until enough matches
// are found (or the status-check budget runs out), trying the easiest tier
// first and only falling back to a harder one when the easy tier comes up
// empty. Torn's fair-fight respect bonus caps out at 3x, so a fight above
// that gives no extra reward for the added risk — this list never goes
// higher, on purpose, so escalation can widen the search without ever
// reaching into "you will lose this" territory.
const FAIR_FIGHT_TIERS = [1, 1.5, 2, 2.5, 3];

interface CandidateInfo {
  level: number;
  categories: { category: TornHofCategory; value: number | string; rank: string }[];
}

export async function runSearch(options: SearchOptions): Promise<SearchResponse> {
  const { apiKey } = options;

  const self = await getOwnProfile(apiKey);

  // 1. Build a candidate pool from this request's own live scan of the
  // public Torn Hall of Fame.
  const hofRequests: { category: TornHofCategory; page: number }[] = [];
  for (const category of options.categories) {
    for (let page = 0; page < options.pagesPerCategory; page++) {
      hofRequests.push({ category, page });
    }
  }

  const candidateEntries = new Map<number, CandidateInfo>();

  let hofErrors = 0;
  let lastHofError: TornApiError | null = null;

  const pages = await mapWithConcurrency(hofRequests, HOF_PAGE_CONCURRENCY, async ({ category, page }) => {
    try {
      return { category, entries: await getHofPage(apiKey, category, 100, page * 100) };
    } catch (err) {
      // A single category/page failing (e.g. transient rate limit) shouldn't
      // sink the whole search — but keep track in case *every* request fails,
      // which usually means the key itself lacks Hall of Fame access.
      hofErrors++;
      if (err instanceof TornApiError) lastHofError = err;
      return { category, entries: [] as TornHofEntry[] };
    }
  });

  if (hofErrors > 0 && hofErrors === hofRequests.length && lastHofError) {
    throw lastHofError;
  }

  for (const { category, entries } of pages) {
    for (const entry of entries) {
      if (entry.id === self.id) continue;
      const existing = candidateEntries.get(entry.id);
      const hofRef = { category, value: entry.value, rank: entry.rank };
      if (existing) {
        existing.categories.push(hofRef);
      } else {
        candidateEntries.set(entry.id, { level: entry.level, categories: [hofRef] });
      }
    }
  }

  const liveCandidateIds = Array.from(candidateEntries.keys());

  // 2. Estimate battle stats / fair fight ratio for this request's own
  // live-scanned candidates via FFScouter.
  const statsMap = new Map<number, FfScouterStats>(await getFairFightStats(apiKey, liveCandidateIds));

  // 2b. Widen the pool with the shared database cache — everyone the
  // background scanner (or an earlier search) has already recorded, so this
  // search can look far deeper into the Hall of Fame than its own live pages
  // cover. Entirely optional: if no database is configured, or the query
  // fails for any reason, the search just proceeds live-only exactly as
  // before. Cached fair-fight numbers are provisional — anything actually
  // considered for a match gets re-verified against FFScouter before it's
  // ever shown (see the tier loop below).
  const cachedIds = new Set<number>();
  const sql = getSql();
  if (sql) {
    try {
      await ensureSchema(sql);
      const dbRows = await queryCandidatePool(sql, options.minLevel, DB_POOL_LIMIT);
      for (const row of dbRows) {
        const id = Number(row.id);
        if (id === self.id || candidateEntries.has(id)) continue;
        const categories = Object.entries(row.hof_categories).map(([category, v]) => ({
          category: category as TornHofCategory,
          value: v.value,
          rank: v.rank,
        }));
        candidateEntries.set(id, { level: row.level, categories });
        statsMap.set(id, {
          player_id: id,
          fair_fight: row.fair_fight,
          bs_estimate: row.bs_estimate != null ? Number(row.bs_estimate) : null,
          bs_estimate_human: row.bs_estimate_human,
          bss_public: null,
          last_updated: null,
          source: "cache",
        });
        cachedIds.add(id);
      }
    } catch (err) {
      console.error("Player cache lookup failed, continuing live-only:", err);
    }
  }

  const candidateIds = Array.from(candidateEntries.keys());

  // 2c. Optionally exclude opponents this key has already attacked, so you
  // don't keep hitting the same targets.
  let previouslyAttackedIds: Set<number> | null = null;
  if (options.excludePreviouslyAttacked) {
    const sinceTimestamp = Math.floor(Date.now() / 1000) - ATTACK_HISTORY_LOOKBACK_DAYS * 86400;
    try {
      const history = await getOutgoingAttackHistory(apiKey, sinceTimestamp, ATTACK_HISTORY_MAX_PAGES);
      previouslyAttackedIds = new Set(history.keys());
    } catch (err) {
      if (err instanceof TornApiError && err.code === 16) {
        throw new TornApiError(16, "This key is missing the attack history permission needed for the \"Previously attacked\" filter.");
      }
      throw err;
    }
  }

  // Hard safety ceiling: never match someone whose estimated total battle
  // stats outright exceed the key owner's own — that's a losing fight
  // regardless of what the fair-fight number says. Only enforceable when the
  // key exposes the owner's own battlestats; skipped otherwise (the fair
  // fight tiers above are still doing real filtering in that case).
  const ownTotalStats = self.battlestats?.total ?? null;

  function passesSafety(stats: FfScouterStats | undefined): stats is FfScouterStats {
    if (!stats || stats.fair_fight == null) return false;
    if (ownTotalStats != null && stats.bs_estimate != null && stats.bs_estimate > ownTotalStats) return false;
    return true;
  }

  // Everyone who clears the level floor, has a usable fair-fight estimate,
  // isn't a certain loss on raw stats, and (if requested) hasn't already
  // been attacked by this key — ranked highest level first (fair fight as
  // the tiebreaker). This ordering is fixed up front; the tier loop below
  // only changes how far down it we're willing to look, and re-checks
  // anything cache-sourced before trusting it.
  const eligible = candidateIds
    .map((id) => ({ id, snapshotLevel: candidateEntries.get(id)?.level ?? 0 }))
    .filter((c) => {
      if (c.snapshotLevel < options.minLevel) return false;
      if (previouslyAttackedIds?.has(c.id)) return false;
      return passesSafety(statsMap.get(c.id));
    })
    .sort((a, b) => b.snapshotLevel - a.snapshotLevel || (statsMap.get(a.id)!.fair_fight ?? 0) - (statsMap.get(b.id)!.fair_fight ?? 0));

  // 3. Widen the fair-fight ceiling tier by tier, live-checking status
  // (hospital/traveling/abroad/etc.) only for candidates not already
  // checked in an earlier, easier tier, until we have enough attackable
  // matches or run out of budget.
  const matches: MatchedPlayer[] = [];
  const checked = new Set<number>();
  const refreshedStats: { id: number; fair_fight: number | null; bs_estimate: number | null; bs_estimate_human: string | null }[] = [];
  let statusChecksSpent = 0;
  let fairFightCeilingUsed: number | null = null;

  for (const tier of FAIR_FIGHT_TIERS) {
    if (matches.length >= options.limit || statusChecksSpent >= MAX_STATUS_CHECKS) break;

    const tierCandidates = eligible.filter((c) => !checked.has(c.id) && statsMap.get(c.id)!.fair_fight! <= tier);
    if (tierCandidates.length === 0) continue;

    const remainingBudget = MAX_STATUS_CHECKS - statusChecksSpent;
    const batch = tierCandidates.slice(0, remainingBudget);
    fairFightCeilingUsed = tier;

    // Anything sourced from the cache gets a fresh FFScouter read before we
    // spend a live status check on it — battle stats drift over time, and
    // we only ever want to show numbers verified right now.
    const toRefresh = batch.filter((c) => cachedIds.has(c.id)).map((c) => c.id);
    if (toRefresh.length > 0) {
      const refreshed = await getFairFightStats(apiKey, toRefresh);
      for (const [id, stats] of refreshed) {
        statsMap.set(id, stats);
        cachedIds.delete(id);
        refreshedStats.push({ id, fair_fight: stats.fair_fight, bs_estimate: stats.bs_estimate, bs_estimate_human: stats.bs_estimate_human });
      }
    }

    await mapWithConcurrency(batch, STATUS_CHECK_CONCURRENCY, async ({ id }) => {
      checked.add(id);
      statusChecksSpent++;
      if (matches.length >= options.limit) return;

      const stats = statsMap.get(id);
      if (!passesSafety(stats) || stats.fair_fight! > tier) return; // no longer qualifies post-refresh

      try {
        const profile = await getPlayerStatus(apiKey, id);
        if (profile.status.state !== ATTACKABLE_STATE) return;
        if (profile.level < options.minLevel) return;

        const candidate = candidateEntries.get(id);
        matches.push({
          id: profile.id,
          name: profile.name,
          level: profile.level,
          faction_id: profile.faction_id,
          status: profile.status,
          fair_fight: stats.fair_fight,
          bs_estimate: stats.bs_estimate,
          bs_estimate_human: stats.bs_estimate_human,
          last_action: profile.last_action?.timestamp ?? 0,
          hof_categories: candidate?.categories ?? [],
        });
      } catch (err) {
        if (err instanceof TornApiError && err.code === 5) {
          // Rate limited — skip this candidate rather than fail the search.
          return;
        }
        // Deleted/invalid accounts, transient errors, etc. — skip.
        return;
      }
    });
  }

  // Highest level first (the "big name, weak fighter" target), lowest fair
  // fight as the tiebreaker among equal levels.
  matches.sort((a, b) => b.level - a.level || (a.fair_fight ?? 0) - (b.fair_fight ?? 0));

  // 4. Best-effort: feed everything this search learned back into the
  // shared cache after the response is already on its way out, so it never
  // adds latency and a cache hiccup never breaks the search itself.
  if (sql) {
    const hofEntriesToCache = pages.flatMap(({ category, entries }) =>
      entries
        .filter((e) => e.id !== self.id)
        .map((e) => ({ id: e.id, name: e.username, level: e.level, faction_id: e.faction_id, category, value: e.value, rank: e.rank }))
    );
    const liveStatsToCache = liveCandidateIds
      .map((id) => statsMap.get(id))
      .filter((s): s is FfScouterStats => !!s && s.fair_fight != null)
      .map((s) => ({ id: s.player_id, fair_fight: s.fair_fight, bs_estimate: s.bs_estimate, bs_estimate_human: s.bs_estimate_human }));

    after(async () => {
      try {
        if (hofEntriesToCache.length > 0) await upsertHofEntries(sql, hofEntriesToCache);
        if (liveStatsToCache.length > 0) await upsertStats(sql, liveStatsToCache);
        if (refreshedStats.length > 0) await upsertStats(sql, refreshedStats);
      } catch (err) {
        console.error("Player cache write failed:", err);
      }
    });
  }

  return {
    self,
    candidates_scanned: candidateIds.length,
    candidates_with_stats: eligible.length,
    fair_fight_ceiling_used: fairFightCeilingUsed,
    matches: matches.slice(0, options.limit),
  };
}
