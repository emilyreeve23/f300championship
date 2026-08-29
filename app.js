let splashHideTimer = null;
let splashHiddenAt = null;

function hideStartupSplash() {
  const splash = document.getElementById("startup-splash");
  if (!splash) {
    document.body.classList.remove("splash-active");
    return;
  }

  splash.classList.add("is-hiding");
  document.body.classList.remove("splash-active");
}

function showStartupSplash(duration = 1200) {
  const splash = document.getElementById("startup-splash");
  if (!splash) return;

  if (splashHideTimer) {
    window.clearTimeout(splashHideTimer);
  }

  splash.classList.remove("is-hiding");
  document.body.classList.add("splash-active");

  const reduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  splashHideTimer = window.setTimeout(
    hideStartupSplash,
    reduced ? 350 : duration
  );
}

function setupStartupSplash() {
  showStartupSplash(1450);
}

const data = window.F300_DATA;
const standings = data.standings || [];
const raceResults = data.raceResults || [];
const $ = (sel) => document.querySelector(sel);

let selectedRound = null;
localStorage.removeItem("f300-driver-filter");
let selectedDriver = "";
let calendarShowingAll = false;

function resetResultsFilter() {
  selectedDriver = "";
  localStorage.removeItem("f300-driver-filter");

  const select = document.getElementById("driver-filter");
  if (select) select.value = "";
}

function handleAppResume() {
  // A visibility change also happens when switching browser tabs.
  // Requiring a short background period prevents tiny interruptions
  // (such as system prompts) from replaying the startup screen.
  if (!splashHiddenAt || Date.now() - splashHiddenAt < 2000) return;

  splashHiddenAt = null;
  resetResultsFilter();
  navigateTo("standings");
  showStartupSplash(1050);
}

