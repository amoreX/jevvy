# Jev Picks

A local decision helper: describe what is on your mind, answer Sonnet 5's questions one at a time, review your options, and let Jev choose and score them.

## Start locally

Use Node.js 22.22.3 (`.nvmrc`). From `jev-picks/`:

```bash
npm ci
npm run dev
```

Set `OPENROUTER_API_KEY` in a local `.env.local` file first. The same OpenRouter account serves **`anthropic/claude-sonnet-5`** and **`typesafe/jev-1.13`**. Environment files and keys are ignored by Git. No provider key is sent to the browser.

Open [http://127.0.0.1:3010](http://127.0.0.1:3010). Port 3010 keeps this experiment separate from the chess app. Starting the app or loading its home page makes no inference calls; submitting a decision, continuing the interview, preparing options, or choosing an option makes paid provider requests.

For a production build, run `npm run build`, then `npm start`. This is a localhost experiment; the POST routes enforce a loopback Host and matching Origin. It has no user accounts or public deployment configuration.

## The flow

1. **Talk it through:** Sonnet asks up to five adaptive questions. Answer in your own words, choose a suggestion, or say you are unsure. After one answer you can ask it to prepare options early.
2. **Review:** Sonnet proposes facts, constraints, explicit assumptions, 2–4 criteria, and 2–5 options. Review and edit all of these. Every criterion has five concrete levels, from poor fit (0) to strong fit (4), used consistently across options. You can adjust priorities, edit or add options, and exclude options. At least two eligible options are required.
3. **Your pick:** Jev receives the exact reviewed brief through OpenRouter's Decisions endpoint. One Choice question selects an eligible option. Separate Score questions evaluate every eligible option against every criterion. The server validates the selected ID, the complete score matrix, finite bounds, and any returned distributions.

The result shows Jev's pick, option probabilities and confidence when supplied, a comparison table, all scale definitions, and per-score confidence and distributions. It also shows the actual returned model, latency, and the provider-reported cost of that evaluation. Missing billing is unknown, not zero. Export the decision as JSON to retain its brief, interview, scores, and receipts.

**What the numbers mean:** Scores locate an option on a descriptive scale; they are not percentages. Choice probabilities describe a distribution over the offered options. Confidence summarizes concentration of the model's answer. Neither predicts real-world success. Choice and Score questions are independent: the final pick is not computed by averaging the displayed scores. Descriptions, tradeoffs and next steps come from the reviewed brief, not an invented explanation of Jev's internal reasoning.

Editing an earlier answer rebuilds all later questions and options. Revisiting the brief discards its old result. Failed requests require an explicit retry; editing the brief clears a failed request's stale retry payload. Cancellation and new decisions ignore late responses. A provider may charge an already processed request even if it is cancelled.

The app keeps the active session only in browser memory. Refreshing clears it. Decision content is sent to OpenRouter's model providers, but the app does not write real user decisions to disk. There is no external research: current prices, availability and other unverified claims must remain assumptions or unknowns. Option eligibility is proposed by Sonnet and reviewed by the user; it is not an independent factual verification system.

## Verification

```bash
npm test             # domain + provider/HTTP boundaries, mocked fetch
npm run typecheck
npm run lint
npm run build
npm run test:browser # desktop/mobile flow with mocked API responses
```

Browser tests use installed Microsoft Edge by default. Change `channel` in `playwright.config.ts` to `chrome` for Chrome, or remove it and run `npx playwright install chromium`. The tests include an adaptive interview, edited brief, scorecard, export, retry, answer changes, cancellation, and mobile containment. Local screenshots and traces are ignored by Git.

For a bounded **paid** check, start the local app and run `npm run smoke:live`. It makes at most two Sonnet calls and one Jev call with synthetic decision data. The full result is written to ignored `data/live-smoke.json`.

On 21 September 2026 the live smoke returned a Sonnet follow-up, four options, three criteria, Jev's choice, all 12 scores, choice probabilities and confidence. The reported total was $0.032611176. This verifies the integration, not recommendation quality.

## Source map

- `src/components/picks.tsx`: interview, editable brief, scorecard and cancellation.
- `src/lib/decision.ts`: domain types, input/output validation and Jev request construction.
- `src/lib/interview-schema.ts`: Sonnet's instructions and structured-output schema.
- `src/lib/server.ts`: authenticated server-side calls, timeouts, concurrency and HTTP guards.
- `src/app/api/`: configuration, interview and decision routes.
- `scripts/smoke.ts`: explicitly opted-in live integration check.

Protocol references: [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [TypeSafe Score](https://docs.typesafe.ai/primitives/score), [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice), and OpenRouter's [Score response schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsscoreanswer.ts). OpenRouter makes confidence, probabilities and score legends optional; the app preserves that distinction.
