// server.js

import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(morgan("dev"));

// serve static files (HTML, JS, CSS, images)
app.use(express.static("public", {
  etag: true,
  lastModified: true,
  setHeaders(res, path) {
    if (path.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    } else if (/\.(?:js|css|png|svg|webmanifest|json|ico)$/i.test(path)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  }
}));

// add this block ONCE, directly below the one above
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.removeHeader("Cache-Control");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});


const {
  WSDOT_API_KEY: KEY,
  ROUTE_ID = "5",
  SEA_TERMINAL_ID = "3",
  BI_TERMINAL_ID = "7",
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
    const norm = s => String(s || "")
    .toLowerCase()
    .replace(/^m\/?v\.?\s+/i, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();

    // Per-vessel overrides when the feed’s deck spaces don’t match app capacity
    const CAP_OVERRIDES = {
    tacoma: 197,
    wenatchee: 197
    };

    (Array.isArray(stats) ? stats : []).forEach(v => {
    const deckTotal = Number(v.RegDeckSpace || 0) + Number(v.TallDeckSpace || 0);

    // Prefer VehicleCount if provided, else deck spaces, else MaxVehicleCount
    let total = (v.VehicleCount != null ? Number(v.VehicleCount) : null);
    if (total == null) total = (deckTotal || null);
    if (total == null && v.MaxVehicleCount != null) total = Number(v.MaxVehicleCount);

    const nameRaw = v.VesselName || "";
    const nameKey = norm(nameRaw);

    // Apply override last
    if (nameKey in CAP_OVERRIDES) total = CAP_OVERRIDES[nameKey];

    if (nameRaw) capByVessel[nameKey] = (typeof total === "number" && isFinite(total)) ? total : null;
});




    // schedule today => TerminalCombos[*].Times[*].DepartingTime
    const tObj = Array.isArray(todayRaw) ? todayRaw[0] : todayRaw;
    const combos = Array.isArray(tObj?.TerminalCombos) ? tObj.TerminalCombos : [];
    const now = Date.now();
    const SEA_ID = Number(SEA_TERMINAL_ID);
    const BI_ID  = Number(BI_TERMINAL_ID);



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

        // WSDOT fixed IDs: 7 = Seattle, 3 = Bainbridge Island
        const direction =
        depTid === 7 ? "Leave Seattle" :
        depTid === 3 ? "Leave Bainbridge Island" :
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
    const nextSEA = pickNearest(entries, SEA_ID);
    const nextBI  = pickNearest(entries, BI_ID);


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
    const seaTerminalObj = extractTerminal(sea, SEA_ID);
    const biTerminalObj  = extractTerminal(bi,  BI_ID);


    const seaAvail = nextSEA ? matchSpaceFromTerminal(seaTerminalObj, nextSEA.dep, BI_ID) : null;
    const biAvail  = nextBI  ? matchSpaceFromTerminal(biTerminalObj,  nextBI.dep,  SEA_ID) : null;


    // live vessel ETAs and last arrivals
    const etaByVessel = {};
    const arrivedByVessel = {};
    (Array.isArray(locs) ? locs : []).forEach(v => {
    const name = v.VesselName;
    // WSDOT uses several keys across endpoints; accept all known variants
    const eta  = parseWsdotDate(v.Eta ?? v.ETA ?? v.EstimatedArrival);
    const arr  = parseWsdotDate(
        v.Arrived ??
        v.Arrival ??
        v.ActualArrival ??
        v.ArrivedUTC ??
        v.ActualArrivalTime ??
        null
    );
    if (name) {
        if (eta) etaByVessel[name] = eta;
        if (arr) arrivedByVessel[name] = arr;
      }
    });

    // Live maps:
    // 1) by route: "<depId>-<arrId>" -> {...}
    // 2) by vessel: "<VesselName>" -> { depId, arrId, leftDock, eta }
    const liveByRoute = {};
    const liveByVessel = {};

    (Array.isArray(locs) ? locs : []).forEach(v => {
    const depId = Number(v.DepartingTerminalID ?? v.OriginTerminalID ?? 0);
    const arrId = Number(v.ArrivingTerminalID  ?? v.DestinationTerminalID ?? 0);
    if (!depId || !arrId) return;

    const vesselName = String(v.VesselName || "");
    const leftDock   = parseWsdotDate(v.LeftDock ?? v.DepartedUTC ?? v.DepartureTime);
    const eta        = parseWsdotDate(v.Eta ?? v.ETA ?? v.EstimatedArrival);

    liveByRoute[`${depId}-${arrId}`] = { vesselName, leftDock, eta };
    if (vesselName) liveByVessel[vesselName] = { depId, arrId, leftDock, eta };
    });

    function shape(row, driveUpAvail, destTid) {

    if (!row) return null;

    // Live match for this specific direction (departing terminal -> destination terminal)
    const liveKey = `${row.termId}-${Number(destTid)}`;
    const live = liveByRoute[liveKey] || null;

    // Vessel and capacities
    const vessel = (live?.vesselName && live.vesselName.trim()) ? live.vesselName : (row.vessel || row.Vessel || row.BoatName || "");
    const capacity = vessel ? (capByVessel[norm(vessel)] ?? null) : null;

    // Times
    // row.dep is a Date object you built earlier from WSDOT (next scheduled or current trip’s dep)
    const scheduledDepartureTime_local = hhmm(row.dep);         // schedule
    const liveDepart_local            = hhmm(live?.leftDock);   // live actual depart, if in transit
    let eta_local = live?.eta ? hhmm(live.eta) : null; // only when live matches this route
        if (live?.leftDock && live?.eta && live.eta < live.leftDock) eta_local = null; // guard: ETA cannot precede depart
    const arr_local                   = hhmm(arrivedByVessel[vessel]);            // last actual arrival if present

    // Use liveByVessel map built in pollOnce()
    const liveV = vessel ? liveByVessel[vessel] : null;
    const liveDepart_byVessel = liveV?.leftDock ? hhmm(liveV.leftDock) : null;


    // underway if either route- or vessel-based live depart exists
    const status = (liveV?.leftDock || live?.leftDock) ? "inTransit" : "scheduled";

    // final displayed departure: vessel live > route live > schedule
    const departure_local = liveDepart_byVessel || liveDepart_local || scheduledDepartureTime_local;

    // fill ETA from by-vessel if route match missed it
    if (!eta_local && liveV?.eta) eta_local = hhmm(liveV.eta);

    // Car space
    const carSlotsTotal     = capacity;
    const carSlotsAvailable = (typeof driveUpAvail === "number") ? driveUpAvail : null;

    // Prefer live dep/arr by vessel when underway; else fall back to scheduled IDs
    let originId = row.termId;
    let destId   = Number(destTid);

    // Use liveByVessel map built in pollOnce()
    if (liveV && liveV.leftDock) {
    if (typeof liveV.depId === "number" && typeof liveV.arrId === "number" && liveV.depId && liveV.arrId) {
        originId = liveV.depId;
        destId   = liveV.arrId;
    }
    }

    // Names by terminal ID (WSDOT: 7=Seattle, 3=Bainbridge Island)
    const fromName =
    originId === 7 ? "Seattle" :
    originId === 3 ? "Bainbridge Island" : null;

    const toName =
    destId === 3 ? "Bainbridge Island" :
    destId === 7 ? "Seattle" : null;

    // Direction string
    const direction = (fromName && toName)
    ? `${fromName} → ${toName}`
    : (row.direction || row.Direction || row.SailingDir || "");

    return {
        vessel,
        direction,

        // Keep existing keys your UI already reads
        departureTime: departure_local,               // live when available, else schedule
        estimatedArrivalTime: eta_local,
        actualArrivalTime: (status === "inTransit") ? null : arr_local,
        carSlotsTotal,
        carSlotsAvailable,

        // Add explicit fields for clarity if you want the UI to switch logic later

        scheduledDepartureTime: scheduledDepartureTime_local,
        actualDepartureTime: liveDepart_local,
        status,
        originTerminalId: row.termId,
        destinationTerminalId: Number(destTid),

        // Debug passthrough of the upstream row (leave if useful)
        _row: row
    };
    }

    let summary = [
    // Seattle -> Bainbridge
    nextSEA ? shape(nextSEA, seaAvail, BI_ID) : null,
    // Bainbridge -> Seattle
    nextBI  ? shape(nextBI,  biAvail,  SEA_ID) : null
    ].filter(Boolean);

    // If both rows show the same vessel name, prefer live route-matched names
    if (summary.length === 2 &&
        summary[0].vessel && summary[1].vessel &&
        summary[0].vessel === summary[1].vessel) {
    const liveA = liveByRoute[`${SEA_ID}-${BI_ID}`]?.vesselName || null;
    const liveB = liveByRoute[`${BI_ID}-${SEA_ID}`]?.vesselName || null;
    if (liveA) summary[0].vessel = liveA;
    if (liveB) summary[1].vessel = liveB;
    }

    const liveNames = Object.keys(liveByVessel || {});
    console.log("[poll] picks", {
        nextSEA: nextSEA?.vessel || null,
        nextBI: nextBI?.vessel || null,
        live: liveNames
    });


    cache = {
        summary,
        lastError: null,
        lastFetchedAt: Date.now(),
        debug: {
            locs, entries, nextSEA, nextBI, seaTerminalObj, biTerminalObj,
            capByVessel,            // add for verification
            stats                   // raw vessel stats for field inspection
  }
};

  } catch (e) {
    cache.lastError = e.message || String(e);
  }
}


