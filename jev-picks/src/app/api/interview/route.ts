import { parseInterviewInput } from "@/lib/decision";
import { failure, interview, readBody } from "@/lib/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return Response.json(
      await interview(
        parseInterviewInput(await readBody(request)),
        request.signal,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
