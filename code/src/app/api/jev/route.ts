import { JEV_MODEL } from "@/lib/jev";
import { EngineError } from "@/lib/native-stockfish";
import { readBody } from "@/lib/request-body";
import { loggedDecision } from "@/lib/logged-decision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  // Configuration check only: no inference or charge until Start.
  return Response.json(
    { model: JEV_MODEL, configured: !!process.env.OPENROUTER_API_KEY?.trim() },
    { headers },
  );
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
      throw new EngineError("Cross-origin requests are not allowed.", 403);
    return Response.json(
      await loggedDecision("jev", await readBody(request), request.signal),
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof EngineError
            ? error.message
            : "Jev is unavailable. Retry to continue.",
      },
      { status: error instanceof EngineError ? error.status : 503, headers },
    );
  }
}
