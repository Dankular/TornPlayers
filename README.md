# TornPlayers

Find easy, attackable targets in [Torn](https://www.torn.com) that "match" your
account: enter your Torn API key and the app cross-references the public Torn
**Hall of Fame** with [FFScouter](https://ffscouter.com)'s fair-fight
estimates, then filters out anyone currently in hospital, jail, traveling, or
abroad — leaving a short list of players you can actually attack right now.

## How it works

1. **Your profile** — `POST /v2/user?selections=profile,battlestats` gets your
   level, faction, and (if your key allows it) battle stats.
2. **Candidate pool** — `GET /v2/torn/hof?cat=<category>` pages through the
   public Hall of Fame (level, rank, attacks won, defends won, offences,
   awards, net worth, etc.) to build a pool of notable, active players.
3. **Fair-fight scoring** — all candidate IDs are sent to FFScouter's
   `get-stats` endpoint (authenticated with the same Torn key) to get an
   estimated fair-fight ratio against you. Only candidates inside your chosen
   "easy" range are kept.
4. **Live status check** — the best-scoring candidates get a fresh
   `GET /v2/user/{id}?selections=profile` lookup; only players whose status is
   `Okay` (not Hospital, Jail, Traveling, Abroad, Federal, ...) make the final
   list.
5. **Shared cache (optional)** — if a database is connected, every search
   also draws from a `players` table that accumulates Hall of Fame sightings
   over time (from a background scanner and from prior searches), so later
   searches reach far deeper into the Hall of Fame than any single request's
   live pages cover. Anything sourced from the cache gets its fair-fight
   number re-verified against FFScouter right before it's ever shown — the
   cache only ever widens *which* players get considered, never what's
   trusted about them. Status is always checked live regardless; it changes
   by the minute, so it's never cached. See [Player cache](#player-cache-optional)
   below.

Your API key is only ever forwarded to the Torn and FFScouter APIs for the
duration of a single search request — it is never stored, logged, or written
to disk.

### Requirements on your Torn key

FFScouter's estimates are what make the matching work, and FFScouter only
recognizes keys registered through its own signup form — so in practice you
need a **Custom key**, not a plain Public/Limited one:

1. Generate a Custom key with the [pre-filled selections this app + FFScouter
   need](https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=TornPlayers&user=hof,faction,basic,profile,cooldowns,refills,attacks,battlestats,personalstats&faction=members,rankedwarreport,warfare,wars,rankedwars&torn=hof,rankedwarreport,rankedwars)
   (includes `torn » hof` for the Hall of Fame pull, plus everything
   FFScouter currently asks for).
2. Submit that key on [ffscouter.com](https://ffscouter.com) (accept its
   terms, paste the key in the signup form) — allow a few minutes for it to
   start returning estimates.
3. Use that same key here. Missing `torn:hof` or an unregistered FFScouter
   key both produce a specific, actionable error message instead of a
   generic failure.

Battlestats permission on the key is otherwise optional — it's only used to
show your own stats for context, not for the matching itself (FFScouter
already computes fair fight from its own perspective on your key).

## Development

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

```bash
npm run build   # production build + typecheck
npm run lint    # eslint
```

## Deployment

This is a standard Next.js (App Router) app — deploys as-is to Vercel or any
Node host. With no environment variables set at all, it works exactly as
described above, live-only, no database required.

## Player cache (optional)

Turning this on makes searches progressively more thorough over time — the
cache only ever grows, so week two finds things week one couldn't.

**1. Add a Postgres database.** In the Vercel dashboard: your project →
**Storage** → **Create Database** → Postgres (the Neon integration). Connect
it to this project — Vercel injects `POSTGRES_URL` (or `DATABASE_URL`)
automatically, no copy-pasting a connection string required. Any other
Postgres works too — just set `DATABASE_URL` yourself.

**2. Add a scanning key.** Set `TORN_SCAN_KEY` to a Torn API key with the
same requirements as your own search key (see above — the
[same pre-filled Custom-key link](https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=TornPlayers&user=hof,faction,basic,profile,cooldowns,refills,attacks,battlestats,personalstats&faction=members,rankedwarreport,warfare,wars,rankedwars&torn=hof,rankedwarreport,rankedwars),
registered on ffscouter.com). This key only ever touches public Hall of Fame
data and FFScouter lookups — it's used exclusively by the background
scanner, never tied to a specific searcher.

**3. (Recommended) Set `CRON_SECRET`** to any random string — Vercel sends it
back as a bearer token on scheduled cron requests, so `/api/cron/scan` can
verify a request actually came from your own cron schedule.

Once those are set, `vercel.json` schedules `/api/cron/scan` once daily (the
Vercel Hobby plan rejects any cron running more than once/day; Pro allows
hourly and up — bump the schedule in `vercel.json` if you're on Pro). Each
run advances a few Hall of Fame categories one page deeper (round-robin
across all 14, wrapping around once a category's depth is exhausted). You
can also trigger a scan manually any time: `GET /api/cron/scan` (with a
`CRON_SECRET` set, pass `Authorization: Bearer <secret>`) — worth doing a
few times by hand right after setup instead of waiting a full day between
each step of the first scan.

The cache is entirely additive to what's described above — nothing about the
live scan, fair-fight scoring, or status check changes; the cache just
supplies more candidates for that same pipeline to consider, and every
cache-sourced candidate gets a fresh FFScouter check before it can appear in
your results.

## Project layout

```
app/
  page.tsx                 # search form + results table
  api/search/route.ts      # orchestrates the HOF -> FFScouter -> status pipeline
  api/cron/scan/route.ts   # background scanner: advances the HOF cache
lib/
  torn.ts             # Torn API v2 client (hof, profile, battlestats, status)
  ffscouter.ts        # FFScouter client (batched fair-fight lookups)
  matching.ts         # candidate pool building + filtering + ranking
  db.ts               # optional Postgres-backed player cache
  concurrency.ts       # small helper to bound in-flight requests
  types.ts            # shared types
```
