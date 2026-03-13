// ==UserScript==
// @name         BadmintonBot Production 3.0.0
// @namespace    http://tampermonkey.net/
// @version      3.0.1
// @description  Persistent booking automation with updated DYNAMIC mail polling
// @author       Samuel Blauer
// @match        https://reservation-cf.frontdeskqms.ca/*
// @match        https://reservation.frontdesksuite.ca/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      api.mail.tm
// ==/UserScript==

(function () {
  "use strict";

  // -----------------------
  // PAGE MAP
  // -----------------------
  const pages = {
    "con_main()": "/rcfs/nepeansportsplex/Home/Index",
    "con_group()": "/rcfs/nepeansportsplex/ReserveTime/SlotCountSelection",
    "con_timeselect()": "/rcfs/nepeansportsplex/ReserveTime/TimeSelection",
    "con_contact()": "/rcfs/nepeansportsplex/ReserveTime/ContactInfo",
    "con_verify": "/rcfs/nepeansportsplex/ReserveTime/ContactInfoValidation",
    "con_confirm()": "/rcfs/nepeansportsplex/ReserveTime/SummaryPage"
  };

  // -----------------------
  // CONFIG (only edit if you know what youre doing!)
  // -----------------------

    /** UI zoom factor for the injected panel. */
  const UI_SCALE = 0.8;

  const BOT_CONFIG = {
    defaultMode: "RUN_NOW",
    targetWeekday: 4, //thursday
    targetTime: { h: 17, m: 59, s: 59 },

    origin: "https://reservation-cf.frontdeskqms.ca",
    mainEntryUrl: "https://reservation.frontdesksuite.ca/rcfs/nepeansportsplex",
    mainPath: "/rcfs/nepeansportsplex/Home/Index",

    tickMs: 250,
    stepTimeoutMs: 330000,
    stepMaxRetries: 8,
    logMax: 250,

    sportName: "Badminton",
    day: "Saturday",
    timeSlot: "7:30 p.m.",

    phone: "6132929977",
    email: "maryottawa@virgilian.com",
    name: "Echo Macleod",

    // mail.tm
    mailAddress: "maryottawa@virgilian.com",
    mailPassword: "z80VLsh(",


    mailPollIntervalMs: 143, // ~7 req/s
    mailMaxWaitMs: 10000,

    // ── CONFIG SETTING ──────────────────────────────────────────────────────────
    // schedulePrewarmEnabled: When true, the bot navigates a few steps early
    // (T-8s) to gain a small head start before the scheduled time fires.
    // Keep this FALSE unless you explicitly want the pre-navigation behaviour.
    // ─────────────────────────────────────────────────────────────────────────
    schedulePrewarmEnabled: false
  };

  const STORAGE_KEYS = {
    running: "fdq_bot_running",
    mode: "fdq_bot_mode",
    stepDone: "fdq_bot_stepDone",
    logs: "fdq_bot_logs",
    waitingUntilIso: "fdq_bot_waitingUntilIso",
    sessionStartIso: "fdq_bot_sessionStartIso",
    lastError: "fdq_bot_lastError",
    successMessage: "fdq_success_message",
    uiLeft: "nb_uiLeft",
    uiTop: "nb_uiTop",

    sportName: "fdq_cfg_sportName",
    day: "fdq_cfg_day",
    timeSlot: "fdq_cfg_timeSlot",

    timeselectWaitStartMs: "fdq_timeselect_wait_start_ms",
    timeselectAttempts: "fdq_timeselect_attempts",

    // mail keys
    mailToken: "mailtm_token",
    mailboxInitReady: "fdq_mailbox_init_ready",

    targetWeekday: "fdq_cfg_targetWeekday",
    targetTime: "fdq_cfg_targetTime",
  };

  const BOT_STATE = {
    running: false,
    mode: BOT_CONFIG.defaultMode,
    timer: null,
    logs: [],
    stepDone: {},
    stepFails: {},
    waitingUntilIso: null,
    sessionStartIso: null,
    inStep: false,
    runToken: 0,
    lastRunSuccessful: false,
    successMessage: "",
    mailboxInitReady: false,
    verifyPolling: false,
    verifyPollTimer: null,
    tokenReadyForRun: false,
    tokenPrepInProgress: false,
    schedulePrewarmed: false

  };

  const BOT_UI = {
  root: null,
  status: null,
  actionBtn: null,
  modeSel: null,
  sportInput: null,
  dayInput: null,

  hourInput: null,
  minuteInput: null,
  ampmSel: null,

  scheduleBtn: null,
  schOverlay: null,
  schDay: null,
  schHour: null,
  schMinute: null,
  schAmPm: null,
  schApply: null,

  steps: {}
};

  // ==============================
  // PERSISTENCE LAYER
  // ==============================
  /**
   * Reads a persisted value by key and returns a fallback when unavailable.
   */
  function sGet(key, fallback) {
    try {
      const v = GM_getValue(key, fallback);
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  /**

   * Persists a value by key using Tampermonkey storage.

   */

  function sSet(key, value) {
    try { GM_setValue(key, value); } catch {}
  }

  /**

   * Deletes a persisted value by key from Tampermonkey storage.

   */

  function sDel(key) {
    try { GM_deleteValue(key); } catch {}
  }

  /**

   * Persists current bot runtime/config state used for reload recovery.

   */

  function saveState() {
    sSet(STORAGE_KEYS.running, BOT_STATE.running);
    sSet(STORAGE_KEYS.mode, BOT_STATE.mode);
    sSet(STORAGE_KEYS.stepDone, BOT_STATE.stepDone);
    sSet(STORAGE_KEYS.logs, BOT_STATE.logs.slice(0, BOT_CONFIG.logMax));
    sSet(STORAGE_KEYS.waitingUntilIso, BOT_STATE.waitingUntilIso);
    sSet(STORAGE_KEYS.sessionStartIso, BOT_STATE.sessionStartIso);
    sSet(STORAGE_KEYS.successMessage, BOT_STATE.successMessage);

    sSet(STORAGE_KEYS.sportName, BOT_CONFIG.sportName);
    sSet(STORAGE_KEYS.day, BOT_CONFIG.day);
    sSet(STORAGE_KEYS.timeSlot, BOT_CONFIG.timeSlot);
    sSet(STORAGE_KEYS.targetWeekday, BOT_CONFIG.targetWeekday);
    sSet(STORAGE_KEYS.targetTime, BOT_CONFIG.targetTime);

  }

/**

 * Loads persisted bot runtime/config state and normalizes legacy values.

 */

function loadState() {
  BOT_STATE.running = !!sGet(STORAGE_KEYS.running, false);

  let loadedMode = sGet(STORAGE_KEYS.mode, BOT_CONFIG.defaultMode);
  // normalize legacy values
  if (loadedMode === "LIVE") loadedMode = "SCHEDULE_RUN";
  if (loadedMode === "TEST") loadedMode = "RUN_NOW";
  if (loadedMode !== "RUN_NOW" && loadedMode !== "SCHEDULE_RUN") loadedMode = "RUN_NOW";
  BOT_STATE.mode = loadedMode;

  BOT_STATE.stepDone = sGet(STORAGE_KEYS.stepDone, {});
  BOT_STATE.logs = sGet(STORAGE_KEYS.logs, []);
  BOT_STATE.waitingUntilIso = sGet(STORAGE_KEYS.waitingUntilIso, null);
  BOT_STATE.sessionStartIso = sGet(STORAGE_KEYS.sessionStartIso, null);
  BOT_STATE.successMessage = sGet(STORAGE_KEYS.successMessage, "");
  BOT_STATE.mailboxInitReady = !!sGet(STORAGE_KEYS.mailboxInitReady, false);

  BOT_CONFIG.sportName = sGet(STORAGE_KEYS.sportName, BOT_CONFIG.sportName);
  BOT_CONFIG.day = sGet(STORAGE_KEYS.day, BOT_CONFIG.day);
  BOT_CONFIG.timeSlot = sGet(STORAGE_KEYS.timeSlot, BOT_CONFIG.timeSlot);
  const tw = Number(sGet(STORAGE_KEYS.targetWeekday, BOT_CONFIG.targetWeekday));
BOT_CONFIG.targetWeekday = Number.isInteger(tw) && tw >= 0 && tw <= 6 ? tw : 4;

const tt = sGet(STORAGE_KEYS.targetTime, BOT_CONFIG.targetTime);
const th = Number(tt?.h), tm = Number(tt?.m), ts = Number(tt?.s);
BOT_CONFIG.targetTime = {
  h: Number.isInteger(th) && th >= 0 && th <= 23 ? th : 18,
  m: Number.isInteger(tm) && tm >= 0 && tm <= 59 ? tm : 0,
  s: Number.isInteger(ts) && ts >= 0 && ts <= 59 ? ts : 0
};

}

  // ==============================
  // SHARED UTILITIES
  // ==============================
  /**
   * Writes a timestamped log line to memory, storage, and browser console.
   */
  function logLine(msg, ok = null) {
    const t = new Date().toLocaleTimeString();
    const prefix = ok === true ? "✅" : ok === false ? "❌" : "•";
    const line = `${prefix} [${t}] ${msg}`;
    BOT_STATE.logs.unshift(line);
    if (BOT_STATE.logs.length > BOT_CONFIG.logMax) BOT_STATE.logs = BOT_STATE.logs.slice(0, BOT_CONFIG.logMax);
    sSet(STORAGE_KEYS.logs, BOT_STATE.logs);
    console.log(`[BOT] ${line}`);
  }

  /**

   * Returns a promise that resolves after the provided delay in milliseconds.

   */

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
/**
 * Applies configured zoom scaling to the injected bot panel.
 */
function applyUIScale(scale = 1) {
  if (!BOT_UI.root) return;
  BOT_UI.root.style.transform = "";
  BOT_UI.root.style.transformOrigin = "";
  BOT_UI.root.style.zoom = String(scale);
}

  /**

   * Formats millisecond duration into human-readable h/m/s text.

   */

  function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes || hours) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  /**

   * Escapes HTML special characters for safe UI string interpolation.

   */

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  /**

   * Validates a time string in expected 12-hour format (e.g., 7:30 p.m.).

   */

  function validate12hTime(input) {
    return /^\s*(1[0-2]|[1-9]):[0-5]\d\s*(a\.m\.|p\.m\.)\s*$/i.test(String(input || ""));
  }

  /**

   * Parses a 12-hour time string into hour/minute/period parts.

   */

  function parseTimeSlot(input) {
  const m = String(input || "").trim().match(/^(1[0-2]|[1-9]):([0-5]\d)\s*(a\.m\.|p\.m\.)$/i);
  if (!m) return null;
  return { hour: String(Number(m[1])), minute: m[2], ampm: m[3].toLowerCase() };
}

/**

 * Builds a normalized 12-hour time string from UI inputs.

 */

function buildTimeSlotFromInputs() {
  const h = Number(BOT_UI.hourInput?.value);
  const m = Number(BOT_UI.minuteInput?.value);
  const ap = String(BOT_UI.ampmSel?.value || "").toLowerCase();

  if (!Number.isInteger(h) || h < 1 || h > 12) return null;
  if (!Number.isInteger(m) || m < 0 || m > 59) return null;
  if (ap !== "a.m." && ap !== "p.m.") return null;

  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

  /**

   * Updates action button state, style, and disabled behavior.

   */

  function updateActionButton(state = "start") {
    if (!BOT_UI.actionBtn) return;

    const disabledByInit = !BOT_STATE.mailboxInitReady && !BOT_STATE.running;
    BOT_UI.actionBtn.disabled = disabledByInit;

    if (disabledByInit) {
      BOT_UI.actionBtn.textContent = "Start";
      BOT_UI.actionBtn.style.background = "#7a7d84";
      BOT_UI.actionBtn.style.color = "#ddd";
      BOT_UI.actionBtn.style.cursor = "not-allowed";
      BOT_UI.actionBtn.dataset.state = "disabled";
      return;
    }

    BOT_UI.actionBtn.style.cursor = "pointer";

    if (state === "stop") {
      BOT_UI.actionBtn.textContent = "Stop";
      BOT_UI.actionBtn.style.background = "#d9534f";
      BOT_UI.actionBtn.style.color = "#fff";
      BOT_UI.actionBtn.dataset.state = "stop";
      return;
    }

    if (state === "retry") {
      BOT_UI.actionBtn.textContent = "Retry";
      BOT_UI.actionBtn.style.background = "#d9534f";
      BOT_UI.actionBtn.style.color = "#fff";
      BOT_UI.actionBtn.dataset.state = "retry";
      return;
    }

    BOT_UI.actionBtn.textContent = "Start";
    BOT_UI.actionBtn.style.background = "#93c963";
    BOT_UI.actionBtn.style.color = "#111";
    BOT_UI.actionBtn.dataset.state = "start";
  }

  /**

   * Updates status banner text and color based on status type.

   */

  function setStatus(text, type = "default") {
    if (!BOT_UI.status) return;
    BOT_UI.status.textContent = text;

    let color = "#f1f1f1";
    if (type === "stopped") color = "#ff6b6b";
    if (type === "waiting") color = "#f0ad4e";
    if (type === "success") color = "#7ed957";
    if (type === "error") color = "#ff6b6b";

    BOT_UI.status.style.color = color;
  }

  /**

   * Marks a process step as complete/incomplete in state and UI.

   */

  function markStep(name, ok) {
    BOT_STATE.stepDone[name] = ok;
    sSet(STORAGE_KEYS.stepDone, BOT_STATE.stepDone);
    _updateProgressBar();
  }

  /**

   * Renders completion state for all process step indicators.

   */

  function renderAllSteps() { _updateProgressBar(); }

  /**

   * Clears visual completion indicators for all process steps.

   */

  function resetVisualProcessSteps() {
    const fill = BOT_UI.root?.querySelector("#nb-prog-fill");
    const pct  = BOT_UI.root?.querySelector("#nb-prog-pct");
    if (fill) fill.style.width = "0%";
    if (pct)  pct.textContent = "Idle";
    BOT_UI.root?.querySelectorAll(".nb-prog-dot").forEach(d => d.classList.remove("done"));
  }

  /** Internal helper – redraws horizontal progress bar from BOT_STATE.stepDone */
  function _updateProgressBar() {
    if (!BOT_UI.root) return;
    const keys  = Object.keys(BOT_UI.steps);
    const total = keys.length;
    const done  = keys.filter(k => BOT_STATE.stepDone[k] === true).length;

    const fill = BOT_UI.root.querySelector("#nb-prog-fill");
    const pct  = BOT_UI.root.querySelector("#nb-prog-pct");
    if (fill) fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
    if (pct) {
      if (done === 0)     pct.textContent = "Idle";
      else if (done === total) pct.textContent = "Complete";
      else                pct.textContent = `${done} / ${total}`;
    }

    keys.forEach(k => {
      const dot = BOT_UI.root.querySelector(`.nb-prog-dot[data-step="${CSS.escape(k)}"]`);
      if (dot) dot.classList.toggle("done", BOT_STATE.stepDone[k] === true);
    });
  }

  /**

   * Resets stored and visual step progress for a new run.

   */

  function clearProcessProgress() {
    BOT_STATE.stepDone = {};
    BOT_STATE.stepFails = {};
    sSet(STORAGE_KEYS.stepDone, BOT_STATE.stepDone);
    sDel(STORAGE_KEYS.timeselectAttempts);
    resetVisualProcessSteps();
  }

  /**

   * Checks whether the main reservation landing page is fully loaded.

   */

  function isMainPageLoaded() {
    if (location.pathname !== BOT_CONFIG.mainPath) return false;
    const qs = new URLSearchParams(location.search);
    return qs.has("Culture") && qs.has("PageId") && qs.has("ButtonId");
  }

  /**

   * Navigates browser to configured reservation entry URL.

   */

  function goToMainEntry() {
    logLine("Going to main entry URL");
    saveState();
    location.href = BOT_CONFIG.mainEntryUrl;
  }

  /**

   * Maps current pathname to the corresponding step function key.

   */

  function getCurrentStepName() {
    const path = location.pathname;
    for (const [stepName, stepPath] of Object.entries(pages)) {
      if (stepPath === path) return stepName;
    }
    return null;
  }

  /**

   * Resolves a step key to its global function reference.

   */

  function getFnFromStep(stepName) {
    return window[stepName.replace(/\(\)$/, "")];
  }

  /**

   * Computes next scheduled run Date from configured weekday/time.

   */

  function getScheduledTargetDate() {
  const now = new Date();
  const target = new Date(now);

  const t = BOT_CONFIG.targetTime || { h: 18, m: 0, s: 0 };
  const h = Number(t.h) || 0;
  const m = Number(t.m) || 0;
  const s = Number(t.s) || 0;

  target.setHours(h, m, s, 0);

  const currentDay = now.getDay();
  const targetDay = Number(BOT_CONFIG.targetWeekday);
  const delta = (targetDay - currentDay + 7) % 7;
  target.setDate(now.getDate() + delta);
  if (delta === 0 && now > target) {
    target.setDate(target.getDate() + 7);
  }

  return target;
}

  /**

   * Stops automation, clears timers/pollers, updates status, and persists stop state.

   */

  function stopBot(reason = "Stopped", isError = false) {
    BOT_STATE.running = false;
    BOT_STATE.inStep = false;
    BOT_STATE.runToken += 1;
    BOT_STATE.tokenReadyForRun = false;
    BOT_STATE.tokenPrepInProgress = false;
    BOT_STATE.schedulePrewarmed = false;

    // Stop verification polling
    stopVerificationRetriever();

    if (BOT_STATE.timer) {
      clearInterval(BOT_STATE.timer);
      BOT_STATE.timer = null;
    }
    BOT_STATE.sessionStartIso = null;
    sDel(STORAGE_KEYS.sessionStartIso);
    BOT_STATE.waitingUntilIso = null;
    sSet(STORAGE_KEYS.running, false);
    sDel(STORAGE_KEYS.waitingUntilIso);
    sSet(STORAGE_KEYS.lastError, reason);

    resetVisualProcessSteps();

    if (isError) {
      BOT_STATE.successMessage = "";
      sDel(STORAGE_KEYS.successMessage);
      setStatus(`Error, program stop: ${reason}`, "error");
      updateActionButton("retry");
    } else {
      if (!BOT_STATE.lastRunSuccessful) setStatus("stopped", "stopped");
      updateActionButton("start");
    }

    logLine(reason, false);
  }
/**
 * Shows or hides schedule settings control based on selected run mode.
 */
function refreshModeUI() {
  const isSchedule = BOT_STATE.mode === "SCHEDULE_RUN";

  // Keep hidden select in sync
  if (BOT_UI.modeSel) BOT_UI.modeSel.value = BOT_STATE.mode;

  // Segmented control pill + labels
  const track = BOT_UI.root?.querySelector("#nb-seg-track");
  if (track) track.classList.toggle("right", isSchedule);
  BOT_UI.root?.querySelectorAll(".nb-seg-opt").forEach(opt => {
    opt.classList.toggle("active", opt.dataset.val === BOT_STATE.mode);
  });

  // Schedule info card visibility
  const card = BOT_UI.root?.querySelector("#nb-schedule-card");
  if (card) card.classList.toggle("visible", isSchedule);

  // Start live countdown if in schedule mode
  if (isSchedule) _startCountdown();
}

  // ==============================
  // NETWORK HELPERS \(GM_xmlhttpRequest\)
  // ==============================
  /**
   * Performs a GM_xmlhttpRequest and resolves with raw response object.
   */
  function gmRequest({ method = "GET", url, headers = {}, data = null, timeout = 15000 }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        timeout,
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error("GM request timeout"))
      });
    });
  }

  /**

   * Performs HTTP request and parses JSON response with error handling.

   */

  async function gmJson({ method, url, headers = {}, bodyObj = null }) {
    const finalHeaders = { ...headers };
    let data = null;

    if (bodyObj !== null) {
      finalHeaders["Content-Type"] = "application/json";
      data = JSON.stringify(bodyObj);
    }

    const res = await gmRequest({ method, url, headers: finalHeaders, data });

    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      const err = new Error(`HTTP ${res.status} ${url}`);
      err.status = res.status;
      err.responseText = res.responseText;
      throw err;
    }

    try {
      return JSON.parse(res.responseText || "{}");
    } catch {
      return {};
    }
  }

  // ==============================
  // MAIL.TM INTEGRATION
  // ==============================


  /**


   * Creates a mail.tm token and stores it for later API calls.


   */


  async function createAndStoreToken() {
    try {
      const res = await gmJson({
        method: "POST",
        url: "https://api.mail.tm/token",
        bodyObj: {
          address: BOT_CONFIG.mailAddress,
          password: BOT_CONFIG.mailPassword
        }
      });

      if (!res?.token) {
        logLine("Token creation failed", false);
        return false;
      }

      sSet(STORAGE_KEYS.mailToken, res.token);
      logLine("Token created and stored", true);
      return true;
    } catch (e) {
      logLine(`Token creation error: ${e?.message}`, false);
      return false;
    }
  }


  /**


   * Clears all mailbox messages and verifies the inbox is empty.


   */


  async function clearInbox() {
  try {
    let token = getToken();

    // 1) Try stored token first (if present)
    if (token) {
      try {
        const probe = await gmRequest({
          method: "GET",
          url: "https://api.mail.tm/messages",
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000
        });

        // Stored token invalid/expired -> discard it so we regenerate below
        if (!(probe.status >= 200 && probe.status < 300)) {
          token = "";
          sDel(STORAGE_KEYS.mailToken);
          logLine("Stored token invalid/expired, generating new token");
        } else {
          logLine("Using stored token for mailbox clear", true);
        }
      } catch {
        token = "";
        sDel(STORAGE_KEYS.mailToken);
        logLine("Stored token check failed, generating new token");
      }
    }

    // 2) No usable stored token -> generate new token
    if (!token) {
      const tokenRes = await gmJson({
        method: "POST",
        url: "https://api.mail.tm/token",
        bodyObj: {
          address: BOT_CONFIG.mailAddress,
          password: BOT_CONFIG.mailPassword
        }
      });

      if (!tokenRes?.token) {
        logLine("Clear inbox: token fetch failed", false);
        return false;
      }

      token = tokenRes.token;
      sSet(STORAGE_KEYS.mailToken, token);
      logLine("Generated and stored fresh token", true);
    }

    const H = { Authorization: `Bearer ${token}` };

    // 3) Get all message IDs
    const listRes = await gmJson({
      method: "GET",
      url: "https://api.mail.tm/messages",
      headers: H
    });

    const messages = listRes["hydra:member"] || [];
    const ids = messages.map(m => m.id).filter(Boolean);

    if (ids.length === 0) {
      logLine("Inbox already empty", true);
      return true;
    }

    // 4) Delete all messages
    const deletePromises = ids.map(id =>
      gmRequest({
        method: "DELETE",
        url: `https://api.mail.tm/messages/${id}`,
        headers: H
      })
    );

    const results = await Promise.allSettled(deletePromises);
    const allSuccess = results.every(
      r => r.status === "fulfilled" && r.value?.status >= 200 && r.value?.status < 300
    );

    if (!allSuccess) {
      logLine("Clear inbox: some deletions failed", false);
      return false;
    }

    // 5) Verify empty
    const verifyRes = await gmJson({
      method: "GET",
      url: "https://api.mail.tm/messages",
      headers: H
    });

    const remaining = (verifyRes["hydra:member"] || []).length;
    if (remaining === 0) {
      logLine("Inbox cleared successfully", true);
      console.log("inbox cleared successfully");
      return true;
    } else {
      logLine(`Clear inbox: ${remaining} messages still remain`, false);
      return false;
    }
  } catch (e) {
    logLine(`Clear inbox error: ${e?.message}`, false);
    return false;
  }
}


  /**


   * Initializes mailbox prerequisites before bot can be started.


   */


  async function runMailboxInit() {
    BOT_STATE.mailboxInitReady = false;
    sSet(STORAGE_KEYS.mailboxInitReady, false);

    setStatus("initializing mailbox...", "waiting");
    updateActionButton("disabled");

    try {
      logLine("Mailbox init: clearing inbox");

      const clearSuccess = await clearInbox();
      if (!clearSuccess) {
        throw new Error("Inbox clearing failed");
      }

      BOT_STATE.mailboxInitReady = true;
      sSet(STORAGE_KEYS.mailboxInitReady, true);

      logLine("Mailbox initialization complete", true);

      if (!BOT_STATE.running && !BOT_STATE.successMessage) {
        setStatus("stopped", "stopped");
      }
      updateActionButton(BOT_STATE.running ? "stop" : "start");
      return true;
    } catch (e) {
      BOT_STATE.mailboxInitReady = false;
      sSet(STORAGE_KEYS.mailboxInitReady, false);
      logLine(`Mailbox init failed: ${e?.message || "unknown"}`, false);
      setStatus("mailbox init failed - reload page", "error");
      updateActionButton("disabled");
      return false;
    }
  }


  /**


   * Returns persisted mail.tm bearer token string.


   */


  function getToken() {
    return sGet(STORAGE_KEYS.mailToken, "") || "";
  }

  /**

   * Extracts numeric verification code from message text content.

   */

  function extractCode(text) {
    const m = String(text || "").match(/\b(\d{4,8})\b/);
    return m ? m[1] : null;
  }

  /**

   * Populates verification code field and submits verification form.

   */

  function applyCodeAndSubmit(code) {
    const codeInput = document.querySelector("#code");
    const submitBtn = document.querySelector(".mdc-button");

    if (!codeInput || !submitBtn) return false;

    codeInput.value = code;
    codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    codeInput.dispatchEvent(new Event("change", { bubbles: true }));

    logLine(`Submitting code: ${code}`, true);
    submitBtn.click();
    return true;
  }

  /**

   * Polls mailbox at high frequency until a verification code is found or times out.

   */

  async function retrieveVerificationCode() {
    return new Promise((resolve) => {
      const startTime = Date.now();

      async function pollOnce() {
        if (!BOT_STATE.verifyPolling) return resolve(null);

        // Hard stop
        if (Date.now() - startTime > BOT_CONFIG.mailMaxWaitMs) {
          logLine("Verification timeout", false);
          stopVerificationRetriever();
          return resolve(null);
        }

        const token = getToken();
        if (!token) {
          logLine("No token available for verification", false);
          stopVerificationRetriever();
          return resolve(null);
        }

        const reqStart = Date.now();

        try {
          const res = await gmRequest({
            method: "GET",
            url: "https://api.mail.tm/messages",
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000
          });

          if (res.status !== 200) {
            stopVerificationRetriever();
            return resolve(null);
          }

          const data = JSON.parse(res.responseText || "{}");
          const msg = (data["hydra:member"] || [])[0];

          if (msg) {
            const code = extractCode(msg.intro);
            logLine(`Message received: ${msg.intro}`);

            if (code) {
              const success = applyCodeAndSubmit(code);
              stopVerificationRetriever();
              return resolve(success ? code : null);
            }

            // If intro exists but no code (shouldn't happen per your setup), keep polling.
          }
        } catch (e) {
          // Transient error: keep polling
          logLine(`Verification poll error: ${e?.message}`, false);
        }

        if (!BOT_STATE.verifyPolling) return;

        // Adaptive delay:
        // - If the request took longer than the target interval, poll again immediately.
        // - Otherwise wait only the remaining time so request STARTs are ~mailPollIntervalMs apart.
        const rtt = Date.now() - reqStart;
        const delay = Math.max(0, BOT_CONFIG.mailPollIntervalMs - rtt);

        BOT_STATE.verifyPollTimer = setTimeout(pollOnce, delay);
      }

      BOT_STATE.verifyPolling = true;
      pollOnce();
    });
  }


  /**

   * Stops active verification polling timers and state flags.

   */

  function stopVerificationRetriever() {
    BOT_STATE.verifyPolling = false;
    if (BOT_STATE.verifyPollTimer) {
      clearTimeout(BOT_STATE.verifyPollTimer);
      BOT_STATE.verifyPollTimer = null;
    }
  }

  // ==============================
  // BOOKING STEP HANDLERS
  // ==============================
  /**
   * Step handler: selects requested sport tile from reservation main page.
   */
  async function con_main(sportName = BOT_CONFIG.sportName) {
    try {
      const localRunToken = BOT_STATE.runToken;

    // If we prewarmed to this page before the exact release time, we know the slots
    // were loaded too early. At the moment the schedule starts, force ONE immediate
    // refresh before doing any checks.
    if (BOT_STATE.mode === "SCHEDULE_RUN" && BOT_STATE.postTargetTimeSelectionRefreshPending) {
      BOT_STATE.postTargetTimeSelectionRefreshPending = false;
      location.reload();
      return false;
    }
      const target = String(sportName || "").trim().toLowerCase();
      if (!target) return false;

      const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

      const start = Date.now();
      const maxWaitMs = 6000;

      while (Date.now() - start < maxWaitMs) {
        if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return false;

        const anchors = Array.from(
          document.querySelectorAll('a.button.no-img, a[href*="/ReserveTime/StartReservation"], .section-buttons a')
        );

        if (anchors.length) {
          let match = anchors.find((a) => {
            const contentText = normalize(a.querySelector(".content")?.textContent);
            const fullText = normalize(a.textContent);
            return contentText === target || fullText === target;
          });

          if (!match) {
            match = anchors.find((a) => {
              const contentText = normalize(a.querySelector(".content")?.textContent);
              const fullText = normalize(a.textContent);
              return contentText.includes(target) || fullText.includes(target);
            });
          }

          if (match) {
            markStep("con_main()", true);
            match.click();
            return true;
          }
        }

        await sleep(120);
      }

      return false;
    } catch {
      return false;
    }
  }

  /**

   * Step handler: confirms group-size page by clicking submit.

   */

  function con_group() {
    try {
      const count = document.querySelector("#reservationCount");
      if (count) {
        count.value = 2;
        // keep it fast: minimal events to satisfy most frameworks
        count.dispatchEvent(new Event("input", { bubbles: true }));
        count.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const btn = document.querySelector("#submit-btn");
      if (!btn) return false;
      markStep("con_group()", true);
      btn.click();
      return true;
    } catch {
      return false;
    }
  }

  /**

   * Step handler: selects requested day/time slot and handles unavailable states.

   */

  async function con_timeselect(day = BOT_CONFIG.day, timeSlot = BOT_CONFIG.timeSlot) {
  try {
    const localRunToken = BOT_STATE.runToken;
    day = String(day).trim().toLowerCase();

    const normalizeTime = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\u00a0/g, " ")
        .replace(/\./g, "")     // p.m. -> pm
        .replace(/\s+/g, " ")
        .trim();

    const wantedTime = normalizeTime(timeSlot);

    const maxWaitMs = 5 * 60 * 1000;
    const refreshEveryMs = 500;

    let waitStart = Number(sGet(STORAGE_KEYS.timeselectWaitStartMs, 0));
    if (!waitStart || Number.isNaN(waitStart)) {
      waitStart = Date.now();
      sSet(STORAGE_KEYS.timeselectWaitStartMs, waitStart);
    }

    const elapsed = Date.now() - waitStart;
    if (elapsed > maxWaitMs) {
      sDel(STORAGE_KEYS.timeselectWaitStartMs);
      return false;
    }

    const sections = document.querySelectorAll("#mainForm > div.section.date-list.times-ampm");
    let dayCard = null;

    outer:
    for (const section of sections) {
      for (const card of section.children) {
        const dateAnchor = card.querySelector("a.title");
        const label = (dateAnchor?.getAttribute("aria-label") || "").toLowerCase();

        const fallbackDay =
          card.children?.[0]?.children?.[0]?.children?.[1]?.innerHTML
            ?.trim()
            .split(" ")[0]
            ?.toLowerCase() || "";

        if (label.includes(day) || fallbackDay === day) {
          dayCard = card;
          break outer;
        }
      }
    }

    const MAX_TIMESELECT_ATTEMPTS = 10;

    // Read + increment persistent attempt counter (survives page reload)
    let attempts = Number(sGet(STORAGE_KEYS.timeselectAttempts, 0)) || 0;

    if (!dayCard) {
      if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return false;
      attempts++;
      sSet(STORAGE_KEYS.timeselectAttempts, attempts);
      if (attempts >= MAX_TIMESELECT_ATTEMPTS) {
        sDel(STORAGE_KEYS.timeselectAttempts);
        sDel(STORAGE_KEYS.timeselectWaitStartMs);
        setStatus(`timeslot not found after ${MAX_TIMESELECT_ATTEMPTS} tries`, "error");
        logLine(`timeslot: day card not found after ${MAX_TIMESELECT_ATTEMPTS} attempts`, false);
        stopBot("timeslot not found – max attempts reached", true);
        return false;
      }
      setStatus(`finding timeslot... (${attempts}/${MAX_TIMESELECT_ATTEMPTS})`, "waiting");
      location.reload();
      return false;
    }

    const timesList = dayCard.querySelector("ul.times-list");
    if (!timesList) {
      if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return false;
      attempts++;
      sSet(STORAGE_KEYS.timeselectAttempts, attempts);
      if (attempts >= MAX_TIMESELECT_ATTEMPTS) {
        sDel(STORAGE_KEYS.timeselectAttempts);
        sDel(STORAGE_KEYS.timeselectWaitStartMs);
        setStatus(`timeslot not found after ${MAX_TIMESELECT_ATTEMPTS} tries`, "error");
        logLine(`timeslot: times-list not found after ${MAX_TIMESELECT_ATTEMPTS} attempts`, false);
        stopBot("timeslot not found – max attempts reached", true);
        return false;
      }
      setStatus(`finding timeslot... (${attempts}/${MAX_TIMESELECT_ATTEMPTS})`, "waiting");
      location.reload();
      return false;
    }

    // Only real slot entries, skip hour separator rows
    const times = Array.from(timesList.querySelectorAll("li.time, li.time.ampm-format"));
    let targetLi = null;

    for (const li of times) {
  const a = li.querySelector("a.time-container, a");
  const label = normalizeTime(a?.getAttribute("aria-label") || "");
  const txt = normalizeTime(a?.textContent || li.textContent || "");


  const labelTime = (label.match(/\b(1[0-2]|0?[1-9]):[0-5]\d\s*(am|pm)\b/) || [])[0] || "";
  const textTime  = (txt.match(/\b(1[0-2]|0?[1-9]):[0-5]\d\s*(am|pm)\b/) || [])[0] || "";


  if (labelTime === wantedTime || textTime === wantedTime) {
    targetLi = li;
    break;
  }
}

    if (!targetLi) {
      if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return false;
      attempts++;
      sSet(STORAGE_KEYS.timeselectAttempts, attempts);
      if (attempts >= MAX_TIMESELECT_ATTEMPTS) {
        sDel(STORAGE_KEYS.timeselectAttempts);
        sDel(STORAGE_KEYS.timeselectWaitStartMs);
        setStatus(`timeslot not found after ${MAX_TIMESELECT_ATTEMPTS} tries`, "error");
        logLine(`timeslot: target li not found after ${MAX_TIMESELECT_ATTEMPTS} attempts`, false);
        stopBot("timeslot not found – max attempts reached", true);
        return false;
      }
      setStatus(`finding timeslot... (${attempts}/${MAX_TIMESELECT_ATTEMPTS})`, "waiting");
      location.reload();
      return false;
    }

    // Unavailable pattern confirmed in your HTML:
    // li.time.reserved.ampm-format[aria-hidden="true"]
    const cls = targetLi.classList;
    const ariaHidden = (targetLi.getAttribute("aria-hidden") || "").toLowerCase() === "true";
    const isUnavailable = cls.contains("reserved") || ariaHidden;

    if (isUnavailable) {
      sDel(STORAGE_KEYS.timeselectWaitStartMs);
      setStatus("timeslot not available", "error");
      logLine("timeslot not available", false);
      stopBot("timeslot not available", true);
      return false;
    }

    const timeButton = targetLi.querySelector("a.time-container, a");
    if (!timeButton) {
      if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return false;
      attempts++;
      sSet(STORAGE_KEYS.timeselectAttempts, attempts);
      if (attempts >= MAX_TIMESELECT_ATTEMPTS) {
        sDel(STORAGE_KEYS.timeselectAttempts);
        sDel(STORAGE_KEYS.timeselectWaitStartMs);
        setStatus(`timeslot not found after ${MAX_TIMESELECT_ATTEMPTS} tries`, "error");
        logLine(`timeslot: time button not found after ${MAX_TIMESELECT_ATTEMPTS} attempts`, false);
        stopBot("timeslot not found – max attempts reached", true);
        return false;
      }
      setStatus(`finding timeslot... (${attempts}/${MAX_TIMESELECT_ATTEMPTS})`, "waiting");
      location.reload();
      return false;
    }

    sDel(STORAGE_KEYS.timeselectAttempts);
    markStep("con_timeselect()", true);
    timeButton.click();
    return true;
  } catch {
    return false;
  }
}

  /**

   * Step handler: fills contact form, waits for Turnstile token, and submits.

   */

  async function con_contact(
    phone = BOT_CONFIG.phone,
    email = BOT_CONFIG.email,
    name = BOT_CONFIG.name
  ) {
    try {
      const localRunToken = BOT_STATE.runToken;
      const waitStart = Date.now();
      const waitFieldsMaxMs = 6000;
      const waitFieldsPollMs = 50;

      let phoneField, emailField, nameField, submitBtn;

      while (Date.now() - waitStart < waitFieldsMaxMs) {
        if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return false;

        phoneField = document.querySelector("#telephone");
        emailField = document.querySelector("#email");
        nameField = document.querySelectorAll(".mdc-text-field")[1].children[1];
        submitBtn = document.querySelector("#submit-btn");

        if (phoneField && emailField && nameField && submitBtn) break;
        await sleep(waitFieldsPollMs);
      }

      if (!(phoneField && emailField && nameField && submitBtn)) return false;

      setStatus(`Filling name: ${name}`);
      nameField.value = String(name);
      nameField.dispatchEvent(new Event("input", { bubbles: true }));
      nameField.dispatchEvent(new Event("change", { bubbles: true }));

      setStatus(`filling email: ${email}`);
      emailField.value = String(email);
      emailField.dispatchEvent(new Event("input", { bubbles: true }));
      emailField.dispatchEvent(new Event("change", { bubbles: true }));

      setStatus(`filling phone number: ${phone}`);
      phoneField.value = String(phone);
      phoneField.dispatchEvent(new Event("input", { bubbles: true }));
      phoneField.dispatchEvent(new Event("change", { bubbles: true }));

      setStatus("waiting for cloudflare");
      const tokenStart = Date.now();
      const tokenTimeoutMs = 6000;

      while (Date.now() - tokenStart < tokenTimeoutMs) {
        if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return false;

        const tokenField = document.querySelector('input[name="cf-turnstile-response"]');
        const token = String(tokenField?.value || "").trim();
        if (token) {
          setStatus("submitting contact info");
          markStep("con_contact()", true);
          submitBtn.click();
          return true;
        }

        await sleep(200);
      }

      location.reload();
      return false;
    } catch {
      return false;
    }
  }


  /**


   * Step handler: retrieves email code and completes verification stage.


   */


  async function con_verify() {
    try {
      const localRunToken = BOT_STATE.runToken;

      if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) {
        return false;
      }

      setStatus("retrieving verification code");
      logLine("Starting verification code retrieval");

      // Start the fast polling retrieval
      const code = await retrieveVerificationCode();

      if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) {
        return false;
      }

      if (!code) {
        logLine("Verification code retrieval failed", false);
        return false;
      }

      // Code was already submitted by applyCodeAndSubmit
      markStep("con_verify", true);
      logLine("Verification successful", true);
      return true;
    } catch (e) {
      logLine(`Verification error: ${e?.message || "unknown"}`, false);
      return false;
    }
  }

  /**

   * Step handler: submits final reservation confirmation action.

   */

  function con_confirm() {
    try {
      const submitBtn = document.querySelector("#submit-btn");
      if (!submitBtn) return false;
      markStep("con_confirm()", true);
      submitBtn.click();
      return true;
    } catch {
      return false;
    }
  }

  // ==============================
  // EXECUTION ENGINE
  // ==============================
  /**
   * Executes current step with timeout/retry handling and success completion flow.
   */
  async function runCurrentStep() {
    if (!BOT_STATE.running || BOT_STATE.inStep) return;

    const localRunToken = BOT_STATE.runToken;
    const stepName = getCurrentStepName();
    if (!stepName) return;
    if (BOT_STATE.stepDone[stepName] === true) return;

    const fn = getFnFromStep(stepName);
    if (typeof fn !== "function") {
      stopBot(`Missing function for step: ${stepName}`, true);
      return;
    }

    BOT_STATE.stepFails[stepName] = BOT_STATE.stepFails[stepName] || 0;
    BOT_STATE.inStep = true;

    if (stepName === "con_main()") setStatus(`selecting ${BOT_CONFIG.sportName}`);
    if (stepName === "con_group()") setStatus("confirming group size");
    if (stepName === "con_timeselect()") setStatus(`selecting ${BOT_CONFIG.day} / ${BOT_CONFIG.timeSlot}`);
    if (stepName === "con_contact()") setStatus(`Filling name: ${BOT_CONFIG.name}`);
    if (stepName === "con_verify") setStatus("retrieving verification code");
    if (stepName === "con_confirm()") setStatus("confirming reservation");

    logLine(`Running ${stepName} on ${location.pathname}`);

    let done = false;
    let timedOut = false;

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => fn()),
        new Promise(resolve =>
          setTimeout(() => {
            timedOut = true;
            resolve(false);
          }, BOT_CONFIG.stepTimeoutMs)
        )
      ]);

      if (!BOT_STATE.running || localRunToken !== BOT_STATE.runToken) return;

      done = result === true;
    } catch (e) {
      logLine(`Step ${stepName} threw error: ${e?.message || "unknown"}`, false);
      done = false;
    } finally {
      if (localRunToken === BOT_STATE.runToken) BOT_STATE.inStep = false;
    }

    if (!done) {
      BOT_STATE.stepFails[stepName] += 1;

      if (timedOut) {
        markStep(stepName, false);
        stopBot(`Timeout error: ${stepName} exceeded ${BOT_CONFIG.stepTimeoutMs}ms`, true);
        return;
      }

      if (stepName === "con_verify") {
        setStatus("retrieving verification code");
      }

      const maxRetries = stepName === "con_verify" ? 15 : BOT_CONFIG.stepMaxRetries;

      if (BOT_STATE.stepFails[stepName] >= maxRetries) {
        markStep(stepName, false);
        const errorMsg = stepName === "con_verify"
          ? "Email verification failed (mail API unreachable or timeout)"
          : `Step failed after retries: ${stepName}`;
        stopBot(errorMsg, true);
      }
      return;
    }

    BOT_STATE.stepFails[stepName] = 0;
    markStep(stepName, true);
    logLine(`Step success: ${stepName}`, true);

    if (stepName === "con_confirm()") {
      const endMs = Date.now();
      const parsedStart = BOT_STATE.sessionStartIso ? new Date(BOT_STATE.sessionStartIso).getTime() : NaN;
      const startMs = Number.isFinite(parsedStart) ? parsedStart : endMs;
      const elapsedMs = Math.max(0, endMs - startMs);
      const elapsedText = formatDuration(elapsedMs);
      BOT_STATE.tokenReadyForRun = false;
      BOT_STATE.tokenPrepInProgress = false;
      BOT_STATE.schedulePrewarmed = false;
      BOT_STATE.running = false;
      BOT_STATE.inStep = false;
      BOT_STATE.runToken += 1;
      BOT_STATE.lastRunSuccessful = true;
      BOT_STATE.successMessage = `Reservation Successful - ${elapsedText}`;
      sSet(STORAGE_KEYS.successMessage, BOT_STATE.successMessage);

      if (BOT_STATE.timer) {
        clearInterval(BOT_STATE.timer);
        BOT_STATE.timer = null;
      }

      sSet(STORAGE_KEYS.running, false);
      sDel(STORAGE_KEYS.waitingUntilIso);

      setStatus(BOT_STATE.successMessage, "success");
      updateActionButton("start");
      saveState();

      logLine(BOT_STATE.successMessage, true);
    }
  }

 /**

  * Starts immediate step execution loop and initializes session timer.

  */

 function startLoopNow() {

  if (!BOT_STATE.sessionStartIso) {
    BOT_STATE.sessionStartIso = new Date().toISOString();
    sSet(STORAGE_KEYS.sessionStartIso, BOT_STATE.sessionStartIso);
  }

  if (BOT_STATE.timer) clearInterval(BOT_STATE.timer);
  BOT_STATE.timer = setInterval(runCurrentStep, BOT_CONFIG.tickMs);
  runCurrentStep();
}
/**
 * During scheduled waits, pre-navigates toward time-selection page for faster start.
 */
