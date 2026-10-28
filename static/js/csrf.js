(function () {
  const read = () => {
    const m = document.cookie.match(/(?:^|; )rb_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : "";
  };
  const orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const opts = init ? Object.assign({}, init) : {};
    const method = String(opts.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const token = read();
      const headers = new Headers(opts.headers || {});
      if (token && !headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", token);
      opts.headers = headers;
      if (!opts.credentials) opts.credentials = "same-origin";
    }
    return orig(input, opts);
  };
})();
