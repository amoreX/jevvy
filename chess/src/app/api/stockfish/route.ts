import { readBody } from "@/lib/request-body";
import {
  EngineError,
  findBestMove,
  evaluatePosition,
  probeStockfish,
} from "@/lib/native-stockfish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

function failure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof EngineError
          ? error.message
          : "Stockfish is unavailable. Please retry.",
    },
    { status: error instanceof EngineError ? error.status : 503, headers },
  );
}

export async function GET(request: Request) {
  try {
    return Response.json(await probeStockfish(request.signal), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const analyze =
      body &&
      typeof body === "object" &&
      "analyze" in body &&
      body.analyze === true;
    return Response.json(
      await (analyze
        ? evaluatePosition(body, request.signal)
        : findBestMove(body, request.signal)),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
