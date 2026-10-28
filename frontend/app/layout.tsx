import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme";

// Applied before paint to avoid a flash of the wrong theme. Light is the
// default; only a stored "dark" choice overrides it.
const NO_FLASH = `(function(){try{var t=localStorage.getItem('aa-theme');document.documentElement.dataset.theme=(t==='dark'||t==='light')?t:'light';}catch(e){document.documentElement.dataset.theme='light';}})();`;

export const metadata: Metadata = {
  metadataBase: new URL("https://analyst.scottcampbell.io"),
  title: "Automotive Analyst: natural language SQL over manufacturing data",
  description:
    "Ask an automotive assembly warehouse questions in plain English. Text to SQL with read only guardrails: every query is validated before it runs and shown beside the answer.",
  applicationName: "Automotive Analyst",
  authors: [{ name: "Scott Campbell", url: "https://scottcampbell.io/" }],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Automotive Analyst",
    title: "Automotive Analyst: natural language SQL over manufacturing data",
    description: "Ask an automotive assembly warehouse questions in plain English. Text to SQL with read only guardrails: every query is validated before it runs and shown beside the answer.",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Automotive Analyst natural language SQL console" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Automotive Analyst: natural language SQL over manufacturing data",
    description: "Ask an automotive assembly warehouse questions in plain English. Text to SQL with read only guardrails: every query is validated before it runs and shown beside the answer.",
    images: ["/og-image.png"],
  },
};

// Structured data for search engines.
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "Automotive Analyst",
  "url": "https://analyst.scottcampbell.io/",
  "description": "Ask an automotive assembly warehouse questions in plain English. Text to SQL with read only guardrails: every query is validated before it runs and shown beside the answer.",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "Any (web browser)",
  "isAccessibleForFree": true,
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "author": {
    "@type": "Person",
    "name": "Scott Campbell",
    "url": "https://scottcampbell.io/"
  },
  "subjectOf": {
    "@type": "CreativeWork",
    "name": "Automotive Analyst case study",
    "url": "https://scottcampbell.io/projects/automotive-analyst/"
  },
  "sameAs": [
    "https://github.com/scottcampbelldata/automotive-analyst"
  ]
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <link rel="preload" href="/fonts/source-serif-4-text.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/libertinus-serif-display-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