function suffix(n) {
  if (["N/A", "DNF", "DNS"].includes(String(n))) return String(n);
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  const mod100 = x % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${x}th`;
  return `${x}${x % 10 === 1 ? "st" : x % 10 === 2 ? "nd" : x % 10 === 3 ? "rd" : "th"}`;
}

function displayResult(value) {
  const n = Number(value);
  return Number.isFinite(n) && String(value).trim() !== "" ? suffix(n) : String(value || "—");
}

function validLap(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
}

function renderLeader(driver) {
  $("#leader-card").innerHTML = `
    <div class="leader-kicker">CHAMPIONSHIP LEADER</div>
    <div class="leader-main">
      <div><div class="leader-name">${escapeHtml(driver.driver)}</div><span class="leader-number">#${driver.number}</span></div>
      <div class="leader-points"><strong>${driver.points}</strong><span>POINTS</span></div>
    </div>
    <div class="leader-stats">
      <div><strong>${driver.rounds}</strong><span>Rounds</span></div>
      <div><strong>${driver.podiums}</strong><span>Podiums</span></div>
      <div><strong>${suffix(driver.bestFinal)}</strong><span>Best final</span></div>
    </div>`;
  $("#leader-card").onclick = () => openDriver(driver);
}

function renderStandings() {
  $("#updated-label").textContent = `Data last updated: ${data.updated}`;
  if (!standings.length) return;
  renderLeader(standings[0]);
  $("#standings-list").innerHTML = standings.slice(1).map(d => `
    <button class="driver-card ${d.position === 2 ? "p2" : d.position === 3 ? "p3" : ""}" data-pos="${d.position}">
      <span class="pos">${d.position}</span>
      <span class="driver-copy"><span class="driver-name">${escapeHtml(d.driver)}</span><span class="driver-meta">#${d.number} · ${d.rounds} round${d.rounds === 1 ? "" : "s"} · ${d.podiums} podium${d.podiums === 1 ? "" : "s"}</span></span>
      <span class="pts">${d.points}<small>PTS</small></span>
    </button>`).join("");
  document.querySelectorAll(".driver-card").forEach(card => card.addEventListener("click", () => openDriver(standings.find(d => d.position === Number(card.dataset.pos)))));
}

function calendarSort(events) {
  const upcoming = events.filter(e => e.status === "Upcoming").sort((a,b) => a.dateKey.localeCompare(b.dateKey));
  const others = events.filter(e => e.status !== "Upcoming").sort((a,b) => b.dateKey.localeCompare(a.dateKey));
  return [...upcoming, ...others];
}

function renderCalendar() {
  const all = calendarSort(data.calendar || []);
  const upcoming = all.filter(e => e.status === "Upcoming");
  const events = calendarShowingAll ? all : upcoming;

  $("#calendar-mode-title").textContent = calendarShowingAll ? "Full season" : "Upcoming races";
  $("#calendar-mode-subtitle").textContent = calendarShowingAll ? "Upcoming first, then previous/cancelled events" : "Next championship dates";
  $("#calendar-toggle").textContent = calendarShowingAll ? "Upcoming only" : "Show all races";

  if (!events.length) {
    $("#calendar-list").innerHTML = `<div class="empty-state"><strong>No upcoming races</strong><span>Use “Show all races” to view the full season.</span></div>`;
    return;
  }

  $("#calendar-list").innerHTML = events.map(event => {
    const status = event.status.toLowerCase();
    return `<div class="calendar-card ${status}">
      <div class="round-badge ${status === "cancelled" ? "cancelled" : ""}">${event.round ?? "—"}</div>
      <div><div class="calendar-track">${escapeHtml(event.track)}</div><div class="calendar-date">${escapeHtml(event.date)}${event.round ? ` · Round ${event.round}` : ""}</div></div>
      <span class="status ${status}">${escapeHtml(event.status)}</span>
    </div>`;
  }).join("");
}

function getRounds() {
  const map = new Map();
  raceResults.forEach(r => { if (!map.has(r.round)) map.set(r.round, { round:r.round, track:r.track }); });
  return [...map.values()].sort((a,b) => a.round-b.round);
}

function fastestLapsForRound(rows) {
  const cols = ["h1Lap","h2Lap","h3Lap","finalLap","weekendBest"];
  return Object.fromEntries(cols.map(col => {
    const laps = rows.map(r => validLap(r[col])).filter(v => v !== null);
    return [col, laps.length ? Math.min(...laps) : null];
  }));
}

function lapMarkup(value, fastest) {
  const n = validLap(value);
  if (n === null) return `<span class="lap-time">${escapeHtml(value || "—")}</span>`;
  const isFastest = fastest !== null && Math.abs(n - fastest) < 0.000001;
  return `<span class="lap-time ${isFastest ? "fastest" : ""}">${n.toFixed(3)}</span>`;
}

function sessionCard(label, result, points, lap, fastest) {
  return `<div class="session-card">
    <div class="session-title">${label}</div>
    <div class="session-main"><span class="session-result">${displayResult(result)}</span><span class="session-points">${points} pts</span></div>
    <div class="lap-line"><span>Fastest lap</span>${lapMarkup(lap, fastest)}</div>
  </div>`;
}

function finalSortValue(value) {
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== "") return n;
  if (String(value).toUpperCase() === "DNF") return 1000;
  if (String(value).toUpperCase() === "DNS") return 1001;
  return 1002;
}

/*
  Small decorative circuit outlines for the Results header.
  These are stylised illustrations rather than official circuit maps.
*/
const TRACK_ART = {
  "lydd": {
    viewBox: "0 0 180 90",
    path: "M20 35 C18 18 34 10 54 13 C83 17 110 26 125 40 C137 52 144 61 158 56 C171 51 174 34 165 24 C154 12 137 13 124 17 C105 23 92 38 78 48 C62 60 45 66 31 58 C23 53 19 44 20 35 Z",
    start: [29, 56, 42, 62]
  },
  "whilton mill": {
    viewBox: "0 0 180 90",
    path: "M18 61 C30 75 53 74 64 60 C74 47 65 36 52 38 C39 40 36 55 46 61 C58 68 75 62 82 51 C91 37 80 22 91 14 C101 7 119 12 124 23 C130 37 119 47 110 55 C100 65 107 78 124 78 L151 78 C164 78 170 69 170 57 L170 33 C170 21 162 15 152 17 C142 19 139 30 143 38 C148 49 148 57 139 61 C127 67 117 57 112 47",
    start: [132, 73, 145, 81]
  },
  "wombwell": {
    viewBox: "0 0 180 90",
    path: "M19 62 C25 76 43 79 56 72 C67 66 68 54 60 48 C51 41 40 46 42 56 C44 66 58 67 67 61 C80 52 74 36 84 25 C94 14 111 12 122 20 C134 29 128 42 118 47 C108 52 104 64 114 72 C125 81 146 78 158 67 C172 54 171 36 162 24 C153 12 135 10 121 15",
    start: [150, 64, 162, 70]
  }
};

function normaliseTrackName(track) {
  return String(track || "").trim().toLowerCase();
}

function trackIllustration(track) {
  const key = normaliseTrackName(track);
  const art = TRACK_ART[key];

  if (!art) {
    return `<svg class="track-art" viewBox="0 0 180 90" role="img" aria-label="Stylised ${escapeHtml(track)} circuit illustration">
      <path class="track-art-shadow" d="M22 59 C35 75 57 75 69 63 C80 52 75 38 86 27 C99 14 120 13 137 22 C154 31 166 43 159 57 C152 70 132 76 116 69 C100 62 90 53 77 55 C62 57 49 67 37 66 C30 65 25 63 22 59 Z"></path>
      <path class="track-art-line" d="M22 59 C35 75 57 75 69 63 C80 52 75 38 86 27 C99 14 120 13 137 22 C154 31 166 43 159 57 C152 70 132 76 116 69 C100 62 90 53 77 55 C62 57 49 67 37 66 C30 65 25 63 22 59 Z"></path>
    </svg>`;
  }

  const [x1, y1, x2, y2] = art.start;
  return `<svg class="track-art" viewBox="${art.viewBox}" role="img" aria-label="Stylised ${escapeHtml(track)} circuit illustration">
    <path class="track-art-shadow" d="${art.path}"></path>
    <path class="track-art-line" d="${art.path}"></path>
    <line class="track-start-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>
  </svg>`;
}

function renderResults(round) {
  const allRoundRows = raceResults.filter(r => r.round === round);
  if (!allRoundRows.length) {
    $("#round-summary").innerHTML = "";
    $("#results-list").innerHTML = '<div class="empty-state"><strong>No results yet</strong><span>There are no saved results for this round.</span></div>';
    return;
  }

  const fastest = fastestLapsForRound(allRoundRows);
  const sortedAll = [...allRoundRows].sort((a,b) => finalSortValue(a.finalResult)-finalSortValue(b.finalResult));
  let rows = selectedDriver ? sortedAll.filter(r => r.driver === selectedDriver) : sortedAll;

  const visibleText = selectedDriver ? `${rows.length ? 1 : 0} selected driver` : `${rows.length} drivers`;
  const roundTrack = allRoundRows[0].track;
  $("#round-summary").innerHTML = `
    <div class="round-summary-copy">
      <strong>${escapeHtml(roundTrack)}</strong>
      <span>${visibleText} · ordered by Final result</span>
    </div>
    <div class="round-track-art">${trackIllustration(roundTrack)}</div>
    <div class="summary-round">ROUND ${round}</div>`;

  if (!rows.length) {
    $("#results-list").innerHTML = `<div class="empty-state"><strong>No result for ${escapeHtml(selectedDriver)}</strong><span>This driver did not record a result in Round ${round}. Choose another race or select All drivers.</span></div>`;
    return;
  }

  $("#results-list").innerHTML = rows.map(r => {
    const overallOrder = sortedAll.indexOf(r) + 1;
    const finalWinner = String(r.finalResult) === "1";
    const weekendFast = validLap(r.weekendBest) !== null && fastest.weekendBest !== null && Math.abs(validLap(r.weekendBest)-fastest.weekendBest) < .000001;
    return `<article class="result-card ${finalWinner ? "winner-card" : ""}">
      <div class="result-head">
        <div class="result-order">${overallOrder}</div>
        <div class="result-driver"><h3>${escapeHtml(r.driver)}</h3><div class="result-sub">${escapeHtml(r.track)} · Round ${r.round}</div></div>
        <div class="final-badge ${finalWinner ? "winner" : ""}"><strong>${displayResult(r.finalResult)}</strong>FINAL</div>
      </div>
      <div class="session-grid">
        ${sessionCard("Heat 1", r.h1Result, r.h1Points, r.h1Lap, fastest.h1Lap)}
        ${sessionCard("Heat 2", r.h2Result, r.h2Points, r.h2Lap, fastest.h2Lap)}
        ${sessionCard("Heat 3", r.h3Result, r.h3Points, r.h3Lap, fastest.h3Lap)}
        ${sessionCard("Final", r.finalResult, r.finalPoints, r.finalLap, fastest.finalLap)}
      </div>
      <div class="result-footer">
        <div class="result-total"><span>Weekend total</span><strong>${r.weekendTotal} pts</strong></div>
        <div class="weekend-best"><span>Weekend best</span><strong class="${weekendFast ? "fastest" : ""}">${validLap(r.weekendBest) !== null ? Number(r.weekendBest).toFixed(3) : escapeHtml(r.weekendBest || "—")}</strong></div>
      </div>
      ${r.notes ? `<div class="result-notes">${escapeHtml(r.notes)}</div>` : ""}
    </article>`;
  }).join("");
}

function setupDriverFilter() {
  const select = $("#driver-filter");
  select.innerHTML = `<option value="">All drivers</option>` + standings.map(d => `<option value="${escapeHtml(d.driver)}">#${d.number} · ${escapeHtml(d.driver)}</option>`).join("");
  if (!standings.some(d => d.driver === selectedDriver)) selectedDriver = "";
  select.value = selectedDriver;
  select.addEventListener("change", () => {
    selectedDriver = select.value;
    if (selectedRound !== null) renderResults(selectedRound);
  });
}

