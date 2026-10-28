const $ = (id) => document.getElementById(id);
    let chinaChart = null;
    let chinaReady = false;
    let lastRouteState = null;
    let lastWeatherState = null;
    let lastTrip = null;
    const isShareView = () => !!window.__SHARE_MODE__;
    function track(name, props) {
      try {
        fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          keepalive: true,
          body: JSON.stringify({ name, props: props || {} }),
        }).catch(() => {});
      } catch (_) {}
    }
    track(isShareView() ? "share_view" : "page_view", {});
    let selectedDay = null; // null = 全部
    let poolPickerDay = null;
    let poolFilterQuery = "";
    let currentPalette = {
      primary: "#0b6594",
      secondary: "#3f6073",
      tertiary: "#4e5b92",
      primaryContainer: "#d3ebfb",
      surfaceContainer: "#eef4f8",
      outlineVariant: "#c4d1d9",
    };
    let abortCtrl = null;
    /** 全局突变世代：规划 / 对话 / 途经重排开始时递增，过期响应一律丢弃 */
    let mutationEpoch = 0;
    let streamPlanEpoch = 0;
    let planInFlight = false;
    let chatEditInFlight = false;

    function bumpMutationEpoch() {
      mutationEpoch += 1;
      return mutationEpoch;
    }

    function isStaleMutation(epoch) {
      return epoch != null && epoch !== mutationEpoch;
    }

    function tripMutationBlockedReason() {
      if (planInFlight) return "正在生成新路书，请稍候再改…";
      if (chatEditInFlight) return "上一条对话调整仍在处理…";
      if (viaReorderBusy) return "正在重排途经，请稍候…";
      return null;
    }

    const chinaPromise = fetch("/static/china.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((geo) => {
        if (geo && typeof echarts !== "undefined") {
          echarts.registerMap("china", geo);
          chinaReady = true;
        }
      })
      .catch(() => {});

    function typeLabel(t) {
      return ({ drive: "驾驶", sight: "景点", food: "餐饮", hotel: "住宿", tip: "提示" })[t] || "提示";
    }

    /** RB 按钮 class：filled | ghost | pill | chip | pill-action */
    function rbBtnClass(variant, extra) {
      const map = {
        filled: "rb-btn",
        ghost: "rb-btn-ghost ghost-btn",
        pill: "rb-pill drive-pill",
        "pill-action": "rb-pill drive-pill action",
        chip: "rb-chip pref-chip",
      };
      const base = map[variant] || map.ghost;
      return extra ? `${base} ${extra}` : base;
    }

    function syncDensity() {
      let density;
      if (window.PlatformBridge && typeof window.PlatformBridge.applyDensity === "function") {
        density = window.PlatformBridge.applyDensity();
      } else {
        const preview = document.body.classList.contains("phone-preview");
        const narrow = window.matchMedia("(max-width: 980px)").matches;
        density = preview ? "wx" : narrow ? "compact" : "desktop";
        document.body.dataset.density = density;
      }
      if (density === "desktop") $("appDock")?.classList.remove("is-scroll-hidden");
      return density;
    }

    function isCompactLayout() {
      const d = document.body.dataset.density;
      return d === "compact" || d === "wx" || document.body.classList.contains("phone-preview");
    }

    function setStatus(msg) { $("status").textContent = msg || ""; }

    function parseLngLat(s) {
      if (!s || typeof s !== "string") return null;
      const parts = s.split(",").map(Number);
      if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
      return parts;
    }

    function clearLoadingState(message) {
      const daysEl = $("daysList");
      if (daysEl.querySelector(".shimmer-block")) {
        daysEl.innerHTML = `<div class="empty">${message || "暂无日程"}</div>`;
      }
      const foodsEl = $("foods");
      if (foodsEl.querySelector(".shimmer-row, .shimmer-line")) {
        foodsEl.innerHTML = `<div class="empty">${message || "暂无美食推荐"}</div>`;
      }
      const hotelsEl = $("hotels");
      if (hotelsEl.querySelector(".shimmer-line")) {
        hotelsEl.innerHTML = `<div class="empty">${message || "暂无住宿建议"}</div>`;
      }
      const tipsEl = $("tips");
      if (tipsEl.querySelector(".shimmer-line")) {
        tipsEl.innerHTML = `<div class="empty">${message || "暂无提示"}</div>`;
      }
    }

    let lastHeroImage = "";
    let lastPalettePacket = null;

    function currentTheme() {
      return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    }

    function resolvePaletteScheme(p) {
      if (!p) return null;
      const theme = currentTheme();
      if (p.light || p.dark) {
        const scheme = (theme === "dark" ? p.dark : p.light) || p.light || p.dark || {};
        return { seed: p.seed, ...scheme };
      }
      return p;
    }

    function applyPalette(p, heroImage) {
      if (!p && !lastPalettePacket) return;
      if (p) lastPalettePacket = p;
      const packet = p || lastPalettePacket;
      const scheme = resolvePaletteScheme(packet);
      if (!scheme) return;
      currentPalette = { ...currentPalette, ...scheme, seed: packet.seed || scheme.seed };
      // 页面肤色固定为阳光浅色 / 暖黑深色，不再用目的地取色把背景刷成亮面
      const r = document.documentElement.style;
      [
        "--md-primary", "--md-on-primary", "--md-primary-container", "--md-on-primary-container",
        "--md-secondary", "--md-secondary-container", "--md-on-secondary-container",
        "--md-tertiary", "--md-tertiary-container",
        "--md-surface", "--md-surface-dim", "--md-surface-container", "--md-surface-container-high",
        "--md-on-surface", "--md-on-surface-variant", "--md-outline", "--md-outline-variant",
        "--md-hero-start", "--md-hero-mid", "--md-hero-end",
        "--rb-elevated", "--rb-field", "--rb-sheet",
      ].forEach((k) => r.removeProperty(k));
      if (heroImage) lastHeroImage = heroImage;
      if (lastHeroImage && $("coverPhoto")) {
        $("coverPhoto").style.backgroundImage = `url("${lastHeroImage}")`;
      }
      if (lastRouteState) renderChinaRoute(lastRouteState);
      if (lastTrip) {
        renderDayChips(lastTrip);
        renderDays(lastTrip);
      }
    }

    const LEG_STEP_MS = 2800;
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let routeView = null;
    let legIndex = 0;
    let legTimer = null;
    let legRaf = 0;
    let legStartedAt = 0;
    let routeGeoKey = "";
    let cityGlow = {};
    let glowStamp = 0;
    let routeHasArrived = false;

    function nearestPolyIndex(poly, pt, from) {
      let best = from;
      let bestD = Infinity;
      for (let i = from; i < poly.length; i++) {
        const dx = poly[i][0] - pt[0];
        const dy = poly[i][1] - pt[1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function splitLegs(poly, nodes) {
      const pts = nodes.map((n) => n.coord);
      if (pts.length < 2) return [];
      if (poly.length < 2) return pts.slice(1).map((p, i) => [pts[i], p]);
      const idx = [0];
      for (let i = 1; i < pts.length - 1; i++) idx.push(nearestPolyIndex(poly, pts[i], idx[i - 1]));
      idx.push(poly.length - 1);
      return idx.slice(1).map((end, i) => {
        const seg = poly.slice(idx[i], end + 1);
        return seg.length >= 2 ? seg : [pts[i], pts[i + 1]];
      });
    }

    // 视野只框住路线（加留白），并按容器宽高比补齐，避免路线被压扁或挤在角落
    function routeBounds(coords, el) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      coords.forEach(([x, y]) => {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      });
      let w = Math.max(maxX - minX, 1.6);
      let h = Math.max(maxY - minY, 1.2);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      w *= 1.42; h *= 1.5;
      const ratio = Math.max(0.6, (el.clientWidth || 600) / Math.max(el.clientHeight || 300, 1));
      const aspect = 0.75;
      if ((w * aspect) / h < ratio) w = (h * ratio) / aspect;
      else h = (w * aspect) / ratio;
      // 顶部留出 #coverLeg 浮层的高度，避免压住北端城市标签
      const headroom = h * 0.1;
      return [[cx - w / 2, cy + h / 2 + headroom], [cx + w / 2, cy - h / 2]];
    }

    function legKm(nodes, i) {
      const a = Number(nodes[i] && nodes[i].cum_km);
      const b = Number(nodes[i + 1] && nodes[i + 1].cum_km);
      return Number.isFinite(a) && Number.isFinite(b) && b > a ? Math.round(b - a) : null;
    }

    function legDayNo(cityName, i) {
      const plan = (lastTrip && lastTrip.days_plan) || [];
      const isHsrLocal = !!(lastTrip && (lastTrip.hsr_local_map || (lastTrip.prefs && lastTrip.prefs.travel_mode === "hsr_rental")));
      if (isHsrLocal) {
        const hit = plan.find((d) => d.stay_city === cityName || d.day === i + 1);
        return hit ? hit.day : i + 1;
      }
      const hit = plan.find((d) => d.kind === "transit" && d.stay_city === cityName);
      return hit ? hit.day : i + 1;
    }

    // 沿折线长度取 0~1 的前缀，颜色跟着光点长，而不是整段先涂满
    function sliceProgress(coords, t) {
      if (!coords || coords.length < 2) return [];
      if (t >= 1) return coords;
      if (t <= 0) return [];
      const dist = [0];
      for (let i = 1; i < coords.length; i++) {
        dist.push(dist[i - 1] + Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]));
      }
      const total = dist[dist.length - 1];
      if (total <= 0) return coords.slice(0, 2);
      const target = total * t;
      const out = [coords[0]];
      for (let i = 1; i < coords.length; i++) {
        if (dist[i] <= target + 1e-9) { out.push(coords[i]); continue; }
        const span = dist[i] - dist[i - 1] || 1;
        const u = (target - dist[i - 1]) / span;
        out.push([
          coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * u,
          coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * u,
        ]);
        break;
      }
      return out.length >= 2 ? out : [];
    }

    function appendCoords(base, seg) {
      if (!seg || seg.length < 2) return base.slice();
      const out = base.slice();
      let start = 0;
      if (out.length) {
        const prev = out[out.length - 1];
        const head = seg[0];
        if (Math.abs(prev[0] - head[0]) < 1e-5 && Math.abs(prev[1] - head[1]) < 1e-5) start = 1;
      }
      for (let j = start; j < seg.length; j++) out.push(seg[j]);
      return out;
    }

    // 已走完的段拼成一条连续折线。当前段不在这里，避免一切段整段先变色
    function joinLegs(legs, lastInclusive) {
      const out = [];
      const n = Math.min(lastInclusive, legs.length - 1);
      for (let k = 0; k <= n; k++) {
        const seg = legs[k];
        if (!seg || seg.length < 2) continue;
        let start = 0;
        if (out.length) {
          const prev = out[out.length - 1];
          const head = seg[0];
          if (Math.abs(prev[0] - head[0]) < 1e-5 && Math.abs(prev[1] - head[1]) < 1e-5) start = 1;
        }
        for (let j = start; j < seg.length; j++) out.push(seg[j]);
      }
      return out;
    }

    function smoothstep(edge0, edge1, x) {
      const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)));
      return t * t * (3 - 2 * t);
    }

    function mixRgba(c0, c1, t) {
      const u = Math.min(1, Math.max(0, t));
      const ch = (i) => Math.round(c0[i] + (c1[i] - c0[i]) * u);
      const a = c0[3] + (c1[3] - c0[3]) * u;
      return `rgba(${ch(0)},${ch(1)},${ch(2)},${a.toFixed(3)})`;
    }

    function glowTargets(t) {
      const targets = {};
      if (!routeView) return targets;
      const { nodes } = routeView;
      nodes.forEach((n) => { targets[n.name] = 0; });
      const i = Math.min(legIndex, Math.max(nodes.length - 2, 0));
      const start = nodes[i] && nodes[i].name;
      const end = nodes[i + 1] && nodes[i + 1].name;
      if (routeView.pinned || reduceMotion) {
        if (end) targets[end] = 1;
        return targets;
      }
      if (end) targets[end] = smoothstep(0.38, 0.96, t);
      if (start && routeHasArrived) targets[start] = 1 - smoothstep(0, 0.4, t);
      return targets;
    }

    function easeGlow(targets, now) {
      const dt = glowStamp ? Math.min(64, now - glowStamp) : 32;
      glowStamp = now;
      const k = 1 - Math.exp(-dt / 260);
      const names = new Set([...Object.keys(cityGlow), ...Object.keys(targets)]);
      names.forEach((name) => {
        const cur = cityGlow[name] || 0;
        const next = cur + ((targets[name] || 0) - cur) * k;
        if (next < 0.008) delete cityGlow[name];
        else cityGlow[name] = next;
      });
    }

    function styledNodes() {
      const { nodes } = routeView;
      return nodes.map((n, k) => {
        const g = Math.min(1, cityGlow[n.name] || 0);
        const isTerminal = k === 0 || k === nodes.length - 1;
        return {
          name: n.name,
          value: n.coord,
          symbolSize: (isTerminal ? 10 : 7) + g * 4,
          itemStyle: {
            color: mixRgba([224, 242, 254, 0.9], [253, 230, 138, 1], g),
            borderColor: "rgba(7,17,28,.9)",
            borderWidth: 2,
          },
          label: {
            show: true,
            formatter: "{b}",
            position: k === nodes.length - 1 ? "left" : "right",
            distance: 8,
            color: mixRgba([248, 251, 255, 1], [26, 20, 8, 1], g),
            fontWeight: isTerminal || g > 0.55 ? 800 : 650,
            fontSize: (isTerminal ? 13 : 11) + (g > 0.45 ? 1 : 0),
            backgroundColor: mixRgba(isTerminal ? [7, 17, 28, 0.72] : [7, 17, 28, 0.5], [253, 230, 138, 0.96], g),
            borderColor: mixRgba([255, 255, 255, 0.18], [253, 230, 138, 0], g),
            borderWidth: 1,
            padding: [3, 8],
            borderRadius: 99,
          },
        };
      });
    }

    function ringData(now) {
      if (!routeView || reduceMotion || routeView.pinned) return [];
      let best = null;
      let amp = 0;
      routeView.nodes.forEach((n) => {
        const g = cityGlow[n.name] || 0;
        if (g > amp) { amp = g; best = n; }
      });
      if (!best || amp < 0.12) return [];
      const phase = (now % 1500) / 1500;
      return [0, 1].map((k) => {
        const p = (phase + k * 0.5) % 1;
        return {
          value: best.coord,
          symbolSize: 9 + p * 24 * amp,
          itemStyle: {
            color: "rgba(253,230,138,0)",
            borderColor: `rgba(253,230,138,${((1 - p) * 0.72 * amp).toFixed(3)})`,
            borderWidth: 1.6,
          },
        };
      });
    }

    function updateCoverLeg() {
      const box = $("coverLeg");
      if (!box) return;
      if (!routeView) { box.innerHTML = ""; return; }
      const { nodes, rail } = routeView;
      const isHsrLocal = !!(lastTrip && lastTrip.hsr_local_map);
      if (isHsrLocal && rail && nodes.length >= 2) {
        const localKm = lastTrip.hsr && lastTrip.hsr.local_drive_km ? `${lastTrip.hsr.local_drive_km} km 当地` : "当地租车";
        box.innerHTML = `
        <span class="cover-leg-day">干线</span>
        <span class="cover-leg-path">${nodes[0].name}<i>高铁→</i>${nodes[nodes.length - 1].name}</span>
        <span class="cover-leg-km">${localKm}</span>`;
        return;
      }
      if (routeView.legs.length < 1) { box.innerHTML = ""; return; }
      const i = Math.min(legIndex, routeView.legs.length - 1);
      const km = legKm(nodes, i);
      box.innerHTML = `
        <span class="cover-leg-day">DAY ${legDayNo(nodes[i + 1].name, i)}</span>
        <span class="cover-leg-path">${nodes[i].name}<i>→</i>${nodes[i + 1].name}</span>
        ${km ? `<span class="cover-leg-km">${km} km</span>` : ""}
        ${routeView.legs.length > 1 ? `<span class="cover-leg-dots">${routeView.legs.map((_, k) => `<b class="${k === i ? "on" : k < i ? "done" : ""}"></b>`).join("")}</span>` : ""}`;
    }

    function drawRouteFrame() {
      if (!chinaChart || !routeView) return;
      const { nodes, legs, full, bounds, rail } = routeView;
      const i = Math.min(legIndex, Math.max(legs.length - 1, 0));
      const activeLeg = legs[i];
      const settle = reduceMotion || routeView.pinned;
      const walked = joinLegs(legs, settle ? i : i - 1);
      if (settle) {
        cityGlow = {};
        const end = nodes[i + 1];
        if (end) cityGlow[end.name] = 1;
      }
      const nodeData = styledNodes();

      const series = [
        {
          id: "route-full",
          type: "lines",
          coordinateSystem: "geo",
          polyline: true,
          zlevel: 1,
          silent: true,
          lineStyle: { color: "rgba(226,232,240,.42)", width: 3, opacity: 1, cap: "round", join: "round" },
          data: full.length >= 2 ? [{ coords: full }] : [],
        },
        {
          id: "route-done",
          type: "lines",
          coordinateSystem: "geo",
          polyline: true,
          zlevel: 2,
          silent: true,
          animation: false,
          lineStyle: {
            color: "#fbbf24",
            width: 5,
            opacity: 1,
            cap: "round",
            join: "round",
            shadowBlur: 12,
            shadowColor: "rgba(251,191,36,.45)",
          },
          data: walked.length >= 2 ? [{ coords: walked }] : [],
        },
        {
          id: "route-head",
          type: "scatter",
          coordinateSystem: "geo",
          zlevel: 5,
          silent: true,
          animation: false,
          symbolSize: settle ? 0 : 9,
          itemStyle: { color: "#fff7d6", shadowBlur: 10, shadowColor: "rgba(251,191,36,.75)" },
          data: !settle && activeLeg && activeLeg.length ? [{ value: activeLeg[0] }] : [],
        },
        {
          id: "route-rail",
          type: "lines",
          coordinateSystem: "geo",
          zlevel: 1,
          silent: true,
          lineStyle: { color: "#93c5fd", width: 2, type: "dashed", opacity: 0.8, curveness: 0.22 },
          data: rail ? [{ coords: rail }] : [],
        },
        {
          id: "route-nodes",
          type: "scatter",
          coordinateSystem: "geo",
          zlevel: 4,
          silent: true,
          animation: false,
          data: nodeData,
        },
        {
          id: "route-rings",
          type: "scatter",
          coordinateSystem: "geo",
          zlevel: 3,
          silent: true,
          animation: false,
          symbol: "circle",
          label: { show: false },
          data: ringData(performance.now()),
        },
      ];

      const geoKey = bounds.map((p) => p.join(",")).join("|");
      const opt = {
        backgroundColor: "transparent",
        animation: false,
        animationDurationUpdate: 0,
        series,
      };
      // 视野没变就不要重设 geo，否则每一段都会把地图重绘一遍，看起来像闪
      if (geoKey !== routeGeoKey) {
        opt.geo = {
          map: "china",
          roam: false,
          silent: true,
          boundingCoords: bounds,
          left: 0, right: 0, top: 0, bottom: 0,
          itemStyle: {
            areaColor: "rgba(148,180,220,0.10)",
            borderColor: "rgba(186,214,242,0.30)",
            borderWidth: 1,
          },
          emphasis: { disabled: true },
        };
        routeGeoKey = geoKey;
      }
      chinaChart.setOption(opt);
      updateCoverLeg();
      armLegMotion();
    }

    function paintGrown(t) {
      if (!chinaChart || !routeView) return;
      const { legs } = routeView;
      const i = Math.min(legIndex, Math.max(legs.length - 1, 0));
      const done = joinLegs(legs, i - 1);
      const partial = sliceProgress(legs[i], t);
      const grown = appendCoords(done, partial);
      const head = partial.length ? partial[partial.length - 1] : (legs[i] && legs[i][0]);
      const now = performance.now();
      easeGlow(glowTargets(t), now);
      chinaChart.setOption({
        animation: false,
        animationDurationUpdate: 0,
        series: [
          { id: "route-done", data: grown.length >= 2 ? [{ coords: grown }] : [] },
          { id: "route-head", data: head ? [{ value: head }] : [] },
          { id: "route-nodes", data: styledNodes(), animation: false },
          { id: "route-rings", data: ringData(now), animation: false },
        ],
      });
    }

    function stopLegCycle() {
      if (legTimer) { clearInterval(legTimer); legTimer = null; }
      if (legRaf) { cancelAnimationFrame(legRaf); legRaf = 0; }
    }

    function armLegMotion() {
      stopLegCycle();
      if (reduceMotion || !routeView || routeView.pinned || routeView.legs.length < 1) return;
      legStartedAt = performance.now();
      let lastPaint = 0;
      const step = (now) => {
        if (!routeView || routeView.pinned) return;
        if (document.hidden) { legRaf = requestAnimationFrame(step); return; }
        const t = Math.min(1, (now - legStartedAt) / LEG_STEP_MS);
        if (now - lastPaint > 32 || t >= 1) {
          paintGrown(t);
          lastPaint = now;
        }
        if (t >= 1) {
          routeHasArrived = true;
          if (routeView.legs.length < 2) return;
          legIndex = (legIndex + 1) % routeView.legs.length;
          drawRouteFrame();
          return;
        }
        legRaf = requestAnimationFrame(step);
      };
      legRaf = requestAnimationFrame(step);
    }

    function startLegCycle() {
      armLegMotion();
    }

    async function renderChinaRoute(state) {
      lastRouteState = { ...(lastRouteState || {}), ...(state || {}) };
      await chinaPromise;
      if (!chinaReady || typeof echarts === "undefined") return;
      const el = $("chinaMap");
      if (!el) return;
      if (chinaChart && chinaChart.getDom && chinaChart.getDom() !== el) {
        chinaChart.dispose();
        chinaChart = null;
      }
      if (!chinaChart) {
        chinaChart = echarts.init(el);
        routeGeoKey = "";
      }

      const s = lastRouteState;
      const oCoord = parseLngLat(s.origin_location);
      const dCoord = parseLngLat(s.destination_location);
      const poly = (s.polyline || []).map(parseLngLat).filter(Boolean);

      let nodes = (s.via_nodes || [])
        .map((n) => ({ name: n.name, coord: parseLngLat(n.location), cum_km: n.cum_km }))
        .filter((n) => n.name && n.coord);
      if (nodes.length < 2) {
        nodes = [];
        if (oCoord) nodes.push({ name: s.origin || "出发", coord: oCoord, cum_km: 0 });
        if (dCoord) nodes.push({ name: s.destination || "抵达", coord: dCoord, cum_km: null });
      }
      if (!nodes.length) return;

      const isHsrLocal = !!s.hsr_local_map;
      let full = poly.length >= 2 ? poly : nodes.map((n) => n.coord);
      if (isHsrLocal) {
        full = poly.length >= 2 ? poly : [];
      }
      const legs =
        isHsrLocal && poly.length >= 2
          ? splitLegs(poly, [
              { name: "_a", coord: poly[0], cum_km: 0 },
              { name: "_b", coord: poly[poly.length - 1], cum_km: null },
            ])
          : isHsrLocal
            ? []
            : splitLegs(poly, nodes);
      const railFrom = parseLngLat(s.rail_from);
      const railTo = parseLngLat(s.rail_to);
      const rail = railFrom && railTo ? [railFrom, railTo] : null;
      const bounds = routeBounds([...full, ...nodes.map((n) => n.coord), ...(rail || [])], el);

      const signature = nodes.map((n) => n.name).join(">");
      const highlight = s.highlight_city || null;
      let pinned = false;
      if (!routeView || routeView.signature !== signature) {
        legIndex = 0;
        cityGlow = {};
        glowStamp = 0;
        routeHasArrived = false;
      }
      if (highlight) {
        const hit = nodes.findIndex((n, k) => k > 0 && n.name === highlight);
        if (hit > 0) { legIndex = hit - 1; pinned = true; }
      }
      routeView = { nodes, legs, full, bounds, rail, signature, pinned };
      chinaChart.resize();
      drawRouteFrame();
      startLegCycle();
    }

    function renderCoverRoute(origin, destination, via) {
      const box = $("coverRoute");
      if (!box) return;
      const mids = (via || []).filter((c) => c && c !== origin && c !== destination);
      const shown = mids.length > 4 ? [...mids.slice(0, 3), `+${mids.length - 3}`] : mids;
      box.innerHTML = [
        `<span class="cr-city cr-end" id="originText">${origin || "出发"}</span>`,
        ...shown.map((c) => `<span class="cr-city">${c}</span>`),
        `<span class="cr-city cr-end cr-dest" id="destText">${destination || "抵达"}</span>`,
      ].join('<span class="cr-sep" aria-hidden="true"></span>');
    }

    function seedFromText(s) {
      let hash = 2166136261;
      for (const ch of (s || "成都")) {
        hash ^= ch.codePointAt(0);
        hash = Math.imul(hash, 16777619);
      }
      const h = ((hash >>> 0) % 360) / 360;
      const sat = 0.62;
      const hsl = (hh, ss, ll) => `hsl(${Math.round(((hh % 1 + 1) % 1) * 360)} ${Math.round(ss * 100)}% ${Math.round(ll * 100)}%)`;
      const sec = h + 0.05;
      const ter = h + 0.14;
      const light = {
        primary: hsl(h, sat, 0.34),
        onPrimary: "#ffffff",
        primaryContainer: hsl(h, 0.55, 0.91),
        onPrimaryContainer: hsl(h, 0.65, 0.14),
        secondary: hsl(sec, 0.32, 0.38),
        secondaryContainer: hsl(sec, 0.35, 0.92),
        onSecondaryContainer: hsl(sec, 0.45, 0.16),
        tertiary: hsl(ter, 0.42, 0.38),
        tertiaryContainer: hsl(ter, 0.45, 0.92),
        surface: hsl(h, 0.22, 0.985),
        surfaceDim: hsl(h, 0.20, 0.94),
        surfaceContainer: hsl(h, 0.24, 0.96),
        surfaceContainerHigh: hsl(h, 0.24, 0.93),
        onSurface: hsl(h, 0.25, 0.11),
        onSurfaceVariant: hsl(h, 0.14, 0.36),
        outline: hsl(h, 0.14, 0.58),
        outlineVariant: hsl(h, 0.18, 0.82),
        heroStart: hsl(h, 0.52, 0.14),
        heroMid: hsl(h, 0.58, 0.22),
        heroEnd: hsl(ter, 0.50, 0.26),
      };
      const dark = {
        primary: hsl(h, Math.max(0.35, sat * 0.72), 0.78),
        onPrimary: hsl(h, sat, 0.14),
        primaryContainer: hsl(h, sat * 0.55, 0.26),
        onPrimaryContainer: hsl(h, sat * 0.55, 0.90),
        secondary: hsl(sec, Math.max(0.22, sat * 0.35), 0.78),
        secondaryContainer: hsl(sec, sat * 0.28, 0.24),
        onSecondaryContainer: hsl(sec, sat * 0.30, 0.90),
        tertiary: hsl(ter, Math.max(0.28, sat * 0.42), 0.80),
        tertiaryContainer: hsl(ter, sat * 0.35, 0.26),
        surface: hsl(h, 0.14, 0.10),
        surfaceDim: hsl(h, 0.14, 0.07),
        surfaceContainer: hsl(h, 0.12, 0.14),
        surfaceContainerHigh: hsl(h, 0.12, 0.18),
        onSurface: hsl(h, 0.08, 0.92),
        onSurfaceVariant: hsl(h, 0.10, 0.74),
        outline: hsl(h, 0.12, 0.55),
        outlineVariant: hsl(h, 0.12, 0.28),
        heroStart: hsl(h, 0.45, 0.08),
        heroMid: hsl(h, 0.50, 0.14),
        heroEnd: hsl(ter, 0.42, 0.18),
      };
      return { seed: hsl(h, sat, 0.42), light, dark, ...light };
    }

    function weatherKind(text) {
      const t = String(text || "");
      if (/雪|冰雹/.test(t)) return "snow";
      if (/雷|暴雨/.test(t)) return "storm";
      if (/雨/.test(t)) return "rain";
      if (/雾|霾|沙|尘/.test(t)) return "fog";
      if (/阴/.test(t)) return "overcast";
      if (/云|晴间多云|多云/.test(t)) return "cloudy";
      if (/晴/.test(t)) return "sunny";
      return "cloudy";
    }

    function weatherIcon(kind) {
      return ({
        sunny: "☀️",
        cloudy: "⛅️",
        overcast: "☁️",
        rain: "🌧",
        storm: "⛈",
        snow: "❄️",
        fog: "🌫",
      })[kind] || "🌤";
    }

    function weatherFxHtml(kind, density) {
      return `<div class="wx-fx ${kind}" data-kind="${kind}" data-density="${density || 1}" aria-hidden="true"><span class="wx-fx-base"></span></div>`;
    }

    const imageTones = new Map();
    let daysRenderEpoch = 0;

    async function applyImageTones(root, renderEpoch) {
      if (!root) return;
      const hosts = [...root.querySelectorAll(".wx-fx")].map((fx) => {
        const img = fx.parentElement && fx.parentElement.querySelector("img.day-hero-img, img.chip-photo");
        return { fx, src: img && img.getAttribute("src") };
      }).filter((h) => h.src);
      const missing = [...new Set(hosts.map((h) => h.src).filter((s) => !imageTones.has(s)))];
      if (missing.length) {
        try {
          const resp = await fetch("/api/image-tones", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: missing }),
          });
          const data = await resp.json();
          missing.forEach((s) => imageTones.set(s, data[s] || null));
        } catch (_) {
          missing.forEach((s) => imageTones.set(s, null));
        }
      }
      if (renderEpoch != null && renderEpoch !== daysRenderEpoch) return;
      hosts.forEach(({ fx, src }) => {
        if (!root.contains(fx)) return;
        const t = imageTones.get(src);
        if (!t) return;
        fx.style.setProperty("--wx-inv", t.inverse);
        fx.style.setProperty("--wx-inv-deep", t.inverseDeep);
      });
    }

    // WeatherFX 由 /static/js/weather-fx.js 提供
    const WeatherFX = window.WeatherFX;
