(function () {
  const $ = (id) => document.getElementById(id);
  const nextUrl =
    typeof window.__LOGIN_NEXT__ === "string" && window.__LOGIN_NEXT__.startsWith("/")
      ? window.__LOGIN_NEXT__
      : "/";

  let sendCooldown = 0;
  let sendTimer = null;
  let sending = false;
  let verifying = false;
  let captchaId = "";

  const loadCaptcha = async () => {
    const box = $("authCaptchaImg");
    try {
      const r = await fetch("/api/auth/captcha", { credentials: "same-origin" });
      const data = await r.json();
      captchaId = data.captcha_id || "";
      if (box) box.innerHTML = data.image_svg || "";
    } catch (_) {
      if (box) box.textContent = "刷新";
    }
  };
  loadCaptcha();
  $("authCaptchaImg")?.addEventListener("click", loadCaptcha);

  /** 已登录则 replace 离开登录页（避免浏览器「返回」从 bfcache 又露出登录表单） */
  const leaveIfLoggedIn = async () => {
    try {
      const r = await fetch("/api/auth/me", { credentials: "same-origin" });
      const data = await r.json();
      if (data && data.logged_in) {
        window.location.replace(nextUrl);
      }
    } catch (_) { /* ignore */ }
  };
  leaveIfLoggedIn();
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) leaveIfLoggedIn();
  });

  const setStatus = (msg) => {
    const el = $("authStatus");
    if (el) el.textContent = msg || "";
  };

  const phoneOk = (phone) => /^1\d{10}$/.test(phone);

  const startCooldown = (seconds) => {
    sendCooldown = Math.max(0, Number(seconds) || 0);
    if (sendTimer) {
      clearInterval(sendTimer);
      sendTimer = null;
    }
    const tick = () => {
      const b = $("authSendCode");
      if (b) {
        b.disabled = sendCooldown > 0 || sending;
        b.textContent = sendCooldown > 0 ? `${sendCooldown}s` : (window.t ? t("loginSend") : "获取验证码");
      }
      if (sendCooldown <= 0) {
        clearInterval(sendTimer);
        sendTimer = null;
        return;
      }
      sendCooldown -= 1;
    };
    tick();
    if (sendCooldown > 0) sendTimer = setInterval(tick, 1000);
  };

  $("authSendCode")?.addEventListener("click", async () => {
    if (sendCooldown > 0 || sending) return;
    const phone = ($("authPhone")?.value || "").trim();
    if (!phoneOk(phone)) {
      setStatus("请输入大陆 11 位手机号");
      return;
    }
    sending = true;
    const btn = $("authSendCode");
    if (btn) btn.disabled = true;
    setStatus("发送中…");
    try {
      const r = await fetch("/api/auth/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          phone,
          captcha_id: captchaId,
          captcha_code: ($("authCaptcha")?.value || "").trim(),
        }),
      });
      const data = await r.json();
          if (!data.ok) {
            setStatus(data.message || "发送失败");
            if (data.captcha_invalid) loadCaptcha();
            if (data.retry_after) startCooldown(data.retry_after);
            else if (btn) btn.disabled = false;
            return;
          }
          loadCaptcha();
          const cap = $("authCaptcha");
          if (cap) cap.value = "";
      const rem = typeof data.remaining === "number" ? data.remaining : null;
      setStatus(
        rem != null
          ? `${data.message || "已发送"}（今日还可发送 ${rem} 次）`
          : data.message || "已发送"
      );
      startCooldown(data.retry_after || 60);
    } catch (e) {
      setStatus(String(e.message || e));
      if (btn) btn.disabled = false;
    } finally {
      sending = false;
    }
  });

  const doLogin = async () => {
    if (verifying) return;
    const phone = ($("authPhone")?.value || "").trim();
    const code = ($("authCode")?.value || "").trim();
    if (!phoneOk(phone)) {
      setStatus("请输入大陆 11 位手机号");
      return;
    }
    if (!code || code.length < 4) {
      setStatus("请输入验证码");
      return;
    }
    verifying = true;
    const submit = $("authSubmit");
    if (submit) submit.disabled = true;
    setStatus("验证中…");
    try {
      const r = await fetch("/api/auth/sms/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ phone, code }),
      });
      const data = await r.json();
      if (!data.ok) {
        setStatus(data.message || "登录失败");
        return;
      }
      setStatus("登录成功，正在进入…");
      window.location.replace(nextUrl);
    } catch (e) {
      setStatus(String(e.message || e));
    } finally {
      verifying = false;
      if (submit) submit.disabled = false;
    }
  };

  $("authSubmit")?.addEventListener("click", doLogin);
  $("authCode")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
})();