function setupResults() {
  const rounds = getRounds();
  const tabs = $("#round-scroller");
  tabs.style.setProperty("--round-count", Math.max(rounds.length, 1));
  tabs.innerHTML = rounds.map(r => `<button class="round-chip" data-round="${r.round}" title="Round ${r.round} · ${escapeHtml(r.track)}" aria-label="Round ${r.round}, ${escapeHtml(r.track)}"><span>R${r.round}</span></button>`).join("");

  function choose(round) {
    selectedRound = round;
    document.querySelectorAll(".round-chip").forEach(b => b.classList.toggle("active", Number(b.dataset.round) === round));
    renderResults(round);
  }

  document.querySelectorAll(".round-chip").forEach(btn => btn.addEventListener("click", () => choose(Number(btn.dataset.round))));

  const initial = rounds.length ? rounds[rounds.length - 1].round : null;
  if (initial !== null) choose(initial);
}

function navigateTo(target) {
  document.querySelectorAll(".nav-button").forEach(b => b.classList.toggle("active", b.dataset.target === target));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.dataset.view === target));
  window.scrollTo({ top:0, behavior:"smooth" });
}

function showDriverResults(driverName) {
  selectedDriver = driverName;
  $("#driver-filter").value = driverName;
  const history = raceResults.filter(r => r.driver === driverName).sort((a,b) => b.round-a.round);
  if (history.length) {
    selectedRound = history[0].round;
    document.querySelectorAll(".round-chip").forEach(b => b.classList.toggle("active", Number(b.dataset.round) === selectedRound));
    renderResults(selectedRound);
  }
  $("#driver-dialog").close();
  navigateTo("results");
}

