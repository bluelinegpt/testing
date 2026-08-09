import type { StorefrontTheme } from "../types.js";

/**
 * Modern — cool near-white canvas, deep slate chrome, electric blue accent,
 * sans-serif headings, tighter radius. Reads technical and current: the
 * natural pairing for the Electronics template.
 */
export const modernTheme: StorefrontTheme = {
  key: "modern",
  label: "Modern",
  tokens: {
    "--sf-accent-contrast": "#ffffff",
    "--sf-bg": "#f4f6fa",
    "--sf-chrome-bg": "#0f172a",
    "--sf-chrome-muted": "#93b4e8",
    "--sf-chrome-soft": "#1c2740",
    "--sf-chrome-text": "#eef2f9",
    "--sf-gold": "#2563eb",
    "--sf-gold-soft": "#dbe7fb",
    "--sf-heading-font":
      '"Segoe UI Semibold", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    "--sf-line": "#dde3ee",
    "--sf-muted": "#5b6577",
    "--sf-radius": "10px",
    "--sf-ribbon-bg": "#dbe7fb",
    "--sf-ribbon-text": "#1e3a8a",
    "--sf-surface": "#ffffff",
    "--sf-text": "#111827",
  },
};
