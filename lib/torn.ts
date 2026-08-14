import type { AttackRecord, OwnProfile, TornHofCategory, TornHofEntry, UserStatus } from "./types";

const TORN_V2_BASE = "https://api.torn.com/v2";

export class TornApiError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "TornApiError";
  }
}

async function tornFetch<T>(path: string, key: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${TORN_V2_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set("key", key);

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "TornPlayers-Matcher/1.0" },
    cache: "no-store",
  });

  const body = await res.json();

  if (body && body.error) {
    throw new TornApiError(body.error.code, body.error.error);
  }

  return body as T;
}

/** Basic info about the supplied key: access level and the player it belongs to. */
export async function getKeyInfo(key: string) {
  return tornFetch<{
    info: {
      selections: Record<string, string[]>;
      access: { level: number; type: string; faction: boolean; company: boolean };
      user: { id: number; faction_id: number | null; company_id: number | null };
    };
  }>("/key/info", key);
}

interface OwnProfileResponse {
  profile: {
    id: number;
    name: string;
    level: number;
    faction_id: number | null;
    status: UserStatus;
  };
  // Each stat comes back as { value, modifier, modifiers[] } in API v2.
  battlestats?: {
    strength: { value: number };
    speed: { value: number };
    dexterity: { value: number };
    defense: { value: number };
    total: number;
  };
}

/** The key owner's own profile + battlestats (battlestats requires the "battlestats" permission on the key). */
export async function getOwnProfile(key: string): Promise<OwnProfile> {
  let data: OwnProfileResponse;
  try {
    data = await tornFetch<OwnProfileResponse>("/user", key, { selections: "profile,battlestats" });
  } catch (err) {
    // Battlestats permission missing on this key — fall back to profile only.
    if (err instanceof TornApiError && err.code === 16) {
      data = await tornFetch<OwnProfileResponse>("/user", key, { selections: "profile" });
    } else {
      throw err;
    }
  }

  return {
    id: data.profile.id,
    name: data.profile.name,
    level: data.profile.level,
    faction_id: data.profile.faction_id,
    status: data.profile.status,
    battlestats: data.battlestats
      ? {
          strength: data.battlestats.strength.value,
          speed: data.battlestats.speed.value,
          dexterity: data.battlestats.dexterity.value,
          defense: data.battlestats.defense.value,
          total: data.battlestats.total,
        }
      : null,
  };
}

/** One page (up to 100) of the public Torn Hall of Fame for a given category. Requires only a public key. */
export async function getHofPage(
  key: string,
  category: TornHofCategory,
  limit: number,
  offset: number
): Promise<TornHofEntry[]> {
  const data = await tornFetch<{ hof: TornHofEntry[] }>("/torn/hof", key, {
    cat: category,
    limit,
    offset,
  });
  return data.hof;
}

interface AttacksResponse {
  attacks: {
    started: number;
    ended: number;
    defender: { id: number };
    result: string;
  }[];
}

/**
 * The key owner's outgoing attack history (requires the "attacks" selection
 * on the key — already part of the FFScouter-compatible key this app asks
 * for). Returns the most recent record per opponent, going back at most
 * `sinceTimestamp` and `maxPages` * 100 attacks, whichever is hit first.
 */
export async function getOutgoingAttackHistory(
  key: string,
  sinceTimestamp: number,
  maxPages: number
): Promise<Map<number, AttackRecord>> {
  const history = new Map<number, AttackRecord>();
  let to: number | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string | number> = {
      filters: "outgoing",
      sort: "DESC",
      limit: 100,
      from: sinceTimestamp,
    };
    if (to !== undefined) params.to = to;

    const data = await tornFetch<AttacksResponse>("/user/attacks", key, params);
    if (data.attacks.length === 0) break;

    for (const attack of data.attacks) {
      // Attacks arrive newest-first, so the first time we see an opponent
      // here is their most recent encounter.
      if (!history.has(attack.defender.id)) {
        history.set(attack.defender.id, { result: attack.result, timestamp: attack.ended });
      }
    }

    if (data.attacks.length < 100) break; // exhausted everything back to sinceTimestamp

    const oldestStarted = Math.min(...data.attacks.map((a) => a.started));
    to = oldestStarted - 1;
  }

  return history;
}

/** Public profile (status/level/faction) for an arbitrary player id. */
export async function getPlayerStatus(
  key: string,
  id: number
): Promise<{ id: number; name: string; level: number; faction_id: number | null; status: UserStatus; last_action: { timestamp: number } }> {
  const data = await tornFetch<{
    profile: {
      id: number;
      name: string;
      level: number;
      faction_id: number | null;
      status: UserStatus;
      last_action: { timestamp: number };
    };
  }>(`/user/${id}`, key, { selections: "profile" });
  return data.profile;
}
