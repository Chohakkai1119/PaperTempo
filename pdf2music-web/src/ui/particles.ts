/**
 * A slow, parallaxed drift of musical glyphs over the WebGL backdrop.
 * Deliberately faint — it should register as texture, not as decoration.
 */

const GLYPHS = ["♪", "♫", "♬", "♩", "\u{1D11E}", "♭", "♯", "\u{1D122}"];

interface Mote {
  x: number;
  y: number;
  size: number;
  depth: number; // 0 = far, 1 = near
  vy: number;
  drift: number;
  phase: number;
  spin: number;
  glyph: string;
  hue: number;
}

const TINTS = ["255, 196, 107", "109, 227, 255", "155, 140, 255", "255, 143, 177"];

export function startParticles(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  let motes: Mote[] = [];

  function make(seedY?: number): Mote {
    const depth = Math.random();
    return {
      x: Math.random() * w,
      y: seedY ?? h + Math.random() * 120,
      size: 11 + depth * 30,
      depth,
      vy: (7 + depth * 20) / 60,
      drift: (Math.random() - 0.5) * 0.35,
      phase: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.12,
      glyph: GLYPHS[(Math.random() * GLYPHS.length) | 0],
      hue: (Math.random() * TINTS.length) | 0,
    };
  }

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.max(10, Math.min(26, Math.round((w * h) / 62000)));
    motes = Array.from({ length: count }, () => make(Math.random() * h));
  }
  resize();
  window.addEventListener("resize", resize);

  let px = 0.5;
  let py = 0.5;
  window.addEventListener(
    "pointermove",
    (e) => {
      px = e.clientX / w;
      py = e.clientY / h;
    },
    { passive: true }
  );

  let last = performance.now();
  let t = 0;

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 16.6667, 3);
    last = now;
    if (document.hidden) return;
    t += dt * 0.01;

    ctx!.clearRect(0, 0, w, h);
    ctx!.textAlign = "center";
    ctx!.textBaseline = "middle";

    for (const m of motes) {
      if (!reduced) {
        m.y -= m.vy * dt;
        m.x += Math.sin(t * 0.8 + m.phase) * m.drift * dt;
        m.phase += m.spin * 0.02 * dt;
      }
      if (m.y < -60) Object.assign(m, make());

      // parallax: near motes lag the pointer more than far ones
      const ox = (px - 0.5) * -30 * m.depth;
      const oy = (py - 0.5) * -18 * m.depth;

      const alpha = (0.05 + m.depth * 0.16) * (0.6 + 0.4 * Math.sin(t * 1.6 + m.phase));
      ctx!.save();
      ctx!.translate(m.x + ox, m.y + oy);
      ctx!.rotate(Math.sin(t * 0.5 + m.phase) * 0.14);
      ctx!.font = `${m.size}px ${"ui-serif, Georgia, serif"}`;
      ctx!.fillStyle = `rgba(${TINTS[m.hue]}, ${alpha.toFixed(3)})`;
      ctx!.shadowColor = `rgba(${TINTS[m.hue]}, ${(alpha * 0.9).toFixed(3)})`;
      ctx!.shadowBlur = 12 + m.depth * 16;
      ctx!.fillText(m.glyph, 0, 0);
      ctx!.restore();
    }
  }
  requestAnimationFrame(frame);
}
