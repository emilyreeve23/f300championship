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

let data = window.F300_DATA || {};
let standings = data.standings || [];
let raceResults = data.raceResults || [];
let lapTimes = data.lapTimes || [];
let driverProfiles = data.profiles || [];
let submissionWindow = data.submissionWindow || { open: false };
let apiUrl = data.apiUrl || "";

const PUBLIC_DATA_REFRESH_MS = 15000;
let publicDataSignature = JSON.stringify(data);
let publicDataRefreshBusy = false;
let hubAuth = { driver: "", authenticated: false, registered: null, resetAllowed: false, token: "" };
let adminAuth = {
  authenticated: false,
  token: localStorage.getItem("f300-admin-token") || "",
  dashboard: null
};
let adminRefreshTimer = null;
const F300_THEME_KEY = "f300-theme";
const $ = (sel) => document.querySelector(sel);

let selectedRound = null;
localStorage.removeItem("f300-driver-filter");
let selectedDriver = "";
let selectedLapDriver = "";
let selectedLapRound = null;
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


function clearAdminSession() {
  localStorage.removeItem("f300-admin-token");
  adminAuth = { authenticated: false, token: "", dashboard: null };
  updateAdminBadges(0);
}

function updateAdminBadges(count, importMessage = "") {
  const total = Number(count) || 0;
  const openBadge = $("#admin-open-badge");
  const navBadge = $("#admin-nav-badge");

  [openBadge, navBadge].forEach(badge => {
    if (!badge) return;
    badge.textContent = String(total);
    badge.hidden = total <= 0;
  });

  const copy = $("#admin-open-copy");
  if (copy) {
    copy.textContent = adminAuth.authenticated
      ? (total ? `${total} new item${total === 1 ? "" : "s"} to review` : "No new admin items")
      : "Private championship tools";
  }

  const nudge = $("#admin-alert-nudge");
  if (nudge) {
    if (adminAuth.authenticated && total > 0) {
      $("#admin-alert-count").textContent = String(total);
      $("#admin-alert-copy").textContent =
        importMessage ||
        `${total} new admin item${total === 1 ? "" : "s"}`;
      nudge.hidden = false;
    } else {
      nudge.hidden = true;
    }
  }
}

function adminItemEmpty(message) {
  return `<div class="admin-empty">${escapeHtml(message)}</div>`;
}

