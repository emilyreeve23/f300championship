# F300 Championship Web App — v3

Mobile-first F300 Karting Championship PWA for GitHub Pages.

## v3 changes
- Logo paths now point to image files in the repository **root** (`logo.png`, `icon-*.png`) so they match the current GitHub upload.
- Calendar defaults to **Upcoming races** with a **Show all races** button.
- Race Results are ordered by **Final result: winner to last**; DNF/DNS appear after classified finishers.
- Large mobile race selector with Previous/Next buttons, a dropdown, and horizontally scrollable round cards.
- Driver filter on Race Results. The selected driver is remembered on that phone.
- Driver profile popup includes a shortcut to that driver's race results.
- More mobile spacing/wrapping fixes throughout.

## Upload to GitHub
Upload/replace every file in this folder directly in the repository root and commit to `main`.
Do **not** create an `icons` folder for this version; the PNG files intentionally live in the root to match the existing repo.

GitHub Pages remains: `main` + `/(root)`.
