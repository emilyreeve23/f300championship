const data = window.F300_DATA;
const standings = data.standings || [];
const raceResults = data.raceResults || [];
const $ = (sel) => document.querySelector(sel);

function suffix(n) {
  if (n === "N/A" || n === "DNF" || n === "DNS") return String(n);
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

function renderLeader(driver) {
  $("#leader-card").innerHTML = `
    <div class="leader-kicker">CHAMPIONSHIP LEADER</div>
    <div class="leader-main">
      <div><div class="leader-name">${driver.driver}</div><span class="leader-number">#${driver.number}</span></div>
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
      <span class="driver-copy"><span class="driver-name">${d.driver}</span><span class="driver-meta">#${d.number} · ${d.rounds} round${d.rounds === 1 ? "" : "s"} · ${d.podiums} podium${d.podiums === 1 ? "" : "s"}</span></span>
      <span class="pts">${d.points}<small>PTS</small></span>
    </button>`).join("");
  document.querySelectorAll(".driver-card").forEach(card => card.addEventListener("click", () => openDriver(standings.find(d => d.position === Number(card.dataset.pos)))));
}

function renderCalendar() {
  $("#calendar-list").innerHTML = data.calendar.map(event => {
    const status = event.status.toLowerCase();
    return `<div class="calendar-card">
      <div class="round-badge ${status === "cancelled" ? "cancelled" : ""}">${event.round ?? "—"}</div>
      <div><div class="calendar-track">${event.track}</div><div class="calendar-date">${event.date}${event.round ? ` · Round ${event.round}` : ""}</div></div>
      <span class="status ${status}">${event.status}</span>
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
  if (n === null) return `<span class="lap-time">${value || "—"}</span>`;
  const isFastest = fastest !== null && Math.abs(n - fastest) < 0.000001;
  return `<span class="lap-time ${isFastest ? "fastest" : ""}">${Number(value).toFixed(3)}</span>`;
}

function sessionCard(label, result, points, lap, fastest) {
  return `<div class="session-card">
    <div class="session-title">${label}</div>
    <div class="session-main"><span class="session-result">${displayResult(result)}</span><span class="session-points">${points} pts</span></div>
    <div class="lap-line"><span>Fastest lap</span>${lapMarkup(lap, fastest)}</div>
  </div>`;
}

function renderResults(round) {
  const rows = raceResults.filter(r => r.round === round);
  if (!rows.length) { $("#results-list").innerHTML = '<div class="info-card">No results available for this round yet.</div>'; return; }
  const fastest = fastestLapsForRound(rows);
  $("#round-summary").innerHTML = `<div><strong>${rows[0].track}</strong><span>${rows.length} driver${rows.length === 1 ? "" : "s"} with results</span></div><div class="summary-round">ROUND ${round}</div>`;
  $("#results-list").innerHTML = rows.map(r => {
    const finalWinner = String(r.finalResult) === "1";
    const weekendFast = validLap(r.weekendBest) !== null && fastest.weekendBest !== null && Math.abs(validLap(r.weekendBest)-fastest.weekendBest) < .000001;
    return `<article class="result-card">
      <div class="result-head">
        <div class="result-driver"><h3>${r.driver}</h3><div class="result-sub">${r.track} · Round ${r.round}</div></div>
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
        <div class="weekend-best"><span>Weekend best</span><strong class="${weekendFast ? "fastest" : ""}">${validLap(r.weekendBest) !== null ? Number(r.weekendBest).toFixed(3) : (r.weekendBest || "—")}</strong></div>
      </div>
      ${r.notes ? `<div class="result-notes">${r.notes}</div>` : ""}
    </article>`;
  }).join("");
}

function setupResults() {
  const rounds = getRounds();
  $("#round-scroller").innerHTML = rounds.map(r => `<button class="round-chip" data-round="${r.round}">R${r.round} · ${r.track}</button>`).join("");
  const initial = rounds.length ? rounds[rounds.length - 1].round : null;
  function choose(round) {
    document.querySelectorAll(".round-chip").forEach(b => b.classList.toggle("active", Number(b.dataset.round) === round));
    renderResults(round);
  }
  document.querySelectorAll(".round-chip").forEach(btn => btn.addEventListener("click", () => choose(Number(btn.dataset.round))));
  if (initial !== null) choose(initial);
}

function openDriver(d) {
  if (!d) return;
  const history = raceResults.filter(r => r.driver === d.driver).sort((a,b) => b.round-a.round);
  const historyHtml = history.length ? `<h4 class="driver-history-title">Race history</h4><div class="driver-history">${history.map(r => `<div class="driver-history-row"><div><strong>Round ${r.round} · ${r.track}</strong><span>Final ${displayResult(r.finalResult)} · Best lap ${validLap(r.weekendBest) !== null ? Number(r.weekendBest).toFixed(3) : (r.weekendBest || "—")}</span></div><div class="driver-history-total"><b>${r.weekendTotal}</b><span>pts</span></div></div>`).join("")}</div>` : "";
  $("#driver-dialog-content").innerHTML = `<div class="driver-detail">
    <div class="number">DRIVER #${d.number} · P${d.position}</div><h3>${d.driver}</h3>
    <div class="big-points">${d.points}<span>POINTS</span></div>
    <div class="detail-grid">
      <div><strong>${d.rounds}</strong><span>Rounds</span></div><div><strong>${d.wins}</strong><span>Final wins</span></div>
      <div><strong>${d.podiums}</strong><span>Final podiums</span></div><div><strong>${suffix(d.bestFinal)}</strong><span>Best final</span></div>
    </div>${historyHtml}</div>`;
  $("#driver-dialog").showModal();
}

function setupNavigation() {
  document.querySelectorAll(".nav-button").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    btn.classList.add("active");
    document.querySelector(`[data-view="${btn.dataset.target}"]`).classList.add("active");
    window.scrollTo({ top:0, behavior:"smooth" });
  }));
}

$("#dialog-close").addEventListener("click", () => $("#driver-dialog").close());
$("#driver-dialog").addEventListener("click", e => { if (e.target === $("#driver-dialog")) $("#driver-dialog").close(); });
$("#driver-count").textContent = standings.length;
$("#completed-count").textContent = getRounds().length;
renderStandings(); renderCalendar(); setupResults(); setupNavigation();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
