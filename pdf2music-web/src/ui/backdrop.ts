/**
 * Fullscreen WebGL backdrop: five-line staves that drift like aurora ribbons.
 *
 * One knob drives the mood from the outside: `energy` (0..1), how alive the
 * scene is — low when idle, high while a file is being dragged in or
 * transcribed. It is smoothed here so callers can set it abruptly.
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uPointer;
uniform float uEnergy;

const vec3 BRASS  = vec3(1.00, 0.70, 0.26);
const vec3 ROSE   = vec3(1.00, 0.36, 0.58);
const vec3 VIOLET = vec3(0.60, 0.40, 1.00);
const vec3 CYAN   = vec3(0.20, 0.86, 1.00);
const vec3 MINT   = vec3(0.34, 1.00, 0.72);

/* Walk the full palette as a loop so ribbons never share a hue. */
vec3 palette(float h) {
  h = fract(h) * 5.0;
  if (h < 1.0) return mix(BRASS, ROSE, smoothstep(0.0, 1.0, h));
  if (h < 2.0) return mix(ROSE, VIOLET, smoothstep(0.0, 1.0, h - 1.0));
  if (h < 3.0) return mix(VIOLET, CYAN, smoothstep(0.0, 1.0, h - 2.0));
  if (h < 4.0) return mix(CYAN, MINT, smoothstep(0.0, 1.0, h - 3.0));
  return mix(MINT, BRASS, smoothstep(0.0, 1.0, h - 4.0));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/* Vertical position of ribbon i at horizontal coordinate x. */
float ribbon(float x, float i, float t, float energy) {
  float amp = mix(0.055, 0.105, energy);
  float y = 0.5
    + amp        * sin(x * 1.55 + t * 0.24 + i * 2.1)
    + amp * 0.55 * sin(x * 3.30 - t * 0.37 + i * 1.3)
    + amp * 0.28 * sin(x * 6.10 + t * 0.55 + i * 4.7);
  /* fan the ribbons apart so they read as separate systems of music */
  return y + (i - 1.5) * mix(0.155, 0.195, energy);
}

/* Soft glow around a distance value. */
float glow(float d, float w) {
  return w / (d * d + w);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  float t = uTime;
  float energy = uEnergy;

  /* On tall/narrow viewports the ribbons stack into one bright band, so
     ease them back until the layout is wide enough to spread them out. */
  float wide = smoothstep(0.62, 1.25, aspect);
  float ribbonGain = mix(0.6, 1.0, wide);

  /* --- ground: indigo below, plum above, with two slow colour washes -- */
  vec3 col = mix(vec3(0.028, 0.020, 0.055), vec3(0.045, 0.030, 0.080), uv.y);
  col += vec3(0.070, 0.030, 0.020) * pow(max(1.0 - abs(uv.y - 0.42) * 1.7, 0.0), 3.0);

  /* Two broad, slowly wandering blobs of complementary colour. They give
     the frame large-scale hue variety that the thin ribbons cannot. */
  vec2 w1 = vec2(sin(t * 0.11) * 0.42, cos(t * 0.09) * 0.24);
  vec2 w2 = vec2(cos(t * 0.07) * -0.46, sin(t * 0.13) * 0.20);
  col += palette(t * 0.03) * glow(length(p - w1), 0.09) * (0.055 + 0.05 * energy);
  col += palette(t * 0.03 + 0.5) * glow(length(p - w2), 0.11) * (0.050 + 0.05 * energy);

  /* --- ribbons: each is a 5-line stave, warped and glowing ---------- */
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x = p.x + t * (0.018 + fi * 0.006);
    float centre = ribbon(x, fi, t, energy);
    float dy = uv.y - centre;

    /* colour walks along the palette per ribbon and slowly in time */
    vec3 tint = palette(fi * 0.27 + t * 0.035);

    /* wide nebula halo */
    float halo = glow(dy, 0.0016 + 0.0022 * energy);
    col += tint * halo * (0.060 + 0.075 * energy) * ribbonGain;

    /* five crisp staff lines riding the same curve */
    float lines = 0.0;
    float gap = 0.0115;
    for (int k = 0; k < 5; k++) {
      float off = (float(k) - 2.0) * gap;
      lines += glow(dy - off, 0.0000075 + 0.000012 * energy);
    }
    float fade = smoothstep(0.9, 0.25, abs(dy) * 6.0);
    col += tint * lines * fade * (0.105 + 0.14 * energy) * ribbonGain;
  }

  /* --- pointer light: a lantern you carry across the page ----------- */
  vec2 pp = vec2((uPointer.x - 0.5) * aspect, uPointer.y - 0.5);
  float pd = length(p - pp);
  col += palette(t * 0.06 + 0.35) * glow(pd, 0.007) * (0.16 + 0.14 * energy);

  /* --- drifting dust ------------------------------------------------ */
  vec2 gp = floor(uv * vec2(70.0 * aspect, 70.0));
  float rnd = hash(gp);
  if (rnd > 0.9965) {
    vec2 cellUv = fract(uv * vec2(70.0 * aspect, 70.0)) - 0.5;
    float tw = 0.5 + 0.5 * sin(t * 1.4 + rnd * 80.0);
    col += vec3(0.9, 0.85, 0.95) * glow(length(cellUv) * 0.06, 0.0000009) * 0.35 * tw;
  }

  /* --- grade -------------------------------------------------------- */
  float vig = smoothstep(1.35, 0.25, length(p * vec2(0.85, 1.0)));
  col *= mix(0.68, 1.0, vig);
  col = col / (col + 1.05);                       /* gentler rolloff keeps hue */
  col = pow(col, vec3(0.82));                     /* lift the shadows   */

  /* Push saturation back up: tonemapping desaturates highlights, and this
     backdrop is nothing but highlights on a dark ground. */
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.45);
  col = max(col, vec3(0.0));
  col += (hash(frag + fract(t)) - 0.5) * 0.016;   /* dither the bands   */

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || "shader compile failed");
  }
  return sh;
}

