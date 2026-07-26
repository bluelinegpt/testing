# Localization Architecture

## Scope

The React application supports English (`en`) and Arabic (`ar`) from the foundation stage. The backend remains authoritative for calculations and returns stable error codes; clients localize presentation text.

## Resources

Translation catalogs live under `apps/web/src/localization/resources`. English is the fallback language. Components use translation keys through `react-i18next` and must not embed duplicate user-facing strings when a reusable key is appropriate.

## Locale State

The web device preference is stored under `blueline.locale`. Missing, inaccessible, or unsupported values fail to English. This browser preference is not tenant authority and does not replace a future server-side user preference.

## Direction

Locale changes set the document `lang` and `dir` attributes. English maps to `ltr`; Arabic maps to `rtl`. Layout uses logical CSS properties where direction matters.

## Formatting

`formatters.ts` centralizes UAE-time-zone date formatting, operational number formatting, and fixed-precision currency display. Currency inputs remain decimal strings and are never converted to JavaScript floating-point values.
