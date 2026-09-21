# Third-party notices

## Native Stockfish

Stockfish is developed by the Stockfish developers and contributors and is licensed under GPL-3.0.

- Source and build instructions: https://github.com/official-stockfish/Stockfish
- Downloads: https://stockfishchess.org/download/
- License: https://github.com/official-stockfish/Stockfish/blob/master/Copying.txt

The Next.js server communicates over UCI with a separately installed, unmodified native executable. No Stockfish binary is included in this repository or sent to the browser. The development machine uses Homebrew's Stockfish 19 installation; other compatible native versions can be selected using `STOCKFISH_PATH`.

## Other packages

- chess.js — BSD-2-Clause: https://github.com/jhlywa/chess.js
- Next.js — MIT: https://github.com/vercel/next.js
- React — MIT: https://github.com/facebook/react
- Tailwind CSS — MIT: https://github.com/tailwindlabs/tailwindcss
- Lucide icons — ISC: https://github.com/lucide-icons/lucide
- DM Sans and Newsreader — SIL Open Font License 1.1, bundled through Fontsource; license files are included in their respective npm packages.

The chess piece SVGs in `src/components/chess-piece.tsx` are original artwork made for this project.
