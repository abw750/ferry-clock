const els = {
  out: document.getElementById("output"),
  status: document.getElementById("status"),
  count: document.getElementById("count"),
  next: document.getElementById("next"),
  refreshBtn: document.getElementById("refresh"),
  toggleBtn: document.getElementById("toggle"),
};

const INTERVAL_MS = 60_000;
let nextAt = 0;
let countdownTimer = null;
let showRaw = false;

init();

function init() {
  els.refreshBtn.addEventListener("click", doRefresh);
  els.toggleBtn.addEventListener("click", () => {
    showRaw = !showRaw;
    els.toggleBtn.textContent = showRaw ? "Show flat" : "Show raw";
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
    els.next.textContent = `next in ${sLeft}s`;
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
    els.out.textContent = pretty(raw);
    els.count.textContent = `${sizeOf(raw)} fields`;
  } else {
    const flat = await getJson("/api/flat");
    els.out.textContent = renderFlat(flat);
    els.count.textContent = `${Object.keys(flat || {}).length} items`;
  }
}

function renderFlat(obj) {
  if (!obj || typeof obj !== "object") return "(no data)";
  const keys = Object.keys(obj).sort();
  return keys.map(k => `${k}: ${format(obj[k])}`).join("\n");
}
function format(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function pretty(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function sizeOf(v) { return v && typeof v === "object" ? Object.keys(v).length : 1; }

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
  els.status.textContent = msg;
  els.status.className = isErr ? "err" : "";
}
function noop() {}
