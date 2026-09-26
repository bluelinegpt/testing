import type { StorefrontTheme } from "../types.js";

/**
 * Clean Light — an all-light look: white chrome with dark text (the one theme
 * whose header is not dark), soft grey canvas, practical green accent, system
 * sans throughout, mid radius. Made for everyday General Products stores.
 */
export const cleanLightTheme: StorefrontTheme = {
  key: "clean-light",
  label: "Clean Light",
  tokens: {
    "--sf-accent-contrast": "#ffffff",
    "--sf-bg": "#f7f8f8",
    "--sf-chrome-bg": "#ffffff",
    "--sf-chrome-muted": "#188a52",
    "--sf-chrome-soft": "#eef2ef",
    "--sf-chrome-text": "#1c2620",
    "--sf-gold": "#188a52",
    "--sf-gold-soft": "#dcf0e4",
    "--sf-heading-font": '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
    "--sf-line": "#e2e6e3",
    "--sf-muted": "#5f6a63",
    "--sf-radius": "12px",
    "--sf-ribbon-bg": "#dcf0e4",
    "--sf-ribbon-text": "#155e3b",
    "--sf-surface": "#ffffff",
    "--sf-text": "#182019",
  },
};