export interface Backdrop {
  setEnergy(v: number): void;
}

const NOOP: Backdrop = { setEnergy() {} };

export function startBackdrop(canvas: HTMLCanvasElement): Backdrop {
  const gl =
    (canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" }) as
      | WebGLRenderingContext
      | null) ?? null;
  if (!gl) {
    // No WebGL: the CSS ground colour is a perfectly decent fallback.
    canvas.style.display = "none";
    return NOOP;
  }

  let program: WebGLProgram;
  try {
    program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "link failed");
    }
  } catch (err) {
    console.warn("backdrop disabled:", err);
    canvas.style.display = "none";
    return NOOP;
  }

  gl.useProgram(program);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(program, "uRes");
  const uTime = gl.getUniformLocation(program, "uTime");
  const uPointer = gl.getUniformLocation(program, "uPointer");
  const uEnergy = gl.getUniformLocation(program, "uEnergy");

  // Half resolution is plenty for a soft, out-of-focus backdrop and keeps
  // laptops cool while the transcription worker is pegging the CPU.
  const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.62;

  function resize() {
    const w = Math.max(1, Math.floor(window.innerWidth * scale));
    const h = Math.max(1, Math.floor(window.innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl!.viewport(0, 0, w, h);
    }
  }
  resize();
  window.addEventListener("resize", resize);

  let pointer = { x: 0.5, y: 0.55 };
  const target = { x: 0.5, y: 0.55 };
  window.addEventListener(
    "pointermove",
    (e) => {
      target.x = e.clientX / window.innerWidth;
      target.y = 1 - e.clientY / window.innerHeight;
    },
    { passive: true }
  );

  let energy = 0;
  let energyTarget = 0;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let time = 0;
  let last = performance.now();
  let visible = true;
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    last = performance.now();
  });

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!visible) return;

    time += reduced ? dt * 0.15 : dt;
    // Just enough smoothing to take the jitter out of raw pointer events —
    // any slower and the light visibly trails the cursor.
    pointer.x += (target.x - pointer.x) * Math.min(1, dt * 22);
    pointer.y += (target.y - pointer.y) * Math.min(1, dt * 22);
    energy += (energyTarget - energy) * Math.min(1, dt * 2.4);

    resize();
    gl!.uniform2f(uRes, canvas.width, canvas.height);
    gl!.uniform1f(uTime, time);
    gl!.uniform2f(uPointer, pointer.x, pointer.y);
    gl!.uniform1f(uEnergy, energy);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }
  requestAnimationFrame(frame);

  return {
    setEnergy(v) {
      energyTarget = Math.max(0, Math.min(1, v));
    },
  };
}
