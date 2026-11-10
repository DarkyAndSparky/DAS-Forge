# Brand assets

- `logo.svg` / `logo.png` / `logo.jpg` — light theme (default). SVG preferred.
- `logo-dark.svg` / `logo-dark.png` / `logo-dark.jpg` — dark theme variant.
  Falls back to the light logo automatically if this doesn't exist yet.

`logo.png` / `logo-dark.png` are the real **beta** artwork (0.1.10) — a
hexagonal anvil mark, replacing the earlier placeholder "DF" monogram
SVGs. Vector (`.svg`) versions of the same mark are expected later;
once dropped in, they'll be picked up automatically (`resolveVendorLogo()`
always prefers `.svg` over `.png`/`.jpg`), no code changes needed.

**Convention (fixed in 0.1.31):** `logo.*` is the variant shown on a LIGHT
page (dark mark), `logo-dark.*` is shown on a DARK page (light mark).
The beta PNGs had been saved the other way round - a black anvil on the
dark error page - so the two files were swapped.
