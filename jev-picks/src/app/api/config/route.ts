import { JEV_MODEL, SONNET_MODEL } from "@/lib/decision";
import { configured } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    {
      configured: configured(),
      interviewer: SONNET_MODEL,
      evaluator: JEV_MODEL,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
