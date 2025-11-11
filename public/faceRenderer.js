// public/faceRenderer.js — owns SVG layers only. No time. No ferries.
(function () {
  function init() {
    const SVG_ID = "clockFace";
    const svg = document.getElementById(SVG_ID);
    if (!svg) { setTimeout(init, 50); return; }

    // Ensure a single overlay root
    const overlay = ensure(svg, "g", { id: "clock-overlay" });

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

    // ----- minute ticks + mid ring (static once) -----
    if (!svg.querySelector("#minute-face")) {
      const ns = "http://www.w3.org/2000/svg";
      const G = document.createElementNS(ns, "g");
      G.setAttribute("id", "minute-face"); // styling via CSS
      svg.appendChild(G);

      // mid ring
      const C = { cx: 200, cy: 200 };
      const mid = document.createElementNS(ns, "circle");
      mid.setAttribute("cx", String(C.cx));
      mid.setAttribute("cy", String(C.cy));
      mid.setAttribute("r", "169");
      mid.setAttribute("fill", "none"); // prevent black dial fill
      G.appendChild(mid);

      // minute ticks: 60 spokes; every 5th is longer
      const rInner = 160;
      const rOuter = 178;
      const rOuterLong = 182;

      for (let i = 0; i < 60; i++) {
        const isFive = (i % 5) === 0;
        const a = (Math.PI / 30) * i - Math.PI / 2;

        const x1 = C.cx + (isFive ? (rInner - 4) : rInner) * Math.cos(a);
        const y1 = C.cy + (isFive ? (rInner - 4) : rInner) * Math.sin(a);
        const x2 = C.cx + (isFive ? rOuterLong : rOuter) * Math.cos(a);
        const y2 = C.cy + (isFive ? rOuterLong : rOuter) * Math.sin(a);

        const tick = document.createElementNS(ns, "line");
        tick.setAttribute("x1", String(x1));
        tick.setAttribute("y1", String(y1));
        tick.setAttribute("x2", String(x2));
        tick.setAttribute("y2", String(y2));
        G.appendChild(tick);
      }
    }
  }

  function ensure(parent, tag, attrs) {
    const ns = "http://www.w3.org/2000/svg";
    const id = attrs && attrs.id;
    let node = id ? parent.querySelector(`#${id}`) : null;
    if (!node) node = document.createElementNS(ns, tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (!node.parentNode) parent.appendChild(node);
    return node;
  }

  // Run after DOM is ready so #clockFace exists.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
