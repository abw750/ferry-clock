// public/app.js — UI table + clock wiring (defensive)
console.log("app.js loaded v=fc4");

const els = {
  out: document.getElementById("output"),
  status: document.getElementById("status"),
  count: document.getElementById("count"),
  next: document.getElementById("next"),
  refreshBtn: document.getElementById("refresh"),
  toggleBtn: document.getElementById("toggle"),
};

const INTERVAL_MS = 60_000;

// normalize actual-arrival field from API, with key scan fallback
function getActualArrival(r) {
  // common names first
  const v =
    r?.actualArrivalTime ??
    r?.actualArrival ??
    r?.arrivalTime ??
    r?.actualTimeOfArrival ??
    r?.actualArrivalDateTime ??
    null;
  if (v != null && v !== "") return v;

  // fallback: scan any key containing "arriv"
  const obj = r || {};
  for (const k of Object.keys(obj)) {
    if (/arriv/i.test(k)) {
      const val = obj[k];
      if (val != null && val !== "") return val;
    }
  }
  return null;
}


// --- helpers (top-level) ---
if (typeof nz !== "function") {
  // fallback to avoid hard failures
  window.nz = v => (v ?? "") !== "" ? String(v) : "—";
}
if (typeof nzi !== "function") {
  window.nzi = v => {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : "—";
  };
}

let nextAt = 0;
let countdownTimer = null;
let showRaw = false;
let tableEl = null; // created on demand

init();

function init() {
  if (!els.refreshBtn || !els.toggleBtn) {
    console.error("app.js: required DOM elements missing");
    return;
  }
  els.refreshBtn.addEventListener("click", doRefresh);
  els.toggleBtn.addEventListener("click", () => {
    showRaw = !showRaw;
    els.toggleBtn.textContent = showRaw ? "Show table" : "Show raw";
    fetchAndRender().catch(noop);
  });
  fetchAndRender().catch(noop);
  scheduleLoop();
}

function scheduleLoop() {
  nextAt = Date.now() + INTERVAL_MS;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const msLeft = Math.max(0, nextAt - Date.now());
    const sLeft = Math.ceil(msLeft / 1000);
    if (els.next) els.next.textContent = `next in ${sLeft}s`;
    if (msLeft <= 0) {
      clearInterval(countdownTimer);
      fetchAndRender().catch(noop).finally(scheduleLoop);
    }
  }, 250);
}

async function doRefresh() {
  setStatus("Requesting immediate refresh...");
  await fetch("/api/refresh", { method: "POST" }).catch(noop);
  await fetchAndRender().catch(noop);
  scheduleLoop();
}

async function fetchAndRender() {
  setStatus("Loading...");
  const status = await getJson("/api/status");
  if (status?.lastError) {
    setStatus(`Backend error: ${status.lastError}`, true);
  } else {
    const ts = status?.lastFetchedAt ? new Date(status.lastFetchedAt).toLocaleTimeString() : "n/a";
    setStatus(`Fetched at ${ts}`);
  }

  if (showRaw) {
    const raw = await getJson("/api/raw");
    ensurePre();
    els.out.textContent = pretty(raw);
    els.count.textContent = countRaw(raw);
    return;
  }

  // table view using /api/summary
  let summary = await getJson("/api/summary");
  if (!Array.isArray(summary)) summary = [];

// DEBUG: log first two ferry rows for verification
(function() {
  const slice = summary.slice(0, 2);
  const names   = slice.map(r => r?.vessel || null);
  const origins = slice.map(r => r?.originTerminalId || null);
  const dests   = slice.map(r => r?.destinationTerminalId || null);
  const status  = slice.map(r => r?.status || null);
  console.log("summary[0..1]", { names, origins, dests, status });

  // ARRIVAL FIELD DIAG
slice.forEach((r, i) => {
  const keys = Object.keys(r || {});
  const arrivalKeys = keys.filter(k => /arriv/i.test(k));
  const diag = {};
  arrivalKeys.forEach(k => { diag[k] = r[k]; });
  console.log(`ARRIVAL DIAG [${i}] ${r?.vessel || "?"}:`, diag);
});
// Tacoma-specific dump
const tac = summary.find(r => r?.vessel === "Tacoma");
console.log("ARRIVAL DIAG Tacoma full keys:", tac ? Object.keys(tac) : "not found");
if (tac) {
  const tdiag = {};
  Object.keys(tac).forEach(k => { if (/arriv/i.test(k)) tdiag[k] = tac[k]; });
  console.log("ARRIVAL DIAG Tacoma arrivals:", tdiag);
}


  // DIAG: scheduled rows lacking actual arrival across possible keys
  const schedNoArr = summary.filter(r =>
    String(r?.status || "").toLowerCase() !== "intransit" &&
    !getActualArrival(r)
  );
  if (schedNoArr.length) {
    console.log("DIAG scheduled-without-actualArrival:", schedNoArr.map(r => r.vessel));
    schedNoArr.slice(0, 2).forEach((r, i) => {
      console.log(`DIAG row[${i}] full:`, r);
      console.log(`DIAG row[${i}] keys:`, Object.keys(r));
    });
  }
})();


  ensureTable();
  renderSummaryTable(summary);

  // update the clock, if available (never throw)
  try {
    if (window.ferry && typeof window.ferry.setData === "function" && typeof window.ferry.render === "function") {
      window.ferry.setData(summary);
      window.ferry.render();
    } else if (typeof window.updateFerryClock === "function") {
      window.updateFerryClock(summary);
    }
  }

  catch (e) {
    console.warn("ferry render failed:", e);
  }

  els.count.textContent = `${summary.length} rows`;
}

