import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TornPlayers — Easy Target Finder",
  description: "Match your Torn profile against the Hall of Fame + FFScouter to find easy, attackable targets.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-torn-bg text-slate-100 antialiased">{children}</body>
    </html>
  );
}
