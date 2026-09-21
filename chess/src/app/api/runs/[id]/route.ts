import { appendRunEvent, readRun, summarizeRun } from "@/lib/run-store";
import { readBody } from "@/lib/request-body";
import { EngineError } from "@/lib/native-stockfish";
import { assertOrigin, apiFailure, noStore } from "@/lib/route-utils";
import { Chess } from "chess.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const log = await readRun(id);
    const format = new URL(request.url).searchParams.get("format");
    if (format === "summary")
      return Response.json(summarizeRun(log), { headers: noStore });
    if (format === "pgn") {
      const latest = log.events
        .filter((event) => event.type === "state")
        .at(-1);
      return new Response(String(latest?.data.pgn ?? ""), {
        headers: {
          ...noStore,
          "Content-Type": "application/x-chess-pgn",
          "Content-Disposition": `attachment; filename="${log.model}-${id}.pgn"`,
        },
      });
    }
    return Response.json(log, {
      headers: {
        ...noStore,
        ...(format === "json"
          ? {
              "Content-Disposition": `attachment; filename="${log.model}-${id}.json"`,
            }
          : {}),
      },
    });
  } catch (error) {
    return apiFailure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    assertOrigin(request);
    const { id } = await context.params;
    const body = (await readBody(request)) as {
      eventId?: unknown;
      state?: Record<string, unknown>;
    };
    const s = body?.state;
    if (
      !s ||
      typeof body.eventId !== "string" ||
      body.eventId.length > 80 ||
      typeof s.fen !== "string" ||
      typeof s.pgn !== "string" ||
      s.pgn.length > 24000 ||
      typeof s.phase !== "string" ||
      ![
        "idle",
        "loading",
        "playing",
        "paused",
        "finished",
        "error",
        "stopped",
      ].includes(s.phase) ||
      typeof s.plies !== "number" ||
      !Number.isInteger(s.plies) ||
      s.plies < 0 ||
      s.plies > 2048
    )
      throw new EngineError("Invalid run state.", 400);
    try {
      new Chess(s.fen);
    } catch {
      throw new EngineError("Invalid run position.", 400);
    }
    const text = (value: unknown) =>
      typeof value === "string" ? value.slice(0, 500) : null;
    await appendRunEvent(
      id,
      "state",
      {
        phase: s.phase,
        fen: s.fen,
        pgn: s.pgn,
        plies: s.plies,
        result: text(s.result),
        reason: text(s.reason),
        error: text(s.error),
        evaluation: s.evaluation ?? null,
        ...(s.move ? { move: s.move } : {}),
      },
      body.eventId,
    );
    return Response.json({ saved: true }, { headers: noStore });
  } catch (error) {
    return apiFailure(error);
  }
}
