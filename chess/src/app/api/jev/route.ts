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
    const input = await readBody(request);
    if (request.headers.get("accept") === "application/x-ndjson") {
      const abort = new AbortController();
      const signal = AbortSignal.any([request.signal, abort.signal]);
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) => {
            if (!closed)
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(event) + "\n"),
              );
          };
          try {
            const decision = await loggedDecision(
              "jev",
              input,
              signal,
              (stage) => send({ stage }),
            );
            send({ decision });
          } catch (error) {
            send({
              error:
                error instanceof EngineError
                  ? error.message
                  : "Jev is unavailable. Retry to continue.",
            });
          } finally {
            if (!closed) {
              closed = true;
              controller.close();
            }
          }
        },
        cancel() {
          closed = true;
          abort.abort();
        },
      });
      return new Response(stream, {
        headers: { ...headers, "Content-Type": "application/x-ndjson" },
      });
    }
    return Response.json(await loggedDecision("jev", input, request.signal), {
      headers,
    });
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
