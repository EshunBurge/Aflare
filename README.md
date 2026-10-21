# Aflare — satellite fire alerts

Aflare shows fires near you using **NASA satellite heat detections**, **official US incident data** and
**National Weather Service alerts**, and notifies you when something shows up near a place you saved.
It is a Progressive Web App (PWA): one website that people can **install like a normal app** on iPhone,
Android, Windows, Mac and Chromebook — no app-store account needed.

**Aflare aims to make fire awareness faster.**

## What actually works

| Feature | Where the data comes from |
|---|---|
| **Home** for the place you pick: official warnings first (banner), then a "Near <place>" summary that keeps three sources apart — **official warnings** (NWS), **reported fires** (NIFC, not-yet-contained only) and **satellite heat** (NASA, unconfirmed) — within your radius, a mini-map with the radius drawn, the nearest items, then weather now, fire weather, hourly + 10-day forecast and condition tiles | NWS, NIFC WFIGS, NASA FIRMS, Open-Meteo |
| **Fire weather** (labelled "Aflare estimate") with the reason in plain words ("Dry air (12% humidity) · Wind 22 mph") and when it peaks | Open-Meteo forecast → Aflare's transparent formula (`fireWeatherScore`) |
| **Places**: add from Home, the places sheet, the map search or your device location; switch, rename, make home, remove; each place shows a status line; switching updates every screen and centres the map | Nominatim geocoding; saved in your account |
| **Alerts for every saved place** while Aflare is open (new detections, incidents, NWS warnings), each labelled by source; tapping one opens its detail | Same sources |
| **Map**: heat detections (24 h / 72 h), incidents (grouped when zoomed out; grey = fully contained), perimeters, street / satellite base map, search with "Save place", List view; filters remembered; 5-minute cache | NASA FIRMS via your Worker (Esri backup), NIFC |
| **Detail sheets**: incidents show size, containment, reported date, last update (flags stale ones), lead agency, ID; heat detections show time, satellite, intensity, confidence and whether an official incident is within 5 mi | NIFC, NASA |
| **Alerts & news**: official NWS warnings (severity, area, times, "What to do" text) kept apart from news headlines (labelled "not official") | NWS, GDELT |
| **Call & report**: call button first (911/112/999/000… by country), your address to tell the dispatcher (copy), saved contacts, text a report / "I'm safe", and official resources for your area (county alerts search, Genasys Protect, CAL FIRE in CA, InciWeb, 211, fire stations, AirNow) | Phone dialer, device location, Nominatim |
| **Learn**: grouped "Get ready" checklist (11 items, saved to your account, each with a "How to"), 7 articles, 8 videos, official links | Written for Aflare; credited photos |
| **Accounts**: sign up / log in / Google / reset / change password / verify email / photo / export / delete; honest sync status on Profile | Firebase (connected) with on-device fallback |

### What Aflare does **not** do (and says so in the app)
* It does **not** show evacuation orders — those come from counties/sheriffs. The app links you to them.
* Fire weather is **not** an official fire-danger rating and does not predict ignitions.
* There is **no alert server**. Checks run when Aflare is open (and about every 10 minutes while open). Installed in Chrome on
  Android, the browser *may* also run a background check every few hours; iPhone does not allow this. The Profile screen
  states which of these applies on the device.
