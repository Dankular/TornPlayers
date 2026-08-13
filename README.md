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

Your API key is only ever forwarded to the Torn and FFScouter APIs for the
duration of a single search request — it is never stored, logged, or written
to disk.

### Requirements on your Torn key

- Needs the `torn » hof` selection (any Public key has this by default;
  Custom/Limited keys must explicitly include it, otherwise you'll get a
  clear "Hall of Fame access" error).
- Needs to be **registered with FFScouter** — sign in at
  [ffscouter.com](https://ffscouter.com) with your Torn account at least once
  so it recognizes your key. Otherwise you'll get a clear error telling you
  to do this.
- Battlestats permission is optional — it's only used to show your own stats
  for context, not for the matching itself (FFScouter already computes fair
  fight from its own perspective on your key).

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
Node host. The matching logic lives entirely in `app/api/search/route.ts` and
`lib/`, so no environment variables or secrets are required (every request
supplies its own Torn API key).

## Project layout

```
app/
  page.tsx            # search form + results table
  api/search/route.ts # orchestrates the HOF -> FFScouter -> status pipeline
lib/
  torn.ts             # Torn API v2 client (hof, profile, battlestats, status)
  ffscouter.ts        # FFScouter client (batched fair-fight lookups)
  matching.ts         # candidate pool building + filtering + ranking
  concurrency.ts       # small helper to bound in-flight requests
  types.ts            # shared types
```
