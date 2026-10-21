/*
  Aflare configuration — the ONLY file you need to edit before deploying.

  ── Accounts that sync across devices (optional) ───────────────────────────
  By default Aflare stores accounts on the user's own device ("on-device
  account"). To get real cloud accounts + a database, create a free Firebase
  project and paste its web config below (README.md has click-by-click steps):

    firebase: {
      apiKey: "AIza...",
      authDomain: "your-project.firebaseapp.com",
      projectId: "your-project",
      storageBucket: "your-project.appspot.com",
      messagingSenderId: "1234567890",
      appId: "1:1234567890:web:abcdef"
    }

  Leave it as `null` to run in on-device mode.
*/

/*
  ── NASA FIRMS direct feed (optional) ──────────────────────────────────────
  Aflare already shows NASA FIRMS satellite hotspots (via Esri's public
  republish). To pull straight from NASA with your own free MAP_KEY, deploy
  nasa-proxy/worker.js (README there) and paste the Worker URL here:

    nasa: { proxyUrl: "https://aflare-nasa.YOURNAME.workers.dev" }

  Leave `proxyUrl` null to use the built-in source.
*/
window.AFLARE_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBMyVXVuuTPgUTbxpNLTsS7DCG4EqIZ5GY",
    authDomain: "aflare-43e80.firebaseapp.com",
    projectId: "aflare-43e80",
    storageBucket: "aflare-43e80.firebasestorage.app",
    messagingSenderId: "414827546267",
    appId: "1:414827546267:web:29dca14cbfa2c636a9283e"
  },
  nasa: { proxyUrl: "https://aflare-nasa.eshunburge.workers.dev" }
};
