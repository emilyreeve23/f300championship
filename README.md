# F300 Championship Web App

Mobile-first F300 Karting Championship PWA.

## Version 4.0 — 29 Aug 2026

- Compact all-round race selector
- Results ordered by Final finishing position
- Driver self-filter on Results
- Upcoming-first calendar with full-season toggle
- App update notes and 2026 rights notice in Info

Hosted from the repository root as a static Cloudflare/GitHub deployment.


## Version 4.2
- Added an F300 branded startup splash screen on app launch.
- Retains the v4 mobile race selector, driver filter, calendar behaviour and legal footer.


## v4.2
Added smart install-to-Home-Screen support: native Chromium/Android install prompt when available, iOS/iPadOS Add to Home Screen guidance, installed-state detection, and a one-time install suggestion.

## Version 4.3
- Added a Contact F300 mail link to `contact@f300championship.co.uk`.
- Replaced internal Google Sheet/snapshot wording with public-facing data and error-reporting guidance.
- Cache bumped to v4.3.


## Version 4.4
- Results driver filter no longer persists between app launches or refreshes.
- Added a Testing Mode notice to the Info page.
- Cache bumped to v4.4.


## Automatic championship data sync

Version 4.4 includes the GitHub Actions data-sync setup.

Required repository secret:

`F300_DATA_URL`

Set this to the Google Apps Script Web App URL ending in `/exec`.

Included files:

- `scripts/update-data.mjs` — downloads the latest public championship JSON feed and rebuilds `data.js`.
- `.github/workflows/update-championship-data.yml` — runs the updater once per day and can also be run manually from the GitHub Actions tab.

If `data.js` changes, the workflow commits the new data to `main`. The existing Cloudflare GitHub deployment can then publish the updated app automatically.
