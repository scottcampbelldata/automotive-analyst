import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Automotive Analyst",
  description:
    "Natural-language analytics over an automotive assembly warehouse — text-to-SQL with read-only guardrails.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
