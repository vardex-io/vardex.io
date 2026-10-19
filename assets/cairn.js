/*
 * Binary cairn
 *
 * A cairn printed in ones into a field of zeros: each stone is traced, then
 * filled row by row, the stack is held and scanned, and it is released back
 * into the grid from the top. Every frame is a pure function of time, so the
 * loop has no seam.
 *
 * Markup:
 *   <canvas data-cairn="dark|paper" data-cairn-slot="#slot" data-cairn-field="full|local"
 *           data-cairn-quiet=".copy, .nav"></canvas>
 *
 * The canvas is sized by CSS. The cairn is fitted inside the slot element
 * (the canvas itself if no slot is given). Elements matched by the quiet
 * selector get a fainter field with no blinking bits behind them. Colours are read from the canvas's
 * --cairn-bg, --cairn-ink and --cairn-flash custom properties.
 *   dark   light bits on a dark ground, lit faces carry the most ones
 *   paper  ink bits on paper, shadows carry the most ones, contours are inked
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Timeline (seconds)
  // ---------------------------------------------------------------------------
  const LOOP = 11.2;
  const GROUND_IN_DUR = 0.8;                     // horizon draws out on the first play only
  const BUILD_START = 0.55;                      // first stone starts filling
  const OUTLINE_LEAD = 0.55, OUTLINE_DUR = 0.55; // contour traced before each fill
  const RESOLVE = 0.34;                          // bits scramble before they lock
  const FLASH = 0.22;                            // afterglow of a freshly locked bit
  const SCAN_START = 6.5, SCAN_DUR = 1.4;        // verification pass while holding
  const DISSOLVE = 8.7, DISSOLVE_SPAN = 1.45;    // top-down release
  const HOLD_FRAME = 6.0;                        // still frame for reduced motion

  const AMBIENT = 0.22;
  const ROWS_TALL = 64;                          // cairn height in grid rows

  // Stones, bottom to top. w/h in cairn units (ground at y = 0), rot in radians,
  // sh leans the top of a stone sideways, pt/pb are superellipse exponents for
  // the upper and lower half of each stone.
  const SPEC = [
    { w: 0.68, h: 0.160, rot: -0.035, dx:  0.000, sh:  0.05, tone: 0.78, pt: 2.6, pb: 3.6, strata: 0 },
    { w: 0.50, h: 0.115, rot:  0.070, dx:  0.030, sh: -0.08, tone: 0.58, pt: 2.8, pb: 3.2, strata: 1 },
    { w: 0.46, h: 0.170, rot: -0.060, dx: -0.020, sh:  0.10, tone: 0.92, pt: 2.0, pb: 2.5, strata: 0 },
    { w: 0.32, h: 0.100, rot:  0.100, dx:  0.022, sh: -0.06, tone: 0.66, pt: 2.6, pb: 3.0, strata: 1 },
    { w: 0.25, h: 0.130, rot: -0.070, dx: -0.010, sh:  0.08, tone: 0.86, pt: 1.9, pb: 2.3, strata: 0 },
    { w: 0.15, h: 0.100, rot:  0.050, dx:  0.010, sh:  0.00, tone: 0.98, pt: 1.8, pb: 2.2, strata: 0 },
  ];

  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  // ---------------------------------------------------------------------------
  // Maths helpers
  // ---------------------------------------------------------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const easeInOut = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(x, 0, 1));
  const easeInOutInv = (v) => Math.acos(1 - 2 * clamp(v, 0, 1)) / Math.PI;

  function hash3(a, b, c) {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2f0f2b6b);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash3(xi, yi, s), b = hash3(xi + 1, yi, s);
    const c = hash3(xi, yi + 1, s), d = hash3(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < 4; o++) { sum += amp * vnoise(x * f, y * f, s + o * 17); norm += amp; amp *= 0.5; f *= 2.03; }
    return sum / norm;
  }
  function mulberry32(a) {
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Stone geometry (resolution independent, built once)
  // ---------------------------------------------------------------------------
  function stoneF(s, X, Y) {
    const dx = X - s.cx, dy = Y - s.cy;
    const lx = dx * s.cos + dy * s.sin, ly = -dx * s.sin + dy * s.cos;
    const u = (lx - s.sh * ly) / s.a, v = ly / s.b;
    const th = Math.atan2(v, u);
    let r = 1;
    for (let m = 0; m < 5; m++) r += s.amps[m] * Math.cos((m + 2) * th + s.phs[m]);
    const p = v < 0 ? s.pb : s.pt;
    return Math.pow(Math.pow(Math.abs(u), p) + Math.pow(Math.abs(v), p), 1 / p) / r;
  }

  function boundary(s, n) {
    n = n || 180;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      const p = sn < 0 ? s.pb : s.pt;
      let r = 1;
      for (let m = 0; m < 5; m++) r += s.amps[m] * Math.cos((m + 2) * th + s.phs[m]);
      const k = r / Math.pow(Math.pow(Math.abs(c), p) + Math.pow(Math.abs(sn), p), 1 / p);
      const ly = sn * k * s.b, lx = c * k * s.a + s.sh * ly;
      pts.push({ x: s.cx + lx * s.cos - ly * s.sin, y: s.cy + lx * s.sin + ly * s.cos, lower: sn < 0 });
    }
    return pts;
  }

  function buildStones() {
    const rnd = mulberry32(20261019);
    const base = [0.05, 0.035, 0.022, 0.012, 0.007];
    const out = [];
    for (let k = 0; k < SPEC.length; k++) {
      const sp = SPEC[k];
      const s = Object.assign({}, sp, {
        a: sp.w / 2, b: sp.h / 2, cos: Math.cos(sp.rot), sin: Math.sin(sp.rot),
        amps: base.map((v) => v * (0.5 + 0.8 * rnd())), phs: base.map(() => rnd() * Math.PI * 2),
        cx: sp.dx, cy: 0, depth: sp.h * 0.55,
      });
      if (k === 0) {
        s.cy = -Math.min(...boundary(s).map((p) => p.y)) - 0.006; // sunk slightly into the ground
      } else {
        const below = out[k - 1];
        s.cy = Math.max(...boundary(below).map((p) => p.y)) + s.b + 0.04;
        // Lower the stone until its underside just settles into the one below.
        for (let it = 0; it < 600; it++) {
          if (boundary(s, 120).some((p) => p.lower && stoneF(below, p.x, p.y) < 0.965)) break;
          s.cy -= 0.001;
        }
      }
      const pts = boundary(s);
      s.ymin = Math.min(...pts.map((p) => p.y));
      s.ymax = Math.max(...pts.map((p) => p.y));
      s.xmin = Math.min(...pts.map((p) => p.x));
      s.xmax = Math.max(...pts.map((p) => p.x));
      out.push(s);
    }
    // Print schedule: each stone starts while the previous one is finishing.
    let start = BUILD_START;
    for (const s of out) {
      s.start = start;
      s.dur = 0.45 + 4.0 * s.h;
      start += 0.82 * s.dur;
    }
    return out;
  }

  const stones = buildStones();
  const cairn = {
    top: Math.max(...stones.map((s) => s.ymax)),
    xmin: Math.min(...stones.map((s) => s.xmin)),
    xmax: Math.max(...stones.map((s) => s.xmax)),
  };

  function glyphSprites(c, color, weight) {
    const gw = Math.max(3, Math.round(c * 0.44));
    const gh = Math.max(5, Math.round(c * 0.64));
    const sw = Math.max(1, Math.round(c * weight));
    const x0 = Math.round((c - gw) / 2), y0 = Math.round((c - gh) / 2);

    const zero = document.createElement('canvas'); zero.width = zero.height = c;
    let g = zero.getContext('2d');
    g.strokeStyle = color; g.lineWidth = sw;
    g.beginPath();
    const iw = gw - sw, ih = gh - sw;
    if (g.roundRect) g.roundRect(x0 + sw / 2, y0 + sw / 2, iw, ih, iw / 2);
    else g.ellipse(x0 + gw / 2, y0 + gh / 2, iw / 2, ih / 2, 0, 0, Math.PI * 2);
    g.stroke();

    const one = document.createElement('canvas'); one.width = one.height = c;
    g = one.getContext('2d');
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = sw;
    const stemX = x0 + Math.round((gw - sw) / 2 + gw * 0.08);
    g.fillRect(stemX, y0, sw, gh);
    g.beginPath();
    g.moveTo(stemX + sw * 0.5, y0 + sw * 0.5);
    g.lineTo(stemX + sw * 0.5 - gw * 0.42, y0 + gh * 0.26);
    g.stroke();
    g.fillRect(x0 + Math.round(gw * 0.08), y0 + gh - sw, gw - Math.round(gw * 0.08), sw);
    return [zero, one];
  }

  // ---------------------------------------------------------------------------
  // One canvas
  // ---------------------------------------------------------------------------
  function mount(canvas, opts) {
    opts = opts || {};
    const paper = (opts.mode || canvas.dataset.cairn) === 'paper';
    const fieldFull = (opts.field || canvas.dataset.cairnField || (paper ? 'local' : 'full')) === 'full';
    const slotSel = opts.slot || canvas.dataset.cairnSlot;
    const slot = (typeof slotSel === 'string' ? document.querySelector(slotSel) : slotSel) || canvas;
    const ctx = canvas.getContext('2d', { alpha: false });

    let W = 0, H = 0, cell = 8, cols = 0, rows = 0, N = 0, cellU = 0.01;
    let bgColor, tinted;
    let kind, sidx, edge, px, py, Yc, alb, nX, nY, nZ, rim, thr, lockT, outT, dissT, abg, flickN, flickP, gFall, gShade, gRow;
    let stoneCells, groundCells, flickCells;
    let ink, fl, glowSpr, bgLayer;
    let outIdx, outGlyph, outAlpha, outFlash;

    function setup() {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(7e6 / (cssW * cssH))));
      W = Math.round(cssW * dpr); H = Math.round(cssH * dpr);
      canvas.width = W; canvas.height = H;

      const cs = getComputedStyle(canvas);
      bgColor = cs.getPropertyValue('--cairn-bg').trim() || (paper ? '#f4f2ee' : '#060606');
      const inkColor = cs.getPropertyValue('--cairn-ink').trim() || (paper ? '#1c1f1e' : '#f4f4f2');
      const flashColor = cs.getPropertyValue('--cairn-flash').trim() || inkColor;
      tinted = flashColor.toLowerCase() !== inkColor.toLowerCase();

      // Fit the cairn into the slot, with room for the ground plane below it.
      const sr = slot === canvas ? rect : slot.getBoundingClientRect();
      const sx = sr.left - rect.left, sy = sr.top - rect.top, sw = sr.width, sh = sr.height;
      const bw = cairn.xmax - cairn.xmin, bh = cairn.top;
      const Scss = Math.min((0.94 * sw) / bw, (0.86 * sh) / bh);
      const minCell = dpr >= 1.75 ? 5.5 : dpr >= 1.25 ? 6.5 : 8;
      cell = Math.max(4, Math.round(clamp((bh * Scss) / ROWS_TALL, minCell, 14) * dpr));
      const S = Scss * dpr;
      cellU = cell / S;

      const fcx = (sx + sw / 2) * dpr;
      const cx = fcx - (S * (cairn.xmin + cairn.xmax)) / 2;
      const gy = Math.round((sy + sh * 0.93) * dpr);
      const fcy = gy - (bh * S) / 2;
      const left0 = Math.round(cx - cell / 2);
      const firstLeft = left0 - Math.ceil(left0 / cell) * cell;
      const firstTop = gy - Math.ceil(gy / cell) * cell;
      cols = Math.ceil((W - firstLeft) / cell);
      rows = Math.ceil((H - firstTop) / cell);
      N = cols * rows;

      kind = new Uint8Array(N); sidx = new Int8Array(N).fill(-1); edge = new Uint8Array(N);
      px = new Int32Array(N); py = new Int32Array(N); Yc = new Float32Array(N);
      alb = new Float32Array(N); nX = new Float32Array(N); nY = new Float32Array(N); nZ = new Float32Array(N);
      rim = new Float32Array(N); thr = new Float32Array(N);
      lockT = new Float32Array(N); outT = new Float32Array(N).fill(-1); dissT = new Float32Array(N);
      abg = new Float32Array(N); flickN = new Uint8Array(N); flickP = new Float32Array(N);
      gFall = new Float32Array(N); gShade = new Float32Array(N); gRow = new Uint8Array(N);

      // The zero field: centred on the cairn. A local field fades out before the
      // canvas edge so the canvas can sit on a page without showing its border.
      const fieldA = paper ? 0.055 : 0.062;
      const rx = fieldFull ? Math.hypot(W, H) * 0.6 : Math.min(fcx, W - fcx, fcy, H - fcy);
      const ry = rx;
      const floor = fieldFull ? 0.45 : 0;
      const horizonW = paper ? 0.9 : fieldFull ? 1.6 : 0.66;

      const quietSel = opts.quiet || canvas.dataset.cairnQuiet;
      const quiet = quietSel ? Array.prototype.map.call(document.querySelectorAll(quietSel), (el) => {
        const q = el.getBoundingClientRect(), pad = 24;
        return [(q.left - rect.left - pad) * dpr, (q.top - rect.top - pad) * dpr, (q.right - rect.left + pad) * dpr, (q.bottom - rect.top + pad) * dpr];
      }) : [];
      const isQuiet = (x, y) => quiet.some((q) => x > q[0] && x < q[2] && y > q[1] && y < q[3]);

      const Ldir = { x: -0.53, y: 0.85 }; // toward the key light, for cast shadows
      const e = cellU * 0.35;

      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          const x = firstLeft + i * cell, y = firstTop + j * cell;
          px[idx] = x; py[idx] = y;
          const X = (x + cell / 2 - cx) / S, Y = (gy - (y + cell / 2)) / S;
          Yc[idx] = Y;
          thr[idx] = (BAYER4[(j & 3) * 4 + (i & 3)] + 0.5) / 16;
          const r = Math.hypot((x + cell / 2 - fcx) / rx, (y + cell / 2 - fcy) / ry);
          const edgeFade = fieldFull ? 1 : 1 - smooth(0.82, 1.0, Math.abs(x + cell / 2 - fcx) / rx);
          abg[idx] = fieldA * (floor + (1 - floor) * (1 - smooth(fieldFull ? 0.2 : 0.3, 1.0, r)));

          // Topmost stone covering this cell
          let k = -1;
          for (let s = stones.length - 1; s >= 0; s--) {
            const st = stones[s];
            if (X < st.xmin - 0.01 || X > st.xmax + 0.01 || Y < st.ymin - 0.01 || Y > st.ymax + 0.01) continue;
            if (stoneF(st, X, Y) < 1) { k = s; break; }
          }

          if (k >= 0) {
            const st = stones[k];
            kind[idx] = 1; sidx[idx] = k;
            // Surface normal from a rounded height profile
            const hgt = (xx, yy) => { const fv = stoneF(st, xx, yy); return fv >= 1 ? 0 : st.depth * Math.pow(1 - Math.pow(fv, 2.4), 0.5); };
            const gx = (hgt(X + e, Y) - hgt(X - e, Y)) / (2 * e);
            const gyy = (hgt(X, Y + e) - hgt(X, Y - e)) / (2 * e);
            let nx = -gx, ny = -gyy, nz = 1;
            const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
            nX[idx] = nx; nY[idx] = ny; nZ[idx] = nz;

            // Albedo: tone, mottling, grain and (for some stones) sediment bands
            const lyL = -(X - st.cx) * st.sin + (Y - st.cy) * st.cos;
            let a = st.tone;
            a *= 0.80 + 0.40 * fbm(X * 9 + k * 3.1, Y * 9, 11 + k);
            a *= 0.86 + 0.28 * fbm(X * 42, Y * 42, 29 + k);
            if (vnoise(X * 95, Y * 95, 53 + k) > 0.8) a *= 0.62;
            if (st.strata) {
              const band = 0.5 + 0.5 * Math.sin((lyL / st.b) * 7.5 + fbm(X * 6, Y * 6, 71 + k) * 5);
              a *= 1 - 0.16 * band * band;
            }
            // Contact occlusion and cast shadow from the stone above
            let occ = 1;
            if (k < stones.length - 1) {
              const up = stones[k + 1];
              occ *= 0.30 + 0.70 * smooth(1.0, 1.32, stoneF(up, X, Y));
              occ *= 0.50 + 0.50 * smooth(0.92, 1.12, stoneF(up, X + Ldir.x * 0.05, Y + Ldir.y * 0.05));
            }
            if (k === 0) occ *= 0.40 + 0.60 * smooth(0.0, 0.05, Y);
            alb[idx] = a * occ;
            rim[idx] = 0.42 * Math.pow(1 - nz, 2.2) * Math.max(0, nx * 0.9 + ny * 0.25) * smooth(0.0, 0.03, Y) * occ;

            // Print order: horizontal layers rising through the stone
            const vn = (Y - st.ymin) / (st.ymax - st.ymin);
            lockT[idx] = st.start + st.dur * easeInOutInv(vn) + (hash3(i, j, 5) - 0.5) * 0.07;
            dissT[idx] = DISSOLVE + DISSOLVE_SPAN * (1 - Y / cairn.top) + 0.3 * hash3(i, j, 9);
          } else if (Y < 0 && Y > -cellU * 5.5) {
            // Horizon (row 0) and a short ground plane receding below it
            const row = Math.floor(-Y / cellU);
            const shade = Math.exp(-Math.pow((X - 0.11) / 0.40, 4));
            const fall = row === 0
              ? Math.exp(-Math.pow(X / horizonW, 2)) * edgeFade
              : Math.pow(1 - row / 6, 1.8) * Math.exp(-Math.pow(X / 0.62, 2)) * (0.85 + 0.3 * fbm(X * 20, Y * 20, 91)) * edgeFade;
            if (fall > 0.04) {
              kind[idx] = 2; gRow[idx] = row; gFall[idx] = fall; gShade[idx] = shade;
              lockT[idx] = GROUND_IN_DUR * Math.pow(Math.min(1, Math.abs(X) / (horizonW * 1.6)), 0.85) + row * 0.06 + hash3(i, j, 13) * 0.05;
            }
          }
          const hushed = quiet.length > 0 && isQuiet(x + cell / 2, y + cell / 2);
          if (hushed) abg[idx] *= 0.55;
          if (kind[idx] === 0 && !hushed && abg[idx] > 0.01 && hash3(i, j, 21) < 0.055) {
            flickN[idx] = 2 + Math.floor(hash3(i, j, 23) * 6);
            flickP[idx] = hash3(i, j, 25);
          }
        }
      }

      // Contour cells are traced before each stone is filled
      stoneCells = []; groundCells = []; flickCells = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          if (kind[idx] === 1) {
            const k = sidx[idx];
            if ((i === 0 || sidx[idx - 1] !== k) || (i === cols - 1 || sidx[idx + 1] !== k) ||
                (j === 0 || sidx[idx - cols] !== k) || (j === rows - 1 || sidx[idx + cols] !== k)) {
              const st = stones[k];
              const X = (px[idx] + cell / 2 - cx) / S, Y = Yc[idx];
              const lx = (X - st.cx) * st.cos + (Y - st.cy) * st.sin, ly = -(X - st.cx) * st.sin + (Y - st.cy) * st.cos;
              const along = Math.abs(Math.atan2((lx - st.sh * ly) / st.a, -ly / st.b)) / Math.PI; // 0 at the base, 1 at the crown
              outT[idx] = st.start - OUTLINE_LEAD + OUTLINE_DUR * along + hash3(i, j, 31) * 0.03;
              edge[idx] = 1;
            }
            stoneCells.push(idx);
          } else if (kind[idx] === 2) groundCells.push(idx);
          else if (flickN[idx]) flickCells.push(idx);
        }
      }

      // Ink on paper reads lighter than light on dark, so paper glyphs are heavier.
      const weight = paper ? 0.15 : 0.11;
      ink = glyphSprites(cell, inkColor, weight);
      fl = tinted ? glyphSprites(cell, flashColor, weight) : ink;
      if (!paper) {
        const gs = Math.round(cell * 3.4);
        glowSpr = document.createElement('canvas'); glowSpr.width = glowSpr.height = gs;
        const g = glowSpr.getContext('2d');
        const grad = g.createRadialGradient(gs / 2, gs / 2, 0, gs / 2, gs / 2, gs / 2);
        grad.addColorStop(0, 'rgba(255,255,255,0.55)');
        grad.addColorStop(0.35, 'rgba(255,255,255,0.16)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(0, 0, gs, gs);
      }

      bgLayer = document.createElement('canvas');
      bgLayer.width = W; bgLayer.height = H;
      const b = bgLayer.getContext('2d', { alpha: false });
      b.fillStyle = bgColor; b.fillRect(0, 0, W, H);
      for (let idx = 0; idx < N; idx++) {
        if (abg[idx] < 0.002) continue;
        b.globalAlpha = abg[idx];
        b.drawImage(ink[0], px[idx], py[idx]);
      }
      b.globalAlpha = 1;

      const cap = stoneCells.length + groundCells.length + flickCells.length;
      outIdx = new Int32Array(cap); outGlyph = new Uint8Array(cap); outAlpha = new Float32Array(cap); outFlash = new Float32Array(cap);
    }

    // Tone (0..1) to how much a cell shows: lit faces in dark mode, shadows in paper mode.
    function tone(b, i) {
      if (!paper) return Math.min(1, b * 1.18);
      const v = clamp(1.04 - b * 1.1, 0.04, 1);
      return edge[i] ? Math.max(v, 0.62) : v;
    }

    function render(tau) {
      const intro = tau < LOOP;
      const t = ((tau % LOOP) + LOOP) % LOOP;

      // Key light drifts a little over the loop, so the dither re-solves itself.
      const ph = (2 * Math.PI * (t - (SCAN_START + 0.7))) / LOOP;
      let lx = -0.46 + 0.22 * Math.sin(ph), ly = 0.74, lz = 0.86;
      const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
      let hx = lx, hy = ly, hz = lz + 1;
      const hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;

      const scanU = (t - SCAN_START) / SCAN_DUR;
      const scanning = scanU > 0 && scanU < 1;
      const scanY = -0.03 + (cairn.top + 0.06) * easeInOut(scanU);
      const scanW = cellU * 0.75;
      const base = stones[0];
      const presence = smooth(base.start, base.start + base.dur, t) * (1 - smooth(DISSOLVE + 0.8, DISSOLVE + DISSOLVE_SPAN + 0.3, t));

      let n = 0;
      const push = (i, glyph, a, f) => { outIdx[n] = i; outGlyph[n] = glyph; outAlpha[n] = a; outFlash[n] = f; n++; };
      const scanBoost = (i) => { if (!scanning) return 0; const d = (Yc[i] - scanY) / scanW; return Math.exp(-d * d); };

      // Stones
      for (let q = 0; q < stoneCells.length; q++) {
        const i = stoneCells[q];
        const lt = lockT[i];
        if (t < lt - RESOLVE) {
          const ot = outT[i];
          if (ot < 0 || t < ot) continue;
          push(i, 1, paper ? 0.7 : 0.34, Math.exp(-(t - ot) / 0.12));
        } else if (t < lt) {
          const u = (t - (lt - RESOLVE)) / RESOLVE;
          const glyph = hash3(i, Math.floor(t * 30), 7) < 0.5 ? 0 : 1;
          let a = glyph ? 0.20 + 0.45 * u : 0.10 + 0.16 * u;
          if (outT[i] >= 0 && t >= outT[i]) a = Math.max(a, 0.3);
          push(i, glyph, a, 0);
        } else {
          const dk = smooth(dissT[i] - 0.55, dissT[i] + 0.2, t);
          if (dk >= 1) continue;
          const diff = Math.max(0, nX[i] * lx + nY[i] * ly + nZ[i] * lz);
          const spec = Math.pow(Math.max(0, nX[i] * hx + nY[i] * hy + nZ[i] * hz), 22) * 0.16;
          const lit = alb[i] * (AMBIENT + (1 - AMBIENT) * diff + spec) + rim[i];
          const v = tone(lit, i) * Math.pow(1 - dk, 1.3);
          let bit = v > thr[i] ? 1 : 0;
          let a = paper ? (bit ? 0.52 + 0.48 * v : 0.17 + 0.2 * v) : (bit ? 0.40 + 0.60 * v : 0.10 + 0.26 * v);
          if (!bit) a += (abg[i] - a) * dk;
          // Release: a little entropy creeps in as each cell lets go
          if (dk > 0 && hash3(i, Math.floor(t * 20), 3) < 0.3 * Math.sin(Math.PI * dk)) bit ^= 1;
          let f = Math.exp(-(t - lt) / FLASH);
          const sb = scanBoost(i);
          if (sb > 0.02) { f = Math.max(f, sb * 0.75); if (sb > 0.55) bit ^= 1; }
          push(i, bit, a, f);
        }
      }

      // Horizon and ground plane: drawn out once, then always there
      for (let q = 0; q < groundCells.length; q++) {
        const i = groundCells[q];
        if (intro && t < lockT[i]) continue;
        const row0 = gRow[i] === 0, s = gShade[i] * presence;
        let v;
        if (paper) v = row0 ? 0.85 * gFall[i] : 0.16 * gFall[i] + 0.5 * s * (1 - gRow[i] / 6);
        else v = row0 ? 0.92 * gFall[i] * (1 - 0.28 * s) : 0.40 * gFall[i] * (1 - 0.78 * s);
        const bit = v > thr[i] ? 1 : 0;
        const a = paper ? (bit ? 0.34 + 0.56 * v : 0.1 + 0.18 * v) : (bit ? 0.26 + 0.70 * v : 0.07 + 0.2 * v);
        let f = intro ? 0.8 * Math.exp(-(t - lockT[i]) / FLASH) : 0;
        f = Math.max(f, scanBoost(i) * 0.5);
        push(i, bit, a, f);
      }

      // Ambient bits blinking in the field
      for (let q = 0; q < flickCells.length; q++) {
        const i = flickCells[q];
        const c = Math.cos(2 * Math.PI * ((flickN[i] * t) / LOOP + flickP[i]));
        if (c < 0.982) continue;
        const amt = (c - 0.982) / 0.018;
        push(i, amt > 0.22 ? 1 : 0, abg[i] + amt * 0.30, 0);
      }

      // Draw: base field, clear changed cells in one path, glyphs, then light.
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(bgLayer, 0, 0);
      ctx.fillStyle = bgColor;
      ctx.beginPath();
      for (let q = 0; q < n; q++) { const i = outIdx[q]; ctx.rect(px[i], py[i], cell, cell); }
      ctx.fill();
      for (let q = 0; q < n; q++) {
        const i = outIdx[q], g = outGlyph[q], f = outFlash[q];
        let a = clamp(outAlpha[q], 0, 1);
        if (tinted) {
          ctx.globalAlpha = a * (1 - 0.85 * f);
          ctx.drawImage(ink[g], px[i], py[i]);
          if (f > 0.02) { ctx.globalAlpha = Math.min(1, f) * 0.95; ctx.drawImage(fl[g], px[i], py[i]); }
        } else {
          ctx.globalAlpha = a + (1 - a) * f * 0.88;
          ctx.drawImage(ink[g], px[i], py[i]);
        }
      }
      if (glowSpr) {
        ctx.globalCompositeOperation = 'lighter';
        const gs = glowSpr.width, off = (gs - cell) / 2;
        for (let q = 0; q < n; q++) {
          const f = outFlash[q];
          if (f < 0.04) continue;
          const i = outIdx[q];
          ctx.globalAlpha = Math.min(1, f) * 0.30;
          ctx.drawImage(glowSpr, px[i] - off, py[i] - off);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
    }

    // -------------------------------------------------------------------------
    // Playback: runs only while on screen, picks up where it left off.
    // -------------------------------------------------------------------------
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tau = reduce ? LOOP + HOLD_FRAME : opts.start || 0;
    let running = false, visible = true, held = false, last = 0, raf = 0;

    function frame(now) {
      if (last) tau += Math.min(0.1, (now - last) / 1000);
      last = now;
      render(tau);
      raf = requestAnimationFrame(frame);
    }
    function sync() {
      const want = visible && !held && !reduce && !window.__CAIRN_MANUAL;
      if (want && !running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
      else if (!want && running) { running = false; cancelAnimationFrame(raf); }
    }

    setup();
    render(tau);

    let resizeTimer = 0;
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { setup(); render(tau); }, 100);
      }).observe(canvas);
    }
    if (window.IntersectionObserver) {
      new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; sync(); }).observe(canvas);
    }
    sync();

    return {
      LOOP,
      render: (t) => { tau = t; render(t); },
      setup,
      toggle() { held = !held; sync(); return !held; },
    };
  }

  const instances = [];
  function boot() {
    document.querySelectorAll('canvas[data-cairn]').forEach((c) => instances.push(mount(c)));
  }
  window.VardexCairn = { mount, instances, LOOP };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
