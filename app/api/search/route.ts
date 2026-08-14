import { NextRequest, NextResponse } from "next/server";
import { runSearch } from "@/lib/matching";
import { TornApiError } from "@/lib/torn";
import { FfScouterError } from "@/lib/ffscouter";
import { TORN_HOF_CATEGORIES, type TornHofCategory } from "@/lib/types";
import { KEY_SETUP_URL } from "@/lib/constants";

// Give this route more room than the Next.js default before Vercel decides
// it's hung — a full search fans out several dozen upstream calls.
export const maxDuration = 60;

interface SearchBody {
  apiKey?: string;
  pagesPerCategory?: number;
  minLevel?: number;
  limit?: number;
  excludePreviouslyAttacked?: boolean;
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

  // Always scan every Hall of Fame category — there's no upside to leaving
  // some out, since the fair-fight tiering already handles filtering out
  // fights that turn out too hard.
  const options = {
    apiKey,
    categories: TORN_HOF_CATEGORIES as TornHofCategory[],
    pagesPerCategory: clamp(body.pagesPerCategory ?? 1, 1, 3),
    minLevel: clamp(typeof body.minLevel === "number" ? body.minLevel : 50, 1, 100),
    limit: clamp(body.limit ?? 20, 1, 50),
    excludePreviouslyAttacked: body.excludePreviouslyAttacked === true,
  };

  try {
    const result = await runSearch(options);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TornApiError) {
      const status = err.code === 2 ? 401 : err.code === 16 ? 403 : 502;
      const message =
        err.code === 16
          ? `${err.message} Generate a Custom key with everything this app needs (Hall of Fame + attack history + FFScouter's requirements): ${KEY_SETUP_URL}`
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
