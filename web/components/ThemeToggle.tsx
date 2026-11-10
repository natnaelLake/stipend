"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("warden-theme");
    if (stored === "light" || stored === "dark") setTheme(stored);
    else setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("warden-theme", next);
    } catch {
      /* private mode */
    }
  };

  return (
    <button
      className="focusable rounded-md border px-2 py-1 text-xs"
      style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
      onClick={toggle}
      aria-label="Toggle colour theme"
    >
      {theme === "dark" ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
