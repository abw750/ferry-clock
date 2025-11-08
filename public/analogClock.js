// public/analogClock.js — clock-only scaffolding. No ferry visuals.
(function () {
  const SVG_ID = "clockFace";
  const svg = document.getElementById(SVG_ID);
  if (!svg) return;

  // Create a single overlay with two named row groups. Nothing is drawn here.
  const overlay = ensure(svg, "g", { id: "clock-overlay", "font-family": "system-ui, Arial, sans-serif" });
  const row1 = ensure(overlay, "g", { id: "row-top" });
  const row2 = ensure(overlay, "g", { id: "row-bot" });

  // Expose handles so other modules can render into these groups.
  window.getClockRows = function getClockRows() {
    return {
      top: row1,
      bottom: row2,
      clear() { row1.innerHTML = ""; row2.innerHTML = ""; }
    };
  };

  // --- tiny helpers ---
  function ensure(parent, tag, attrs) {
    const ns = "http://www.w3.org/2000/svg";
    let node = (attrs.id && parent.querySelector(`#${attrs.id}`)) || null;
    if (!node) node = document.createElementNS(ns, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (!node.parentNode) parent.appendChild(node);
    return node;
  }

    // --- clock hands (hour + minute), drawn above overlay ---
  const hands = ensure(svg, "g", { id: "clock-hands", stroke: "#222", "stroke-linecap": "round" });
  const hourHand   = ensure(hands, "line", { id: "hand-hour",   x1: 200, y1: 200, x2: 200, y2: 130, "stroke-width": 5 });
  const minuteHand = ensure(hands, "line", { id: "hand-minute", x1: 200, y1: 200, x2: 200, y2:  90, "stroke-width": 3 });
  const pin        = ensure(hands, "circle", { cx: 200, cy: 200, r: 4, fill: "#222" });

  function setRot(node, deg) {
    node.setAttribute("transform", `rotate(${deg} 200 200)`);
  }
  function tick() {
    const now = new Date();
    const h = now.getHours() % 12;
    const m = now.getMinutes();
    const s = now.getSeconds();
    const ha = (h + m / 60) * 30;   // 360/12
    const ma = (m + s / 60) * 6;    // 360/60
    setRot(hourHand, ha);
    setRot(minuteHand, ma);
  }
  tick();
  setInterval(tick, 1000);

})();
