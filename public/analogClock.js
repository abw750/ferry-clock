// public/analogClock.js — clock-only scaffolding. No ferry visuals.
console.log("[analogClock] init, svg found:", !!document.getElementById("clockFace"));

(function initClock() {
    const SVG_ID = "clockFace";
    const svg = document.getElementById(SVG_ID);
    if (!svg) { document.addEventListener("DOMContentLoaded", initClock, { once: true }); return; }

    // --- clock hands (hour + minute), drawn above overlay ---
    const hands = ensure(svg, "g", { id: "clock-hands" });
    const hourHand   = ensure(hands, "line", { id: "hand-hour",   x1: 200, y1: 200, x2: 200, y2: 105 });
    const minuteHand = ensure(hands, "line", { id: "hand-minute", x1: 200, y1: 200, x2: 200, y2: 65  });
    const secondHand = ensure(hands, "line", { id: "hand-second", x1: 200, y1: 200, x2: 200, y2: 25  });
    ensure(hands, "circle", { cx: 200, cy: 200, r: 4 });



    function setRot(node, deg) {
        node.setAttribute("transform", `rotate(${deg} 200 200)`);
    }

    function tick() {
        const now = new Date();
        const s = now.getSeconds();
        const m = now.getMinutes();
        const h = now.getHours() % 12;
        const ha = (h + m / 60) * 30;
        const ma = (m + s / 60) * 6;

        // 10 sub-steps per second
        const sub = Math.floor((now.getMilliseconds() / 1000) * 10);
        const sAdj = s + sub / 10;

        setRot(hourHand, ha);
        setRot(minuteHand, ma);
        setRot(secondHand, sAdj * 6);
    }

tick();
setInterval(tick, 100); // 10 ticks per second

  // --- tiny helpers ---
  function ensure(parent, tag, attrs) {
    const ns = "http://www.w3.org/2000/svg";
    let node = (attrs.id && parent.querySelector(`#${attrs.id}`)) || null;
    if (!node) node = document.createElementNS(ns, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (!node.parentNode) parent.appendChild(node);
    return node;
  }
})();
