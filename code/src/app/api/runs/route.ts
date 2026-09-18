import { createRun, listRuns } from "@/lib/run-store";
import { isPlayerId } from "@/lib/models";
import { readBody } from "@/lib/request-body";
import { EngineError } from "@/lib/native-stockfish";
import { assertOrigin, apiFailure, noStore } from "@/lib/route-utils";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await listRuns(), { headers: noStore });
  } catch (error) {
    return apiFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const body = await readBody(request);
    if (
      !body ||
      typeof body !== "object" ||
      !("model" in body) ||
      !isPlayerId(body.model) ||
      !("initialFen" in body) ||
      typeof body.initialFen !== "string"
    )
      throw new EngineError("A model and starting FEN are required.", 400);
    return Response.json(await createRun(body.model, body.initialFen), {
      headers: noStore,
    });
  } catch (error) {
    return apiFailure(error);
  }
}
