const data = window.F300_DATA;
const standings = data.standings;
const $ = (sel) => document.querySelector(sel);

function suffix(n) {
  if (n === "N/A") return "N/A";
  const x = Number(n);
  const mod100 = x % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${x}th`;
  return `${x}${x % 10 === 1 ? "st" : x % 10 === 2 ? "nd" : x % 10 === 3 ? "rd" : "th"}`;
}

function renderLeader(driver) {
  $("#leader-card").innerHTML = `
    <div class="leader-kicker">CHAMPIONSHIP LEADER</div>
    <div class="leader-main">
      <div>
        <div class="leader-name">${driver.driver}</div>
        <span class="leader-number">#${driver.number}</span>
      </div>
      <div class="leader-points"><strong>${driver.points}</strong><span>POINTS</span></div>
    </div>
    <div class="leader-stats">
      <div><strong>${driver.rounds}</strong><span>Rounds</span></div>
      <div><strong>${driver.podiums}</strong><span>Podiums</span></div>
      <div><strong>${suffix(driver.bestFinal)}</strong><span>Best final</span></div>
    </div>`;
  $("#leader-card").addEventListener("click", () => openDriver(driver));
}

function renderStandings() {
  $("#updated-label").textContent = `Updated ${data.updated}`;
  renderLeader(standings[0]);
  $("#standings-list").innerHTML = standings.slice(1).map(d => `
    <button class="driver-card ${d.position === 2 ? "p2" : d.position === 3 ? "p3" : ""}" data-pos="${d.position}">
      <span class="pos">${d.position}</span>
      <span><span class="driver-name">${d.driver}</span><span class="driver-meta">#${d.number} · ${d.rounds} round${d.rounds === 1 ? "" : "s"} · ${d.podiums} podium${d.podiums === 1 ? "" : "s"}</span></span>
      <span class="pts">${d.points}<small>PTS</small></span>
    </button>`).join("");

  document.querySelectorAll(".driver-card").forEach(card => {
    card.addEventListener("click", () => openDriver(standings.find(d => d.position === Number(card.dataset.pos))));
  });
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

function openDriver(d) {
  $("#driver-dialog-content").innerHTML = `
    <div class="driver-detail">
      <div class="number">DRIVER #${d.number} · P${d.position}</div>
      <h3>${d.driver}</h3>
      <div class="big-points">${d.points}<span>POINTS</span></div>
      <div class="detail-grid">
        <div><strong>${d.rounds}</strong><span>Rounds</span></div>
        <div><strong>${d.wins}</strong><span>Final wins</span></div>
        <div><strong>${d.podiums}</strong><span>Final podiums</span></div>
        <div><strong>${suffix(d.bestFinal)}</strong><span>Best final</span></div>
      </div>
    </div>`;
  $("#driver-dialog").showModal();
}

function setupNavigation() {
  document.querySelectorAll(".nav-button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      btn.classList.add("active");
      document.querySelector(`[data-view="${btn.dataset.target}"]`).classList.add("active");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

$("#dialog-close").addEventListener("click", () => $("#driver-dialog").close());
$("#driver-dialog").addEventListener("click", e => { if (e.target === $("#driver-dialog")) $("#driver-dialog").close(); });

renderStandings();
renderCalendar();
setupNavigation();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
