/**
 * Server-side SVG charts, no dependencies. Colours come from theme tokens (`var(--adm-*)`) so charts
 * follow light/dark and the application's own palette. Every chart has role="img", a <title> and a
 * text summary for screen readers.
 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function niceMax(v, integer = false) {
  if (v <= 0) return integer ? 4 : 1;
  const p = 10 ** Math.floor(Math.log10(v));
  let out = 10 * p;
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) { out = m * p; break; }
  // Whole-number data (request counts): the four steps of the axis must be whole numbers too.
  return integer ? Math.max(4, Math.ceil(out / 4) * 4) : out;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function frame({ width, height, title, summary, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}: ${esc(summary)}" style="max-width:${width}px;font:11px system-ui,sans-serif"><title>${esc(title)}: ${esc(summary)}</title>${body}</svg>`;
}

function axes({ width, height, pad, max, labels, every }) {
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ih - (ih * i) / 4;
    g += `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y}" y2="${y}" stroke="var(--adm-border)" stroke-width="1"/>`;
    g += `<text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" fill="var(--adm-text-dim)">${fmt((max * i) / 4)}</text>`;
  }
  const step = iw / labels.length;
  labels.forEach((l, i) => {
    if (i % every === 0) g += `<text x="${pad.l + step * i + step / 2}" y="${height - pad.b + 14}" text-anchor="middle" fill="var(--adm-text-dim)">${esc(l)}</text>`;
  });
  return g;
}

/** @param {{label:string,value:number}[]} points */
export function svgBarChart(points, { title = '', width = 640, height = 200, color = 'var(--adm-accent)', unit = '' } = {}) {
  const pad = { l: 40, r: 8, t: 8, b: 22 };
  const vals = points.map((p) => p.value ?? 0);
  const max = niceMax(Math.max(0, ...vals), vals.every((p) => Number.isInteger(p)));
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const step = iw / Math.max(points.length, 1);
  const bw = Math.max(1, step * 0.7);
  let bars = ''; let hits = '';
  points.forEach((p, i) => {
    if (p.value === null || p.value === undefined) return;
    const h = (ih * p.value) / max;
    bars += `<rect x="${pad.l + step * i + (step - bw) / 2}" y="${pad.t + ih - h}" width="${bw}" height="${h}" rx="1.5" fill="${color}"><title>${esc(p.label)}: ${fmt(p.value)}${esc(unit)}</title></rect>`;
    // a hover target as tall as the chart: a short bar is as easy to point at as a tall one
    hits += `<rect class="adm-hit" x="${pad.l + step * i}" y="${pad.t}" width="${step}" height="${ih}" fill="transparent"><title>${esc(p.label)}: ${fmt(p.value)}${esc(unit)}</title></rect>`;
  });
  const total = points.reduce((a, p) => a + (p.value ?? 0), 0);
  const body = axes({ width, height, pad, max, labels: points.map((p) => p.label), every: Math.ceil(points.length / 8) }) + bars + hits;
  return frame({ width, height, title, summary: `${points.length} · Σ ${fmt(total)}${unit}`, body });
}

export function svgLineChart(points, { title = '', width = 640, height = 200, color = 'var(--adm-accent)', unit = '' } = {}) {
  const pad = { l: 40, r: 8, t: 8, b: 22 };
  const vals = points.map((p) => p.value ?? 0);
  const max = niceMax(Math.max(0, ...vals), vals.every((p) => Number.isInteger(p)));
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const step = iw / Math.max(points.length, 1);
  const xy = points.map((p, i) => (p.value === null || p.value === undefined ? null : [pad.l + step * i + step / 2, pad.t + ih - (ih * p.value) / max]));
  // A point without data breaks the line instead of dropping to zero.
  const path = xy.map((c, i) => (c ? `${i > 0 && xy[i - 1] ? 'L' : 'M'}${c[0].toFixed(1)} ${c[1].toFixed(1)}` : '')).filter(Boolean).join(' ');
  const dots = points.map((p, i) => (xy[i] ? `<circle cx="${xy[i][0].toFixed(1)}" cy="${xy[i][1].toFixed(1)}" r="2.5" fill="${color}"><title>${esc(p.label)}: ${fmt(p.value)}${esc(unit)}</title></circle><circle class="adm-hit" cx="${xy[i][0].toFixed(1)}" cy="${xy[i][1].toFixed(1)}" r="9" fill="transparent"><title>${esc(p.label)}: ${fmt(p.value)}${esc(unit)}</title></circle>` : '')).join('');
  const known = points.filter((p) => p.value !== null && p.value !== undefined);
  const last = known.length ? known[known.length - 1].value : 0;
  const body = axes({ width, height, pad, max, labels: points.map((p) => p.label), every: Math.ceil(points.length / 8) })
    + (path ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>` : '') + dots;
  return frame({ width, height, title, summary: `${points.length} · ${fmt(last)}${unit}`, body });
}
