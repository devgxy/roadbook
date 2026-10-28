(function () {
  const DICT = {
    zh: {
      brand: "Roadbook · 自驾路书",
      title: "自驾路书",
      sub: "真实沿途分段 · 一键导航 · 日均动态预算 · 对话微调 · 微信分享海报。",
      phonePreview: "手机预览",
      phoneExit: "退出预览",
      logout: "退出",
      history: "历史路书",
      feedback: "意见反馈",
      settings: "设置",
      account: "账号",
      appearance: "外观",
      origin: "出发地",
      destination: "目的地",
      days: "天数",
      startDate: "出发日期",
      paceLabel: "行程节奏",
      paceRelaxed: "轻松慢游",
      paceBalanced: "经典均衡",
      paceHard: "特种兵",
      themeLabel: "同行主题",
      themeLandmark: "经典地标",
      themeFamily: "亲子友好",
      themePhoto: "人文摄影",
      themeFood: "烟火美食",
      budgetLabel: "吃住玩日均档位（自动随天数和车费联动总区间）",
      budgetEconomy: "经济省钱 · 日均 ¥150~260/人",
      budgetComfort: "舒适口碑 · 日均 ¥260~420/人",
      budgetPremium: "品质度假 · 日均 ¥450~780/人",
      travelLabel: "出行方式",
      travelDrive: "全程自驾",
      travelHsr: "高铁 + 到站租车",
      highwayLabel: "路线偏好",
      highwayExpress: "高速优先",
      highwayScenic: "少走高速",
      queryLabel: "需求描述",
      queryPh: "例如：这周末从北京去郑州，只看河南，其他帮我推荐",
      briefOpen: "信息不全就点这里说。确认后，这句话会写回上面。",
      generate: "生成路书",
      regenerate: "重新生成",
      planSummaryEdit: "改需求",
      prefSummaryEdit: "改偏好",
      copyShareLink: "复制链接",
      copyShareUnavailable: "链接未就绪",
      copyPrevShare: "复制上一版链接",
      posterShareReady: "这一版已可扫码或复制链接发出",
      posterShareFail: "分享未写成，先不要把海报当扫码入口",
      posterTitle: "发出这一版",
      copilotHello: "第 1 天在左边。要改就说一句，例如：中间加西安。",
      exHsr: "北京 → 成都 · 高铁+租车",
      exBjCd: "北京 → 成都 · 7天自驾",
      exShHz: "上海 → 杭州 · 3天",
      exXaLz: "西安 → 兰州 · 5天",
      itinerary: "逐日路书",
      copilotTitle: "路书副驾驶",
      undo: "撤销",
      copilotRewrite: "重写需求",
      budgetTitle: "自驾预算估算",
      checklistTitle: "行前检查清单",
      tipsTitle: "避坑指南和住宿",
      foodTitle: "必吃清单",
      dockBrief: "用对话说清这次出行",
      dockEdit: "改路书",
      dockPh: "说一句改路线，例如：中间加西安 / 第二天别太赶",
      dockPhDay: "改第 {n} 天：换成某一站 / 少赶路…",
      dockSave: "收藏",
      dockHistory: "历史",
      dockPoster: "海报",
      modeBrief: "说清需求",
      modeEdit: "改这条路书",
      closeSheet: "收起",
      briefConfirm: "确定，写回需求描述",
      briefWritten: "需求已写回。可以点生成路书。",
      briefNeed: "还没说完。先补全这句出行需求。",
      askIntent: "我还看不出这是一次出行。直接说从哪到哪，比如「这周末从北京去郑州」。",
      askOrigin: "从哪个城市出发？",
      askDest: "想去哪个城市？",
      askWhen: "玩几天，或者这周末出发？",
      askDays: "想玩几天？",
      askConfirm: "就按这句话安排吗？要改直接说。",
      understood: "我先理解成：{text}",
      chipWeekend: "这周末",
      chip3: "3天",
      chip5: "5天",
      chip7: "7天",
      chipOk: "就这样",
      chipChangeDays: "改天数",
      chipChangeDest: "换目的地",
      chipBjZz: "从北京去郑州",
      chatPhBrief: "直接补充，例如：只在河南、玩3天",
      chatPhEdit: "如：中间加西安 / 不去运城 / 玩8天",
      chatSend: "发送",
      chatAdjust: "调整",
      feedbackTitle: "意见反馈",
      feedbackHint: "说说哪里不准、哪里难用，或你希望加上的功能。不会上传完整路书。",
      feedbackSend: "提交",
      historyTitle: "历史路书夹",
      close: "关闭",
      downloadPoster: "下载 PNG",
      queryLong: "需求描述请控制在 200 字以内",
      queryInject: "请只描述这次出行，不要写其它指令",
      queryIllegal: "这段内容和出行路书无关，无法生成",
      queryEmpty: "先用对话把出行说清楚",
      editNeedTrip: "还没有生成路书。先在「说清需求」里确认，再生成。",
      themeLight: "浅色",
      themeDark: "深色",
      langZh: "中",
      langEn: "EN",
    },
    en: {
      brand: "Roadbook",
      title: "Roadbook",
      sub: "Real segments, navigation, daily budget, chat edits, and a share poster.",
      phonePreview: "Phone preview",
      phoneExit: "Exit preview",
      logout: "Log out",
      history: "History",
      feedback: "Feedback",
      settings: "Settings",
      account: "Account",
      appearance: "Appearance",
      origin: "From",
      destination: "To",
      days: "Days",
      startDate: "Start date",
      paceLabel: "Pace",
      paceRelaxed: "Easy",
      paceBalanced: "Balanced",
      paceHard: "Packed",
      themeLabel: "Theme",
      themeLandmark: "Landmarks",
      themeFamily: "Family",
      themePhoto: "Photo",
      themeFood: "Food",
      budgetLabel: "Daily stay, food and tickets (total updates with days and driving)",
      budgetEconomy: "Budget · ¥150–260 / person / day",
      budgetComfort: "Comfort · ¥260–420 / person / day",
      budgetPremium: "Premium · ¥450–780 / person / day",
      travelLabel: "How you travel",
      travelDrive: "Drive the whole way",
      travelHsr: "High-speed rail + rental car",
      highwayLabel: "Roads",
      highwayExpress: "Highways first",
      highwayScenic: "Fewer highways",
      queryLabel: "Trip request",
      queryPh: "e.g. This weekend from Beijing to Zhengzhou, Henan only, recommend the rest",
      briefOpen: "If this is incomplete, talk it through. Confirm to write it back here.",
      generate: "Create roadbook",
      regenerate: "Regenerate",
      planSummaryEdit: "Edit request",
      prefSummaryEdit: "Edit prefs",
      copyShareLink: "Copy link",
      copyShareUnavailable: "Link not ready",
      copyPrevShare: "Copy previous link",
      posterShareReady: "This version is ready to scan or copy",
      posterShareFail: "Share link failed — don't treat the poster QR as live",
      posterTitle: "Send this version",
      copilotHello: "Day 1 is on the left. Say one change, e.g. add Xi'an in the middle.",
      exHsr: "Beijing → Chengdu · rail + car",
      exBjCd: "Beijing → Chengdu · 7 days",
      exShHz: "Shanghai → Hangzhou · 3 days",
      exXaLz: "Xi'an → Lanzhou · 5 days",
      itinerary: "Day by day",
      copilotTitle: "Copilot",
      undo: "Undo",
      copilotRewrite: "Rewrite request",
      budgetTitle: "Driving budget",
      checklistTitle: "Before you go",
      tipsTitle: "Pitfalls and stays",
      foodTitle: "Food list",
      dockBrief: "Describe this trip in chat",
      dockEdit: "Edit trip",
      dockPh: "Change the route in one line, e.g. add Xi'an / ease up day 2",
      dockPhDay: "Edit day {n}: swap a stop / less driving…",
      dockSave: "Save",
      dockHistory: "History",
      dockPoster: "Poster",
      modeBrief: "Describe trip",
      modeEdit: "Edit roadbook",
      closeSheet: "Close",
      briefConfirm: "Confirm and write it back",
      briefWritten: "Request saved. You can create the roadbook.",
      briefNeed: "Still incomplete. Finish the trip request in chat.",
      askIntent: "I can't tell this is a trip yet. Say where you're going, for example “this weekend from Beijing to Zhengzhou”.",
      askOrigin: "Which city are you leaving from?",
      askDest: "Which city are you going to?",
      askWhen: "How many days, or leave this weekend?",
      askDays: "How many days?",
      askConfirm: "Plan it like this? Say what to change, or confirm.",
      understood: "Here is what I heard: {text}",
      chipWeekend: "This weekend",
      chip3: "3 days",
      chip5: "5 days",
      chip7: "7 days",
      chipOk: "Looks right",
      chipChangeDays: "Change days",
      chipChangeDest: "Change destination",
      chipBjZz: "Beijing to Zhengzhou",
      chatPhBrief: "Add a detail, e.g. Henan only, 3 days",
      chatPhEdit: "e.g. add Xi'an / skip a city / make it 8 days",
      chatSend: "Send",
      chatAdjust: "Update",
      feedbackTitle: "Feedback",
      feedbackHint: "Tell us what was wrong or missing. The full itinerary is not uploaded.",
      feedbackSend: "Send",
      historyTitle: "Saved roadbooks",
      close: "Close",
      downloadPoster: "Download PNG",
      queryLong: "Keep the request within 200 characters",
      queryInject: "Describe the trip only",
      queryIllegal: "This isn't a trip request, so it can't be planned",
      queryEmpty: "Describe the trip in chat first",
      editNeedTrip: "No roadbook yet. Confirm the request, then create one.",
      themeLight: "Light",
      themeDark: "Dark",
      langZh: "中",
      langEn: "EN",
    },
  };

  function lang() {
    return document.documentElement.dataset.lang === "en" ? "en" : "zh";
  }

  function t(key, vars) {
    const pack = DICT[lang()] || DICT.zh;
    let text = pack[key] || DICT.zh[key] || key;
    if (vars) {
      Object.keys(vars).forEach((name) => {
        text = text.split("{" + name + "}").join(String(vars[name]));
      });
    }
    return text;
  }

  function applyI18n() {
    const root = document.documentElement;
    root.lang = lang() === "en" ? "en" : "zh-CN";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.dataset.i18nTitle));
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      el.setAttribute("aria-label", t(el.dataset.i18nAria));
    });
    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.langBtn === lang() ? "true" : "false");
    });
    const theme = root.dataset.theme === "dark" ? "dark" : "light";
    document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.themeBtn === theme ? "true" : "false");
    });
    document.dispatchEvent(new CustomEvent("roadbook-lang"));
  }

  function setLang(next) {
    document.documentElement.dataset.lang = next === "en" ? "en" : "zh";
    try { localStorage.setItem("rb-lang", document.documentElement.dataset.lang); } catch (_) { /* ignore */ }
    applyI18n();
  }

  function setTheme(next) {
    const theme = next === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("rb-theme", theme); } catch (_) { /* ignore */ }
    applyI18n();
    document.dispatchEvent(new CustomEvent("roadbook-theme", { detail: theme }));
  }

  document.addEventListener("click", (event) => {
    const langBtn = event.target.closest("[data-lang-btn]");
    if (langBtn) {
      setLang(langBtn.dataset.langBtn);
      return;
    }
    const themeBtn = event.target.closest("[data-theme-btn]");
    if (themeBtn) setTheme(themeBtn.dataset.themeBtn);
  });

  window.t = t;
  window.applyI18n = applyI18n;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyI18n);
  } else {
    applyI18n();
  }
})();
