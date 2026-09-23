"use strict";

// 3D 展厅：把整条卷轴挂在一面墙上，镜头沿着它走一遍。
//
// 只看不画——墙的本体一直是二维的卷轴，这里只是另一种看它的方式。
// 打开那一刻的样子就是展出的样子，之后别人再画什么，关了重开才看得到。
//
// 没用 three.js：场景里只有几块长方形（纸、墙、地、两根轴杆），原生 WebGL2 两百行就够，
// 犯不着为它多一个依赖，也不用担心 CDN 在国内打不开。
//
// 和墙本身一样，纹理只给镜头附近的几段建，走远的就释放——卷轴可以有几百段。
//
// 对外只有一个入口：
//   Gallery.open({ segments, title, render: async (i) => canvas }) → 成功返回 true
// render 画出第 i 段（纸 + 墨迹），画成什么分辨率由调用方决定。

(function () {
  // 世界坐标：1 = 1000px。一段纸 1.6 × 1.0，底边离地 0.45
  const W = 1.6;
  const H = 1.0;
  const Y0 = 0.45;
  const EYE_Y = 1.02;
  const DIST = 1.9; // 人离墙多远
  const LEAD = 1.0; // 镜头看向前方多少——墙斜着退向远处，才看得出是一条长廊
  const TOUR_SPEED = 0.42; // 漫游时每秒走多远：一段大约四秒
  const BG = [0.085, 0.072, 0.063];
  const KEEP_BEHIND = 3;
  const KEEP_AHEAD = 10;

  const VS = `#version 300 es
in vec2 aUV;
uniform vec3 uO, uU, uV;
uniform mat4 uVP;
out vec2 vUV;
out vec3 vW;
void main() {
  vec3 w = uO + aUV.x * uU + aUV.y * uV;
  vW = w;
  vUV = aUV;
  gl_Position = uVP * vec4(w, 1.0);
}`;

  // uKind：0 纯色（墙、轴杆、没加载出来的纸）  1 纸的纹理  2 地板
  // 每段中心上方挂一盏灯：墙和纸按横向位置算一块光斑，地板上在墙根投一圈光
  const FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vW;
uniform sampler2D uTex;
uniform int uKind;
uniform vec4 uColor;
uniform vec3 uEye, uBg;
uniform float uSeg, uAlpha;
out vec4 o;
float pool(float x) {
  float c = fract(x / uSeg) - 0.5;
  return exp(-c * c * 4.0);
}
void main() {
  vec4 c = uKind == 1 ? texture(uTex, vUV) : uColor;
  float wy = abs(vW.y);
  if (uKind == 2) {
    float near = exp(-max(vW.z, 0.0) * 1.1);
    c.rgb *= 0.55 + 1.1 * pool(vW.x) * near;
  } else if (uKind == 1) {
    // 纸本身要看得清：光斑只是轻轻一层，别把墨迹晒没了
    c.rgb *= 0.8 + 0.2 * pool(vW.x);
  } else {
    float top = (1.0 - smoothstep(1.0, 2.6, wy)) * 0.35 + 0.65;
    c.rgb *= (0.45 + 0.6 * pool(vW.x)) * top;
  }
  float d = distance(vW, uEye);
  c.rgb = mix(c.rgb, uBg, smoothstep(3.5, 13.0, d));
  o = vec4(c.rgb, c.a * uAlpha);
}`;

  // ───────────── 矩阵（列主序，和 GLSL 一致） ─────────────

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }

  function lookAt(e, c) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let n = Math.hypot(zx, zy, zz);
    zx /= n; zy /= n; zz /= n;
    // x = up × z，up 取 (0,1,0)
    let xx = zz, xy = 0, xz = -zx;
    n = Math.hypot(xx, xy, xz);
    xx /= n; xy /= n; xz /= n;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    return [
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]),
      -(yx * e[0] + yy * e[1] + yz * e[2]),
      -(zx * e[0] + zy * e[1] + zz * e[2]),
      1,
    ];
  }

  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    }
    return o;
  }

  function hex(c, a = 1) {
    const n = parseInt(c.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
  }

  const PAPER = hex("#F3EDE2");
  const WALL = hex("#5a4f45");
  const FLOOR = hex("#2a221c", 0.86);
  const ROD = hex("#3d2a1c");
  const SHADOW = [0, 0, 0, 0.38];

  // ───────────── 展厅 ─────────────

  let current = null;

  function open(opts) {
    if (current) return true;
    const root = document.createElement("div");
    root.className = "gallery";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "3D 展厅");
    root.innerHTML = `
      <canvas></canvas>
      <div class="gallery-bar">
        <span class="gallery-title"></span>
        <span class="gallery-where"></span>
        <span class="gallery-gap"></span>
        <button type="button" class="gallery-tour"></button>
        <button type="button" class="gallery-close">离开展厅</button>
      </div>
      <div class="gallery-hint">滚轮、拖动或 ← → 走动 · 空格 漫游 · Esc 离开</div>`;
    const canvas = root.querySelector("canvas");
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) return false;
    document.body.appendChild(root);
    current = start(root, canvas, gl, opts);
    return true;
  }

  function start(root, canvas, gl, opts) {
    const N = Math.max(1, opts.segments | 0);
    const total = N * W;
    const $ = (s) => root.querySelector(s);
    $(".gallery-title").textContent = opts.title || "";

    // ── 着色器和一块单位方片 ──
    function shader(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const U = {};
    for (const n of ["uO", "uU", "uV", "uVP", "uTex", "uKind", "uColor", "uEye", "uBg", "uSeg", "uAlpha"]) {
      U[n] = gl.getUniformLocation(prog, n);
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aUV");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(U.uTex, 0);
    gl.uniform3fv(U.uBg, BG);
    gl.uniform1f(U.uSeg, W);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");

    // 画一块长方形：原点 o，两条边 u、v
    function quad(o, u, v, kind, color, alpha = 1) {
      gl.uniform3fv(U.uO, o);
      gl.uniform3fv(U.uU, u);
      gl.uniform3fv(U.uV, v);
      gl.uniform1i(U.uKind, kind);
      gl.uniform4fv(U.uColor, color || PAPER);
      gl.uniform1f(U.uAlpha, alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // ── 纹理：只给镜头附近的几段建，最近的先建 ──
    const tex = new Map(); // i → WebGLTexture
    let loading = -1;
    let closed = false;

    function wanted(f) {
      const lo = Math.max(0, Math.floor((f - KEEP_BEHIND) / W));
      const hi = Math.min(N - 1, Math.floor((f + KEEP_AHEAD) / W));
      return { lo, hi };
    }

    function pump(f) {
      const { lo, hi } = wanted(f);
      for (const [i, t] of tex) {
        if (i < lo - 2 || i > hi + 2) {
          gl.deleteTexture(t);
          tex.delete(i);
        }
      }
      if (loading >= 0) return;
      const at = Math.floor(f / W);
      let pick = -1;
      for (let d = 0; d <= hi - lo + 1 && pick < 0; d++) {
        for (const i of [at + d, at - d]) {
          if (i >= lo && i <= hi && !tex.has(i)) {
            pick = i;
            break;
          }
        }
      }
      if (pick < 0) return;
      loading = pick;
      Promise.resolve(opts.render(pick))
        .then((img) => {
          if (closed || !img) return;
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          // 墙是斜着看的，没有各向异性过滤远处的字会糊成一片
          if (aniso) {
            const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
            gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
          }
          tex.set(pick, t);
        })
        .catch(() => {})
        .finally(() => {
          loading = -1;
        });
    }

    // ── 镜头：f 是看向的那一点在卷轴上的位置 ──
    // 竖屏视野窄：人正对着墙站，从第一段中间看起；横屏斜着看，才有长廊的纵深
    const portrait = canvas.clientWidth < canvas.clientHeight;
    const startF = portrait ? 0.3 : -0.5;
    let f = startF;
    let target = f;
    let touring = true;
    let look = [0, 0]; // 鼠标带来的一点点转头
    let lookTarget = [0, 0];
    const minF = startF;
    const maxF = total + 0.4;
    const clampF = (x) => Math.max(minF, Math.min(maxF, x));

    const tourBtn = $(".gallery-tour");
    function setTour(on) {
      touring = on;
      tourBtn.textContent = on ? "停下" : "从头走一遍";
    }
    setTour(true);

    function stopTour() {
      if (touring) setTour(false);
    }

    function walk(d) {
      stopTour();
      target = clampF(target + d);
    }

    tourBtn.addEventListener("click", () => {
      if (touring) {
        setTour(false);
        target = f;
        return;
      }
      f = target = minF;
      setTour(true);
    });
    $(".gallery-close").addEventListener("click", close);

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
        walk((e.deltaX + e.deltaY) * unit * 0.0022);
      },
      { passive: false }
    );

    let drag = null;
    canvas.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      root.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      lookTarget = [((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2];
      if (!drag || drag.id !== e.pointerId) return;
      walk(-(e.clientX - drag.x) * (3.2 / r.width));
      drag.x = e.clientX;
    });
    const endDrag = () => {
      drag = null;
      root.classList.remove("dragging");
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => {
      lookTarget = [0, 0];
    });

    // 展厅开着的时候，键盘全归它：墙那边的快捷键（撤销、空格拖动）不能跟着动
    function onKey(e) {
      e.stopPropagation();
      if (e.type !== "keydown") return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") walk(W / 2);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") walk(-W / 2);
      else if (e.key === "Home") walk(minF - target);
      else if (e.key === "End") walk(maxF - target);
      else if (e.key === " ") tourBtn.click();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);

    // ── 尺寸 ──
    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    }

    // ── 一帧 ──
    const where = $(".gallery-where");
    let lastWhere = "";
    let last = performance.now();
    let raf = 0;

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (touring) {
        // 起步慢一点，别一打开就嗖地冲出去
        const ramp = Math.min(1, (target - minF) / 0.6 + 0.15);
        target = Math.min(maxF, target + TOUR_SPEED * ramp * dt);
        if (target >= maxF) setTour(false);
      }
      const ease = 1 - Math.exp(-dt * 5);
      f += (target - f) * ease;
      look[0] += (lookTarget[0] - look[0]) * ease * 0.6;
      look[1] += (lookTarget[1] - look[1]) * ease * 0.6;
      pump(f);

      const seg = Math.max(1, Math.min(N, Math.floor(f / W) + 1));
      const text = N > 1 ? `第 ${seg} / ${N} 段` : "";
      if (text !== lastWhere) where.textContent = lastWhere = text;

      resize();
      const aspect = canvas.width / canvas.height;
      // 竖屏时退远一点、正一点，让一整段纸差不多刚好装进屏幕
      const tall = aspect < 1;
      const dist = DIST * Math.max(1, 0.9 / aspect);
      const eye = [f - LEAD * (tall ? 0.15 : 0.55), EYE_Y - look[1] * 0.05, dist];
      const at = [f + LEAD * (tall ? 0.55 : 0.25) + look[0] * 0.5, EYE_Y - 0.08 - look[1] * 0.25, 0];
      const vp = mul(perspective((52 * Math.PI) / 180, aspect, 0.05, 40), lookAt(eye, at));
      gl.uniformMatrix4fv(U.uVP, false, vp);
      gl.uniform3fv(U.uEye, eye);

      gl.clearColor(BG[0], BG[1], BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const { lo, hi } = wanted(f);
      const x0 = -6;
      const x1 = total + 6;

      // 倒影：地板下面镜像一份墙和纸，再盖一层半透明的地板
      quad([x0, 0, -0.03], [x1 - x0, 0, 0], [0, -3.2, 0], 0, WALL, 0.5);
      for (let i = lo; i <= hi; i++) drawPaper(i, true);
      quad([x0, 0, -0.03], [x1 - x0, 0, 0], [0, 0, 8], 2, FLOOR);

      // 墙、纸的影子、纸、上下两根轴杆
      quad([x0, 0, -0.03], [x1 - x0, 0, 0], [0, 3.2, 0], 0, WALL);
      quad([0.02, Y0 - 0.025, -0.02], [total, 0, 0], [0, H, 0], 0, SHADOW);
      for (let i = lo; i <= hi; i++) drawPaper(i, false);
      quad([-0.04, Y0 + H, 0.004], [total + 0.08, 0, 0], [0, 0.028, 0], 0, ROD);
      quad([-0.04, Y0 - 0.028, 0.004], [total + 0.08, 0, 0], [0, 0.028, 0], 0, ROD);
    }

    function drawPaper(i, mirror) {
      const t = tex.get(i);
      if (t) gl.bindTexture(gl.TEXTURE_2D, t);
      const y = mirror ? -Y0 : Y0;
      quad([i * W, y, 0], [W, 0, 0], [0, mirror ? -H : H, 0], t ? 1 : 0, PAPER, mirror ? 0.22 : 1);
    }

    function close() {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      for (const t of tex.values()) gl.deleteTexture(t);
      tex.clear();
      // 显存别等垃圾回收，马上还回去
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      root.remove();
      current = null;
      if (typeof opts.onClose === "function") opts.onClose();
    }

    raf = requestAnimationFrame(frame);
    $(".gallery-close").focus();
    return { close };
  }

  window.Gallery = {
    open,
    close: () => current && current.close(),
    get isOpen() {
      return !!current;
    },
  };
})();
