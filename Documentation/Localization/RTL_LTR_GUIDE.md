# RTL and LTR Guide

## Direction Contract

- `en`: `lang="en"`, `dir="ltr"`.
- `ar`: `lang="ar"`, `dir="rtl"`.
- Direction is applied at the document root so native controls and assistive technology receive the same state.

## Layout Rules

- Use logical properties such as `margin-inline`, `padding-inline`, `inset-inline`, and `text-align: start`.
- Do not mirror brand marks, media controls, numeric values, or other direction-neutral content without a specific requirement.
- Icons that represent physical direction may need mirroring; familiar universal action icons usually do not.
- Keep mixed Arabic, English, identifiers, and numbers readable with isolated elements where needed.

## Verification

Test both directions at desktop and mobile widths. Check overflow, overlap, focus order, control visibility, text wrapping, and document `lang`/`dir` attributes.
