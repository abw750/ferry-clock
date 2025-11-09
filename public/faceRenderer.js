// faceRenderer.js — owns SVG layers only. No time. No ferries.
(function () {
  const SVG_ID = "clockFace";
  const svg = document.getElementById(SVG_ID);
  if (!svg) return;

  // Ensure a single overlay root
  const overlay = ensure(svg, "g", { id: "clock-overlay", "font-family": "system-ui, Arial, sans-serif" });

  // Two stable row groups for consumers
  const rowTop = ensure(overlay, "g", { id: "row-top" });
  const rowBot = ensure(overlay, "g", { id: "row-bot" });

  // Public accessor for engines
  window.getFaceLayers = function getFaceLayers() {
    return {
      overlay,
      top: rowTop,
      bottom: rowBot,
      clear() { rowTop.innerHTML = ""; rowBot.innerHTML = ""; }
    };
  };

  function ensure(parent, tag, attrs) {
    const ns = "http://www.w3.org/2000/svg";
    const id = attrs && attrs.id;
    let node = id ? parent.querySelector(`#${id}`) : null;
    if (!node) node = document.createElementNS(ns, tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (!node.parentNode) parent.appendChild(node);
    return node;
  }
    // ----- minute ticks + mid ring (static once) -----
  (function ensureMinuteFace() {
    const svg = document.getElementById("clockFace");
    if (!svg) return;

    // if already built, skip
    if (svg.querySelector("#minute-face")) return;

    const ns = "http://www.w3.org/2000/svg";
    const G = document.createElementNS(ns, "g");
    G.setAttribute("id", "minute-face");
    G.setAttribute("stroke", "#333");
    G.setAttribute("stroke-linecap", "round");
    svg.appendChild(G);

    // circles currently at r=198 and r=180; add a thin mid ring at r=189
    const C = { cx: 200, cy: 200 };
    const mid = document.createElementNS(ns, "circle");
    mid.setAttribute("cx", C.cx);
    mid.setAttribute("cy", C.cy);
    mid.setAttribute("r", "169");
    mid.setAttribute("fill", "none");
    mid.setAttribute("stroke", "#2b2b2b");
    mid.setAttribute("stroke-width", "1");
    G.appendChild(mid);

    // minute ticks: 60 spokes between the two rings; every 5th extends beyond the outside ring
    const rInner = 160;
    const rOuter = 178;
    const rOuterLong = 182; // extend slightly past the outer ring

    for (let i = 0; i < 60; i++) {
      const isFive = (i % 5) === 0;
      const a = (Math.PI / 30) * i - Math.PI / 2; // start at 12 o'clock
      const x1 = C.cx + (isFive ? rInner - 4 : rInner) * Math.cos(a);
      const y1 = C.cy + (isFive ? rInner - 4 : rInner) * Math.sin(a);
      const x2 = C.cx + (isFive ? rOuterLong : rOuter) * Math.cos(a);
      const y2 = C.cy + (isFive ? rOuterLong : rOuter) * Math.sin(a);

      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.setAttribute("stroke-width", isFive ? "3" : "1.5");
      G.appendChild(line);
    }
  })();

})();
