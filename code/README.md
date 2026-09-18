# Opening · Chess model comparison

A Next.js, React, TypeScript and Tailwind chess board where **Jev 1.13, GPT-6 Astra (medium reasoning), or GLM 5.3 (low reasoning) plays White** and **native Stockfish 19 plays Black**. chess.js generates all legal moves and enforces the rules. All models receive the same current board, full move history and every legal choice, without Stockfish rankings or evaluations.

## Run locally

Use Node.js 22.22.3 (`nvm use`), then run these commands inside `code/`:

```bash
npm ci
# On a new Mac only; this Mac already has Stockfish 19:
brew install stockfish
# Create local configuration if needed; no environment files are tracked:
touch .env.local
```

Follow the [root setup guide](../README.md#run-locally) to create the configuration locally. Set `OPENROUTER_API_KEY` for Jev and GLM and `OPENAI_API_KEY` for Astra in `.env.local`. Both are server-only variables; do not prefix them with `NEXT_PUBLIC_`. The file is ignored by Git. Restart the server after adding/changing a key. Astra calls OpenAI directly; it never falls back to OpenRouter.

```bash
npm run dev -- --hostname 127.0.0.1
```

Open http://localhost:3000, choose **Jev 1.13**, **GPT-6 Astra · Medium**, or **GLM 5.3 · Low**, and click **Start game**. Start checks local key configuration and Stockfish, then evaluates the board and requests the selected model's first decision. Loading the page and `GET /api/jev` do not perform paid inference. Missing configuration shows an actionable error and leaves the initial board intact.

Stockfish is detected at Homebrew and common Linux paths, or from `PATH`. Override with `STOCKFISH_PATH` in `.env.local` if needed. A Node.js server with permission to spawn the native binary is required; static export and Edge runtime are unsupported. No Python or additional inference SDK is required.

This is a local experiment. The provider route spends the server's provider credits when called; add user authentication and per-user quotas before exposing it publicly. The built-in origin check and per-process concurrency limit are not user authentication.

## Watching and controlling a game

### Optional Jev lookahead

Select Jev and enable **Stockfish lookahead** before starting a game to attach predicted continuations and concrete consequences to every legal move. The switch defaults to Off and is locked for the game, including pause/resume and undo; choose New game to change it. Other models do not use this mode.

The server runs a separate Stockfish 19 MultiPV search at skill 20, one thread, 16 MB hash, depth capped at 16 and a total search budget of 3 seconds. It uses the latest complete iteration covering every legal move and preserves the original legal-choice ordering. Actual depth depends on the position and machine. Each choice includes up to six plies (including the candidate move), the resulting FEN, captures, promotions, castling, checks, and any rule-based terminal result reached. Lines are validated and replayed with the full game history. These are predicted best-play lines; the Club-strength opponent may choose differently.

No engine score, ranking, win probability, or recommended move is sent to Jev. The engine search can examine further than the displayed six plies. This is still engine-assisted play; run history and JSON/PGN exports identify the mode so results can be distinguished from unassisted runs. Older logs without a lookahead setting are treated as Off.

The UI reports lookahead preparation followed by Jev's decision. Pause/reset/undo abort pending work. Failed or incomplete analysis stops the turn before provider inference and requires an explicit retry. Assisted inputs are larger and may increase provider cost. The exact enriched payload is logged before transmission, together with achieved depth, engine identity, pinned settings and analysis time; model latency remains separate. The analysis metadata is not included in Jev's payload.

The browser API also accepts `window.opening.start({ model: "jev", lookahead: true })`. The saved run setting is authoritative on the server. The command-line benchmark continues to create unassisted games by default.

Native verification: `node --env-file=.env.local --import tsx --test tests/native-stockfish.integration.ts tests/lookahead.integration.ts`. The lookahead integration test uses the installed engine and a fake provider response; it does not spend provider credits.

### Controlled continuation replay

`scripts/replay-lookahead.ts` compares 6-ply and up-to-18-ply previews on the saved positions before White moves 13, 16 and 19. Both arms use the same full history, legal-choice ordering, Stockfish search snapshot, balanced chess instruction and resulting ASCII board. No material-loss summaries, engine scores, rankings or recommendations are sent to Jev. Search uses skill 20, one thread, 64 MiB, depth cap 22 and 15 seconds per position; actual PV lengths and depth are recorded. This experiment does not change the frontend lookahead mode.

```bash
# Offline preparation and review (no provider requests):
node --env-file=.env.local --import tsx scripts/replay-lookahead.ts data/runs/<run-id>.json data/replays/<experiment-name>
# Two decisions per position per arm: at most 12 paid Jev requests.
node --env-file=.env.local --import tsx scripts/replay-lookahead.ts data/runs/<run-id>.json data/replays/<experiment-name> --live
```

The output directory contains `experiment.json` with exact paired inputs, assessor-only engine scores, response IDs, usage, costs and attempt records, plus `report.md`. Each attempt is saved before transmission; reusing a directory skips all attempted calls, including failed or interrupted ones. No automatic provider retries occur. A changed source run or configuration requires a fresh directory. Results measure the chosen move against the best move in the shared search, not piece counts or the truncated final board. This selected-position diagnostic does not establish playing strength or explain the model's internal reasoning; both arms also differ in board representation and instructions from the original game.

The board scales to fit the viewport width and height. The model chooser and game controls sit underneath it, with compact evaluation and cost information during play. Run history is collapsed by default.

- **Start game** runs the selected White model → Stockfish → updated model input until the game ends. Changing models requires a new game; all use the same Stockfish settings.
- **Pause** cancels the pending request; **Resume** continues from the same position. An already processed provider request may still be charged.
- **Undo** takes back the last turn and pauses. **New game** resets the board; it does not automatically start another game.
- The board is a spectator view. Flip it or navigate squares with arrow keys; clicks and drags do not make moves.
- Errors pause the game. **Retry connection** retries the same position explicitly; there are no automatic paid retries or substitute players.
- Checkmate, stalemate, castling, en passant, all four promotions, insufficient material, threefold repetition and the fifty-move rule are handled by chess.js.
- The active board stays in page memory, while run logs persist on the server. Refresh resets the playable board but keeps saved runs, including paused and stopped games. Saved runs can be inspected and exported; replay/resuming archived games is not implemented.

Stockfish uses the existing fixed Club settings (skill 6, depth 9, 650 ms). Version 19 does not mean maximum strength. Jev is pinned to `typesafe/jev-1.13`, through OpenRouter's `POST /api/alpha/decisions`. Astra uses `gpt-6-astra` directly through OpenAI’s `POST https://api.openai.com/v1/responses`, with `reasoning.effort: medium`, `store: false`, a 4,096-token output cap (including reasoning), and a strict JSON schema restricting the choice to legal UCI moves. Each provider uses its own key. Short smoke tests verify connectivity, not chess strength. See [API research](docs/jev-api-research.md) and [design proposal](docs/jev-chess-proposal.md).

GLM is pinned to `z-ai/glm-5.3`, the latest flagship verified on 18 September 2026. It uses OpenRouter Chat Completions, the same state/history/legal choices, strict legal-move JSON, mandatory low reasoning (a practical app setting; the model defaults to max), a 16,384-token combined output cap and a five-minute deadline. GLM does not support medium reasoning, so it is not an equal-reasoning-budget comparison with Astra. Actual OpenRouter charges are saved even when a response is rejected. See [GLM API research](docs/glm-api-research.md).

## Running a benchmark

The resumable runner saves every paid attempt and move in the site's normal logs. Each new selected model receives 50 games as White against the same Club Stockfish. Provider failures and 400-ply caps remain unfinished, never chess losses or draws. Automatic retries are limited to two per failed move in each execution pass.

```bash
CHESS_BENCHMARK_MODELS=glm CHESS_BENCHMARK_GLM_CONCURRENCY=20 node --env-file=.env.local --import tsx scripts/benchmark.ts data/benchmarks/glm-50/results.json
node scripts/benchmark-progress.mjs data/benchmarks/glm-50/results.json
node --env-file=.env.local --import tsx scripts/benchmark-report.ts data/benchmarks/glm-50/results.json
```

The same manifest resumes unfinished games without replaying saved decisions. Do not run two processes against one manifest. `CHESS_BENCHMARK_MODELS` defaults to `jev,astra` for a new batch; an existing manifest controls its own players. These commands spend provider credits. Concurrency overrides apply only to the benchmark process; the website keeps a two-request provider limit.

## Evaluation and saved runs

The vertical bar beside the board and the compact evaluation below it use a **separate Stockfish 19 analysis** at skill 20, up to depth 16 / 600 ms per position. Scores are always from White's perspective: `+1.00` favors the chosen model, negative values favor Stockfish, and `M3` denotes a forced mate reported by the engine. The bar's fill is a visual scale, not a win probability. Flipping the board flips the bar's white/black orientation without changing the score perspective. Analysis is never included in any model's input.

Each new run is stored as `data/runs/<uuid>.json` by default, with atomic writes and serial event ordering. Set `CHESS_RUNS_DIR` to an absolute directory to keep logs outside the app checkout. This machine's preview uses the canonical project's `code/data/runs` directory. `/data/` is ignored by Git.

**Run history** lists all saved runs, model and provider, result/status, ply count, evaluation, mean response time and run cost in USD. The controls below the board monitor the active run cost every two seconds, and history refreshes every three seconds. Open **View** for the event log, or download **JSON** / **PGN**. JSON includes starting position, opponent and analysis settings, full model request inputs, legal options, returned choices, actual model IDs, latency, optional confidence, token usage, per-request cost and its source, a persisted run billing summary, moves/PGN, pauses, undo/reset events and errors. Logging begins with this update; earlier unlogged games cannot be reconstructed.

Requests are logged before provider calls and every completed/error attempt is recorded, including cancellation. Model inputs and outputs are logged; credentials, authorization headers and hidden reasoning are not. A failed run-log creation prevents inference. Failure to save an applied move pauses the loop before the next player. Final page-close state is best effort; provider request records remain on disk. No hidden automatic inference retries occur.

Transient Windows file-replacement failures retry the same completed temporary file up to three times (50, 150 and 500 ms delays). Browser state saves retry network failures, HTTP 408/429 and server errors up to twice (250 and 750 ms delays), preserving the event ID and queue order so a lost response cannot duplicate a saved event. Persistent failures still stop play and expose Retry. Paid model requests are not automatically repeated.

Costs include every priced attempt, including responses rejected as illegal or incomplete. OpenRouter's `usage.cost` is stored as the provider-reported charge, without rounding the stored value. Direct OpenAI costs are calculated from the returned token counts at published Standard rates, and are labeled **Calculated**, not invoice totals. The request explicitly selects `service_tier: default`.

Astra prices verified on 18 September 2026 are $10 / million ordinary input tokens, $1 / million cached reads, $12.50 / million cache writes and $50 / million output tokens. Cache reads/writes are disjoint subsets of input, and reasoning is already included in output tokens. Above 272,000 input tokens, input/cache rates double and output rates multiply by 1.5 for the full request. Each calculated cost saves its rate snapshot, source, verification date, token counts and cost breakdown, so a later price update does not reprice recorded charges. See [OpenAI pricing](https://developers.openai.com/api/docs/models/gpt-6-astra), [cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching), and [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

A run's persisted `billing` object contains known USD total, reported/calculated subtotals, priced/unpriced/pending counts and completeness. A **+** marks missing or pending charges; a dash means no cost is known. Missing usage on a timeout, cancellation or network failure is not counted as zero. A failed response with usage is still counted. These totals exclude taxes, credit-purchase fees and private account discounts. No organization-wide billing or admin access is required.

Older OpenRouter Astra runs retain their original provider. Saved OpenAI usage is backfilled only when enough counts remain to calculate a price; inferred Standard tier is explicitly noted. Cache details omitted from an older response are only inferred as zero below the documented 1,024-token caching minimum. The one-time migration can be rerun idempotently with the server stopped: `node --env-file=.env.local --import tsx scripts/backfill-costs.ts`. Server logs survive restarts; active in-memory games do not.

The model settings were checked against [OpenAI's Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [OpenAI reasoning parameters](https://developers.openai.com/api/docs/guides/reasoning).

## Browser API

After hydration, `window.opening` exposes the same controller as the UI:

```js
await window.opening.start({ model: "astra" }); // "jev" is the default; autoplay continues
window.opening.pause(); // abort pending work, preserve the board
window.opening.getState(); // FEN, history, phase, turn, result, decisions
await window.opening.resume(); // resume either side's pending turn
window.opening.undo(); // take back a turn and pause
window.opening.pgn(); // actual moves with player names and result
window.opening.reset(); // return to idle; no automatic restart
```

`getState().decisions` contains the requested FEN, offered UCI moves, chosen move, returned model ID, latency and optional confidence/usage/cost for each applied model turn. Confidence is not a chess win probability. The same inputs and returned decisions are also saved in server run logs. The earlier decorative sections stay removed.

For custom positions, `start({ fen: "..." })` validates the FEN before replacing the game. A Black-to-move FEN starts with Stockfish. Terminal positions never call either player. The console-only `move(from, to, promotion?)` works **only while paused**, validates legality, and marks the PGN as an edited position. Promotion defaults to queen; `r`, `b` and `n` are supported. Resume then lets the appropriate player continue from the edited history. Manual board gestures remain disabled.

## Verification

```bash
npm test             # simulated Jev and Stockfish, HTTP boundaries, rules and cancellation
npm run test:native  # real installed Stockfish; no OpenRouter requests
npm run typecheck
npm run lint
npm run build
npm start -- --hostname 127.0.0.1
```

Provider unit tests replace fetch and use fake keys; they never call OpenRouter or OpenAI. Initial live smoke tests on 18 September 2026 verified one model decision and a Stockfish reply for each model through OpenRouter, plus a four-ply Astra game through the UI. The UI game was paused; a pending third Astra request was cancelled and recorded. A subsequent direct OpenAI smoke test verified `gpt-6-astra` with medium reasoning: `e4 g6`, a White-perspective evaluation of +0.67 at depth 16, and a saved request/result/PGN log. The direct response took 3.2 seconds. All test games were stopped afterward. These are integration tests, not a performance ranking.

## Main files

- `src/lib/chess-session.ts`: one serial turn loop, game state, cancellation, recovery and PGN.
- `src/lib/server-glm.ts`: GLM 5.3 low reasoning through OpenRouter Chat Completions with legal-move structured output.
- `src/lib/server-astra.ts`: GPT-6 Astra with medium reasoning and legal-move structured output.
- `src/lib/run-store.ts`: persistent run metadata and atomic event storage.
- `src/lib/evaluation.ts`: White-perspective scores and display formatting.
- `src/lib/server-jev.ts`: deterministic state/choice construction and authenticated Decisions request. Validates the selected move against that exact position.
- `src/lib/jev.ts`: browser transport and shared decision types; contains no credentials.
- `src/app/api/jev/route.ts`: uncached configuration check and decision endpoint.
- `src/lib/native-stockfish.ts`: native UCI process lifecycle, position validation and cleanup.
- `src/components/chess-club.tsx`: controls, game status and public API.
- `src/components/chess-board.tsx`: responsive spectator board with last-move/check highlights.

All players have finite request timeouts and cancellation. Only one turn is active per game; reset, pause, undo and disposal invalidate late responses. The Jev route permits at most two simultaneous provider requests per Node process. Native Stockfish permits four, one thread and 16 MB hash each. Full initial FEN plus legal move history is replayed so repetition is preserved.

## Stockfish source and license

Stockfish is GPL-3.0. Its native binary is installed separately, not bundled in the browser or repository. Upstream source, license and releases: https://github.com/official-stockfish/Stockfish. See `THIRD_PARTY_NOTICES.md`.
