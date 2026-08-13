"use client";

import { useState } from "react";
import type { MatchedPlayer, SearchResponse, TornHofCategory } from "@/lib/types";
import { TORN_HOF_CATEGORIES } from "@/lib/types";

const CATEGORY_LABELS: Record<TornHofCategory, string> = {
  level: "Level",
  rank: "Rank",
  attacks: "Attacks Won",
  defends: "Defends Won",
  offences: "Offences",
  awards: "Awards",
  networth: "Net Worth",
  busts: "Busts",
  revives: "Revives",
  workstats: "Working Stats",
  racingwins: "Racing Wins",
  racingpoints: "Racing Points",
  racingskill: "Racing Skill",
  traveltime: "Travel Time",
};

const DEFAULT_CATEGORIES: TornHofCategory[] = ["level", "rank", "attacks", "defends", "offences", "awards"];

function timeAgo(ts: number) {
  if (!ts) return "unknown";
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function fairFightColor(ff: number | null) {
  if (ff == null) return "text-slate-400";
  if (ff <= 1) return "text-torn-accent2";
  if (ff <= 2) return "text-yellow-400";
  return "text-torn-accent";
}

export default function Home() {
  const [apiKey, setApiKey] = useState("");
  const [categories, setCategories] = useState<TornHofCategory[]>(DEFAULT_CATEGORIES);
  const [minFairFight, setMinFairFight] = useState(0);
  const [maxFairFight, setMaxFairFight] = useState(1.5);
  const [limit, setLimit] = useState(20);
  const [pagesPerCategory, setPagesPerCategory] = useState(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);

  function toggleCategory(cat: TornHofCategory) {
    setCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, categories, minFairFight, maxFairFight, limit, pagesPerCategory }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Search failed.");
      }
      setResult(data as SearchResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">
          Torn<span className="text-torn-accent">Players</span>
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-400">
          Enter your Torn API key. We pull candidates from the public Torn Hall of Fame, score them with
          FFScouter&apos;s fair-fight estimates, and filter out anyone currently in hospital, jail, traveling, or
          abroad — leaving a short list of easy, attackable targets.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="rounded-xl border border-torn-border bg-torn-panel p-5">
        <label className="block text-sm font-medium text-slate-300">Torn API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="16-character API key"
          required
          pattern="[a-zA-Z0-9]{16}"
          maxLength={16}
          className="mt-1 w-full rounded-md border border-torn-border bg-black/30 px-3 py-2 font-mono text-sm outline-none focus:border-torn-accent"
        />
        <p className="mt-1 text-xs text-slate-500">
          A Public or Limited key works (Hall of Fame + target lookups are public data). Your key is sent to our
          server only for this request and is never stored or logged.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <span className="block text-sm font-medium text-slate-300">Hall of Fame categories to scan</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {TORN_HOF_CATEGORIES.map((cat) => (
                <button
                  type="button"
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    categories.includes(cat)
                      ? "border-torn-accent bg-torn-accent/20 text-white"
                      : "border-torn-border text-slate-400 hover:border-slate-500"
                  }`}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300">Min fair fight</label>
              <input
                type="number"
                step="0.1"
                min={0}
                max={5}
                value={minFairFight}
                onChange={(e) => setMinFairFight(parseFloat(e.target.value))}
                className="mt-1 w-full rounded-md border border-torn-border bg-black/30 px-3 py-2 text-sm outline-none focus:border-torn-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Max fair fight</label>
              <input
                type="number"
                step="0.1"
                min={0}
                max={5}
                value={maxFairFight}
                onChange={(e) => setMaxFairFight(parseFloat(e.target.value))}
                className="mt-1 w-full rounded-md border border-torn-border bg-black/30 px-3 py-2 text-sm outline-none focus:border-torn-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Pages / category</label>
              <input
                type="number"
                min={1}
                max={3}
                value={pagesPerCategory}
                onChange={(e) => setPagesPerCategory(parseInt(e.target.value, 10))}
                className="mt-1 w-full rounded-md border border-torn-border bg-black/30 px-3 py-2 text-sm outline-none focus:border-torn-accent"
              />
              <p className="mt-1 text-[11px] text-slate-500">100 candidates per page</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Result limit</label>
              <input
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                className="mt-1 w-full rounded-md border border-torn-border bg-black/30 px-3 py-2 text-sm outline-none focus:border-torn-accent"
              />
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || categories.length === 0}
          className="mt-6 w-full rounded-md bg-torn-accent py-2.5 font-semibold text-white transition hover:bg-torn-accent/90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-8"
        >
          {loading ? "Scanning…" : "Find easy targets"}
        </button>

        {error && <p className="mt-4 text-sm text-torn-accent">{error}</p>}
      </form>

      {result && (
        <section className="mt-8">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {result.matches.length} attackable match{result.matches.length === 1 ? "" : "es"}
            </h2>
            <p className="text-xs text-slate-500">
              Scanned {result.candidates_scanned} HOF candidates · {result.candidates_with_stats} within your fair
              fight range · for {result.self.name} (lvl {result.self.level})
            </p>
          </div>

          {result.matches.length === 0 ? (
            <p className="rounded-lg border border-torn-border bg-torn-panel p-6 text-sm text-slate-400">
              No attackable matches found in range. Try widening the fair fight range, adding more Hall of Fame
              categories, or scanning more pages per category.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-torn-border">
              <table className="w-full text-sm">
                <thead className="bg-black/30 text-left text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Player</th>
                    <th className="px-3 py-2">Level</th>
                    <th className="px-3 py-2">Fair fight</th>
                    <th className="px-3 py-2">Est. stats</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Last action</th>
                    <th className="px-3 py-2">HOF</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matches.map((m) => (
                    <MatchRow key={m.id} match={m} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function MatchRow({ match }: { match: MatchedPlayer }) {
  return (
    <tr className="border-t border-torn-border/60 hover:bg-white/5">
      <td className="px-3 py-2">
        <a
          href={`https://www.torn.com/profiles.php?XID=${match.id}`}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-slate-100 hover:text-torn-accent hover:underline"
        >
          {match.name}
        </a>
        <span className="ml-1 text-xs text-slate-500">[{match.id}]</span>
      </td>
      <td className="px-3 py-2">{match.level}</td>
      <td className={`px-3 py-2 font-semibold ${fairFightColor(match.fair_fight)}`}>
        {match.fair_fight?.toFixed(2) ?? "—"}
      </td>
      <td className="px-3 py-2 text-slate-300">{match.bs_estimate_human ?? "—"}</td>
      <td className="px-3 py-2">
        <span className="rounded-full bg-torn-accent2/20 px-2 py-0.5 text-xs font-medium text-torn-accent2">
          {match.status.description || match.status.state}
        </span>
      </td>
      <td className="px-3 py-2 text-slate-400">{timeAgo(match.last_action)}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {match.hof_categories.slice(0, 3).map((c) => (
            <span key={c.category} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">
              {CATEGORY_LABELS[c.category]}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}