function renderAdminDashboard() {
  const dashboard = adminAuth.dashboard || { support: [], timing: [], unreadCount: 0 };
  const support = dashboard.support || [];
  const timing = dashboard.timing || [];

  $("#admin-dashboard-summary").innerHTML = dashboard.unreadCount
    ? `<strong>${dashboard.unreadCount}</strong><span>new item${dashboard.unreadCount === 1 ? "" : "s"} need your attention</span>`
    : `<strong>✓</strong><span>Nothing new needs reviewing</span>`;

  $("#admin-support-count").textContent = `${support.length} new`;
  $("#admin-timing-count").textContent = `${timing.length} new`;

  $("#admin-support-list").innerHTML = support.length
    ? support.map(item => `
        <article class="admin-review-card">
          <div class="admin-review-card-head">
            <div>
              <span class="eyebrow">${escapeHtml(item.topic || "SUPPORT")}</span>
              <strong>${escapeHtml(item.driver || "General enquiry")}</strong>
            </div>
            <span>${escapeHtml(item.receivedAt || "")}</span>
          </div>
          ${item.contact ? `<div class="admin-review-meta">${escapeHtml(item.contact)}</div>` : ""}
          <p>${escapeHtml(item.message || "")}</p>
          <button class="secondary-button admin-seen-button" type="button" data-admin-kind="support" data-admin-row="${item.row}">Mark seen</button>
        </article>`).join("")
    : adminItemEmpty("No new support tickets.");

  $("#admin-timing-list").innerHTML = timing.length
    ? timing.map(item => {
        const isSummary = Boolean(item.isSummary);
        const title = isSummary
          ? `Round ${escapeHtml(item.round || "?")} import complete`
          : `Round ${escapeHtml(item.round || "?")} · ${escapeHtml(item.session || "Import check")}`;
        const eyebrow = isSummary ? "IMPORT COMPLETE" : escapeHtml(item.source || "TIMING");
        const buttonText = isSummary ? "Noted" : "Confirm / mark seen";

        return `
          <article class="admin-review-card ${isSummary ? "" : "admin-review-warning"}">
            <div class="admin-review-card-head">
              <div>
                <span class="eyebrow">${eyebrow}</span>
                <strong>${title}</strong>
              </div>
              <span>${escapeHtml(item.importedAt || "")}</span>
            </div>
            <div class="admin-review-meta">${escapeHtml(item.updated || "0")} updated · ${escapeHtml(item.skipped || "0")} blocked</div>
            <p>${escapeHtml(item.notes || "Timing import completed.")}</p>
            <button class="secondary-button admin-seen-button" type="button" data-admin-kind="timing" data-admin-row="${item.row}">${buttonText}</button>
          </article>`;
      }).join("")
    : adminItemEmpty("No new timing imports or issues.");

  document.querySelectorAll(".admin-seen-button").forEach(button => {
    button.onclick = async () => {
      const status = $("#admin-dashboard-status");
      button.disabled = true;

      try {
        status.textContent = "Updating…";

        await apiPost({
          action: "adminMarkSeen",
          token: adminAuth.token,
          kind: button.dataset.adminKind,
          row: Number(button.dataset.adminRow)
        });

        await refreshAdminDashboard();
        status.textContent = "Marked as seen.";
      } catch (error) {
        button.disabled = false;
        status.textContent = error.message || "Could not update this item.";
      }
    };
  });

  updateAdminBadges(dashboard.unreadCount || 0, dashboard.latestImportMessage || "");
}

async function refreshAdminDashboard() {
  if (!adminAuth.authenticated || !adminAuth.token || !apiUrl) return;

  try {
    const result = await apiPost({
      action: "adminDashboard",
      token: adminAuth.token
    });

    adminAuth.dashboard = result;
    renderAdminDashboard();
  } catch (error) {
    if (/expired|sign in/i.test(String(error.message || ""))) {
      clearAdminSession();
    }
  }
}

async function verifyStoredAdminSession() {
  if (!adminAuth.token || !apiUrl) {
    updateAdminBadges(0);
    return;
  }

  try {
    const result = await apiPost({
      action: "adminVerify",
      token: adminAuth.token
    });

    if (!result.authenticated) {
      clearAdminSession();
      return;
    }

    adminAuth.authenticated = true;
    await refreshAdminDashboard();
  } catch {
    clearAdminSession();
  }
}

function showAdminDialog() {
  const dialog = $("#admin-dialog");
  if (!dialog) return;

  const loggedIn = adminAuth.authenticated;

  $("#admin-login-panel").hidden = loggedIn;
  $("#admin-dashboard-panel").hidden = !loggedIn;
  $("#admin-login-status").textContent = "";
  $("#admin-dashboard-status").textContent = "";

  if (loggedIn) refreshAdminDashboard();

  dialog.showModal();
}

