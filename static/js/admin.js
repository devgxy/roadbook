(function () {
  const $ = (id) => document.getElementById(id);
  const msg = (t) => { const el = $("adminMsg"); if (el) el.textContent = t || ""; };

  async function loadBoard() {
    const r = await fetch("/api/admin/summary", { credentials: "same-origin" });
    if (r.status === 401) return;
    const data = await r.json();
    if (!data.ok) return;
    $("adminLogin")?.classList.add("hidden");
    $("adminBoard")?.classList.remove("hidden");
    const rows = data.series || [];
    const head = ["日期", "人数", "打开", "开始生成", "生成完成", "失败", "对话改", "海报", "分享打开", "手机预览"];
    const keys = ["day", "people", "page_view", "plan_start", "plan_done", "plan_fail", "chat_edit", "poster_open", "share_view", "phone_preview"];
    const table = $("adminSeries");
    if (table) {
      table.innerHTML = "<tr>" + head.map((h) => `<th>${h}</th>`).join("") + "</tr>" +
        rows.map((row) => "<tr>" + keys.map((k) => `<td>${row[k] ?? 0}</td>`).join("") + "</tr>").join("");
    }
    const modes = data.modes || {};
    if ($("adminModes")) {
      $("adminModes").textContent = Object.keys(modes).length
        ? Object.entries(modes).map(([k, v]) => `${k} ${v}`).join(" · ")
        : "还没有生成完成记录";
    }
    const cats = data.feedback_categories || {};
    if ($("adminCats")) {
      $("adminCats").textContent = Object.keys(cats).length
        ? Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(" · ") + ` · 共 ${data.feedback_total || 0} 条`
        : "还没有反馈";
    }
    const box = $("adminFeedback");
    if (box) {
      const list = data.feedback || [];
      box.innerHTML = list.length ? list.map((item) => {
        const when = new Date((item.at || 0) * 1000).toLocaleString();
        return `<article class="admin-card"><header><b>${item.category || "其他"}</b><span>${item.phone || "未登录"} · ${when}</span></header><p>${item.text || ""}</p></article>`;
      }).join("") : '<p class="admin-sub">暂无</p>';
    }
  }

  $("adminLogin")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg("验证中…");
    const r = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: $("adminPass")?.value || "" }),
    });
    const data = await r.json();
    if (!data.ok) {
      msg(data.message || "失败");
      return;
    }
    msg("");
    loadBoard();
  });
  loadBoard();
})();
