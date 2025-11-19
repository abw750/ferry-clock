// server.js

import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(morgan("dev"));

// serve static files (HTML, JS, CSS, images)
app.use(
  express.static("public", {
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
    },
  })
);

// clear caching for API responses
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.removeHeader("Cache-Control");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});

const {
  WSDOT_API_KEY: KEY,
  ROUTE_ID,
  ROUTE_NAME,
  SEA_TERMINAL_ID,
  SEA_TERMINAL_NAME,
  BI_TERMINAL_ID,
  BI_TERMINAL_NAME,
  CROSSING_TIME_MINUTES,
  WEST_LABEL,
  EAST_LABEL,
  POLL_MS,
} = process.env;

const BASE = "https://www.wsdot.wa.gov/Ferries/API";
const URLS = {
  today: `${BASE}/Schedule/rest/scheduletoday/${ROUTE_ID}/true?apiaccesscode=${KEY}`,
  vesselLoc: `${BASE}/Vessels/rest/vessellocations?apiaccesscode=${KEY}`,
  spaceSEA: `${BASE}/Terminals/rest/terminalsailingspace?apiaccesscode=${KEY}&terminalid=${SEA_TERMINAL_ID}&route=${ROUTE_ID}`,
  spaceBI: `${BASE}/Terminals/rest/terminalsailingspace?apiaccesscode=${KEY}&terminalid=${BI_TERMINAL_ID}&route=${ROUTE_ID}`,
  stats: `${BASE}/Vessels/rest/vesselstats?apiaccesscode=${KEY}`,
};

let cache = {
  summary: [],
  lastError: null,
  lastFetchedAt: 0,
  debug: {},
};

// Cannon dock: module-level per-vessel state
let prevLiveByVessel = {};      // last poll's live snapshot by vessel
const syntheticArrivals = {};   // synthesized arrival timestamps when a vessel disappears at/after ETA

// Cannon Dock: module-level per-vessel state (no output behavior yet)
const dockState = {
  // byVessel["Tacoma"] = {
  //   lastSeenMs: <timestamp>,
  //   lastStatus: "underway" | "notUnderway",
  //   lastSeenUnderwayMs: <timestamp | null>
  // }
  byVessel: Object.create(null),
};

function updateDockState(summary, liveByVessel, arrivedByVessel) {
  const now = Date.now();
  const map = dockState.byVessel;

  // Normalize summary array
  const rows = Array.isArray(summary) ? summary : [];

  // Collect vessel names from summary + liveByVessel
  const names = new Set();

  rows.forEach((r) => {
    const v = r && r.vessel && String(r.vessel).trim();
    if (v) names.add(v);
  });

  if (liveByVessel && typeof liveByVessel === "object") {
    Object.keys(liveByVessel).forEach((raw) => {
      const v = String(raw || "").trim();
      if (v) names.add(v);
    });
  }

  names.forEach((name) => {
    if (!name) return;

    const live = liveByVessel && liveByVessel[name] ? liveByVessel[name] : null;
    const lane = rows.find(
      (r) => r && String(r.vessel || "").trim() === name
    );

    const statusStr = String(lane?.status || "").toLowerCase();

    const isUnderway =
      statusStr === "intransit" ||
      Boolean(lane?.actualDepartureTime) ||
      Boolean(live?.leftDock);

    const prev = map[name] || {};

    let arrivalMs = prev.arrivalMs || null;
    let dockStartMs = prev.dockStartMs || null;
    let dockStartIsSynthetic = !!prev.dockStartIsSynthetic;

    // Cannon rule: when a previously-underway vessel is no longer underway,
    // treat that instant as arrival / dock start (once per dock cycle).
    if (prev.lastStatus === "underway" && !isUnderway) {
      if (!arrivalMs) {
        arrivalMs = now;
      }
      if (!dockStartMs) {
        dockStartMs = now;
        dockStartIsSynthetic = true;
      }
    }
    // If the live feed now exposes a concrete arrival time, let it refine
    // our synthetic anchor. This corrects the dock arc start once the
    // actual arrival is known.
    if (arrivedByVessel && arrivedByVessel[name] instanceof Date) {
      const arrDate = arrivedByVessel[name];
      const arrMs = arrDate.getTime();

      if (Number.isFinite(arrMs)) {
        // Always record the best-known arrival time
        if (!arrivalMs || Math.abs(arrMs - arrivalMs) > 30 * 1000) {
          arrivalMs = arrMs;
        }

        // If our dockStartMs was synthetic or missing, or clearly later
        // than the real arrival, snap the dock anchor back to the true arrival.
        if (
          !dockStartMs ||
          dockStartIsSynthetic ||
          arrMs < dockStartMs
        ) {
          dockStartMs = arrMs;
          dockStartIsSynthetic = false;
        }
      }
    }

    map[name] = {
      lastSeenMs: now,
      lastStatus: isUnderway ? "underway" : "notUnderway",
      lastSeenUnderwayMs: isUnderway
        ? now
        : prev.lastSeenUnderwayMs || null,
      arrivalMs,
      dockStartMs,
      dockStartIsSynthetic,
    };
  });
}