function setupAdminTools() {
  $("#admin-open-button")?.addEventListener("click", showAdminDialog);
  $("#admin-alert-open")?.addEventListener("click", showAdminDialog);
  $("#admin-alert-close")?.addEventListener("click", () => {
    $("#admin-alert-nudge").hidden = true;
  });
  $("#admin-dialog-close")?.addEventListener("click", () => $("#admin-dialog")?.close());

  $("#admin-login-form")?.addEventListener("submit", async event => {
    event.preventDefault();

    const status = $("#admin-login-status");
    const code = String($("#admin-code-input")?.value || "").trim();

    if (!/^\d{8}$/.test(code)) {
      status.textContent = "Enter the 8-digit admin code.";
      return;
    }

    try {
      status.textContent = "Signing in…";

      const result = await apiPost({
        action: "adminLogin",
        code
      });

      adminAuth = {
        authenticated: true,
        token: result.token,
        dashboard: null
      };

      localStorage.setItem("f300-admin-token", result.token);
      $("#admin-code-input").value = "";
      $("#admin-login-panel").hidden = true;
      $("#admin-dashboard-panel").hidden = false;

      await refreshAdminDashboard();
      status.textContent = "";
    } catch (error) {
      status.textContent = error.message || "Admin sign in failed.";
    }
  });

  $("#admin-signout-button")?.addEventListener("click", () => {
    clearAdminSession();
    $("#admin-dashboard-panel").hidden = true;
    $("#admin-login-panel").hidden = false;
    $("#admin-dashboard-status").textContent = "";
  });

  verifyStoredAdminSession();

  if (adminRefreshTimer) window.clearInterval(adminRefreshTimer);
  adminRefreshTimer = window.setInterval(() => {
    if (!document.hidden && adminAuth.authenticated) {
      refreshAdminDashboard();
    }
  }, 60000);
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


function lapSessionLabel(key) {
  return ({
    h1:"Heat 1",
    h2:"Heat 2",
    h3:"Heat 3",
    final:"Final"
  })[String(key || "").toLowerCase()] || String(key || "Session").toUpperCase();
}

function allDriverLapEntries(driverName) {
  return lapTimes.filter(item => item.driver === driverName);
}

function driverLifetimeBest(driverName) {
  const entries = allDriverLapEntries(driverName);
  let best = null;
  let context = null;

  entries.forEach(entry => {
    (entry.laps || []).forEach(lap => {
      const time = validLap(lap.time);
      if (time === null) return;

      if (best === null || time < best) {
        best = time;
        context = {
          round:entry.round,
          track:entry.track,
          sessionKey:entry.sessionKey
        };
      }
    });
  });

  return { best, context };
}

function renderLapTimesOverview() {
  const target = $("#lap-driver-list");
  if (!target) return;

  if (!lapTimes.length) {
    target.innerHTML = `
      <div class="lap-empty-card">
        <strong>No lap-by-lap data yet</strong>
        <span>Lap times will appear here after a supported race timing import.</span>
      </div>`;
    return;
  }

  target.innerHTML = standings.map(driver => {
    const lifetime = driverLifetimeBest(driver.driver);
    const best = lifetime.best;
    const context = lifetime.context;
    const hasData = allDriverLapEntries(driver.driver).length > 0;

    return `
      <button class="lap-driver-card" type="button" data-lap-driver="${escapeHtml(driver.driver)}" ${hasData ? "" : "disabled"}>
        <span class="lap-driver-rank">${driver.position}</span>
        ${avatarMarkup(driver.driver, "list-avatar")}
        <span class="lap-driver-copy">
          <strong>${escapeHtml(driver.driver)}</strong>
          <small>#${escapeHtml(driver.number)}${context ? ` · Best at ${escapeHtml(context.track)} R${context.round}` : " · No imported laps yet"}</small>
        </span>
        <span class="lap-driver-best">
          <b>${best === null ? "—" : best.toFixed(3)}</b>
          <small>BEST LAP</small>
        </span>
      </button>`;
  }).join("");

  target.querySelectorAll(".lap-driver-card:not([disabled])").forEach(button => {
    button.addEventListener("click", () => {
      selectedLapDriver = button.dataset.lapDriver || "";
      const rounds = Array.from(new Set(
        allDriverLapEntries(selectedLapDriver).map(item => Number(item.round))
      )).filter(Number.isFinite).sort((a,b) => a-b);

      selectedLapRound = rounds.length ? rounds[0] : null;
      renderLapDriverDetail();
    });
  });

  setupAvatarFallbacks(target);
}

function renderLapDriverDetail() {
  const overview = $("#lap-times-overview");
  const detail = $("#lap-driver-detail");
  if (!overview || !detail) return;

  if (!selectedLapDriver) {
    overview.hidden = false;
    detail.hidden = true;
    renderLapTimesOverview();
    return;
  }

  const standing = standings.find(item => item.driver === selectedLapDriver);
  const entries = allDriverLapEntries(selectedLapDriver);
  const availableRounds = Array.from(new Set(
    entries.map(item => Number(item.round))
  )).filter(Number.isFinite).sort((a,b) => a-b);
  const availableSet = new Set(availableRounds);

  const calendarRounds = Array.from(new Set(
    (data.calendar || [])
      .filter(item => String(item.status || "").toLowerCase() !== "cancelled")
      .map(item => Number(item.round))
      .filter(Number.isFinite)
  )).sort((a,b) => a-b);

  const rounds = Array.from(new Set([...calendarRounds, ...availableRounds]))
    .sort((a,b) => a-b);

  if (!availableRounds.length) {
    selectedLapDriver = "";
    renderLapDriverDetail();
    return;
  }

  if (!availableSet.has(Number(selectedLapRound))) {
    // Open on the newest round for which this driver actually has lap data.
    selectedLapRound = availableRounds[availableRounds.length - 1];
  }

  overview.hidden = true;
  detail.hidden = false;

  const lifetime = driverLifetimeBest(selectedLapDriver);

  $("#lap-driver-header").innerHTML = `
    <div class="lap-driver-profile">
      ${avatarMarkup(selectedLapDriver, "dialog-avatar lap-driver-avatar")}
      <div>
        <span class="eyebrow">DRIVER LAP HISTORY</span>
        <h3>${escapeHtml(selectedLapDriver)}</h3>
        <p>#${escapeHtml(standing?.number || entries[0]?.number || "—")} · Championship P${escapeHtml(standing?.position || "—")}</p>
      </div>
      <div class="lap-lifetime-best">
        <strong>${lifetime.best === null ? "—" : lifetime.best.toFixed(3)}</strong>
        <span>Best recorded lap</span>
      </div>
    </div>`;

  $("#lap-round-scroller").style.setProperty("--round-count", String(Math.max(1, rounds.length)));
  $("#lap-round-scroller").innerHTML = rounds
    .map(round => {
      const available = availableSet.has(Number(round));
      const active = available && Number(round) === Number(selectedLapRound);

      return `
        <button
          class="round-chip ${active ? "active" : ""} ${available ? "" : "lap-round-unavailable"}"
          type="button"
          data-lap-round="${round}"
          ${available ? "" : "disabled"}
          aria-disabled="${available ? "false" : "true"}"
          title="${available ? `View Round ${round} lap times` : `Round ${round} lap times are not available yet`}">
          <span>Round ${round}</span>
        </button>`;
    })
    .join("");

  $("#lap-round-scroller").querySelectorAll("[data-lap-round]:not([disabled])").forEach(button => {
    button.addEventListener("click", () => {
      selectedLapRound = Number(button.dataset.lapRound);
      renderLapDriverDetail();
    });
  });

  const roundEntries = entries
    .filter(item => Number(item.round) === Number(selectedLapRound))
    .sort((a,b) =>
      ["h1","h2","h3","final"].indexOf(a.sessionKey) -
      ["h1","h2","h3","final"].indexOf(b.sessionKey)
    );

  const event = calendarEventForRound(selectedLapRound);
  const track = roundEntries[0]?.track || event?.track || "";
  const weekendDate = event?.date || "";
  const totalLaps = roundEntries.reduce(
    (sum,item) => sum + (item.laps || []).length,
    0
  );
  const roundBest = roundEntries.reduce((best,item) => {
    const value = validLap(item.best);
    if (value === null) return best;
    return best === null || value < best ? value : best;
  }, null);

  $("#lap-round-summary").innerHTML = `
    <span><strong>Round ${selectedLapRound}</strong> · ${escapeHtml(track)}${weekendDate ? ` · ${escapeHtml(weekendDate)}` : ""}</span>
    <span>${totalLaps} recorded lap${totalLaps === 1 ? "" : "s"}${roundBest === null ? "" : ` · Best ${roundBest.toFixed(3)}`}</span>`;

  $("#lap-session-list").innerHTML = roundEntries.map(entry => {
    const laps = entry.laps || [];
    const best = validLap(entry.best);

    return `
      <details class="lap-session-card">
        <summary>
          <span>
            <strong>${lapSessionLabel(entry.sessionKey)}</strong>
            <small>${laps.length} lap${laps.length === 1 ? "" : "s"}</small>
          </span>
          <span class="lap-session-best">
            <b>${best === null ? "—" : best.toFixed(3)}</b>
            <small>BEST</small>
          </span>
        </summary>
        <div class="lap-table">
          ${laps.map(lap => {
            const time = validLap(lap.time);
            const isBest = best !== null && time !== null && Math.abs(time - best) < 0.0005;

            return `
              <div class="lap-row ${isBest ? "lap-row-best" : ""}">
                <span>Lap ${escapeHtml(lap.lap)}</span>
                <strong>${time === null ? "—" : time.toFixed(3)}</strong>
                <small>${lap.inPit ? "PIT" : ""}</small>
              </div>`;
          }).join("") || `<div class="lap-empty-inline">No lap times recorded.</div>`}
        </div>
      </details>`;
  }).join("") || `
    <div class="lap-empty-card">
      <strong>No lap data for this round</strong>
    </div>`;

  setupAvatarFallbacks($("#lap-driver-header"));
}

function renderLapTimes() {
  if (selectedLapDriver) {
    renderLapDriverDetail();
  } else {
    $("#lap-times-overview").hidden = false;
    $("#lap-driver-detail").hidden = true;
    renderLapTimesOverview();
  }
}

function setupLapTimes() {
  $("#lap-times-back")?.addEventListener("click", () => {
    selectedLapDriver = "";
    selectedLapRound = null;
    renderLapTimes();
  });

  renderLapTimes();
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

function currentRaceOrder(a, b) {
  const aPoints = Number(a.weekendTotal) || 0;
  const bPoints = Number(b.weekendTotal) || 0;

  if (bPoints !== aPoints) return bPoints - aPoints;

  // For equal points, use the latest completed session first,
  // then work backwards through the race day.
  const sessions = [
    ["finalPoints", "finalResult"],
    ["h3Points", "h3Result"],
    ["h2Points", "h2Result"],
    ["h1Points", "h1Result"]
  ];

  for (const [pointsKey, resultKey] of sessions) {
    const ap = Number(a[pointsKey]) || 0;
    const bp = Number(b[pointsKey]) || 0;

    if (bp !== ap) return bp - ap;

    const ar = finalSortValue(a[resultKey]);
    const br = finalSortValue(b[resultKey]);
    if (ar !== br) return ar - br;
  }

  return String(a.driver || "").localeCompare(String(b.driver || ""));
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
  const sortedAll = [...allRoundRows].sort(currentRaceOrder);
  let rows = selectedDriver ? sortedAll.filter(r => r.driver === selectedDriver) : sortedAll;

  const visibleText = selectedDriver ? `${rows.length ? 1 : 0} selected driver` : `${rows.length} drivers`;
  const roundTrack = allRoundRows[0].track;
  const weekendDate = roundWeekendDate(round);
  $("#round-summary").innerHTML = `
    <div class="round-summary-copy">
      <strong>${escapeHtml(roundTrack)}${weekendDate ? ` <span class="round-weekend-date">· ${escapeHtml(weekendDate)}</span>` : ""}</strong>
      <span>${visibleText} · ordered by current race points</span>
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
  select.onchange = () => {
    selectedDriver = select.value;
    if (selectedRound !== null) renderResults(selectedRound);
  };
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

  const currentStillExists = rounds.some(r => r.round === selectedRound);
  const initial = currentStillExists
    ? selectedRound
    : (rounds.length ? rounds[0].round : null);

  if (initial !== null) choose(initial);
}

function parsePublicDataScript(text) {
  const equalsAt = text.indexOf("=");
  if (equalsAt === -1) throw new Error("Invalid data.js response.");

  const jsonText = text
    .slice(equalsAt + 1)
    .trim()
    .replace(/;\s*$/, "");

  return JSON.parse(jsonText);
}

function applyFreshPublicData(nextData) {
  const activeHubDriver =
    (hubAuth.authenticated && hubAuth.driver) ||
    $("#hub-driver-select")?.value ||
    "";

  data = nextData || {};
  standings = data.standings || [];
  raceResults = data.raceResults || [];
  lapTimes = data.lapTimes || [];
  driverProfiles = data.profiles || [];
  submissionWindow = data.submissionWindow || { open: false };
  apiUrl = data.apiUrl || "";

  $("#driver-count").textContent = standings.length;
  $("#completed-count").textContent = getRounds().length;

  renderStandings();
  renderCalendar();
  renderLapTimes();
  setupDriverFilter();
  setupResults();

  // Refresh the current driver/profile display without changing login state.
  if (activeHubDriver) {
    const hubSelect = $("#hub-driver-select");

    if (hubSelect && standings.some(d => d.driver === activeHubDriver)) {
      hubSelect.innerHTML =
        `<option value="">Choose your driver</option>` +
        standings
          .map(d => `<option value="${escapeHtml(d.driver)}">#${d.number} · ${escapeHtml(d.driver)}</option>`)
          .join("");

      hubSelect.value = activeHubDriver;
      renderHubProfile(activeHubDriver);
      renderLocalGearing(activeHubDriver);
      updateHubDriverPicker();
      updateHubControls();
    }

    const windowTarget = $("#submission-window");
    if (windowTarget) windowTarget.innerHTML = formatSubmissionWindow();
  }
}

