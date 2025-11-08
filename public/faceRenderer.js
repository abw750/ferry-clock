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
})();