setInterval(pollOnce, INTERVAL);
pollOnce(); // kick off immediately

// API
app.get("/api/summary", (req, res) => res.json(cache.summary));
app.get("/api/raw", (req, res) => res.json(cache));
// Shows the live vessel fields we need, from the existing cache.debug.locs
app.get("/api/peek", (req, res) => {
  try {
    const locs = Array.isArray(cache?.debug?.locs) ? cache.debug.locs : [];
    const out = locs.map(l => ({
      vesselName: String(l?.VesselName ?? ""),
      departingTerminalId: Number(l?.DepartingTerminalID ?? l?.OriginTerminalID ?? NaN),
      arrivingTerminalId: Number(l?.ArrivingTerminalID ?? l?.DestinationTerminalID ?? NaN),
      leftDock: l?.LeftDock ?? l?.DepartedUTC ?? l?.DepartureTime ?? null,
      eta: l?.Eta ?? l?.ETA ?? l?.EstimatedArrival ?? null,
      atDock: Boolean(l?.AtDock ?? (l?.Status === "Docked"))
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "peek failed", detail: String(e?.message || e) });
  }
});

// Quick probe: raw stats for a vessel (defaults to Tacoma).
// Usage: /api/peekStats?v=Tacoma
app.get("/api/peekStats", async (req, res) => {
  try {
    const q = String(req.query.v || "Tacoma").trim().toLowerCase();
    const stats = await getJson(URLS.stats);
    const match = (Array.isArray(stats) ? stats : []).find(s => {
      const name = String(s?.VesselName || "").trim().toLowerCase()
        .replace(/^m\/?v\.?\s+/i, "");
      return name === q;
    });
    if (!match) return res.json({ error: "vessel not found", query: q });

    // Return all numeric-looking fields to see what 270 comes from
    const numeric = {};
    Object.keys(match).forEach(k => {
      const v = match[k];
      if (typeof v === "number") numeric[k] = v;
    });

    res.json({
      vessel: match.VesselName || null,
      numeric,
      deckSum: Number(match.RegDeckSpace || 0) + Number(match.TallDeckSpace || 0)
    });
  } catch (e) {
    res.status(500).json({ error: "peekStats failed", detail: String(e?.message || e) });
  }
});

app.get("/api/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.json({
    lastFetchedAt: cache.lastFetchedAt,
    lastError: cache.lastError,
    items: cache.summary.length
  });
});

app.get("/api/flat", (req, res) => res.json(cache.summary));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
