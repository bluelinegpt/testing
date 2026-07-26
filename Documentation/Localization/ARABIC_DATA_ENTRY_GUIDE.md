# Arabic Data Entry Guide

- Store Arabic and English business names in separate approved fields; do not overwrite one language with the other.
- Preserve Unicode text exactly and avoid lossy transliteration.
- Trim surrounding whitespace while retaining meaningful internal spacing.
- Validate length and required-state rules server-side independent of display direction.
- Do not translate customer-entered names, addresses, notes, identifiers, or legal values automatically.
- Search normalization must be documented before it changes matching behavior.
- Business calculations, identifiers, audit meaning, and stored monetary values never change with language.
