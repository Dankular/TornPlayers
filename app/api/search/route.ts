import { NextRequest, NextResponse } from "next/server";
import { runSearch } from "@/lib/matching";
import { TornApiError } from "@/lib/torn";
import { FfScouterError } from "@/lib/ffscouter";
import { TORN_HOF_CATEGORIES, type TornHofCategory } from "@/lib/types";

// Give this route more room than the Next.js default before Vercel decides
// it's hung — a full search fans out several dozen upstream calls.
export const maxDuration = 60;

interface SearchBody {
  apiKey?: string;
  categories?: string[];
  pagesPerCategory?: number;
  minFairFight?: number;
  maxFairFight?: number;
  limit?: number;
}

export async function POST(req: NextRequest) {
  let body: SearchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const apiKey = (body.apiKey ?? "").trim();
  if (!apiKey || !/^[a-zA-Z0-9]{16}$/.test(apiKey)) {
    return NextResponse.json({ error: "A valid 16-character Torn API key is required." }, { status: 400 });
  }

  const categories: TornHofCategory[] = (body.categories ?? []).filter((c): c is TornHofCategory =>
    (TORN_HOF_CATEGORIES as string[]).includes(c)
  );

  const options = {
    apiKey,
    categories: categories.length > 0 ? categories : (["level", "rank", "attacks", "defends", "offences", "awards"] as TornHofCategory[]),
    pagesPerCategory: clamp(body.pagesPerCategory ?? 1, 1, 3),
    minFairFight: typeof body.minFairFight === "number" ? body.minFairFight : 0,
    maxFairFight: typeof body.maxFairFight === "number" ? body.maxFairFight : 1.5,
    limit: clamp(body.limit ?? 20, 1, 50),
  };

  try {
    const result = await runSearch(options);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TornApiError) {
      const status = err.code === 2 ? 401 : err.code === 16 ? 403 : 502;
      const message =
        err.code === 16
          ? "This key doesn't have Hall of Fame access. Generate a key on torn.com/preferences.php#tab=api with at least the \"Public\" selections (or a Custom key that includes torn » hof) and try again."
          : `Torn API error: ${err.message}`;
      return NextResponse.json({ error: message, code: err.code }, { status });
    }
    if (err instanceof FfScouterError) {
      return NextResponse.json({ error: `FFScouter error: ${err.message}` }, { status: 502 });
    }
    console.error(err);
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
