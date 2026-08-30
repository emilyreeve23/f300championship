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
const driverProfiles = data.profiles || [];
const submissionWindow = data.submissionWindow || { open: false };
const apiUrl = data.apiUrl || "";
let hubAuth = { driver: "", authenticated: false, registered: null, resetAllowed: false, token: "" };
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
  // Keep the user's current screen during normal short app-switches.
  // After roughly five minutes in the background, treat the return as
  // a fresh session: show the logo, reset the Results filter and
  // return to Standings.
  const inactiveFor = splashHiddenAt ? Date.now() - splashHiddenAt : 0;

  if (!splashHiddenAt || inactiveFor < 300000) {
    splashHiddenAt = null;
    return;
  }

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


function driverInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join("") || "F3";
}

function profileForDriver(name) {
  const publicProfile = driverProfiles.find(p => p.driver === name) || null;
  const localPhoto = localStorage.getItem(`f300-profile-photo-${name}`) || "";
  if (localPhoto) return { ...(publicProfile || {}), driver: name, photoUrl: localPhoto };
  return publicProfile;
}

function avatarMarkup(name, extraClass = "") {
  const profile = profileForDriver(name);
  const photo = profile?.photoUrl;
  return `<span class="driver-avatar ${extraClass}">
    <span class="driver-avatar-fallback">${escapeHtml(driverInitials(name))}</span>
    ${photo ? `<img class="driver-avatar-img" src="${escapeHtml(photo)}" alt="${escapeHtml(name)} profile photo" loading="lazy">` : ""}
  </span>`;
}

function setupAvatarFallbacks(root = document) {
  root.querySelectorAll(".driver-avatar-img").forEach(img => {
    if (img.dataset.fallbackReady) return;
    img.dataset.fallbackReady = "1";
    img.addEventListener("error", () => img.remove());
  });
}

function hubStorageKey(driver) {
  return `f300-gearing-${String(driver || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function getLocalGearing(driver) {
  try {
    return JSON.parse(localStorage.getItem(hubStorageKey(driver)) || "[]");
  } catch {
    return [];
  }
}

function saveLocalGearing(driver, entry) {
  const history = getLocalGearing(driver).filter(item => item.round !== entry.round);
  history.unshift(entry);
  localStorage.setItem(hubStorageKey(driver), JSON.stringify(history.slice(0, 20)));
}

async function apiPost(payload) {
  if (!apiUrl) {
    throw new Error("My Profile is not connected yet.");
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Submission failed (${response.status}).`);
  }

  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Submission could not be saved.");
  return result;
}

function formatSubmissionWindow() {
  if (!submissionWindow.open) {
    return `<div class="hub-window closed"><strong>Gearing entry is closed</strong><span>It opens on race day and remains available for 7 days after the race weekend.</span></div>`;
  }

  return `<div class="hub-window open"><strong>Round ${submissionWindow.round} · ${escapeHtml(submissionWindow.track)}</strong><span>Gearing entry closes ${escapeHtml(submissionWindow.closes || "")}</span></div>`;
}

function renderLocalGearing(driver) {
  const target = $("#gearing-history");
  if (!target) return;

  if (!driver) {
    target.innerHTML = `<div class="hub-empty">Choose your driver above to see saved gearing.</div>`;
    return;
  }

  const history = getLocalGearing(driver);
  if (!history.length) {
    target.innerHTML = `<div class="hub-empty">No gearing saved on this device yet.</div>`;
    return;
  }

  target.innerHTML = history.map(item => `
    <div class="gearing-row">
      <div><strong>${escapeHtml(item.track || `Round ${item.round}`)}</strong><span>Round ${item.round}${item.notes ? ` · ${escapeHtml(item.notes)}` : ""}</span></div>
      <div class="gearing-value">${escapeHtml(item.front || "—")} / ${escapeHtml(item.rear || "—")}</div>
    </div>`).join("");
}

function renderHubProfile(driver) {
  const target = $("#hub-profile-preview");
  if (!target) return;

  if (!driver) {
    target.innerHTML = `<div class="hub-empty">Choose your name to open your profile.</div>`;
    return;
  }

  const standing = standings.find(d => d.driver === driver);
  const profile = profileForDriver(driver);

  target.innerHTML = `
    <div class="hub-profile-main">
      ${avatarMarkup(driver, "hub-avatar")}
      <div>
        <span class="eyebrow">DRIVER PROFILE</span>
        <h3>${escapeHtml(driver)}</h3>
        <p>#${standing?.number ?? profile?.number ?? "—"}${standing ? ` · P${standing.position} · ${standing.points} pts` : ""}</p>
      </div>
    </div>
    <div class="hub-profile-note">${profile?.photoUrl ? "Profile photo active." : "No profile photo uploaded yet."}</div>`;
  setupAvatarFallbacks(target);
}

