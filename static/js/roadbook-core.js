/**
 * RoadbookCore — 平台无关的路书状态管理、预算测算、站点操作与 API 协议层
 * 0 DOM 依赖：可直接复用于 Web 桌面端、H5 移动端与微信小程序 (utils/roadbook-core.js)
 */
(function (global) {
  "use strict";

  const DAILY_TIERS = {
    economy: {
      dMin: 150,
      dMax: 260,
      hotelRoom: 160,
      foodPp: 65,
      ticketPp: 25,
      label: "经济省钱",
      desc: "快捷连锁拼房 ¥80/人 · 地道粉面小吃 ¥65/天 · 优选免票景点",
    },
    comfort: {
      dMin: 260,
      dMax: 420,
      hotelRoom: 300,
      foodPp: 110,
      ticketPp: 45,
      label: "舒适口碑",
      desc: "全季/亚朵级拼房 ¥150/人 · 必吃榜老字号 ¥110/天 · 核心景区含票",
    },
    premium: {
      dMin: 450,
      dMax: 780,
      hotelRoom: 620,
      foodPp: 180,
      ticketPp: 80,
      label: "品质度假",
      desc: "景观美宿/高星 ¥310/人 · 特色私房大餐 ¥180/天 · 含索道深度体验",
    },
  };

  function cleanCityName(name) {
    // 只剥行政后缀；勿剥「苏州/杭州」里的「州」，否则会变成「苏」「杭」
    return (
      String(name || "")
        .trim()
        .replace(/(?:市|省|自治区|自治州|地区|盟)$/, "") || String(name || "").trim()
    );
  }

  function parseLngLat(loc) {
    if (!loc || typeof loc !== "string" || !loc.includes(",")) return null;
    const [lng, lat] = loc.split(",").map((x) => parseFloat(x.trim()));
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  }

  function haversineKm(loc1, loc2) {
    const a = parseLngLat(loc1);
    const b = parseLngLat(loc2);
    if (!a || !b) return null;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  }

  /**
   * 选择阶段：根据「档位日均标准 × 天数 + 预估跨城车费分摊」计算合理的总预算区间
   */
  function estimateFormBudgetRange(opts) {
    const level = (opts && opts.level) || "comfort";
    const days = Math.max(1, Math.min(14, Number((opts && opts.days) || 7)));
    const pax = Math.max(1, Math.min(5, Number((opts && opts.pax) || 2)));
    const energy = (opts && opts.energy) === "ev" ? "ev" : "oil";
    const highway = (opts && opts.highway) === "scenic" ? "scenic" : "express";
    const tier = DAILY_TIERS[level] || DAILY_TIERS.comfort;

    // 预估日均行车约 220km（短途 2~3 天约 150km/天）
    const estKmPerDay = days <= 3 ? 140 : 230;
    const estTotalKm = estKmPerDay * days;
    const kmRate = energy === "ev" ? 0.18 : 0.58;
    const tollRate = highway === "express" ? 0.42 : 0;
    const rigidPp = Math.round((estTotalKm * (kmRate + tollRate)) / pax);

    const totalMin = Math.round((tier.dMin * days + rigidPp * 0.8) / 50) * 50;
    const totalMax = Math.round((tier.dMax * days + rigidPp * 1.15) / 50) * 50;
    return {
      level,
      tierLabel: tier.label,
      tierDesc: tier.desc,
      dailyMin: tier.dMin,
      dailyMax: tier.dMax,
      rigidPp,
      totalMin: Math.max(300, totalMin),
      totalMax: Math.max(totalMin + 200, totalMax),
    };
  }

  /**
   * 结果阶段：根据路书真实里程、天数、同车人数、油/电车重算预算仪表盘数据
   */
  function recomputeBudget(rawBudget, trip, overrides) {
    if (!rawBudget) return null;
    const pax = Math.max(1, Math.min(5, Number((overrides && overrides.pax) || rawBudget.pax || 2)));
    const energy = ((overrides && overrides.energy) || rawBudget.energy_type || "oil") === "ev" ? "ev" : "oil";
    const hsr = trip && trip.hsr;
    const localKm = Number(
      (rawBudget.local_drive_km != null ? rawBudget.local_drive_km : null) ||
        (hsr && hsr.local_drive_km) ||
        0
    );
    const dist = Number(rawBudget.distance_km || (trip && trip.distance_km) || 0);
    const driveKm = hsr && localKm > 0 ? localKm : dist;
    const days = Number((trip && trip.days) || 7);
    const nights = Math.max(days - 1, 1);
    const rooms = Math.max(1, Math.ceil(pax / 2));

    const fuel = Math.round(driveKm * (energy === "ev" ? 0.18 : 0.58));
    const toll =
      hsr && localKm > 0
        ? Math.round(localKm * (rawBudget.highway === "express" ? 0.42 : 0))
        : rawBudget.toll ?? 0;
    const hotelUnit = Number(rawBudget.hotel_room_unit || 300);
    const foodUnit = Number(rawBudget.food_pp_unit || 110);
    const ticketUnit = Number(rawBudget.ticket_pp_unit || 45);

    const hotel = Math.round(hotelUnit * rooms * nights);
    const food = Math.round(foodUnit * pax * days);
    const ticket = Math.round(ticketUnit * pax * days);
    const hsrTickets = Number(rawBudget.hsr_tickets || (hsr && hsr.ticket_total) || 0);
    const carRental = Number(rawBudget.car_rental || (hsr && hsr.rental_total) || 0);
    const total = fuel + toll + hotel + food + ticket + hsrTickets + carRental;
    const perPerson = Math.round(total / pax);
    const rigidPp = Math.round((fuel + toll) / pax);
    const livingDailyPp = Math.max(0, Math.round((perPerson - rigidPp) / Math.max(days, 1)));

    const bMin = Number(rawBudget.budget_min || 1500);
    const bMax = Number(rawBudget.budget_max || 3800);
    let status = "fit";
    let statusLabel = `符合目标区间（吃住玩日均 ¥${livingDailyPp}/人·天）`;
    if (perPerson > bMax) {
      status = "over";
      statusLabel = `超出设定上限 ¥${perPerson - bMax}/人`;
    } else if (perPerson < bMin) {
      status = "under";
      statusLabel = `比目标下限还省 ¥${bMin - perPerson}/人`;
    }

    const driveLabel = hsr && localKm > 0 ? `当地租车行驶（约 ${Math.round(localKm)}km）` : energy === "ev" ? "充电补能" : "油费能耗";
    const items = [
      ...(hsrTickets
        ? [
            {
              key: "hsr",
              label: "高铁二等座（往返按单程估）",
              color: "#2563eb",
              amount: hsrTickets,
              formula: `参考 ¥${Math.round(hsrTickets / pax)}/人 · 以 12306 实时票价为准`,
              tip: "热门区间建议提前 15 天抢票；跳转官网购票",
            },
          ]
        : []),
      ...(carRental
        ? [
            {
              key: "rental",
              label: `目的地租车（${hsr && hsr.rental_days ? hsr.rental_days : days}天）`,
              color: "#7c3aed",
              amount: carRental,
              formula: `¥${Math.round(carRental / Math.max(hsr && hsr.rental_days ? hsr.rental_days : days, 1))}/天 · 含基础险`,
              tip: "高铁站/机场取还最顺路；检查划痕并拍照留证",
            },
          ]
        : []),
      {
        key: "fuel",
        label: driveLabel,
        color: "#0284c7",
        amount: fuel,
        formula:
          energy === "ev"
            ? `${Math.round(driveKm)}km × ¥0.18/km ÷ ${pax}人 = ¥${Math.round(fuel / pax)}/人`
            : `${Math.round(driveKm)}km × ¥0.58/km ÷ ${pax}人 = ¥${Math.round(fuel / pax)}/人`,
        tip: hsr ? "仅估算当地游玩里程，不含跨城段" : energy === "ev" ? "服务区快充至 80% 最省时" : "进山区前在城郊加油站补满",
      },
      {
        key: "toll",
        label: "高速过路费",
        color: "#6366f1",
        amount: toll,
        formula:
          rawBudget.highway === "express" && driveKm > 0
            ? `${Math.round(driveKm)}km × ¥0.42/km ÷ ${pax}人 = ¥${Math.round(toll / pax)}/人`
            : "已选少走高速/国道风景线，过路费 ¥0",
        tip: "法定节假日免费通行可整笔省下",
      },
      {
        key: "hotel",
        label: `沿途住宿（${nights}晚·${rooms}间）`,
        color: "#0d9488",
        amount: hotel,
        formula: `¥${hotelUnit}/间·晚 × ${nights}晚 × ${rooms}间（折合 ¥${Math.round(hotel / pax / nights)}/人·晚）`,
        tip: "2人拼标间最划算；赶路日住高速口连锁酒店",
      },
      {
        key: "food",
        label: `地道三餐（${days}天）`,
        color: "#f59e0b",
        amount: food,
        formula: `¥${foodUnit}/人·天 × ${days}天 × ${pax}人（早粉面+午简餐+晚老字号）`,
        tip: "避开景区门口拉客店，走 500 米进居民区老店",
      },
      {
        key: "ticket",
        label: "核心门票 & 机动",
        color: "#ec4899",
        amount: ticket,
        formula: `¥${ticketUnit}/人·天 × ${days}天 × ${pax}人（每天仅 1 个付费锚点，其余免票街区）`,
        tip: "顺路可选站优先排免费古镇/公园，不花冤枉钱",
      },
    ].map((it) => ({
      ...it,
      pct: Math.round(((it.amount || 0) / Math.max(total, 1)) * 100),
    }));

    return {
      ...rawBudget,
      energy_type: energy,
      pax,
      rooms,
      fuel,
      hotel,
      food,
      ticket,
      total,
      perPerson,
      rigidPp,
      livingDailyPp,
      dailyPerPerson: Math.round(perPerson / Math.max(days, 1)),
      bMin,
      bMax,
      status,
      statusLabel,
      items,
    };
  }

  /**
   * 修复跨城串味 Bug：严格按「当天所属城市 day.stay_city」从对应城市候选池换一换
   */
  function swapStopInTrip(trip, dayNum, stopId) {
    if (!trip || !trip.days_plan) return null;
    const day = trip.days_plan.find((d) => d.day === dayNum);
    if (!day || !day.items) return null;
    const idx = day.items.findIndex((it) => (it.id || "") === stopId);
    if (idx < 0) return null;
    const curItem = day.items[idx];

    const dayCity = cleanCityName(day.stay_city || day.to_city || curItem.city || trip.destination);
    const destClean = cleanCityName(trip.destination);
    const isCountyDay = day.kind === "county" && !!day.district;
    const cityPools = trip.city_pools || {};
    const cPoolObj = cityPools[dayCity] || cityPools[day.stay_city] || null;

    let pool = [];
    if (curItem.type === "food") {
      if (cPoolObj && cPoolObj.foods && cPoolObj.foods.length) {
        pool = cPoolObj.foods;
      } else if (dayCity === destClean) {
        pool = trip.food_pool || [];
      }
    } else {
      if (cPoolObj && cPoolObj.sights && cPoolObj.sights.length) {
        pool = cPoolObj.sights;
      } else if (dayCity === destClean) {
        pool = trip.sight_pool || [];
      }
    }
    if (!pool.length && isCountyDay && Array.isArray(trip.sight_pool)) {
      pool = trip.sight_pool.filter((p) => (p.district || "") === day.district);
    }
    // 再过滤一次：严禁把别的城市的点塞进当前城市
    const sameCityPool = pool.filter((p) => {
      if (!p.city) return dayCity === destClean;
      return cleanCityName(p.city) === dayCity;
    });
    const finalPool = sameCityPool.length ? sameCityPool : pool;
    if (!finalPool.length) return null;

    const usedInDay = new Set((day.items || []).map((it) => it.title));
    const curTitle = curItem.title;
    let next = null;
    if (isCountyDay) {
      const districtPool = finalPool.filter((p) => (p.district || "") === day.district);
      next =
        districtPool.find((p) => p.name !== curTitle && !usedInDay.has(p.name)) ||
        districtPool.find((p) => p.name !== curTitle) ||
        null;
      if (!next) return null;
    } else {
      next =
        finalPool.find((p) => p.name !== curTitle && !usedInDay.has(p.name)) ||
        finalPool.find((p) => p.name !== curTitle) ||
        finalPool[0];
      if (!next) return null;
    }

    const stay = next.stay_hours || curItem.stay_hours || 1.5;
    day.items[idx] = {
      ...curItem,
      title: next.name,
      place: next.address || curItem.place,
      city: dayCity,
      district: next.district || dayCity,
      is_county: !!next.is_county,
      human_tags: next.human_tags || [],
      image: next.image || "",
      location: next.location || curItem.location || "",
      rating: next.rating || "",
      cost: next.cost || "",
      tag: next.tag || "",
      stay_hours: stay,
      id: `${curItem.type}-${next.location || next.name}-${Date.now() % 10000}`,
      done: false,
    };
    return next;
  }

  /**
   * 当天这座城、全程还没排上的景点。县域日把同区县排在前面。
   */
  function candidatesForDay(trip, dayNum) {
    if (!trip || !trip.days_plan) return [];
    const day = trip.days_plan.find((d) => d.day === dayNum);
    if (!day) return [];
    const dayCity = cleanCityName(day.stay_city || day.to_city || trip.destination);
    const destClean = cleanCityName(trip.destination);
    const isCountyDay = day.kind === "county" && !!day.district;
    const cityPools = trip.city_pools || {};
    const cPoolObj = cityPools[dayCity] || cityPools[day.stay_city] || null;
    let pool = [];
    if (cPoolObj && cPoolObj.sights && cPoolObj.sights.length) {
      pool = cPoolObj.sights;
    } else if (dayCity === destClean) {
      pool = trip.sight_pool || [];
    }
    if (!pool.length && isCountyDay && Array.isArray(trip.sight_pool)) {
      pool = trip.sight_pool.filter((p) => (p.district || "") === day.district);
    }
    const sameCityPool = pool.filter((p) => {
      if (!p || !p.name) return false;
      if (!p.city) return dayCity === destClean;
      return cleanCityName(p.city) === dayCity;
    });
    const finalPool = sameCityPool.length ? sameCityPool : pool.filter((p) => p && p.name);
    const used = new Set();
    (trip.days_plan || []).forEach((d) => {
      (d.items || []).forEach((it) => {
        if (it && it.title) used.add(it.title);
      });
    });
    const seen = new Set();
    const list = [];
    finalPool.forEach((p) => {
      if (used.has(p.name) || seen.has(p.name)) return;
      seen.add(p.name);
      list.push(p);
    });
    if (isCountyDay && day.district) {
      list.sort((a, b) => {
        const ad = (a.district || "") === day.district ? 0 : 1;
        const bd = (b.district || "") === day.district ? 0 : 1;
        return ad - bd;
      });
    }
    return list;
  }

  global.RoadbookCore = {
    DAILY_TIERS,
    cleanCityName,
    parseLngLat,
    haversineKm,
    estimateFormBudgetRange,
    recomputeBudget,
    swapStopInTrip,
    candidatesForDay,
  };
})(typeof window !== "undefined" ? window : globalThis);