async function prewarmToTimeSelection() {
  // Only for scheduled mode and only while waiting
  if (!BOT_STATE.running || BOT_STATE.mode !== "SCHEDULE_RUN") return false;

  const path = location.pathname;

  // If already at or past time selection, nothing to do
  if (
    path === pages["con_timeselect()"] ||
    path === pages["con_contact()"] ||
    path === pages["con_verify"] ||
    path === pages["con_confirm()"]
  ) {
    return true;
  }

  // From main page: click sport
  if (path === pages["con_main()"]) {
    const ok = await con_main(BOT_CONFIG.sportName);
    return ok === true;
  }

  // Group page: click continue
  if (path === pages["con_group()"]) {
    return con_group() === true;
  }

  // Any other page during prewarm: go to main entry
  goToMainEntry();
  return false;
}

  /**

   * Runs scheduled wait loop, prewarm actions, token prep, and launch at target time.

   */

  function startLiveWaitLoop() {
  if (BOT_STATE.timer) clearInterval(BOT_STATE.timer);

  const checkWait = async () => {
    if (!BOT_STATE.running) return;

    if (!BOT_STATE.waitingUntilIso) {
      if (!BOT_STATE.tokenReadyForRun) {
        if (BOT_STATE.tokenPrepInProgress) return;
        BOT_STATE.tokenPrepInProgress = true;
        const ok = await createAndStoreToken();
        BOT_STATE.tokenPrepInProgress = false;
        if (!ok) {
          stopBot("Token creation failed", true);
          saveState();
          return;
        }
        BOT_STATE.tokenReadyForRun = true;
      }
      startLoopNow();
      return;
    }

    const now = new Date();
    const target = new Date(BOT_STATE.waitingUntilIso);
    const remaining = target - now;
    if (remaining <= 8000 && remaining > 0 && !BOT_STATE.schedulePrewarmed && BOT_CONFIG.schedulePrewarmEnabled) {
      BOT_STATE.schedulePrewarmed = true;

      logLine("Schedule prewarm: attempting to reach time selection (T-8s)");

      const moved = await prewarmToTimeSelection();
      if (moved) {
        logLine("Schedule prewarm action executed", true);
      } else {
        logLine("Schedule prewarm pending/redirected", null);
      }
    }
    if (remaining <= 5000 && remaining > 0 && !BOT_STATE.tokenReadyForRun) {
      if (!BOT_STATE.tokenPrepInProgress) {
        BOT_STATE.tokenPrepInProgress = true;
        setStatus("preparing mail token...", "waiting");
        const ok = await createAndStoreToken();
        BOT_STATE.tokenPrepInProgress = false;

        if (!ok) {
          stopBot("Token creation failed", true);
          saveState();
          return;
        }

        BOT_STATE.tokenReadyForRun = true;
        logLine("Scheduled run token prepared at T-5s", true);
      }
    }

    if (remaining <= 0) {
      if (!BOT_STATE.tokenReadyForRun) {
        if (BOT_STATE.tokenPrepInProgress) return;
        BOT_STATE.tokenPrepInProgress = true;
        const ok = await createAndStoreToken();
        BOT_STATE.tokenPrepInProgress = false;
        if (!ok) {
          stopBot("Token creation failed", true);
          saveState();
          return;
        }
        BOT_STATE.tokenReadyForRun = true;
      }

      logLine("Target time reached! Starting automation.");
      // Only force a refresh if prewarm was active (we may have navigated early).
      // When prewarm is disabled the page is untouched, so no refresh is needed.
      BOT_STATE.postTargetTimeSelectionRefreshPending = BOT_CONFIG.schedulePrewarmEnabled;
      BOT_STATE.waitingUntilIso = null;
      sDel(STORAGE_KEYS.waitingUntilIso);
      startLoopNow();
      return;
    }

    if (BOT_STATE.schedulePrewarmed && remaining > 0 && BOT_CONFIG.schedulePrewarmEnabled) {
      setStatus("Advancing to get a head start...", "waiting");
    } else {
      const timeLeft = formatDuration(Math.max(0, remaining));
      setStatus(`WAITING - ${timeLeft}`, "waiting");
    }

  };

  BOT_STATE.timer = setInterval(() => { checkWait(); }, 1000);
  checkWait();
}

  /**

   * Initializes a new run and branches to immediate or scheduled execution.

   */

  function beginRun() {
    BOT_STATE.running = true;
    BOT_STATE.sessionStartIso = null;
    sDel(STORAGE_KEYS.sessionStartIso);
    BOT_STATE.inStep = false;
    BOT_STATE.runToken += 1;
    BOT_STATE.lastRunSuccessful = false;
    BOT_STATE.tokenReadyForRun = false;
    BOT_STATE.tokenPrepInProgress = false;
    BOT_STATE.schedulePrewarmed = false;
    sDel(STORAGE_KEYS.lastError);
    sSet(STORAGE_KEYS.running, true);
    updateActionButton("stop");

    if (BOT_STATE.mode === "SCHEDULE_RUN") {
      const targetDate = getScheduledTargetDate();
      const now = new Date();
      const deltaMs = targetDate - now;

      if (deltaMs > 5000) {
        BOT_STATE.waitingUntilIso = targetDate.toISOString();
        sSet(STORAGE_KEYS.waitingUntilIso, BOT_STATE.waitingUntilIso);
        logLine(`SCHEDULE RUN: waiting until ${targetDate.toLocaleString()}`);

        startLiveWaitLoop();
      } else {
        logLine("SCHEDULE RUN: target time already passed or within 5s, starting immediately");

        startLoopNow();
      }
    } else {
      logLine("RUN NOW: starting immediately");
      startLoopNow();
    }
  }

  /** Starts a 1-second ticker that keeps the schedule countdown live. Safe to call multiple times. */
  function _startCountdown() {
    if (BOT_UI._countdownTick) return; // already running
    BOT_UI._countdownTick = setInterval(() => {
      const hEl = document.getElementById("nb-cnt-h");
      const mEl = document.getElementById("nb-cnt-m");
      const sEl = document.getElementById("nb-cnt-s");
      if (!hEl || !mEl || !sEl) return;

      const diff = getScheduledTargetDate() - new Date();
      if (diff <= 0) {
        hEl.textContent = "00"; mEl.textContent = "00"; sEl.textContent = "00";
        return;
      }
      const tot = Math.floor(diff / 1000);
      hEl.textContent = String(Math.floor(tot / 3600)).padStart(2, "0");
      mEl.textContent = String(Math.floor((tot % 3600) / 60)).padStart(2, "0");
      sEl.textContent = String(tot % 60).padStart(2, "0");
    }, 1000);
  }

  // ==============================
  // UI RENDERING & EVENTS
  // ==============================
  /**
   * Injects bot UI, styles, controls, and binds all UI event handlers.
   */
  function uiInject() {
    if (BOT_UI.root) return;

    const root = document.createElement("div");
    root.id = "nepeanbot-ui";

    const style = document.createElement("style");
    style.textContent = `
      #nepeanbot-ui{
        position:fixed;
        top:20px;
        right:20px;
        width:340px;
        background:#1e1e1e;
        color:#f1f1f1;
        border-radius:8px;
        box-shadow:0 6px 20px rgba(0,0,0,0.5);
        font-family:"Segoe UI",Tahoma,sans-serif;
        font-size:14px;
        z-index:999999;
        overflow:hidden;
      }
        #nepeanbot-ui, #nepeanbot-ui .nb-header, #nepeanbot-ui .nb-title, #nepeanbot-ui .nb-step, #nepeanbot-ui .nb-status, #nepeanbot-ui button, #nepeanbot-ui span { user-select:none; -webkit-user-select:none; }
#nepeanbot-ui input, #nepeanbot-ui textarea { user-select:text; -webkit-user-select:text; }

      #nepeanbot-ui *{box-sizing:border-box;}
      .nb-header{
        background:linear-gradient(135deg,#2b5876,#4e4376);
        padding:12px 16px;
        font-weight:bold;
        font-size:15px;
        text-align:center;
        color:#fff;
      }
      .nb-body{ padding:14px; display:flex; flex-direction:column; gap:10px; }

      /* ── Info Card ── */
      .nb-info-card{
        background:linear-gradient(145deg,#1c1c1e,#28282c);
        border:1px solid rgba(255,255,255,0.07);
        border-radius:16px;
        padding:16px 14px 14px;
        text-align:center;
      }
      .nb-sport-emoji{ font-size:30px; line-height:1; margin-bottom:6px; }
      .nb-sport-sup{
        font-size:10px;
        text-transform:uppercase;
        letter-spacing:1.2px;
        color:#666;
        margin-bottom:2px;
      }
      .nb-sport-name{
        font-size:20px;
        font-weight:700;
        color:#fff;
        letter-spacing:-0.3px;
      }
      .nb-timeslot{
        font-size:13px;
        color:#8e8e93;
        margin-top:3px;
      }

      /* ── Segmented Control ── */
      .nb-seg-ctrl{
        display:flex;
        background:#2c2c2e;
        border-radius:10px;
        padding:3px;
        position:relative;
      }
      .nb-seg-track{
        position:absolute;
        top:3px; bottom:3px;
        left:3px;
        width:calc(50% - 3px);
        background:#48484a;
        border-radius:8px;
        transition:transform 0.22s cubic-bezier(0.34,1.3,0.64,1);
        box-shadow:0 1px 4px rgba(0,0,0,0.4);
      }
      .nb-seg-track.right{ transform:translateX(calc(100%)); }
      .nb-seg-opt{
        flex:1;
        text-align:center;
        padding:8px 4px;
        font-size:13px;
        font-weight:500;
        color:#666;
        cursor:pointer;
        border-radius:8px;
        position:relative;
        z-index:1;
        transition:color 0.15s;
        user-select:none;
        -webkit-user-select:none;
      }
      .nb-seg-opt.active{ color:#fff; }

      /* ── Schedule Card ── */
      .nb-schedule-card{
        background:#1c1c1e;
        border:1px solid rgba(255,255,255,0.07);
        border-radius:16px;
        padding:14px;
        display:none;
        overflow:hidden;
      }
      .nb-schedule-card.visible{ display:block; }
      .nb-sch-header{
        font-size:10px;
        text-transform:uppercase;
        letter-spacing:1.2px;
        color:#636366;
        margin-bottom:4px;
      }
      .nb-sch-time{
        font-size:16px;
        font-weight:600;
        color:#f2f2f7;
        margin-bottom:12px;
      }
      .nb-sch-time span{ color:#30d158; }
      .nb-countdown-row{
        display:flex;
        gap:6px;
      }
      .nb-cnt-block{
        flex:1;
        background:#2c2c2e;
        border-radius:10px;
        padding:8px 4px 6px;
        text-align:center;
      }
      .nb-cnt-val{
        font-size:22px;
        font-weight:700;
        color:#fff;
        font-variant-numeric:tabular-nums;
        letter-spacing:-0.5px;
        line-height:1;
      }
      .nb-cnt-lbl{
        font-size:9px;
        color:#636366;
        text-transform:uppercase;
        letter-spacing:0.8px;
        margin-top:3px;
      }

      /* ── Progress Bar ── */
      .nb-prog-wrap{
        background:#1c1c1e;
        border:1px solid rgba(255,255,255,0.06);
        border-radius:16px;
        padding:14px;
      }
      .nb-prog-header{
        display:flex;
        justify-content:space-between;
        align-items:center;
        margin-bottom:10px;
      }
      .nb-prog-title{
        font-size:10px;
        text-transform:uppercase;
        letter-spacing:1.2px;
        color:#636366;
      }
      .nb-prog-pct{
        font-size:11px;
        font-weight:600;
        color:#30d158;
      }
      .nb-prog-track{
        height:5px;
        background:#2c2c2e;
        border-radius:3px;
        overflow:hidden;
        margin-bottom:10px;
      }
      .nb-prog-fill{
        height:100%;
        background:linear-gradient(90deg,#1a9e40,#30d158);
        border-radius:3px;
        width:0%;
        transition:width 0.5s cubic-bezier(0.22,1,0.36,1);
      }
      .nb-prog-dots{
        display:flex;
        justify-content:space-between;
        align-items:center;
        padding:0 2px;
      }
      .nb-prog-dot{
        width:7px;
        height:7px;
        border-radius:50%;
        background:#3a3a3c;
        transition:background 0.3s, transform 0.3s;
        cursor:default;
      }
      .nb-prog-dot.done{
        background:#30d158;
        transform:scale(1.3);
        box-shadow:0 0 5px rgba(48,209,88,0.5);
      }

      /* ── Status ── */
      .nb-status{
        background:#1c1c1e;
        border:1px solid rgba(255,255,255,0.06);
        border-radius:10px;
        padding:9px 12px;
        font-size:12px;
        text-align:center;
        color:#f1f1f1;
        letter-spacing:0.1px;
      }

      .nb-row{ display:flex; gap:8px; margin-bottom:8px; }
      .nb-row:last-child{ margin-bottom:0; }
      .nb-row input,.nb-row select{
        flex:1 1 0; min-width:0;
        background:#1a1a1a; border:1px solid #444;
        color:#f1f1f1; padding:8px 10px;
        border-radius:4px; font-size:13px;
      }
      .nb-row input:focus,.nb-row select:focus{ outline:none; border-color:#5a9fd4; }
      .nb-mode-row{ display:flex; gap:8px; }
      .nb-mode-select{ flex:1 1 auto; min-width:0; }

.nb-icon-btn{
  width:40px; min-width:40px; height:40px;
  border-radius:8px; border:1px solid #444;
  background:#1a1a1a; color:#f1f1f1;
  cursor:pointer; display:none;
  align-items:center; justify-content:center;
  font-size:16px;
}

.nb-overlay{
  position:absolute; inset:0; z-index:1000;
  display:flex; align-items:center; justify-content:center;
  backdrop-filter:blur(3px);
  background:rgba(8,8,10,.35);
  border-radius:8px;
}
.nb-hidden{ display:none !important; }

.nb-modal{
  width:84%; max-width:340px;
  background:#202226;
  border:1px solid #3a3f48;
  border-radius:14px;
  padding:14px;
  box-shadow:
  0 0 0 1px rgba(255, 255, 255, 0.07),
  0 0 24px rgba(255, 255, 255, 0.11),
  0 0 48px rgba(255, 255, 255, 0.13),
  0 0 510px rgba(255, 255, 255, 0.12),
  0 12px 30px rgba(0,0,0,.45);
}

.nb-modal-title{
  text-align:center; font-weight:700; font-size:17px;
  margin-bottom:10px; color:#f4f4f4;
}

.nb-apply-btn{
  width:100%;
  border:none;
  border-radius:10px;
  padding:11px 12px;
  font-weight:700;
  font-size:15px;
  background:#93c963;
  color:#111;
  cursor:pointer;
}

      .nb-action{
        width:100%;
        padding:12px;
        border:none;
        border-radius:6px;
        font-size:15px;
        font-weight:bold;
        cursor:pointer;
        transition:all 0.2s;
        text-transform:uppercase;
        letter-spacing:0.5px;
      }
      .nb-action:hover:not(:disabled){
        transform:translateY(-2px);
        box-shadow:0 4px 12px rgba(0,0,0,0.3);
      }
      .nb-action:active:not(:disabled){
        transform:translateY(0);
      }
      .nb-action:disabled{
        opacity:1;
      }
    `;

    const processSteps = [
      ["con_main()", "Select sport"],
      ["con_group()", "Select Group"],
      ["con_timeselect()", "Select Timeslot"],
      ["con_contact()", "Fill Contact Information"],
      ["con_verify", "Email Verification"],
      ["con_confirm()", "Confirmation"]
    ];

    const stepsHtml = processSteps.map(([key, label]) => `
      <div class="nb-step" data-step="${escapeHtml(key)}">
        <span class="nb-step-box"></span>
        <span>${escapeHtml(label)}</span>
      </div>
    `).join("");

    root.innerHTML = `
  <div class="nb-header">NepeanBot v3.0.1 PROD</div>
  <div class="nb-body">

    <!-- Hidden legacy inputs – keep for backward-compat with existing logic -->
    <div style="display:none">
      <input  id="nb-sport"  value="Badminton" />
      <select id="nb-day"><option value="Saturday" selected>Saturday</option></select>
      <input  id="nb-hour"   type="number" value="7" />
      <input  id="nb-minute" type="number" value="30" />
      <select id="nb-ampm"><option value="p.m." selected>p.m.</option></select>
      <select id="nb-mode">
        <option value="RUN_NOW">Run Now</option>
        <option value="SCHEDULE_RUN">Schedule Run</option>
      </select>
      <button id="nb-schedule-btn"></button>
    </div>

    <!-- Sport + Timeslot card -->
    <div class="nb-info-card">
      <div class="nb-sport-emoji">🏸</div>
      <div class="nb-sport-sup">Activity</div>
      <div class="nb-sport-name">Badminton</div>
      <div class="nb-timeslot">7:30 PM &middot; Saturday</div>
    </div>

    <!-- Segmented mode toggle -->
    <div class="nb-seg-ctrl" id="nb-seg-ctrl">
      <div class="nb-seg-track" id="nb-seg-track"></div>
      <div class="nb-seg-opt active" data-val="RUN_NOW">Run Now</div>
      <div class="nb-seg-opt" data-val="SCHEDULE_RUN">Scheduled</div>
    </div>

    <!-- Schedule info card (visible only in SCHEDULE_RUN mode) -->
    <div class="nb-schedule-card" id="nb-schedule-card">
      <div class="nb-sch-header">Next Run</div>
      <div class="nb-sch-time">Thursday &middot; <span>5:59:59 PM</span></div>
      <div class="nb-countdown-row">
        <div class="nb-cnt-block">
          <div class="nb-cnt-val" id="nb-cnt-h">--</div>
          <div class="nb-cnt-lbl">hrs</div>
        </div>
        <div class="nb-cnt-block">
          <div class="nb-cnt-val" id="nb-cnt-m">--</div>
          <div class="nb-cnt-lbl">min</div>
        </div>
        <div class="nb-cnt-block">
          <div class="nb-cnt-val" id="nb-cnt-s">--</div>
          <div class="nb-cnt-lbl">sec</div>
        </div>
      </div>
    </div>

    <!-- Horizontal progress bar -->
    <div class="nb-prog-wrap">
      <div class="nb-prog-header">
        <span class="nb-prog-title">Progress</span>
        <span class="nb-prog-pct" id="nb-prog-pct">Idle</span>
      </div>
      <div class="nb-prog-track">
        <div class="nb-prog-fill" id="nb-prog-fill"></div>
      </div>
      <div class="nb-prog-dots" id="nb-prog-dots">
        ${processSteps.map(([key, label]) =>
          `<div class="nb-prog-dot" data-step="${escapeHtml(key)}" title="${escapeHtml(label)}"></div>`
        ).join("")}
      </div>
    </div>

    <div id="nb-status" class="nb-status">initializing mailbox...</div>
    <button id="nb-action" class="nb-action" data-state="disabled" disabled>Start</button>
  </div>

  <!-- Schedule overlay (kept for legacy sch-apply logic) -->
  <div id="nb-schedule-overlay" class="nb-overlay nb-hidden">
    <div class="nb-modal">
      <div class="nb-modal-title">Schedule Run Settings</div>
      <div class="nb-row">
        <select id="nb-sch-day"><option value="Thursday" selected>Thursday</option></select>
      </div>
      <div class="nb-row">
        <input id="nb-sch-hour"   type="number" value="5" />
        <input id="nb-sch-minute" type="text"   value="59.59" />
        <select id="nb-sch-ampm"><option value="p.m." selected>p.m.</option></select>
      </div>
      <button id="nb-sch-apply" class="nb-apply-btn">Apply</button>
    </div>
  </div>
`;

    document.head.appendChild(style);
    document.body.appendChild(root);

    BOT_UI.root      = root;
    BOT_UI.status    = root.querySelector("#nb-status");
    BOT_UI.actionBtn = root.querySelector("#nb-action");
    BOT_UI.modeSel   = root.querySelector("#nb-mode");
    BOT_UI.sportInput  = root.querySelector("#nb-sport");
    BOT_UI.dayInput    = root.querySelector("#nb-day");
    BOT_UI.hourInput   = root.querySelector("#nb-hour");
    BOT_UI.minuteInput = root.querySelector("#nb-minute");
    BOT_UI.ampmSel     = root.querySelector("#nb-ampm");
    BOT_UI.scheduleBtn = root.querySelector("#nb-schedule-btn");
    BOT_UI.schOverlay  = root.querySelector("#nb-schedule-overlay");
    BOT_UI.schDay      = root.querySelector("#nb-sch-day");
    BOT_UI.schHour     = root.querySelector("#nb-sch-hour");
    BOT_UI.schMinute   = root.querySelector("#nb-sch-minute");
    BOT_UI.schAmPm     = root.querySelector("#nb-sch-ampm");
    BOT_UI.schApply    = root.querySelector("#nb-sch-apply");

    processSteps.forEach(([key]) => {
      // Dots are looked up dynamically; legacy step ref kept for safety
      BOT_UI.steps[key] = root.querySelector(`.nb-prog-dot[data-step="${CSS.escape(key)}"]`) ?? null;
    });

    // Segmented control – toggle mode
    root.querySelectorAll(".nb-seg-opt").forEach(opt => {
      opt.addEventListener("click", () => {
        if (BOT_STATE.running) return; // lock during run
        const val = opt.dataset.val;
        if (!val || val === BOT_STATE.mode) return;
        BOT_STATE.mode = val;
        BOT_UI.modeSel.value = val;
        sSet(STORAGE_KEYS.mode, val);
        refreshModeUI();
        logLine(`Mode set: ${val}`);
      });
    });

    // Legacy schedule-apply (overlay hidden but logic preserved)
    BOT_UI.schApply?.addEventListener("click", () => {
      const h          = Number(BOT_UI.schHour.value);
      const ap         = String(BOT_UI.schAmPm.value || "").toLowerCase();
      const minuteRaw  = String(BOT_UI.schMinute.value || "").trim();
      const minuteMatch = minuteRaw.match(/^(\d{1,2})(?:\.(\d{1,2}))?$/);
      if (!minuteMatch) { alert('Enter minute as "mm.ss" e.g. 59.59'); return; }
      const m  = Number(minuteMatch[1]);
      const s  = Number(minuteMatch[2] ?? "0");
      if (!Number.isInteger(h)||h<1||h>12||m<0||m>59||s<0||s>59||(ap!=="a.m."&&ap!=="p.m.")) {
        alert("Invalid schedule time."); return;
      }
      const dayName    = BOT_UI.schDay.value || "Thursday";
      const weekdayMap = { Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6 };
      const h24        = ap === "p.m." ? (h%12)+12 : (h%12);
      BOT_CONFIG.targetWeekday = weekdayMap[dayName];
      BOT_CONFIG.targetTime    = { h:h24, m, s };
      sSet(STORAGE_KEYS.targetWeekday, BOT_CONFIG.targetWeekday);
      sSet(STORAGE_KEYS.targetTime,    BOT_CONFIG.targetTime);
      BOT_UI.schOverlay.classList.add("nb-hidden");
      logLine(`Schedule target updated: ${dayName} ${h}:${String(m).padStart(2,"0")}.${String(s).padStart(2,"0")} ${ap}`, true);
    });

    BOT_UI.schOverlay?.addEventListener("click", e => {
      if (e.target === BOT_UI.schOverlay) BOT_UI.schOverlay.classList.add("nb-hidden");
    });

    BOT_UI.actionBtn.addEventListener("click", () => {
      const state = BOT_UI.actionBtn.dataset.state;
      if (state === "disabled") return;
      if (state === "stop") { bot_main("stop"); return; }
      bot_main("start");
    });

    renderAllSteps();
    updateActionButton();
    applyUIScale(UI_SCALE);
    makeUIDraggable();
  }

  /**

   * Synchronizes UI controls and status with persisted runtime state.

   */

  function syncUIFromState() {
    if (!BOT_UI.root) return;

    BOT_STATE.mode = BOT_STATE.mode || "RUN_NOW";
    if (BOT_UI.modeSel) BOT_UI.modeSel.value = BOT_STATE.mode;
    refreshModeUI();

    // Keep hidden inputs in sync so existing logic reading them still works
    if (BOT_UI.sportInput) BOT_UI.sportInput.value = BOT_CONFIG.sportName;
    if (BOT_UI.dayInput)   BOT_UI.dayInput.value   = BOT_CONFIG.day;
    if (BOT_UI.hourInput || BOT_UI.minuteInput || BOT_UI.ampmSel) {
      const p = parseTimeSlot(BOT_CONFIG.timeSlot) || { hour: "7", minute: "30", ampm: "p.m." };
      if (BOT_UI.hourInput)   BOT_UI.hourInput.value   = p.hour;
      if (BOT_UI.minuteInput) BOT_UI.minuteInput.value = p.minute;
      if (BOT_UI.ampmSel)     BOT_UI.ampmSel.value     = p.ampm;
    }

    if (!BOT_STATE.running) {
      BOT_STATE.stepDone = {};
      sSet(STORAGE_KEYS.stepDone, BOT_STATE.stepDone);
      resetVisualProcessSteps();
    } else {
      renderAllSteps();
    }

    if (BOT_STATE.running) {
      updateActionButton("stop");
      if (BOT_STATE.waitingUntilIso) {
        const msLeft = new Date(BOT_STATE.waitingUntilIso) - new Date();
        setStatus(`WAITING - ${formatDuration(Math.max(0, msLeft))}`, "waiting");
      }
      else setStatus("running...");
      return;
    }

    if (BOT_STATE.successMessage) {
      setStatus(BOT_STATE.successMessage, "success");
      updateActionButton("start");
      return;
    }

    const lastError = sGet(STORAGE_KEYS.lastError, "");
if (lastError) {
  // On fresh page load, do NOT keep Retry state
  sDel(STORAGE_KEYS.lastError);
  updateActionButton("start");
  setStatus("stopped", "stopped");
  return;
}

    if (!BOT_STATE.mailboxInitReady) {
      setStatus("initializing mailbox...", "waiting");
      updateActionButton("disabled");
      return;
    }

    updateActionButton("start");
    setStatus("stopped", "stopped");
  }
  // ==============================
  // DRAG & POSITIONING
  // ==============================
