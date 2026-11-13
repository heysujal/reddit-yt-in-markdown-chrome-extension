// Shared helpers: floating button, clipboard, markdown formatting.
(() => {
  const MDC = (globalThis.MDC = globalThis.MDC || {});

  MDC.indent = (text, prefix) =>
    String(text ?? "")
      .split("\n")
      .map((line) => (line.trim() ? prefix + line : ""))
      .join("\n");

  MDC.fmtNum = (n) => (n == null || n === "" || isNaN(n) ? String(n ?? "") : Number(n).toLocaleString("en-US"));

  MDC.fmtDate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  // Runs async tasks with a concurrency limit.
  MDC.pool = async (tasks, limit) => {
    let i = 0;
    const worker = async () => {
      while (i < tasks.length) await tasks[i++]();
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  };

  MDC.copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };


  // ---------- options ----------

  MDC.DEFAULT_OPTIONS = { comments: true, images: true };

  MDC.loadOptions = async () => {
    try {
      const saved = await chrome.storage.local.get(Object.keys(MDC.DEFAULT_OPTIONS));
      return { ...MDC.DEFAULT_OPTIONS, ...saved };
    } catch {
      return { ...MDC.DEFAULT_OPTIONS };
    }
  };

  MDC.saveOptions = async (opts) => {
    try {
      await chrome.storage.local.set(opts);
    } catch {}
  };

  // ---------- download ----------

  // Turns a title into a safe file name, e.g. "What's new? (2026)" -> "whats-new-2026".
  MDC.slug = (title) =>
    String(title || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page";

  MDC.download = (md) => {
    const title = md.match(/^# (.+)$/m)?.[1];
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${MDC.slug(title)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  // ---------- floating button ----------

  const COPY_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
  const DOWNLOAD_ICON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 15v3H6v-3H4v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3h-2zm-1-4-1.4-1.4-2.6 2.6V4h-2v8.2L8.4 9.6 7 11l5 5 5-5z"/></svg>';
  const MORE_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

  // Mounts a floating "Copy Markdown" button (plus Download and a ⋯ options menu) that is
  // shown only while isActive(location) is true.
  // build(progress, signal, options) must resolve to the markdown string. Clicking while busy
  // aborts the fetch, and build() should then return whatever it has collected so far.
  MDC.mountButton = ({ label, isActive, build }) => {
    const host = document.createElement("div");
    host.id = "mdc-copy-markdown";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
          display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
          font: 600 15px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        .row { display: flex; box-shadow: 0 6px 20px rgba(0,0,0,.35); border-radius: 999px; }
        button {
          display: flex; align-items: center; gap: 8px; border: 0; cursor: pointer;
          font: inherit; color: #fff; background: #0d7c86; transition: background .15s, transform .1s;
        }
        button:hover { transform: translateY(-1px); }
        button:active { transform: translateY(1px); }
        button:focus-visible { outline: 3px solid #9be7ee; outline-offset: 2px; }
        .main { padding: 14px 18px 14px 22px; border-radius: 999px 0 0 999px; max-width: 380px; }
        .more { padding: 14px 16px 14px 12px; border-radius: 0 999px 999px 0; border-left: 1px solid rgba(255,255,255,.3); }
        .row[data-state="busy"] button { background: #6e40c9; }
        .row[data-state="ok"] button { background: #1a7f37; }
        .row[data-state="ready"] button { background: #bf8700; }
        .row[data-state="err"] button { background: #cf222e; }
        .panel {
          display: none; flex-direction: column; gap: 4px; min-width: 210px; padding: 10px;
          color: #1f2328; background: #fff; border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.3);
          font-weight: 500; font-size: 14px;
        }
        .panel[data-open] { display: flex; }
        label { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-radius: 8px; cursor: pointer; }
        label:hover { background: #f0f3f6; }
        input { width: 16px; height: 16px; margin: 0; accent-color: #0d7c86; cursor: pointer; }
        .dl { padding: 14px 13px; border-left: 1px solid rgba(255,255,255,.3); }
        svg { flex: none; }
      </style>
      <div class="wrap">
        <div class="panel" role="menu">
          <label><input type="checkbox" name="comments" /> Include comments</label>
          <label><input type="checkbox" name="images" /> Include images</label>
        </div>
        <div class="row" data-state="idle">
          <button type="button" class="main" title="Copy this page as Markdown">${COPY_ICON}<span></span></button>
          <button type="button" class="dl" title="Download as a .md file" aria-label="Download Markdown file">${DOWNLOAD_ICON}</button>
          <button type="button" class="more" title="Options" aria-label="Options" aria-haspopup="true" aria-expanded="false">${MORE_ICON}</button>
        </div>
      </div>`;
    const row = root.querySelector(".row");
    const mainBtn = root.querySelector(".main");
    const moreBtn = root.querySelector(".more");
    const panel = root.querySelector(".panel");
    const dlBtn = root.querySelector(".dl");
    const text = mainBtn.querySelector("span");
    const boxes = [...panel.querySelectorAll("input")];

    let options = { ...MDC.DEFAULT_OPTIONS };
    MDC.loadOptions().then((o) => {
      options = o;
      for (const b of boxes) b.checked = !!options[b.name];
    });
    for (const b of boxes) {
      b.addEventListener("change", () => {
        options = { ...options, [b.name]: b.checked };
        MDC.saveOptions(options);
      });
    }

    const setOpen = (open) => {
      if (open) panel.setAttribute("data-open", "");
      else panel.removeAttribute("data-open");
      moreBtn.setAttribute("aria-expanded", String(open));
    };
    moreBtn.addEventListener("click", () => setOpen(!panel.hasAttribute("data-open")));
    document.addEventListener("click", (e) => {
      if (!e.composedPath().includes(host)) setOpen(false);
    });

    let controller = null; // set while a build is running
    let pending = null; // markdown waiting for a click because the clipboard write was rejected
    let resetTimer = null;

    const set = (msg, state) => {
      text.textContent = msg;
      row.dataset.state = state;
    };
    const idle = () => set(label, "idle");
    const flash = (msg, state) => {
      set(msg, state);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(idle, 3500);
    };
    const sizeOf = (md) => (new Blob([md]).size / 1024).toFixed(1) + " KB";

    const finish = async (md, mode) => {
      if (mode === "download") {
        MDC.download(md);
        pending = null;
        return flash(`Downloaded ✓ (${sizeOf(md)})`, "ok");
      }
      if (await MDC.copy(md)) {
        pending = null;
        flash(`Copied ✓ (${sizeOf(md)})`, "ok");
      } else {
        pending = md;
        set("Ready — click again to copy", "ready");
      }
    };

    const run = async (mode) => {
      setOpen(false);
      if (controller) {
        controller.abort();
        set("Stopping…", "busy");
        return;
      }
      if (pending && mode === "copy") return finish(pending, mode);
      pending = null;
      clearTimeout(resetTimer);
      controller = new AbortController();
      try {
        const md = await build((msg) => set(msg + " (click to stop)", "busy"), controller.signal, { ...options });
        await finish(md, mode);
      } catch (e) {
        console.error("[Copy Markdown]", e);
        flash("Failed: " + (e?.message || e), "err");
      } finally {
        controller = null;
      }
    };
    mainBtn.addEventListener("click", () => run("copy"));
    dlBtn.addEventListener("click", () => run("download"));

    let lastUrl = null;
    const sync = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        controller?.abort();
        pending = null;
        clearTimeout(resetTimer);
        setOpen(false);
        idle();
      }
      const on = isActive(location);
      if (on && !host.isConnected) document.body.appendChild(host);
      if (!on && host.isConnected) host.remove();
    };
    sync();
    // Both sites are single-page apps, so watch for URL changes.
    setInterval(sync, 700);
    window.addEventListener("popstate", sync);
    document.addEventListener("yt-navigate-finish", sync);
  };
})();
