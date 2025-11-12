// public/ferryClock.js — ferry-only rendering, no dependency on analogClock
(function () {
    // clock geometry
    const CX = 200;
    const CY = 200;
    const RIM_OUTER = 182;                 // outer dial radius
    const RIM_INNER = Math.round(RIM_OUTER * 0.56); // inward offset for labels/pies

    // color palette (all ferry visuals)
    const COLOR_STRONG_LTR = "#15a868ff"; // BI → SEA
    const COLOR_STRONG_RTL = "#e11b1bff"; // SEA → BI
    const COLOR_TRACK       = "#e5e7eb";

    const COLORS = {
    ltr:  { strong: COLOR_STRONG_LTR, light: COLOR_STRONG_LTR },
    rtl:  { strong: COLOR_STRONG_RTL, light: COLOR_STRONG_RTL },
    track: COLOR_TRACK
    };

        // WSDOT terminal IDs
    const TERM_BI  = 3; // Bainbridge Island
    const TERM_SEA = 7; // Seattle

    // 12 o'clock rim radii for dock arcs
    const DOCK_OUTER_R = RIM_OUTER - 9;  // 182 - 9 = 173
    const DOCK_INNER_R = RIM_OUTER - 17; // 182 - 17 = 165

  function drawDockTopArc(container, slotIndex, pct, color, startDeg) {
    const r = slotIndex === 0 ? DOCK_OUTER_R : DOCK_INNER_R;
    if (pct == null) return;

    const start = Number.isFinite(startDeg) ? startDeg : -90; // default 12 o'clock
    const end = start + 360 * clamp01(pct);
    const large = Math.abs(end - start) > 180 ? 1 : 0;
    const [x0, y0] = polar(CX, CY, r, start);
    const [x1, y1] = polar(CX, CY, r, end);

    container.appendChild(elNS("path", {
        d: `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
        stroke: color, "stroke-width": 7, fill: "none", "stroke-linecap": STROKE_CAP
    }));
  }
    // ship icon settings
    const ICON_SRC  = "/icons/ferry.png";
    const SHIP_W    = 18;    // px
    const SHIP_H    = 18;    // px
    const SHIP_GAP  = 4;     // vertical gap above the bar
    const LABEL_GAP = 15;    // px
    const BAR_W   = 150;     // px, transit bar width
    const BAR_Y_OFFSET = 50; // px, vertical offset from arrow row to transit bar
    const STROKE_CAP = "butt";  // consistent stroke linecap across arcs and pies
    // time units
    const MIN_MS = 60 * 1000;
    const HOUR_MS = 60 * MIN_MS;
    const DAY_MS = 24 * HOUR_MS;
    // defaults
    const DEFAULT_DWELL_MIN = 20;   // fallback dock dwell
    const DOCK_CACHE_GRACE_MIN = 5; // keep dock snapshot after sched depart
    
    // capacity pie geometry
    const CAP_PIE_R = 15;           // radius in px
    const CAP_PIE_X_OFFSET = 28;    // horizontal offset from RIM_INNER

  // strict actual-arrival accessor (no ETA fallback)
  function getActualArrivalLocal(r) {
    if (window.getActualArrival) return window.getActualArrival(r);
    if (!r) return null;
    return (
      r.actualArrivalTime ??
      r.actualArrival ??
      r.actualTimeOfArrival ??
      r.actualArrivalDateTime ??
      null
    );
  }

  function isUnderway(r) {
  if (!r) return false;
  const s = String(r.status || "").toLowerCase();
  return s === "intransit" ||
         !!r.actualDepartureTime ||
         (!!r.estimatedArrivalTime && r.estimatedArrivalTime !== "—");
}

  // --- state ---
  // sticky dock cache so arcs persist even if the API drops a row briefly
const _dockCache = loadDockCache();
function loadDockCache(){ try { return JSON.parse(localStorage.getItem("ferryDockCache")||"{}"); } catch { return {}; } }
function saveDockCache(){ try { localStorage.setItem("ferryDockCache", JSON.stringify(_dockCache)); } catch {} }

// record last docked state; expires shortly after scheduled departure
function upsertDockSnapshot(r){
  const v = String(r?.vessel || "").trim(); if (!v) return;
  if (isUnderway(r)) return;
  const depart = parseNextOccurrence(r?.scheduledDepartureTime); if (!depart) return;
  const arrive = getActualArrivalLocal(r) || null;
  _dockCache[v] = {
    vessel: v,
    scheduledDepartureTime: r?.scheduledDepartureTime || null,
    actualArrivalTime: arrive,
    originTerminalId: r?.originTerminalId ?? null,
    destinationTerminalId: r?.destinationTerminalId ?? null,
    direction: r?.direction || null,
    status: "Docked",
    _expiresAt: depart.getTime() + DOCK_CACHE_GRACE_MIN * MIN_MS // keep past sched depart
  };
  saveDockCache();
}

function getDockSnapshot(v){
  const s = _dockCache?.[String(v).trim()];
  if (!s) return null;
  if (Date.now() > (s._expiresAt || 0)) { delete _dockCache[String(v).trim()]; saveDockCache(); return null; }
  return s;
}

  let _rows = [];
  // stable vessel→slot map: 0 = top, 1 = bottom
  const _slotByVessel = Object.create(null);
  
// choose best row for a vessel (prefer inTransit, else earliest upcoming sched within 24h)
function bestRowForVessel(rows, vessel) {
  const name = String(vessel || "").trim();
  const subset = rows.filter(r => String(r?.vessel || "").trim() === name);
  if (!subset.length) return null;

  const inT = subset.find(r => String(r?.status || "").toLowerCase() === "intransit");
  if (inT) return inT;

  let best = null, bestT = Infinity;
  for (const r of subset) {
    const t = parseNextOccurrence(r?.scheduledDepartureTime)?.getTime();
    if (t != null && t < bestT) { bestT = t; best = r; }
  }
  return best || subset[0];
}

// map slots -> vessel names using the stable assignment
function vesselsBySlot() {
  const map = [null, null];
  for (const v in _slotByVessel) {
    const s = _slotByVessel[v];
    if (s === 0 || s === 1) map[s] = v;
  }
  return map;
}

// fallback: earliest upcoming scheduled departure within 24h, with optional vessel exclusion
function earliestUpcoming(rows, excludeVessel = null) {
  let best = null, bestT = Infinity;
  const ex = excludeVessel ? String(excludeVessel).trim() : null;
  for (const r of rows) {
    const v = String(r?.vessel || "").trim();
    if (ex && v === ex) continue;
    const t = parseNextOccurrence(r?.scheduledDepartureTime)?.getTime();
    if (t != null && t < bestT) { bestT = t; best = r; }
  }
  return best || (rows && rows[0]) || null;
}

  // --- persist slot map so vessels never trade bars ---
function loadSlotMap() {
  try { return JSON.parse(localStorage.getItem("ferrySlotMap") || "{}"); } catch { return {}; }
}

function saveSlotMap(map) {
  try { localStorage.setItem("ferrySlotMap", JSON.stringify(map)); } catch {}
}

function assignSlots(rows) {
  // start with any saved mapping
  const saved = loadSlotMap();
  for (const v in saved) {
    if (saved[v] === 0 || saved[v] === 1) _slotByVessel[v] = saved[v];
  }

  // assign new vessels to the first free slot, then persist
  rows.forEach(r => {
    const v = (r && r.vessel && String(r.vessel).trim()) || null;
    if (!v) return;
    if (!(_slotByVessel[v] === 0 || _slotByVessel[v] === 1)) {
      const used = new Set(Object.values(_slotByVessel));
      _slotByVessel[v] = used.has(0) ? 1 : 0;
    }
  });

  // persist after any additions
  saveSlotMap(_slotByVessel);
}

  // --- public API ---
    window.ferry = {
    setData(rows) {
        _rows = Array.isArray(rows) ? rows : [];
        assignSlots(_rows);

        // update dock cache from current rows
        for (const r of _rows) upsertDockSnapshot(r);
    },

    render() {      
      const layers = getLayers();
      if (!layers) { console.warn("ferry.render: no layers"); return; }
      const { top, bottom, dockTop, clear } = layers;
        clear();

      ensureLabels();

    // choose rows by stable slot map; backfill so lanes never disappear
    const slotRows = [null, null];
    const vs = vesselsBySlot();

    // try per-vessel picks first
    if (vs[0]) slotRows[0] = bestRowForVessel(_rows, vs[0]);
    if (vs[1]) slotRows[1] = bestRowForVessel(_rows, vs[1]);
    // if missing in live data, fall back to sticky dock snapshot
    if (!slotRows[0] && vs[0]) slotRows[0] = getDockSnapshot(vs[0]);
    if (!slotRows[1] && vs[1]) slotRows[1] = getDockSnapshot(vs[1]);

    // backfill any missing slot with earliest upcoming, avoiding duplicate vessel
    if (!slotRows[0]) slotRows[0] = earliestUpcoming(_rows, slotRows[1]?.vessel || null);
    if (!slotRows[1]) slotRows[1] = earliestUpcoming(_rows, slotRows[0]?.vessel || null);

    // final safety
    if (!slotRows[0] && _rows[0]) slotRows[0] = _rows[0];
    if (!slotRows[1] && _rows[1]) slotRows[1] = _rows[1];

    // hard de-duplication: never show the same vessel in both slots
    if (slotRows[0]?.vessel && slotRows[1]?.vessel &&
        String(slotRows[0].vessel).trim() === String(slotRows[1].vessel).trim()) {

      const dupName = String(slotRows[0].vessel).trim();

      // prefer replacing the bottom slot with the earliest alternative that is not the duplicate
      const replacement = earliestUpcoming(_rows, dupName);

      // if no alternative is available, try a dock snapshot of any other mapped vessel
      const vsList = vesselsBySlot().filter(v => v && v !== dupName);
      const snap = vsList.length ? getDockSnapshot(vsList[0]) : null;

      slotRows[1] = replacement || snap || null;

      // if still null, keep only the top slot populated and leave bottom empty
      if (!slotRows[1]) {
        console.warn("[ferry] de-dup: only one vessel available; hiding duplicate in bottom slot:", dupName);
      }
    }


      // 12 o'clock dock arcs: only when docked. No track when underway.
      if (dockTop) {
        for (let slot = 0; slot <= 1; slot++) {
          const rr = slotRows[slot];
          // infer direction
          let dir = null;
          if (rr) {
            const s = String(rr.direction || "").toLowerCase();
            if (s.includes("bainbridge") && s.includes("seattle")) {
              dir = s.indexOf("bainbridge") < s.indexOf("seattle") ? "ltr" : "rtl";
            } else {
                const from = Number(rr.originTerminalId), to = Number(rr.destinationTerminalId);
                if (from === TERM_BI && to === TERM_SEA) dir = "ltr";
                if (from === TERM_SEA && to === TERM_BI) dir = "rtl";
            }
          }
          const scheme = dir === "ltr" ? COLORS.ltr : COLORS.rtl;
          const underway = isUnderway(rr);

          if (rr && !underway) {
            const arrive = getActualArrivalLocal(rr);
            const win = getDockWindow(arrive, rr.scheduledDepartureTime);
            if (win) {
              // Start angle = arrival minute on the rim
              const startDeg = -90 + (win.tA.getMinutes() % 60) * 6;
              // Sweep = elapsed minutes * 6° per minute; pass as a fraction of 60 minutes
              const sweepDeg = Math.max(0, Math.min(win.elapsedMin, win.dwellMin)) * 6;
              const pctOfCircle = sweepDeg / 360; // drawDockTopArc expects fraction of a full circle
              drawDockTopArc(dockTop, slot, pctOfCircle, scheme.light, startDeg);
            }
          }
        }
      }
      drawRow(top,    slotRows[0] || null, 95);
      drawRow(bottom, slotRows[1] || null, 305);

// ---- capacity pies (always show two, BI on left, SEA on right) ----
const capG = layers.capacity;
if (capG) {
  capG.innerHTML = "";

  // robust origin resolver: prefer IDs, else direction text, else infer from destination
  const ORIGIN = { SEA: TERM_SEA, BI: TERM_BI };
  function originIdOf(r){
    const id = Number(r?.originTerminalId);
    if (id === TERM_SEA || id === TERM_BI) return id;
    const dir = String(r?.direction || "").toLowerCase();
    if (dir.includes("leave seattle") || dir.includes("seattle →") || dir.includes("seattle to")) return TERM_SEA;
    if (dir.includes("leave bainbridge") || dir.includes("bainbridge →") || dir.includes("bainbridge to")) return TERM_BI;
    const dst = Number(r?.destinationTerminalId);
    if (dst === TERM_SEA) return TERM_BI;
    if (dst === TERM_BI) return TERM_SEA;
    return null;
  }

  // next scheduled departure in the future from an origin
  function nextFrom(originId){
    const now = Date.now();
    const items = _rows
      .filter(r => originIdOf(r) === originId && r?.scheduledDepartureTime)
      .map(r => ({ r, t: parseNextOccurrence(r.scheduledDepartureTime)?.getTime() || Infinity }))
      .filter(x => x.t !== Infinity && x.t >= now - 60*1000)
      .sort((a,b) => a.t - b.t);
    return items.length ? items[0].r : null;
  }

  const rowSEA = nextFrom(TERM_SEA);
  const rowBI  = nextFrom(TERM_BI);

  // geometry: centered on 3–9 axis, near labels
  const R = CAP_PIE_R;        // radius of small pies
  const yC = CY;
  const xSeattle = CX + RIM_INNER - CAP_PIE_X_OFFSET;  // just left of "SEATTLE"
  const xBain    = CX - RIM_INNER + CAP_PIE_X_OFFSET;  // just right of "BAINBRIDGE ISLAND"

 // Sticky cache for capacity pies — survives reloads via localStorage
const CAP_STICKY_KEY = "capStickyV1";
function loadCapSticky() {
  try { return JSON.parse(localStorage.getItem(CAP_STICKY_KEY) || "") || null; } catch { return null; }
}
function saveCapSticky(obj) { try { localStorage.setItem(CAP_STICKY_KEY, JSON.stringify(obj)); } catch {} }

window.__capSticky = loadCapSticky() || {
  SEA: { total: null, avail: null, tTotal: 0, tAvail: 0 },
  BI:  { total: null, avail: null, tTotal: 0, tAvail: 0 }
};

// Returns sticky values; never force 0 on brief nulls
function sticky(originKey, nextTotal, nextAvail) {
  const rec = window.__capSticky[originKey] || { total: null, avail: null, tTotal: 0, tAvail: 0 };
  const now = Date.now();

  // independent clocks for total vs avail
  const SOFT_TTL_AVAIL_MS = 5 * 60 * 1000;  // keep last avail up to 5 min
  const HARD_TTL_AVAIL_MS = 20 * 60 * 1000; // drop after 20 min with no updates

  // TOTAL: accept any finite value immediately
  if (Number.isFinite(nextTotal) && nextTotal >= 0) {
    rec.total = nextTotal;
    rec.tTotal = now;
  }

  // AVAIL: accept any finite value immediately
  if (Number.isFinite(nextAvail) && nextAvail >= 0) {
    rec.avail = nextAvail;
    rec.tAvail = now;
  } else {
    // feed has null/zero/NaN: keep last known within TTL windows
    const age = now - rec.tAvail;
    if (rec.avail != null) {
      // keep last for soft window; after hard window, mark unknown (null), do NOT force 0
      if (age > HARD_TTL_AVAIL_MS) rec.avail = null;
    }
  }

  window.__capSticky[originKey] = rec;
  saveCapSticky(window.__capSticky);

  // Outputs: numbers; when unknown, fall back to 0 total/avail for drawing but avoid
  // sudden zeroing during soft outages because rec.avail is preserved above.
  const outTotal = Number.isFinite(rec.total) ? Math.max(0, rec.total) : 0;
  const outAvail = Number.isFinite(rec.avail) ? Math.max(0, rec.avail) : 0;
  return { total: outTotal, avail: outAvail };
}


  // --- SEA (right pie) ---
  {
    const nextTotal = rowSEA && Number.isFinite(Number(rowSEA?.carSlotsTotal)) ? Number(rowSEA.carSlotsTotal) : null;
    const nextAvail = rowSEA && Number.isFinite(Number(rowSEA?.carSlotsAvailable)) ? Math.max(0, Number(rowSEA.carSlotsAvailable)) : null;
    const { total, avail } = sticky("SEA", nextTotal, nextAvail);
    drawCapacityPie(capG, xSeattle, yC, R, total, avail, COLORS.rtl.strong);
  }

  // --- BI (left pie) ---
  {
    const nextTotal = rowBI && Number.isFinite(Number(rowBI?.carSlotsTotal)) ? Number(rowBI.carSlotsTotal) : null;
    const nextAvail = rowBI && Number.isFinite(Number(rowBI?.carSlotsAvailable)) ? Math.max(0, Number(rowBI.carSlotsAvailable)) : null;
    const { total, avail } = sticky("BI", nextTotal, nextAvail);
    drawCapacityPie(capG, xBain, yC, R, total, avail, COLORS.ltr.strong);
  }
} // end if (capG)

    } // end render()
  }; // end window.ferry


  // Back-compat shim
  window.updateFerryClock = function updateFerryClock(summaryRows) {
    window.ferry.setData(summaryRows);
    window.ferry.render();
  };

  // Smooth dock-arc animation: re-render without refetch every 5s.
  // Guard against multiple timers on hot reload.
  if (!window.__ferryRenderTimer) {
    window.__ferryRenderTimer = setInterval(() => {
      try {
        if (window.ferry && typeof window.ferry.render === "function") {
          window.ferry.render();
        }
      } catch {}
    }, 5000);
  }

  // ---------- core drawing ----------
function drawRow(g, r, y) {
    g.innerHTML = "";
    if (!r) return;

    // infer direction: prefer text, then IDs
    let dir = null; // "ltr" | "rtl"
    const s = String(r.direction || "").toLowerCase();
    if (s.includes("bainbridge") && s.includes("seattle")) {
        dir = s.indexOf("bainbridge") < s.indexOf("seattle") ? "ltr" : "rtl";
    } else {
        const from = toNum(r.originTerminalId);
        const to   = toNum(r.destinationTerminalId);
        if (from === TERM_BI && to === TERM_SEA) dir = "ltr";  // BI -> SEA
        if (from === TERM_SEA && to === TERM_BI) dir = "rtl";  // SEA -> BI
    }

    // underway heuristic
    const underway = isUnderway(r);

    // shared bar geometry for transit and labels
    const barWidth = BAR_W;
    const xL = CX - barWidth / 2;
    const xR = CX + barWidth / 2;
    const barY = (y < CY) ? (y + BAR_Y_OFFSET) : (y - BAR_Y_OFFSET);
    const isTop = y < CY;

    // colors
    const scheme = (dir === "ltr") ? COLORS.ltr : COLORS.rtl;
    const stroke = (dir ? (underway ? scheme.strong : scheme.light) : "#999");

    // center arrow indicator on 12–6 axis
    if (dir) {
    const y0 = y, halfLen = 28, head = 8;
    const xL = CX - halfLen, xR = CX + halfLen;
    const arrowColor = underway ? scheme.strong : scheme.light;

    g.appendChild(line(xL, y0, xR, y0, arrowColor, 3));
    if (dir === "ltr") {
      g.appendChild(arrowHead(xR, y0, 0, arrowColor, 3, head));
      if (!underway) g.appendChild(circleDot(xL, y0, 2, arrowColor));
    } else {
      g.appendChild(arrowHead(xL, y0, Math.PI, arrowColor, 3, head));
      if (!underway) g.appendChild(circleDot(xR, y0, 2, arrowColor));
    }
  } else {
    const t = elNS("text", { x: CX, y, "text-anchor": "middle", fill: stroke, "font-size": "14" });
    t.textContent = "--";
    g.appendChild(t);
  }

  // transit bar + moving dot
  if (dir) {
    let xp = null; // ensure defined before use

    // 1) always draw grey track
    g.appendChild(line(xL, barY, xR, barY, COLORS.track, 6));
    // 2) draw progress fill and moving dot
    if (underway) {
      // robust start/end for progress
      const startStr =
        r.actualDepartureTime ||
        r.departureTime ||
        r.scheduledDepartureTime ||
        null;
      const endStr = r.estimatedArrivalTime || null;

      const pct = computeTransitProgress(startStr, endStr);

      // choose x-position for dot
      if (pct != null) {
        if (dir === "ltr") {
          xp = xL + (xR - xL) * pct;
          g.appendChild(line(xL, barY, xp, barY, scheme.strong, 6)); // colored fill
        } else {
          xp = xR - (xR - xL) * pct;
          g.appendChild(line(xR, barY, xp, barY, scheme.strong, 6)); // colored fill
        }
      } else {
        // progress unknown briefly after depart → park dot at origin side
        const origin = toNum(r.originTerminalId);
        xp = origin === TERM_SEA ? xR : origin === TERM_BI ? xL : (dir === "ltr" ? xL : xR);
      }

      // moving dot must always be visible while underway
      g.appendChild(circleDot(xp, barY, 5.5, scheme.strong));
      addShipIcon(g, xp, barY);
    } else {
      // docked: show dot at bar end closest to current dock (origin of next sailing)
      const origin = toNum(r.originTerminalId);
      xp = origin === TERM_SEA ? xR : origin === TERM_BI ? xL : (dir === "ltr" ? xL : xR);

      g.appendChild(circleDot(xp, barY, 5.5, scheme.light));
      addShipIcon(g, xp, barY);
      // no colored fill while docked
    }
  } 

  // ---- label hooks (docked vs underway) ----
  // recompute bar geometry locally to avoid touching existing logic
  if (dir) {
    const labelY = barY + LABEL_GAP;

    // endpoint x positions
    const originX = (dir === "ltr") ? xL : xR;
    const destX   = (dir === "ltr") ? xR : xL;

    // choose anchors so text is horizontally aligned to the bar end
    const originAnchor = (dir === "ltr") ? "start" : "end";
    const destAnchor   = (dir === "ltr") ? "end" : "start";

    // strings
    const sched = r.scheduledDepartureTime || r.departureTime || "";
    const eta   = stickyEta(r.vessel, r.estimatedArrivalTime, underway);


    // draw one label depending on state
    if (!underway && sched) {

      const t = elNS("text", {
          x: originX, y: labelY,
          "text-anchor": originAnchor,
          fill: "#111",
          "font-size": "10"
      });
      t.textContent = sched;
      g.appendChild(t);

    } else if (underway && eta) {
      const etaY = barY + LABEL_GAP;

      const t = elNS("text", {
          x: destX, y: etaY,
          "text-anchor": destAnchor,
          fill: "#111",
          "font-size": "10"
      });
      t.textContent = eta;
      g.appendChild(t);
    }
  }

  // ferry name
  const name = (r.vessel && String(r.vessel).trim()) ? String(r.vessel) : "—";
  const nameY = (y >= CY) ? (y - 12) : (y + 20);
  const tn = elNS("text", { x: CX, y: nameY, "text-anchor": "middle", fill: "#222", "font-size": "12" });
  tn.textContent = name;
  g.appendChild(tn);
}

// ---------- face layers ----------
  function getLayers() {
    // Prefer faceRenderer if present
    if (typeof window.getFaceLayers === "function") {
      const L = window.getFaceLayers();
      const svg = document.getElementById("clockFace");
      const overlay = svg ? svg.querySelector("#clock-overlay") : null;
      const dockTop = overlay ? ensure(overlay, "g", { id: "dock-top-arcs" }) : null;
      const capacity = overlay ? ensure(overlay, "g", { id: "capacity-pies" }) : null;
      return {
        overlay: L.overlay,
        top: L.top,
        bottom: L.bottom,
        dockTop,
        capacity,
        clear() { L.clear(); if (dockTop) dockTop.innerHTML = ""; if (capacity) capacity.innerHTML = ""; }
      };
    }

    // Fallback: create local overlay + rows inside #clockFace
    const svg = document.getElementById("clockFace");
    if (!svg) return null;
    const overlay = ensure(svg, "g", { id: "clock-overlay", "font-family": "system-ui, Arial, sans-serif" });
    const top = ensure(overlay, "g", { id: "row-top" });
    const bottom = ensure(overlay, "g", { id: "row-bot" });
    const dockTop = ensure(overlay, "g", { id: "dock-top-arcs" });
    const capacity = ensure(overlay, "g", { id: "capacity-pies" });
    return { overlay, top, bottom, dockTop, capacity, clear() { top.innerHTML = ""; bottom.innerHTML = ""; dockTop.innerHTML = ""; capacity.innerHTML = ""; } };
  }

  // ---------- static labels once ----------
  function ensureLabels() {
    const svg = document.getElementById("clockFace");
    if (!svg) return;
        let labels = svg.querySelector("#ferry-rim-labels");
    if (!labels) {
        labels = elNS("g", { id: "ferry-rim-labels", "font-family": "system-ui, Arial, sans-serif" });
        svg.appendChild(labels);
    }
    if (!labels.childNodes || labels.childNodes.length === 0) {
        const rx = CX + RIM_INNER, ry = CY;
        labels.appendChild(elText("SEATTLE", rx, ry, { anchor: "middle", fill: "#444", rotate: [90, rx, ry] }));
        const lx = CX - RIM_INNER, ly = CY;
        labels.appendChild(elText("BAINBRIDGE ISLAND", lx, ly, { anchor: "middle", fill: "#444", rotate: [-90, lx, ly] }));

    }
  }

  // ---------- SVG helpers ----------
  function elNS(tag, attrs) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function elText(text, x, y, { anchor = "start", fill = "#000", rotate = null } = {}) {
    const t = elNS("text", { x, y, "text-anchor": anchor, fill });
    if (rotate) t.setAttribute("transform", `rotate(${rotate[0]}, ${rotate[1]}, ${rotate[2]})`);
    t.textContent = text;
    return t;
  }
  function line(x1, y1, x2, y2, stroke, w) {
    return elNS("line", { x1, y1, x2, y2, stroke, "stroke-width": w, "stroke-linecap": "round" });
  }
  function arrowHead(x, y, angleRad, stroke, w, size) {
    const s = size || 8;
    const p1x = x + Math.cos(angleRad + Math.PI - 0.9) * s;
    const p1y = y + Math.sin(angleRad + Math.PI - 0.9) * s;
    const p2x = x + Math.cos(angleRad + Math.PI + 0.9) * s;
    const p2y = y + Math.sin(angleRad + Math.PI + 0.9) * s;
    return elNS("path", {
      d: `M ${x} ${y} L ${p1x} ${p1y} M ${x} ${y} L ${p2x} ${p2y}`,
      stroke, "stroke-width": w, fill: "none", "stroke-linecap": "round"
    });
  }
  function circleDot(x, y, r, stroke) {
    return elNS("circle", { cx: x, cy: y, r: r, fill: stroke });

  }
  function addShipIcon(g, cx, barY) {
    const x = cx - SHIP_W / 2;
    const y = barY - SHIP_H - SHIP_GAP;
    const img = elNS("image", {
      href: ICON_SRC,
      x, y,
      width: SHIP_W, height: SHIP_H,
      preserveAspectRatio: "xMidYMid meet"
    });
    g.appendChild(img);
  }

  function ensure(parent, tag, attrs) {
    const id = attrs && attrs.id;
    let node = id ? parent.querySelector(`#${id}`) : null;
    if (!node) node = elNS(tag, attrs || {});
    else if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (!node.parentNode) parent.appendChild(node);
    return node;
  }
  function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  // --- time + progress helpers ---
    // core hh:mm AM/PM → Date parser using a provided base day
    function parseHHMMBase(hhmm, baseDate) {
        if (!hhmm || typeof hhmm !== "string" || !(baseDate instanceof Date)) return null;
        const parts = hhmm.trim().split(/\s+/);
        if (parts.length < 2) return null;
        const time = parts[0];
        const ampm = parts[1].toUpperCase();
        const [hStr, mStr] = time.split(":");
        let h = Number(hStr), m = Number(mStr);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        if (ampm === "PM" && h !== 12) h += 12;
        if (ampm === "AM" && h === 12) h = 0;
        const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), h, m, 0, 0);
        return Number.isFinite(d.getTime()) ? d : null;
    }

    // Compute progress for an underway trip using today-only times.
    // Rolls the END forward 24h if it is <= START (cross-midnight protection).
    function computeTransitProgress(startStr, endStr) {
    const t0 = parseTodayLocal(startStr);
    const t1 = parseTodayLocal(endStr);
    if (!t0 || !t1) return null;
    let a = t0.getTime();
    let b = t1.getTime();
    if (b <= a) b += DAY_MS; // allow ETA past midnight
    return clamp01((Date.now() - a) / (b - a));
    }

  function parseTodayLocal(hhmm) {
    return parseHHMMBase(hhmm, new Date());
  }

  function clamp01(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x; }

  // pick the next occurrence of an hh:mm AM/PM within the next 24h
  function parseNextOccurrence(hhmm) {
    const base = parseHHMMBase(hhmm, new Date());
    if (!base) return null;
    const now = Date.now();
    let t = base.getTime();
    // if that time already passed by >~1 minute, roll it to tomorrow
    if (t < now - MIN_MS) t += DAY_MS;
    return new Date(t);
  }
  // pick the most recent occurrence of an hh:mm AM/PM at or before now
  function parsePrevOccurrence(hhmm) {
    const base = parseHHMMBase(hhmm, new Date());
    if (!base) return null;
    const now = Date.now();
    let t = base.getTime();
    // if that time is in the future by >~1 minute, roll it to yesterday
    if (t > now + MIN_MS) t -= DAY_MS;
    // if it’s slightly ahead due to rounding, clamp to now - 1s
    if (t > now) t = now - 1000;
    return new Date(t);
  }

  // debug: mark renderer loaded
  console.log("[ferryClock] ready");

  // Dock window helper: returns arrival/depart times and minute counts
  function getDockWindow(actualArriveStr, schedDepartStr) {
    const tD = parseNextOccurrence(schedDepartStr);
    if (!tD) return null;
    let tA = parsePrevOccurrence(actualArriveStr);
    if (!tA) {
      // fallback dwell of 20 min ending at scheduled depart
      tA = new Date(tD.getTime() - DEFAULT_DWELL_MIN * MIN_MS);
    }
    if (!(tD.getTime() > tA.getTime())) return null;
    const now = Date.now();
    const dwellMs   = tD.getTime() - tA.getTime();
    const elapsedMs = Math.max(0, Math.min(dwellMs, now - tA.getTime()));
    const dwellMin   = dwellMs   / 60000;
    const elapsedMin = elapsedMs / 60000;
    return { tA, tD, dwellMin, elapsedMin };
  }

  function polar(cx, cy, r, aDeg) {
    const a = (aDeg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

// --- ETA stickiness: only after first valid ETA ("armed"), short TTL while underway ---
window.__etaSticky = window.__etaSticky || Object.create(null);
/**
 * Returns the ETA string to display. Behavior:
 * - While docked: no stickiness; ETA clears.
 * - While underway:
 *    - Before first valid ETA appears: returns "" (no fallback).
 *    - After a valid ETA appeared once ("armed"): if a later cycle drops ETA,
 *      reuse the last ETA for up to TTL_MS, then clear if still missing.
 */
function stickyEta(vesselName, nextEtaStr, underway) {
  const v = (vesselName && String(vesselName).trim()) || "";
  if (!v) return nextEtaStr || "";

  const TTL_MS = 90 * 1000; // 90s reuse window
  const now = Date.now();
  const rec = (window.__etaSticky[v] ||= { armed: false, value: "", t: 0 });

  if (!underway) {
    rec.armed = false;
    rec.value = "";
    rec.t = now;
    return nextEtaStr || "";
  }

  const clean = (s) => (s && s !== "—") ? String(s) : "";
  const nxt = clean(nextEtaStr);

  if (nxt) {
    rec.armed = true;
    rec.value = nxt;
    rec.t = now;
    return nxt;
  }

  if (rec.armed && (now - rec.t) <= TTL_MS && rec.value) {
    return rec.value;
  }
  return "";
}
  
// ---- capacity pie helpers ----
// visual tuning knob: donut ring thickness in px
const RING_W = 6;

function drawCapacityPie(g, cx, cy, r, total, avail, color) {
  // normalize
  const T = Number.isFinite(total) ? Math.max(0, total) : 0;
  const A = Number.isFinite(avail) ? Math.max(0, avail) : 0;

  // placeholder when total unknown
  if (T <= 0) {
    // faint track ring
    g.appendChild(elNS("circle", {
      cx, cy, r,
      fill: "none",
      stroke: "#ddd",
      "stroke-width": RING_W,
      "stroke-linecap": STROKE_CAP
    }));
    // white center to force donut look on non-white backgrounds
    g.appendChild(elNS("circle", {
      cx, cy, r: Math.max(1, r - RING_W * 0.5 - 1),
      fill: "#fff", stroke: "none"
    }));
    // label
    const txt = elNS("text", { x: cx, y: cy + 4, "text-anchor": "middle", fill: "#888", "font-size": "12", "font-weight": "600" });
    txt.textContent = "—";
    g.appendChild(txt);
    return;
  }

  // always draw track ring
  g.appendChild(elNS("circle", {
    cx, cy, r,
    fill: "none",
    stroke: COLORS.track,
    "stroke-width": RING_W,
    "stroke-linecap": STROKE_CAP
  }));

    // availability as an arc along the ring, starting at 12 o'clock
    const frac = Math.max(0, Math.min(1, A / T));
    // Avoid 360°, which renders no arc in SVG
    const sweep = Math.min(359.9, frac * 360);
    if (sweep > 0) {
    const path = elNS("path", {
        d: arcPath(cx, cy, r, -90, sweep),

      fill: "none",
      stroke: color,
      "stroke-width": RING_W,
      "stroke-linecap": STROKE_CAP
    });
    g.appendChild(path);
  }

  // white center so it reads as a donut regardless of page background
  g.appendChild(elNS("circle", {
    cx, cy, r: Math.max(1, r - RING_W * 0.5 - 1),
    fill: "#fff",
    stroke: "none"
  }));

  // numeric label = available count
  const txt = elNS("text", {
    x: cx, y: cy + 4,
    "text-anchor": "middle",
    fill: "#111",
    "font-size": "12",
    "font-weight": "600"
  });
  txt.textContent = String(A);
  g.appendChild(txt);
}

// SVG arc path centered at (cx,cy) with radius r,
// starting at startDeg and sweeping sweepDeg clockwise.
function arcPath(cx, cy, r, startDeg, sweepDeg) {
  const a0 = (Math.PI / 180) * startDeg;
  const a1 = (Math.PI / 180) * (startDeg + sweepDeg);
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = Math.abs(sweepDeg) > 180 ? 1 : 0;
  const sweep = sweepDeg >= 0 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
}

// end IIFE
})();
