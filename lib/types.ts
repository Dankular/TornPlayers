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

// Categories where ranking highly has little to do with battle stats
// (working stats, racing skill, net worth, busting, reviving are all trained
// or earned independently of strength/speed/dexterity/defense). Seeding the
// candidate pool from these surfaces far more "high level, low stats" easy
// targets per scan than combat categories like attacks/defends/offences,
// which already select for players who fight — and fight well.
export const RECOMMENDED_EASY_TARGET_CATEGORIES: TornHofCategory[] = [
  "workstats",
  "networth",
  "busts",
  "revives",
  "racingskill",
  "racingpoints",
  "racingwins",
  "level",
  "rank",
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
  matches: MatchedPlayer[];
}

export interface SearchOptions {
  apiKey: string;
  categories: TornHofCategory[];
  pagesPerCategory: number; // each page = up to 100 entries
  minFairFight: number;
  maxFairFight: number;
  minLevel: number;
  limit: number;
}
