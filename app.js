function setupStartupSplash() {
  const splash = document.getElementById("startup-splash");
  if (!splash) {
    document.body.classList.remove("splash-active");
    return;
  }
  const hide = () => {
    splash.classList.add("is-hiding");
    document.body.classList.remove("splash-active");
    window.setTimeout(() => splash.remove(), 380);
  };
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.setTimeout(hide, reduced ? 450 : 1450);
}

const data = window.F300_DATA;
const standings = data.standings || [];
const raceResults = data.raceResults || [];
const $ = (sel) => document.querySelector(sel);

let selectedRound = null;
let selectedDriver = localStorage.getItem("f300-driver-filter") || "";
let calendarShowingAll = false;

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
  $("#updated-label").textContent = `Updated ${data.updated}`;
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
  $("#round-summary").innerHTML = `<div><strong>${escapeHtml(allRoundRows[0].track)}</strong><span>${visibleText} · ordered by Final result</span></div><div class="summary-round">ROUND ${round}</div>`;

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
    if (selectedDriver) localStorage.setItem("f300-driver-filter", selectedDriver); else localStorage.removeItem("f300-driver-filter");
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
  localStorage.setItem("f300-driver-filter", driverName);
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

$("#calendar-toggle").addEventListener("click", () => { calendarShowingAll = !calendarShowingAll; renderCalendar(); });
$("#dialog-close").addEventListener("click", () => $("#driver-dialog").close());
$("#driver-dialog").addEventListener("click", e => { if (e.target === $("#driver-dialog")) $("#driver-dialog").close(); });
$("#driver-count").textContent = standings.length;
$("#completed-count").textContent = getRounds().length;

setupStartupSplash();
setupLogoFallbacks();
renderStandings();
renderCalendar();
setupDriverFilter();
setupResults();
setupNavigation();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
