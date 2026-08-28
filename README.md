# F300 Championship Web App — v2

Mobile-first F300 Karting Championship PWA.

## What changed in v2
- Added a dedicated **Race Results** page
- Round selector for Lydd, Whilton Mill and Wombwell
- Every driver result shown as a phone-friendly card (no wide spreadsheet table)
- Heat 1, Heat 2, Heat 3 and Final shown in a 2×2 grid on phones
- Fastest lap in each session and the weekend best highlighted gold
- Driver popups now include race history
- Improved small-screen spacing/wrapping throughout the whole app
- Four-button bottom navigation: Standings / Results / Calendar / Info
- Added a text fallback if the logo image is unavailable
- Service-worker cache bumped to v2 so updates replace the old app assets

## Update the live GitHub Pages site
Upload/replace every file in the root of the `f300championship` repository with the files from this package, including the `icons` folder. Commit the changes to `main`. GitHub Pages will redeploy automatically.

Current data is still a snapshot of the Google Sheet as at 28 Aug 2026. The next step can be a live Google Sheets/Apps Script feed.