function openDriver(d) {
  if (!d) return;
  const history = raceResults.filter(r => r.driver === d.driver).sort((a,b) => b.round-a.round);
  const historyHtml = history.length ? `<h4 class="driver-history-title">Race history</h4><div class="driver-history">${history.map(r => `<div class="driver-history-row"><div><strong>Round ${r.round} · ${escapeHtml(r.track)}</strong><span>Final ${displayResult(r.finalResult)} · Best lap ${validLap(r.weekendBest) !== null ? Number(r.weekendBest).toFixed(3) : escapeHtml(r.weekendBest || "—")}</span></div><div class="driver-history-total"><b>${r.weekendTotal}</b><span>pts</span></div></div>`).join("")}</div>` : "";
  $("#driver-dialog-content").innerHTML = `<div class="driver-detail">
    <div class="number">DRIVER #${d.number} · P${d.position}</div><h3>${escapeHtml(d.driver)}</h3>
    <div class="big-points">${d.points}<span>POINTS</span></div>
    <div class="detail-grid">
      <div><strong>${d.rounds}</strong><span>Rounds</span></div><div><strong>${d.wins}</strong><span>Final wins</span></div>
      <div><strong>${d.podiums}</strong><span>Final podiums</span></div><div><strong>${suffix(d.bestFinal)}</strong><span>Best final</span></div>
    </div>
    ${history.length ? `<button class="primary-button driver-results-button" id="driver-results-button">View ${escapeHtml(d.driver.split(" ")[0])}'s race results</button>` : ""}
    ${historyHtml}</div>`;
  $("#driver-dialog").showModal();
  const button = $("#driver-results-button");
  if (button) button.addEventListener("click", () => showDriverResults(d.driver));
}

function setupNavigation() {
  document.querySelectorAll(".nav-button").forEach(btn => btn.addEventListener("click", () => navigateTo(btn.dataset.target)));
}

function setupLogoFallbacks() {
  document.querySelectorAll('img[src$="logo.png"]').forEach(img => {
    img.addEventListener("error", () => {
      img.style.display = "none";
      const fallback = img.parentElement?.querySelector(".brand-fallback");
      if (fallback) fallback.style.display = "grid";
    });
    img.addEventListener("load", () => {
      const fallback = img.parentElement?.querySelector(".brand-fallback");
      if (fallback) fallback.style.display = "none";
    });
  });
}


// v4.2 install-to-home-screen experience
let deferredInstallPrompt = null;

function isStandaloneApp() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /android/i.test(navigator.userAgent);
}

function updateInstallUI() {
  const button = $("#install-button");
  const copy = $("#install-copy");
  const status = $("#install-status");
  if (!button || !copy || !status) return;

  if (isStandaloneApp()) {
    button.textContent = "Installed ✓";
    button.disabled = true;
    copy.textContent = "F300 is already installed on this device and can be opened from your Home Screen.";
    status.textContent = "Installed as a web app";
    $("#install-nudge")?.setAttribute("hidden", "");
    return;
  }

  button.disabled = false;
  button.textContent = "Install F300 App";
  if (deferredInstallPrompt) {
    copy.textContent = "Tap Install and your phone will show its secure app-install confirmation.";
    status.textContent = "Ready to install";
  } else if (isIOSDevice()) {
    copy.textContent = "On iPhone or iPad, tap Install for the short Add to Home Screen guide.";
    status.textContent = "iPhone / iPad instructions available";
  } else if (isAndroidDevice()) {
    copy.textContent = "Tap Install. If your browser supports direct PWA installation, its native install prompt will open.";
    status.textContent = "Android install";
  } else {
    copy.textContent = "Tap Install for instructions for your browser or device.";
    status.textContent = "Installation help available";
  }
}

function openInstallInstructions() {
  const dialog = $("#install-dialog");
  const title = $("#install-dialog-title");
  const body = $("#install-dialog-body");
  if (!dialog || !title || !body) return;

  if (isIOSDevice()) {
    title.textContent = "Install F300 on iPhone / iPad";
    body.innerHTML = `<ol class="install-steps">
      <li><strong>Open the Share menu</strong><span>Tap the Share button in your browser.</span></li>
      <li><strong>Choose Add to Home Screen</strong><span>Scroll the Share menu if you do not see it immediately.</span></li>
      <li><strong>Keep Open as Web App enabled</strong><span>If that option is shown on your iPhone/iPad.</span></li>
      <li><strong>Tap Add</strong><span>The F300 icon will appear on your Home Screen.</span></li>
    </ol>`;
  } else if (isAndroidDevice()) {
    title.textContent = "Install F300 on Android";
    body.innerHTML = `<ol class="install-steps">
      <li><strong>Open your browser menu</strong><span>In Chrome, tap the three-dot menu.</span></li>
      <li><strong>Choose Install app</strong><span>It may also be labelled Add to Home screen.</span></li>
      <li><strong>Confirm Install</strong><span>F300 will then appear with your other apps.</span></li>
    </ol>`;
  } else {
    title.textContent = "Install F300";
    body.innerHTML = `<p class="install-help-text">Use your browser's <strong>Install app</strong>, <strong>Add to Home Screen</strong>, or equivalent menu option to save F300 as an app.</p>`;
  }

  if (typeof dialog.showModal === "function") dialog.showModal();
}

