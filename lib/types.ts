// Shared types for the Torn key -> HOF -> FFScouter matching pipeline.

export type TornHofCategory =
  | "level"
  | "busts"
  | "rank"
  | "traveltime"
  | "workstats"
  | "networth"
  | "revives"
  | "defends"
  | "offences"
  | "attacks"
  | "awards"
  | "racingwins"
  | "racingpoints"
  | "racingskill";

export const TORN_HOF_CATEGORIES: TornHofCategory[] = [
  "level",
  "rank",
  "attacks",
  "defends",
  "offences",
  "awards",
  "networth",
  "busts",
  "revives",
  "workstats",
  "racingwins",
  "racingpoints",
  "racingskill",
  "traveltime",
];

// The only state in which a player can actually be attacked.
export type UserStatusState =
  | "Abroad"
  | "Awoken"
  | "Dormant"
  | "Fallen"
  | "Federal"
  | "Hospital"
  | "Jail"
  | "Okay"
  | "Traveling";

export interface UserStatus {
  description: string;
  details: string | null;
  state: UserStatusState | string;
  color: string;
  until: number | null;
}

export interface TornHofEntry {
  id: number;
  username: string;
  faction_id: number;
  level: number;
  last_action: number;
  rank_name: string;
  rank_number: number;
  position: number;
  signed_up: number;
  age_in_days: number;
  value: number | string;
  rank: string;
}

// A single result row from 'user' -> 'search' (API v2, shipped Aug 2026).
// Unlike the Hall of Fame, this covers the entire playerbase in a level band
// (filtered server-side to exclude hospitalized players), not just
// record-holders — the response itself carries no hospital/jail/travel
// state, so a live status check is still required before attacking.
export interface UserSearchResult {
  id: number;
  name: string;
  level: number;
  online: "Online" | "Idle" | "Offline";
  faction_id: number;
}

export interface OwnProfile {
  id: number;
  name: string;
  level: number;
  faction_id: number | null;
  status: UserStatus;
  battlestats: {
    strength: number;
    speed: number;
    dexterity: number;
    defense: number;
    total: number;
  } | null;
}

export interface FfScouterStats {
  player_id: number;
  fair_fight: number | null;
  bs_estimate: number | null;
  bs_estimate_human: string | null;
  bss_public: number | null;
  last_updated: number | null;
  source: string | null;
}

// The key owner's most recent outgoing attack against a given opponent.
export interface AttackRecord {
  result: string;
  timestamp: number;
}

export interface MatchedPlayer {
  id: number;
  name: string;
  level: number;
  faction_id: number | null;
  status: UserStatus;
  fair_fight: number | null;
  bs_estimate: number | null;
  bs_estimate_human: string | null;
  last_action: number;
  hof_categories: { category: TornHofCategory; value: number | string; rank: string }[];
}

export interface SearchResponse {
  self: OwnProfile;
  candidates_scanned: number;
  candidates_with_stats: number;
  // The widest fair-fight ceiling the search had to reach to fill the
  // result list (null if nothing attackable was found at all). Lower is
  // easier; this is informational, not something the caller sets.
  fair_fight_ceiling_used: number | null;
  // Diagnostics for the optional shared cache — lets the UI show plainly
  // whether a database is actually connected, rather than leaving you to
  // guess why results do or don't vary between searches.
  cache_connected: boolean;
  cache_pool_size: number;
  // How many non-hospitalized players at or above minLevel Torn itself
  // reports having, per 'user' -> 'search' metadata — null if that lookup
  // failed (e.g. the endpoint is Unstable and temporarily unavailable).
  // Purely informational: shows how much of the playerbase this search
  // could ever have looked at, independent of Hall of Fame coverage.
  search_pool_total: number | null;
  matches: MatchedPlayer[];
}

export interface SearchOptions {
  apiKey: string;
  categories: TornHofCategory[];
  pagesPerCategory: number; // each page = up to 100 entries
  minLevel: number;
  limit: number;
  // When true, exclude opponents this key has attacked before (requires
  // the "attacks" selection on the key) — avoids re-hitting the same targets.
  excludePreviouslyAttacked: boolean;
}
