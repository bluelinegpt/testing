import type { StorefrontTheme } from "../types.js";

/**
 * Luxury Minimal — the Prompt 1 look, now expressed as tokens: warm neutral
 * canvas, dark navy chrome, gold accent, serif display headings, generous
 * radius. The CSS defaults equal these values, so applying this theme is a
 * no-op by construction and the approved Fashion storefront cannot drift.
 */
export const luxuryMinimalTheme: StorefrontTheme = {
  key: "luxury-minimal",
  label: "Luxury Minimal",
  tokens: {
    "--sf-accent-contrast": "#221a0d",
    "--sf-bg": "#faf7f2",
    "--sf-chrome-bg": "#141f36",
    "--sf-chrome-muted": "#cbb98f",
    "--sf-chrome-soft": "#1e2c4a",
    "--sf-chrome-text": "#f6f1e7",
    "--sf-gold": "#b98a3c",
    "--sf-gold-soft": "#e9dcc3",
    "--sf-heading-font": 'Georgia, "Times New Roman", serif',
    "--sf-line": "#e7e0d5",
    "--sf-muted": "#6f675d",
    "--sf-radius": "14px",
    "--sf-ribbon-bg": "#e9dcc3",
    "--sf-ribbon-text": "#5c4718",
    "--sf-surface": "#ffffff",
    "--sf-text": "#241f1a",
  },
};