async function requestAppInstall() {
  if (isStandaloneApp()) {
    updateInstallUI();
    return;
  }

  if (deferredInstallPrompt) {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    if (choice?.outcome === "accepted") {
      localStorage.setItem("f300-install-nudge-dismissed", "1");
      $("#install-nudge")?.setAttribute("hidden", "");
    }
    updateInstallUI();
    return;
  }

  openInstallInstructions();
}

function maybeShowInstallNudge() {
  const nudge = $("#install-nudge");
  if (!nudge || isStandaloneApp() || localStorage.getItem("f300-install-nudge-dismissed")) return;
  window.setTimeout(() => {
    if (!isStandaloneApp()) nudge.removeAttribute("hidden");
  }, 2600);
}

function setupInstallExperience() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallUI();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    localStorage.setItem("f300-install-nudge-dismissed", "1");
    $("#install-nudge")?.setAttribute("hidden", "");
    updateInstallUI();
  });

  $("#install-button")?.addEventListener("click", requestAppInstall);
  $("#install-nudge-button")?.addEventListener("click", requestAppInstall);
  $("#install-nudge-close")?.addEventListener("click", () => {
    localStorage.setItem("f300-install-nudge-dismissed", "1");
    $("#install-nudge")?.setAttribute("hidden", "");
  });
  $("#install-dialog-close")?.addEventListener("click", () => $("#install-dialog")?.close());
  $("#install-dialog-done")?.addEventListener("click", () => $("#install-dialog")?.close());
  $("#install-dialog")?.addEventListener("click", event => {
    if (event.target === $("#install-dialog")) $("#install-dialog")?.close();
  });

  updateInstallUI();
  maybeShowInstallNudge();
}

$("#calendar-toggle").addEventListener("click", () => { calendarShowingAll = !calendarShowingAll; renderCalendar(); });
$("#dialog-close").addEventListener("click", () => $("#driver-dialog").close());
$("#driver-dialog").addEventListener("click", e => { if (e.target === $("#driver-dialog")) $("#driver-dialog").close(); });
$("#driver-count").textContent = standings.length;
$("#completed-count").textContent = getRounds().length;

setupStartupSplash();
setupLogoFallbacks();
setupInstallExperience();
renderStandings();
renderCalendar();
setupDriverFilter();
setupResults();
setupNavigation();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    splashHiddenAt = Date.now();
    return;
  }

  handleAppResume();
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