async function refreshPublicData() {
  if (publicDataRefreshBusy || !navigator.onLine) return;

  publicDataRefreshBusy = true;

  try {
    const url = new URL("./data.js", window.location.href);
    url.searchParams.set("fresh", String(Date.now()));

    const response = await fetch(url.href, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });

    if (!response.ok) return;

    const nextData = parsePublicDataScript(await response.text());
    const nextSignature = JSON.stringify(nextData);

    if (nextSignature === publicDataSignature) return;

    publicDataSignature = nextSignature;
    applyFreshPublicData(nextData);
    if (adminAuth.authenticated) refreshAdminDashboard();
  } catch (error) {
    // Stay quiet if offline or a deployment is between versions.
    console.debug("F300 data refresh skipped:", error);
  } finally {
    publicDataRefreshBusy = false;
  }
}

function startPublicDataRefresh() {
  window.setInterval(() => {
    if (!document.hidden) refreshPublicData();
  }, PUBLIC_DATA_REFRESH_MS);
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


function currentF300Theme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function updateThemeControl() {
  const theme = currentF300Theme();
  const icon = $("#theme-toggle-icon");
  const label = $("#theme-toggle-label");
  const button = $("#theme-toggle");

  if (icon) icon.textContent = theme === "dark" ? "☀️" : "🌙";
  if (label) label.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  if (button) {
    button.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", theme === "dark" ? "#05080d" : "#f7f9fb");
}

function applyF300Theme(theme, remember = true) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;

  if (remember) {
    try { localStorage.setItem(F300_THEME_KEY, next); } catch (_) {}
  }

  updateThemeControl();
}

function setupThemeToggle() {
  updateThemeControl();
  $("#theme-toggle")?.addEventListener("click", () => {
    applyF300Theme(currentF300Theme() === "dark" ? "light" : "dark");
  });
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

setupThemeToggle();
setupStartupSplash();
setupLogoFallbacks();
setupInstallExperience();
renderStandings();
renderCalendar();
setupDriverFilter();
setupResults();
setupLapTimes();
setupDriverHub();
setupContactSupport();
setupAdminTools();
setupNavigation();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    splashHiddenAt = Date.now();
    return;
  }

  handleAppResume();
  refreshPublicData();
  if (adminAuth.authenticated) refreshAdminDashboard();
});

window.addEventListener("online", () => refreshPublicData());

startPublicDataRefresh();

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
