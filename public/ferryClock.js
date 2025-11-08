// public/ferryClock.js — ferry-only rendering, no dependency on analogClock
(function () {
  const CX = 200, CY = 200, RIM = 182, INWARD = Math.round(RIM * 0.56);

  // --- bootstrap a stable API and a safe render path ---
  let _rows = [];

  // Public API
  window.ferry = {
    setData(rows) {
      _rows = Array.isArray(rows) ? rows : [];
      try {
        const names = _rows.slice(0, 2).map(r => r && r.vessel || null);
        console.log("ferry.setData:", _rows.length, names);
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
      const { top, bottom, clear } = layers;
      if (typeof clear === "function") clear(); else { top.innerHTML = ""; bottom.innerHTML = ""; }

      ensureLabels();

      const rows = _rows.slice(0, 2);
      drawRow(top, rows[0] || null, 95);
      drawRow(bottom, rows[1] || null, 305);
    }
  };

  // Back-compat shim for existing app.js calls
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

    // marker: centered on the 12–6 axis (x=200). Always draw.
    if (dir) {
      const y0 = y, halfLen = 28, head = 8;
      const stroke = underway ? "#222" : "#999";
      const xL = 200 - halfLen, xR = 200 + halfLen;

      if (dir === "ltr") {
        g.appendChild(line(xL, y0, xR, y0, stroke, 3));         // →
        g.appendChild(arrowHead(xR, y0, 0, stroke, 3, head));
        if (!underway) g.appendChild(circleDot(xL, y0, 2, stroke)); // origin tick at left
      } else { // rtl
        g.appendChild(line(xL, y0, xR, y0, stroke, 3));         // ←
        g.appendChild(arrowHead(xL, y0, Math.PI, stroke, 3, head));
        if (!underway) g.appendChild(circleDot(xR, y0, 2, stroke)); // origin tick at right
      }
    } else {
      const t = elNS("text", { x: 200, y, "text-anchor": "middle", fill: "#666", "font-size": "14" });
      t.textContent = "--";
      g.appendChild(t);
    }

    // progress bar: always draw a light track; fill only when we can compute progress
    if (dir) {
      const barWidth = 150;                 // length
      const xL = 200 - barWidth / 2;        // 125
      const xR = 200 + barWidth / 2;        // 275
      const barY = (y < 200) ? (y + 50) : (y - 50); // your chosen offsets

      // draw track even if scheduled or missing times
      g.appendChild(line(xL, barY, xR, barY, "#ddd", 6));

      // compute and draw progress fill only when both times exist and are sane
      const pct = computeProgress(r.actualDepartureTime, r.estimatedArrivalTime);
      if (pct != null) {
        if (dir === "ltr") {
          const xp = xL + (xR - xL) * pct;
          g.appendChild(line(xL, barY, xp, barY, "#2a2a2a", 6));
        } else {
          const xp = xR - (xR - xL) * pct;
          g.appendChild(line(xR, barY, xp, barY, "#2a2a2a", 6));
        }
      }
    }




     // ferry name: inside toward the center with extra clearance on the top row
    const name = (r.vessel && String(r.vessel).trim()) ? String(r.vessel) : "—";
    const nameY = (y >= 200) ? (y - 12) : (y + 20);
    const tn = elNS("text", { x: 200, y: nameY, "text-anchor": "middle", fill: "#222", "font-size": "12" });
    tn.textContent = name;
    g.appendChild(tn);
  }

  // ---------- face layers ----------
  function getLayers() {
    // Prefer faceRenderer if present
    if (typeof window.getFaceLayers === "function") return window.getFaceLayers();

    // Fallback: create local overlay + rows inside #clockFace
    const svg = document.getElementById("clockFace");
    if (!svg) return null;
    const overlay = ensure(svg, "g", { id: "clock-overlay", "font-family": "system-ui, Arial, sans-serif" });
    const top = ensure(overlay, "g", { id: "row-top" });
    const bottom = ensure(overlay, "g", { id: "row-bot" });
    return { overlay, top, bottom, clear() { top.innerHTML = ""; bottom.innerHTML = ""; } };
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
    // Expect "12:34 PM" style. Build a Date for today in local time.
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
  function computeProgress(actualDepartStr, etaStr) {
    const t0 = parseTodayLocal(actualDepartStr);
    const t1 = parseTodayLocal(etaStr);
    if (!t0 || !t1) return null;
    const now = Date.now();
    const a = t0.getTime(), b = t1.getTime();
    if (!(b > a)) return null;
    return clamp01((now - a) / (b - a));
  }



})();
