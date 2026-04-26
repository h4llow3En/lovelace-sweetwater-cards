import type { HistoryPoint } from './history';

function timeSampleHistory(history: HistoryPoint[], hours: number, samples = 144): number[] {
  const valid = history.map(p => {
    const val = parseFloat(p.s ?? p.state ?? '');
    const ts = p.lu
      ? p.lu * 1000
      : new Date(p.last_changed ?? p.last_updated ?? 0).getTime();
    return { val, ts };
  }).filter(p => !isNaN(p.val) && !isNaN(p.ts));

  if (valid.length === 0) return [];
  if (valid.length === 1) return Array(samples).fill(valid[0].val) as number[];

  const now = Date.now();
  const start = now - hours * 3600 * 1000;
  const chunkMs = (hours * 3600 * 1000) / samples;

  return Array.from({ length: samples }, (_, i) => {
    const chunkStart = start + i * chunkMs;
    const chunkEnd = chunkStart + chunkMs;
    const inChunk = valid.filter(p => p.ts >= chunkStart && p.ts < chunkEnd);
    if (inChunk.length > 0) {
      return inChunk.reduce((sum, p) => sum + p.val, 0) / inChunk.length;
    }
    const before = valid.filter(p => p.ts < chunkStart);
    return before.length > 0 ? before[before.length - 1].val : valid[0].val;
  });
}

function gaussianSmooth(values: number[], sigma = 2.0): number[] {
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
  );
  const kSum = kernel.reduce((a, b) => a + b, 0);
  return values.map((_, ci) =>
    kernel.reduce((sum, w, j) => {
      const idx = Math.max(0, Math.min(values.length - 1, ci + j - radius));
      return sum + values[idx] * w;
    }, 0) / kSum,
  );
}

export function buildGraph(history: HistoryPoint[] | null, hours = 24): string {
  if (!history || history.length < 2) return '';

  const samples = Math.max(Math.ceil(hours) * 6, 60);
  const raw = timeSampleHistory(history, hours, samples);
  if (raw.length < 2) return '';
  const values = gaussianSmooth(raw);

  const W = 300, H = 80;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 0.08;

  const pts: [number, number][] = values.map((val, i, arr) => [
    (i / (arr.length - 1)) * W,
    H - pad * H - ((val - min) / range) * H * (1 - 2 * pad),
  ]);

  // Monotone cubic spline tangents (Fritsch-Carlson)
  const m: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    m.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
  }
  const t = [m[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    t.push(m[i - 1] * m[i] <= 0 ? 0 : 2 * m[i - 1] * m[i] / (m[i - 1] + m[i]));
  }
  t.push(m[m.length - 1]);

  let line = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const dx = (x2 - x1) / 3;
    line += ` C${(x1 + dx).toFixed(1)},${(y1 + t[i] * dx).toFixed(1)} ${(x2 - dx).toFixed(1)},${(y2 - t[i + 1] * dx).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }

  const fill = `${line} L${W},${H} L0,${H} Z`;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
         preserveAspectRatio="none" style="width:100%;height:100%;display:block;">
      <defs>
        <linearGradient id="sw-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="var(--sw-room-card-color)" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="var(--sw-room-card-color)" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${fill}" fill="url(#sw-grad)" stroke="none"/>
      <path d="${line}" fill="none"
            stroke="var(--sw-room-card-color)"
            style="stroke-width:var(--sw-room-card-graph-width);"
            stroke-linecap="round" stroke-linejoin="round"
            vector-effect="non-scaling-stroke"/>
    </svg>`;
}
