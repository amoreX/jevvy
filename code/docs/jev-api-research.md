# Jev through OpenRouter: verified API contract

Checked 18 September 2026. Research only: no API keys read, no inference requests made, and no application code changed.

## Recommended route

Use server-side HTTP `POST https://openrouter.ai/api/alpha/decisions`, with `Authorization: Bearer <OPENROUTER_API_KEY>` and `Content-Type: application/json`. This is OpenRouter's **alpha Decisions API**, not its chat-completions API. The official SDK builds that exact URL and request method; its public helper is `openRouter.alpha.decisions.create({ decisionsRequest: ... })`. Plain `fetch` is sufficient for this Next.js application. [OpenRouter request implementation](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/funcs/alphaDecisionsCreate.ts), [SDK usage](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/docs/sdks/decisions/README.mdx), [authentication](https://openrouter.ai/docs/api_reference/authentication).

Pin **`typesafe/jev-1.13`** for the first experiment. The moving OpenRouter alias is **`~typesafe/jev-latest`**, including the leading tilde. The model's actual provider is TypeSafe. Its endpoint metadata reports `text->decisions`, a **32,000-token context**, **$0.042 per million input tokens**, and **$0 output-token price**. These are current catalog values, not a claim about future prices. [Model page](https://openrouter.ai/typesafe/jev-1.13), [pinned model endpoint metadata](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints), [latest alias metadata](https://openrouter.ai/api/v1/models/~typesafe/jev-latest/endpoints).

## OpenRouter request and response

Required top-level properties are `model`, `state`, and `questions`. `state` may be a string, object, or array. Each named question can be a Choice, Score, or Noul. For this app use one Choice question, whose `criteria` keys are legal UCI moves. Its `instructions` can be text or structured JSON; each criterion can be a string, object, array, or null. The HTTP body can additionally include `provider`, `session_id`, `trace`, and `user`, but none is required for this experiment. [Request schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/models/decisionsrequest.ts), [Choice question schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/models/decisionschoicequestion.ts).

Concrete initial-position request, containing **all 20 legal moves**:

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "game": "standard chess",
    "your_color": "white",
    "side_to_move": "white",
    "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "position_description": "The normal starting position. White moves first. All pieces are on their starting squares.",
    "move_history_san": [],
    "in_check": false
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose the best next legal chess move for White to improve its position and ultimately checkmate Black. Every criterion is a legal move in the current position.",
      "criteria": {
        "a2a3": "a3: move the white a-pawn from a2 to a3.",
        "a2a4": "a4: move the white a-pawn from a2 to a4.",
        "b2b3": "b3: move the white b-pawn from b2 to b3.",
        "b2b4": "b4: move the white b-pawn from b2 to b4.",
        "c2c3": "c3: move the white c-pawn from c2 to c3.",
        "c2c4": "c4: move the white c-pawn from c2 to c4.",
        "d2d3": "d3: move the white d-pawn from d2 to d3.",
        "d2d4": "d4: move the white d-pawn from d2 to d4.",
        "e2e3": "e3: move the white e-pawn from e2 to e3.",
        "e2e4": "e4: move the white e-pawn from e2 to e4.",
        "f2f3": "f3: move the white f-pawn from f2 to f3.",
        "f2f4": "f4: move the white f-pawn from f2 to f4.",
        "g2g3": "g3: move the white g-pawn from g2 to g3.",
        "g2g4": "g4: move the white g-pawn from g2 to g4.",
        "h2h3": "h3: move the white h-pawn from h2 to h3.",
        "h2h4": "h4: move the white h-pawn from h2 to h4.",
        "b1a3": "Na3: move the white knight from b1 to a3.",
        "b1c3": "Nc3: move the white knight from b1 to c3.",
        "g1f3": "Nf3: move the white knight from g1 to f3.",
        "g1h3": "Nh3: move the white knight from g1 to h3."
      }
    }
  }
}
```

Read the selected move from `answers.move.choice`, with `answers.move.type === "choice"`. The response requires `model`, `answers`, and `usage`; raw HTTP usage uses `input_tokens` and `output_tokens`. `id`, `provider`, and `usage.cost` are optional. Crucially, **OpenRouter's schema makes `probabilities` and `confidence` optional**. Preserve/show them if present, and allow a valid chosen move without them. No streaming, `messages`, temperature, or chat output parsing is needed. [Choice answer schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/models/decisionschoiceanswer.ts), [response schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/models/decisionsresponse.ts).

An illustrative schema-valid minimal response (invented values, **not an inference result**) is:

```json
{
  "model": "typesafe/jev-1.13",
  "answers": { "move": { "type": "choice", "choice": "g1f3" } },
  "usage": { "input_tokens": 900, "output_tokens": 100 }
}
```

TypeSafe documents up to **255 options per Choice**. The current OpenRouter SDK schema adds no stricter option-count validation. Its behavior at that boundary has not been tested here. Direct TypeSafe Choice probabilities cover every option and sum to one; confidence measures the concentration of that distribution. It is **not a chess win probability or proof of a strong move**. [TypeSafe Choice documentation](https://docs.typesafe.ai/primitives/choice), [confidence](https://docs.typesafe.ai/confidence).

## TypeSafe direct API is a distinct integration

The direct endpoint is `POST https://api.typesafe.ai/v1/systemone`, with a **TypeSafe** Bearer key, not an OpenRouter key. Direct model IDs are `jev-1.13.0` and `jev-latest` (currently pointing to that version). The documented direct response requires probabilities/confidence for Choice answers. Do not copy these model IDs or assume that changing an SDK base URL alone produces the OpenRouter contract. [TypeSafe HTTP API](https://docs.typesafe.ai/api).

