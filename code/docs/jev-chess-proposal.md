# Jev as White against Stockfish 19

Proposed and approved on 18 September 2026. The integration is now implemented; live Jev inference is pending the user's API key. No paid request has been made. This document records the approved design; see README.md for current controls and setup. See [the API research](jev-api-research.md) for the verified HTTP contract and a complete opening-position request.

## Proposed experience

Start begins an automatic game: Jev chooses White's move, the board applies it, Stockfish 19 replies as Black, and the cycle repeats. Keep the minimal board layout and the previously removed sections removed. Replace “You” with “Jev”; add Pause/Resume and New game. Manual piece movement is disabled while these two players control the game. Preserve programmatic state inspection and PGN export.

Keep Stockfish's existing Club settings for the first experiment: skill 6, depth 9, 650 ms search time, as defined in `src/lib/stockfish.ts:12`. Stockfish 19 is the engine version, not an assertion that the current game uses maximum strength. Pin Jev to `typesafe/jev-1.13` to make trials comparable; the moving alias is available if automatic model upgrades are later desired. [OpenRouter model listing](https://openrouter.ai/typesafe/jev-1.13).

## One decision per White turn

1. Reconstruct the position from the initial FEN and complete move history using the existing chess.js rules library. Check for a finished game before making any model call.
2. Generate **every legal move**, including separate queen, rook, bishop, and knight promotion choices. Use UCI moves as stable IDs, with SAN and plain descriptions for the model. Chess.js already supplies legal moves and applies them with validation. [Chess.js documentation](https://jhlywa.github.io/chess.js/).
3. Send the current state and one Choice question to Jev. State includes FEN, an explicit square/piece list, whose turn it is, SAN history, check status, and the game-rule facts needed to interpret the position. Build this afresh each turn; model memory is not required. Do not supply Stockfish evaluations, recommended moves, or a ranked shortlist in the initial experiment.
4. Validate `answers.move.choice` against the legal moves for the requested position. Apply it only if the same game generation and FEN are still current. Missing confidence is valid; a missing, wrong-type, or illegal choice is an error.
5. Check the result, ask the existing Stockfish endpoint for Black's reply, validate/apply that reply, and check the result again. Then start the next White decision.

The model owns the choice among legal alternatives. Chess code owns rules, move application, turn order, and termination. TypeSafe supports up to 255 options per Choice; if an input exceeds a supported limit, pause with an explicit error rather than silently omit moves. Confidence, when returned, is not a chess win probability. [TypeSafe Choice contract](https://docs.typesafe.ai/primitives/choice), [OpenRouter optional answer fields](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/models/decisionschoiceanswer.ts).

## Small integration boundary

The existing `ChessSession` owns state, full history, result detection, request cancellation, and stale-response protection (`src/lib/chess-session.ts:35`, `:79`, `:84`, `:156`). Extend that controller with one sequential turn loop. Avoid a second loop in a React effect that can independently mutate the board.

Add a server-only Jev adapter and `/api/jev` route. The browser submits the initial FEN and move history; the server reconstructs and validates them, requires a nonterminal White turn, and generates the options itself. It does not trust client-provided candidate lists. Share the existing position-validation mechanics where practical (`src/lib/native-stockfish.ts:16`).

The server calls `POST https://openrouter.ai/api/alpha/decisions` with a fixed endpoint, the pinned model, state, and questions. Plain server-side `fetch` is enough; no Python service or general agent SDK is needed. The API key will be `OPENROUTER_API_KEY` in ignored `code/.env.local`, never a `NEXT_PUBLIC_` variable or browser payload. [Official OpenRouter request implementation](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/funcs/alphaDecisionsCreate.ts).

Only one turn request may be active. Pause, reset, undo, and disposal abort it and invalidate its generation. Cancellation cannot undo a provider charge already incurred, but a late response must never move a changed board. Network/authentication/credit/rate-limit errors pause at the current position; retry is explicit, with no silent substitute player. The initial live smoke test is capped at one Jev decision, followed by a short bounded game before normal autoplay testing.

Keep state in the existing in-page session for this first version. Pause/Resume works within that session; browser refresh does not promise durable recovery. Initial FEN plus complete history is the reconstruction format, because a current FEN alone does not encode prior repetitions. Keep a compact decision record with position, offered IDs, selected move, returned model ID, latency, and returned usage/cost. Do not log credentials. PGN records the actual applied game. No model-written explanation is expected from a typed Choice response.

## Reference comparison and evidence

The domain reference was inspected read-only at PettingZoo commit `1262fb3275f4de6c49bab884afc991ff656c8483`: chess runtime, chess tests, AEC documentation, order/illegal-action wrappers, license, and related issue reports. No reference code was executed or added as a dependency. These references support the mechanics, not Jev's chess strength.

| Reference behavior | Adopt | Omit or adapt, with reason |
| --- | --- | --- |
| [Chess environment](https://github.com/Farama-Foundation/PettingZoo/blob/1262fb3275f4de6c49bab884afc991ff656c8483/pettingzoo/classic/chess/chess.py): observe the board, expose the current player's legal actions, validate/apply one action, check endings, advance the player. | The same serial state → choices → action → terminal check → next player sequence. | Its Python/Pygame runtime and tensor/action encoding: this app already has a Next.js board and chess.js; UCI IDs directly fit Jev's criteria map. |
| [AEC API](https://github.com/Farama-Foundation/PettingZoo/blob/1262fb3275f4de6c49bab884afc991ff656c8483/docs/api/aec.md) and [order wrapper](https://github.com/Farama-Foundation/PettingZoo/blob/1262fb3275f4de6c49bab884afc991ff656c8483/pettingzoo/utils/wrappers/order_enforcing.py): initialization and termination constrain when an action is valid. | Initialize before starting; stop on terminal positions; stale responses cannot act. | No training loop, rewards framework, or parallel environment abstraction is needed for one visible chess game. |
| [Illegal-action wrapper](https://github.com/Farama-Foundation/PettingZoo/blob/1262fb3275f4de6c49bab884afc991ff656c8483/pettingzoo/utils/wrappers/terminate_illegal.py): illegal actions can end a player's episode. | Validate every selected action at the application boundary. | Do not turn transport/protocol errors into chess losses. They leave the legal board unchanged and pause this experiment. |
| [Chess tests](https://github.com/Farama-Foundation/PettingZoo/blob/1262fb3275f4de6c49bab884afc991ff656c8483/pettingzoo/classic/chess/test_chess.py) exercise move/action conversion; [issue 1307](https://github.com/Farama-Foundation/PettingZoo/issues/1307) reports historical copy/pickle state loss in a different environment. | Test action conversion and explicit position/history reconstruction. | Do not assume copying a runtime object is a durable checkpoint. The issue is a caution, not evidence of a current chess defect. |
| [OpenRouter Choice schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/models/decisionschoicequestion.ts) and request implementation define typed choices and the Decisions endpoint. | One named move question, stable criteria IDs, optional returned confidence. | No chat-completions parsing, generated tool commands, or SDK default hour-long retry budget. This UI needs finite timeouts and explicit recovery. |

PettingZoo's [MIT license](https://github.com/Farama-Foundation/PettingZoo/blob/1262fb3275f4de6c49bab884afc991ff656c8483/LICENSE) was inspected; no code is being copied. This is an action-selection environment, not a security sandbox. In this app Jev receives only chess data and returns a choice: it receives no shell, filesystem, credential, or arbitrary network capability. Existing native Stockfish execution remains behind its validated UCI adapter. No additional executable dependency is proposed.

Component decisions: **KEEP** chess.js and the native Stockfish adapter (existing legal game/Black move paths); **THIN** `ChessSession` into a single serial scheduler with no move-ranking heuristic; **KEEP** a server-only Jev adapter (required by the authenticated Decisions contract and browser key isolation); **KILL** proposed Python wrappers, general agent frameworks, Stockfish-based White shortlists, and extra model calls for prose (none is required by this requested flow).

## Verification before calling it working

- Test complete candidate generation, captures, castling, en passant, check evasions, and all promotions; replay full history for repetition and terminal detection.
- Use controlled adapter responses to verify White → Black → updated White input, a single active request, and no requests after game completion.
- Test illegal/wrong-type responses, optional confidence, request timeouts, and pause/reset/undo during either player's pending turn. A late result must not mutate the new position.
- Run the existing game and native Stockfish tests, type checking, lint, and build after implementation. Check Start/Pause/Resume/New game in the browser with the existing minimal layout.
- After confirmation and local key setup, make one real Jev choice and then a bounded game. Record actual response shape, legality, latency, and usage. Synthetic test fixtures are not model performance evidence.

OpenRouter lists the model, but this account's access and Jev's chess ability remain untested. Schema-constrained output does not establish strong chess play. If strength is later evaluated, pin both model and engine settings and use held-out positions/games; do not insert Stockfish's preferred answers into Jev's evaluation input.
