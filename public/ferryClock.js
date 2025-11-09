// public/ferryClock.js — ferry-only rendering, no dependency on analogClock
(function () {
  const CX = 200, CY = 200, RIM = 182, INWARD = Math.round(RIM * 0.56);

  // color palette
  const COLORS = {
    ltr:  { strong: "#059669", light: "#86efac" }, // BI -> SEA
    rtl:  { strong: "#2563eb", light: "#93c5fd" }, // SEA -> BI
    track:"#e5e7eb"
  };

  // 12 o'clock rim radii for dock arcs
  const DOCK_OUTER_R = 174
  ; // top slot
  const DOCK_INNER_R = 165; // bottom slot

  function drawDockTopArc(container, slotIndex, pct, color) {
    const r = slotIndex === 0 ? DOCK_OUTER_R : DOCK_INNER_R;
    // fill 0..360 from 12 o'clock (-90deg)
    if (pct != null) {
      const start = -90;
      const end = start + 360 * clamp01(pct);
      const large = Math.abs(end - start) > 180 ? 1 : 0;
      const [x0, y0] = polar(CX, CY, r, start);
      const [x1, y1] = polar(CX, CY, r, end);
      container.appendChild(elNS("path", {
        d: `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
        stroke: color, "stroke-width": 8, fill: "none", "stroke-linecap": "round"
      }));
    }
  }

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

  // --- state ---
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

  try { console.log("assignSlots map:", JSON.parse(JSON.stringify(_slotByVessel))); } catch {}
}


  // --- public API ---
  window.ferry = {
    setData(rows) {
      _rows = Array.isArray(rows) ? rows : [];
      assignSlots(_rows);
      try {
        const names = _rows.slice(0, 2).map(r => r && r.vessel || null);
        console.log("ferry.setData:", _rows.length, names, "slots:", JSON.stringify(_slotByVessel));
      } catch {}
    },

    render() {
      const dbg = _rows.slice(0, 2).map(r => r && ({
        vessel: r.vessel || null,
        from: r.originTerminalId ?? null,
        to: r.destinationTerminalId ?? null,
        status: r.status || null,
        depart: r.actualDepartureTime || r.scheduledDepartureTime || null,
        eta: r.estimatedArrivalTime || null
      }));
      console.table(dbg);

      const layers = getLayers();
      if (!layers) { console.warn("ferry.render: no layers"); return; }
      const { top, bottom, dockTop, clear } = layers;

      if (typeof clear === "function") {
        clear();
      } else {
        top.innerHTML = "";
        bottom.innerHTML = "";
        if (dockTop) dockTop.innerHTML = "";
      }

      ensureLabels();

    // choose rows by stable slot map; backfill so lanes never disappear
    const slotRows = [null, null];
    const vs = vesselsBySlot();

    // try per-vessel picks first
    if (vs[0]) slotRows[0] = bestRowForVessel(_rows, vs[0]);
    if (vs[1]) slotRows[1] = bestRowForVessel(_rows, vs[1]);

    // backfill any missing slot with earliest upcoming, avoiding duplicate vessel
    if (!slotRows[0]) slotRows[0] = earliestUpcoming(_rows, slotRows[1]?.vessel || null);
    if (!slotRows[1]) slotRows[1] = earliestUpcoming(_rows, slotRows[0]?.vessel || null);

    // final safety
    if (!slotRows[0] && _rows[0]) slotRows[0] = _rows[0];
    if (!slotRows[1] && _rows[1]) slotRows[1] = _rows[1];


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
              if (from === 3 && to === 7) dir = "ltr";
              if (from === 7 && to === 3) dir = "rtl";
            }
          }
          const scheme = dir === "ltr" ? COLORS.ltr : COLORS.rtl;
          const underway = !!(rr && (rr.status === "inTransit" || rr.actualDepartureTime || (rr.estimatedArrivalTime && rr.estimatedArrivalTime !== "—")));

          if (rr && !underway) {
            const arrive = getActualArrivalLocal(rr);
            let pct = computeDockProgress(arrive, rr.scheduledDepartureTime);
            drawDockTopArc(dockTop, slot, pct, scheme.light);
          }
        }
      }
      drawRow(top,    slotRows[0] || null, 95);
      drawRow(bottom, slotRows[1] || null, 305);
      // ---- capacity pies (20% of face diameter => radius 40) ----
      const capG = layers.capacity;
      if (capG) {
        capG.innerHTML = "";

       // robust origin resolver: prefer IDs, else direction text, else infer from destination
        const ORIGIN = { SEA: 7, BI: 3 };
        function originIdOf(r){
        const id = Number(r?.originTerminalId);
        if (id === 7 || id === 3) return id;
        const dir = String(r?.direction || "").toLowerCase();
        if (dir.includes("leave seattle") || dir.includes("seattle →") || dir.includes("seattle to")) return 7;
        if (dir.includes("leave bainbridge") || dir.includes("bainbridge →") || dir.includes("bainbridge to")) return 3;
        const dst = Number(r?.destinationTerminalId);
        if (dst === 7) return 3;
        if (dst === 3) return 7;
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

        const rowSEA = nextFrom(ORIGIN.SEA);
        const rowBI  = nextFrom(ORIGIN.BI);

        // diag
        try { console.log("capacity pies pick:", {
        SEA: rowSEA ? { vessel: rowSEA.vessel, avail: rowSEA.carSlotsAvailable, total: rowSEA.carSlotsTotal } : null,
        BI:  rowBI  ? { vessel: rowBI.vessel,  avail: rowBI.carSlotsAvailable,  total: rowBI.carSlotsTotal }  : null
        }); } catch {}


        // geometry: centered on 3–9 axis, near labels
        const R = 15;               // raduis of small circles pies
        const yC = 200;
        const xSeattle = CX + INWARD - 28;     // just left of "SEATTLE"
        const xBain    = CX - INWARD + 28;     // just right of "BAINBRIDGE ISLAND"

        if (rowSEA) {
          const total = Number(rowSEA.carSlotsTotal) || 0;
          const avail = Math.max(0, Number(rowSEA.carSlotsAvailable) || 0);
          drawCapacityPie(capG, xSeattle, yC, R, total, avail, COLORS.rtl.strong);
        }
        if (rowBI) {
          const total = Number(rowBI.carSlotsTotal) || 0;
          const avail = Math.max(0, Number(rowBI.carSlotsAvailable) || 0);
          drawCapacityPie(capG, xBain, yC, R, total, avail, COLORS.ltr.strong);
        }
      }


    }
  };
  // Back-compat shim
  window.updateFerryClock = function updateFerryClock(summaryRows) {
    window.ferry.setData(summaryRows);
    window.ferry.render();
  };

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
    if (from === 3 && to === 7) dir = "ltr";  // BI -> SEA
    if (from === 7 && to === 3) dir = "rtl";  // SEA -> BI
  }

  // underway heuristic
  const underway =
    r.status === "inTransit" ||
    !!r.actualDepartureTime ||
    (!!r.estimatedArrivalTime && r.estimatedArrivalTime !== "—");

  // colors
  const scheme = (dir === "ltr") ? COLORS.ltr : COLORS.rtl;
  const stroke = (dir ? (underway ? scheme.strong : scheme.light) : "#999");

  // center arrow indicator on 12–6 axis
  if (dir) {
    const y0 = y, halfLen = 28, head = 8;
    const xL = 200 - halfLen, xR = 200 + halfLen;
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
    const t = elNS("text", { x: 200, y, "text-anchor": "middle", fill: stroke, "font-size": "14" });
    t.textContent = "--";
    g.appendChild(t);
  }

  // transit bar + moving dot
  if (dir) {
    const barWidth = 150;
    const xL = 200 - barWidth / 2;
    const xR = 200 + barWidth / 2;
    const barY = (y < 200) ? (y + 50) : (y - 50);

    // 1) always draw grey track
    g.appendChild(line(xL, barY, xR, barY, COLORS.track, 6));

    // 2) draw progress fill and moving dot
   if (underway) {
  // draw track
  g.appendChild(line(xL, barY, xR, barY, COLORS.track, 6));

  // robust start/end for progress
  const startStr =
    r.actualDepartureTime ||
    r.departureTime ||
    r.scheduledDepartureTime ||
    null;
  const endStr = r.estimatedArrivalTime || null;

  const pct = computeProgress(startStr, endStr);

  // choose x-position for dot
  let xp;
    if (pct != null) {
        if (dir === "ltr") {
        xp = xL + (xR - xL) * pct;
        g.appendChild(line(xL, barY, xp, barY, scheme.strong, 6));  // colored fill
        } else {
        xp = xR - (xR - xL) * pct;
        g.appendChild(line(xR, barY, xp, barY, scheme.strong, 6));  // colored fill
        }
    } else {
        // progress unknown briefly after depart → park dot at origin side
        const origin = toNum(r.originTerminalId);
        xp = origin === 7 ? xR : origin === 3 ? xL : (dir === "ltr" ? xL : xR);
    }

    // moving dot must always be visible while underway
    g.appendChild(circleDot(xp, barY, 5.5, scheme.strong));
    } else {

      // docked: show dot at bar end closest to current dock (origin of next sailing)
      // place docked dot by actual origin terminal: 3=BI (left), 7=SEA (right)
        const origin = toNum(r.originTerminalId);
        const xp = origin === 7 ? xR : origin === 3 ? xL : (dir === "ltr" ? xL : xR);

      g.appendChild(circleDot(xp, barY, 5.5, scheme.light));
      // no colored fill while docked
    }
  }
  // ---- label hooks (docked vs underway) ----
  // recompute bar geometry locally to avoid touching existing logic
  if (dir) {
    const barWidth = 150;
    const xL = 200 - barWidth / 2;
    const xR = 200 + barWidth / 2;
    const barY = (y < 200) ? (y + 50) : (y - 50);
    const isTop = y < 200;
    const labelGapTop = 8;   // vertical gap from bar for top row
    const labelGapBot = 12;  // vertical gap from bar for bottom row
    const labelY = isTop ? (barY - labelGapTop) : (barY + labelGapBot);

    // endpoint x positions
    const originX = (dir === "ltr") ? xL : xR;
    const destX   = (dir === "ltr") ? xR : xL;

    // choose anchors so text is horizontally aligned to the bar end
    // anchors set so text aligns inward to bar ends
    const originAnchor = (dir === "ltr") ? "end" : "start";
    const destAnchor   = (dir === "ltr") ? "end" : "start";


    // strings
    const sched = r.scheduledDepartureTime || r.departureTime || "";
    const eta   = r.estimatedArrivalTime   || "";

    // draw one label depending on state
    if (!underway && sched) {
    // docked: place label 20px toward center from the origin end
    const inward = 40;
    const originXi = originX + (originX < 200 ? inward : -inward);

    const t = elNS("text", {
        x: originXi, y: labelY,
        "text-anchor": originAnchor, // inward-aligned to the bar end
        fill: "#111",
        "font-size": "10"
    });
    t.textContent = sched;
    g.appendChild(t);
    } else if (underway && eta) {
 
      const t = elNS("text", {
        x: destX, y: labelY,
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
  const nameY = (y >= 200) ? (y - 12) : (y + 20);
  const tn = elNS("text", { x: 200, y: nameY, "text-anchor": "middle", fill: "#222", "font-size": "12" });
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
      const rx = CX + INWARD, ry = CY;
      labels.appendChild(elText("SEATTLE", rx, ry, { anchor: "middle", fill: "#444", rotate: [90, rx, ry] }));
      const lx = CX - INWARD, ly = CY;
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
  function parseTodayLocal(hhmm) {
    if (!hhmm || typeof hhmm !== "string") return null;
    const now = new Date();
    const [time, ampmRaw] = hhmm.trim().split(/\s+/);
    if (!time || !ampmRaw) return null;
    const ampm = ampmRaw.toUpperCase();
    const [hStr, mStr] = time.split(":");
    let h = Number(hStr), m = Number(mStr);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (ampm === "PM" && h !== 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  function clamp01(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x; }
// pick the next occurrence of an hh:mm AM/PM within the next 24h
function parseNextOccurrence(hhmm) {
  const base = parseTodayLocal(hhmm);
  if (!base) return null;
  const now = Date.now();
  let t = base.getTime();
  // if that time already passed by >~1 minute, roll it to tomorrow
  if (t < now - 60 * 1000) t += 24 * 60 * 60 * 1000;
  return new Date(t);
}

// --- time + progress helpers ---
function computeProgress(actualDepartStr, etaStr) {
  const t0 = parseNextOccurrence(actualDepartStr);
  const t1 = parseNextOccurrence(etaStr);
  if (!t0 || !t1) return null;
  const a = t0.getTime(), b = t1.getTime();
  if (!(b > a)) return null;
  const now = Date.now();
  return clamp01((now - a) / (b - a));
}

function computeDockProgress(actualArriveStr, schedDepartStr) {
  const tD = parseNextOccurrence(schedDepartStr);
  if (!tD) return null;

  let tA = parseNextOccurrence(actualArriveStr);
  if (!tA) {
    // fallback dwell of 20 min ending at sched depart, roll if needed
    tA = new Date(tD.getTime() - 20 * 60 * 1000);
  }
  if (!(tD.getTime() > tA.getTime())) return null;
  const now = Date.now();
  return clamp01((now - tA.getTime()) / (tD.getTime() - tA.getTime()));
}

  function computeProgress(actualDepartStr, etaStr) {
    const t0 = parseTodayLocal(actualDepartStr);
    const t1 = parseTodayLocal(etaStr);
    if (!t0 || !t1) return null;
    const now = Date.now();
    const a = t0.getTime(), b = t1.getTime();
    if (!(b > a)) return null;
    return clamp01((now - a) / (b - a));
  }

  // debug: mark renderer loaded
  console.log("[ferryClock] ready");

  // --- dock progress + arc helpers ---
  function computeDockProgress(actualArriveStr, schedDepartStr) {
    const tD = parseTodayLocal(schedDepartStr);
    if (!tD) return null;

    // if arrival missing, assume fixed dwell ending at scheduled departure
    let tA = parseTodayLocal(actualArriveStr);
    if (!tA) {
      const fallbackMin = 20; // fallback dwell
      tA = new Date(tD.getTime() - fallbackMin * 60 * 1000);
    }
    if (!(tD > tA)) return null;
    const now = Date.now();
    return clamp01((now - tA.getTime()) / (tD.getTime() - tA.getTime()));
  }

  function polar(cx, cy, r, aDeg) {
    const a = (aDeg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
function polar(cx, cy, r, aDeg) {
  const a = (aDeg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// ---- capacity pie helpers ----
function drawCapacityPie(g, cx, cy, r, total, avail, color) {
  const frac = total > 0 ? Math.max(0, Math.min(1, avail / total)) : 0;
  g.appendChild(elNS("circle", { cx, cy, r, fill: color, stroke: "none" }));
  if (frac < 1) {
    const usedFrac = 1 - frac;
    g.appendChild(elNS("path", {
      d: sectorPath(cx, cy, r, -90, -90 + usedFrac * 360),
      fill: "#fff"
    }));
  }
  const txt = elNS("text", {
    x: cx, y: cy + 4, "text-anchor": "middle",
    fill: "#111", "font-size": "12", "font-weight": "600"
  });
  txt.textContent = Number.isFinite(avail) ? String(avail) : "—";
  g.appendChild(txt);
}

function sectorPath(cx, cy, r, a0Deg, a1Deg) {
  const a0 = (Math.PI / 180) * a0Deg;
  const a1 = (Math.PI / 180) * a1Deg;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = Math.abs(a1Deg - a0Deg) > 180 ? 1 : 0;
  const sweep = 1;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1} Z`;
}
})();