const INTERVAL = Math.max(15000, Number(POLL_MS) || 60000);


// // Track prior live vessel positions between polls and synthetic arrivals
// // when a vessel disappears near its expected arrival time.
// let prevLiveByVessel = {};   // { [vesselName]: { leftDockMs, etaMs } }
// let syntheticArrivals = {};  // { [vesselName]: Date }

function parseWsdotDate(d) {
  // "/Date(1762560000000-0800)/" -> 1762560000000
  if (!d) return null;
  const m = String(d).match(/\d+/);
  return m ? new Date(Number(m[0])) : null;
}

function hhmm(t) {
  if (!t) return null;
  return t.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

async function getJson(u) {
  // Timeout without AbortController
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("timeout")), 12000)
  );
  const res = await Promise.race([
    fetch(u, { headers: { accept: "application/json" } }),
    timeout,
  ]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

// route metadata helper: resilient, env-driven fallback
async function getRoutesSafe() {
  const base = "https://www.wsdot.wa.gov/Ferries/API";
  const url = `${base}/Routes/rest/routes?apiaccesscode=${KEY}`;

  try {
    const raw = await getJson(url);
    if (!Array.isArray(raw)) throw new Error("invalid payload");

    return raw.map((r) => ({
      routeId: Number(r.RouteID),
      name: r.RouteName || "",
      terminals: Array.isArray(r.Terminals)
        ? r.Terminals.map((t) => ({
            id: Number(t.TerminalID),
            name: t.TerminalName || "",
          }))
        : [],
    }));
  } catch {
    // fallback uses .env values only, no hard-coded text
    return [
      {
        routeId: Number(ROUTE_ID),
        name: ROUTE_NAME || "Unknown Route",
        terminals: [
          {
            id: Number(SEA_TERMINAL_ID),
            name: SEA_TERMINAL_NAME || String(SEA_TERMINAL_ID),
          },
          {
            id: Number(BI_TERMINAL_ID),
            name: BI_TERMINAL_NAME || String(BI_TERMINAL_ID),
          },
        ],
      },
    ];
  }
}

// polling logic, keeps existing summary shape
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
    const norm = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/^m\/?v\.?\s+/i, "")
        .replace(/\s*\(.*\)\s*$/, "")
        .trim();

    // per-vessel overrides when the feed deck spaces do not match app capacity
    const CAP_OVERRIDES = {
      tacoma: 197,
      wenatchee: 197,
    };

    (Array.isArray(stats) ? stats : []).forEach((v) => {
      const deckTotal =
        Number(v.RegDeckSpace || 0) + Number(v.TallDeckSpace || 0);

      // prefer VehicleCount if provided, else deck spaces, else MaxVehicleCount
      let total = v.VehicleCount != null ? Number(v.VehicleCount) : null;
      if (total == null) total = deckTotal || null;
      if (total == null && v.MaxVehicleCount != null) {
        total = Number(v.MaxVehicleCount);
      }

      const nameRaw = v.VesselName || "";
      const nameKey = norm(nameRaw);

      // apply override last
      if (nameKey in CAP_OVERRIDES) total = CAP_OVERRIDES[nameKey];

      if (nameRaw) {
        capByVessel[nameKey] =
          typeof total === "number" && isFinite(total) ? total : null;
      }
    });

    // schedule today -> TerminalCombos[*].Times[*].DepartingTime
    const tObj = Array.isArray(todayRaw) ? todayRaw[0] : todayRaw;
    const combos = Array.isArray(tObj?.TerminalCombos)
      ? tObj.TerminalCombos
      : [];
    const now = Date.now();
    const SEA_ID = Number(SEA_TERMINAL_ID);
    const BI_ID = Number(BI_TERMINAL_ID);

    // build nearest departure per departing terminal
    const entries = combos.flatMap((c) => {
      const depTid = c.DepartingTerminalID;
      const times = Array.isArray(c.Times) ? c.Times : [];

      const sorted = times
        .map((x) => ({ ...x, depTs: parseWsdotDate(x.DepartingTime) }))
        .filter((x) => x.depTs)
        .sort((a, b) => a.depTs - b.depTs);

      const next =
        sorted.find((x) => x.depTs.getTime() >= now) || sorted[sorted.length - 1];
      if (!next) return [];

      const direction =
        depTid === 7
          ? "Leave Seattle"
          : depTid === 3
          ? "Leave Bainbridge Island"
          : `Leave ${c.DepartingTerminalName || depTid}`;

      return [
        {
          direction,
          vessel: next.VesselName || null,
          termId: depTid,
          dep: next.depTs,
        },
      ];
    });

    // pick nearest (prefer future) for SEA and BI
    function pickNearest(arr, termId) {
      const list = arr
        .filter((x) => x.termId === Number(termId))
        .sort((a, b) => a.dep - b.dep);
      if (!list.length) return null;
      const i = list.findIndex((x) => x.dep.getTime() >= now);
      return i >= 0 ? list[i] : list[list.length - 1];
    }
    const nextSEA = pickNearest(entries, SEA_ID);
    const nextBI = pickNearest(entries, BI_ID);

    // terminal sailings space -> array of terminals; each has DepartingSpaces[*]
    function extractTerminal(spaceArr, terminalId) {
      const list = Array.isArray(spaceArr) ? spaceArr : [];
      return (
        list.find((t) => t && t.TerminalID === Number(terminalId)) || null
      );
    }

    function matchSpaceFromTerminal(terminalObj, depDate, arrivalTid) {
      if (!terminalObj || !depDate) return null;
      const recs = Array.isArray(terminalObj.DepartingSpaces)
        ? terminalObj.DepartingSpaces
        : [];

      const target = depDate.getTime();
      let best = null;
      let bestDelta = Infinity;
      for (const r of recs) {
        const t = parseWsdotDate(r.Departure)?.getTime();
        if (!t) continue;
        const d = Math.abs(t - target);
        if (d < bestDelta) {
          best = r;
          bestDelta = d;
        }
      }
      if (!best || bestDelta > 10 * 60 * 1000) return null;

      const arrs = Array.isArray(best.SpaceForArrivalTerminals)
        ? best.SpaceForArrivalTerminals
        : [];
      const match =
        arrs.find((a) => a.TerminalID === Number(arrivalTid)) || arrs[0];
      if (!match) return null;

      return match.DisplayDriveUpSpace ? match.DriveUpSpaceCount ?? null : null;
    }

    const seaTerminalObj = extractTerminal(sea, SEA_ID);
    const biTerminalObj = extractTerminal(bi, BI_ID);

    const seaAvail = nextSEA
      ? matchSpaceFromTerminal(seaTerminalObj, nextSEA.dep, BI_ID)
      : null;
    const biAvail = nextBI
      ? matchSpaceFromTerminal(biTerminalObj, nextBI.dep, SEA_ID)
      : null;

    // live vessel ETAs and last arrivals (from current locs)
    const etaByVessel = {};
    const arrivedByVessel = {};
    (Array.isArray(locs) ? locs : []).forEach((v) => {
      const name = v.VesselName;
      const eta = parseWsdotDate(
        v.Eta ?? v.ETA ?? v.EstimatedArrival ?? null
      );
      const arr = parseWsdotDate(
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

    // Fold in any synthetic arrivals created when a vessel disappeared
    Object.keys(syntheticArrivals).forEach((name) => {
      if (!arrivedByVessel[name]) {
        arrivedByVessel[name] = syntheticArrivals[name];
      }
    });


    // live maps
    const liveByRoute = {};
    const liveByVessel = {};

    (Array.isArray(locs) ? locs : []).forEach((v) => {
      const depId = Number(
        v.DepartingTerminalID ?? v.OriginTerminalID ?? 0
      );
      const arrId = Number(
        v.ArrivingTerminalID ?? v.DestinationTerminalID ?? 0
      );
      if (!depId || !arrId) return;

      const vesselName = String(v.VesselName || "");
      const leftDock = parseWsdotDate(
        v.LeftDock ?? v.DepartedUTC ?? v.DepartureTime ?? null
      );
      const eta = parseWsdotDate(
        v.Eta ?? v.ETA ?? v.EstimatedArrival ?? null
      );

      liveByRoute[`${depId}-${arrId}`] = { vesselName, leftDock, eta };
      if (vesselName) {
        liveByVessel[vesselName] = { depId, arrId, leftDock, eta };
      }
    });

      // Detect vessels that were underway last poll and have now disappeared.
    // If this happens very close to or after their ETA, treat disappearance as "arrived now".
    const CROSS_MIN =
      CROSSING_TIME_MINUTES != null ? Number(CROSSING_TIME_MINUTES) : null;
    const CROSS_MS =
      (Number.isFinite(CROSS_MIN) && CROSS_MIN > 0 ? CROSS_MIN : 35) *
      60 * 1000;
    const nowMs = Date.now();

    Object.keys(prevLiveByVessel).forEach((name) => {
      const prev = prevLiveByVessel[name];
      const stillLive = liveByVessel[name];
      if (stillLive) return; // still present in current feed

      if (!prev || !prev.leftDockMs) return;

      // Expected arrival: prior ETA if we had one; else leftDock + crossing time.
      const etaMs = prev.etaMs || (prev.leftDockMs + CROSS_MS);

      // If we've reached (or just pre-passed) expected arrival, synthesize an arrival.
      if (nowMs >= etaMs - 60 * 1000 && !syntheticArrivals[name]) {
        syntheticArrivals[name] = new Date(nowMs);
      }
    });

    // Snapshot current live map for the next poll.
    prevLiveByVessel = {};
    Object.keys(liveByVessel).forEach((name) => {
      const v = liveByVessel[name];
      prevLiveByVessel[name] = {
        leftDockMs: v.leftDock ? v.leftDock.getTime() : null,
        etaMs: v.eta ? v.eta.getTime() : null,
      };
    });

    function shape(row, driveUpAvail, destTid) {
      if (!row) return null;

      const liveKey = `${row.termId}-${Number(destTid)}`;
      const live = liveByRoute[liveKey] || null;

      const vessel = (live?.vesselName && live.vesselName.trim())
        ? live.vesselName
        : row.vessel || row.Vessel || row.BoatName || "";

      const capacity = vessel ? capByVessel[norm(vessel)] ?? null : null;

      const scheduledDepartureTime_local = hhmm(row.dep);
      const liveDepart_local = hhmm(live?.leftDock);

      let eta_local = live?.eta ? hhmm(live.eta) : null;
      if (live?.leftDock && live?.eta && live.eta < live.leftDock) {
        // defensive guard against bad ETA from source
        eta_local = null;
      }

      const arr_local = hhmm(arrivedByVessel[vessel]);

      const liveV = vessel ? liveByVessel[vessel] : null;
      const liveDepart_byVessel = liveV?.leftDock ? hhmm(liveV.leftDock) : null;

      const status = liveV?.leftDock || live?.leftDock ? "inTransit" : "scheduled";

      const departure_local =
        liveDepart_byVessel || liveDepart_local || scheduledDepartureTime_local;

      if (!eta_local && liveV?.eta) {
        eta_local = hhmm(liveV.eta);
      }

      const carSlotsTotal = capacity;
      const carSlotsAvailable =
        typeof driveUpAvail === "number" ? driveUpAvail : null;

      // Base routing on the schedule row.
      let originId = row.termId;
      let destId = Number(destTid);

      // Only override origin/dest when we are confident this row is the
      // same sailing as the live vessel (matching dep/arr IDs).
      if (
        liveV &&
        liveV.leftDock &&
        typeof liveV.depId === "number" &&
        typeof liveV.arrId === "number" &&
        liveV.depId &&
        liveV.arrId &&
        originId === liveV.depId &&
        destId === liveV.arrId
      ) {
        originId = liveV.depId;
        destId = liveV.arrId;
      }

      const fromName =
        originId === 7
          ? "Seattle"
          : originId === 3
          ? "Bainbridge Island"
          : null;

      const toName =
        destId === 3
          ? "Bainbridge Island"
          : destId === 7
          ? "Seattle"
          : null;

      const direction =
        fromName && toName
          ? `${fromName} → ${toName}`
          : row.direction || row.Direction || row.SailingDir || "";

      return {
        vessel,
        direction,
        departureTime: departure_local,
        estimatedArrivalTime: eta_local,
        actualArrivalTime: status === "inTransit" ? null : arr_local,
        carSlotsTotal,
        carSlotsAvailable,
        scheduledDepartureTime: scheduledDepartureTime_local,
        actualDepartureTime: liveDepart_local,
        status,
        originTerminalId: originId,
        destinationTerminalId: destId,
        _row: row,
      };
    }

    let summary = [
      nextSEA ? shape(nextSEA, seaAvail, BI_ID) : null, // Seattle -> BI
      nextBI ? shape(nextBI, biAvail, SEA_ID) : null,  // BI -> Seattle
    ].filter(Boolean);

    if (
      summary.length === 2 &&
      summary[0].vessel &&
      summary[1].vessel &&
      summary[0].vessel === summary[1].vessel
    ) {
      const liveA = liveByRoute[`${SEA_ID}-${BI_ID}`]?.vesselName || null;
      const liveB = liveByRoute[`${BI_ID}-${SEA_ID}`]?.vesselName || null;
      if (liveA) summary[0].vessel = liveA;
      if (liveB) summary[1].vessel = liveB;
    }

    const liveNames = Object.keys(liveByVessel || {});
    console.log("[poll] picks", {
      nextSEA: nextSEA?.vessel || null,
      nextBI: nextBI?.vessel || null,
      live: liveNames,
    });

    // Cannon Dock: track per-vessel underway/not-underway over time
    // and refine dock start when actual arrivals are known.
    updateDockState(summary, liveByVessel, arrivedByVessel);

    cache = {
      summary,
      lastError: null,
      lastFetchedAt: Date.now(),
      debug: {
        locs,
        entries,
        nextSEA,
        nextBI,
        seaTerminalObj,
        biTerminalObj,
        capByVessel,
        stats,

        // Cannon Dock: expose per-vessel dock state for debugging only
        dockState: dockState.byVessel,
      },
    };

  } catch (e) {
    cache.lastError = e.message || String(e);
  }
}

setInterval(pollOnce, INTERVAL);
pollOnce(); // kick off immediately

// canonical FerryClock2 state builder, derived from current cache
function buildCanonicalState() {
  const SEA_ID = Number(SEA_TERMINAL_ID) || null;
  const BI_ID = Number(BI_TERMINAL_ID) || null;
  const routeId = Number(ROUTE_ID) || null;
  const items = Array.isArray(cache.summary) ? cache.summary : [];
  const locs = Array.isArray(cache.debug?.locs) ? cache.debug.locs : [];
  const now = Date.now();

  if (!items.length || !routeId || !SEA_ID || !BI_ID) return null;

  // live map by vessel name for atDock + terminal IDs
  const liveByVessel = {};
  locs.forEach((l) => {
    const name = String(l?.VesselName || "").trim();
    if (!name) return;
    liveByVessel[name] = {
      atDock: Boolean(l?.AtDock ?? (l?.Status === "Docked")),
      departingTerminalId: Number(
        l?.DepartingTerminalID ?? l?.OriginTerminalID ?? 0
      ),
      arrivingTerminalId: Number(
        l?.ArrivingTerminalID ?? l?.DestinationTerminalID ?? 0
      ),
    };
  });

  // assign lanes strictly by origin terminal id (no index-based fallbacks)
  let laneWestToEast =
    items.find((x) => x.originTerminalId === BI_ID) || null; // BI → SEA
  let laneEastToWest =
    items.find((x) => x.originTerminalId === SEA_ID) || null; // SEA → BI

  // If one side is missing and we have exactly two rows, try to infer from the other.
  if (!laneWestToEast && items.length === 2) {
    const other = items.find((x) => x !== laneEastToWest) || null;
    if (other && other.originTerminalId === BI_ID) {
      laneWestToEast = other;
    }
  }

  if (!laneEastToWest && items.length === 2) {
    const other = items.find((x) => x !== laneWestToEast) || null;
    if (other && other.originTerminalId === SEA_ID) {
      laneEastToWest = other;
    }
  }

  // Guard: never use the exact same row object for both lanes.
  if (laneWestToEast && laneEastToWest && laneWestToEast === laneEastToWest) {
    if (laneWestToEast.originTerminalId === BI_ID) {
      // keep BI → SEA, drop SEA → BI
      laneEastToWest = null;
    } else if (laneEastToWest.originTerminalId === SEA_ID) {
      // keep SEA → BI, drop BI → SEA
      laneWestToEast = null;
    } else {
      // ambiguous: keep the first, clear the second
      laneEastToWest = null;
    }
  }

  function laneToStatus(lane) {
    if (!lane) return null;
    const live = lane.vessel ? liveByVessel[lane.vessel] || null : null;
    const atDock = live ? live.atDock : null;

    return {
      vesselName: lane.vessel || null,
      atDock,
      originTerminalId: lane.originTerminalId ?? null,
      destinationTerminalId: lane.destinationTerminalId ?? null,
      status: lane.status || null,
      scheduledDeparture: lane.scheduledDepartureTime || null,
      actualDeparture: lane.actualDepartureTime || null,
      departureLabel: lane.departureTime || null,
      eta: lane.estimatedArrivalTime || null,
      actualArrival: lane.actualArrivalTime || null,

      // Cannon extras: wired into the shape but currently left null.
      // Client-side FerryClock falls back to heuristics when these are missing.
      phase: null,
      dockStartTime: null,
      dockStartIsSynthetic: null,
      dockArcFraction: null,
      arrivalTime: lane.actualArrivalTime || null,
    };
  }

  const upperLane = laneWestToEast;
  const lowerLane = laneEastToWest;

  const userRouteSelection = {
    selectedDescription: ROUTE_NAME || "Bainbridge Island - Seattle",
    selectedRouteID: routeId,
    crossingTimeMinutes:
      CROSSING_TIME_MINUTES != null
        ? Number(CROSSING_TIME_MINUTES)
        : null,
    terminalNameWest: BI_TERMINAL_NAME || "Bainbridge Island",
    terminalNameEast: SEA_TERMINAL_NAME || "Seattle",
    labelWest: WEST_LABEL || "BAINBRIDGE",
    labelEast: EAST_LABEL || "SEATTLE",
  };

  const terminalMapping = {
    terminalID_West: BI_ID,
    terminalID_East: SEA_ID,
  };

  const capacity = {
    west: {
      terminalID: BI_ID,
      maxAuto: upperLane?.carSlotsTotal ?? null,
      availAuto: upperLane?.carSlotsAvailable ?? null,
      hasLiveData:
        typeof upperLane?.carSlotsAvailable === "number" &&
        upperLane.carSlotsAvailable >= 0,
    },
    east: {
      terminalID: SEA_ID,
      maxAuto: lowerLane?.carSlotsTotal ?? null,
      availAuto: lowerLane?.carSlotsAvailable ?? null,
      hasLiveData:
        typeof lowerLane?.carSlotsAvailable === "number" &&
        lowerLane.carSlotsAvailable >= 0,
    },
  };

  const liveStatus = {
    upper: laneToStatus(upperLane),
    lower: laneToStatus(lowerLane),
  };

  const laneVessels = {
    upper: upperLane
      ? {
          vesselPositionNum: 1,
          vesselName: upperLane.vessel || null,
        }
      : null,
    lower: lowerLane
      ? {
          vesselPositionNum: 2,
          vesselName: lowerLane.vessel || null,
        }
      : null,
  };

  const staleWindowMs = 10 * 60 * 1000;
  const last = cache.lastFetchedAt || 0;
  const staleFlags =
    last > 0
      ? {
          vesselsLastUpdated: new Date(last).toISOString(),
          capacityLastUpdated: new Date(last).toISOString(),
          vesselsStale: now - last > staleWindowMs,
          capacityStale: now - last > staleWindowMs,
        }
      : {
          vesselsLastUpdated: null,
          capacityLastUpdated: null,
          vesselsStale: null,
          capacityStale: null,
        };

  // Cannon Dock: derive per-lane dock metadata from module-level dockState,
  // and synthesize a boot-time dockStart when a vessel is already at dock.
  // Also surface a best-known arrivalTime for Cannon consumers.
  function laneDockMeta(lane) {
    const EMPTY = {
      dockStartTime: null,
      dockStartSource: null,
      arrivalTime: null,
    };

    if (!lane || !lane.vessel) {
      return EMPTY;
    }

    const name = String(lane.vessel).trim();
    if (!name) return EMPTY;

    const byVessel = dockState && dockState.byVessel ? dockState.byVessel : null;
    const d = byVessel ? byVessel[name] : null;

    let dockStartTime = null;
    let dockStartSource = null;
    let arrivalTime = null;

    // Prefer Cannon per-vessel arrival when present.
    if (d && d.arrivalMs) {
      const aTs = Number(d.arrivalMs);
      if (Number.isFinite(aTs) && aTs > 0) {
        const aDt = new Date(aTs);
        if (Number.isFinite(aDt.getTime())) {
          // Keep arrivalTime in local hh:mm format for clients.
          arrivalTime = hhmm(aDt);
        }
      }
    }

    // If Cannon has no arrival opinion yet, fall back to legacy lane arrival.
    if (!arrivalTime && lane.actualArrivalTime) {
      arrivalTime = lane.actualArrivalTime;
    }

    // Primary path: observed dock start from prior underway → notUnderway transition.
    if (d && d.dockStartMs) {
      const ts = Number(d.dockStartMs);
      if (Number.isFinite(ts) && ts > 0) {
        const dt = new Date(ts);
        if (Number.isFinite(dt.getTime())) {
          dockStartTime = dt.toISOString();
          dockStartSource = d.dockStartIsSynthetic ? "synthetic" : "observed";
        }
      }
    }

    // Boot-time synthetic path:
    // If the vessel is currently at dock and we have a scheduled departure for this lane,
    // approximate dockStart as (scheduled departure - 25 minutes).
    if (!dockStartTime) {
      const live = liveByVessel && name in liveByVessel ? liveByVessel[name] : null;
      const atDock = live ? !!live.atDock : false;

      const row = lane._row || null;
      const dep = row && row.dep instanceof Date ? row.dep : null;

      if (atDock && dep) {
        const SYNTH_DWELL_MIN = 25;
        const synthMs = dep.getTime() - SYNTH_DWELL_MIN * 60 * 1000;
        const dt = new Date(synthMs);
        if (Number.isFinite(dt.getTime())) {
          dockStartTime = dt.toISOString();
          dockStartSource = "synthetic-boot";
        }
      }
    }

    if (!dockStartTime && !arrivalTime) {
      return EMPTY;
    }

    return {
      dockStartTime,
      dockStartSource,
      arrivalTime,
    };
  }

  const dockMeta = {
    upper: laneDockMeta(upperLane),
    lower: laneDockMeta(lowerLane),
  };

  // Cannon Dock: lift dock metadata into liveStatus so clients see dockStart
  // and arrivalTime, and compute a dockArcFraction when currently at dock.
  function augmentStatusWithDock(status, meta) {
    if (!status || !meta) return;

    // dockStartTime and synthetic flag propagated onto liveStatus
    status.dockStartTime =
      meta.dockStartTime && typeof meta.dockStartTime === "string"
        ? meta.dockStartTime
        : null;

    status.dockStartIsSynthetic =
      meta.dockStartSource && meta.dockStartSource !== "observed"
        ? true
        : false;

    // arrivalTime: prefer Cannon when present; otherwise leave legacy value.
    if (typeof meta.arrivalTime === "string" && meta.arrivalTime) {
      status.arrivalTime = meta.arrivalTime;
    }

    // Phase hint for clients: "docked" vs "underway"
    const statStr = String(status.status || "").toLowerCase();
    const atDock = typeof status.atDock === "boolean" ? status.atDock : false;
    if (atDock) {
      status.phase = "docked";
    } else if (statStr === "intransit") {
      status.phase = "underway";
    } else {
      status.phase = null;
    }

    // Server-side dock arc fraction:
    // When at dock and we have a valid dockStartTime, compute minutes at dock
    // capped at 60 minutes, then convert to 0..1 fraction.
    status.dockArcFraction = null;

    if (status.phase === "docked" && status.dockStartTime) {
      const t0 = Date.parse(status.dockStartTime);
      if (Number.isFinite(t0) && t0 > 0) {
        const elapsedMin = Math.max(0, Math.min(60, (now - t0) / 60000));
        status.dockArcFraction = elapsedMin / 60;
      }
    }
  }

  augmentStatusWithDock(liveStatus.upper, dockMeta.upper);
  augmentStatusWithDock(liveStatus.lower, dockMeta.lower);

  return {
    userRouteSelection,
    terminalMapping,
    laneVessels,
    capacity,
    liveStatus,
    dockMeta,
    stale: staleFlags,
  };
}

// API
// routes endpoint (unchanged contract)
app.get("/api/routes", async (req, res) => {
  try {
    res.json(await getRoutesSafe());
  } catch (e) {
    res
      .status(500)
      .json({ error: "route list failed", detail: String(e?.message || e) });
  }
});

// new canonical state endpoint
app.get("/api/state", (req, res) => {
  const state = buildCanonicalState();
  if (!state) {
    return res.status(503).json({ error: "no current state available" });
  }
  res.json(state);
});

// existing endpoints preserved for compatibility
app.get("/api/summary", (req, res) => res.json(cache.summary));

app.get("/api/raw", (req, res) => res.json(cache));

// shows live vessel fields, same as before
app.get("/api/peek", (req, res) => {
  try {
    const locs = Array.isArray(cache?.debug?.locs) ? cache.debug.locs : [];
    const out = locs.map((l) => ({
      vesselName: String(l?.VesselName ?? ""),
      departingTerminalId: Number(
        l?.DepartingTerminalID ?? l?.OriginTerminalID ?? NaN
      ),
      arrivingTerminalId: Number(
        l?.ArrivingTerminalID ?? l?.DestinationTerminalID ?? NaN
      ),
      leftDock: l?.LeftDock ?? l?.DepartedUTC ?? l?.DepartureTime ?? null,
      eta: l?.Eta ?? l?.ETA ?? l?.EstimatedArrival ?? null,
      atDock: Boolean(l?.AtDock ?? (l?.Status === "Docked")),
    }));
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "peek failed", detail: String(e?.message || e) });
  }
});

// raw stats for a vessel (defaults to Tacoma)
app.get("/api/peekStats", async (req, res) => {
  try {
    const q = String(req.query.v || "Tacoma").trim().toLowerCase();
    const stats = await getJson(URLS.stats);
    const match = (Array.isArray(stats) ? stats : []).find((s) => {
      const name = String(s?.VesselName || "")
        .trim()
        .toLowerCase()
        .replace(/^m\/?v\.?\s+/i, "");
      return name === q;
    });
    if (!match) return res.json({ error: "vessel not found", query: q });

    const numeric = {};
    Object.keys(match).forEach((k) => {
      const v = match[k];
      if (typeof v === "number") numeric[k] = v;
    });

    res.json({
      vessel: match.VesselName || null,
      numeric,
      deckSum:
        Number(match.RegDeckSpace || 0) + Number(match.TallDeckSpace || 0),
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: "peekStats failed", detail: String(e?.message || e) });
  }
});

app.get("/api/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.json({
    lastFetchedAt: cache.lastFetchedAt,
    lastError: cache.lastError,
    items: cache.summary.length,
  });
});

app.get("/api/flat", (req, res) => res.json(cache.summary));

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
