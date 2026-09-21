# Viewer compatibility sources

The four JavaScript files here are copied without modification from
[mneuhaus/prismarine-viewer, commit 0060a2dd9cb0058a720a16139e1bd4a696ef09c0](https://github.com/mneuhaus/prismarine-viewer/tree/0060a2dd9cb0058a720a16139e1bd4a696ef09c0),
the implementation behind [Prismarine Viewer PR #480](https://github.com/PrismarineJS/prismarine-viewer/pull/480).
See `LICENSE` for the upstream MIT license.

These supply 26.x texture-reference parsing, correct section indexing and
world heights (including negative Y), and a browser build configuration.
`build-viewer.js` combines these with the npm Prismarine Viewer 1.33.0 release,
adds 26.2 to the renderer's supported-version list, and builds against the
same 26.2 data and chunk packages used by Jev. Vanilla block textures and models
come from Mojang's SHA-1-verified 26.2 client jar; no older-version block IDs
are substituted. Rendering and world streaming remain Prismarine Viewer code.

The browser viewer is a simplified rendering: lighting, weather, special block
entities, entity models/skins, animations and the in-game HUD are not guaranteed
to match the official graphical client. Entity rendering uses upstream's
bundled 1.16.4 models/textures. Live block state, terrain, position, health,
food and player list come from Jev's real connection.
