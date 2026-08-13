# Store app icons — development-safe placeholder

The icons in this directory (`icon-192.png`, `icon-512.png`, `../apple-touch-icon.png`,
`../favicon.ico`) are a **development-safe placeholder**, generated
programmatically from the three approved Store tokens only
(`--store-navy #101936`, `--store-primary #4f63f6`, white) — no other colour
or typography is used.

**Final production Store/App icon artwork has not been designed and is
pending.** Do not treat these as brand-approved assets; they exist only so
the manifest/PWA installability foundation (Prompt 3D) is structurally
complete and testable.

## Maskable icon

No maskable icon is declared in `manifest.webmanifest`. A maskable icon
requires artwork deliberately designed with a safe interior zone (the OS may
crop up to the outer ~20% into a circle/squircle/rounded-square mask), and
`icon-512-maskable-source.png` in this directory is only an *unpadded*
starting point for a future designer — it must not be wired into the
manifest with `"purpose": "maskable"` until it has actually been checked
against a safe-zone template.