Direct TypeSafe documents 64k tokens across state plus all questions, with 32k for state plus the longest individual question, and currently lists 250,000 tokens/second and 1,200 requests/minute, explicitly subject to change. Those direct-service limits should not be presented as guaranteed OpenRouter limits. [TypeSafe models](https://docs.typesafe.ai/models).

## Access and remaining uncertainty

The OpenRouter model page and provider endpoint are publicly listed. The route uses normal API-key authentication and defines authentication, credit, permission, rate-limit, and service errors. No separate Jev allowlist requirement was found in the official materials checked; that does **not** verify this user's account access or credits. A single authorized test after key setup must confirm access, the returned optional fields, latency, and billing. TypeSafe's own homepage still presents a waitlist; direct-provider account access is a separate question. [OpenRouter operation and error definitions](https://github.com/OpenRouterTeam/typescript-sdk/blob/1a45645ff4db9026739c410f359779706edca838/src/funcs/alphaDecisionsCreate.ts), [TypeSafe homepage](https://typesafe.ai/).

OpenRouter's Decisions documentation is present in its [official documentation index](https://openrouter.ai/docs/llms.txt), but direct retrieval of that individual documentation page returned 403 during research. The exact contract above was therefore verified against the official OpenRouter SDK at commit `1a45645ff4db9026739c410f359779706edca838`, rather than inferred from another provider's API. This alpha endpoint may change.

## Implications for the chess experiment

Generate exact legal moves and game facts in deterministic chess code, send every move as a criterion, then validate Jev's returned choice against that exact position before applying it. Stockfish 19 plays Black. After Black replies, rebuild state and choices and call Jev again. Include board-piece descriptions, SAN history, check state, and explicit captures/promotions alongside FEN so the model need not decode only compact notation. Do not supply Stockfish rankings/evaluations to Jev in the initial experiment: doing so measures an engine-assisted chooser rather than Jev's own move selection. These are design recommendations, not claims about measured chess ability.

TypeSafe itself documents weaknesses in numeric precision, indirection, and lengthy irrelevant context; Jev is aimed at narrow judgments rather than extended search. Chess strength remains unmeasured here. Keep calculation and game legality in code, pin the model, save decisions for comparison, pause on invalid responses or API errors, and use bounded retries. [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

At the listed input price, an illustrative 40-decision game averaging 2,000 input tokens per decision costs about **$0.00336 in inference input charges** (`40 × 2,000 × $0.042 / 1,000,000`). This is arithmetic, not a measured bill; actual token usage, retries, game length, and any account funding fees differ.