function storedDriverSession() {
  return {
    driver: localStorage.getItem("f300-auth-driver") || "",
    token: localStorage.getItem("f300-auth-token") || ""
  };
}

function saveDriverSession(driver, token) {
  localStorage.setItem("f300-auth-driver", driver);
  localStorage.setItem("f300-auth-token", token);
}

function clearDriverSession() {
  localStorage.removeItem("f300-auth-driver");
  localStorage.removeItem("f300-auth-token");
}

function authTokenFor(driver) {
  return hubAuth.authenticated && hubAuth.driver === driver ? hubAuth.token : "";
}

function updateHubDriverPicker() {
  const select = $("#hub-driver-select");
  if (!select) return;

  let locked = $("#hub-driver-locked");
  if (!locked) {
    locked = document.createElement("div");
    locked.id = "hub-driver-locked";
    locked.className = "hub-driver-locked";
    select.insertAdjacentElement("afterend", locked);
  }

  const stored = storedDriverSession();
  const checkingStoredSession =
    !hubAuth.authenticated &&
    hubAuth.registered === null &&
    stored.driver &&
    stored.token &&
    stored.driver === select.value;

  const lockedDriver =
    hubAuth.authenticated
      ? hubAuth.driver
      : checkingStoredSession
        ? stored.driver
        : "";

  if (lockedDriver) {
    const standing = standings.find(d => d.driver === lockedDriver);

    if (standings.some(d => d.driver === lockedDriver)) {
      select.value = lockedDriver;
    }

    select.hidden = true;
    locked.hidden = false;
    locked.innerHTML = hubAuth.authenticated
      ? `
        <span>
          <span class="eyebrow">SIGNED IN AS</span>
          <strong>${standing ? `#${standing.number} · ` : ""}${escapeHtml(lockedDriver)}</strong>
        </span>
        <button id="hub-signout-inline" class="secondary-button compact-button" type="button">Sign out</button>`
      : `
        <span>
          <span class="eyebrow">CHECKING PROFILE</span>
          <strong>${standing ? `#${standing.number} · ` : ""}${escapeHtml(lockedDriver)}</strong>
        </span>`;

    $("#hub-signout-inline")?.addEventListener("click", () => {
      clearDriverSession();
      hubAuth = {
        driver: lockedDriver,
        authenticated: false,
        registered: true,
        resetAllowed: false,
        token: ""
      };
      updateHubDriverPicker();
      renderHubAuth();
    });

    return;
  }

  select.hidden = false;
  locked.hidden = true;
  locked.innerHTML = "";
}

function pinIsValid(pin) {
  return /^\d{4}$/.test(String(pin || ""));
}

function updateHubControls() {
  updateHubDriverPicker();

  const driver = $("#hub-driver-select")?.value || "";
  const unlocked = Boolean(driver && hubAuth.authenticated && hubAuth.driver === driver);

  const photoInput = $("#profile-photo-input");
  const photoButton = $("#photo-submit-button");
  if (photoInput) photoInput.disabled = !unlocked;
  if (photoButton) photoButton.disabled = !unlocked || !apiUrl;

  const form = $("#gearing-submission-form");
  if (form) {
    const enabled = Boolean(unlocked && submissionWindow.open && apiUrl);
    form.querySelectorAll("input,select,textarea,button").forEach(el => el.disabled = !enabled);
  }
}

function renderHubAuth() {
  const target = $("#hub-auth");
  const driver = $("#hub-driver-select")?.value || "";
  if (!target) return;

  target.hidden = false;

  if (!driver) {
    target.innerHTML = `<div class="hub-auth-message">Choose your driver above to continue.</div>`;
    updateHubControls();
    return;
  }

  if (!apiUrl) {
    target.innerHTML = `<div class="hub-auth-message">Profile access is temporarily unavailable.</div>`;
    updateHubControls();
    return;
  }

  if (hubAuth.authenticated && hubAuth.driver === driver) {
    target.innerHTML = "";
    target.hidden = true;
    updateHubControls();
    return;
  }

  if (hubAuth.registered === null) {
    target.innerHTML = `<div class="hub-auth-message">Checking profile access…</div>`;
    updateHubControls();
    return;
  }

  if (!hubAuth.registered || hubAuth.resetAllowed) {
    target.innerHTML = `
      <div class="hub-auth-box">
        <span class="eyebrow">${hubAuth.resetAllowed ? "RESET PIN" : "FIRST TIME SETUP"}</span>
        <h3>${hubAuth.resetAllowed ? "Choose a new PIN" : "Create your 4-digit PIN"}</h3>
        <p>${hubAuth.resetAllowed ? "F300 has enabled a one-time PIN reset for this profile." : "This driver has not set up a PIN yet. Create one now to claim your profile."}</p>
        <div class="pin-grid">
          <input id="hub-new-pin" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN">
          <input id="hub-confirm-pin" type="password" inputmode="numeric" maxlength="4" placeholder="Confirm PIN">
        </div>
        <button id="hub-register-button" class="primary-button" type="button">${hubAuth.resetAllowed ? "Reset PIN" : "Set up my profile"}</button>
        <div id="hub-auth-status" class="hub-status" aria-live="polite"></div>
      </div>`;

    $("#hub-register-button")?.addEventListener("click", async () => {
      const pin = $("#hub-new-pin")?.value || "";
      const confirm = $("#hub-confirm-pin")?.value || "";
      const status = $("#hub-auth-status");

      if (!pinIsValid(pin)) {
        status.textContent = "Please use exactly 4 numbers.";
        return;
      }
      if (pin !== confirm) {
        status.textContent = "The two PINs do not match.";
        return;
      }

      try {
        status.textContent = "Saving PIN…";
        const result = await apiPost({ action: "registerDriver", driver, pin });
        saveDriverSession(driver, result.token);
        hubAuth = { driver, authenticated: true, registered: true, resetAllowed: false, token: result.token };
        updateHubDriverPicker();
        renderHubAuth();
      } catch (error) {
        status.textContent = error.message || "PIN could not be saved.";
      }
    });

    updateHubControls();
    return;
  }

  target.innerHTML = `
    <div class="hub-auth-box">
      <span class="eyebrow">PROFILE LOCKED</span>
      <h3>Enter your PIN</h3>
      <p>Your driver profile has already been set up.</p>
      <input id="hub-login-pin" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN">
      <button id="hub-login-button" class="primary-button" type="button">Unlock my profile</button>
      <button id="hub-pin-help" class="text-button" type="button">Forgot PIN? Contact F300</button>
      <div id="hub-auth-status" class="hub-status" aria-live="polite"></div>
    </div>`;

  $("#hub-login-button")?.addEventListener("click", async () => {
    const pin = $("#hub-login-pin")?.value || "";
    const status = $("#hub-auth-status");

    if (!pinIsValid(pin)) {
      status.textContent = "Please enter your 4-digit PIN.";
      return;
    }

    try {
      status.textContent = "Checking PIN…";
      const result = await apiPost({ action: "loginDriver", driver, pin });
      saveDriverSession(driver, result.token);
      hubAuth = { driver, authenticated: true, registered: true, resetAllowed: false, token: result.token };
      renderHubAuth();
    } catch (error) {
      status.textContent = error.message || "PIN could not be verified.";
    }
  });

  $("#hub-pin-help")?.addEventListener("click", () => openContactDialog({ driver, topic: "PIN help" }));
  updateHubControls();
}

async function refreshDriverAuth(driver) {
  hubAuth = { driver, authenticated: false, registered: null, resetAllowed: false, token: "" };
  updateHubDriverPicker();
  renderHubAuth();

  if (!driver || !apiUrl) return;

  const stored = storedDriverSession();
  if (stored.driver === driver && stored.token) {
    try {
      const result = await apiPost({ action: "verifySession", driver, token: stored.token });
      if (result.authenticated) {
        hubAuth = { driver, authenticated: true, registered: true, resetAllowed: false, token: stored.token };
        updateHubDriverPicker();
        renderHubAuth();
        return;
      }
    } catch {}
    clearDriverSession();
    updateHubDriverPicker();
  }

  try {
    const result = await apiPost({ action: "driverStatus", driver });
    hubAuth = {
      driver,
      authenticated: false,
      registered: Boolean(result.registered),
      resetAllowed: Boolean(result.resetAllowed),
      token: ""
    };
  } catch {
    hubAuth = { driver, authenticated: false, registered: false, resetAllowed: false, token: "" };
  }

  updateHubDriverPicker();
  renderHubAuth();
}

function renderDriverHub() {
  const select = $("#hub-driver-select");
  if (!select) return;

  const storedSession = storedDriverSession();
  const savedDriver =
    (storedSession.driver && storedSession.token ? storedSession.driver : "") ||
    localStorage.getItem("f300-hub-driver") ||
    "";

  select.innerHTML = `<option value="">Choose your driver</option>` +
    standings.map(d => `<option value="${escapeHtml(d.driver)}">#${d.number} · ${escapeHtml(d.driver)}</option>`).join("");

  if (standings.some(d => d.driver === savedDriver)) select.value = savedDriver;

  const driver = select.value;
  renderHubProfile(driver);
  renderLocalGearing(driver);

  const windowTarget = $("#submission-window");
  if (windowTarget) windowTarget.innerHTML = formatSubmissionWindow();

  refreshDriverAuth(driver);
}

function setupDriverHub() {
  const hubSelect = $("#hub-driver-select");
  if (!hubSelect) return;

  hubSelect.addEventListener("change", () => {
    if (hubAuth.authenticated && hubAuth.driver) {
      hubSelect.value = hubAuth.driver;
      updateHubDriverPicker();
      return;
    }

    localStorage.setItem("f300-hub-driver", hubSelect.value);
    renderHubProfile(hubSelect.value);
    renderLocalGearing(hubSelect.value);
    refreshDriverAuth(hubSelect.value);
  });

  $("#profile-photo-input")?.addEventListener("change", event => {
    const file = event.target.files?.[0];
    const preview = $("#photo-preview");
    if (!file || !preview) return;

    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      preview.innerHTML = `<span>Please choose a JPG, PNG or WebP image.</span>`;
      event.target.value = "";
      return;
    }

    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Profile photo preview">`;
  });

  $("#photo-submit-button")?.addEventListener("click", async () => {
    const driver = hubSelect.value;
    const token = authTokenFor(driver);
    const file = $("#profile-photo-input")?.files?.[0];
    const status = $("#photo-status");

    if (!driver || !token) {
      status.textContent = "Unlock your profile first.";
      return;
    }
    if (!file) {
      status.textContent = "Choose a photo first.";
      return;
    }

    try {
      status.textContent = "Preparing photo…";
      const imageData = await compressProfilePhoto(file);
      status.textContent = "Updating profile photo…";

      const result = await apiPost({
        action: "profilePhoto",
        driver,
        token,
        imageData: imageData.data,
        mimeType: imageData.mimeType
      });

      if (result.photoUrl) localStorage.setItem(`f300-profile-photo-${driver}`, result.photoUrl);

      status.textContent = "Profile photo updated.";
      $("#profile-photo-input").value = "";
      $("#photo-preview").innerHTML = "";
      renderHubProfile(driver);
      renderStandings();
      renderResults(selectedRound);
    } catch (error) {
      status.textContent = error.message || "Photo could not be submitted.";
    }
  });

  $("#gearing-submission-form")?.addEventListener("submit", async event => {
    event.preventDefault();

    const form = event.currentTarget;
    const driver = hubSelect.value;
    const token = authTokenFor(driver);
    const status = $("#gearing-submit-status");

    if (!driver || !token || !submissionWindow.open) return;

    const values = Object.fromEntries(new FormData(form).entries());

    if (!values.frontSprocket && !values.rearSprocket && !String(values.gearingNotes || "").trim()) {
      status.textContent = "Add some gearing information before saving.";
      return;
    }

    try {
      status.textContent = "Saving gearing…";

      await apiPost({
        action: "gearingSubmission",
        driver,
        token,
        round: submissionWindow.round,
        track: submissionWindow.track,
        frontSprocket: values.frontSprocket,
        rearSprocket: values.rearSprocket,
        gearingNotes: values.gearingNotes || ""
      });

      saveLocalGearing(driver, {
        round: Number(submissionWindow.round),
        track: submissionWindow.track,
        front: values.frontSprocket,
        rear: values.rearSprocket,
        notes: values.gearingNotes || ""
      });

      status.textContent = "Gearing saved.";
      form.reset();
      renderLocalGearing(driver);
    } catch (error) {
      status.textContent = error.message || "Gearing could not be saved.";
    }
  });

  renderDriverHub();
}

