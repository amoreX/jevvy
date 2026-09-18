import { MODELS } from "@/lib/models";
import { readBody } from "@/lib/request-body";
import { loggedDecision } from "@/lib/logged-decision";
import { assertOrigin, apiFailure, noStore } from "@/lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      model: MODELS.glm.id,
      provider: MODELS.glm.provider,
      reasoning: MODELS.glm.reasoning,
      configured: !!process.env.OPENROUTER_API_KEY?.trim(),
    },
    { headers: noStore },
  );
}

export async function POST(request: Request) {
  try {
    assertOrigin(request);
    return Response.json(
      await loggedDecision("glm", await readBody(request), request.signal),
      { headers: noStore },
    );
  } catch (error) {
    return apiFailure(error);
  }
}
