
export function flatten(input) {
  const out = {};
  walk(input, "");
  return out;
  function walk(val, path) {
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(v, path ? `${path}[${i}]` : `[${i}]`));
    } else if (val && typeof val === "object") {
      for (const k of Object.keys(val)) {
        const next = path ? `${path}.${k}` : k;
        walk(val[k], next);
      }
    } else {
      out[path || "(root)"] = val;
    }
  }
}

