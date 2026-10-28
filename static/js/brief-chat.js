(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document !== "undefined") api.mount();
  root.RoadbookBrief = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const PLACES = [
    ["北京", "Beijing"], ["上海", "Shanghai"], ["广州", "Guangzhou"], ["深圳", "Shenzhen"],
    ["成都", "Chengdu"], ["杭州", "Hangzhou"], ["西安", "Xi'an"], ["西安", "Xian"],
    ["重庆", "Chongqing"], ["武汉", "Wuhan"], ["南京", "Nanjing"], ["苏州", "Suzhou"],
    ["天津", "Tianjin"], ["长沙", "Changsha"], ["郑州", "Zhengzhou"], ["青岛", "Qingdao"],
    ["厦门", "Xiamen"], ["昆明", "Kunming"], ["兰州", "Lanzhou"], ["三亚", "Sanya"],
    ["桂林", "Guilin"], ["济南", "Jinan"], ["石家庄", "Shijiazhuang"], ["太原", "Taiyuan"],
    ["洛阳", "Luoyang"], ["开封", "Kaifeng"], ["合肥", "Hefei"], ["福州", "Fuzhou"],
    ["哈尔滨", "Harbin"], ["沈阳", "Shenyang"], ["大连", "Dalian"], ["南阳", "Nanyang"],
    ["安阳", "Anyang"], ["新乡", "Xinxiang"], ["许昌", "Xuchang"], ["焦作", "Jiaozuo"],
  ];
  const REGIONS = [
    ["河南", "Henan"], ["河北", "Hebei"], ["山西", "Shanxi"], ["陕西", "Shaanxi"], ["山东", "Shandong"],
  ];
  const TRAVEL = /自驾|高铁|租车|行程|路书|出游|旅游|旅行|游玩|出发|抵达|途经|景点|住宿|美食|周末|这周|假期|玩|\d+\s*天|去|到|至|from|to|trip|drive|weekend|days/i;
  const UNCERTAIN = /推荐|帮我|其他|只有|只看|只在|只去|看看|随便|不知道|还没|么|recommend|only in/i;

  let draft = blank();
  let log = [];
  let confirmed = null;

  function blank() {
    return {
      origin: "",
      destination: "",
      originAssumed: false,
      destAssumed: false,
      days: null,
      daysExplicit: false,
      startDate: "",
      whenLabel: "",
      onlyRegion: "",
      recommend: false,
      softNotes: [],
      softPace: "",
      routeFromText: false,
      hasTravelCue: false,
      acknowledged: false,
      forceDays: false,
    };
  }

  function pickSoftNotes(text) {
    const src = String(text || "");
    const notes = [];
    let softPace = "";
    if (/不要太累|别太累|别太赶|不要太赶|不赶|轻松|慢游|悠闲|慢一点|带老人/.test(src)) {
      if (/不要太累|别太累/.test(src)) notes.push("不要太累");
      else if (/别太赶|不要太赶|不赶/.test(src)) notes.push("别太赶");
      else if (/轻松|慢游|悠闲|慢一点/.test(src)) notes.push("轻松慢游");
      else notes.push("不要太累");
      softPace = "relaxed";
    }
    return { notes, softPace };
  }

  function lang() {
    if (typeof document === "undefined" || !document.documentElement) return "zh";
    return document.documentElement.dataset.lang === "en" ? "en" : "zh";
  }

  function tr(key, vars) {
    if (typeof window !== "undefined" && window.t) return window.t(key, vars);
    return key;
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function iso(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function upcomingSaturday(now) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekday = date.getDay();
    if (weekday === 0) date.setDate(date.getDate() + 6);
    else date.setDate(date.getDate() + (6 - weekday));
    return date;
  }

  function normalize(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/这周么|这周未|这个周末/g, "这周末");
  }

  function cleanPlace(name) {
    const text = String(name || "").trim();
    if (text.length > 2 && /[市省]$/.test(text)) return text.slice(0, -1);
    return text;
  }

  function resolvePlace(raw) {
    const text = cleanPlace(raw);
    if (!text) return "";
    const lower = text.toLowerCase();
    for (let i = 0; i < PLACES.length; i += 1) {
      const zh = PLACES[i][0];
      const en = PLACES[i][1];
      if (text === zh || lower === en.toLowerCase() || text.includes(zh)) return zh;
    }
    if (/^[\u4e00-\u9fff]{2,8}$/.test(text)) return text;
    return "";
  }

  function resolveRegion(raw) {
    const text = cleanPlace(String(raw || "").replace(/[^A-Za-z\u4e00-\u9fff]/g, ""));
    const lower = text.toLowerCase();
    for (let i = 0; i < REGIONS.length; i += 1) {
      const en = String(REGIONS[i][1] || "").toLowerCase();
      if (text === REGIONS[i][0] || lower === en || text.startsWith(REGIONS[i][0])) {
        return REGIONS[i][0];
      }
    }
    return "";
  }

  function regionEn(name) {
    for (let i = 0; i < REGIONS.length; i += 1) {
      if (REGIONS[i][0] === name) return REGIONS[i][1];
    }
    return name;
  }

  function readDraft(text, form, today) {
    const src = normalize(text);
    const base = form || {};
    const next = blank();
    next.hasTravelCue = TRAVEL.test(src);
    next.recommend = /推荐|帮我|其他的|其余|recommend/i.test(src);
    const fromTo = src.match(/从\s*([^\s，,。]{2,8}?)\s*(?:去|到|至)\s*([^\s，,。看只玩游的]{2,8})/);
    if (fromTo) {
      next.origin = resolvePlace(fromTo[1]);
      next.destination = resolvePlace(fromTo[2]);
      next.routeFromText = !!(next.origin && next.destination);
    }
    if (!next.routeFromText) {
      const english = src.match(/from\s+([A-Za-z\u4e00-\u9fff' ]{2,20}?)\s+to\s+([A-Za-z\u4e00-\u9fff' ]{2,20})/i);
      if (english) {
        next.origin = resolvePlace(english[1]);
        next.destination = resolvePlace(english[2]);
        next.routeFromText = !!(next.origin && next.destination);
      }
    }
    if (!next.destination) {
      const destHit = src.match(/(?:去|到|至)\s*([^\s，,。看只玩游的]{2,8})/);
      const city = destHit && resolvePlace(destHit[1]);
      if (city) next.destination = city;
    }
    const dayHit = src.match(/(\d+)\s*(?:天|days?)/i);
    if (dayHit) {
      next.days = Math.max(1, Math.min(14, Number(dayHit[1])));
      next.daysExplicit = true;
    }
    if (/这周末|this weekend/i.test(src)) {
      next.whenLabel = "weekend";
      next.startDate = iso(upcomingSaturday(today || new Date()));
      if (!next.daysExplicit) next.days = 2;
    }
    const regionHit = src.match(/(?:只看|只有|只在|只去|only in)\s*([A-Za-z\u4e00-\u9fff]{2,12})/i);
    if (regionHit) next.onlyRegion = resolveRegion(regionHit[1]);
    const soft = pickSoftNotes(src);
    if (soft.notes.length) {
      next.softNotes = soft.notes;
      next.softPace = soft.softPace;
    } else if (Array.isArray(base.softNotes) && base.softNotes.length) {
      next.softNotes = base.softNotes.slice();
      next.softPace = base.softPace || "";
    }
    if (!next.origin && base.origin) {
      next.origin = String(base.origin).trim();
      next.originAssumed = true;
    }
    if (!next.destination && base.destination) {
      next.destination = String(base.destination).trim();
      next.destAssumed = true;
    }
    if (!next.days && base.days) next.days = Number(base.days) || null;
    if (!next.startDate && base.startDate && next.whenLabel !== "weekend") next.startDate = base.startDate;
    return next;
  }

  function nextStep(state) {
    if (!state.hasTravelCue && !state.routeFromText) return { slot: "intent" };
    if (!state.origin) return { slot: "origin" };
    if (!state.destination) return { slot: "destination" };
    if (state.forceDays) return { slot: "days" };
    if ((state.originAssumed || state.destAssumed) && !state.acknowledged) return { slot: "confirm" };
    if (!state.whenLabel && !state.daysExplicit) return { slot: "when" };
    return { slot: "confirm" };
  }

  function shouldTalk(text, form, autoSentence) {
    const q = String(text || "").trim();
    if (!q) return true;
    if (autoSentence && q === autoSentence) return false;
    if (confirmed && confirmed.query === q) return false;
    const state = readDraft(q, form);
    if (!state.hasTravelCue && !state.routeFromText) return true;
    if (UNCERTAIN.test(q) || UNCERTAIN.test(normalize(q))) return true;
    if (state.originAssumed || state.destAssumed) return true;
    if (!state.origin || !state.destination) return true;
    if (!state.daysExplicit && !state.whenLabel) return true;
    return false;
  }

  function compose(state, language) {
    const days = state.days || 2;
    const useEn = language === "en";
    const when = state.whenLabel === "weekend"
      ? (useEn ? "This weekend" : "这周末")
      : (state.startDate ? (useEn ? "Starting " + state.startDate : state.startDate + "出发") : "");
    const region = state.onlyRegion
      ? (useEn ? ", sightseeing only in " + regionEn(state.onlyRegion) : "，只在" + state.onlyRegion + "游玩")
      : "";
    const soft = (state.softNotes || []).filter(Boolean);
    const softZh = soft.length ? "，" + soft.join("，") : "";
    const softEn = soft.length
      ? ", keep it easy" + (soft.some((n) => /累|赶/.test(n)) ? " and not too tiring" : "")
      : "";
    const rec = state.recommend
      ? (useEn ? ". Please recommend the route, sights, food and stays." : "，其余路线、景点和吃住请推荐。")
      : (useEn ? "." : "。");
    if (useEn) {
      return (when ? when + ", " : "") + "from " + state.origin + " to " + state.destination + ", " + days + " days" + region + softEn + rec;
    }
    return (when ? when : "") + "从" + state.origin + "去" + state.destination + "，玩" + days + "天" + region + softZh + rec;
  }

  function applyUtterance(state, raw) {
    const text = normalize(raw);
    const next = Object.assign({}, state);
    if (/^(对|是的?|好的?|可以|确认|确定|就这样|就这|ok|yes|yep|looks right)$/i.test(text)) {
      next.originAssumed = false;
      next.destAssumed = false;
      next.acknowledged = true;
      next.forceDays = false;
      return { draft: next, intent: "confirm" };
    }
    if (/改天数|换天数|change days/i.test(text)) {
      next.daysExplicit = false;
      next.whenLabel = "";
      next.forceDays = true;
      return { draft: next, intent: "revise" };
    }
    if (/换目的地|改目的地|change destination/i.test(text)) {
      next.destination = "";
      next.destAssumed = false;
      next.acknowledged = false;
      return { draft: next, intent: "revise" };
    }
    if (/换出发地|改出发地|change origin/i.test(text)) {
      next.origin = "";
      next.originAssumed = false;
      next.acknowledged = false;
      return { draft: next, intent: "revise" };
    }
    const parsed = readDraft(text, {});
    if (parsed.routeFromText) {
      next.origin = parsed.origin;
      next.destination = parsed.destination;
      next.originAssumed = false;
      next.destAssumed = false;
      next.hasTravelCue = true;
      next.routeFromText = true;
    }
    if (!parsed.routeFromText && parsed.destination && !parsed.destAssumed) {
      next.destination = parsed.destination;
      next.destAssumed = false;
      next.hasTravelCue = true;
    }
    if (parsed.daysExplicit) {
      next.days = parsed.days;
      next.daysExplicit = true;
      next.forceDays = false;
      next.hasTravelCue = true;
    }
    if (parsed.whenLabel === "weekend") {
      next.whenLabel = "weekend";
      next.startDate = parsed.startDate;
      if (!parsed.daysExplicit) next.days = 2;
      next.forceDays = false;
      next.hasTravelCue = true;
    }
    if (parsed.onlyRegion) next.onlyRegion = parsed.onlyRegion;
    if (parsed.recommend) next.recommend = true;
    if (parsed.softNotes && parsed.softNotes.length) {
      next.softNotes = parsed.softNotes.slice();
      next.softPace = parsed.softPace || next.softPace || "";
    }
    const bare = resolvePlace(text);
    const step = nextStep(state);
    if (bare && text.replace(bare, "").replace(/市|省/g, "").trim().length === 0) {
      if (step.slot === "origin" || step.slot === "intent") {
        next.origin = bare;
        next.originAssumed = false;
        next.hasTravelCue = true;
      } else if (step.slot === "destination") {
        next.destination = bare;
        next.destAssumed = false;
        next.hasTravelCue = true;
      }
    }
    if (step.slot === "when" && /上面的日期|表单|keep the date/i.test(text)) {
      next.whenLabel = "form";
      next.daysExplicit = true;
      next.days = next.days || state.days || 7;
    }
    if (
      !parsed.routeFromText &&
      !bare &&
      !parsed.daysExplicit &&
      !parsed.whenLabel &&
      !parsed.onlyRegion &&
      !(parsed.softNotes && parsed.softNotes.length)
    ) {
      return { draft: next, intent: "unknown" };
    }
    return { draft: next, intent: "revise" };
  }

  function question(state) {
    const step = nextStep(state);
    const sentence = state.origin && state.destination ? compose(state, lang()) : "";
    const lead = sentence ? tr("understood", { text: sentence }) + " " : "";
    const ask = {
      intent: tr("askIntent"),
      origin: tr("askOrigin"),
      destination: tr("askDest"),
      when: tr("askWhen"),
      days: tr("askDays"),
      confirm: tr("askConfirm"),
    }[step.slot];
    return lead + ask;
  }

  function chipsFor(state) {
    const slot = nextStep(state).slot;
    if (slot === "intent" || slot === "origin") {
      return [
        ["北京", "北京"],
        ["上海", "上海"],
        ["成都", "成都"],
        [tr("chipBjZz"), "从北京去郑州"],
      ];
    }
    if (slot === "destination") {
      return [["郑州", "郑州"], ["成都", "成都"], ["杭州", "杭州"], ["洛阳", "洛阳"], ["开封", "开封"]];
    }
    if (slot === "when" || slot === "days") {
      return [
        [tr("chipWeekend"), "这周末"],
        [tr("chip3"), "3天"],
        [tr("chip5"), "5天"],
        [tr("chip7"), "7天"],
      ];
    }
    return [
      [tr("chipOk"), "就这样"],
      [tr("chipChangeDays"), "改天数"],
      [tr("chipChangeDest"), "换目的地"],
    ];
  }

  function $(id) { return document.getElementById(id); }

  function render() {
    const box = $("chatLogMobile");
    if (!box || document.body.dataset.sheetMode === "edit") return;
    box.replaceChildren();
    log.forEach((item) => {
      const row = document.createElement("div");
      row.className = "chat-msg " + (item.role === "user" ? "user" : "bot");
      row.textContent = item.text;
      box.appendChild(row);
    });
    box.scrollTop = box.scrollHeight;
    const chips = $("quickChipsMobile");
    if (chips) {
      chips.replaceChildren();
      chipsFor(draft).forEach((pair) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "quick-chip";
        btn.textContent = pair[0];
        btn.addEventListener("click", () => submit(pair[1]));
        chips.appendChild(btn);
      });
    }
    const confirmBtn = $("briefConfirm");
    if (confirmBtn) confirmBtn.hidden = document.body.dataset.sheetMode !== "brief" || nextStep(draft).slot !== "confirm";
    const input = $("chatInputMobile");
    if (input && document.body.dataset.sheetMode === "brief") input.placeholder = tr("chatPhBrief");
  }

  function pushBot() {
    log.push({ role: "bot", text: question(draft) });
    render();
  }

  function seedFromForm(form) {
    const text = (form && form.query) || "";
    draft = readDraft(text, form || {});
    log = [];
    pushBot();
  }

  function safety(text) {
    const q = String(text || "").trim();
    if (q.length > 200) return tr("queryLong");
    if (/(忽略|无视).{0,12}(指令|规则|提示)|system\s*prompt|jailbreak/i.test(q)) return tr("queryInject");
    if (/毒品|冰毒|海洛因|大麻|制毒|炸药|炸弹|枪支|买枪|军火|色情|裸聊|招嫖|诈骗|洗钱|木马|入侵系统|儿童色情/.test(q)) {
      return tr("queryIllegal");
    }
    return "";
  }

  function commit() {
    if (!draft.origin || !draft.destination) {
      pushBot();
      return;
    }
    draft.originAssumed = false;
    draft.destAssumed = false;
    draft.acknowledged = true;
    document.body.dataset.queryLocked = "1";
    const sentence = compose(draft, lang());
    if ($("query")) $("query").value = sentence;
    if ($("origin")) $("origin").value = draft.origin;
    if ($("destination")) $("destination").value = draft.destination;
    if ($("days") && draft.days) $("days").value = String(draft.days);
    if ($("startDate") && draft.startDate) $("startDate").value = draft.startDate;
    if (draft.softPace === "relaxed") {
      const paceChip = document.querySelector('.pref-row[data-pref="pace"] .pref-chip[data-value="relaxed"]');
      if (paceChip) {
        document.querySelectorAll('.pref-row[data-pref="pace"] .pref-chip').forEach((el) => el.classList.remove("active"));
        paceChip.classList.add("active");
      }
    }
    confirmed = { query: sentence, onlyRegion: draft.onlyRegion || "" };
    if ($("status")) $("status").textContent = tr("briefWritten");
    closeSheet();
  }

  function submit(raw) {
    const text = String(raw || "").trim();
    if (!text) return;
    const blocked = safety(text);
    if (blocked) {
      log.push({ role: "user", text: text });
      log.push({ role: "bot", text: blocked });
      render();
      return;
    }
    const result = applyUtterance(draft, text);
    draft = result.draft;
    log.push({ role: "user", text: text });
    if ($("chatInputMobile")) $("chatInputMobile").value = "";
    if (result.intent === "confirm" && nextStep(draft).slot === "confirm") {
      log.push({ role: "bot", text: tr("briefWritten") });
      render();
      commit();
      return;
    }
    if (result.intent === "unknown") {
      log.push({ role: "bot", text: question(draft) });
      render();
      return;
    }
    pushBot();
  }

  function setMode(mode) {
    const next = mode === "edit" ? "edit" : "brief";
    if (next === "edit" && !document.body.classList.contains("has-trip")) {
      document.body.dataset.sheetMode = "brief";
      if (!log.length) seedFromForm(readForm());
      else {
        log.push({ role: "bot", text: tr("editNeedTrip") });
        render();
      }
      markTabs("brief");
      return;
    }
    document.body.dataset.sheetMode = next;
    markTabs(next);
    const confirmBtn = $("briefConfirm");
    if (confirmBtn) confirmBtn.hidden = next !== "brief" || nextStep(draft).slot !== "confirm";
    if (next === "edit") {
      document.dispatchEvent(new CustomEvent("roadbook-sheet-mode", { detail: "edit" }));
      if ($("chatInputMobile")) $("chatInputMobile").placeholder = tr("chatPhEdit");
    } else {
      render();
    }
  }

  function markTabs(mode) {
    const briefBtn = $("sheetModeBrief");
    const editBtn = $("sheetModeEdit");
    if (briefBtn) briefBtn.classList.toggle("active", mode === "brief");
    if (editBtn) editBtn.classList.toggle("active", mode === "edit");
  }

  function open(mode) {
    if (document.body.classList.contains("share-mode")) return;
    const want = mode || (document.body.classList.contains("has-trip") ? "edit" : "brief");
    if (want === "brief" && !log.length) seedFromForm(readForm());
    setMode(want);
    const backdrop = $("chatSheetBackdrop");
    if (backdrop) {
      backdrop.classList.add("open");
      backdrop.setAttribute("aria-hidden", "false");
    }
    setTimeout(() => $("chatInputMobile")?.focus(), 60);
  }

  function closeSheet() {
    const backdrop = $("chatSheetBackdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
  }

  function readForm() {
    return {
      query: $("query") ? $("query").value : "",
      origin: $("origin") ? $("origin").value.trim() : "",
      destination: $("destination") ? $("destination").value.trim() : "",
      days: $("days") ? $("days").value : "",
      startDate: $("startDate") ? $("startDate").value : "",
    };
  }

  function beforeGenerate(form) {
    const text = (form && form.query) || "";
    const blocked = safety(text);
    if (blocked && text.trim()) return blocked;
    if (!shouldTalk(text, form, form && form.autoSentence)) {
      const state = readDraft(text, {});
      if (state.routeFromText) {
        draft = state;
        if ($("origin")) $("origin").value = state.origin;
        if ($("destination")) $("destination").value = state.destination;
        if ($("days") && state.days) $("days").value = String(state.days);
        if ($("startDate") && state.startDate) $("startDate").value = state.startDate;
        confirmed = { query: text.trim(), onlyRegion: state.onlyRegion || "" };
      }
      return "";
    }
    seedFromForm(form);
    open("brief");
    return tr("briefNeed");
  }

  function retargetFromForm(form) {
    if (!confirmed || !form) return;
    if (form.origin) draft.origin = form.origin;
    if (form.destination) draft.destination = form.destination;
    if (form.days) {
      draft.days = Number(form.days);
      draft.daysExplicit = true;
    }
    if (form.startDate && form.startDate !== draft.startDate) {
      draft.whenLabel = "form";
      draft.startDate = form.startDate;
    }
    draft.originAssumed = false;
    draft.destAssumed = false;
    const sentence = compose(draft, lang());
    if ($("query")) $("query").value = sentence;
    confirmed = { query: sentence, onlyRegion: draft.onlyRegion || "" };
  }

  function onlyRegion() {
    const current = $("query") ? $("query").value.trim() : "";
    if (!confirmed || confirmed.query !== current) return "";
    return confirmed.onlyRegion || "";
  }

  function mount() {
    if (!document.body || document.body.classList.contains("share-mode")) return;
    $("openBriefChat")?.addEventListener("click", () => {
      log = [];
      seedFromForm(readForm());
      open("brief");
    });
    $("sheetModeBrief")?.addEventListener("click", () => {
      if (!log.length) seedFromForm(readForm());
      setMode("brief");
      $("chatSheetBackdrop")?.classList.add("open");
    });
    $("sheetModeEdit")?.addEventListener("click", () => {
      setMode("edit");
      $("chatSheetBackdrop")?.classList.add("open");
      $("chatSheetBackdrop")?.setAttribute("aria-hidden", "false");
      setTimeout(() => $("chatInputMobile")?.focus(), 60);
    });
    $("briefConfirm")?.addEventListener("click", commit);
    $("chatSendMobile")?.addEventListener("click", () => {
      if (document.body.dataset.sheetMode === "brief") submit($("chatInputMobile").value);
    });
    $("chatInputMobile")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && document.body.dataset.sheetMode === "brief") {
        event.preventDefault();
        event.stopPropagation();
        submit($("chatInputMobile").value);
      }
    });
    $("openBriefFromCopilot")?.addEventListener("click", () => {
      log = [];
      seedFromForm(readForm());
      open("brief");
    });
    document.addEventListener("roadbook-lang", () => {
      if (confirmed) retargetFromForm(readForm());
      if (document.body.dataset.sheetMode === "brief") render();
    });
  }

  return {
    readDraft: readDraft,
    nextStep: nextStep,
    shouldTalk: shouldTalk,
    compose: compose,
    applyUtterance: applyUtterance,
    upcomingSaturday: upcomingSaturday,
    iso: iso,
    beforeGenerate: beforeGenerate,
    open: open,
    onlyRegion: onlyRegion,
    retargetFromForm: retargetFromForm,
    mount: mount,
  };
});