* NWS warnings and NIFC incidents are **US only**; outside the US those rows say "not available" rather than "none".
* Air quality is a **model estimate** (CAMS), not a sensor reading.
* Headlines come from GDELT, which is slow (often ~15 s) and rate-limits hard. The app asks your Worker (`/news`), which shares one answer between visitors for 15 minutes; if GDELT is still busy the app says so and offers a "Search wildfire news on Google News" link instead. (Google News's feed itself is not used — its terms limit it to personal feed readers.)

### Mock data
The app itself contains **no mock or sample data** — everything shown comes from the live services above, or from the
copy saved the last time they answered (always marked with its time, and "Offline" when offline). Mock data is used
**only in the automated tests** (outside this folder), which intercept the network.

## Design & accessibility

* **One warm palette, two themes.** Aflare follows the phone's light / dark setting automatically. Colours are
  defined once as CSS variables at the top of `style.css` (`:root` for light, `@media (prefers-color-scheme: dark)` for dark).
* **WCAG 2.1 & 2.2 Level AA.** Every text colour pair is at least 4.5 : 1 (most are 6–16 : 1); outlines of inputs,
  switches and chips are at least 3 : 1. Body text is 16 px, nothing is smaller than 13 px, and every tap target is at
  least 24 × 24 px (most are 44–48 px).
* **Tested (v2.3):** axe-core 4.10 (WCAG 2.0/2.1/2.2 A + AA + best-practice) on 33 screens, dialogs and states
  (incl. onboarding and offline) in light and dark, at 320, 390 and 768 px — 0 violations. A keyboard test pressed Tab
  630 times and added a place and ticked the checklist by keyboard: visible focus everywhere, nothing hidden under the bars,
  dialogs trap and return focus. 105 workflow tests, 10 failure-state tests and a click-every-control crawl (353 controls) pass.
* **Tap cues:** anything that opens more detail inside Aflare ends in a chevron (›) — forecast days, condition tiles, "Near you" rows, articles, videos, alert history, the featured article and the little map on Home ("Open map ›"); anything that leaves Aflare (headlines, official links) ends in an arrow (↗). Rows tint when pressed. A dismissible one-time tip on Home explains this and disappears for good once dismissed or once any detail sheet has been opened. The cues are drawn in CSS (`.listcard::after`, `.tile::after`, … in `style.css`, "Tap cues"), so new list rows get them automatically.
* Real `<button>`s and `<label>`s everywhere, a "Skip to main content" link, live regions for status messages,
  `role="switch"` / `aria-checked` toggles, page titles per screen, alt text for photos, and reduced-motion support.
* **Maps:** OpenStreetMap street tiles, or Esri World Imagery with place labels (the Satellite button). The map's
  **List** button shows everything in view as a plain list, so you don't need to tap small markers.
* **Logos & colour:** `img/mark.png` (flat flame triangle) and `img/wordmark.png`, both in the logo red **#86231E**,
  which is also the app's main colour (buttons, active tabs, switches, alerts). In dark mode, red *text* uses a lighter
  shade of the same red (#E8897C) so it stays readable. App icons in `icons/` are the logo on black.

## Try it on your computer (30 seconds)

```bash
cd aflare-app
python3 -m http.server 8000      # then open http://localhost:8000
```
`localhost` counts as a secure site, so install + service worker + GPS all work. (Double-clicking `index.html`
also works for a quick look, but installing and offline mode need a web address.)

## Put it on the internet so anyone can install it

Pick ONE. All three give you a free `https://` address (HTTPS is required for installing, GPS and notifications).

**A. Netlify Drop (fastest, no account to try).** Go to <https://app.netlify.com/drop> and drag the whole
`aflare-app` folder onto the page. You get a live link immediately. Create a free account to keep it permanently.

**B. Firebase Hosting (best if you also use Firebase accounts).**
```bash
npm install -g firebase-tools
firebase login
firebase init hosting      # choose your project; "public directory" = .  ; do NOT overwrite index.html
firebase deploy
```
`firebase.json` is already included.

**C. GitHub Pages.** Put the folder contents in a repo → Settings → Pages → deploy from the `main` branch.

### How people install it
* **iPhone / iPad:** open the link in **Safari** → Share → **Add to Home Screen**. (Notifications on iOS only work
  after it is added to the Home Screen, iOS 16.4+.)
* **Android:** open in Chrome → **Install app** (or the Install button inside Aflare's Profile tab).
* **Windows / Mac / Chromebook:** Chrome or Edge → install icon in the address bar.

## Accounts (Firebase) — already connected
`config.js` points at the Firebase project **aflare-43e80**. Make sure these are done in the Firebase console:
1. **Authentication → Sign-in method:** enable **Email/Password** (and **Google** for the Google button).
2. **Firestore Database → Create database**, then paste `firestore.rules` into the **Rules** tab and publish.
3. **Authentication → Settings → Authorized domains:** add the address you deployed to (e.g. `your-site.netlify.app`).

Each user's profile, photo, locations, emergency contacts and settings are stored at `users/{their-uid}` and the
rules only let that user read or write it. If Firebase can't be reached the app falls back to on-device accounts.

## NASA data and headlines (Cloudflare Worker) — already connected
NASA's servers don't allow browsers to call them directly, so `nasa-proxy/worker.js` runs on Cloudflare
(free) at `https://aflare-nasa.eshunburge.workers.dev`, keeps your FIRMS `MAP_KEY` secret, and adds the
headers browsers need. `config.js → nasa.proxyUrl` tells the app to use it. If the Worker is ever down, the app
silently switches to the same NASA data republished by Esri.

The same Worker also has a `/news` route for the wildfire headlines (GDELT answers slowly and its error replies carry no
CORS headers, so browsers can't read them directly). **After updating the app to v2.3.1 or later, paste the new
`nasa-proxy/worker.js` into your Worker (Edit code → paste → Deploy)** — your `MAP_KEY` secret stays as it is. Until you do,
the app falls back to asking GDELT directly, which often fails.

## Project layout (read this to understand the code)
```
index.html            screens + markup (built from src/index.src.html)
style.css             all styling; mobile-first, phone-frame only on wide screens
app.js                all logic (built from src/app.part1.js + part2 + app.home.js + part3)
sw.js                 service worker: offline shell, tile cache, notifications, background check
manifest.webmanifest  install info (name, icons, shortcuts)
config.js             the one file you edit (Firebase config + NASA Worker URL)
nasa-proxy/worker.js  the Cloudflare Worker that relays NASA FIRMS data (/area) and wildfire headlines (/news)
lib/                  Leaflet (maps) and the Firebase SDK, bundled so the app works offline
img/, icons/          logo + app icons
firebase.json, firestore.rules   hosting + database security
```
`app.js` sections: 1 Helpers · 2 Storage · 3 Accounts · 4 Location · 5 Live data (the API calls) ·
6 Derived info & alerts (`situation()` — the one summary Home, alerts and the places sheet share — clustering,
fire-weather score, notifications) · 7 Learn content · then screens, map, Home (`app.home.js`), emergency tools,
PWA code and `boot()`.
After editing anything in `src/`, run `python3 build.py`.

## Credits & licenses
Leaflet (BSD-2) · Firebase JS SDK (Apache-2.0, optional) · © OpenStreetMap contributors (ODbL) and Nominatim ·
NASA FIRMS / LANCE (NASA open data; backup copy via Esri Living Atlas) · Esri World Imagery & place labels ·
Learn photos: USDA Forest Service, BLM, NPS, FEMA, NASA Earth Observatory (public domain) and Christopher Michel (CC BY 2.0), via Wikimedia Commons · NIFC WFIGS (public domain) · NOAA/NWS (public domain) ·
Open-Meteo (CC BY 4.0, non-commercial free tier) · GDELT Project · YouTube embeds belong to their publishers.
Please keep the attribution that the app shows in its Privacy, Data & About screen.
