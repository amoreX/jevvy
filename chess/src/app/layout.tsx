import type { Metadata } from "next";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/400-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Opening — Chess model comparison",
  description:
    "Compare Jev and GPT-6 Astra against Stockfish 19, with live evaluation and saved game logs.",
  applicationName: "Opening",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
