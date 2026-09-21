# Jev — headless Minecraft 26.2

A separate local player instance connecting to a server you configure as
`Jev`, using the server's offline authentication mode. It runs through
Mineflayer without a graphical Minecraft client, launcher, Java runtime,
or Microsoft login.

## Setup

Use Node.js 22 or newer and Python 3.9 or newer. From the repository root:

```sh
cd minecraft
npm ci --ignore-scripts --no-fund
npm rebuild canvas
cp config.example.json config.json
cp env.example .env
```

Edit `config.json` with your server's host and port, and set
`OPENROUTER_API_KEY` in `.env`. Both files are ignored by Git. The example
connection uses offline authentication and Minecraft Java 26.2; the server
must support that configuration. Then build the viewer and start Jev:

```sh
npm run build:viewer
npm run up
```

Open [the local viewer](http://127.0.0.1:3007/). The initial viewer build
downloads Mojang's official 26.2 client jar and checks its SHA-1 before
extracting assets. Generated assets, runtime state, logs, and dependencies
stay local. Canvas uses a native module; if its prebuilt binary is unavailable
for your Node/platform combination, installation needs a C/C++ compiler and
the [node-canvas build dependencies](https://github.com/Automattic/node-canvas#compiling).

`npm run up` and `npm start` load `.env`; background child processes inherit
the key. A private `runtime/openrouter-key.json` from an existing installation
takes precedence if present. Neither credential source is sent to the browser.

### Project layout

- `agent/`: goal parsing, Jev decisions, planning, execution, chat, and memory.
- `bot.js`, `supervisor.js`, `instance.js`: Minecraft connection and service lifecycle.
- `viewer-*.js`, `viewer.html`, `agent-client.js`: local viewer and task input.
- `vendor/viewer-compat/`: upstream viewer fixes, provenance, and license.
- `server/`: optional server-console commands for survival testing protection.
- `test/`: automated tests and explicitly opted-in live checks.
- `docs/IMPLEMENTATION.md`: historical implementation and verification notes.

## Watch Jev live

Open **http://127.0.0.1:3007/** while Jev is running. The viewer starts with
`npm run up` and is accessible only on the computer running Jev.

- **Jev's eyes** follows the player's live first-person camera.
- **Orbit** shows the player from outside. Drag to rotate, scroll to zoom,
  and right-drag to pan. These controls only move your viewing camera.
- The overlay shows live health and food.

This is an existing Prismarine Viewer renderer adapted for the real 26.2
block data and assets. It shows the live world, with simplified lighting and
entity graphics rather than the full vanilla client's visuals.

## Give Jev goals

Type a task in the single input and press **Enter** or **Do it**. It starts
immediately. The same button becomes **Stop** while Jev works and the input is empty. You can type a new task while Jev works; **Do it** then interrupts the current task. A new task replaces
unfinished work; there is no visible queue, settings panel, or API-key form.
For a task with several steps, write `get iron armor then get 16 torches`.
Type `resume` to re-enable idle activity after stopping. Shift+Enter inserts a line break.
The OpenRouter key loads from the private local configuration automatically.

### Minecraft chat and autonomous play

Any online player can address Jev with `@jev` (case-insensitive). Jev answers in
public Minecraft chat, addressing the requesting player. The sender comes from
the player-chat UUID; his own replies and duplicate chat events are ignored.

```text
@jev come to me
@jev come to me and help mine coal in this cave
@jev keep following me until I say stop
@jev keep gathering wood until I tell you to stop
@jev build a small shelter
@jev my base is made of birch; remember that
@jev what are you doing?
@jev stop
@jev resume
```

`me` is the speaker, with their live Minecraft position. Players outside loaded
chunks have no current position available: Jev asks for coordinates or for them
to come closer. He does not invent a location. A request can contain several
ordered skills, with recipe/tool prerequisites supplied by the existing planner.

Chat and complex wording use **`openai/gpt-5.6-luna`** through OpenRouter strict
JSON outputs, with reasoning disabled for latency. Simple commands, stopping and
pronoun resolution have a local fast path. **`typesafe/jev-1.13`** continues to
choose concrete gameplay actions, idle objectives, and which player to help.
Luna never executes generated code; plans are validated against known skills,
registry items, coordinates and live action preconditions.

When another player asks for help, Jev chooses between the current and incoming
requests using urgency, progress and waiting time. Interrupted work is saved and
resumed. Waiting requests are reconsidered after a minute to avoid an indefinite
task monopolizing him. Anyone can say `@jev stop`; it immediately cancels model
requests and movement, clears pending work and holds him still. `@jev resume`
enables autonomous play again. Ongoing work has no 20-minute or 120-decision
deadline; blocked ongoing tasks retry with backoff until stopped or replaced.

When idle, Jev chooses from eligible activities: observing, exploring, gathering
wood/stone/coal/iron, upgrading tools, making and wearing armor, cooking, crafting
torches, building a small shelter or work platform, lighting an area, storing
surplus, farming, fishing and sleeping. Activities have prerequisites and learned
failure cooldowns. Human requests interrupt idle work. Hunger recovery can
interrupt work and then return to it. Small builds use clear natural sites and
verified block placements; autonomous storage uses chests Jev built himself.

Memory is automatic: conversations and player-reported facts, observed player
positions/resources/workstations, changed/depleted landmarks, successful and
failed skills, task ownership and interrupted progress persist across restarts.
Claims retain their source and are distinguished from direct observations.
Relevant memories and Minecraft planning rules are included in model context.
Files are private: `runtime/world-memory.json`, `world-events.jsonl`, and
`community.json`. Recent recall is bounded; older events remain in rotated journals.

The exact model is **`typesafe/jev-1.13`**, called through the official
`@openrouter/sdk` method `alpha.decisions.create`, at
`https://openrouter.ai/api/alpha/decisions`. Jev is TypeSafe's structured
decision model, not a prose/chat model. Each request gives it current game
state and named executable choices; it returns a choice and confidence.
Recipe quantities and prerequisites come from code and 26.2 recipe data.
Completion is verified from inventory, worn armor, world state or position.

The controller has **60 action types**, each backed by an executor using
Mineflayer, Pathfinder, CollectBlock, Tool, or Prismarine recipe APIs. Its live
`available_actions` array contains concrete item names/counts, slots, entity IDs,
block positions, faces and window IDs. Jev returns one of those action IDs.
Invented IDs and stale targets are rejected. Large sets are selected by action
family and target before the final choice; options are not silently truncated.

Actions cover observation; walking/sprinting/sneaking/swimming, jumping, turning,
following and exploration; digging and block/entity placement; farming; crafting
and smelting; equipment, hotbar, inventory slots and dropping; containers and
furnaces; enchanting, anvils and villager trading; food, beds and respawning;
using/charging items and fishing; melee attacks and entity interactions; riding,
steering and gliding; and creative flight/items when the server grants creative
mode. The conversational layer generates chat replies; explicit say/sign/book
actions preserve user-supplied text. Jev does not execute chat slash commands.

```text
jump 3 times and rotate 6 times
walk forward 3 blocks then turn left 90 degrees
follow ronis for 20 seconds
follow ronis around keep moving to him
sprint to ronis
open chest then take 5 iron ingots from chest then close window
equip shield in offhand
plant wheat seeds
attack zombie
get iron armor then get 16 torches
inspect inventory
```

The task parser preserves literal quantities, coordinates and messages. `and`,
`then`, semicolons and newlines separate ordered steps; quoted text is preserved.
Unrecognized wording goes to Luna for a validated skill plan grounded in the
speaker, current world and memory. Jev chooses the concrete action within each step.
Specific commands and resource goals instead have deterministic completion checks:
jumps require takeoff and landing, rotations use a complete sequence of angles,
transfers check inventory changes, and armor checks the equipped slots. An open
workstation or equipped item can be a prerequisite without completing the task.
Named navigation resolves a complete player name separately from surrounding
wording. `keep following`, `follow … around` and `until I press stop` track the
player until Stop; an explicit duration takes precedence. Bare `follow ronis`
retains the 15-second default. Following reacquires the same player after an
entity change and reports missing targets or blocked movement explicitly.

The iron-armor planner obtains ingredients, tools and workstations using actual
26.2 recipes. Its dependency chain is included in the decision state, explaining
why collecting wood can advance an armor goal. Collection searches exposed blocks
within 32 blocks and can choose reachable exploration destinations when sources
are absent. Logs require nearby leaves. The home collection buffer is 8 blocks;
autonomous travel can leave the original 96-block area. Travel opens wooden doors,
clears obstructing bamboo/soft vegetation outside the home buffer, and avoids large drops. It does not dig through stone or existing structures. The supported building blueprints
are small shelters and platforms; blind tunnels, bridges and arbitrary castles
are not implemented. Unreachable terrain can still block resource acquisition. Direct
block-breaking and placement commands act on the explicitly selected target.

Available actions depend on items, reachable targets, open windows and game mode;
server protection and interaction rules can still reject an action. These
advanced interactions are wired to library APIs, not all verified in live play.
Vanilla spawn-protection denials now abort optimistic digging and persist a
confirmed minimum protected radius around the server's world spawn. Collection
and route clearing avoid that area. If Jev is enclosed by protected blocks, a
server operator must relocate him to clear ground; survival mode alone does not
grant permission to mine spawn.
Smelting uses an empty furnace and persists unfinished batches for resumption.
It does not consume a pre-existing furnace batch. There is no generic model pause
option competing with valid actions. Missing preconditions and server/plugin
failures produce a specific visible/chat error. Human tasks retry transient failures;
idle failures cool down and a different activity can be chosen. Stop cancels movement
and pending work. A stuck plugin has a
125-second disconnect backstop. Follow uses a cancellable tracking loop; continuous
follow remains active until Stop or a reported target/path failure, without that
watchdog. No model-generated code is executed.

`GET /api/actions` is a read-only diagnostic view of the full current option array
and unavailable action families. Exact offered choices, selections, observed
results and errors are recorded privately in `runtime/decisions.jsonl` (20 MiB
rotation with one previous file). `runtime/jev.log` includes selected action IDs
and failure details. There are no extra controls or action menus in the viewer.

The viewer and APIs bind only to `127.0.0.1`, check Host/Origin, and require a
per-process token on mutations. The key is never included in status, sockets or
logs; if remembered, it is stored in `runtime/openrouter-key.json` with mode 0600.
Do not commit or share `runtime/`. Game observations and goals are sent to
OpenRouter/TypeSafe when making decisions and to Luna when interpreting chat.
Task progress and
recent activity are persisted locally in `runtime/agent.json`.

## Run

Complete [Setup](#setup) first, then run these commands from `minecraft/`:

```sh
npm run up       # Start in the background; stays running after the terminal closes
npm run status   # Process status and latest player/world snapshot
npm run ping     # Independently query the server's version and online players
npm run down     # Disconnect and stop this instance
```

For foreground operation, stop the background instance first, then run
`npm start`. Ctrl+C disconnects. Local duplicate instances are rejected.

Connection settings are in `config.json`. Logs are in `runtime/jev.log`;
`runtime/status.json` updates every ten seconds and on lifecycle events.
To follow the log:

```sh
tail -f runtime/jev.log
```

The process runs while the host computer is awake. The background supervisor reconnects
after unexpected disconnects with 3–60 second backoff and resumes saved human
work. `npm run down` stops both processes. It does not automatically launch at login.

## Validation

Run `npm test` for the SDK contract, valid-choice enforcement, credential privacy,
compound-task counts, cancellation, live-state action availability, window/target
validation, executor coverage, recipe dependency planning, and 26.2 serialization.
Recipe and advanced interaction tests use simulated world state. Social tests
cover sender identity, duplication, contextual plans, cancellation during model
calls, player arbitration, persistent jobs/memory, ongoing retries, idle selection,
building progress, owned storage and wooden-door navigation.

Opt-in live checks: `node test/live-chat.js --run` and
`node test/live-social.js --run`. These join clearly named test players and send
ordinary chat requests to the configured server. Live chat verified: replies,
remembered preferences, jumping, following a named player, and stop. Simple stop
replies took 0.1–0.2 seconds; Luna replies took about 1.3–2.6 seconds in these checks.

Live verified on the configured 26.2 server through real OpenRouter Jev decisions:
three jumps with landing checks followed by six full rotations, and opening,
inspecting and closing a blast furnace; returning home; and the user-submitted
`hit ronis` command with a server damage event and no disconnect. The combat
check caught a missing coordinate in the aim vector; it is fixed and finite-angle
validation prevents malformed camera values from reaching movement packets.
A collection test attempted a nearby tree,
reported Pathfinder's unreachable route and executed exploration moves; it did
not obtain the log. A full live iron-armor run has not been completed.

## Existing software and version choice

Research and installation date: 2026-09-19.

- [PrismarineJS Mineflayer](https://github.com/PrismarineJS/mineflayer)
  is the established open-source bot library. Its current published version,
  4.39.0, lists supported versions through 26.1, so the standard npm release
  was not used for this 26.2 server.
- [Complexity-ML's Minecraft 26.2 distribution](https://github.com/Complexity-ML/mineflayer-26.2)
  supplies the existing native 26.2 compatibility work. Installed Mineflayer:
  `4.37.1+complexity.26.2.3`; protocol: `1.66.2+complexity.26.2.3`;
  data: `3.111.0+complexity.26.2.5`; chunk decoder: `1.40.0+complexity.26.2.0`;
  physics: `1.11.0+complexity.26.2.0`.
- Minecraft 26.2 uses protocol `776`, data version `4903`. The live server
  and installed data both match these values.
- Dependencies are pinned to release assets, with npm overrides keeping the
  26.2 data/chunk/physics stack consistent across dependencies. The lockfile
  records resolved versions and integrity hashes. Do not replace this stack
  with the ordinary Mineflayer release without rechecking 26.2 support.
- [Mindcraft](https://github.com/mindcraft-bots/mindcraft) is an existing
  LLM-plus-Mineflayer project, but its current supported versions and chat-model
  interface do not match native 26.2 plus TypeSafe Jev. It is not installed.
  Its general separation of dialogue, memory and reusable Mineflayer skills
  informed the controller; existing Prismarine libraries still execute gameplay.
- [GPT-5.6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
  and [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
  describe the chat model and response contract. The exact Luna slug was verified
  in OpenRouter's live model catalog and with an actual request.
- [Mineflayer Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder),
  [CollectBlock](https://github.com/PrismarineJS/mineflayer-collectblock), and
  [Tool](https://github.com/PrismarineJS/mineflayer-tool) provide pathfinding,
  resource collection and tool selection. Crafting and furnaces use Mineflayer's
  existing APIs and Prismarine Recipe; the local code connects those to Jev.
- [TypeSafe's API](https://docs.typesafe.ai/api) and
  [function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling)
  describe typed choices. [OpenRouter's official Jev Lab](https://openrouter.ai/labs/jev/game)
  demonstrates the SDK decisions method used here.
- `protocol-fix.js` backports the outgoing 26.2 interaction packet correction
  from [zkonikishi/Mineflayer commit f9e7db4](https://github.com/zkonikishi/Mineflayer/commit/f9e7db4447afda7838f08aa13430ec768738c178).
  It updates in-memory protocol data on startup; the installed pinned package
  remains reproducible. Swing, placement and use-item IDs are regression-tested.
- `bamboo-collision.js` corrects the 26.2 registry's position-independent bamboo
  collision box. It follows `BambooStalkBlock.getCollisionShape`,
  `BlockBehaviour.Properties.offsetType` and `Mth.getSeed` from the official,
  SHA-1-verified 26.2 client jar used for the viewer assets. The fix was verified
  live: movement next to the bamboo stopped causing server position corrections.

To reproduce the installation:

```sh
npm ci --ignore-scripts --no-fund
npm rebuild canvas
npm run build:viewer
```

Rebuilding the viewer also needs Python 3.9+ and downloads the official 26.2
client jar once to extract textures/models, checking Mojang's published SHA-1.
The local compatibility source and provenance are in `vendor/viewer-compat`.

No forced dependency upgrade is applied to the version-sensitive 26.2 stack.
Use `npm audit` to inspect current inherited dependency findings before changing
versions.

## Live verification

On 2026-09-19, the client emitted login and spawn events, decoded 329 chunks,
received thousands of live packets, and reported 20 health and 20 food at
`(-24.5, 79, 7.5)` in the overworld. An independent server-list query showed
`ronis` and `Jev` online together. See the live status/log for the current
position and connection state. Jev was later teleported to the house around
`(-242, 122, -1178)`, where the live camera control was also verified.
