import { EngineError } from "./native-stockfish";
export const noStore = { "Cache-Control": "no-store" };
export function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new EngineError("Cross-origin requests are not allowed.", 403);
}
export function apiFailure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof EngineError
          ? error.message
          : "The request could not be completed. Check the server and retry.",
    },
    {
      status: error instanceof EngineError ? error.status : 503,
      headers: noStore,
    },
  );
}
