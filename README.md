# F300 Championship Web App

Mobile-first F300 Karting Championship PWA.

## Publish with GitHub Pages

1. Upload every file and the `icons` folder in this package to the root of the `f300championship` repository.
2. Open **Settings → Pages** in GitHub.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select **main** and **/(root)**, then Save.
5. After GitHub finishes deploying, the app will be available at:
   `https://emilyreeve23.github.io/f300championship/`

## Version 1

- Mobile-first championship standings
- Driver detail popups
- Race calendar
- PWA manifest and service worker
- Home-screen icons
- Offline cache

The current championship data is stored in `data.js` as a snapshot. The next version can replace this with a live Google Sheets/Apps Script data feed without redesigning the app.
