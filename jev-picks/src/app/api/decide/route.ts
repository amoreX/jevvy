import { parseBrief } from "@/lib/decision";
import { decide, failure, readBody } from "@/lib/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return Response.json(
      await decide(parseBrief(await readBody(request)), request.signal),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