/**
 * Enables drag-and-drop repositioning of UI panel with persisted position.
 */
function makeUIDraggable() {
  const root = BOT_UI.root;
  const handle = root?.querySelector(".nb-header");
  if (!root || !handle) return;

  root.style.userSelect = "none";
  root.style.webkitUserSelect = "none";
  root.style.touchAction = "none";

  root.querySelectorAll("input, textarea").forEach((el) => {
    el.style.userSelect = "text";
    el.style.webkitUserSelect = "text";
  });

  handle.style.cursor = "grab";

  const getZoom = () => {
    const z = parseFloat(root.style.zoom || "1");
    return Number.isFinite(z) && z > 0 ? z : 1;
  };

  // normalize position to left/top (CSS px)
  const rect = root.getBoundingClientRect();
  const z0 = getZoom();
  root.style.left = `${rect.left / z0}px`;
  root.style.top = `${rect.top / z0}px`;
  root.style.right = "auto";
  root.style.bottom = "auto";

  let dragging = false;
  let pointerId = null;
  let grabOffsetX = 0; // CSS px
  let grabOffsetY = 0; // CSS px
  let targetLeft = parseFloat(root.style.left) || 0; // CSS px
  let targetTop = parseFloat(root.style.top) || 0;   // CSS px
  let raf = 0;

  const clamp = () => {
    const z = getZoom();
    const wCss = root.offsetWidth;   // CSS px
    const hCss = root.offsetHeight;  // CSS px
    const maxLeft = Math.max(0, window.innerWidth / z - wCss);
    const maxTop = Math.max(0, window.innerHeight / z - hCss);

    targetLeft = Math.min(maxLeft, Math.max(0, targetLeft));
    targetTop = Math.min(maxTop, Math.max(0, targetTop));
  };

  const render = () => {
    raf = 0;
    root.style.left = `${targetLeft}px`;
    root.style.top = `${targetTop}px`;
  };

  const scheduleRender = () => {
    if (!raf) raf = requestAnimationFrame(render);
  };

  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;

    const z = getZoom();
    const r = root.getBoundingClientRect(); // viewport px

    dragging = true;
    pointerId = e.pointerId;
    handle.setPointerCapture(pointerId);
    handle.style.cursor = "grabbing";

    // convert viewport delta to CSS px
    grabOffsetX = (e.clientX - r.left) / z;
    grabOffsetY = (e.clientY - r.top) / z;

    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;

    const z = getZoom();

    // convert pointer position to CSS px, preserve grab offset
    targetLeft = e.clientX / z - grabOffsetX;
    targetTop = e.clientY / z - grabOffsetY;

    clamp();
    scheduleRender();
  };

  const onUp = (e) => {
    if (!dragging || (e && e.pointerId !== pointerId)) return;

    dragging = false;
    handle.style.cursor = "grab";
    try { handle.releasePointerCapture(pointerId); } catch {}
    pointerId = null;

    sSet(STORAGE_KEYS.uiLeft, targetLeft); // store CSS px
    sSet(STORAGE_KEYS.uiTop, targetTop);   // store CSS px
  };

  handle.addEventListener("pointerdown", onDown, { passive: false });
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerup", onUp, { passive: true });
  window.addEventListener("pointercancel", onUp, { passive: true });

  window.addEventListener("resize", () => {
    clamp();
    scheduleRender();
  });


  const savedLeft = Number(sGet(STORAGE_KEYS.uiLeft, NaN));
  const savedTop = Number(sGet(STORAGE_KEYS.uiTop, NaN));
  if (Number.isFinite(savedLeft) && Number.isFinite(savedTop)) {
    targetLeft = savedLeft;
    targetTop = savedTop;
  }

  clamp();
  scheduleRender();
}

  // ==============================
  // COMMAND ENTRYPOINTS
  // ==============================
  /**
   * Public command entrypoint for start/stop actions.
   */
  async function bot_main(cmd) {
  if (cmd === "start") {
    // reset stale errors
    sDel(STORAGE_KEYS.lastError);
    BOT_STATE.lastRunSuccessful = false;
    BOT_STATE.successMessage = "";
    sDel(STORAGE_KEYS.successMessage);

    // keep selected mode
    BOT_STATE.mode = BOT_UI.modeSel ? BOT_UI.modeSel.value : BOT_STATE.mode;
    sSet(STORAGE_KEYS.mode, BOT_STATE.mode);

    // Final safety gate: ensure inbox is empty at Start press
    setStatus("checking mailbox...", "waiting");
    updateActionButton("disabled");

    const inboxOk = await clearInbox();
    if (!inboxOk) {
      setStatus("mailbox not empty - retry", "error");
      updateActionButton("retry");
      sSet(STORAGE_KEYS.lastError, "Mailbox was not empty at start");
      saveState();
      return;
    }

    logLine("Mailbox confirmed empty at start", true);

    beginRun();
    return;
  }

  if (cmd === "stop") {
    stopBot("Stopped by user", false);
    return;
  }
}


  /**

   * Auto-resumes active runs after navigation/reload when applicable.

   */

  function autoResumeIfRunning() {
    if (!BOT_STATE.running) return;

    const isAllowedDomain =
      location.origin === BOT_CONFIG.origin ||
      location.origin === "https://reservation.frontdesksuite.ca";

    if (!isAllowedDomain) {
      stopBot(`Wrong domain: ${location.origin}`, true);
      saveState();
      return;
    }

    updateActionButton("stop");

    if (BOT_STATE.mode === "SCHEDULE_RUN") {
      if (BOT_STATE.waitingUntilIso) {
        startLiveWaitLoop();
      } else {
        const hasProgress = Object.values(BOT_STATE.stepDone).some(v => v === true);
        if (!hasProgress && !isMainPageLoaded()) {
          goToMainEntry();
          return;
        }
        startLoopNow();
      }
    } else {
      const hasProgress = Object.values(BOT_STATE.stepDone).some(v => v === true);
      if (!hasProgress && !isMainPageLoaded()) {
        goToMainEntry();
        return;
      }
      startLoopNow();
    }
  }

  // ==============================
  // BOOTSTRAP
  // ==============================
  loadState();


  if (!BOT_STATE.running) {
    BOT_STATE.mailboxInitReady = false;
    sSet(STORAGE_KEYS.mailboxInitReady, false);
  }

  uiInject();
  syncUIFromState();

  window.bot_main = bot_main;
  window.con_main = con_main;
  window.con_group = con_group;
  window.con_timeselect = con_timeselect;
  window.con_contact = con_contact;
  window.con_verify = con_verify;
  window.con_confirm = con_confirm;

  (async () => {

    if (!BOT_STATE.running && !BOT_STATE.mailboxInitReady) {
      setStatus("initializing mailbox...", "waiting");
      updateActionButton("disabled");
      await runMailboxInit();
    }

    syncUIFromState();
    autoResumeIfRunning();
  })();
})();