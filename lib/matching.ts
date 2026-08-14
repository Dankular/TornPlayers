import { mapWithConcurrency } from "./concurrency";
import { getFairFightStats } from "./ffscouter";
import { getHofPage, getOutgoingAttackHistory, getOwnProfile, getPlayerStatus, TornApiError } from "./torn";
import type { MatchedPlayer, SearchOptions, SearchResponse, TornHofCategory, TornHofEntry } from "./types";

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

// There's no meaningful "right" fair fight cutoff to ask the user for up
// front — the whole point is to find *something* attackable. So instead of a
// fixed range, widen the fair-fight ceiling in steps until enough matches
// are found (or the status-check budget runs out), trying the easiest tier
// first and only falling back to a harder one when the easy tier comes up
// empty.
const FAIR_FIGHT_TIERS = [1, 1.5, 2, 3, 5, 8, 15, 50, Number.POSITIVE_INFINITY];

export async function runSearch(options: SearchOptions): Promise<SearchResponse> {
  const { apiKey } = options;

  const self = await getOwnProfile(apiKey);

  // 1. Build a candidate pool from the public Torn Hall of Fame.
  const hofRequests: { category: TornHofCategory; page: number }[] = [];
  for (const category of options.categories) {
    for (let page = 0; page < options.pagesPerCategory; page++) {
      hofRequests.push({ category, page });
    }
  }

  const candidateEntries = new Map<number, { entry: TornHofEntry; categories: { category: TornHofCategory; value: number | string; rank: string }[] }>();

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
        candidateEntries.set(entry.id, { entry, categories: [hofRef] });
      }
    }
  }

  const candidateIds = Array.from(candidateEntries.keys());

  // 2. Estimate battle stats / fair fight ratio for every candidate via FFScouter.
  const ffStats = await getFairFightStats(apiKey, candidateIds);

  // 2b. Optionally exclude opponents this key has already attacked, so you
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

  // Everyone who clears the level floor, has a usable fair-fight estimate,
  // and (if requested) hasn't already been attacked by this key — ranked
  // highest level first (fair fight as the tiebreaker). This ordering is
  // fixed up front; the tier loop below only changes how far down it we're
  // willing to look.
  const eligible = candidateIds
    .map((id) => ({ id, stats: ffStats.get(id), snapshotLevel: candidateEntries.get(id)?.entry.level ?? 0 }))
    .filter((c): c is { id: number; stats: NonNullable<typeof c.stats>; snapshotLevel: number } => {
      if (!c.stats || c.stats.fair_fight == null) return false;
      if (c.snapshotLevel < options.minLevel) return false;
      if (previouslyAttackedIds?.has(c.id)) return false;
      return true;
    })
    .sort((a, b) => b.snapshotLevel - a.snapshotLevel || (a.stats.fair_fight ?? 0) - (b.stats.fair_fight ?? 0));

  // 3. Widen the fair-fight ceiling tier by tier, live-checking status
  // (hospital/traveling/abroad/etc.) only for candidates not already
  // checked in an earlier, easier tier, until we have enough attackable
  // matches or run out of budget.
  const matches: MatchedPlayer[] = [];
  const checked = new Set<number>();
  let statusChecksSpent = 0;
  let fairFightCeilingUsed: number | null = null;

  for (const tier of FAIR_FIGHT_TIERS) {
    if (matches.length >= options.limit || statusChecksSpent >= MAX_STATUS_CHECKS) break;

    const tierCandidates = eligible.filter((c) => !checked.has(c.id) && c.stats.fair_fight! <= tier);
    if (tierCandidates.length === 0) continue;

    const remainingBudget = MAX_STATUS_CHECKS - statusChecksSpent;
    const batch = tierCandidates.slice(0, remainingBudget);
    fairFightCeilingUsed = tier;

    await mapWithConcurrency(batch, STATUS_CHECK_CONCURRENCY, async ({ id, stats }) => {
      checked.add(id);
      statusChecksSpent++;
      if (matches.length >= options.limit) return;
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

  return {
    self,
    candidates_scanned: candidateIds.length,
    candidates_with_stats: eligible.length,
    fair_fight_ceiling_used: fairFightCeilingUsed,
    matches: matches.slice(0, options.limit),
  };
}
