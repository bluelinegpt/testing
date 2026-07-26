# Localization Test Plan

## Automated Foundation Tests

- English content renders by default.
- Arabic selection changes content and document direction.
- The selected locale is stored as a device preference.
- Date formatting differs appropriately by locale.
- Operational numbers group correctly.
- Currency formatting preserves decimal-string precision and rejects unsupported precision.

## Browser Matrix

For English and Arabic, test desktop and narrow mobile widths for horizontal overflow, overlapping content, visible controls, keyboard focus, translated wrapping, and correct root `lang`/`dir` attributes.

## Feature Requirements

Every future UI feature adds English and Arabic catalog entries and tests its important states in both directions. Backend validation tests assert stable codes; client tests assert localized presentation separately.