function openContactDialog(options = {}) {
  const dialog = $("#contact-dialog");
  if (!dialog) return;

  const select = $("#contact-driver");
  select.innerHTML = `<option value="">Not driver-specific</option>` +
    standings.map(d => `<option value="${escapeHtml(d.driver)}">#${d.number} · ${escapeHtml(d.driver)}</option>`).join("");

  const preferred = options.driver || (hubAuth.authenticated ? hubAuth.driver : "") || $("#hub-driver-select")?.value || "";
  if (standings.some(d => d.driver === preferred)) select.value = preferred;

  if (options.topic) $("#contact-topic").value = options.topic;
  $("#contact-status").textContent = "";
  dialog.showModal();
}

function setupContactSupport() {
  $("#contact-open-button")?.addEventListener("click", () => openContactDialog());
  $("#contact-dialog-close")?.addEventListener("click", () => $("#contact-dialog")?.close());

  $("#contact-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const status = $("#contact-status");
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());

    if (!String(values.message || "").trim()) {
      status.textContent = "Please enter a message.";
      return;
    }

    try {
      status.textContent = "Sending…";
      const driver = values.driver || "";
      await apiPost({
        action: "contactSupport",
        driver,
        token: authTokenFor(driver),
        topic: values.topic,
        contact: values.contact,
        message: values.message
      });
      status.textContent = "Sent to F300.";
      event.currentTarget.reset();
      setTimeout(() => $("#contact-dialog")?.close(), 850);
    } catch (error) {
      status.textContent = error.message || "Message could not be sent.";
    }
  });
}

function compressProfilePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("The photo could not be read."));
    reader.onload = () => {
      const img = new Image();

      img.onerror = () => reject(new Error("The photo could not be processed."));
      img.onload = () => {
        const size = 512;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        const width = img.width * scale;
        const height = img.height * scale;
        const x = (size - width) / 2;
        const y = (size - height) / 2;

        ctx.fillStyle = "#07111f";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, x, y, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve({
          mimeType: "image/jpeg",
          data: dataUrl.split(",")[1]
        });
      };
      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

function renderLeader(driver) {
  $("#leader-card").innerHTML = `
    <div class="leader-kicker">CHAMPIONSHIP LEADER</div>
    <div class="leader-main">
      <div class="leader-identity">${avatarMarkup(driver.driver, "leader-avatar")}<div><div class="leader-name">${escapeHtml(driver.driver)}</div><span class="leader-number">#${driver.number}</span></div></div>
      <div class="leader-points"><strong>${driver.points}</strong><span>POINTS</span></div>
    </div>
    <div class="leader-stats">
      <div><strong>${driver.rounds}</strong><span>Rounds</span></div>
      <div><strong>${driver.podiums}</strong><span>Podiums</span></div>
      <div><strong>${suffix(driver.bestFinal)}</strong><span>Best final</span></div>
    </div>`;
  $("#leader-card").onclick = () => openDriver(driver);
  setupAvatarFallbacks($("#leader-card"));
}

function renderStandings() {
  $("#updated-label").textContent = `Data last updated: ${data.updated}`;
  if (!standings.length) return;
  renderLeader(standings[0]);
  $("#standings-list").innerHTML = standings.slice(1).map(d => `
    <button class="driver-card ${d.position === 2 ? "p2" : d.position === 3 ? "p3" : ""}" data-pos="${d.position}">
      <span class="pos">${d.position}</span>
      ${avatarMarkup(d.driver, "list-avatar")}
      <span class="driver-copy"><span class="driver-name">${escapeHtml(d.driver)}</span><span class="driver-meta">#${d.number} · ${d.rounds} round${d.rounds === 1 ? "" : "s"} · ${d.podiums} podium${d.podiums === 1 ? "" : "s"}</span></span>
      <span class="pts">${d.points}<small>PTS</small></span>
    </button>`).join("");
  document.querySelectorAll(".driver-card").forEach(card => card.addEventListener("click", () => openDriver(standings.find(d => d.position === Number(card.dataset.pos)))));
  setupAvatarFallbacks($("#standings-list"));
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
      <div class="calendar-copy">
        <div class="calendar-track">${escapeHtml(event.track)}</div>
        <div class="calendar-date">${escapeHtml(event.date)}${event.round ? ` · Round ${event.round}` : ""}</div>
      </div>
      <div class="calendar-track-art">${trackIllustration(event.track)}</div>
      <span class="status ${status}">${escapeHtml(event.status)}</span>
    </div>`;
  }).join("");
}

function getRounds() {
  const map = new Map();
  raceResults.forEach(r => { if (!map.has(r.round)) map.set(r.round, { round:r.round, track:r.track }); });
  return [...map.values()].sort((a,b) => a.round-b.round);
}

function calendarEventForRound(round) {
  return (data.calendar || []).find(event => Number(event.round) === Number(round)) || null;
}

function roundWeekendDate(round) {
  return calendarEventForRound(round)?.date || "";
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
  },
  "clay pigeon": {
    viewBox: "0 0 180 90",
    path: "M19 48 C22 31 38 20 55 22 C73 24 78 39 68 49 C58 60 42 57 39 46 C36 34 48 29 59 34 C73 40 81 58 96 65 C111 72 131 69 143 58 C155 47 151 34 141 29 C131 23 119 29 116 39 C113 49 122 58 134 59 C149 61 165 52 168 39",
    start: [27, 40, 39, 45]
  },
  "llandow": {
    viewBox: "0 0 180 90",
    path: "M18 60 C29 73 47 76 61 68 C76 59 73 45 63 39 C51 31 39 38 42 50 C45 61 60 62 72 55 C88 45 83 25 98 17 C111 10 129 14 136 25 C144 38 136 49 125 56 C113 64 115 75 130 77 C146 79 162 70 168 57 C173 46 168 34 158 30",
    start: [147, 69, 158, 62]
  },
  "fulbeck": {
    viewBox: "0 0 180 90",
    path: "M20 64 C31 75 49 75 58 65 C67 55 61 44 51 42 C40 40 34 50 39 59 C45 70 61 68 73 59 C87 49 85 35 96 25 C108 14 126 13 138 21 C151 29 154 43 146 54 C137 67 121 66 113 57 C105 48 110 36 122 33 C137 29 153 38 165 31",
    start: [26, 60, 38, 67]
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
  const weekendDate = roundWeekendDate(round);
  $("#round-summary").innerHTML = `
    <div class="round-summary-copy">
      <strong>${escapeHtml(roundTrack)}${weekendDate ? ` <span class="round-weekend-date">· ${escapeHtml(weekendDate)}</span>` : ""}</strong>
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
        ${avatarMarkup(r.driver, "result-avatar")}
        <div class="result-driver"><h3>${escapeHtml(r.driver)}</h3><div class="result-sub">${escapeHtml(r.track)}${weekendDate ? ` · ${escapeHtml(weekendDate)}` : ""} · Round ${r.round}</div></div>
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
  setupAvatarFallbacks($("#results-list"));
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
  tabs.innerHTML = rounds.map(r => `<button class="round-chip" data-round="${r.round}" title="Round ${r.round} · ${escapeHtml(r.track)}" aria-label="Round ${r.round}, ${escapeHtml(r.track)}"><span>Round ${r.round}</span></button>`).join("");

  function choose(round) {
    selectedRound = round;
    document.querySelectorAll(".round-chip").forEach(b => b.classList.toggle("active", Number(b.dataset.round) === round));
    renderResults(round);
  }

  document.querySelectorAll(".round-chip").forEach(btn => btn.addEventListener("click", () => choose(Number(btn.dataset.round))));

  const initial = rounds.length ? rounds[0].round : null;
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
    <div class="driver-profile-head driver-profile-head-large">${avatarMarkup(d.driver, "dialog-avatar dialog-avatar-large")}<div><div class="number">DRIVER #${d.number} · P${d.position}</div><h3>${escapeHtml(d.driver)}</h3></div></div>
    <div class="big-points">${d.points}<span>POINTS</span></div>
    <div class="detail-grid">
      <div><strong>${d.rounds}</strong><span>Rounds</span></div><div><strong>${d.wins}</strong><span>Final wins</span></div>
      <div><strong>${d.podiums}</strong><span>Final podiums</span></div><div><strong>${suffix(d.bestFinal)}</strong><span>Best final</span></div>
    </div>
    ${history.length ? `<button class="primary-button driver-results-button" id="driver-results-button">View ${escapeHtml(d.driver.split(" ")[0])}'s race results</button>` : ""}
    ${historyHtml}</div>`;
  $("#driver-dialog").showModal();
  setupAvatarFallbacks($("#driver-dialog-content"));
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
setupDriverHub();
setupContactSupport();
setupNavigation();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    splashHiddenAt = Date.now();
    return;
  }

  handleAppResume();
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
