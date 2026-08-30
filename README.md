# F300 Karting Championship 2026

Public, mobile-first web app for the **F300 Karting Championship 2026**.

**Current build: v1.1 — pre-launch/public-use build**

Live site: **f300championship.co.uk**

## What the app includes

### Championship standings

- Current championship order and points
- Driver numbers, rounds, Final wins and podiums
- Driver profile photos
- Driver detail view and race history

### Race results

- Separate results view for each completed round
- Full **Round 1 / Round 2 / Round 3** style race selector
- Track name and race-weekend date
- Heat 1, Heat 2, Heat 3 and Final results
- Session points and fastest laps
- Weekend total and weekend-best lap
- Fastest laps highlighted
- Driver filter
- Results ordered by Final finishing position
- Stylised track artwork for championship venues

### Race calendar

- Upcoming-races view
- Full-season view
- Complete, upcoming and cancelled events
- Race dates, round numbers and stylised circuit artwork

### My Profile

Drivers can select their championship profile and create a **4-digit PIN**.

Once authenticated:

- The app stays locked to that driver until they sign out
- The driver list is hidden while signed in
- Drivers can upload/update their profile photo
- Authenticated profile photos are applied without manual approval
- Race-weekend submissions can be sent during the active submission window
- Drivers can submit Heat/Final positions and fastest laps
- Front/rear sprocket settings and gearing notes can be recorded
- Local gearing history is retained on the driver's device

PIN hashes are kept in the Google Apps Script/Sheet backend and are **not included in the public GitHub `data.js` feed**.

### Contact F300

The app contains a small in-app **Contact F300** form for:

- General questions
- Bug reports
- Incorrect information
- PIN help

Requests are written to the championship admin Google Sheet rather than opening the user's email app.

### PWA / mobile support

- Installable web app
- Android/Chromium install prompt support
- iPhone/iPad Add to Home Screen guidance
- F300 branded startup splash
- Offline app shell and cached championship data
- Short app switches keep the current screen
- Longer inactive sessions return to Standings and refresh the app experience

## Data and backend

The championship Google Sheet is the administration/source-of-truth system.

Google Apps Script provides:

- Public standings
- Public race calendar
- Public race results
- Approved/current driver profile photos
- Current race submission-window information
- Driver PIN registration/login
- Authenticated profile-photo uploads
- Authenticated weekend submissions
- Contact/support submissions

Private authentication/contact/admin data is not intentionally returned in the public championship JSON feed.

## Automatic championship-data sync

GitHub Actions retrieves the public Google Apps Script feed and rebuilds `data.js`.

The workflow is stored at:

`/.github/workflows/update-championship-data.yml`

The updater is stored at:

`/scripts/update-data.mjs`

Repository secret required:

`F300_DATA_URL`

This should contain the deployed Google Apps Script Web App `/exec` URL.

### Current automatic schedule

The championship data check runs twice daily:

- **06:17 UTC**
- **18:17 UTC**

It can also be run manually from:

**GitHub → Actions → Update Championship Data → Run workflow**

When championship data changes, the workflow updates `data.js` and commits it to `main`. The Cloudflare deployment then publishes the new data.

## Hosting

The app is served as a static PWA through **Cloudflare Workers**, with GitHub `main` as the deployment source.

Production domain:

**f300championship.co.uk**

## Main repository files

- `index.html` — app structure
- `styles.css` — responsive/mobile styling
- `app.js` — app behaviour and UI
- `data.js` — automatically generated public championship data
- `sw.js` — service worker/offline cache
- `manifest.webmanifest` — PWA metadata
- `logo.png` / app icons — F300 branding
- `scripts/update-data.mjs` — public data updater
- `.github/workflows/update-championship-data.yml` — scheduled/manual sync

## Version

### v1.1

First public-use build of the F300 Championship PWA.

Current v1.1 work includes:

- Standings, Results and Calendar
- Driver profile photos
- My Profile driver PIN access
- Signed-in driver profile locking
- Profile-photo uploads
- Race-weekend driver submissions
- Gearing/setup notes
- In-app Contact F300 support form
- Offline/PWA installation support
- Automatic Google Sheet → GitHub → Cloudflare championship-data updates

---

© 2026 F300 Championship. All rights reserved.
