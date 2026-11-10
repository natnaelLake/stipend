import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Warden — agent spending vault",
  description:
    "A policy-enforced spending vault for AI agents on NEAR. Live policy, approval queue and audit log.",
};

/**
 * Set the stored theme before first paint so a dark-mode viewer never sees a
 * white flash. Inline by necessity — it has to run before hydration.
 */
const THEME_BOOTSTRAP = `
try {
  var t = localStorage.getItem('warden-theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