function weatherForDay(dayNum) {
      const chart = lastWeatherState || (lastTrip && lastTrip.weather_chart);
      if (!chart || !chart.labels || !chart.labels.length) return null;
      const idx = Math.max(0, Math.min((dayNum || 1) - 1, chart.labels.length - 1));
      const hi = chart.highs && chart.highs[idx];
      const lo = chart.lows && chart.lows[idx];
      const text = (chart.texts && chart.texts[idx]) || "";
      if (hi == null && lo == null && !text) return null;
      const kind = weatherKind(text);
      return {
        hi,
        lo,
        label: chart.labels[idx],
        text: text || "多云",
        kind,
        icon: weatherIcon(kind),
      };
    }

    function showSkeleton(data) {
      applyPalette(seedFromText(data.destination || data.origin));
      $("result").classList.remove("hidden");
      $("title").textContent = data.title || `${data.origin} → ${data.destination}`;
      renderCoverRoute(data.origin, data.destination, []);
      const hl = $("highlight");
      if (hl) {
        hl.classList.remove("first-glance");
        hl.textContent = data.highlight || "正在规划…";
      }
      $("statDays").textContent = `${data.days || "—"} 天`;
      $("statDistance").textContent = data.distance || "计算中…";
      $("statDrive").textContent = data.drive_hours || "计算中…";
      setStatSrc("statDistanceSrc", "");
      setStatSrc("statDriveSrc", "");
      setStatSrc("statBudgetSrc", "");
      selectedDay = null;
      lastTrip = null;
      $("dayBar").innerHTML = "";
      renderChinaRoute({ origin: data.origin, destination: data.destination });
    }

    function renderWeather(chart) {
      lastWeatherState = chart;
      if (lastTrip) {
        renderDayChips(lastTrip);
        renderDays(lastTrip);
      }
    }

    function weatherBadgeHtml(w, compact) {
      if (!w) return "";
      const temp = (w.hi != null || w.lo != null)
        ? `${w.hi ?? "—"}° / ${w.lo ?? "—"}°`
        : "";
      if (compact) {
        return `<span class="chip-wx"><span class="wx-icon ${w.kind}">${w.icon}</span>${w.text}${temp ? ` ${temp}` : ""}</span>`;
      }
      return `<div class="day-wx"><span class="wx-icon ${w.kind}">${w.icon}</span><span>${w.text}${temp ? ` · ${temp}` : ""}</span></div>`;
    }

    function escAttr(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function normalizeImageUrl(url) {
      if (!url || typeof url !== "string") return "";
      let u = url.trim();
      if (!u) return "";
      if (u.startsWith("//")) u = "https:" + u;
      else if (u.startsWith("http://")) u = "https://" + u.slice(7);
      return u;
    }

    function dayHeroImage(day, trip) {
      const items = day.items || [];
      const ranked = [
        ...items.filter((i) => i.type === "sight" && i.image),
        ...items.filter((i) => i.type === "food" && i.image),
        ...items.filter((i) => i.image),
      ];
      if (ranked[0]?.image) return normalizeImageUrl(ranked[0].image);
      const foods = trip.foods || [];
      const fallback = foods[(Math.max(1, day.day) - 1) % Math.max(foods.length, 1)];
      return normalizeImageUrl((fallback && fallback.image) || trip.hero_image || "");
    }

    function photoImgHtml(url, cls) {
      const src = normalizeImageUrl(url);
      if (!src) return "";
      return `<img class="${cls}" src="${escAttr(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" decoding="async" />`;
    }

    function slotImgHtml(url, alt) {
      const src = normalizeImageUrl(url);
      if (!src) return "";
      return `<div class="img-slot"><img src="${escAttr(src)}" alt="${escAttr(alt || "")}" loading="lazy" referrerpolicy="no-referrer" decoding="async" onload="this.classList.add('ready')" onerror="this.parentElement.classList.add('broken');this.remove()" /></div>`;
    }

    function slotImgHtmlSm(url, alt) {
      const src = normalizeImageUrl(url);
      if (!src) return "";
      return `<div class="img-slot sm"><img src="${escAttr(src)}" alt="${escAttr(alt || "")}" loading="lazy" referrerpolicy="no-referrer" decoding="async" onload="this.classList.add('ready')" onerror="this.parentElement.classList.add('broken');this.remove()" /></div>`;
    }

    function renderDayChips(trip) {
      const days = trip.days_plan || [];
      const bar = $("dayBar");
      const chips = [renderDayChipAll(trip, days)];
      days.forEach((day) => chips.push(renderDayChip(day, trip)));
      bar.innerHTML = chips.join("");
      WeatherFX.mount(bar);
      applyImageTones(bar);
      bar.querySelectorAll(".day-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
          const raw = btn.dataset.day;
          selectedDay = raw === "" ? null : Number(raw);
          const day = selectedDay == null ? null : (trip.days_plan || []).find((d) => d.day === selectedDay);
          renderDayChips(trip);
          renderDays(trip);
          refreshRailForDay(trip);
          if (lastRouteState) {
            renderChinaRoute({
              ...lastRouteState,
              highlight_city: day ? (day.stay_city || day.to_city || null) : null,
            });
          }
        });
      });
    }

    function renderFreeSlot(item, dayNum) {
      return `
        <div class="free-slot" data-day="${dayNum}" data-stop-id="${escAttr(item.id || `free-${dayNum}`)}">
          <div>
            <strong>☕ ${item.time ? `${item.time} · ` : ""}${item.title || "留白自由活动"}</strong>
            <div>${item.detail || ""}</div>
          </div>
          <button type="button" class="stop-remove" data-act="remove-free" title="移除留白">×</button>
        </div>`;
    }

    function stopCardHtml(item, index, dayNum) {
      if (item.type === "free") return renderFreeSlot(item, dayNum);
      const src = normalizeImageUrl(item.image);
      const showSlot = !!src;
      const done = !!item.done;
      const prio = item.priority || (item.type === "drive" ? "anchor" : "must");
      const idx = done ? "✓" : (prio === "anchor" && item.type === "sight" ? "★" : String(index).padStart(2, "0"));
      const tags = [];
      if (item.rating) tags.push(`★ ${item.rating}`);
      if (item.cost) tags.push(`人均 ¥${item.cost}`);
      if (item.stay_hours && item.type !== "drive") tags.push(`建议 ${item.stay_hours}h`);
      (item.human_tags || []).forEach((t) => {
        if (tags.length < 4 && !tags.includes(t)) tags.push(t);
      });
      const canNav = !!(item.location || item.place);
      const canSwap = !isShareView() && (item.type === "sight" || item.type === "food");
      const canXhs = item.type === "sight" || item.type === "food";
      const districtText = item.district
        ? (item.is_county ? `🏞 郊县 · ${item.district}` : `📍 ${item.district}`)
        : "";
      let prioBadge = "";
      if (prio === "anchor" && item.type === "sight") {
        prioBadge = `<span class="prio-badge anchor">今日必去锚点</span>`;
      } else if (prio === "optional") {
        prioBadge = `<span class="prio-badge optional">顺路可选 · 体力好再去</span>`;
      }
      return `
        <div class="stop-card ${done ? "done" : ""} ${prio === "anchor" ? "is-anchor" : ""} ${prio === "optional" ? "is-optional" : ""}" data-day="${dayNum}" data-stop-id="${escAttr(item.id || `${dayNum}-${index}`)}" data-type="${escAttr(item.type || "")}">
          <div class="stop-idx" data-act="done" title="点击标记已去过/取消">${idx}</div>
          <div class="stop-body ${showSlot ? "" : "no-img"}">
            ${showSlot ? slotImgHtml(src, item.title || "") : ""}
            <div>
              <div class="stop-head">
                <div class="stop-badges">
                  <span class="stop-kind">${typeLabel(item.type)}</span>
                  ${prioBadge}
                  ${districtText ? `<span class="county-badge">${districtText}</span>` : ""}
                </div>
                ${canSwap ? `<button type="button" class="stop-remove" data-act="remove" title="从当日移除">×</button>` : ""}
              </div>
              <div class="stop-title${canNav ? " stop-title-nav" : ""}"${canNav ? ` data-act="nav" title="点击导航至「${escAttr(item.title || item.place || "")}」"` : ""}>${item.title || ""}</div>
              ${item.place ? `<div class="stop-meta stop-place-row"><button type="button" class="stop-place-nav" data-act="nav" title="点击导航">📍 ${escAttr(item.place)}</button>${canNav ? `<button type="button" class="stop-place-copy" data-act="copy" title="复制地址">复制</button>` : ""}</div>` : ""}
              ${item.detail ? `<div class="stop-meta">${item.detail}</div>` : ""}
              ${item.time ? `<span class="stop-time">${item.time}</span>` : ""}
              ${tags.length ? `<div class="stop-tags">${tags.map((t) => `<span class="stop-tag">${t}</span>`).join("")}</div>` : ""}
              <div class="stop-actions">
                ${canNav ? `<button type="button" class="stop-act primary" data-act="nav">🧭 导航</button>` : ""}
                ${canXhs ? `<button type="button" class="stop-act xhs" data-act="xhs">📕 小红书实况</button>` : ""}
                ${canSwap ? `<button type="button" class="stop-act" data-act="swap">↻ 换一换</button>` : ""}
              </div>
            </div>
          </div>
        </div>`;
    }

    function haversineKmJs(loc1, loc2) {
      const a = parseLngLat(loc1);
      const b = parseLngLat(loc2);
      if (!a || !b) return null;
      const toRad = (x) => (x * Math.PI) / 180;
      const dLat = toRad(b[1] - a[1]);
      const dLng = toRad(b[0] - a[0]);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(h));
    }

    function legHtml(prev, next) {
      if (!prev || !next) return "";
      if (prev.type === "free" || next.type === "free") {
        return `<div class="leg">松弛转场 · 歇够了再出发</div>`;
      }
      if (prev.type === "drive") {
        return `<div class="leg">抵达落脚城 · <strong>进城先停好车，傍晚轻装逛吃</strong></div>`;
      }
      const km = haversineKmJs(prev.location, next.location);
      if (km != null && km > 0.2) {
        const roadKm = Math.max(1, Math.round(km * 1.3));
        const mins = Math.max(8, Math.round((roadKm / 32) * 60));
        if (roadKm >= 20) {
          return `<div class="leg">跨区/县域转场 · 约 <strong>${roadKm} km（车程 ${mins} 分钟）</strong> · 留意景区停车场</div>`;
        }
        return `<div class="leg">站间移动 · 约 <strong>${roadKm} km（驾车/打车 ${mins} 分钟）</strong></div>`;
      }
      if (next.type === "food") {
        return `<div class="leg">傍晚寻味 · 前往当地口碑老店（错峰免排队）</div>`;
      }
      return `<div class="leg">同片区顺路移动 · 约 <strong>15–25 分钟</strong></div>`;
    }

    function timeWindowLabel(raw) {
      const m = String(raw || "").match(/(\d{1,2})\s*:\s*(\d{2})/);
      if (!m) return "";
      const h = Number(m[1]);
      if (h < 11) return `早上 ${h} 点前后`;
      if (h < 14) return `中午 ${h} 点前后`;
      if (h < 18) return `下午 ${h} 点前后`;
      return `傍晚 ${h} 点前后`;
    }

    function shortStopName(item) {
      return String((item && item.title) || "").replace(/[（(].*$/, "").trim();
    }

    /** 每天一句取舍：出发时间窗 · 今日锚点 · 晚点先砍的可选站 */
    function dayPlayLine(day) {
      if (!day) return "";
      const items = day.items || [];
      const drive = items.find((it) => it.type === "drive" && it.time);
      const anchor =
        items.find((it) => it.priority === "anchor" && it.type === "sight") ||
        items.find((it) => it.type !== "drive" && it.type !== "tip" && it.priority === "anchor");
      const optional =
        [...items].reverse().find((it) => it.user_added && it.priority === "optional" && it.title) ||
        items.find((it) => it.priority === "optional" && it.title);
      const parts = [];
      const departSrc = drive || (anchor && anchor.time ? anchor : null);
      const windowLabel = departSrc ? timeWindowLabel(departSrc.time) : "";
      if (windowLabel) parts.push(`${windowLabel}出发`);
      const anchorName = shortStopName(anchor);
      if (anchorName) parts.push(`今天保「${anchorName}」`);
      const cutName = shortStopName(optional);
      if (cutName) parts.push(`晚点先砍「${cutName}」`);
      else if (day.kind === "transit" && day.drive_km) {
        parts.push(`今日约 ${Math.round(Number(day.drive_km) || 0)} km`);
      }
      return parts.join(" · ");
    }

    function renderDayHero(day, trip) {
      const photo = dayHeroImage(day, trip);
      const w = weatherForDay(day.day);
      const playLine = dayPlayLine(day);
      const drivePills = [];
      if (day.kind === "transit" && day.drive_km) {
        drivePills.push(`<span class="${rbBtnClass("pill")}">🚗 今日 ${day.drive_km} km · 约 ${day.drive_hours || "—"} h</span>`);
      }
      if (day.stay_city) {
        const vibe = day.city_vibe || (trip.city_vibes && trip.city_vibes[day.stay_city]);
        const vibeText = vibe && vibe.tags ? ` · ${vibe.tags.slice(0, 2).join("/")}` : "";
        drivePills.push(`<span class="${rbBtnClass("pill")}">🛏 夜宿 ${day.stay_city}${vibeText}</span>`);
      }
      if (day.kind === "county") drivePills.push(`<span class="${rbBtnClass("pill")}">🏞 宝藏郊县专场 · 不折返</span>`);
      else if (day.kind === "explore") drivePills.push(`<span class="${rbBtnClass("pill")}">📌 1 锚点 + 弹性漫游</span>`);
      drivePills.push(`<button type="button" class="${rbBtnClass("pill-action")}" data-day-nav="${day.day}">🧭 导航今日全程 ↗</button>`);
      if (!isShareView()) {
        drivePills.push(`<button type="button" class="${rbBtnClass("pill-action")}" data-day-chat="${day.day}">💬 对话改这天</button>`);
      }
      return `
        <div class="day-hero ${photo ? "has-photo" : ""}">
          ${photoImgHtml(photo, "day-hero-img")}
          <div class="day-hero-veil"></div>
          ${w ? weatherFxHtml(w.kind, 1) : ""}
          <div class="day-hero-copy">
            <div class="day-no">DAY ${day.day}${dayDateTag(day) ? " · " + dayDateTag(day) : ""}</div>
            <h4>${day.title || ""}</h4>
            ${playLine ? `<p class="day-play-line">${escAttr(playLine)}</p>` : ""}
            ${day.summary ? `<p class="day-summary">${day.summary}</p>` : ""}
            <div class="drive-bar">${drivePills.join("")}</div>
            ${weatherBadgeHtml(w, false)}
          </div>
        </div>`;
    }

    function renderDayChipAll(trip, days) {
      const totalStops = days.reduce((n, d) => n + ((d.items || []).length), 0);
      const allPhoto = trip.hero_image || (trip.foods || []).find((f) => f.image)?.image || "";
      const allWx = weatherForDay(1);
      return `
        <button type="button" class="day-chip ${allPhoto ? "has-photo" : ""} ${selectedDay === null ? "active" : ""}" data-day="">
          ${photoImgHtml(allPhoto, "chip-photo")}
          <span class="chip-veil"></span>
          ${allWx ? weatherFxHtml(allWx.kind, .7) : ""}
          <span class="chip-copy">
            <span class="chip-k">全部</span>
            <span class="chip-t">${trip.days || days.length} 日行程</span>
            <span class="chip-m">${totalStops} 个站点</span>
            ${weatherBadgeHtml(allWx, true)}
          </span>
        </button>`;
    }

    function renderDayChip(day, trip) {
      const w = weatherForDay(day.day);
      const stops = (day.items || []).length;
      const theme = (day.title || "").replace(/^.*?[·•]\s*/, "").slice(0, 12) || `第 ${day.day} 日`;
      const photo = dayHeroImage(day, trip);
      return `
        <button type="button" class="day-chip ${photo ? "has-photo" : ""} ${selectedDay === day.day ? "active" : ""}" data-day="${day.day}">
          ${photoImgHtml(photo, "chip-photo")}
          <span class="chip-veil"></span>
          ${w ? weatherFxHtml(w.kind, .7) : ""}
          <span class="chip-copy">
            <span class="chip-k">DAY ${day.day}${day.date ? " · " + shortDate(day.date) : ""}</span>
            <span class="chip-t">${theme}</span>
            <span class="chip-m">${stops} 站</span>
            ${weatherBadgeHtml(w, true)}
          </span>
        </button>`;
    }

    const TRANSIT_ICON = { rail: "🚄", metro: "🚇", taxi: "🚕", drive: "🚗" };

    function localTransitHtml(day) {
      const notes = day.local_transit || [];
      if (!notes.length) return "";
      return `
        <div class="local-transit" aria-label="当天交通备注">
          <span class="local-transit-k">当天怎么走</span>
          ${notes.map((n) => `
            <span class="local-transit-item" data-mode="${n.mode || ""}">
              <i>${TRANSIT_ICON[n.mode] || "•"}</i>${n.text || ""}
            </span>`).join("")}
        </div>`;
    }

    function renderDays(trip) {
      const renderEpoch = ++daysRenderEpoch;
      const days = trip.days_plan || [];
      if (!days.length) {
        $("daysList").innerHTML = '<div class="empty">暂无日程</div>';
        return;
      }
      const visible = selectedDay == null
        ? days
        : days.filter((d) => d.day === selectedDay);
      if (poolPickerDay != null && !visible.some((d) => d.day === poolPickerDay)) {
        poolPickerDay = null;
        poolFilterQuery = "";
      }
      syncPoolDock();
      if (!visible.length) {
        $("daysList").innerHTML = '<div class="empty">该日暂无安排</div>';
        return;
      }
      $("daysList").innerHTML = visible.map((day) => {
        const items = day.items || [];
        let seq = 0;
        const body = items.map((item, i) => {
          if (item.type !== "free") seq += 1;
          const card = stopCardHtml(item, seq, day.day);
          const leg = i < items.length - 1 ? legHtml(item, items[i + 1]) : "";
          return card + leg;
        }).join("");
        return `
          <section class="day-block" data-day="${day.day}">
            ${renderDayHero(day, trip)}
            ${localTransitHtml(day)}
            <div class="stop-list">
              ${body || '<div class="empty">当天细节待补充</div>'}
              ${poolPickerHtml(day, trip)}
            </div>
          </section>`;
      }).join("");
      WeatherFX.mount($("daysList"));
      applyImageTones($("daysList"), renderEpoch);
      bindStopActions($("daysList"));
      layoutStopRails($("daysList"));
      watchStopRails($("daysList"));
      setTimeout(() => chinaChart && chinaChart.resize(), 60);
    }

    function layoutStopRails(root) {
      if (!root) return;
      root.querySelectorAll(".stop-list").forEach((list) => {
        list.querySelectorAll(":scope > .stop-join").forEach((node) => node.remove());
        const idxs = [...list.querySelectorAll(":scope > .stop-card .stop-idx")];
        if (idxs.length < 2) return;
        const listBox = list.getBoundingClientRect();
        for (let i = 0; i < idxs.length - 1; i += 1) {
          const a = idxs[i].getBoundingClientRect();
          const b = idxs[i + 1].getBoundingClientRect();
          const y1 = a.top + a.height / 2 - listBox.top;
          const y2 = b.top + b.height / 2 - listBox.top;
          const join = document.createElement("div");
          join.className = "stop-join";
          join.style.left = `${a.left + a.width / 2 - listBox.left}px`;
          join.style.top = `${y1}px`;
          join.style.height = `${Math.max(0, y2 - y1)}px`;
          list.appendChild(join);
        }
      });
    }

    function watchStopRails(root) {
      if (!root || root.dataset.railWatch === "1" || typeof ResizeObserver === "undefined") return;
      root.dataset.railWatch = "1";
      const observer = new ResizeObserver(() => layoutStopRails(root));
      observer.observe(root);
    }

    function railCityKey(name) {
      if (window.RoadbookCore && window.RoadbookCore.cleanCityName) {
        return window.RoadbookCore.cleanCityName(name);
      }
      return String(name || "").trim().replace(/(?:市|省|自治区|自治州|地区|盟)$/, "");
    }

    function dayNumsOf(days, kinds) {
      return (days || [])
        .filter((d) => !kinds || kinds.has(d.kind))
        .map((d) => Number(d.day))
        .filter((n) => Number.isFinite(n) && n > 0);
    }

    /** 与 trip_planner._annotate_rail_items / _build_pitfalls 同一规则。已有 day 不覆盖。 */
    function ensureRailAttribution(trip) {
      if (!trip) return;
      const days = trip.days_plan || [];
      const dest = railCityKey(trip.destination || "");
      const origin = railCityKey(trip.origin || "");
      const cityToDays = new Map();
      days.forEach((d) => {
        const dayNo = Number(d.day);
        if (!Number.isFinite(dayNo) || dayNo <= 0) return;
        [d.stay_city, d.to_city, d.from_city].forEach((raw) => {
          const key = railCityKey(raw || "");
          if (!key) return;
          if (!cityToDays.has(key)) cityToDays.set(key, []);
          const list = cityToDays.get(key);
          if (!list.includes(dayNo)) list.push(dayNo);
        });
      });
      const explore = dayNumsOf(days, new Set(["explore", "county"]));
      const allDays = dayNumsOf(days);
      const destDays = cityToDays.get(dest) || (explore.length ? explore : allDays);
      const transit = dayNumsOf(days, new Set(["transit"]));
      const county = dayNumsOf(days, new Set(["county"]));

      function cityFromPlace(place, fallback) {
        const text = String(place || "");
        for (const key of cityToDays.keys()) {
          if (key && text.includes(key)) return key;
        }
        return fallback || dest;
      }

      (trip.foods || []).forEach((food, i) => {
        if (!food) return;
        const city = railCityKey(food.city || "") || cityFromPlace(food.place, dest);
        food.city = city || dest;
        if (food.day == null || food.day === "") {
          const bucket = cityToDays.get(food.city) || destDays;
          food.day = bucket.length ? bucket[i % bucket.length] : null;
        }
      });
      (trip.hotels || []).forEach((hotel) => {
        if (!hotel) return;
        const city = railCityKey(hotel.city || "") || cityFromPlace(hotel.place || hotel.name, dest);
        hotel.city = city || dest;
        if (hotel.day == null || hotel.day === "") {
          const bucket = cityToDays.get(hotel.city) || destDays;
          hotel.day = bucket.length ? bucket[bucket.length - 1] : null;
        }
      });
      (trip.pitfalls || []).forEach((pit) => {
        if (!pit || pit.day != null || pit.scope === "all") return;
        const text = String(pit.pit || "");
        if (/雨雾/.test(text)) {
          pit.scope = "all";
          pit.day = null;
          pit.city = "";
          return;
        }
        if (/赶路|晚高峰|山路/.test(text) && transit.length) {
          pit.day = transit[0];
          pit.city = origin;
          pit.scope = "transit";
          return;
        }
        if (/郊县|折返/.test(text)) {
          pit.day = (county[0] || explore[0] || allDays[0]) || null;
          pit.city = dest;
          return;
        }
        pit.day = (explore[0] || allDays[0]) || null;
        pit.city = dest;
      });
    }

    function selectedDayContext(trip) {
      if (selectedDay == null) return null;
      const day = (trip.days_plan || []).find((d) => Number(d.day) === Number(selectedDay));
      if (!day) return { day: selectedDay };
      return { day: selectedDay };
    }

    function railScopeLabel(item) {
      if (item && item.scope === "all") return "全程";
      if (item && item.day != null && item.day !== "") return `Day ${item.day}`;
      return "";
    }

    function itemMatchesSelectedDay(item, ctx) {
      if (!ctx) return true;
      if (!item || item.scope === "all") return false;
      return item.day != null && item.day !== "" && Number(item.day) === Number(ctx.day);
    }

    function filterRailItems(items, trip) {
      const list = items || [];
      const ctx = selectedDayContext(trip);
      if (!ctx) return list;
      return list.filter((it) => itemMatchesSelectedDay(it, ctx));
    }

    function setRailSectionTitle(boxId, baseTitle, filteredCount, totalCount) {
      const box = $(boxId);
      const panel = box && box.closest("section.panel");
      const h4 = panel && panel.querySelector("h4");
      if (!h4) return;
      if (selectedDay == null) {
        h4.textContent = baseTitle;
        return;
      }
      const tag = `Day ${selectedDay}`;
      if (filteredCount === 0) h4.textContent = `${tag} · ${baseTitle}`;
      else if (filteredCount < totalCount) h4.textContent = `${tag} · ${baseTitle}（${filteredCount}）`;
      else h4.textContent = `${tag} · ${baseTitle}`;
    }

    function refreshRailForDay(trip) {
      const t = trip || lastTrip;
      if (!t) return;
      ensureRailAttribution(t);
      const foods = t.foods || [];
      const hotels = t.hotels || [];
      const pitfalls = t.pitfalls || [];
      const foodsView = filterRailItems(foods, t);
      const hotelsView = filterRailItems(hotels, t);
      const pitsView = filterRailItems(pitfalls, t);
      renderFoods(foodsView, { filtered: selectedDay != null, total: foods.length });
      renderHotels(hotelsView, { filtered: selectedDay != null, total: hotels.length });
      renderTips(
        selectedDay == null ? t.tips || [] : [],
        pitsView,
        { filtered: selectedDay != null, total: pitfalls.length }
      );
      setRailSectionTitle("foods", "必吃清单", foodsView.length, foods.length);
      setRailSectionTitle("tips", "避坑指南和住宿", pitsView.length + hotelsView.length, pitfalls.length + hotels.length);
    }

    function renderFoods(foods, meta) {
      setRailSectionTitle("foods", "必吃清单", (foods || []).length, (meta && meta.total) || (foods || []).length);
      if (!foods || !foods.length) {
        $("foods").innerHTML = selectedDay != null
          ? `<div class="empty">Day ${selectedDay} 暂无单独必吃，切回「全部」看全程</div>`
          : '<div class="empty">暂无美食推荐</div>';
        return;
      }
      $("foods").innerHTML = foods.map((f) => {
        const tag = railScopeLabel(f);
        return `
        <div class="quiet-item ${normalizeImageUrl(f.image) ? "" : "no-img"}">
          ${slotImgHtmlSm(f.image, f.name || "")}
          <div>
            <strong>${tag ? `<span class="rail-day-tag">${escAttr(tag)}</span> ` : ""}${escAttr(f.name || "")}</strong>
            <span>${[f.place, f.note].filter(Boolean).map(escAttr).join(" · ")}</span>
          </div>
        </div>`;
      }).join("");
    }

    function renderHotels(hotels, meta) {
      if (!hotels || !hotels.length) {
        $("hotels").innerHTML = selectedDay != null
          ? `<div class="empty">Day ${selectedDay} 暂无单独住宿建议</div>`
          : '<div class="empty">暂无住宿建议</div>';
        return;
      }
      $("hotels").innerHTML = hotels.map((h) => {
        const tag = railScopeLabel(h);
        return `
        <div class="quiet-item no-img">
          <div>
            <strong>${tag ? `<span class="rail-day-tag">${escAttr(tag)}</span> ` : ""}${escAttr(h.name || "")}</strong>
            <span>${[h.place, h.note].filter(Boolean).map(escAttr).join(" · ")}</span>
          </div>
        </div>`;
      }).join("");
    }

    function renderTips(tips, pitfalls, meta) {
      const pList = pitfalls && pitfalls.length ? pitfalls : null;
      const total = (meta && meta.total) || (pList ? pList.length : 0);
      setRailSectionTitle("tips", "避坑指南和住宿", pList ? pList.length : 0, total);
      if (pList) {
        $("tips").innerHTML = `
          <div class="pitfall-list">
            ${pList.map((p) => {
              const tag = railScopeLabel(p);
              return `
              <div class="pitfall-card">
                <div class="pit-line">⛔ 避坑${tag ? ` · ${escAttr(tag)}` : ""}：${escAttr(p.pit || "")}</div>
                <div class="why-line">原因：${escAttr(p.why || "")}</div>
                <div class="fix-line">✓ 解法：${escAttr(p.fix || "")}</div>
              </div>`;
            }).join("")}
          </div>`;
        return;
      }
      if (selectedDay != null) {
        $("tips").innerHTML = `<div class="empty">Day ${selectedDay} 暂无单独避坑，切回「全部」看全程</div>`;
        return;
      }
      if (!tips || !tips.length) {
        $("tips").innerHTML = '<div class="empty">暂无提示</div>';
        return;
      }
      $("tips").innerHTML = `<ul class="tips">${tips.map((t) => `<li>${escAttr(t)}</li>`).join("")}</ul>`;
    }

    function renderFitVerdict(fit) {
      const el = $("fitStrip");
      if (!el) return;
      // 封面第四句已承担「必知」，这条缝留给按天，不再摊开适合谁
      el.classList.add("hidden");
      el.setAttribute("aria-hidden", "true");
      if (!fit || (!fit.best_for && !fit.skip_if)) {
        el.innerHTML = "";
        return;
      }
      el.innerHTML = `
        <div class="fit-cell">
          <span class="fit-dot ok">✓</span>
          <div><strong>适合谁：</strong>${fit.best_for || ""}</div>
        </div>
        <div class="fit-cell">
          <span class="fit-dot warn">!</span>
          <div><strong>慎选提示：</strong>${fit.skip_if || ""}</div>
        </div>
        ${fit.season_tip ? `<div class="fit-season">🌤 <strong>行前气候与错峰叮嘱：</strong>${fit.season_tip}</div>` : ""}`;
    }

    function openXhsSearch(item) {
      if (window.PlatformBridge) {
        window.PlatformBridge.openXiaohongshu(
          item,
          (lastTrip && lastTrip.destination) || "",
          setStatus
        );
        return;
      }
      const city = item.district || item.city || (lastTrip && lastTrip.destination) || "";
      const kw = `${city} ${item.title || ""} ${item.type === "food" ? "必点 避坑" : "机位 攻略"}`.trim();
      window.open(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`, "_blank");
    }

    function openDayFullRoute(dayNum) {
      const day = (lastTrip && (lastTrip.days_plan || []).find((d) => d.day === dayNum)) || null;
      if (!day) return;
      if (window.PlatformBridge) {
        window.PlatformBridge.openRouteNavigation(
          day,
          (lastTrip && lastTrip.destination) || "",
          setStatus
        );
        return;
      }
    }

    let budgetPax = 2;
    let budgetEnergy = "oil";
    let checklistCat = "all";
    let checkedIds = new Set();

    function recomputeBudgetClient(budget) {
      return window.RoadbookCore.recomputeBudget(budget, lastTrip, {
        pax: budgetPax,
        energy: budgetEnergy,
      });
    }

    function renderBudget(rawBudget) {
      const box = $("budgetBox");
      if (!rawBudget) {
        box.innerHTML = '<div class="empty">暂无预算</div>';
        return;
      }
      const b = recomputeBudgetClient(rawBudget);
      if ($("statBudget")) {
        $("statBudget").textContent = `¥${b.perPerson}/人`;
      }
      // 计算水位条坐标（以 bMax * 1.4 为满刻度）
      const scaleMax = Math.max(b.bMax * 1.35, b.perPerson * 1.15, 2000);
      const zoneLeft = Math.min(92, Math.round((b.bMin / scaleMax) * 100));
      const zoneWidth = Math.max(6, Math.min(96 - zoneLeft, Math.round(((b.bMax - b.bMin) / scaleMax) * 100)));
      const markerPos = Math.max(3, Math.min(97, Math.round((b.perPerson / scaleMax) * 100)));

      box.innerHTML = `
        <div class="budget-hero-card">
          <div class="budget-hero-grid">
            <div>
              <div class="budget-hero-k">${b.level_label || "品质舒适"} · ${b.pax} 人同车人均</div>
              <div class="budget-hero-v">¥${b.perPerson.toLocaleString()}<small>/人</small></div>
            </div>
            <div class="budget-hero-right">
              <div>整车合计 <strong>¥${b.total.toLocaleString()}</strong></div>
              <div>日均约 <strong>¥${b.dailyPerPerson}/人·天</strong></div>
            </div>
          </div>
          <div class="budget-gauge">
            <div class="gauge-head">
              <span>目标区间 ¥${b.bMin.toLocaleString()} ~ ¥${b.bMax.toLocaleString()}/人</span>
              <span class="gauge-pill ${b.status}">${b.status === "fit" ? "✓ " : b.status === "over" ? "⚠ " : "★ "}${b.statusLabel}</span>
            </div>
            <div class="gauge-bar">
              <div class="gauge-zone" style="left:${zoneLeft}%;width:${zoneWidth}%"></div>
              <div class="gauge-marker" style="left:${markerPos}%" title="当前人均 ¥${b.perPerson}"></div>
            </div>
          </div>
        </div>

        <div class="budget-controls-bar">
          <div class="mini-seg">
            ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${budgetPax === n ? "active" : ""}" data-pax="${n}">${n}人分摊</button>`).join("")}
          </div>
          <div class="mini-seg">
            <button type="button" class="${budgetEnergy === "oil" ? "active" : ""}" data-energy="oil">⛽ 油车</button>
            <button type="button" class="${budgetEnergy === "ev" ? "active" : ""}" data-energy="ev">⚡ 电车(-65%)</button>
          </div>
        </div>

        <div class="stacked-bar" title="五项费用占比">
          ${(b.items || []).map((it) => `<div class="stacked-seg" style="width:${Math.max(4, it.pct || 0)}%;background:${it.color || "#0b6594"}"></div>`).join("")}
        </div>

        <div class="budget-item-list">
          ${(b.items || []).map((it) => `
            <div class="budget-item-card">
              <div class="budget-item-top">
                <span><i class="budget-dot" style="background:${it.color || "#0b6594"}"></i>${it.label} <small style="font-weight:500;color:var(--md-on-surface-variant)">(${it.pct || 0}%)</small></span>
                <span>¥${(it.amount || 0).toLocaleString()} <small style="font-weight:500;color:var(--md-on-surface-variant)">(¥${Math.round((it.amount || 0) / b.pax)}/人)</small></span>
              </div>
              ${it.formula ? `<div class="budget-formula">算式：${it.formula}</div>` : ""}
              ${it.tip ? `<div class="budget-item-tip">💡 ${it.tip}</div>` : ""}
            </div>`).join("")}
        </div>
        ${b.saving_tip ? `<div class="budget-saving-box"><strong>💰 预算师建议：</strong>${b.saving_tip}</div>` : ""}`;

      box.querySelectorAll("[data-pax]").forEach((btn) => {
        btn.addEventListener("click", () => {
          budgetPax = Number(btn.dataset.pax);
          renderBudget(lastTrip && lastTrip.budget);
          if (lastTrip) renderFirstGlance(lastTrip);
          persistTripEdits();
        });
      });
      box.querySelectorAll("[data-energy]").forEach((btn) => {
        btn.addEventListener("click", () => {
          budgetEnergy = btn.dataset.energy;
          renderBudget(lastTrip && lastTrip.budget);
          if (lastTrip) renderFirstGlance(lastTrip);
          persistTripEdits();
        });
      });
    }

    let preTripExpanded = false;

    function updatePreTripReadinessBar(list) {
      const bar = $("preTripBar");
      if (!bar) return;
      if (!list || !list.length) {
        bar.classList.add("hidden");
        bar.setAttribute("aria-hidden", "true");
        return;
      }
      bar.classList.remove("hidden");
      bar.setAttribute("aria-hidden", "false");
      const done = list.filter((i) => checkedIds.has(i.id)).length;
      const total = list.length;
      const pct = Math.round((done / total) * 100);
      const badge = $("preTripBadge");
      const pending = $("preTripPending");
      const fill = $("preTripFill");
      const arrow = $("preTripArrow");
      const toggle = $("preTripToggle");
      const drawer = $("preTripDrawer");
      if (badge) {
        badge.textContent = `🎒 行前必查 ${done}/${total}`;
        badge.classList.toggle("all-done", done === total && total > 0);
      }
      if (pending) {
        if (done === total) pending.textContent = "行前事项都勾完了";
        else {
          const left = list.filter((i) => !checkedIds.has(i.id)).slice(0, 2).map((i) => i.text);
          pending.textContent = left.length ? `还差：${left.join("、")}` : "点击展开核对驾驶证、胎压与必带物品";
        }
      }
      if (fill) fill.style.width = `${pct}%`;
      if (arrow) arrow.textContent = preTripExpanded ? "收起 ▴" : "展开核对 ▾";
      if (drawer) drawer.classList.toggle("hidden", !preTripExpanded);
      if (toggle) {
        toggle.tabIndex = 0;
        toggle.setAttribute("role", "button");
        toggle.setAttribute("aria-expanded", preTripExpanded ? "true" : "false");
      }
    }

    function renderChecklistInto(container, list, suffix) {
      if (!container) return;
      if (!list || !list.length) {
        container.innerHTML = '<div class="empty">暂无清单</div>';
        return;
      }
      const groupIcons = {
        证件: "🪪 必带证件 & 支付",
        车辆: "🚗 车辆安全检查",
        安全: "🛡 长途行车安全",
        装备: "🔌 随车数码 & 装备",
        天气: "🧥 天气穿衣 & 防护",
        健康: "💊 随车医药 & 应急",
        住宿: "🛏 沿途住宿预订",
        自定义: "✨ 我的自定义物品",
      };
      const grouped = new Map();
      list.forEach((it) => {
        const g = it.group || "其他";
        if (!grouped.has(g)) grouped.set(g, []);
        grouped.get(g).push(it);
      });
      const doneCount = list.filter((i) => checkedIds.has(i.id)).length;
      const pct = Math.round((doneCount / list.length) * 100);
      const allDone = doneCount === list.length;

      const groupsHtml = [...grouped.entries()]
        .map(([g, items]) => {
          const gDone = items.filter((i) => checkedIds.has(i.id)).length;
          return `
            <div class="bento-group">
              <div class="bento-group-title">
                <span>${groupIcons[g] || `📦 ${g}`}</span>
                <span>${gDone}/${items.length}</span>
              </div>
              <div class="bento-grid">
                ${items
                  .map((it) => {
                    const done = checkedIds.has(it.id);
                    return `
                      <button type="button" class="bento-tile ${done ? "done" : ""}" data-check-tile="${escAttr(it.id)}">
                        <span class="bento-ring">✓</span>
                        <span class="bento-text">${it.text}</span>
                      </button>`;
                  })
                  .join("")}
              </div>
            </div>`;
        })
        .join("");

      container.innerHTML = `
        <div class="bento-check-hero">
          <div class="bento-check-meta" style="flex:1">
            <strong>出发前点按核对 · 已就绪 ${doneCount}/${list.length}（${pct}%）</strong>
            <span>点一下磁贴即可打勾，进度自动保存在本机</span>
            <div class="check-prog-track"><div class="check-prog-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="bento-check-actions">
            <button type="button" class="bento-mini-btn" data-check-toggle-all="${suffix}">${allDone ? "重置" : "全选"}</button>
          </div>
        </div>
        ${groupsHtml}
        <button type="button" class="bento-add-trigger" data-open-custom="${suffix}">＋ 加一项随车物品（如：无人机、保温杯）</button>
        <div class="check-add-row" data-custom-row="${suffix}">
          <input data-custom-input="${suffix}" placeholder="输入物品名称，回车添加…" />
          <button type="button" data-custom-add="${suffix}">添加</button>
        </div>`;

      container.querySelectorAll("[data-check-tile]").forEach((tile) => {
        tile.addEventListener("click", () => {
          const id = tile.dataset.checkTile;
          if (checkedIds.has(id)) checkedIds.delete(id);
          else checkedIds.add(id);
          persistTripEdits();
          renderChecklist(lastTrip && lastTrip.checklist);
        });
      });
      container.querySelector(`[data-check-toggle-all="${suffix}"]`)?.addEventListener("click", () => {
        if (allDone) checkedIds.clear();
        else list.forEach((i) => checkedIds.add(i.id));
        persistTripEdits();
        renderChecklist(lastTrip && lastTrip.checklist);
      });
      const rowEl = container.querySelector(`[data-custom-row="${suffix}"]`);
      const inputEl = container.querySelector(`[data-custom-input="${suffix}"]`);
      container.querySelector(`[data-open-custom="${suffix}"]`)?.addEventListener("click", () => {
        rowEl?.classList.toggle("open");
        inputEl?.focus();
      });
      const addCustom = () => {
        const val = (inputEl?.value || "").trim();
        if (!val || !lastTrip) return;
        const id = `custom-${Date.now()}`;
        lastTrip.checklist = [...(lastTrip.checklist || []), { id, text: val, group: "自定义" }];
        checkedIds.add(id);
        persistTripEdits();
        renderChecklist(lastTrip.checklist);
      };
      container.querySelector(`[data-custom-add="${suffix}"]`)?.addEventListener("click", addCustom);
      inputEl?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addCustom();
      });
    }

    function renderChecklist(list) {
      updatePreTripReadinessBar(list);
      // 主入口：地图下方行前条；侧栏副本隐藏避免双入口
      const rail = $("checklistBox");
      if (rail) {
        rail.innerHTML = "";
        const panel = rail.closest("section.panel");
        if (panel) {
          panel.classList.add("hidden");
          panel.setAttribute("aria-hidden", "true");
        }
      }
      renderChecklistInto($("checklistTopBox"), list || [], "top");
    }

    function findDayStop(dayNum, stopId) {
      const day = (lastTrip.days_plan || []).find((d) => d.day === dayNum);
      if (!day) return null;
      const idx = (day.items || []).findIndex((it) => (it.id || "") === stopId);
      return { day, idx, item: idx >= 0 ? day.items[idx] : null };
    }

    function openNav(item) {
      if (window.PlatformBridge) {
        window.PlatformBridge.openNavigation(item, setStatus);
        return;
      }
      const name = encodeURIComponent(item.title || "");
      if (item.location) {
        window.open(`https://uri.amap.com/marker?position=${encodeURIComponent(item.location)}&name=${name}`, "_blank");
      } else if (item.place) {
        window.open(`https://uri.amap.com/search?keyword=${encodeURIComponent(item.place)}`, "_blank");
      }
    }

    function copyPlace(item) {
      const text = [item.title, item.place, item.location].filter(Boolean).join(" · ");
      if (window.PlatformBridge) {
        window.PlatformBridge.copyText(text, setStatus);
        return;
      }
      navigator.clipboard?.writeText(text).then(() => setStatus("已复制地址")).catch(() => setStatus(text));
    }

    function swapStop(dayNum, stopId) {
      if (!lastTrip || !window.RoadbookCore) return;
      const next = window.RoadbookCore.swapStopInTrip(lastTrip, dayNum, stopId);
      if (!next) { setStatus("当前城市备选库暂无更多站点"); return; }
      persistTripEdits();
      renderDays(lastTrip);
      setStatus(`已在本城换成：${next.name}`);
    }

    function removeStop(dayNum, stopId) {
      const hit = findDayStop(dayNum, stopId);
      if (!hit || hit.idx < 0) return;
      hit.day.items.splice(hit.idx, 1);
      persistTripEdits();
      const y = window.scrollY;
      renderDays(lastTrip);
      window.scrollTo(0, y);
    }

    function toggleDone(dayNum, stopId) {
      const hit = findDayStop(dayNum, stopId);
      if (!hit || !hit.item) return;
      hit.item.done = !hit.item.done;
      persistTripEdits();
      renderDays(lastTrip);
    }

    function poolTagText(raw) {
      return String(raw || "").replace(/^#/, "").trim();
    }

    function poolRowMeta(p) {
      const tags = (p.human_tags || []).map(poolTagText).filter(Boolean);
      const isLimit = (t) => /预约|免门票/.test(t);
      const isReason = (t) => /人文|轻松|日落|夜景|宝藏|出片|扎堆|老字号|烟火/.test(t);
      const reason = tags.find(isReason) || tags.find((t) => !isLimit(t)) || "";
      const limit = tags.find((t) => t !== reason && isLimit(t)) || "";
      const bits = [];
      if (reason) bits.push(reason);
      if (limit) bits.push(limit);
      const hours = Number(p.stay_hours);
      if (Number.isFinite(hours) && hours > 0) {
        const hourText = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 10) / 10);
        bits.push(`约 ${hourText} 小时`);
      }
      if (p.district) bits.push(p.district);
      else if (p.tag) bits.push(String(p.tag).split(/[;；]/)[0]);
      return bits.join(" · ");
    }

    function poolQueryHit(p, query) {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return true;
      const hay = [p.name, p.district, p.tag, ...(p.human_tags || [])].join(" ").toLowerCase();
      return hay.includes(q);
    }

    function poolThumbHtml(p) {
      const src = normalizeImageUrl(p && (p.image || p.list_image));
      if (!src) return "";
      return `<img class="stop-pool-thumb" src="${escAttr(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" decoding="async" onerror="this.remove()" />`;
    }

    function poolPickerHtml(day, trip) {
      if (isShareView() || !day) return "";
      const open = poolPickerDay === day.day;
      const source = trip || lastTrip;
      const list = open && window.RoadbookCore
        ? window.RoadbookCore.candidatesForDay(source, day.day)
        : [];
      const cityRaw = day.stay_city || day.to_city || (source && source.destination) || "";
      const city = window.RoadbookCore
        ? window.RoadbookCore.cleanCityName(cityRaw)
        : String(cityRaw).replace(/(?:市|省)$/, "");
      const shown = list.filter((p) => poolQueryHit(p, poolFilterQuery));
      const rows = shown.map((p) => {
        const idx = list.indexOf(p);
        const meta = poolRowMeta(p);
        return `<button type="button" class="stop-pool-item" data-day="${day.day}" data-pool-idx="${idx}">
          ${poolThumbHtml(p)}
          <span class="stop-pool-copy">
            <strong>${escAttr(p.name)}</strong>
            ${meta ? `<span>${escAttr(meta)}</span>` : ""}
          </span>
        </button>`;
      }).join("");
      const emptyText = list.length
        ? "没有匹配的站点"
        : "这座城的备选已经都在行程里了";
      const filter = list.length
        ? `<input class="stop-pool-filter" data-day="${day.day}" type="search" enterkeyhint="search" placeholder="只找今天${escAttr(city || "这座城")}还没排上的" value="${escAttr(poolFilterQuery)}" />`
        : "";
      const panel = open
        ? `<div class="stop-pool">
            ${filter}
            ${rows || `<p class="stop-pool-empty">${emptyText}</p>`}
          </div>`
        : "";
      return `<div class="add-stop-wrap">
        <button type="button" class="add-stop" data-day="${day.day}" aria-expanded="${open ? "true" : "false"}">${open ? "收起备选" : "＋ 从备选库选一站"}</button>
        ${panel}
      </div>`;
    }

    function syncPoolDock() {
      document.body.classList.toggle("pool-open", poolPickerDay != null);
    }

    function toggleStopPool(dayNum) {
      poolFilterQuery = "";
      poolPickerDay = poolPickerDay === dayNum ? null : dayNum;
      syncPoolDock();
      const y = window.scrollY;
      renderDays(lastTrip);
      window.scrollTo(0, y);
    }

    function onPoolFilterInput(dayNum, value) {
      if (poolPickerDay !== dayNum) return;
      poolFilterQuery = value;
      const y = window.scrollY;
      renderDays(lastTrip);
      window.scrollTo(0, y);
      const input = $("daysList")?.querySelector(`.stop-pool-filter[data-day="${dayNum}"]`);
      if (input) {
        input.focus();
        const pos = input.value.length;
        try { input.setSelectionRange(pos, pos); } catch (e) {}
      }
    }

    function addStopFromPool(dayNum, poolIdx) {
      const day = (lastTrip.days_plan || []).find((d) => d.day === dayNum);
      if (!day || !window.RoadbookCore) return;
      const list = window.RoadbookCore.candidatesForDay(lastTrip, dayNum);
      const next = list[poolIdx];
      if (!next) {
        setStatus("这座城的备选已经都在行程里了");
        return;
      }
      day.items = day.items || [];
      day.items.push({
        time: "16:00",
        type: "sight",
        priority: "optional",
        user_added: true,
        title: next.name,
        place: next.address || day.stay_city || lastTrip.destination,
        district: next.district || "",
        is_county: !!next.is_county,
        human_tags: next.human_tags || [],
        detail: `弹性顺路站（建议预留 ${next.stay_hours || 2} 小时）`,
        image: next.image || "",
        location: next.location || "",
        rating: next.rating || "",
        cost: next.cost || "",
        tag: next.tag || "",
        stay_hours: next.stay_hours || 2,
        id: `sight-${next.location || next.name}`,
      });
      poolPickerDay = null;
      poolFilterQuery = "";
      syncPoolDock();
      persistTripEdits();
      const y = window.scrollY;
      renderDays(lastTrip);
      window.scrollTo(0, y);
      setStatus(`已加上「${next.name}」，标成可选。晚点可以先砍这一站。`);
    }

    function bindStopActions(root) {
      if (!root) return;
      root.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (isShareView() && (act === "swap" || act === "remove" || act === "remove-free")) return;
          if (act === "remove-free") {
            const freeEl = btn.closest(".free-slot");
            if (freeEl) removeStop(Number(freeEl.dataset.day), freeEl.dataset.stopId);
            return;
          }
          const card = btn.closest(".stop-card");
          if (!card || !lastTrip) return;
          const dayNum = Number(card.dataset.day);
          const stopId = card.dataset.stopId;
          const hit = findDayStop(dayNum, stopId);
          if (act === "nav" && hit?.item) openNav(hit.item);
          else if (act === "xhs" && hit?.item) openXhsSearch(hit.item);
          else if (act === "copy" && hit?.item) copyPlace(hit.item);
          else if (act === "swap") swapStop(dayNum, stopId);
          else if (act === "remove") removeStop(dayNum, stopId);
          else if (act === "done") toggleDone(dayNum, stopId);
        });
      });
      root.querySelectorAll("[data-day-nav]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          openDayFullRoute(Number(btn.dataset.dayNav));
        });
      });
      root.querySelectorAll("[data-day-chat]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const dNum = Number(btn.dataset.dayChat);
          openDockConversation(`Day ${dNum} 换成`);
        });
      });
      root.querySelectorAll(".add-stop").forEach((btn) => {
        btn.addEventListener("click", () => toggleStopPool(Number(btn.dataset.day)));
      });
      root.querySelectorAll(".stop-pool-item").forEach((btn) => {
        btn.addEventListener("click", () => addStopFromPool(Number(btn.dataset.day), Number(btn.dataset.poolIdx)));
      });
      root.querySelectorAll(".stop-pool-filter").forEach((input) => {
        input.addEventListener("input", () => onPoolFilterInput(Number(input.dataset.day), input.value));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") e.preventDefault();
        });
      });
    }

    const HISTORY_KEY = "roadbook_v1_history";
    const EDIT_KEY = "roadbook_v1_edits";

    function loadHistory() {
      try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; }
    }

    function saveHistory(trip) {
      if (!trip) return;
      const list = loadHistory().filter((t) => !(t.origin === trip.origin && t.destination === trip.destination && t.days === trip.days && JSON.stringify(t.prefs) === JSON.stringify(trip.prefs)));
      list.unshift({ ...trip, saved_at: Date.now() });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 10)));
      renderHistoryList();
    }

    function persistTripEdits() {
      if (isShareView() || !lastTrip) return;
      try {
        localStorage.setItem(EDIT_KEY, JSON.stringify({
          trip: lastTrip,
          checked: [...checkedIds],
          budgetPax,
          saved_at: Date.now(),
        }));
      } catch (_) {}
    }

    function renderHistoryList() {
      const list = loadHistory();
      const el = $("historyList");
      if (!list.length) {
        el.innerHTML = '<div class="empty">暂无收藏，生成后点「收藏」即可</div>';
        return;
      }
      el.innerHTML = list.map((t, i) => `
        <div class="history-item" data-hist="${i}">
          <div>
            <strong>${t.title || `${t.origin} → ${t.destination}`}</strong>
            <span>${t.days} 天 · ${t.distance || ""} · ${new Date(t.saved_at || Date.now()).toLocaleDateString()}</span>
          </div>
          <button type="button" class="ghost-btn" data-load="${i}">打开</button>
        </div>`).join("");
      el.querySelectorAll("[data-load]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const trip = loadHistory()[Number(btn.dataset.load)];
          if (!trip) return;
          checkedIds = new Set();
          applyItinerary(trip);
          restoreChecklistCheckedForTrip(trip);
          renderChecklist(lastTrip && lastTrip.checklist);
          $("result").classList.remove("hidden");
          $("historyDrawer").classList.remove("open");
          collapsePlanForm(trip, { scroll: true });
          setStatus("已从历史路书夹打开");
        });
      });
    }

    let userTouchedRange = false;

    function refreshFormBudgetByContext(forceReset, opts = {}) {
      if (!window.RoadbookCore) return;
      if (forceReset) userTouchedRange = false;
      const keepBudgetRange = !!opts.keepBudgetRange;
      const level = document.querySelector('.pref-row[data-pref="budget_level"] .pref-chip.active')?.dataset.value || "comfort";
      const days = Number($("days")?.value || 7);
      const pax = Number(document.querySelector("#formPaxSeg button.active")?.dataset.formPax || budgetPax || 2);
      const energy = document.querySelector("#formEnergySeg button.active")?.dataset.formEnergy || budgetEnergy || "oil";
      const highway = document.querySelector('.pref-row[data-pref="highway"] .pref-chip.active')?.dataset.value || "express";
      const est = window.RoadbookCore.estimateFormBudgetRange({ level, days, pax, energy, highway });
      if ($("budgetTierBreakdown")) {
        $("budgetTierBreakdown").textContent = `标准：${est.tierDesc}（日均吃住玩 ¥${est.dailyMin}~${est.dailyMax}/人·天 + ${days}天跨城油电过路费分摊约 ¥${est.rigidPp}/人）`;
      }
      if (!userTouchedRange && !keepBudgetRange) {
        syncBudgetRangeUI(est.totalMin, est.totalMax);
      }
    }

    function syncBudgetRangeUI(bMin, bMax) {
      let minV = Math.max(500, Number(bMin || $("budgetMinInput")?.value || 3000));
      let maxV = Math.max(800, Number(bMax || $("budgetMaxInput")?.value || 5500));
      if (maxV < minV + 300) maxV = minV + 300;
      if ($("budgetMinInput")) $("budgetMinInput").value = minV;
      if ($("budgetMaxInput")) $("budgetMaxInput").value = maxV;
      if ($("budgetMinRange")) $("budgetMinRange").value = Math.min(12000, minV);
      if ($("budgetMaxRange")) $("budgetMaxRange").value = Math.min(18000, maxV);
      if ($("bMinLbl")) $("bMinLbl").textContent = `¥${minV}`;
      if ($("bMaxLbl")) $("bMaxLbl").textContent = `¥${maxV}`;
      if ($("budgetRangeText")) $("budgetRangeText").textContent = `¥${minV.toLocaleString()} ~ ¥${maxV.toLocaleString()} / 人`;
    }

    function setPrefChip(name, value) {
      if (!value) return;
      const row = document.querySelector(`.pref-row[data-pref="${name}"]`);
      if (!row) return;
      row.querySelectorAll(".pref-chip").forEach((c) => {
        c.classList.toggle("active", c.dataset.value === value);
      });
    }

    function syncFormFromTrip(trip) {
      if (!trip) return;
      if (trip.origin != null) $("origin").value = trip.origin;
      if (trip.destination != null) $("destination").value = trip.destination;
      if (trip.days != null) $("days").value = trip.days;
      if (trip.start_date) $("startDate").value = trip.start_date;
      const p = trip.prefs || {};
      setPrefChip("pace", p.pace);
      setPrefChip("theme", p.theme);
      setPrefChip("budget_level", p.budget_level);
      setPrefChip("highway", p.highway);
      setPrefChip("travel_mode", p.travel_mode || "drive");
      if (p.pax) {
        document.querySelectorAll("#formPaxSeg button").forEach((b) => {
          b.classList.toggle("active", Number(b.dataset.formPax) === Number(p.pax));
        });
        budgetPax = Number(p.pax);
      }
      if (p.energy_type) {
        document.querySelectorAll("#formEnergySeg button").forEach((b) => {
          b.classList.toggle("active", b.dataset.formEnergy === p.energy_type);
        });
        budgetEnergy = p.energy_type;
      }
      const hasTripBudget =
        trip.budget && trip.budget.budget_min != null && trip.budget.budget_max != null;
      if (hasTripBudget) {
        syncBudgetRangeUI(trip.budget.budget_min, trip.budget.budget_max);
      } else if (p.budget_min != null && p.budget_max != null) {
        syncBudgetRangeUI(p.budget_min, p.budget_max);
      }
      refreshFormBudgetByContext(false, { keepBudgetRange: hasTripBudget || (p.budget_min != null && p.budget_max != null) });
      syncQueryFromPrefs();
    }

    function tripFingerprint(trip) {
      if (!trip) return "";
      const p = trip.prefs || {};
      return [
        trip.origin || "",
        trip.destination || "",
        String(trip.days || ""),
        p.pace || "",
        p.theme || "",
        p.budget_level || "",
        p.highway || "",
        String(p.pax || ""),
        p.energy_type || "",
        p.travel_mode || "drive",
      ].join("|");
    }

    function loadPersistedEdits() {
      try {
        const raw = localStorage.getItem(EDIT_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    /** 同一路书指纹下恢复清单勾选（历史打开 / 服务端更新后） */
    function restoreChecklistCheckedForTrip(trip) {
      const saved = loadPersistedEdits();
      if (!saved || !trip || tripFingerprint(saved.trip) !== tripFingerprint(trip)) return;
      if (!Array.isArray(saved.checked)) return;
      const valid = new Set((trip.checklist || []).map((i) => i.id));
      saved.checked.forEach((id) => {
        if (valid.has(id)) checkedIds.add(id);
      });
    }

    function tryRestoreSessionFromEdits() {
      const saved = loadPersistedEdits();
      if (!saved?.trip?.days_plan?.length) return false;
      checkedIds = new Set(Array.isArray(saved.checked) ? saved.checked : []);
      mergeChecklistChecked(saved.trip);
      applyItinerary(saved.trip);
      $("result")?.classList.remove("hidden");
      collapsePlanForm(saved.trip, { scroll: false });
      setStatus(saved.from_share ? "已复制好友路书到本机，可直接修改（不影响原分享）" : "已恢复本机上次的编辑进度");
      return true;
    }

    function mergeChecklistChecked(trip) {
      const valid = new Set((trip.checklist || []).map((i) => i.id));
      checkedIds = new Set([...checkedIds].filter((id) => valid.has(id)));
    }

    function applyTripUpdate(data, opts = {}) {
      if (isStaleMutation(opts.epoch)) return;
      const nextTrip = data.trip;
      if (!nextTrip) return;
      if (data.chat_log) nextTrip.chat_log = data.chat_log;
      mergeChecklistChecked(nextTrip);
      restoreChecklistCheckedForTrip(nextTrip);
      syncFormFromTrip(nextTrip);
      poolPickerDay = null;
      poolFilterQuery = "";
      if (data.focus_day) selectedDay = null;
      else if (!opts.preserveDayFilter) selectedDay = null;
      const scrollY = opts.preserveScroll ? window.scrollY : null;
      applyItinerary(nextTrip, { skipFormSync: true });
      if (scrollY != null) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => window.scrollTo(0, scrollY));
        });
      }
      if (opts.saveHistory !== false) saveHistory(nextTrip);
      setStatus(data.reply || "已更新路书");
      if (data.focus_day) {
        const focusEpoch = opts.epoch;
        setTimeout(() => {
          if (isStaleMutation(focusEpoch) || editSheetOpen()) return;
          focusAndFlashDay(data.focus_day);
        }, 80);
      }
    }

    let viaReorderBusy = false;
    let viaClickSuppressUntil = 0;

    function readMidOrderFromLane(lane) {
      return [...lane.querySelectorAll(".via-mid-item")].map((n) => n.dataset.viaMid);
    }

    function clearViaTextSelection() {
      try {
        const sel = window.getSelection?.();
        if (sel && sel.rangeCount) sel.removeAllRanges();
      } catch (_) {}
    }

    function initViaPointerSort(laneEl) {
      if (!laneEl) return;
      const scrollEl = laneEl.closest(".via-route-scroll");
      const routeEl = laneEl.closest(".via-route");
      const items = () => [...laneEl.querySelectorAll(".via-mid-item")];
      const LONG_PRESS_MS = 320;

      if (routeEl && routeEl.dataset.viaGestureGuard !== "1") {
        routeEl.dataset.viaGestureGuard = "1";
        routeEl.addEventListener("selectstart", (e) => {
          if (e.target.closest(".via-mid-lane")) e.preventDefault();
        });
        routeEl.addEventListener("contextmenu", (e) => {
          if (e.target.closest(".via-mid-item")) e.preventDefault();
        });
      }

      /*
       * RecyclerView / ItemTouchHelper 式排序：
       * - 触屏长按卡片（或直接按住 ≡）抬起；鼠标按下卡片后移动超过阈值即抬起
       * - 拖动期间 DOM 不变：被拖项 translateX 跟手，其余项 transform 让位
       *   （移动 DOM 会释放 pointer capture，导致事件丢失）
       * - 靠近两端自动横向滚动；松手 FLIP 落位后再提交服务端
       */
      let gesture = null;

      const resetGestureUi = () => {
        document.body.classList.remove("via-no-select", "via-sort-active");
        scrollEl?.classList.remove("is-sorting");
        laneEl.classList.remove("is-sorting");
        clearViaTextSelection();
      };

      const stopAutoScroll = (g) => {
        if (g && g.autoRaf) {
          cancelAnimationFrame(g.autoRaf);
          g.autoRaf = 0;
        }
      };

      const layoutDrag = (g) => {
        const scrollDelta = (scrollEl ? scrollEl.scrollLeft : 0) - g.startScroll;
        let dx = g.lastX - g.startX + scrollDelta;
        dx = Math.max(g.minDx, Math.min(g.maxDx, dx));
        let target = g.from;
        if (dx > 0) {
          const leadEdge = g.rights[g.from] + dx;
          for (let i = g.from + 1; i < g.centers.length && leadEdge > g.centers[i]; i++) target = i;
        } else if (dx < 0) {
          const leadEdge = g.lefts[g.from] + dx;
          for (let i = g.from - 1; i >= 0 && leadEdge < g.centers[i]; i--) target = i;
        }
        g.target = target;
        g.node.style.transform = `translate3d(${dx}px, 0, 0)`;
        g.items.forEach((el, i) => {
          if (i === g.from) return;
          let shift = 0;
          if (g.from < target && i > g.from && i <= target) shift = -g.slot;
          else if (target < g.from && i >= target && i < g.from) shift = g.slot;
          el.style.transform = shift ? `translate3d(${shift}px, 0, 0)` : "";
        });
      };

      const autoScrollTick = () => {
        const g = gesture;
        if (!g || g.phase !== "drag" || !scrollEl) return;
        const r = scrollEl.getBoundingClientRect();
        const EDGE = 44;
        let v = 0;
        if (g.lastX < r.left + EDGE) v = -Math.ceil((r.left + EDGE - g.lastX) / 4);
        else if (g.lastX > r.right - EDGE) v = Math.ceil((g.lastX - (r.right - EDGE)) / 4);
        if (v) {
          const before = scrollEl.scrollLeft;
          scrollEl.scrollLeft = before + v;
          if (scrollEl.scrollLeft !== before) layoutDrag(g);
        }
        g.autoRaf = requestAnimationFrame(autoScrollTick);
      };

      const beginDrag = (g) => {
        const blocked = tripMutationBlockedReason();
        if (blocked || viaReorderBusy) {
          setStatus(blocked || "正在重排途经…");
          endGesture(false);
          return;
        }
        g.items = items();
        g.from = g.items.indexOf(g.node);
        if (g.from < 0 || g.items.length < 2) {
          endGesture(false);
          return;
        }
        const rects = g.items.map((el) => el.getBoundingClientRect());
        const gap = Math.max(0, rects[1].left - rects[0].right);
        g.centers = rects.map((r) => r.left + r.width / 2);
        g.lefts = rects.map((r) => r.left);
        g.rights = rects.map((r) => r.right);
        g.slot = rects[g.from].width + gap;
        g.minDx = rects[0].left - rects[g.from].left;
        g.maxDx = rects[rects.length - 1].right - rects[g.from].right;
        g.startScroll = scrollEl ? scrollEl.scrollLeft : 0;
        g.target = g.from;
        g.phase = "drag";
        g.node.classList.remove("is-holding");
        g.node.classList.add("is-dragging");
        laneEl.classList.add("is-sorting");
        scrollEl?.classList.add("is-sorting");
        document.body.classList.add("via-sort-active");
        if (g.pointerType !== "mouse") navigator.vibrate?.(12);
        layoutDrag(g);
        g.autoRaf = requestAnimationFrame(autoScrollTick);
      };

      const settleAndCommit = (g, commit) => {
        const from = g.from;
        const to = commit ? g.target : from;
        const firstRects = new Map(g.items.map((el) => [el, el.getBoundingClientRect()]));
        g.items.forEach((el) => {
          el.style.transition = "none";
          el.style.transform = "";
        });
        g.node.classList.remove("is-dragging");
        laneEl.classList.remove("is-sorting");
        if (to !== from) {
          const order = g.items.slice();
          const [moved] = order.splice(from, 1);
          order.splice(to, 0, moved);
          order.forEach((el) => laneEl.appendChild(el));
          order.forEach((el, i) => {
            const idxEl = el.querySelector(".via-node-dot");
            if (idxEl) idxEl.textContent = String(i + 1);
          });
          laneEl.classList.add("is-pending");
        }
        g.items.forEach((el) => {
          const a = firstRects.get(el);
          const b = el.getBoundingClientRect();
          const dx = a.left - b.left;
          if (Math.abs(dx) > 0.5) el.style.transform = `translate3d(${dx}px, 0, 0)`;
        });
        void laneEl.offsetWidth;
        g.items.forEach((el) => {
          el.style.transition = "transform 220ms cubic-bezier(.2,.8,.2,1)";
          el.style.transform = "";
        });
        setTimeout(() => {
          g.items.forEach((el) => {
            el.style.transition = "";
            el.style.transform = "";
          });
        }, 240);
        if (to === from) return;
        const full = [...(lastTrip?.via_cities || [])];
        if (full.length < 2) return;
        commitViaReorder([full[0], ...readMidOrderFromLane(laneEl), full[full.length - 1]]);
      };

      function endGesture(commit) {
        const g = gesture;
        if (!g) return;
        gesture = null;
        clearTimeout(g.holdTimer);
        stopAutoScroll(g);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        g.node.classList.remove("is-holding");
        if (g.phase === "drag") {
          viaClickSuppressUntil = performance.now() + 400;
          settleAndCommit(g, commit);
        }
        resetGestureUi();
      }

      function onMove(ev) {
        const g = gesture;
        if (!g || ev.pointerId !== g.pointerId) return;
        g.lastX = ev.clientX;
        if (g.phase === "drag") {
          ev.preventDefault();
          layoutDrag(g);
          return;
        }
        const dx = ev.clientX - g.startX;
        const dy = ev.clientY - g.startY;
        if (g.pointerType === "mouse") {
          if (Math.hypot(dx, dy) > 5) beginDrag(g);
        } else if (Math.hypot(dx, dy) > 10) {
          endGesture(false);
        }
      }

      function onUp(ev) {
        if (!gesture || ev.pointerId !== gesture.pointerId) return;
        endGesture(true);
      }

      function onCancel(ev) {
        if (!gesture || ev.pointerId !== gesture.pointerId) return;
        endGesture(false);
      }

      laneEl.addEventListener("pointerdown", (ev) => {
        if (gesture) return;
        if (ev.pointerType === "mouse" && ev.button !== 0) return;
        if (ev.target.closest("[data-del-via], .via-leg-pill")) return;
        const node = ev.target.closest(".via-mid-item.is-sortable");
        if (!node || !laneEl.contains(node)) return;
        const onHandle = !!ev.target.closest("[data-via-handle]");
        const g = {
          node,
          pointerId: ev.pointerId,
          pointerType: ev.pointerType,
          startX: ev.clientX,
          startY: ev.clientY,
          lastX: ev.clientX,
          phase: "pending",
          holdTimer: 0,
          autoRaf: 0,
        };
        gesture = g;
        clearViaTextSelection();
        document.body.classList.add("via-no-select");
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
        if (ev.pointerType === "mouse") ev.preventDefault();
        if (onHandle) {
          beginDrag(g);
          return;
        }
        if (ev.pointerType !== "mouse") {
          node.classList.add("is-holding");
          g.holdTimer = setTimeout(() => {
            if (gesture === g && g.phase === "pending") beginDrag(g);
          }, LONG_PRESS_MS);
        }
      });

      laneEl.addEventListener(
        "touchmove",
        (ev) => {
          if (gesture && gesture.phase === "drag") ev.preventDefault();
        },
        { passive: false }
      );
    }

    function renderViaBar(trip) {
      const isHsr = !!(trip.hsr || (trip.prefs && trip.prefs.travel_mode === "hsr_rental"));
      const via = trip.via_cities || [];
      const vibes = trip.city_vibes || {};
      const el = $("via");
      if (!el) return;
      el.className = "via-route";
      if (isHsr && trip.origin && trip.destination) {
        el.className = "via-route is-hsr is-direct";
        el.innerHTML =
          `<div class="via-route-head">` +
          `<div class="via-route-head-copy">` +
          `<span class="via-route-title">高铁干线 · 当地游玩</span>` +
          `<span class="via-route-hint">${escAttr(trip.origin)} 乘高铁至 ${escAttr(trip.destination)}；下方日程为到站后租车，以目的地为中心游玩。</span>` +
          `</div></div>` +
          `<div class="via-route-scroll">` +
          `<div class="via-route-track via-hsr-track" role="list">` +
          `<div class="via-stop via-stop--origin" role="listitem"><span class="via-stop-dot"></span><span class="via-stop-label">出发</span><span class="via-stop-name">${escAttr(trip.origin)}</span></div>` +
          `<div class="via-hsr-leg" aria-hidden="true"><span class="via-hsr-leg-icon">🚄</span><span class="via-hsr-leg-text">高铁</span></div>` +
          `<div class="via-stop via-stop--dest" role="listitem"><span class="via-stop-dot"></span><span class="via-stop-label">抵达</span><span class="via-stop-name">${escAttr(trip.destination)}</span></div>` +
          `</div></div>`;
        return;
      }
      if (via.length < 2) {
        el.innerHTML = '<div class="via-route-empty">生成路书后在此调整沿途途经</div>';
        return;
      }
      const origin = via[0];
      const dest = via[via.length - 1];
      const mids = via.length > 2 ? via.slice(1, -1) : [];
      const canSort = !isShareView() && mids.length > 1;
      const days = trip.days_plan || [];
      const paceLimit = ({ relaxed: 450, balanced: 600, hardcore: 750 }[(trip.prefs || {}).pace] || 600) * 1.3;

      const legOf = (from, to) => {
        const d = days.find((x) => x.kind === "transit" && x.from_city === from && x.to_city === to);
        return d ? { day: d.day, km: Number(d.drive_km) || 0, h: Number(d.drive_hours) || 0 } : null;
      };
      const legHtml = (from, to, extraCls = "") => {
        const leg = legOf(from, to);
        if (!leg || !leg.km) {
          return `<div class="via-leg${extraCls}" aria-hidden="true"></div>`;
        }
        const long = leg.km > paceLimit;
        const label = `${Math.round(leg.km)} km${leg.h ? `<span class="via-leg-h"> · ${leg.h.toFixed(1)}h</span>` : ""}`;
        const tip = `DAY ${leg.day} ${from} → ${to}，约 ${Math.round(leg.km)} 公里${leg.h ? ` / ${leg.h.toFixed(1)} 小时` : ""}${long ? "，单日车程偏长" : ""}`;
        return (
          `<div class="via-leg${extraCls}${long ? " is-long" : ""}">` +
          `<button type="button" class="via-leg-pill" data-via-day="${leg.day}" title="${escAttr(tip)}" aria-label="${escAttr(tip)}">${label}</button>` +
          `</div>`
        );
      };

      const termNode = (city, kind, label, day) => `
        <div class="via-stop via-stop--${kind}" role="listitem"${day ? ` data-via-day="${day}"` : ""}>
          <span class="via-stop-dot" aria-hidden="true"></span>
          <span class="via-stop-label">${label}</span>
          <span class="via-stop-name">${escAttr(city)}</span>
        </div>`;

      const midNodes = mids
        .map((c, idx) => {
          const v = vibes[c];
          const prev = idx === 0 ? origin : mids[idx - 1];
          const arrive = legOf(prev, c);
          const tags = v && v.tags && v.tags[0] ? `<span class="via-mid-tags">${escAttr(v.tags[0])}</span>` : "";
          return (
            `<div class="via-mid-item${canSort ? " is-sortable" : ""}" role="listitem" data-via-mid="${escAttr(c)}" data-via-idx="${idx}">` +
            legHtml(prev, c) +
            `<div class="via-node">` +
            `<span class="via-node-dot" aria-hidden="true">${idx + 1}</span>` +
            `<div class="via-mid-chip" data-via-drag-surface${arrive ? ` data-via-day="${arrive.day}"` : ""}>` +
            (canSort
              ? `<span class="via-mid-handle" data-via-handle role="button" tabindex="0" aria-label="拖动 ${escAttr(c)}"></span>`
              : "") +
            `<span class="via-mid-name">${escAttr(c)}</span>${tags}` +
            `</div>` +
            (isShareView()
              ? ""
              : `<button type="button" class="via-mid-remove" data-del-via="${escAttr(c)}" aria-label="跳过 ${escAttr(c)}" title="跳过 ${escAttr(c)}">×</button>`) +
            `</div>` +
            `</div>`
          );
        })
        .join("");

      const lastFrom = mids.length ? mids[mids.length - 1] : origin;
      const destLeg = legOf(lastFrom, dest);
      const firstExplore = days.find((x) => x.kind !== "transit");
      const destDay = destLeg ? destLeg.day : firstExplore ? firstExplore.day : null;
      const hint = isShareView()
        ? "只读分享 · 点里程看当天"
        : !mids.length
          ? "直达路线 · 可在中途加一站"
          : canSort
            ? `${isCompactLayout() ? "长按" : "按住"}城市拖动排序 · 点里程看当天`
            : "点城市看当天 · × 跳过该城";

      el.className = `via-route${mids.length ? "" : " is-direct"}`;
      el.innerHTML =
        `<div class="via-route-head">` +
        `<div class="via-route-head-copy">` +
        `<span class="via-route-title">沿途途经${mids.length ? `<em class="via-route-count">${mids.length} 城</em>` : ""}</span>` +
        `<span class="via-route-hint">${hint}</span>` +
        `</div>` +
        (isShareView() ? "" : `<button type="button" class="via-add-btn" id="viaAddBtn">＋ 加途经城</button>`) +
        `</div>` +
        `<div class="via-route-scroll">` +
        `<div class="via-route-track" id="viaTrack" role="list">` +
        termNode(origin, "origin", "出发") +
        `<div class="via-mid-lane" id="viaMidLane">${midNodes}</div>` +
        legHtml(lastFrom, dest, " via-leg--last") +
        termNode(dest, "dest", "抵达", destDay) +
        `</div></div>`;

      el.querySelectorAll("[data-del-via]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const blocked = tripMutationBlockedReason();
          if (blocked || viaReorderBusy || el.querySelector(".via-mid-item.is-removing")) {
            setStatus(blocked || "正在更新途经，请稍候…");
            return;
          }
          btn.closest(".via-mid-item")?.classList.add("is-removing");
          el.classList.add("is-busy");
          sendChatEdit(`不去${btn.dataset.delVia}`, { noFocus: true });
        });
      });
      el.querySelectorAll("[data-via-day]").forEach((node) => {
        node.addEventListener("click", (e) => {
          if (performance.now() < viaClickSuppressUntil || el.classList.contains("is-busy")) return;
          e.stopPropagation();
          focusAndFlashDay(Number(node.dataset.viaDay));
        });
      });
      $("viaAddBtn")?.addEventListener("click", () => {
        openDockConversation("中间加个");
      });

      const scroller = el.querySelector(".via-route-scroll");
      if (scroller) {
        const syncEdges = () => {
          const max = scroller.scrollWidth - scroller.clientWidth;
          scroller.classList.toggle("fade-start", scroller.scrollLeft > 4);
          scroller.classList.toggle("fade-end", max - scroller.scrollLeft > 4);
        };
        scroller.addEventListener("scroll", syncEdges, { passive: true });
        requestAnimationFrame(syncEdges);
      }

      const lane = $("viaMidLane");
      if (lane && canSort) initViaPointerSort(lane);
    }

    async function commitViaReorder(viaCities) {
      const blocked = tripMutationBlockedReason();
      if (!lastTrip || viaReorderBusy || blocked) {
        if (blocked) setStatus(blocked);
        return;
      }
      const epoch = bumpMutationEpoch();
      viaReorderBusy = true;
      const tripSnapshot = JSON.parse(JSON.stringify(lastTrip));
      tripUndoStack.push(tripSnapshot);
      if (tripUndoStack.length > 6) tripUndoStack.shift();
      updateUndoButtons();
      setStatus("正在按新顺序重排途经…");
      try {
        const resp = await fetch("/api/via-reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip: tripSnapshot, via_cities: viaCities }),
        });
        const data = await resp.json();
        if (isStaleMutation(epoch)) return;
        if (!resp.ok || !data.ok || !data.trip) {
          throw new Error(data.message || "重排失败");
        }
        const log = [...(tripSnapshot.chat_log || [])];
        if (data.changes && data.changes.length) {
          log.push({ role: "bot", text: data.reply, changes: data.changes });
        }
        applyTripUpdate({ ...data, chat_log: log.slice(-16) }, {
          epoch,
          preserveScroll: true,
          preserveDayFilter: true,
          saveHistory: false,
        });
      } catch (err) {
        if (!isStaleMutation(epoch)) {
          tripUndoStack.pop();
          updateUndoButtons();
          if (lastTrip) renderViaBar(lastTrip);
          setStatus(`重排失败：${err.message || err}`);
        }
      } finally {
        if (epoch === mutationEpoch) viaReorderBusy = false;
      }
    }

    function briefForm() {
      return {
        query: $("query") ? $("query").value : "",
        origin: $("origin") ? $("origin").value.trim() : "",
        destination: $("destination") ? $("destination").value.trim() : "",
        days: $("days") ? $("days").value : "",
        startDate: $("startDate") ? $("startDate").value : "",
      };
    }

    function buildQuerySentence() {
      const o = $("origin").value.trim() || "出发地";
      const d = $("destination").value.trim() || "目的地";
      const days = $("days").value || 7;
      const prefs = readPrefs();
      const paceMap = { relaxed: "轻松慢游", balanced: "经典均衡", hardcore: "特种兵打卡" };
      const themeMap = { landmark: "经典地标", family: "亲子友好", photo: "人文摄影", food: "烟火美食" };
      const hw = prefs.highway === "scenic" ? "少走高速看风景" : "高速优先";
      const car = prefs.energy_type === "ev" ? "新能源电车" : "燃油车";
      const mode = prefs.travel_mode === "hsr_rental" ? "高铁+到站租车" : `自驾（${prefs.pax}人同车·${car}）`;
      return `规划从${o}到${d}的${days}天${mode}，${paceMap[prefs.pace]}，主题${themeMap[prefs.theme]}，人均预算¥${prefs.budget_min}~${prefs.budget_max}，${hw}`;
    }

    function syncQueryFromPrefs() {
      if (!$("query")) return;
      // 用户已经写过需求时，偏好改动不再盖掉那句话
      if (document.body.dataset.queryLocked === "1") {
        if (window.RoadbookBrief) RoadbookBrief.retargetFromForm(briefForm());
        return;
      }
      $("query").value = buildQuerySentence();
    }

    function refreshPrefSummaryText() {
      const el = $("prefSummaryText");
      if (!el) return;
      el.textContent = prefSummaryLine();
    }

    function setPrefBlockOpen(open) {
      const block = $("prefBlock");
      const btn = $("prefSummaryToggle");
      if (!block || !btn) return;
      if (open) {
        block.hidden = false;
        block.classList.remove("is-collapsed");
        btn.setAttribute("aria-expanded", "true");
      } else {
        block.hidden = true;
        block.classList.add("is-collapsed");
        btn.setAttribute("aria-expanded", "false");
      }
      refreshPrefSummaryText();
    }

    function copilotPrompt(trip) {
      if (!trip) {
        return (window.t && t("copilotHello")) || "第 1 天在左边。要改就说一句，例如：中间加西安。";
      }
      const log = trip.chat_log || [];
      for (let i = log.length - 1; i >= 0; i -= 1) {
        if (log[i] && log[i].role !== "user" && log[i].text) {
          return String(log[i].text).replace(/\s+/g, " ").trim();
        }
      }
      const via = (trip.via_cities || [])[1] || "某城";
      return `路书已就绪。直接说「中间加个西安」「不去${via}」「玩${(trip.days || 7) + 1}天」。`;
    }

    function updateDockChatLabel() {
      const hint = $("dockHint");
      if (!hint) return;
      const trip = document.body.classList.contains("has-trip") ? lastTrip : null;
      hint.textContent = copilotPrompt(trip);
    }

    function syncGoLabel(hasTrip) {
      const go = $("go");
      if (!go || isShareView()) return;
      if (hasTrip) {
        go.dataset.i18n = "regenerate";
        go.textContent = (window.t && t("regenerate")) || "重新生成";
      } else {
        go.dataset.i18n = "generate";
        go.textContent = (window.t && t("generate")) || "生成路书";
      }
    }

    function prefSummaryLine() {
      const prefs = readPrefs();
      const paceMap = { relaxed: "轻松慢游", balanced: "经典均衡", hardcore: "特种兵" };
      const themeMap = { landmark: "经典地标", family: "亲子友好", photo: "人文摄影", food: "烟火美食" };
      const budgetMap = { economy: "经济", comfort: "舒适", premium: "品质" };
      const mode = prefs.travel_mode === "hsr_rental" ? "高铁+租车" : "全程自驾";
      const hw = prefs.highway === "scenic" ? "少走高速" : "高速优先";
      return [
        paceMap[prefs.pace] || "经典均衡",
        themeMap[prefs.theme] || "经典地标",
        budgetMap[prefs.budget_level] || "舒适",
        mode,
        hw,
      ].join(" · ");
    }

    function updatePlanSummary(trip) {
      const text = $("planSummaryText");
      if (!text) return;
      const o = (trip && trip.origin) || ($("origin") && $("origin").value.trim()) || "出发地";
      const d = (trip && trip.destination) || ($("destination") && $("destination").value.trim()) || "目的地";
      const days = (trip && trip.days) || ($("days") && $("days").value) || "—";
      const date = (trip && trip.start_date) || ($("startDate") && $("startDate").value) || "";
      const dateBit = date ? ` · ${date}` : "";
      text.textContent = `${o} → ${d} · ${days} 天${dateBit} · ${prefSummaryLine()}`;
    }

    function collapsePlanForm(trip, opts = {}) {
      if (isShareView()) return;
      const shell = document.querySelector(".shell");
      const summary = $("planSummary");
      if (!shell || !summary) return;
      updatePlanSummary(trip || lastTrip);
      shell.classList.add("form-collapsed");
      summary.classList.remove("hidden");
      summary.setAttribute("aria-expanded", "false");
      syncGoLabel(true);
      if (opts.scroll !== false) {
        requestAnimationFrame(() => {
          const cover = $("cover");
          if (cover) cover.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }

    function expandPlanForm() {
      if (isShareView()) return;
      const shell = document.querySelector(".shell");
      const summary = $("planSummary");
      if (!shell || !summary) return;
      shell.classList.remove("form-collapsed");
      summary.classList.add("hidden");
      summary.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => {
        shell.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    function longestDriveDay(trip) {
      let best = null;
      for (const d of trip.days_plan || []) {
        const km = Number(d.drive_km) || 0;
        if (!km) continue;
        if (!best || km > best.km) {
          best = {
            day: d.day,
            km,
            from: d.from_city || "",
            to: d.to_city || d.stay_city || "",
          };
        }
      }
      return best;
    }

    function setStatSrc(id, label) {
      const el = $(id);
      if (el) el.textContent = label || "";
    }

    function renderFirstGlance(trip) {
      const el = $("highlight");
      if (!el || !trip) return;
      const origin = trip.origin || "";
      const dest = trip.destination || "";
      const days = trip.days || "—";
      const dateRaw = trip.start_date || ($("startDate") && $("startDate").value) || "";
      const dateBit = dateRaw ? ` · ${dateRaw} 出发` : "";
      const line1 = `${origin} → ${dest} · ${days} 天${dateBit}`;

      const longest = longestDriveDay(trip);
      let line2 = trip.drive_hours ? `全程驾驶约 ${trip.drive_hours}` : "驾驶里程按路线计算中";
      if (longest && longest.km) {
        const leg = longest.from && longest.to ? ` ${longest.from}→${longest.to}` : "";
        line2 = `最长一天：DAY ${longest.day}${leg}，约 ${Math.round(longest.km)} km`;
      }

      let line3 = "人均预算：生成后可见估算";
      if (trip.budget) {
        const b = recomputeBudgetClient(trip.budget);
        const range = `¥${Number(b.bMin).toLocaleString()}~¥${Number(b.bMax).toLocaleString()}`;
        if (b.status === "over") {
          line3 = `人均约 ¥${Number(b.perPerson).toLocaleString()}，超出你设的 ${range}`;
        } else if (b.status === "under") {
          line3 = `人均约 ¥${Number(b.perPerson).toLocaleString()}，低于你设的 ${range}`;
        } else {
          line3 = `人均约 ¥${Number(b.perPerson).toLocaleString()}，落在你设的 ${range}`;
        }
      }

      const fit = trip.fit_verdict || {};
      const pit = (trip.pitfalls && trip.pitfalls[0] && trip.pitfalls[0].pit) || "";
      const pace = (trip.prefs && trip.prefs.pace) || "";
      let risk = fit.skip_if || pit || fit.season_tip || "";
      if (pace === "relaxed") {
        risk = "按轻松慢游排，下午留白，不赶打卡";
      } else if (risk && /特种兵/.test(risk) && pace !== "hardcore") {
        risk = "本方案下午留白，不赶极限打卡";
      }
      const line4 = risk
        ? `必知：${risk}`
        : fit.best_for
          ? `适合：${fit.best_for}`
          : "";

      el.classList.add("first-glance");
      el.innerHTML = [line1, line2, line3, line4]
        .filter(Boolean)
        .map((t) => `<span>${escAttr(t)}</span>`)
        .join("");

      setStatSrc("statDistanceSrc", "按路线算出");
      setStatSrc("statDriveSrc", "按路线算出");
      setStatSrc("statBudgetSrc", "估算");
    }

    function readPrefs() {
      const get = (name) => {
        const active = document.querySelector(`.pref-row[data-pref="${name}"] .pref-chip.active`);
        return active ? active.dataset.value : "";
      };
      const formPax = Number(document.querySelector("#formPaxSeg button.active")?.dataset.formPax || budgetPax || 2);
      const formEnergy = document.querySelector("#formEnergySeg button.active")?.dataset.formEnergy || budgetEnergy || "oil";
      const bMin = Number($("budgetMinInput")?.value || 3000);
      const bMax = Number($("budgetMaxInput")?.value || 5500);
      return {
        pace: get("pace") || "balanced",
        theme: get("theme") || "landmark",
        budget_level: get("budget_level") || "comfort",
        highway: get("highway") || "express",
        budget_min: Math.min(bMin, bMax),
        budget_max: Math.max(bMin, bMax),
        pax: formPax,
        energy_type: formEnergy,
        travel_mode: get("travel_mode") || "drive",
      };
    }

    function renderHsrCard(hsr) {
      const box = $("hsrBox");
      if (!box) return;
      if (!hsr) {
        box.classList.add("hidden");
        box.innerHTML = "";
        return;
      }
      box.classList.remove("hidden");
      const pri = hsr.priority;
      const trains = (hsr.trains || []).slice(0, 3);
      const trainRows = trains
        .map((t, i) => {
          const price =
            t.second_class != null ? `¥${Number(t.second_class).toFixed(0)} 起` : "见 12306";
          const viaLine = t.via_label
            ? `<div class="hsr-train-via ${t.via_hits && t.via_hits.length ? "" : "is-miss"}">${escAttr(t.via_label)}</div>`
            : "";
          const best = i === 0 && t.via_hits && t.via_hits.length ? " is-best" : "";
          return `<div class="hsr-train-row${best}">
            <div class="hsr-train-no">${escAttr(t.train_no || "—")}</div>
            <div>
              <div>${escAttr(t.from_station || hsr.from_station)} → ${escAttr(t.to_station || hsr.to_station)}</div>
              <div class="hsr-train-time">${escAttr(t.depart || "—")} 开 · ${escAttr(t.duration || "—")} · ${escAttr(t.arrive || "—")} 到</div>
              ${viaLine}
            </div>
            <div class="hsr-train-price">${price}</div>
          </div>`;
        })
        .join("");
      const viaNote = hsr.via_note ? `<div class="hsr-via">${escAttr(hsr.via_note)}</div>` : "";
      box.innerHTML = `
        <div class="hsr-head">
          <div>
            <h4>🚄 ${hsr.mode_label || "高铁 + 到站租车"}</h4>
            <div class="hsr-meta">${hsr.from_station} → ${hsr.to_station} · ${hsr.travel_date || "—"} · ${hsr.pax || 2} 人 · 当地租车 ${hsr.rental_days || "—"} 天</div>
          </div>
          ${pri ? `<span class="hsr-badge">热门线 ${pri.rank} · ${pri.source || ""}</span>` : ""}
        </div>
        ${viaNote}
        <div class="hsr-trains">${trainRows || '<div class="hsr-meta">暂无班次，请跳转 12306 查询</div>'}</div>
        <div class="hsr-actions">
          <a href="${hsr.booking_url || "https://www.12306.cn"}" target="_blank" rel="noopener noreferrer">跳转 12306 购票</a>
          <span class="hsr-meta">数据来源：${hsr.source || "参考"} · 余票以官网为准</span>
        </div>
        <div class="hsr-foot">到站取车后按下方逐日路书游玩；跨城段不计入全程自驾里程。</div>`;
    }

    function posterFit(ctx, text, maxW) {
      let s = String(text || "");
      if (ctx.measureText(s).width <= maxW) return s;
      while (s && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
      return s ? s + "…" : "";
    }

    function posterFrames(trip) {
      const frames = [];
      const push = (url, caption) => {
        const n = normalizeImageUrl(url);
        if (!n || frames.some((f) => f.url === n)) return;
        frames.push({ url: n, caption: caption || "" });
      };
      push(trip.hero_image, trip.destination || "");
      (trip.days_plan || []).forEach((day) => {
        const shot = (day.items || []).find((it) => it.image && (it.type === "sight" || it.type === "food"));
        if (shot) push(shot.image, day.stay_city || shot.name || "");
      });
      (trip.foods || []).forEach((food) => push(food.image, food.name || ""));
      return frames.slice(0, 3);
    }

    function loadPosterImage(url) {
      return new Promise((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => resolve(null), 7000);
        img.onload = () => {
          clearTimeout(timer);
          resolve(img.naturalWidth ? img : null);
        };
        img.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
        img.src = `/api/img?u=${encodeURIComponent(url)}`;
      });
    }

    function coverImage(ctx, img, x, y, w, h) {
      const ir = img.width / img.height;
      const r = w / h;
      let sx = 0;
      let sy = 0;
      let sw = img.width;
      let sh = img.height;
      if (ir > r) {
        sw = img.height * r;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / r;
        sy = (img.height - sh) / 2;
      }
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }

    function posterSlots(n, W, H) {
      const gap = 8;
      if (n <= 1) return [[0, 0, W, H]];
      if (n === 2) {
        const top = Math.round(H * 0.62);
        return [[0, 0, W, top], [0, top + gap, W, H - top - gap]];
      }
      const top = Math.round(H * 0.56);
      const bw = (W - gap) / 2;
      return [
        [0, 0, W, top],
        [0, top + gap, bw, H - top - gap],
        [bw + gap, top + gap, bw, H - top - gap],
      ];
    }

    function drawFrostPanel(ctx, x, y, w, h, r) {
      const a = document.createElement("canvas");
      a.width = Math.max(16, Math.round(w / 5));
      a.height = Math.max(16, Math.round(h / 5));
      a.getContext("2d").drawImage(ctx.canvas, x, y, w, h, 0, 0, a.width, a.height);
      const b = document.createElement("canvas");
      b.width = Math.max(10, Math.round(a.width / 2.4));
      b.height = Math.max(10, Math.round(a.height / 2.4));
      b.getContext("2d").drawImage(a, 0, 0, b.width, b.height);
      ctx.save();
      roundRect(ctx, x, y, w, h, r);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(b, 0, 0, b.width, b.height, x, y, w, h);
      ctx.fillStyle = "rgba(255,250,242,.55)";
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,.82)";
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, w, h, r);
      ctx.stroke();
      ctx.restore();
    }

    function drawPosterSketch(ctx, W, H, trip, isHsr) {
      const sky = ctx.createLinearGradient(0, 0, 0, H * 0.7);
      sky.addColorStop(0, "#8ecae6");
      sky.addColorStop(0.55, "#f6e7c1");
      sky.addColorStop(1, "#d7e3b8");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = "#ffe08a";
      ctx.beginPath();
      ctx.arc(W - 110, 128, 48, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,224,138,.45)";
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(W - 110, 128, 64, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = "#b7c9d6";
      ctx.beginPath();
      ctx.moveTo(0, 390);
      ctx.lineTo(110, 250);
      ctx.lineTo(230, 360);
      ctx.lineTo(360, 200);
      ctx.lineTo(500, 370);
      ctx.lineTo(640, 230);
      ctx.lineTo(W, 360);
      ctx.lineTo(W, 470);
      ctx.lineTo(0, 470);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(300, 250);
      ctx.lineTo(360, 200);
      ctx.lineTo(420, 268);
      ctx.stroke();

      ctx.fillStyle = "#7f9a62";
      ctx.beginPath();
      ctx.moveTo(0, 560);
      ctx.quadraticCurveTo(200, 430, 380, 560);
      ctx.quadraticCurveTo(540, 680, W, 500);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#f7f1e4";
      ctx.beginPath();
      ctx.moveTo(70, H + 10);
      ctx.quadraticCurveTo(180, 1040, 340, 1100);
      ctx.quadraticCurveTo(540, 1180, W + 20, 980);
      ctx.lineTo(W + 20, 1060);
      ctx.quadraticCurveTo(500, 1260, 300, 1180);
      ctx.quadraticCurveTo(120, 1100, -10, H - 30);
      ctx.closePath();
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = "rgba(196,165,116,.9)";
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 12]);
      ctx.beginPath();
      ctx.moveTo(40, H - 16);
      ctx.quadraticCurveTo(200, 1120, 360, 1140);
      ctx.quadraticCurveTo(560, 1170, W - 30, 1020);
      ctx.stroke();
      ctx.restore();

      const tree = (x, y, s) => {
        ctx.fillStyle = "#6b4a2e";
        ctx.fillRect(x - 3 * s, y, 6 * s, 18 * s);
        ctx.fillStyle = "#5f8144";
        ctx.beginPath();
        ctx.arc(x, y, 16 * s, 0, Math.PI * 2);
        ctx.fill();
      };
      tree(78, 620, 1.15);
      tree(250, 560, 0.85);
      tree(610, 600, 1);

      const vehicleX = 250;
      const vehicleY = H - 118;
      if (isHsr) {
        ctx.fillStyle = "#f7f4ee";
        roundRect(ctx, vehicleX, vehicleY, 92, 28, 8);
        ctx.fill();
        ctx.fillStyle = "#2f6fed";
        ctx.fillRect(vehicleX, vehicleY + 16, 92, 6);
        ctx.fillStyle = "#9fd3e8";
        [10, 28, 46, 64].forEach((dx) => ctx.fillRect(vehicleX + dx, vehicleY + 5, 12, 8));
      } else {
        ctx.fillStyle = "#e85d4c";
        roundRect(ctx, vehicleX, vehicleY, 58, 24, 7);
        ctx.fill();
        ctx.fillStyle = "#b9e2f2";
        ctx.fillRect(vehicleX + 12, vehicleY + 5, 16, 8);
        ctx.fillStyle = "#1c1915";
        ctx.beginPath();
        ctx.arc(vehicleX + 14, vehicleY + 24, 5, 0, Math.PI * 2);
        ctx.arc(vehicleX + 42, vehicleY + 24, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      const allStops = (
        isHsr
          ? [trip.origin, trip.destination]
          : [trip.origin, ...(trip.via_cities || []), trip.destination]
      ).filter((name, i, arr) => name && arr.indexOf(name) === i);
      const mids = allStops.slice(1, -1);
      const stops = allStops.length <= 4
        ? allStops
        : [allStops[0], mids[0], mids[mids.length - 1], allStops[allStops.length - 1]]
            .filter((name, i, arr) => name && arr.indexOf(name) === i);
      const serif = "'Songti SC', 'STSong', 'PingFang SC', serif";
      stops.forEach((name, i) => {
        const x = 70 + i * 150;
        const y = 300 + (i % 2) * 36;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#1c1915";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#1c1915";
        ctx.font = `700 26px ${serif}`;
        ctx.fillText(name, x + 14, y + 8);
      });
    }

    // 海报用离屏地图：复用封面同款 ECharts 路线图，按海报配色重新渲染后导出
    function posterMapImage(trip, w, h, pal) {
      return (async () => {
        await chinaPromise;
        if (!chinaReady || typeof echarts === "undefined") return null;
        let holder = $("posterMapHolder");
        if (!holder) {
          holder = document.createElement("div");
          holder.id = "posterMapHolder";
          holder.style.cssText = "position:fixed;left:-99999px;top:0;pointer-events:none;";
          document.body.appendChild(holder);
        }
        holder.style.width = `${w}px`;
        holder.style.height = `${h}px`;
        const chart = echarts.init(holder);

        const oCoord = parseLngLat(trip.origin_location);
        const dCoord = parseLngLat(trip.destination_location);
        const poly = (trip.polyline || []).map(parseLngLat).filter(Boolean);
        let nodes = (trip.via_nodes || [])
          .map((n) => ({ name: n.name, coord: parseLngLat(n.location) }))
          .filter((n) => n.name && n.coord);
        if (nodes.length < 2) {
          nodes = [];
          if (oCoord) nodes.push({ name: trip.origin || "出发", coord: oCoord });
          if (dCoord) nodes.push({ name: trip.destination || "抵达", coord: dCoord });
        }
        if (!nodes.length) { chart.dispose(); return null; }
        const isHsr = !!(trip.hsr || (trip.prefs && trip.prefs.travel_mode === "hsr_rental"));
        const isHsrLocal = !!trip.hsr_local_map;
        let full = poly.length >= 2 ? poly : nodes.map((n) => n.coord);
        if (isHsrLocal) full = poly.length >= 2 ? poly : oCoord && dCoord ? [oCoord, dCoord] : full;
        const bounds = routeBounds([...(full || []), ...(isHsr && oCoord && dCoord ? [oCoord, dCoord] : [])], holder);
        const rail = isHsr && oCoord && dCoord ? [oCoord, dCoord] : null;

        const nodeData = nodes.map((n, k) => {
          const terminal = k === 0 || k === nodes.length - 1;
          return {
            name: n.name,
            value: n.coord,
            symbolSize: terminal ? 9 : 6,
            itemStyle: { color: terminal ? pal.signal : pal.ink, borderColor: pal.mapNodeBorder, borderWidth: 2 },
            label: {
              show: true,
              formatter: "{b}",
              position: k === 0 ? "top" : k === nodes.length - 1 ? "left" : "right",
              distance: 7,
              color: pal.ink,
              fontWeight: terminal ? 800 : 600,
              fontSize: terminal ? 14 : 12,
            },
          };
        });

        chart.setOption({
          backgroundColor: "transparent",
          animation: false,
          geo: {
            map: "china",
            roam: false,
            silent: true,
            boundingCoords: bounds,
            left: 0, right: 0, top: 0, bottom: 0,
            itemStyle: { areaColor: pal.mapArea, borderColor: pal.mapBorder, borderWidth: 1 },
            emphasis: { disabled: true },
          },
          series: [
            {
              type: "lines",
              coordinateSystem: "geo",
              polyline: true,
              zlevel: 1,
              silent: true,
              lineStyle: { color: pal.signal, width: 4, cap: "round", join: "round", shadowBlur: 10, shadowColor: pal.signalSoft },
              data: full.length >= 2 ? [{ coords: full }] : [],
            },
            {
              type: "lines",
              coordinateSystem: "geo",
              polyline: true,
              zlevel: 1,
              silent: true,
              lineStyle: { color: pal.rail, width: 2, type: "dashed", opacity: 0.85, curveness: 0.18 },
              data: rail ? [{ coords: rail }] : [],
            },
            {
              type: "scatter",
              coordinateSystem: "geo",
              zlevel: 3,
              data: nodeData,
            },
          ],
        });

        return new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            let url = null;
            try { url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "transparent" }); } catch (e) {}
            chart.dispose();
            if (!url) { resolve(null); return; }
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
          };
          chart.on("finished", finish);
          setTimeout(finish, 2000);
        });
      })();
    }

    // 短日期：2026-10-28 → 10/28；带周几的行内标签
    function shortDate(iso) {
      const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return "";
      return `${Number(m[2])}/${Number(m[3])}`;
    }

    function dayDateTag(day) {
      if (!day || !day.date) return "";
      return `${shortDate(day.date)}${day.weekday ? " " + day.weekday : ""}`;
    }

    // 一天的亮点：锚点/景点名 + 当晚晚饭或夜宿，给海报一行落点
    function dayHighlight(day) {
      const items = day.items || [];
      const anchor =
        items.find((it) => it.priority === "anchor" && it.type === "sight" && it.title) ||
        items.find((it) => it.type === "sight" && it.title);
      const dinner =
        items.find((it) => it.type === "food" && (it.priority === "must" || !it.priority) && it.title) ||
        items.find((it) => it.type === "food" && it.title);
      let name = shortStopName(anchor);
      if (!name) name = String(day.title || "").replace(/\s*→\s*/g, " · ").trim();
      const night = dinner
        ? `晚饭 ${shortStopName(dinner)}`
        : day.stay_city
          ? `住 ${day.stay_city}`
          : "";
      return {
        city: day.stay_city || "",
        name: name.slice(0, 18),
        night: String(night || "").slice(0, 16),
        no: day.day,
        date: day.date || "",
        weekday: day.weekday || "",
      };
    }

    function posterPalette() {
      if (currentTheme() === "dark") {
        return {
          ink: "#f6efe6", paper: "#141210", head: "#241c18", cream: "#f6efe6",
          band: "#1e1a16", muted: "#b3a79b", signal: "#ff8a4c", signalDeep: "#ffb088", accent: "#ff8a4c",
          line: "rgba(246,239,230,.16)", lineStrong: "rgba(246,239,230,.38)", dash: "rgba(246,239,230,.28)",
          headText: "rgba(246,239,230,.78)", mapArea: "#2a241e", mapBorder: "#4a4036",
          mapNodeBorder: "#141210", rail: "#cbb8a8", signalSoft: "rgba(255,138,76,.35)",
        };
      }
      return {
        ink: "#1c1916", paper: "#f6f3ee", head: "#1c1916", cream: "#f7f1e6",
        band: "#efe6d8", muted: "#7d746a", signal: "#e25b2a", signalDeep: "#b4441f", accent: "#ee7a3f",
        line: "rgba(28,25,22,.18)", lineStrong: "rgba(28,25,22,.4)", dash: "rgba(28,25,22,.25)",
        headText: "rgba(247,241,230,.78)", mapArea: "#e7ddca", mapBorder: "#c9b99e",
        mapNodeBorder: "#f3efe6", rail: "#5c554a", signalSoft: "rgba(212,83,43,.35)",
      };
    }

    async function drawPoster(trip) {
      const canvas = $("posterCanvas");
      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;
      const pal = posterPalette();
      const ink = pal.ink;
      const paper = pal.paper;
      const cream = pal.cream;
      const band = pal.band;
      const muted = pal.muted;
      const signal = pal.signal;
      const serif = "'Songti SC', 'STSong', 'PingFang SC', serif";
      const sans = "'PingFang SC', 'Hiragino Sans GB', sans-serif";
      const isHsr = !!(trip.hsr || (trip.prefs && trip.prefs.travel_mode === "hsr_rental"));
      const origin = trip.origin || "出发";
      const dest = trip.destination || "抵达";

      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, W, H);

      // 顶部墨色带：品牌 + 目的地
      const headH = 186;
      ctx.fillStyle = pal.head;
      ctx.fillRect(0, 0, W, headH);
      ctx.fillStyle = pal.headText;
      ctx.font = `600 14px ${sans}`;
      ctx.fillText(isHsr ? "ROADBOOK  ·  高铁 + 租车" : "ROADBOOK  ·  自驾路书", 56, 54);
      ctx.textAlign = "right";
      ctx.fillStyle = pal.accent;
      const startTag = trip.start_date ? ` · ${shortDate(trip.start_date)} 出发` : "";
      ctx.fillText(`${trip.days || "—"} 日${startTag}`, W - 56, 54);
      ctx.textAlign = "left";

      ctx.fillStyle = cream;
      let titleSize = [...dest].length <= 2 ? 78 : 60;
      ctx.font = `700 ${titleSize}px ${serif}`;
      while (titleSize > 36 && ctx.measureText(dest).width > W - 260) {
        titleSize -= 4;
        ctx.font = `700 ${titleSize}px ${serif}`;
      }
      ctx.fillText(posterFit(ctx, dest, W - 112), 56, 138);
      ctx.fillStyle = pal.headText;
      ctx.font = `500 19px ${sans}`;
      const via = (trip.via_cities || []).filter((c) => c && c !== origin && c !== dest).slice(0, 3);
      const sub = isHsr
        ? `自${origin}高铁至${dest} · 到站租车`
        : via.length
          ? `自${origin}  ·  经${via.join("、")}`
          : `自${origin}出发`;
      ctx.fillText(posterFit(ctx, sub, W - 340), 56, 168);

      // 副题右侧：出行人数 + 预算小字，补一行「这次出行」的关键画像
      const budget = trip.budget;
      const priced = budget ? recomputeBudgetClient(budget) : null;
      const total = (priced && priced.total) || (budget && budget.total) || 0;
      const pax = (budget && budget.pax) || 2;
      const per = total ? Math.round(total / pax) : 0;
      ctx.textAlign = "right";
      ctx.fillStyle = pal.accent;
      ctx.font = `500 15px ${sans}`;
      const paxText = `${pax} 人出行`;
      const perText = per ? `人均 ¥${per}` : "";
      ctx.fillText(paxText, W - 56, 132);
      if (perText) ctx.fillText(perText, W - 56, 168);
      ctx.textAlign = "left";

      // 路线图（离屏重渲封面同款）
      const mapTop = headH + 12;
      const mapH = 438;
      const mapImg = await posterMapImage(trip, W, mapH, pal);
      if (mapImg) {
        ctx.drawImage(mapImg, 0, mapTop, W, mapH);
      } else {
        ctx.strokeStyle = pal.dash;
        ctx.setLineDash([6, 8]);
        ctx.strokeRect(48, mapTop + 30, W - 96, mapH - 60);
        ctx.setLineDash([]);
        ctx.fillStyle = muted;
        ctx.font = `500 18px ${sans}`;
        ctx.textAlign = "center";
        ctx.fillText(`${origin} → ${dest}`, W / 2, mapTop + mapH / 2);
        ctx.textAlign = "left";
      }

      // 每日亮点：让拿到海报的人一眼看懂每天玩什么
      const listTop = mapTop + mapH + 26;
      ctx.fillStyle = signal;
      ctx.font = `700 14px ${sans}`;
      ctx.fillText("每日亮点", 56, listTop);
      const headTextW = ctx.measureText("每日亮点").width;
      if (trip.holiday_note) {
        ctx.textAlign = "right";
        ctx.fillStyle = pal.signalDeep;
        ctx.font = `600 13px ${sans}`;
        ctx.fillText(posterFit(ctx, trip.holiday_note.replace(/[；;]*/, "·").slice(0, 26), W - 190 - headTextW - 40), W - 56, listTop);
        ctx.textAlign = "left";
      }
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(56 + headTextW + 16, listTop - 4);
      ctx.lineTo(W - 56, listTop - 4);
      ctx.stroke();

      const days = trip.days_plan || [];
      const highlights = days.map(dayHighlight).filter((h) => h.name || h.city);
      const maxRows = 7;
      const shown = highlights.length > maxRows
        ? highlights.slice(0, maxRows - 1)
        : highlights;
      const rowsTop = listTop + 34;
      const rowsBottom = H - 288;
      const rowH = Math.max(34, Math.min(46, Math.floor((rowsBottom - rowsTop) / Math.max(shown.length, 1))));
      shown.forEach((h, i) => {
        const by = rowsTop + i * rowH + 26;
        ctx.fillStyle = signal;
        ctx.font = `700 15px ${sans}`;
        ctx.fillText(`D${h.no || i + 1}`, 56, by);
        let cursor = 108;
        if (h.city) {
          ctx.fillStyle = ink;
          ctx.font = `700 20px ${serif}`;
          const cityLabel = posterFit(ctx, h.city, 120);
          ctx.fillText(cityLabel, cursor, by);
          cursor += ctx.measureText(cityLabel).width + 10;
        }
        const mid = [h.name, h.night].filter(Boolean).join(" · ");
        if (mid) {
          ctx.fillStyle = muted;
          ctx.font = `400 15px ${sans}`;
          ctx.fillText(posterFit(ctx, mid, W - 170 - cursor), cursor, by - 1);
        }
        if (h.date) {
          ctx.textAlign = "right";
          ctx.fillStyle = muted;
          ctx.font = `500 13px ${sans}`;
          ctx.fillText(`${shortDate(h.date)}${h.weekday ? " " + h.weekday : ""}`, W - 56, by - 1);
          ctx.textAlign = "left";
        }
      });
      if (highlights.length > maxRows) {
        const by = rowsTop + shown.length * rowH + 26;
        ctx.fillStyle = muted;
        ctx.font = `400 16px ${sans}`;
        ctx.fillText(`……共 ${highlights.length} 天，完整行程见路书`, 108, by - 1);
      }

      // 底部票根带
      const bandTop = H - 260;
      ctx.fillStyle = band;
      ctx.fillRect(0, bandTop, W, H - bandTop);
      ctx.fillStyle = paper;
      ctx.beginPath();
      ctx.arc(0, bandTop, 18, 0, Math.PI * 2);
      ctx.arc(W, bandTop, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = pal.lineStrong;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 9]);
      ctx.beginPath();
      ctx.moveTo(20, bandTop);
      ctx.lineTo(W - 20, bandTop);
      ctx.stroke();
      ctx.setLineDash([]);

      const distance = isHsr
        ? (trip.hsr && (trip.hsr.local_drive_hint || trip.distance)) || ""
        : (trip.distance || "");
      const train = isHsr && trip.hsr && (trip.hsr.trains || [])[0] ? trip.hsr.trains[0].train_no : "";
      const facts = [
        ["里程", String(distance || "—")],
        ["驾时", String(trip.drive_hours || "—")],
      ];
      if (train) facts.push(["高铁", train]);
      facts.push(["人均", per ? `¥${per}` : "—"]);
      const colW = (W - 112) / facts.length;
      facts.forEach((fact, i) => {
        const x = 56 + i * colW;
        ctx.fillStyle = muted;
        ctx.font = `500 12px ${sans}`;
        ctx.fillText(fact[0], x, bandTop + 44);
        ctx.fillStyle = ink;
        ctx.font = `700 25px ${serif}`;
        ctx.fillText(posterFit(ctx, fact[1], colW - 20), x, bandTop + 78);
      });

      // 同一份路书复用刚写成的链接；失败时保留上一版，不画这一版的假码
      const prevUrl = trip._share_url || "";
      const prevPath = trip._share_path || "";
      const fp = shareFingerprint(trip);
      let qrPayload = "";
      let shareFailed = false;
      if (prevUrl && trip._share_fp === fp) {
        qrPayload = prevUrl;
      } else {
        try {
          const shareResp = await fetch("/api/share", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ trip }),
          });
          const shareData = await shareResp.json();
          if (shareData && shareData.ok && shareData.path) {
            qrPayload = `${window.location.origin}${shareData.path}`;
            trip._share_path = shareData.path;
            trip._share_url = qrPayload;
            trip._share_fp = fp;
          }
        } catch (_) { /* 下面按失败处理 */ }
        if (!qrPayload) {
          shareFailed = true;
          trip._share_url = prevUrl;
          trip._share_path = prevPath;
          trip._share_fp = prevUrl ? trip._share_fp : "";
        }
      }
      syncPosterShareUi(trip, { failed: shareFailed });
      if (qrPayload && !shareFailed) {
        const qrImg = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = `/api/qrcode?data=${encodeURIComponent(qrPayload)}`;
        });
        if (qrImg) {
          ctx.drawImage(qrImg, 56, bandTop + 94, 132, 132);
        } else {
          ctx.strokeStyle = pal.lineStrong;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 7]);
          ctx.strokeRect(56, bandTop + 94, 132, 132);
          ctx.setLineDash([]);
        }
        ctx.fillStyle = ink;
        ctx.font = `700 22px ${serif}`;
        ctx.fillText("扫码看完整行程", 210, bandTop + 148);
        ctx.fillStyle = muted;
        ctx.font = `400 13px ${sans}`;
        ctx.fillText("含每日安排 · 预算 · 行前准备", 210, bandTop + 176);
        ctx.fillText("打开这一版完整路书", 210, bandTop + 202);
      } else {
        const failLine = (window.t && t("posterShareFail")) || "分享未写成，先不要把海报当扫码入口";
        ctx.fillStyle = muted;
        ctx.font = `500 15px ${sans}`;
        const failLines = failLine.length > 18
          ? [failLine.slice(0, 18), failLine.slice(18)]
          : [failLine];
        failLines.forEach((line, i) => ctx.fillText(line, 56, bandTop + 140 + i * 28));
      }
      ctx.textAlign = "right";
      ctx.fillStyle = muted;
      ctx.font = `400 13px ${sans}`;
      ctx.fillText(`${origin} → ${dest} · ROADBOOK`, W - 56, H - 22);
      ctx.textAlign = "left";
    }

    function shareFingerprint(trip) {
      const days = (trip.days_plan || []).map((d) => ({
        day: d.day,
        title: d.title || "",
        stay: d.stay_city || "",
        km: d.drive_km || 0,
        items: (d.items || []).map((it) => it.title || "").join("|"),
      }));
      return JSON.stringify({
        o: trip.origin || "",
        d: trip.destination || "",
        days: trip.days || 0,
        date: trip.start_date || "",
        km: trip.distance || "",
        via: trip.via_cities || [],
        plan: days,
      });
    }

    function syncPosterShareUi(trip, opts = {}) {
      const btn = $("copyShareLink");
      const note = $("posterShareNote");
      const url = (trip && trip._share_url) || "";
      const failed = !!opts.failed;
      const failText = (window.t && t("posterShareFail")) || "分享未写成，先不要把海报当扫码入口";
      const readyText = (window.t && t("posterShareReady")) || "这一版已可扫码或复制链接发出";
      if (btn) {
        btn.disabled = !url;
        btn.dataset.shareUrl = url;
        if (failed && url) btn.textContent = (window.t && t("copyPrevShare")) || "复制上一版链接";
        else if (url) btn.textContent = (window.t && t("copyShareLink")) || "复制链接";
        else btn.textContent = failText;
      }
      if (note) note.textContent = failed ? failText : (url ? readyText : failText);
    }
    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function openPoster() {
      if (!lastTrip) { setStatus("请先生成路书"); return; }
      track("poster_open", {});
      $("posterModal").classList.add("open");
      drawPoster(lastTrip).catch(() => drawPoster(lastTrip));
    }

    function applyItinerary(trip, opts = {}) {
      if (isStaleMutation(opts.epoch) && !opts.allowStaleStream) return;
      lastTrip = trip;
      if (!opts.skipFormSync) {
        syncFormFromTrip(trip);
        mergeChecklistChecked(trip);
        restoreChecklistCheckedForTrip(trip);
      }
      document.body.classList.add("has-trip");
      updateDockChatLabel();
      $("result").classList.remove("hidden");
      $("title").textContent = trip.title || "—";
      const coverVia =
        trip.hsr_local_map || (trip.prefs && trip.prefs.travel_mode === "hsr_rental")
          ? []
          : trip.via_cities || [];
      renderCoverRoute(trip.origin, trip.destination, coverVia);
      $("statDays").textContent = `${trip.days || "—"} 天`;
      $("statDistance").textContent = trip.distance || "—";
      $("statDrive").textContent = trip.drive_hours || "—";
      renderHsrCard(trip.hsr || null);
      if (trip.palette) applyPalette(trip.palette, trip.hero_image);
      if (trip.origin_location || trip.polyline || trip.via_nodes) {
        renderChinaRoute({
          origin: trip.origin,
          destination: trip.destination,
          origin_location: trip.origin_location,
          destination_location: trip.destination_location,
          polyline: trip.polyline,
          via_nodes: trip.via_nodes,
          via_cities: trip.via_cities,
          hsr_local_map: !!trip.hsr_local_map,
          rail_from: trip.hsr ? trip.origin_location : "",
          rail_to: trip.hsr ? trip.destination_location : "",
          highlight_city: selectedDay
            ? ((trip.days_plan || []).find((d) => d.day === selectedDay) || {}).stay_city
            : null,
        });
      }
      renderViaBar(trip);
      renderFitVerdict(trip.fit_verdict);
      if (trip.weather_chart) renderWeather(trip.weather_chart);
      renderDayChips(trip);
      renderDays(trip);
      refreshRailForDay(trip);
      if (trip.budget) {
        if (trip.budget.pax) budgetPax = Number(trip.budget.pax);
        if (trip.budget.energy_type) budgetEnergy = trip.budget.energy_type;
        if (trip.budget.budget_min && trip.budget.budget_max) {
          syncBudgetRangeUI(trip.budget.budget_min, trip.budget.budget_max);
        }
      }
      renderBudget(trip.budget);
      renderFirstGlance(trip);
      if (trip.checklist) {
        // 保留已勾选
        renderChecklist(trip.checklist);
      }
      renderCopilot(trip);
      persistTripEdits();
    }

    let tripUndoStack = [];

    function updateUndoButtons() {
      const dis = tripUndoStack.length === 0;
      if ($("undoBtn")) $("undoBtn").disabled = dis;
      if ($("undoBtnMobile")) $("undoBtnMobile").disabled = dis;
    }

    function buildQuickSuggestions(trip) {
      const via = trip.via_cities || [];
      const suggestions = [];
      const candidateCities = ["西安", "洛阳", "平遥", "太原", "武汉", "重庆", "大理", "都江堰"];
      for (const c of candidateCities) {
        if (!via.includes(c) && c !== trip.origin && c !== trip.destination) {
          suggestions.push(`＋ 途经${c}`);
          if (suggestions.length >= 2) break;
        }
      }
      if (via.length > 2) {
        suggestions.push(`跳过${via[1]}`);
      }
      const nextDays = Math.min(14, (trip.days || 7) + 1);
      suggestions.push(`改成${nextDays}天`);
      if ((trip.prefs && trip.prefs.pace) !== "relaxed") suggestions.push("节奏调轻松");
      else suggestions.push("主题改烟火美食");
      return suggestions.slice(0, 5);
    }

    function renderCopilot(trip) {
      if (!trip) return;
      const log = trip.chat_log || [];
      const html = log.length
        ? log.map((m) => {
            const text = escAttr(m.text || "");
            if (m.role === "user") return `<div class="chat-msg user">${text}</div>`;
            const diffs = (m.changes || []).map((c) => `<span class="chat-diff-tag">✓ ${escAttr(c)}</span>`).join("");
            const jump = m.focus_day ? ` <a href="javascript:void(0)" data-jump-day="${escAttr(m.focus_day)}" style="color:var(--md-primary);font-weight:700">[看 DAY ${escAttr(m.focus_day)} ↗]</a>` : "";
            return `<div class="chat-msg bot"><div>${text}${jump}</div>${diffs ? `<div class="chat-diff-tags">${diffs}</div>` : ""}</div>`;
          }).join("")
        : `<div class="chat-msg bot">路书已就绪。直接说「中间加个西安」「不去${(trip.via_cities || [])[1] || "某城"}」「玩${(trip.days || 7) + 1}天」。</div>`;

      const logIds = ["chatLog"];
      if (document.body.dataset.sheetMode !== "brief") logIds.push("chatLogMobile");
      logIds.forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.innerHTML = html;
        el.scrollTop = el.scrollHeight;
        el.querySelectorAll("[data-jump-day]").forEach((a) => {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            closeEditSheet();
            focusAndFlashDay(Number(a.dataset.jumpDay));
          });
        });
      });

      const quicks = buildQuickSuggestions(trip);
      const qHtml = quicks.map((q) => `<button type="button" class="quick-chip" data-quick="${escAttr(q)}">${q}</button>`).join("");
      const chipIds = ["quickChips"];
      if (document.body.dataset.sheetMode !== "brief") chipIds.push("quickChipsMobile");
      chipIds.forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.innerHTML = qHtml;
        el.querySelectorAll("[data-quick]").forEach((btn) => {
          btn.addEventListener("click", () => sendChatEdit(btn.dataset.quick));
        });
      });
      updateUndoButtons();
      updateDockChatLabel();
    }

    function editSheetOpen() {
      const backdrop = $("chatSheetBackdrop");
      return !!(backdrop && backdrop.classList.contains("open") && document.body.dataset.sheetMode !== "brief");
    }

    function closeEditSheet() {
      const backdrop = $("chatSheetBackdrop");
      if (!backdrop || document.body.dataset.sheetMode === "brief") return;
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
    }

    function focusAndFlashDay(dayNum) {
      if (!dayNum || !lastTrip) return;
      selectedDay = null;
      renderDayChips(lastTrip);
      renderDays(lastTrip);
      const block = document.querySelector(`.day-block[data-day="${dayNum}"]`);
      if (block) {
        block.scrollIntoView({ behavior: "smooth", block: "nearest" });
        block.classList.remove("flash-focus");
        void block.offsetWidth;
        block.classList.add("flash-focus");
      }
    }

    async function sendChatEdit(rawText, opts = {}) {
      const msg = (rawText || "").trim();
      if (!msg) return;
      if (!lastTrip) {
        $("query").value = msg;
        startPlan();
        return;
      }
      const blocked = tripMutationBlockedReason();
      if (blocked) {
        setStatus(blocked);
        return;
      }
      const epoch = bumpMutationEpoch();
      chatEditInFlight = true;
      const tripSnapshot = JSON.parse(JSON.stringify(lastTrip));
      const chatLogBefore = [...(tripSnapshot.chat_log || [])];
      tripUndoStack.push(tripSnapshot);
      if (tripUndoStack.length > 6) tripUndoStack.shift();
      updateUndoButtons();

      lastTrip.chat_log = [...chatLogBefore, { role: "user", text: msg }].slice(-16);
      renderCopilot(lastTrip);
      if ($("chatInput")) $("chatInput").value = "";
      if ($("chatInputMobile")) $("chatInputMobile").value = "";
      setStatus(`正在按「${msg}」调整路书…`);
      track("chat_edit", {});

      try {
        const resp = await fetch("/api/chat-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trip: tripSnapshot, message: msg }),
        });
        const data = await resp.json();
        if (isStaleMutation(epoch)) return;
        if (!resp.ok || !data.ok || !data.trip) {
          throw new Error(data.message || "微调失败");
        }
        const chat_log = [
          ...chatLogBefore,
          { role: "user", text: msg },
          {
            role: "bot",
            text: data.reply || "已更新路书",
            changes: data.changes || [],
            focus_day: data.focus_day || null,
          },
        ].slice(-16);
        const focusDay = opts.noFocus ? null : data.focus_day;
        applyTripUpdate({ ...data, focus_day: focusDay, chat_log }, {
          epoch,
          preserveScroll: !focusDay,
          preserveDayFilter: !focusDay,
        });
      } catch (err) {
        if (!isStaleMutation(epoch)) {
          tripUndoStack.pop();
          updateUndoButtons();
          lastTrip.chat_log = chatLogBefore;
          renderCopilot(lastTrip);
          renderViaBar(lastTrip);
          setStatus(`调整失败：${err.message || err}`);
        }
      } finally {
        if (epoch === mutationEpoch) chatEditInFlight = false;
      }
    }

    function undoLastChatEdit() {
      if (!tripUndoStack.length) return;
      bumpMutationEpoch();
      chatEditInFlight = false;
      viaReorderBusy = false;
      const prev = tripUndoStack.pop();
      updateUndoButtons();
      selectedDay = null;
      poolPickerDay = null;
      poolFilterQuery = "";
      applyItinerary(prev);
      setStatus("已撤销上一步修改");
    }

    function tripQueryIssue(text) {
      const q = (text || "").trim();
      const say = (key, zh) => (window.t && t(key) !== key ? t(key) : zh);
      if (!q) return say("queryEmpty", "先用对话把出行说清楚");
      if (q.length > 200) return say("queryLong", "需求描述请控制在 200 字以内");
      if (/(忽略|无视).{0,12}(指令|规则|提示)|system\s*prompt|jailbreak/i.test(q)) {
        return say("queryInject", "请只描述这次出行，不要写其它指令");
      }
      if (/毒品|冰毒|海洛因|大麻|制毒|炸药|炸弹|枪支|买枪|军火|色情|裸聊|招嫖|诈骗|洗钱|木马|入侵系统|儿童色情/.test(q)) {
        return say("queryIllegal", "这段内容和出行路书无关，无法生成");
      }
      return "";
    }

    async function startPlan() {
      const form = Object.assign(briefForm(), { autoSentence: buildQuerySentence() });
      if (window.RoadbookBrief) {
        const held = RoadbookBrief.beforeGenerate(form);
        if (held) {
          setStatus(held);
          return;
        }
      } else {
        const issue = tripQueryIssue(form.query);
        if (issue) {
          setStatus(issue);
          return;
        }
      }
      if (abortCtrl) abortCtrl.abort();
      bumpMutationEpoch();
      streamPlanEpoch = mutationEpoch;
      chatEditInFlight = false;
      viaReorderBusy = false;
      abortCtrl = new AbortController();
      planInFlight = true;
      $("go").disabled = true;
      setStatus("开始规划…");
      track("plan_start", { travel_mode: readPrefs().travel_mode, days: Number($("days")?.value || 0) });
      $("daysList").innerHTML = '<div class="shimmer-block"></div><div class="shimmer-block short"></div>';
      $("foods").innerHTML = '<div class="shimmer-row"><i class="shimmer-thumb"></i><span class="shimmer-line"></span></div><div class="shimmer-row"><i class="shimmer-thumb"></i><span class="shimmer-line"></span></div>';
      $("hotels").innerHTML = '<div class="shimmer-line"></div><div class="shimmer-line short"></div>';
      $("tips").innerHTML = '<div class="shimmer-line"></div><div class="shimmer-line short"></div>';
      $("budgetBox").innerHTML = '<div class="empty">计算中…</div>';
      $("checklistBox").innerHTML = '<div class="empty">生成中…</div>';
      $("dayBar").innerHTML = "";
      selectedDay = null;
      poolPickerDay = null;
      poolFilterQuery = "";
      lastTrip = null;
      checkedIds = new Set();

      const prefs = readPrefs();
      const body = {
        query: $("query").value.trim(),
        origin: $("origin").value.trim(),
        destination: $("destination").value.trim(),
        days: Number($("days").value || 7),
        start_date: ($("startDate") && $("startDate").value) || "",
        only_region: window.RoadbookBrief ? RoadbookBrief.onlyRegion() : "",
        ...prefs,
      };

      try {
        const resp = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortCtrl.signal,
        });
        if (!resp.ok || !resp.body) throw new Error("请求失败");

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";
          for (const chunk of chunks) {
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const raw = line.slice(6);
            let msg;
            try { msg = JSON.parse(raw); } catch { continue; }
            handleStage(msg);
          }
        }
        if (!lastTrip) clearLoadingState("未能生成行程，请重试");
        else collapsePlanForm(lastTrip, { scroll: true });
        setStatus("生成完成");
      } catch (err) {
        if (err.name !== "AbortError") {
          setStatus(`失败：${err.message || err}`);
          clearLoadingState("生成失败，请重试");
        }
      } finally {
        planInFlight = false;
        $("go").disabled = false;
      }
    }

    function handleStage(msg) {
      if (isStaleMutation(streamPlanEpoch)) return;
      const stage = msg.stage;
      const data = msg.data || {};
      if (stage === "progress") {
        setStatus(data.message || "");
        return;
      }
      if (stage === "skeleton") {
        showSkeleton(data);
        return;
      }
      if (stage === "geo") {
        renderCoverRoute(data.origin, data.destination, []);
        renderChinaRoute(data);
        setStatus("坐标已落图，正在规划路线…");
        return;
      }
      if (stage === "route") {
        if (data.via_cities) renderCoverRoute(data.origin, data.destination, data.via_cities);
        $("statDistance").textContent = data.distance || "—";
        $("statDrive").textContent = data.drive_hours || "—";
        renderChinaRoute({
          ...data,
          via_nodes: data.via_nodes || (lastTrip && lastTrip.via_nodes) || [],
        });
        if (data.via_cities && lastTrip) {
          renderViaBar({ ...lastTrip, via_cities: data.via_cities });
        } else if (data.via_cities) {
          renderViaBar({ origin: data.origin, destination: data.destination, via_cities: data.via_cities, city_vibes: {} });
        }
        setStatus("中国地图路线已绘出，正在查询天气…");
        return;
      }
      if (stage === "weather") {
        renderWeather(data);
        setStatus("天气已更新，正在整理行程…");
        return;
      }
      if (stage === "itinerary") {
        applyItinerary(data, { epoch: streamPlanEpoch, allowStaleStream: false });
        setStatus("行程正文已生成，正在配图与取色…");
        return;
      }
      if (stage === "palette") {
        applyPalette(data.palette, data.hero_image);
        return;
      }
      if (stage === "photos") {
        applyItinerary(data, { epoch: streamPlanEpoch, allowStaleStream: false });
        setStatus("配图与 MD3 动态配色完成");
        return;
      }
      if (stage === "done") {
        if (!lastTrip) clearLoadingState("暂无日程");
        else {
          saveHistory(lastTrip);
          track("plan_done", { travel_mode: (lastTrip.prefs || {}).travel_mode, days: lastTrip.days });
          collapsePlanForm(lastTrip, { scroll: true });
        }
        setStatus("生成完成");
        return;
      }
      if (stage === "error") {
        track("plan_fail", {});
        setStatus(`失败：${data.message || "未知错误"}`);
        const hl = $("highlight");
        if (hl) {
          hl.classList.remove("first-glance");
          hl.textContent = data.message || "生成失败";
        }
        clearLoadingState("生成失败，请重试");
      }
    }

    $("go")?.addEventListener("click", startPlan);
    $("planSummary")?.addEventListener("click", () => {
      expandPlanForm();
    });
    $("prefSummaryToggle")?.addEventListener("click", () => {
      const block = $("prefBlock");
      setPrefBlockOpen(!!(block && block.hidden));
    });
    $("query")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") startPlan();
    });
    $("query")?.addEventListener("input", () => {
      document.body.dataset.queryLocked = "1";
    });
    // 出发日期默认明天，让行程从第一天就挂上真实日历
    (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const el = $("startDate");
      if (el && !el.value) el.value = iso;
    })();
    document.querySelectorAll(".examples button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [q, o, d, days] = JSON.parse(btn.dataset.ex);
        document.body.dataset.queryLocked = "";
        $("query").value = q;
        $("origin").value = o;
        $("destination").value = d;
        $("days").value = days;
        const travel = btn.dataset.travel || "drive";
        setPrefChip("travel_mode", travel);
        refreshFormBudgetByContext(true);
        syncQueryFromPrefs();
        refreshPrefSummaryText();
      });
    });
    document.querySelectorAll(".pref-row").forEach((row) => {
      row.querySelectorAll(".pref-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          row.querySelectorAll(".pref-chip").forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          if (row.dataset.pref === "budget_level" || row.dataset.pref === "highway") {
            refreshFormBudgetByContext(row.dataset.pref === "budget_level");
          }
          syncQueryFromPrefs();
          refreshPrefSummaryText();
        });
      });
    });
    // 预算区间双滑块 & 输入框联动
    $("budgetMinRange")?.addEventListener("input", (e) => {
      userTouchedRange = true;
      syncBudgetRangeUI(Number(e.target.value), Number($("budgetMaxInput").value));
      syncQueryFromPrefs();
    });
    $("budgetMaxRange")?.addEventListener("input", (e) => {
      userTouchedRange = true;
      syncBudgetRangeUI(Number($("budgetMinInput").value), Number(e.target.value));
      syncQueryFromPrefs();
    });
    $("budgetMinInput")?.addEventListener("change", (e) => {
      userTouchedRange = true;
      syncBudgetRangeUI(Number(e.target.value), Number($("budgetMaxInput").value));
      syncQueryFromPrefs();
    });
    $("budgetMaxInput")?.addEventListener("change", (e) => {
      userTouchedRange = true;
      syncBudgetRangeUI(Number($("budgetMinInput").value), Number(e.target.value));
      syncQueryFromPrefs();
    });
    document.querySelectorAll("#formPaxSeg button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#formPaxSeg button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        budgetPax = Number(btn.dataset.formPax);
        refreshFormBudgetByContext(false);
        syncQueryFromPrefs();
      });
    });
    document.querySelectorAll("#formEnergySeg button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#formEnergySeg button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        budgetEnergy = btn.dataset.formEnergy;
        refreshFormBudgetByContext(false);
        syncQueryFromPrefs();
      });
    });
    $("swapCities")?.addEventListener("click", () => {
      const a = $("origin").value;
      $("origin").value = $("destination").value;
      $("destination").value = a;
      syncQueryFromPrefs();
    });
    ["origin", "destination", "days"].forEach((id) => {
      $(id)?.addEventListener("change", () => {
        if (id === "days") refreshFormBudgetByContext(false);
        syncQueryFromPrefs();
      });
      $(id)?.addEventListener("input", () => {
        if (id === "days") refreshFormBudgetByContext(false);
        syncQueryFromPrefs();
      });
    });
    $("togglePhone")?.addEventListener("click", () => {
      document.body.classList.toggle("phone-preview");
      $("togglePhone").textContent = document.body.classList.contains("phone-preview")
        ? (window.t ? t("phoneExit") : "退出预览")
        : (window.t ? t("phonePreview") : "手机预览");
      track("phone_preview", { ok: document.body.classList.contains("phone-preview") });
      closeSettings();
      syncDensity();
      refreshMobilePanes();
      setTimeout(() => lastRouteState && renderChinaRoute(lastRouteState), 80);
    });
    const openHist = () => {
      track("history_open", {});
      $("settingsDrawer")?.classList.remove("open");
      renderHistoryList();
      $("historyDrawer")?.classList.add("open");
    };
    const closeHist = () => $("historyDrawer")?.classList.remove("open");
    const openSettings = () => {
      $("historyDrawer")?.classList.remove("open");
      $("settingsDrawer")?.classList.add("open");
      $("settingsDrawer")?.setAttribute("aria-hidden", "false");
    };
    const closeSettings = () => {
      $("settingsDrawer")?.classList.remove("open");
      $("settingsDrawer")?.setAttribute("aria-hidden", "true");
    };

    function avatarColorFromSeed(seed) {
      let hash = 2166136261;
      for (const ch of String(seed || "rb")) {
        hash ^= ch.codePointAt(0);
        hash = Math.imul(hash, 16777619);
      }
      const h = (hash >>> 0) % 360;
      return `hsl(${h} 52% 42%)`;
    }

    function paintUserAvatar(data) {
      const label = (data && data.phone_tail) || ((data && data.phone_masked) || "").slice(-2) || "我";
      const seed = (data && (data.phone_masked || data.phone_tail)) || label;
      const bg = avatarColorFromSeed(seed);
      ["userAvatar", "userAvatarLarge"].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.textContent = label;
        el.style.background = bg;
        el.classList.remove("hidden");
      });
      const chip = $("authUserChip");
      if (chip) {
        chip.textContent = (data && data.phone_masked) || "";
        chip.classList.toggle("hidden", !(data && data.phone_masked));
      }
    }

    $("openHistory")?.addEventListener("click", openHist);
    $("openSettings")?.addEventListener("click", openSettings);
    $("closeSettings")?.addEventListener("click", closeSettings);
    $("settingsDrawer")?.addEventListener("click", (e) => {
      if (e.target === $("settingsDrawer")) closeSettings();
    });
    $("userAvatar")?.addEventListener("click", openSettings);
    (function initAuthHeader() {
      if (window.__SHARE_MODE__) return;
      $("authLogout")?.classList.add("hidden");
      paintUserAvatar({ phone_tail: "客", phone_masked: "", guest: true });
    })();
    $("dockHistory")?.addEventListener("click", openHist);
    $("closeHistory")?.addEventListener("click", closeHist);
    $("historyDrawer")?.addEventListener("click", (e) => { if (e.target === $("historyDrawer")) closeHist(); });
    $("dockSave")?.addEventListener("click", () => {
      if (!lastTrip) { setStatus("请先生成路书"); return; }
      saveHistory(lastTrip);
      setStatus("已收藏到历史路书夹");
    });
    $("dockPoster")?.addEventListener("click", openPoster);
    $("closePoster")?.addEventListener("click", () => $("posterModal")?.classList.remove("open"));
    $("posterModal")?.addEventListener("click", (e) => { if (e.target === $("posterModal")) $("posterModal").classList.remove("open"); });
    $("copyShareLink")?.addEventListener("click", async () => {
      const btn = $("copyShareLink");
      const url = (btn && btn.dataset.shareUrl) || (lastTrip && lastTrip._share_url) || "";
      if (!url) {
        setStatus("分享链接未就绪");
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
        } else {
          const ta = document.createElement("textarea");
          ta.value = url;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setStatus("已复制这一版链接");
        if ($("posterShareNote")) {
          $("posterShareNote").textContent = "链接已复制，发给同伴即可打开这一版";
        }
      } catch (_) {
        setStatus(url);
      }
    });
    $("downloadPoster")?.addEventListener("click", () => {
      const a = document.createElement("a");
      a.download = `roadbook-${(lastTrip && lastTrip.origin) || "trip"}.png`;
      a.href = $("posterCanvas").toDataURL("image/png");
      a.click();
    });
    // 对话微调事件绑定（宽屏右栏 + 竖屏半屏抽屉）
    $("chatSend")?.addEventListener("click", () => sendChatEdit($("chatInput").value));
    $("chatInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatEdit($("chatInput").value); });
    $("chatSendMobile")?.addEventListener("click", () => {
      if (document.body.dataset.sheetMode === "brief") return;
      sendChatEdit($("chatInputMobile").value);
    });
    $("chatInputMobile")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && document.body.dataset.sheetMode !== "brief") sendChatEdit($("chatInputMobile").value);
    });
    $("undoBtn")?.addEventListener("click", undoLastChatEdit);
    $("undoBtnMobile")?.addEventListener("click", undoLastChatEdit);
    function initDockScrollReveal() {
      const dock = $("appDock");
      if (!dock) return;
      const reduceMotion =
        window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) return;

      const HIDE_AFTER_PX = 110;
      const SHOW_AFTER_UP_PX = 36;
      const MIN_TOGGLE_GAP_MS = 650;
      const TOP_ANCHOR_PX = 56;
      const BOTTOM_ANCHOR_PX = 100;
      const TICK_MIN = 4;

      let lastWinY = window.scrollY;
      let lastRailY = 0;
      let accumDown = 0;
      let accumUp = 0;
      let lastToggleAt = 0;
      let hidden = false;
      let rafId = 0;
      let frameDy = 0;

      const railEl = document.querySelector(".rail");
      if (railEl) lastRailY = railEl.scrollTop;

      function autoHideEnabled() {
        return false;
      }

      function dockLockedOpen() {
        if ($("chatSheetBackdrop")?.classList.contains("open")) return true;
        if ($("historyDrawer")?.classList.contains("open")) return true;
        if ($("posterModal")?.classList.contains("open")) return true;
        if (document.querySelector(".bridge-sheet-backdrop.open")) return true;
        const ae = document.activeElement;
        if (ae && (ae.closest(".chat-sheet") || ae.closest("#chatInputMobile"))) return true;
        return false;
      }

      function atScrollAnchor() {
        const doc = document.documentElement;
        const nearTop = window.scrollY <= TOP_ANCHOR_PX;
        const nearBottom =
          window.scrollY + window.innerHeight >= doc.scrollHeight - BOTTOM_ANCHOR_PX;
        const railNearTop = !railEl || railEl.scrollTop <= TOP_ANCHOR_PX;
        return nearTop || nearBottom || railNearTop;
      }

      function showDock(force) {
        if (!document.body.classList.contains("has-trip")) return;
        const now = Date.now();
        if (!force && hidden && now - lastToggleAt < MIN_TOGGLE_GAP_MS) return;
        dock.classList.remove("is-scroll-hidden");
        hidden = false;
        lastToggleAt = force ? lastToggleAt : now;
        accumDown = 0;
        accumUp = 0;
      }

      function hideDock() {
        if (!document.body.classList.contains("has-trip")) return;
        const now = Date.now();
        if (hidden || now - lastToggleAt < MIN_TOGGLE_GAP_MS) return;
        dock.classList.add("is-scroll-hidden");
        hidden = true;
        lastToggleAt = now;
        accumDown = 0;
        accumUp = 0;
      }

      function applyFrameDelta(dy) {
        if (!autoHideEnabled()) {
          showDock(true);
          return;
        }
        if (dockLockedOpen() || dock.classList.contains("is-pinned")) {
          showDock(true);
          accumDown = 0;
          accumUp = 0;
          return;
        }
        if (atScrollAnchor()) {
          showDock(true);
          accumDown = 0;
          accumUp = 0;
          return;
        }
        if (Math.abs(dy) < TICK_MIN) return;

        if (dy > 0) {
          accumDown += dy;
          accumUp = 0;
          if (!hidden && accumDown >= HIDE_AFTER_PX) hideDock();
        } else {
          accumUp += -dy;
          accumDown = 0;
          if (hidden && accumUp >= SHOW_AFTER_UP_PX) showDock(true);
        }
      }

      function queueDelta(dy) {
        frameDy += dy;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          const d = frameDy;
          frameDy = 0;
          applyFrameDelta(d);
        });
      }

      function onWindowScroll() {
        const y = window.scrollY;
        const dy = y - lastWinY;
        lastWinY = y;
        queueDelta(dy);
      }

      function onRailScroll() {
        if (!railEl) return;
        const y = railEl.scrollTop;
        const dy = y - lastRailY;
        lastRailY = y;
        if (Math.abs(window.scrollY - lastWinY) > TICK_MIN) return;
        queueDelta(dy);
      }

      window.addEventListener("scroll", onWindowScroll, { passive: true });
      railEl?.addEventListener("scroll", onRailScroll, { passive: true });

      dock.addEventListener("mouseenter", () => dock.classList.add("is-pinned"));
      dock.addEventListener("mouseleave", () => dock.classList.remove("is-pinned"));
      dock.addEventListener("focusin", () => dock.classList.add("is-pinned"));
      dock.addEventListener("focusout", (e) => {
        if (!dock.contains(e.relatedTarget)) dock.classList.remove("is-pinned");
      });
      dock.addEventListener(
        "touchstart",
        () => {
          dock.classList.add("is-pinned");
          showDock(true);
        },
        { passive: true }
      );

      window.addEventListener("resize", () => {
        if (!autoHideEnabled()) showDock(true);
      });

      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) showDock(true);
      });
    }

    initDockScrollReveal();

    function openDockConversation(prefill) {
      const backdrop = $("chatSheetBackdrop");
      const already = backdrop?.classList.contains("open") && document.body.dataset.sheetMode === "edit";
      $("appDock")?.classList.remove("is-scroll-hidden");
      if (already && !prefill) {
        backdrop.classList.remove("open");
        backdrop.setAttribute("aria-hidden", "true");
        return;
      }
      if (window.RoadbookBrief) {
        RoadbookBrief.open(lastTrip ? "edit" : "brief");
      } else if (backdrop) {
        backdrop.classList.add("open");
        backdrop.setAttribute("aria-hidden", "false");
        if (lastTrip) document.body.dataset.sheetMode = "edit";
        setTimeout(() => $("chatInputMobile")?.focus(), 60);
      }
      if (prefill && $("chatInputMobile")) {
        $("chatInputMobile").value = prefill;
        setTimeout(() => {
          const input = $("chatInputMobile");
          if (!input) return;
          input.focus();
          const end = input.value.length;
          input.setSelectionRange?.(end, end);
        }, 80);
      }
    }

    $("dockChatOpen")?.addEventListener("click", () => openDockConversation());
    document.addEventListener("roadbook-sheet-mode", (event) => {
      if (event.detail === "edit" && lastTrip) renderCopilot(lastTrip);
    });
    document.addEventListener("roadbook-lang", () => {
      updateDockChatLabel();
      const phoneBtn = $("togglePhone");
      if (!phoneBtn || !window.t) return;
      phoneBtn.textContent = document.body.classList.contains("phone-preview") ? t("phoneExit") : t("phonePreview");
    });
    document.addEventListener("roadbook-theme", () => {
      if (lastPalettePacket) applyPalette(lastPalettePacket);
      else applyPalette(seedFromText(($("destination") && $("destination").value) || "路书"));
      if (lastTrip && $("posterModal")?.classList.contains("open")) drawPoster(lastTrip).catch(() => {});
    });
    $("closeChatSheet")?.addEventListener("click", () => {
      const backdrop = $("chatSheetBackdrop");
      if (!backdrop) return;
      backdrop.classList.remove("open");
      backdrop.setAttribute("aria-hidden", "true");
    });
    $("chatSheetBackdrop")?.addEventListener("click", (e) => {
      if (e.target === $("chatSheetBackdrop")) {
        $("chatSheetBackdrop").classList.remove("open");
        $("chatSheetBackdrop").setAttribute("aria-hidden", "true");
      }
    });
    $("mobileTabs")?.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        $("mobileTabs").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const pane = btn.dataset.pane;
        document.querySelectorAll("[data-mobile-pane]").forEach((el) => {
          el.classList.toggle("hidden-pane", el.dataset.mobilePane !== pane);
        });
      });
    });
    $("preTripToggle")?.addEventListener("click", () => {
      preTripExpanded = !preTripExpanded;
      updatePreTripReadinessBar(lastTrip && lastTrip.checklist);
    });
    // 默认桌面显示全部 pane；密度由 PlatformBridge 写入 body[data-density]
    function refreshMobilePanes() {
      const isMobile = isCompactLayout();
      const active = $("mobileTabs")?.querySelector("button.active")?.dataset.pane || "itinerary";
      document.querySelectorAll("[data-mobile-pane]").forEach((el) => {
        if (!isMobile) el.classList.remove("hidden-pane");
        else el.classList.toggle("hidden-pane", el.dataset.mobilePane !== active);
      });
    }
    window.addEventListener("resize", () => {
      syncDensity();
      if (lastRouteState) renderChinaRoute(lastRouteState);
      refreshMobilePanes();
    });
    function initShareChrome() {
      if (!isShareView()) return;
      const statusEl = $("shareStatus");
      const setShareStatus = (msg) => { if (statusEl) statusEl.textContent = msg || ""; };
      paintUserAvatar({ phone_tail: "客", phone_masked: "", guest: true });
      $("authLogout")?.classList.add("hidden");
      $("shareFork")?.classList.remove("hidden");
      const own = $("shareMakeOwn");
      if (own) {
        own.href = "/";
        own.textContent = "去做自己的路书";
      }
      $("shareSave")?.addEventListener("click", () => {
        if (!lastTrip) {
          setShareStatus("路书还在加载，请稍候再收藏");
          return;
        }
        saveHistory(lastTrip);
        setShareStatus("已收藏到本机历史路书。这是你的副本，不会改到好友的分享。");
      });
      $("shareFork")?.addEventListener("click", () => {
        if (!lastTrip) {
          setShareStatus("路书还在加载");
          return;
        }
        try {
          localStorage.setItem(EDIT_KEY, JSON.stringify({
            trip: lastTrip,
            checked: [],
            from_share: true,
            saved_at: Date.now(),
          }));
        } catch (_) {
          setShareStatus("复制失败，请检查浏览器是否允许本地存储");
          return;
        }
        window.location.href = "/";
      });
    }

    (function initFeedback() {
      const sheet = $("feedbackSheet");
      if (!sheet) return;
      let category = "不准";
      const setMsg = (t) => { const el = $("feedbackStatus"); if (el) el.textContent = t || ""; };
      const open = () => {
        track("feedback_open", {});
        closeSettings();
        sheet.classList.remove("hidden");
        setMsg("");
      };
      const close = () => sheet.classList.add("hidden");
      $("openFeedback")?.addEventListener("click", open);
      $("openFeedbackMobile")?.addEventListener("click", open);
      $("feedbackClose")?.addEventListener("click", close);
      sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
      $("feedbackCats")?.querySelectorAll("[data-cat]").forEach((btn) => {
        btn.addEventListener("click", () => {
          category = btn.dataset.cat || "其他";
          $("feedbackCats").querySelectorAll("[data-cat]").forEach((b) => b.classList.toggle("active", b === btn));
        });
      });
      $("feedbackSend")?.addEventListener("click", async () => {
        setMsg("提交中…");
        try {
          const r = await fetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ category, text: $("feedbackText")?.value || "" }),
          });
          const data = await r.json();
          setMsg(data.message || (data.ok ? "已收到" : "提交失败"));
          if (data.ok && $("feedbackText")) $("feedbackText").value = "";
        } catch (e) {
          setMsg(String(e.message || e));
        }
      });
    })();
    syncDensity();
    refreshMobilePanes();
    initShareChrome();
    applyPalette(seedFromText(($("destination") && $("destination").value) || "路书"));
    if (!window.__SHARE_MODE__) {
      refreshFormBudgetByContext(true);
      syncQueryFromPrefs();
      setPrefBlockOpen(false);
      refreshPrefSummaryText();
      renderHistoryList();
      if (!tryRestoreSessionFromEdits()) {
        /* 无本地草稿时保持空白表单 */
      }
    } else {
      (async () => {
        const sid = window.__SHARE_ID__ || document.body.dataset.shareId || "";
        if (!sid) return;
        try {
          const r = await fetch(`/api/share/${encodeURIComponent(sid)}`, { credentials: "same-origin" });
          const data = await r.json();
          if (!data.ok || !data.trip) {
            setStatus(data.message || "分享加载失败");
            return;
          }
          applyItinerary(data.trip, { skipFormSync: true, allowStaleStream: true });
          document.body.classList.add("has-trip", "phone-preview");
          syncDensity();
          refreshMobilePanes();
          setTimeout(() => lastRouteState && renderChinaRoute(lastRouteState), 120);
        } catch (e) {
          setStatus(String(e.message || e));
        }
      })();
    }
