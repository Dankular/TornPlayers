// A Torn "Custom" API key pre-filled with every selection this app needs
// (torn » hof for the Hall of Fame pull) plus every selection FFScouter
// currently asks for when you register a key with it. Using this single link
// avoids needing two separate keys.
export const KEY_SETUP_URL =
  "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=TornPlayers&user=hof,faction,basic,profile,cooldowns,refills,attacks,battlestats,personalstats&faction=members,rankedwarreport,warfare,wars,rankedwars&torn=hof,rankedwarreport,rankedwars";

export const FFSCOUTER_SIGNUP_URL = "https://ffscouter.com";

// 10-wide level bands used to page through 'user' -> 'search' round-robin in
// the background scanner, the same pattern as the Hall of Fame scan cursor.
// 100 is Torn's normal level cap.
export const LEVEL_SEARCH_BUCKETS: { bucket: string; minLevel: number; maxLevel: number }[] = [
  { bucket: "10-19", minLevel: 10, maxLevel: 19 },
  { bucket: "20-29", minLevel: 20, maxLevel: 29 },
  { bucket: "30-39", minLevel: 30, maxLevel: 39 },
  { bucket: "40-49", minLevel: 40, maxLevel: 49 },
  { bucket: "50-59", minLevel: 50, maxLevel: 59 },
  { bucket: "60-69", minLevel: 60, maxLevel: 69 },
  { bucket: "70-79", minLevel: 70, maxLevel: 79 },
  { bucket: "80-89", minLevel: 80, maxLevel: 89 },
  { bucket: "90-99", minLevel: 90, maxLevel: 99 },
  { bucket: "100-100", minLevel: 100, maxLevel: 100 },
];
