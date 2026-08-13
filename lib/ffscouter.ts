import type { FfScouterStats } from "./types";

const FFSCOUTER_BASE = "https://ffscouter.com/api/v1/get-stats";
// FFScouter caps a single request at 205 target ids.
const CHUNK_SIZE = 200;

export class FfScouterError extends Error {}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * FFScouter authenticates with the caller's own Torn API key (same key used
 * against the official Torn API) and returns estimated battle stats / fair
 * fight ratios for arbitrary target player ids.
 */
export async function getFairFightStats(key: string, targetIds: number[]): Promise<Map<number, FfScouterStats>> {
  const results = new Map<number, FfScouterStats>();
  if (targetIds.length === 0) return results;

  const batches = chunk(Array.from(new Set(targetIds)), CHUNK_SIZE);

  for (const batch of batches) {
    const url = new URL(FFSCOUTER_BASE);
    url.searchParams.set("key", key);
    url.searchParams.set("targets", batch.join(","));

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "TornPlayers-Matcher/1.0" },
      cache: "no-store",
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new FfScouterError(
          'This Torn key isn\'t recognized by FFScouter. Sign in at ffscouter.com with this Torn account at least once (Torn login via "Sign in with Torn") so it can register your key, then try again.'
        );
      }
      throw new FfScouterError(`FFScouter request failed with status ${res.status}`);
    }

    const data = (await res.json()) as FfScouterStats[];
    for (const entry of data) {
      results.set(entry.player_id, entry);
    }
  }

  return results;
}