// ---------- rendering ----------

function ensureTable() {
  if (tableEl) return;
  try {
    tableEl = document.createElement("table");
    tableEl.setAttribute("id", "summaryTable");
    tableEl.style.width = "100%";
    tableEl.style.borderCollapse = "collapse";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const cols = [
      "Vessel",
      "Direction",
      "Scheduled departure",
      "Actual departure time",
      "Estimated Arrival Time",
      "Actual time of arrival",
      "Car slots total",
      "Car slots available",
      "Status"
    ];
    cols.forEach(c => {
      const th = document.createElement("th");
      th.textContent = c;
      th.style.textAlign = "left";
      th.style.border = "1px solid #ddd";
      th.style.padding = "6px 8px";
      th.style.fontSize = "14px";
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tableEl.appendChild(thead);

    const tbody = document.createElement("tbody");
    tableEl.appendChild(tbody);

    // swap the <pre id="output"> for the table, keep a hidden pre for raw view
    els.out.replaceWith(tableEl);
    const pre = document.createElement("pre");
    pre.id = "output";
    pre.className = "output";
    pre.style.display = "none";
    tableEl.after(pre);
    els.out = pre;
  } catch (err) {
    console.error("table render error:", err);
  }
}

function ensurePre() {
  if (!els.out || els.out.tagName !== "PRE") {
    const pre = document.getElementById("output");
    if (pre) {
      els.out = pre;
      els.out.style.display = "";
    } else {
      els.out = document.createElement("pre");
      els.out.id = "output";
      els.out.className = "output";
      tableEl ? tableEl.after(els.out) : document.body.appendChild(els.out);
    }
  }
  if (tableEl) { tableEl.remove(); tableEl = null; }
}

function renderSummaryTable(rows) {
  const tbody = tableEl.querySelector("tbody");
  tbody.innerHTML = "";
  const safe = rows.slice(0, 2); // deterministic two rows
  safe.forEach(r => {
    const tr = document.createElement("tr");
    const cells = [
      nz(r?.vessel),
      nz(r?.direction),
      nz(r?.scheduledDepartureTime),   // explicitly scheduled
      nz(r?.actualDepartureTime),      // new column
      nz(r?.estimatedArrivalTime),
      nz(getActualArrival(r)), 
      nzi(r?.carSlotsTotal),
      nzi(r?.carSlotsAvailable),
      nz(r?.status === "inTransit" ? "Underway" : "At dock"),
    ];


    cells.forEach(val => {
      const td = document.createElement("td");
      td.textContent = val;
      td.style.border = "1px solid #ddd";
      td.style.padding = "6px 8px";
      td.style.fontSize = "14px";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ---------- helpers ----------

function nz(v) { return v == null || v === "" ? "—" : String(v); }
function nzi(v) { return Number.isFinite(v) ? String(v) : "—"; }

function pretty(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function countRaw(v) {
  if (Array.isArray(v)) return `${v.length} items`;
  if (v && typeof v === "object") return `${Object.keys(v).length} fields`;
  return "1 value";
}

async function getJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    setStatus(`Fetch error: ${e.message || e}`, true);
    return null;
  }
}
function setStatus(msg, isErr = false) {
  if (!els.status) return;
  els.status.textContent = msg;
  els.status.className = isErr ? "err" : "";
}
function noop() {}
