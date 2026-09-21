# Persistent Jev agent — 2026-09-19

| Requirement | Implementation | Evidence |
|---|---|---|
| Address Jev in Minecraft chat and get replies | UUID-based chat listener, mention filtering, duplicate suppression, paced replies | Live `JevCheck` chat: question/reply, jump, follow, stop |
| Control inventory and interact with the environment | Existing 60 state-filtered actions and recipe planner; automatic food/armor choices, owned surplus storage, building/lighting skills | Existing action/recipe/window tests; new storage and building state tests |
| Choose work when idle | Jev selects eligible resource, tool, armor, exploration, construction, lighting, farming, fishing, cooking and observation activities with cooldowns | Live autonomous survey and exploration completed; gathering selected and attempted; idle catalogue tests |
| Understand speaker and contextual sequences | Luna compiles validated skill plans using live positions, inventory, blocks, current jobs and recalled memory | Real Luna request compiled “come to me and help mine coal … until stop” into visit-speaker + ongoing coal acquisition, 2.379 s; sender/context tests |
| Indefinite jobs until stopped | Cooperative follow; repeatable acquisition batches; no managed-session deadline; ongoing blocked jobs retry with backoff | Live continuous following stopped by another player; repeated-batch and long-lived retry tests |
| Decide between players | Jev arbitrates incoming/current work, retains interrupted progress, revisits waiting requests | Live two-player test: Jev finished the first wait request then completed the second player's jump; preempt/resume tests |
| Learn world/player history automatically | Source-labelled player facts, conversations, observed/stale landmarks, task outcomes and durable jobs | Live recall of birch preference after restart; memory/reconnect tests |
| Lightweight chat model, Jev for decisions | `openai/gpt-5.6-luna` chat with strict JSON; `typesafe/jev-1.13` typed choices | Both real OpenRouter endpoints exercised; contract/validation tests |
| Minecraft knowledge | Installed 26.2 recipe dependencies plus planning rules supplied in model context | Existing no-gear-to-iron-armor simulated progression; actual contextual plan |
| Fast interaction | Literal-command fast path, immediate abort path, background chat separate from skills, frontier checks only when needed | Live stop replies 102–205 ms; other-player stop observed in 105 ms; Luna replies 1.3–2.6 s; latest Jev choice 580 ms |
| Persistent local service and minimal viewer | Reconnect supervisor, durable state, original single task input now supports interruption | Forced child exit rejoined in 4.016 s; viewer refreshed, input accepted new work while collecting, no key/queue controls |

Validation: `npm test` — **53 passed**, zero failures. Viewer build passed.
`node test/live-chat.js --run` and `node test/live-social.js --run` both passed.
Temporary integration players disconnected after testing. Autonomous play was
re-enabled through the viewer, which showed the live world and 20 health/20 food.

Limits: player coordinates exist only for loaded entities; unreachable terrain
can block tasks. The bot can clear soft vegetation and open wooden doors, but does
not tunnel through arbitrary structures. Built-in construction currently covers
small shelters, platforms and lighting. Those construction/storage workflows are
tested with simulated world state, not a completed live build. A full live
iron-armor run and every advanced workstation interaction have not been verified.
