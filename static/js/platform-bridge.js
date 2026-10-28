/**
 * PlatformBridge — 桌面端 (desktop-web) / 移动端 H5 (mobile-web) / 微信小程序 (wx-miniprogram) 统一动作与跳转桥接层
 * 业务层只调用 PlatformBridge.openNavigation / openRouteNavigation / openXiaohongshu / copyText / storage / saveCanvas
 * 迁移微信小程序时无需改动业务代码，自动走 wx.* 原生 API。
 */
(function (global) {
  "use strict";

  function detectEnv() {
    // 1) 真实微信小程序或 WebView 环境
    if (
      typeof wx !== "undefined" &&
      wx &&
      (typeof wx.openLocation === "function" ||
        (wx.miniProgram && typeof wx.miniProgram.navigateTo === "function") ||
        global.__wxjs_environment === "miniprogram")
    ) {
      return "wx-miniprogram";
    }
    // 2) 页面开启了「手机/小程序预览模式」时，可模拟小程序交互体验
    if (
      typeof document !== "undefined" &&
      document.body &&
      document.body.classList.contains("phone-preview")
    ) {
      return "wx-miniprogram-sim";
    }
    // 3) 手机浏览器 / 微信内 H5
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/Android|iPhone|iPad|iPod|Mobile|MicroMessenger/i.test(ua)) {
      return "mobile-web";
    }
    // 4) 桌面浏览器
    return "desktop-web";
  }

  /**
   * Roadbook 三密度：desktop | compact | wx
   * - wx-miniprogram / phone-preview 仿真 → wx（430px 壳、触控优先）
   * - mobile-web 或桌面窄窗 ≤980 → compact（流式宽、单栏 Tab）
   * - 其余 → desktop（双栏工作台，max ~1320px）
   */
  function resolveDensity() {
    const env = detectEnv();
    if (env === "wx-miniprogram" || env === "wx-miniprogram-sim") return "wx";
    if (env === "mobile-web") return "compact";
    const narrow =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 980px)").matches;
    return narrow ? "compact" : "desktop";
  }

  function applyDensity(force) {
    if (typeof document === "undefined" || !document.body) return resolveDensity();
    const density = force || resolveDensity();
    document.body.dataset.density = density;
    return density;
  }

  function parseLngLat(loc) {
    if (!loc || typeof loc !== "string" || !loc.includes(",")) return null;
    const [lng, lat] = loc.split(",").map((x) => parseFloat(x.trim()));
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return { lng, lat };
  }

  /**
   * 轻量原生感 Toast / 模态回执（用于在手机/小程序模拟态提示口令或导航选择）
   */
  function showBridgeSheet(opts) {
    if (typeof document === "undefined") return;
    let host = document.getElementById("bridgeActionSheet");
    if (!host) {
      host = document.createElement("div");
      host.id = "bridgeActionSheet";
      host.className = "bridge-sheet-backdrop";
      document.body.appendChild(host);
    }
    const actionsHtml = (opts.actions || [])
      .map(
        (a, i) =>
          `<button type="button" class="bridge-sheet-btn ${a.primary ? "primary" : ""}" data-bidx="${i}">${a.label}</button>`
      )
      .join("");
    host.innerHTML = `
      <div class="bridge-sheet">
        <div class="sheet-handle"></div>
        <div class="bridge-sheet-tag">${opts.envTag || "平台桥接"}</div>
        <h4>${opts.title || ""}</h4>
        <p>${opts.desc || ""}</p>
        <div class="bridge-sheet-actions">${actionsHtml}</div>
        <button type="button" class="bridge-sheet-cancel" data-bclose="1">关闭</button>
      </div>`;
    host.classList.add("open");
    host.querySelectorAll("[data-bidx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = opts.actions[Number(btn.dataset.bidx)];
        host.classList.remove("open");
        if (act && typeof act.onClick === "function") act.onClick();
      });
    });
    host.querySelector("[data-bclose]")?.addEventListener("click", () => host.classList.remove("open"));
    host.onclick = (e) => {
      if (e.target === host) host.classList.remove("open");
    };
  }

  /**
   * 复制文本（三端分流：wx.setClipboardData -> navigator.clipboard -> textarea 兜底）
   */
  function copyText(text, onNotice) {
    const notify = typeof onNotice === "function" ? onNotice : () => {};
    const env = detectEnv();
    if (env === "wx-miniprogram" && typeof wx !== "undefined" && wx.setClipboardData) {
      wx.setClipboardData({
        data: String(text || ""),
        success: () => notify("已复制到剪贴板"),
      });
      return Promise.resolve(true);
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(String(text || ""))
        .then(() => {
          notify("已复制：" + String(text).slice(0, 24));
          return true;
        })
        .catch(() => fallbackCopy(text, notify));
    }
    return Promise.resolve(fallbackCopy(text, notify));
  }

  function fallbackCopy(text, notify) {
    try {
      const ta = document.createElement("textarea");
      ta.value = String(text || "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      notify("已复制：" + String(text).slice(0, 24));
      return true;
    } catch (_) {
      notify(String(text || ""));
      return false;
    }
  }

  /**
   * 1. 单站点导航（三端分流）
   * - wx-miniprogram: 调用 wx.openLocation({ latitude, longitude, name, address }) 原生地图半屏
   * - mobile-web / wx-miniprogram-sim: 弹出「拉起高德 App / 腾讯地图 / 复制地址」动作面板，防止 window.open 被拦截
   * - desktop-web: 新标签页打开高德 Web URI
   */
  function openNavigation(item, onNotice) {
    const notify = typeof onNotice === "function" ? onNotice : () => {};
    const env = detectEnv();
    const title = (item && item.title) || "目的地";
    const addr = (item && item.place) || title;
    const pt = parseLngLat(item && item.location);

    const amapWebUrl = pt
      ? `https://uri.amap.com/marker?position=${encodeURIComponent(`${pt.lng},${pt.lat}`)}&name=${encodeURIComponent(title)}&callnative=1`
      : `https://uri.amap.com/search?keyword=${encodeURIComponent(addr)}`;

    // 真实微信小程序环境
    if (env === "wx-miniprogram" && typeof wx !== "undefined" && wx.openLocation && pt) {
      wx.openLocation({
        latitude: pt.lat,
        longitude: pt.lng,
        name: title,
        address: addr,
        scale: 15,
      });
      notify(`已调用 wx.openLocation 打开「${title}」`);
      return;
    }

    // 手机 H5 或 小程序预览模式：提供原生风格地图选择弹层（对应小程序 wx.openLocation 体验）
    if (env === "mobile-web" || env === "wx-miniprogram-sim") {
      const iosAmapScheme = pt
        ? `iosamap://viewMap?sourceApplication=roadbook&poiname=${encodeURIComponent(title)}&lat=${pt.lat}&lon=${pt.lng}&dev=0`
        : amapWebUrl;
      const qqMapUrl = pt
        ? `https://apis.map.qq.com/uri/v1/marker?marker=coord:${pt.lat},${pt.lng};title:${encodeURIComponent(title)};addr:${encodeURIComponent(addr)}&referer=roadbook`
        : amapWebUrl;

      showBridgeSheet({
        envTag: env === "wx-miniprogram-sim" ? "微信小程序 · wx.openLocation 桥接" : "移动端导航桥接",
        title: `🧭 导航至「${title}」`,
        desc: `📍 ${addr}${pt ? `（${pt.lng.toFixed(4)}, ${pt.lat.toFixed(4)}）` : ""}`,
        actions: [
          {
            label: "🚀 打开高德地图导航",
            primary: true,
            onClick: () => {
              if (env === "mobile-web") {
                global.location.href = iosAmapScheme;
                setTimeout(() => global.open(amapWebUrl, "_blank"), 450);
              } else {
                global.open(amapWebUrl, "_blank");
              }
              notify(`已拉起高德地图：${title}`);
            },
          },
          {
            label: "🗺 打开腾讯地图（微信原生同款）",
            onClick: () => {
              global.open(qqMapUrl, "_blank");
              notify(`已打开腾讯地图：${title}`);
            },
          },
          {
            label: "📋 仅复制详细地址",
            onClick: () => copyText(`${title} · ${addr}`, notify),
          },
        ],
      });
      return;
    }

    // 桌面端 Web：直接打开高德 Web 地图
    global.open(amapWebUrl, "_blank", "noopener,noreferrer");
    notify(`已在桌面新标签页打开「${title}」高德定位`);
  }

  /**
   * 2. 全天多途经点路线导航（三端分流）
   */
  function openRouteNavigation(day, fallbackCity, onNotice) {
    const notify = typeof onNotice === "function" ? onNotice : () => {};
    const env = detectEnv();
    const pts = ((day && day.items) || []).filter((it) => it.location && it.type !== "free");
    let webUrl = "";
    if (pts.length >= 2) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      const mids = pts
        .slice(1, -1)
        .map((p) => `${p.location},${p.title || "途经"}`)
        .join("|");
      webUrl = `https://uri.amap.com/navigation?from=${encodeURIComponent(`${first.location},${first.title || "起点"}`)}&to=${encodeURIComponent(`${last.location},${last.title || "终点"}`)}${mids ? `&via=${encodeURIComponent(mids)}` : ""}&mode=car&policy=1&callnative=1`;
    } else {
      const target = (day && (day.stay_city || day.to_city)) || fallbackCity || "";
      webUrl = `https://uri.amap.com/search?keyword=${encodeURIComponent(target)}`;
    }

    if (env === "wx-miniprogram" || env === "wx-miniprogram-sim") {
      const stopNames = pts.map((p) => p.title).join(" → ") || (day && day.title) || fallbackCity;
      showBridgeSheet({
        envTag: "小程序多途经点路线桥接",
        title: `🚗 DAY ${day ? day.day : ""} 全天串联导航`,
        desc: `路线顺序：${stopNames}`,
        actions: [
          {
            label: "🧭 拉起高德全天多点路线",
            primary: true,
            onClick: () => {
              global.open(webUrl, "_blank");
              notify(`已拉起 DAY ${day ? day.day : ""} 全天路线`);
            },
          },
          {
            label: "📋 复制今日全部站点顺序",
            onClick: () => copyText(`DAY ${day ? day.day : ""} 路线：${stopNames}`, notify),
          },
        ],
      });
      return;
    }

    if (env === "mobile-web") {
      global.location.href = webUrl;
      notify(`正在唤起高德 App 规划 DAY ${day ? day.day : ""} 全程`);
      return;
    }

    global.open(webUrl, "_blank", "noopener,noreferrer");
    notify(`已打开 DAY ${day ? day.day : ""} 全天多站点路线`);
  }

  /**
   * 3. 小红书实况跳转（三端分流）
   * - wx-miniprogram / wx-miniprogram-sim: 微信小程序禁止直接外跳网页，自动复制搜索词并弹出引导卡（或支持打开网页预览）
   * - mobile-web: 优先尝试 xhsdiscover://search/result?keyword=... 唤起小红书 App，兜底 H5
   * - desktop-web: 直接打开小红书 Web 搜索结果页
   */
  function openXiaohongshu(item, fallbackCity, onNotice) {
    const notify = typeof onNotice === "function" ? onNotice : () => {};
    const env = detectEnv();
    const city = (item && (item.district || item.city)) || fallbackCity || "";
    const suffix = item && item.type === "food" ? "必点 避坑" : "机位 实况 避坑";
    const kw = `${city} ${(item && item.title) || ""} ${suffix}`.trim();
    const webUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`;
    const appScheme = `xhsdiscover://search/result?keyword=${encodeURIComponent(kw)}`;

    copyText(kw, () => {});

    if (env === "wx-miniprogram" || env === "wx-miniprogram-sim") {
      showBridgeSheet({
        envTag: "微信小程序 · 外链合规桥接",
        title: "📕 小红书实况搜索词已复制",
        desc: `已自动复制「${kw}」。微信小程序内受外链域名限制，打开小红书粘贴即可查看本周游客实拍与避雷；当前预览环境也可直接新窗口打开：`,
        actions: [
          {
            label: "📕 直接打开小红书实况页（预览）",
            primary: true,
            onClick: () => {
              global.open(webUrl, "_blank", "noopener,noreferrer");
              notify(`已打开「${kw}」小红书实况`);
            },
          },
          {
            label: "✓ 仅保留剪贴板口令，去 App 粘贴",
            onClick: () => notify(`口令已就绪：${kw}`),
          },
        ],
      });
      return;
    }

    if (env === "mobile-web") {
      // 先尝试唤起小红书 App，600ms 后若未跳走则打开网页版
      const t0 = Date.now();
      global.location.href = appScheme;
      setTimeout(() => {
        if (Date.now() - t0 < 1200 && !document.hidden) {
          global.open(webUrl, "_blank");
        }
      }, 600);
      notify(`已复制「${kw}」并尝试唤起小红书 App`);
      return;
    }

    global.open(webUrl, "_blank", "noopener,noreferrer");
    notify(`已复制「${kw}」，并在新窗口打开小红书实况`);
  }

  /**
   * 4. 跨端本地存储适配（Web localStorage <-> 微信小程序 wx.getStorageSync / wx.setStorageSync）
   */
  const storage = {
    get(key, fallback) {
      try {
        if (typeof wx !== "undefined" && wx && typeof wx.getStorageSync === "function") {
          const v = wx.getStorageSync(key);
          return v !== "" && v !== undefined && v !== null ? v : fallback;
        }
        const raw = global.localStorage ? global.localStorage.getItem(key) : null;
        return raw ? JSON.parse(raw) : fallback;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof wx !== "undefined" && wx && typeof wx.setStorageSync === "function") {
          wx.setStorageSync(key, value);
          return;
        }
        if (global.localStorage) {
          global.localStorage.setItem(key, JSON.stringify(value));
        }
      } catch (_) {}
    },
  };

  global.PlatformBridge = {
    detectEnv,
    resolveDensity,
    applyDensity,
    copyText,
    openNavigation,
    openRouteNavigation,
    openXiaohongshu,
    storage,
  };
})(typeof window !== "undefined" ? window : globalThis);
