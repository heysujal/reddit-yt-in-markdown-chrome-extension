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

  MDC.DEFAULT_OPTIONS = { comments: true, images: true, prepare: false };

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

  // ---------- background work ----------

  // In background mode, wait for the browser to be idle between network requests so a
  // prefetch never competes with scrolling, typing or the site's own scripts.
  MDC.breathe = (opts) => {
    if (!opts?.background) return Promise.resolve();
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 1000 });
      else setTimeout(resolve, 50);
    });
  };

  // ---------- floating buttons ----------

  const COPY_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
  const DOWNLOAD_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 15v3H6v-3H4v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3h-2zm-1-4-1.4-1.4-2.6 2.6V4h-2v8.2L8.4 9.6 7 11l5 5 5-5z"/></svg>';
  const MORE_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

  // Mounts floating "Download .md" and "Copy Markdown" buttons plus a ⋯ options menu, shown only
  // while isActive(location) is true.
  // build(progress, signal, options) must resolve to the markdown string. Clicking while busy
  // aborts the fetch, and build() should then return whatever it has collected so far.
  // With options.prepare on, build() starts in the background when the page loads, so a later
  // click copies or downloads instantly.
  MDC.mountButton = ({ label, isActive, build }) => {
    const host = document.createElement("div");
    host.id = "mdc-copy-markdown";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
          display: flex; flex-direction: column; align-items: stretch; gap: 10px; width: 270px;
          font: 600 15px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        .row { display: flex; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
        button {
          display: flex; align-items: center; gap: 8px; border: 0; cursor: pointer; min-width: 0;
          font: inherit; color: #fff; background: #0d7c86; transition: background .15s, transform .1s;
        }
        button:hover { transform: translateY(-1px); }
        button:active { transform: translateY(1px); }
        button:focus-visible { outline: 3px solid #9be7ee; outline-offset: 2px; }
        .action { flex: 1; padding: 14px 18px 14px 22px; border-radius: 999px; }
        .row .action { border-radius: 999px 0 0 999px; }
        .action span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .more { flex: none; padding: 14px 16px 14px 12px; border-radius: 0 999px 999px 0; border-left: 1px solid rgba(255,255,255,.3); }
        .dl { box-shadow: 0 6px 20px rgba(0,0,0,.35); }
        [data-state="busy"] { background: #6e40c9; }
        [data-state="ok"] { background: #1a7f37; }
        [data-state="ready"] { background: #bf8700; }
        [data-state="err"] { background: #cf222e; }
        .row:has(.copy[data-state="busy"]) .more { background: #6e40c9; }
        .row:has(.copy[data-state="ok"]) .more { background: #1a7f37; }
        .row:has(.copy[data-state="ready"]) .more { background: #bf8700; }
        .row:has(.copy[data-state="err"]) .more { background: #cf222e; }
        .dot { width: 8px; height: 8px; margin-left: auto; flex: none; border-radius: 50%; background: transparent; }
        .dot[data-prep="working"] { background: #ffd866; animation: pulse 1.2s ease-in-out infinite; }
        .dot[data-prep="done"] { background: #7ee2a8; }
        @keyframes pulse { 50% { opacity: .35; } }
        @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
        .panel {
          display: none; flex-direction: column; gap: 2px; padding: 10px;
          color: #1f2328; background: #fff; border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.3);
          font-weight: 500; font-size: 14px;
        }
        .panel[data-open] { display: flex; }
        label { display: flex; align-items: flex-start; gap: 10px; padding: 8px 6px; border-radius: 8px; cursor: pointer; }
        label:hover { background: #f0f3f6; }
        label small { display: block; margin-top: 2px; color: #59636e; font-weight: 400; font-size: 12px; }
        input { flex: none; width: 16px; height: 16px; margin: 1px 0 0; accent-color: #0d7c86; cursor: pointer; }
        .status { padding: 6px 6px 2px; color: #59636e; font-size: 12px; font-weight: 400; }
        .status:empty { display: none; }
        svg { flex: none; }
      </style>
      <div class="wrap">
        <div class="panel" role="menu">
          <label><input type="checkbox" name="comments" /> Include comments</label>
          <label><input type="checkbox" name="images" /> Include images</label>
          <label><input type="checkbox" name="prepare" />
            <span>Prepare in background<small>Fetch everything when the page loads, so Copy and Download are instant.</small></span></label>
          <div class="status" aria-live="polite"></div>
        </div>
        <button type="button" class="action dl" data-state="idle" title="Download as a .md file">${DOWNLOAD_ICON}<span></span><i class="dot"></i></button>
        <div class="row">
          <button type="button" class="action copy" data-state="idle" title="Copy this page as Markdown">${COPY_ICON}<span></span><i class="dot"></i></button>
          <button type="button" class="more" title="Options" aria-label="Options" aria-haspopup="true" aria-expanded="false">${MORE_ICON}</button>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const panel = $(".panel");
    const moreBtn = $(".more");
    const status = $(".status");
    const dots = [...root.querySelectorAll(".dot")];
    const boxes = [...panel.querySelectorAll("input")];
    const buttons = {
      copy: { el: $(".copy"), label },
      download: { el: $(".dl"), label: "Download .md" },
    };

    // ---- options ----
    let options = { ...MDC.DEFAULT_OPTIONS };
    const contentKey = () => `${location.href}|${options.comments}|${options.images}`;
    MDC.loadOptions().then((o) => {
      options = o;
      for (const b of boxes) b.checked = !!options[b.name];
      schedulePrepare();
    });
    for (const b of boxes) {
      b.checked = !!options[b.name];
      b.addEventListener("change", () => {
        options = { ...options, [b.name]: b.checked };
        MDC.saveOptions(options);
        // Changed content or turned preparing off: discard background work, but never a run
        // the user is waiting on (it finishes with the options it started with).
        const stale = b.name !== "prepare" || !b.checked;
        if (stale && job && !job.foreground) dropJob();
        schedulePrepare();
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

    // ---- button text ----
    const resetTimers = {};
    const set = (mode, msg, state) => {
      const b = buttons[mode];
      b.el.querySelector("span").textContent = msg;
      b.el.dataset.state = state;
    };
    const idle = (mode) => set(mode, buttons[mode].label, "idle");
    const flash = (mode, msg, state) => {
      set(mode, msg, state);
      clearTimeout(resetTimers[mode]);
      resetTimers[mode] = setTimeout(() => idle(mode), 3500);
    };
    const setPrep = (state, msg = "") => {
      for (const d of dots) {
        if (state) d.dataset.prep = state;
        else delete d.dataset.prep;
      }
      status.textContent = msg;
      const tip = state === "working" ? "Preparing in the background…" : state === "done" ? "Ready: click for an instant result" : "";
      for (const m of Object.keys(buttons)) buttons[m].el.title = tip || buttons[m].el.dataset.baseTitle;
    };
    for (const m of Object.keys(buttons)) buttons[m].el.dataset.baseTitle = buttons[m].el.title;
    const sizeOf = (md) => (new Blob([md]).size / 1024).toFixed(1) + " KB";

    // ---- the build job (one per page + content options) ----
    // job = { key, controller, opts, promise, md, done, aborted, foreground: "copy" | "download" | null }
    let job = null;
    let pending = null; // markdown waiting for a click because the clipboard write was rejected

    function dropJob() {
      if (!job) return;
      job.controller.abort();
      job.dropped = true;
      job = null;
      setPrep(null);
    }

    function startJob(background) {
      const controller = new AbortController();
      const opts = { ...options, background };
      const j = { key: contentKey(), controller, opts, md: null, done: false, foreground: null };
      const progress = (msg) => {
        if (j.dropped) return;
        if (j.foreground) set(j.foreground, msg + " (click to stop)", "busy");
        else setPrep("working", msg);
      };
      j.promise = build(progress, controller.signal, opts).then(
        (md) => {
          j.md = md;
          j.done = true;
          j.aborted = controller.signal.aborted;
          if (!j.dropped && !j.foreground && !j.aborted) setPrep("done", "Ready: Copy and Download are instant.");
          return md;
        },
        (e) => {
          j.done = true;
          j.error = e;
          if (!j.dropped && !j.foreground) setPrep(null);
          throw e;
        }
      );
      j.promise.catch(() => {}); // a failed background prefetch is retried by the next click
      job = j;
      return j;
    }

    let prepTimer = null;
    function schedulePrepare() {
      clearTimeout(prepTimer);
      if (!options.prepare || !isActive(location)) return;
      if (job && job.key === contentKey()) return;
      // Start once the page has settled and only while the tab is visible.
      prepTimer = setTimeout(() => {
        const go = () => {
          if (!options.prepare || !isActive(location) || (job && job.key === contentKey())) return;
          if (document.hidden) return document.addEventListener("visibilitychange", go, { once: true });
          setPrep("working", "Preparing…");
          startJob(true);
        };
        if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 1000 });
        else go();
      }, 1500);
    }

    async function finish(mode, md) {
      if (mode === "download") {
        MDC.download(md);
        return flash(mode, `Downloaded ✓ (${sizeOf(md)})`, "ok");
      }
      if (await MDC.copy(md)) {
        pending = null;
        flash(mode, `Copied ✓ (${sizeOf(md)})`, "ok");
      } else {
        pending = md;
        set(mode, "Ready — click again to copy", "ready");
      }
    }

    async function run(mode) {
      setOpen(false);
      // A click on either button while one is working stops it early.
      if (job?.foreground && !job.done) {
        job.controller.abort();
        set(job.foreground, "Stopping…", "busy");
        return;
      }
      if (pending && mode === "copy") return finish(mode, pending);
      pending = null;
      clearTimeout(resetTimers[mode]);

      // Reuse the prepared result (or the one still preparing) when it matches the page.
      let j = job && job.key === contentKey() && !job.error && !job.aborted ? job : null;
      if (j?.done) return finish(mode, j.md);
      if (!j) {
        dropJob();
        j = startJob(false);
      }
      j.foreground = mode;
      j.opts.background = false; // the user is waiting: stop yielding to idle time
      set(mode, "Preparing… (click to stop)", "busy");
      try {
        const md = await j.promise;
        await finish(mode, md);
        if (job === j) {
          // A stopped run is partial: don't keep it as the prepared result.
          if (j.aborted) {
            job = null;
            setPrep(null);
          } else {
            setPrep("done", "Ready: Copy and Download are instant.");
          }
        }
      } catch (e) {
        console.error("[Copy Markdown]", e);
        flash(mode, "Failed: " + (e?.message || e), "err");
        if (job === j) {
          job = null;
          setPrep(null);
        }
      } finally {
        j.foreground = null;
      }
    }
    buttons.copy.el.addEventListener("click", () => run("copy"));
    buttons.download.el.addEventListener("click", () => run("download"));

    // ---- page tracking ----
    let lastUrl = null;
    const sync = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        dropJob();
        pending = null;
        setOpen(false);
        for (const m of Object.keys(buttons)) {
          clearTimeout(resetTimers[m]);
          idle(m);
        }
        schedulePrepare();
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
