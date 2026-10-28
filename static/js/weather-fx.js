/**
 * WeatherFX — 独立 Canvas 天气粒子与柔光引擎（晴/多云/阴/雨/雷暴/雪/雾）
 * 单一 requestAnimationFrame 循环 + IntersectionObserver 离屏暂停
 */
(function (global) {
  "use strict";

  const WeatherFX = (() => {
    const reduceMotion =
      global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scenes = new Set();
    const sprites = {};
    let raf = 0;
    let lastTs = 0;
    const rand = (a, b) => a + Math.random() * (b - a);
    const TAU = Math.PI * 2;

    const io =
      "IntersectionObserver" in global
        ? new IntersectionObserver(
            (entries) =>
              entries.forEach((e) => {
                if (e.target.__wx) e.target.__wx.visible = e.isIntersecting;
              }),
            { rootMargin: "120px" }
          )
        : null;
    const ro =
      "ResizeObserver" in global
        ? new ResizeObserver((entries) =>
            entries.forEach((e) => e.target.__wx && e.target.__wx.resize())
          )
        : null;

    function cloudSprite(tone) {
      if (sprites[tone]) return sprites[tone];
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 220;
      const g = c.getContext("2d");
      const puffs = [
        [120, 140, 78],
        [200, 112, 94],
        [286, 136, 78],
        [62, 160, 54],
        [338, 160, 56],
        [200, 164, 54],
      ];
      for (const [x, y, r] of puffs) {
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, `rgba(${tone},.62)`);
        rg.addColorStop(0.5, `rgba(${tone},.32)`);
        rg.addColorStop(1, `rgba(${tone},0)`);
        g.fillStyle = rg;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }
      sprites[tone] = c;
      return c;
    }

    class Scene {
      constructor(host) {
        this.host = host;
        this.kind = host.dataset.kind || "cloudy";
        this.density = Number(host.dataset.density) || 1;
        this.canvas = document.createElement("canvas");
        this.canvas.className = "wx-canvas";
        host.appendChild(this.canvas);
        this.ctx = this.canvas.getContext("2d");
        this.visible = true;
        this.t = rand(0, 20);
        this.flash = 0;
        this.w = 0;
        this.h = 0;
        this.resize();
      }

      resize() {
        const w = this.host.clientWidth;
        const h = this.host.clientHeight;
        if (!w || !h || (w === this.w && h === this.h)) return;
        const dpr = Math.min(global.devicePixelRatio || 1, 2);
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.w = w;
        this.h = h;
        this.init();
      }

      init() {
        const { w, h, density: d } = this;
        const area = w * h;
        const k = this.kind;
        this.parts = [];
        if (k === "rain" || k === "storm") {
          const n = Math.min(420, Math.round((area / (k === "storm" ? 420 : 640)) * d));
          this.wind = k === "storm" ? -0.32 : -0.2;
          for (let i = 0; i < n; i++) this.parts.push(this.newDrop(true));
        } else if (k === "snow") {
          const n = Math.min(320, Math.round((area / 850) * d));
          for (let i = 0; i < n; i++) this.parts.push(this.newFlake(true));
        } else if (k === "cloudy" || k === "overcast") {
          const n = Math.max(
            k === "overcast" ? 8 : 6,
            Math.round(w / (k === "overcast" ? 90 : 130))
          );
          for (let i = 0; i < n; i++) {
            const z = rand(0.3, 1);
            this.parts.push({
              z,
              s: (h / 220) * rand(0.75, 1.25) * (0.55 + z * 0.5),
              x: (i / n) * (w * 1.2) - w * 0.2 + rand(-20, 20),
              y: rand(-0.4, 0.2) * h,
              a: k === "overcast" ? rand(0.4, 0.7) : rand(0.32, 0.62),
              v: 6 + z * 14,
              tone:
                k === "overcast"
                  ? Math.random() < 0.5
                    ? "190,198,210"
                    : "140,148,162"
                  : "255,255,255",
            });
          }
          this.parts.sort((a, b) => a.z - b.z);
        } else if (k === "sunny") {
          const n = Math.round(Math.min(28, area / 9000) * d);
          for (let i = 0; i < n; i++) {
            this.parts.push({
              x: rand(0, w),
              y: rand(0, h),
              r: rand(0.6, 2.2),
              v: rand(4, 12),
              ph: rand(0, TAU),
            });
          }
        } else if (k === "fog") {
          for (let i = 0; i < 4; i++) {
            this.parts.push({
              y: (0.15 + i * 0.24) * h,
              ph: rand(0, TAU),
              v: rand(0.08, 0.18),
              a: rand(0.3, 0.46),
            });
          }
        }
      }

      newDrop(spread) {
        const z = Math.pow(Math.random(), 1.6) * 0.85 + 0.15;
        return {
          z,
          x: rand(0, this.w + this.h * 0.4),
          y: spread ? rand(-this.h, this.h) : rand(-this.h * 0.3, -10),
          len: 7 + z * 22,
          v: 420 + z * 760,
        };
      }

      newFlake(spread) {
        const z = Math.pow(Math.random(), 1.4) * 0.85 + 0.15;
        return {
          z,
          x: rand(0, this.w),
          y: spread ? rand(-this.h, this.h) : rand(-30, -6),
          r: 0.7 + z * 2.6,
          v: 14 + z * 42,
          ph: rand(0, TAU),
          amp: 8 + z * 18,
        };
      }

      step(dt) {
        this.t += dt;
        const { ctx, w, h } = this;
        ctx.clearRect(0, 0, w, h);
        const k = this.kind;
        if (k === "rain" || k === "storm") this.drawRain(dt);
        else if (k === "snow") this.drawSnow(dt);
        else if (k === "cloudy" || k === "overcast") this.drawClouds(dt);
        else if (k === "sunny") this.drawSun(dt);
        else if (k === "fog") this.drawFog(dt);
      }

      drawRain(dt) {
        const { ctx, w, h, wind } = this;
        ctx.lineCap = "round";
        for (const p of this.parts) {
          p.y += p.v * dt;
          p.x += p.v * dt * wind;
          if (p.y - p.len > h || p.x < -40) Object.assign(p, this.newDrop(false));
          ctx.strokeStyle = `rgba(205,222,255,${0.1 + p.z * 0.42})`;
          ctx.lineWidth = 0.5 + p.z * 1.1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - wind * p.len, p.y - p.len);
          ctx.stroke();
        }
        if (this.kind === "storm") {
          if (this.flash <= 0 && Math.random() < dt * 0.18) this.flash = 1;
          if (this.flash > 0) {
            const flicker = this.flash > 0.7 ? 1 : this.flash > 0.45 ? 0.25 : 0.7;
            ctx.fillStyle = `rgba(210,220,255,${this.flash * 0.32 * flicker})`;
            ctx.fillRect(0, 0, w, h);
            this.flash -= dt * 2.2;
          }
        }
      }

      drawSnow(dt) {
        const { ctx, h } = this;
        for (const p of this.parts) {
          p.y += p.v * dt;
          p.x += Math.sin(this.t * 0.9 + p.ph) * p.amp * dt;
          if (p.y - p.r > h) Object.assign(p, this.newFlake(false));
          const a = 0.3 + p.z * 0.6;
          if (p.z > 0.7) {
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.4);
            g.addColorStop(0, `rgba(255,255,255,${a})`);
            g.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 2.4, 0, TAU);
            ctx.fill();
          } else {
            ctx.fillStyle = `rgba(255,255,255,${a})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, TAU);
            ctx.fill();
          }
        }
      }

      drawClouds(dt) {
        const { ctx, w } = this;
        for (const c of this.parts) {
          const img = cloudSprite(c.tone);
          const cw = img.width * c.s;
          const ch = img.height * c.s;
          c.x += c.v * dt;
          if (c.x > w + 10) c.x = -cw - rand(0, w * 0.3);
          ctx.globalAlpha = c.a;
          ctx.drawImage(img, c.x, c.y, cw, ch);
        }
        ctx.globalAlpha = 1;
      }

      drawSun(dt) {
        const { ctx, w, h, t } = this;
        const sx = w * 0.86;
        const sy = -h * 0.06;
        const R = Math.max(w, h) * 0.9;
        const pulse = 0.5 + Math.sin(t * 0.7) * 0.06;
        ctx.globalCompositeOperation = "lighter";

        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
        glow.addColorStop(0, `rgba(255,244,214,${pulse})`);
        glow.addColorStop(0.18, `rgba(255,214,150,${pulse * 0.45})`);
        glow.addColorStop(0.5, `rgba(255,170,100,${pulse * 0.12})`);
        glow.addColorStop(1, "rgba(255,160,90,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(t * 0.035);
        for (let i = 0; i < 12; i++) {
          const ang = (i / 12) * TAU;
          const spread = 0.045 + (i % 3) * 0.02;
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
          g.addColorStop(0, `rgba(255,236,190,${0.1 + (i % 2) * 0.05})`);
          g.addColorStop(1, "rgba(255,236,190,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, R, ang - spread, ang + spread);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();

        for (const p of this.parts) {
          p.y -= p.v * dt;
          p.x += Math.sin(t * 0.5 + p.ph) * 4 * dt;
          if (p.y < -4) {
            p.y = h + 4;
            p.x = rand(0, w);
          }
          const a = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(t * 1.6 + p.ph));
          ctx.fillStyle = `rgba(255,240,210,${a})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, TAU);
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }

      drawFog() {
        const { ctx, w, h, t } = this;
        for (const b of this.parts) {
          const x = w * (0.5 + Math.sin(t * b.v + b.ph) * 0.35);
          const r = h * 0.55;
          ctx.save();
          ctx.translate(x, b.y);
          ctx.scale((w / r) * 0.9, 1);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          const a = b.a * (0.75 + 0.25 * Math.sin(t * 0.4 + b.ph));
          g.addColorStop(0, `rgba(232,238,244,${a})`);
          g.addColorStop(1, "rgba(232,238,244,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    function drop(scene) {
      scenes.delete(scene);
      io && io.unobserve(scene.host);
      ro && ro.unobserve(scene.host);
      if (scene.canvas && scene.canvas.parentNode) {
        scene.canvas.remove();
      }
      if (scene.host) {
        scene.host.__wx = null;
      }
    }

    function frame(ts) {
      raf = 0;
      const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
      lastTs = ts;
      scenes.forEach((s) => {
        if (!s.host.isConnected) {
          drop(s);
          return;
        }
        if (s.visible && !document.hidden && s.w) s.step(dt);
      });
      if (scenes.size) raf = requestAnimationFrame(frame);
      else lastTs = 0;
    }

    function mount(root) {
      if (reduceMotion || !root) return;
      root.querySelectorAll(".wx-fx[data-kind]").forEach((host) => {
        if (host.__wx) return;
        const scene = new Scene(host);
        host.__wx = scene;
        scenes.add(scene);
        io && io.observe(host);
        ro && ro.observe(host);
      });
      if (!raf && scenes.size) raf = requestAnimationFrame(frame);
    }

    return { mount };
  })();

  global.WeatherFX = WeatherFX;
})(typeof window !== "undefined" ? window : globalThis);
