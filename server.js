import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(morgan("dev"));
app.use(express.static("public"));

const {
  WSDOT_API_KEY: KEY,
  ROUTE_ID = "5",
  SEA_TERMINAL_ID = "7",
  BI_TERMINAL_ID = "3",
  POLL_MS = "60000",
} = process.env;

const BASE = "https://www.wsdot.wa.gov/Ferries/API";
const URLS = {
  today: `${BASE}/Schedule/rest/scheduletoday/${ROUTE_ID}/true?apiaccesscode=${KEY}`,
  vesselLoc: `${BASE}/Vessels/rest/vessellocations?apiaccesscode=${KEY}`,
  spaceSEA: `${BASE}/Terminals/rest/terminalsailingspace?apiaccesscode=${KEY}&terminalid=${SEA_TERMINAL_ID}&route=${ROUTE_ID}`,
  spaceBI: `${BASE}/Terminals/rest/terminalsailingspace?apiaccesscode=${KEY}&terminalid=${BI_TERMINAL_ID}&route=${ROUTE_ID}`,
  stats: `${BASE}/Vessels/rest/vesselstats?apiaccesscode=${KEY}`,
};

let cache = { summary: [], lastError: null, lastFetchedAt: 0 };

const INTERVAL = Math.max(15000, Number(POLL_MS) || 60000);

function parseWsdotDate(d) {
  // "/Date(1762560000000-0800)/" => 1762560000000
  if (!d) return null;
  const m = String(d).match(/\d+/);
  return m ? new Date(Number(m[0])) : null;
}
function hhmm(t) {
  if (!t) return null;
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function getJson(u) {
  // Timeout without AbortController
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("timeout")), 12000)
  );
  const res = await Promise.race([fetch(u, { headers: { "accept": "application/json" } }), timeout]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

async function pollOnce() {
  try {
    const [todayRaw, locs, sea, bi, stats] = await Promise.all([
      getJson(URLS.today),
      getJson(URLS.vesselLoc),
      getJson(URLS.spaceSEA),
      getJson(URLS.spaceBI),
      getJson(URLS.stats),
    ]);

    // capacities by vessel name
    const capByVessel = {};
    (Array.isArray(stats) ? stats : []).forEach(v => {
      const total = (v.RegDeckSpace || 0) + (v.TallDeckSpace || 0);
      if (v.VesselName) capByVessel[v.VesselName] = total;
    });

    // schedule today => TerminalCombos[*].Times[*].DepartingTime
    const tObj = Array.isArray(todayRaw) ? todayRaw[0] : todayRaw;
    const combos = Array.isArray(tObj?.TerminalCombos) ? tObj.TerminalCombos : [];
    const now = Date.now();

    // build nearest departure per departing terminal
    const entries = combos.flatMap(c => {
      const depTid = c.DepartingTerminalID;
      const times = Array.isArray(c.Times) ? c.Times : [];

      const sorted = times
        .map(x => ({ ...x, depTs: parseWsdotDate(x.DepartingTime) }))
        .filter(x => x.depTs)
        .sort((a, b) => a.depTs - b.depTs);

      const next = sorted.find(x => x.depTs.getTime() >= now) || sorted[sorted.length - 1];
      if (!next) return [];

      const direction =
        depTid === Number(SEA_TERMINAL_ID) ? "Leave Seattle" :
        depTid === Number(BI_TERMINAL_ID)  ? "Leave Bainbridge Island" :
        `Leave ${c.DepartingTerminalName || depTid}`;

      return [{
        direction,
        vessel: next.VesselName || null,
        termId: depTid,
        dep: next.depTs
      }];
    });

    // pick nearest (pref future) for SEA and BBI
    function pickNearest(arr, termId) {
      const list = arr.filter(x => x.termId === Number(termId)).sort((a,b)=>a.dep-b.dep);
      if (!list.length) return null;
      const i = list.findIndex(x => x.dep.getTime() >= now);
      return i >= 0 ? list[i] : list[list.length-1];
    }
    const nextSEA = pickNearest(entries, SEA_TERMINAL_ID);
    const nextBI  = pickNearest(entries, BI_TERMINAL_ID);

    // terminal sailings space => array of terminals; each has DepartingSpaces[*]
    function extractTerminal(spaceArr, terminalId) {
      const list = Array.isArray(spaceArr) ? spaceArr : [];
      return list.find(t => t && t.TerminalID === Number(terminalId)) || null;
    }
    function matchSpaceFromTerminal(terminalObj, depDate, arrivalTid) {
      if (!terminalObj || !depDate) return null;
      const recs = Array.isArray(terminalObj.DepartingSpaces) ? terminalObj.DepartingSpaces : [];

      // note: field name is "Departure" here (not DepartingTime)
      const target = depDate.getTime();
      let best = null, bestDelta = Infinity;
      for (const r of recs) {
        const t = parseWsdotDate(r.Departure)?.getTime();
        if (!t) continue;
        const d = Math.abs(t - target);
        if (d < bestDelta) { best = r; bestDelta = d; }
      }
      if (!best || bestDelta > 10 * 60 * 1000) return null;

      const arrs = Array.isArray(best.SpaceForArrivalTerminals) ? best.SpaceForArrivalTerminals : [];
      const match = arrs.find(a => a.TerminalID === Number(arrivalTid)) || arrs[0];
      if (!match) return null;

      return match.DisplayDriveUpSpace ? (match.DriveUpSpaceCount ?? null) : null;
    }
    const seaTerminalObj = extractTerminal(sea, SEA_TERMINAL_ID);
    const biTerminalObj  = extractTerminal(bi,  BI_TERMINAL_ID);

    const seaAvail = nextSEA ? matchSpaceFromTerminal(seaTerminalObj, nextSEA.dep, BI_TERMINAL_ID) : null;
    const biAvail  = nextBI  ? matchSpaceFromTerminal(biTerminalObj,  nextBI.dep,  SEA_TERMINAL_ID) : null;

    // live vessel ETAs and last arrivals
    const etaByVessel = {};
    const arrivedByVessel = {};
    (Array.isArray(locs) ? locs : []).forEach(v => {
      const name = v.VesselName;
      const eta  = parseWsdotDate(v.Eta);
      const arr  = parseWsdotDate(v.Arrived);
      if (name) {
        if (eta) etaByVessel[name] = eta;
        if (arr) arrivedByVessel[name] = arr;
      }
    });

    function shape(row, driveUpAvail) {
      if (!row) return null;
      const vessel = row.vessel || null;
      const capacity = vessel ? capByVessel[vessel] ?? null : null;
      return {
        vessel,
        direction: row.direction || null,
        departureTime: hhmm(row.dep),
        estimatedArrivalTime: hhmm(etaByVessel[vessel]),
        actualArrivalTime: hhmm(arrivedByVessel[vessel]),
        carSlotsTotal: capacity,
        carSlotsAvailable: driveUpAvail,
      };
    }

    const summary = [shape(nextSEA, seaAvail), shape(nextBI, biAvail)].filter(Boolean);
    cache = { summary, lastError: null, lastFetchedAt: Date.now() };
  } catch (e) {
    cache.lastError = e.message || String(e);
  }
}


setInterval(pollOnce, INTERVAL);
pollOnce(); // kick off immediately

// API
app.get("/api/summary", (req, res) => res.json(cache.summary));
app.get("/api/status",  (req, res) => res.json({
  lastFetchedAt: cache.lastFetchedAt,
  lastError: cache.lastError,
  items: cache.summary.length
}));
app.get("/api/flat", (req, res) => res.json(cache.summary));

app.listen(8000, () => console.log("Server http://localhost:8000"));
