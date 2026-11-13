// YouTube: reads the watch page's embedded data, then pages through YouTube's own comments API
// (the same one youtube.com uses) to collect every comment thread and all of its replies.
(() => {
  const MDC = globalThis.MDC;
  const REPLY_CONCURRENCY = 6;

  const videoIdOf = (loc) => (loc.pathname === "/watch" ? new URLSearchParams(loc.search).get("v") : null);
  const isActive = (loc) => !!videoIdOf(loc);

  // ---------- generic helpers ----------

  // Extracts the JSON object literal that starts right after `marker` in `src`.
  function extractJson(src, marker, from = 0) {
    const at = src.indexOf(marker, from);
    if (at < 0) return null;
    const start = src.indexOf("{", at + marker.length - (marker.endsWith("{") ? 1 : 0));
    let depth = 0;
    let inStr = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return { value: JSON.parse(src.slice(start, i + 1)), end: i + 1 };
        } catch {
          return { value: null, end: i + 1 };
        }
      }
    }
    return null;
  }

  // Returns every value stored under `key` anywhere inside `obj`.
  function findAll(obj, key, out = []) {
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (k === key) out.push(v);
        findAll(v, key, out);
      }
    }
    return out;
  }

  const txt = (o) => (o == null ? "" : typeof o === "string" ? o : o.simpleText ?? o.content ?? (o.runs || []).map((r) => r.text).join(""));

  const findToken = (obj) => findAll(obj, "continuationCommand")[0]?.token || null;

  const fmtDuration = (s) => {
    s = Number(s) || 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };

  // ---------- page data ----------

  async function loadPage(videoId, signal) {
    const res = await fetch(`${location.origin}/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include", signal });
    if (!res.ok) throw new Error(`YouTube returned ${res.status}`);
    const html = await res.text();

    const cfg = {};
    for (let pos = 0, r; (r = extractJson(html, "ytcfg.set({", pos)); pos = r.end) {
      if (r.value) Object.assign(cfg, r.value);
    }
    const data = extractJson(html, "var ytInitialData =")?.value || extractJson(html, 'window["ytInitialData"] =')?.value;
    const player = extractJson(html, "var ytInitialPlayerResponse =")?.value;
    if (!data || !player) throw new Error("Could not read video data from the page");
    return { cfg, data, player };
  }

  function makeApi(cfg) {
    const context = cfg.INNERTUBE_CONTEXT || {
      client: { clientName: "WEB", clientVersion: cfg.INNERTUBE_CLIENT_VERSION || "2.20250101.00.00", hl: "en" },
    };
    const url = `${location.origin}/youtubei/v1/next?prettyPrint=false${cfg.INNERTUBE_API_KEY ? `&key=${cfg.INNERTUBE_API_KEY}` : ""}`;
    let credentials = "omit";
    return async function next(continuation, signal) {
      const req = () =>
        fetch(url, {
          method: "POST",
          credentials,
          signal,
          headers: {
            "content-type": "application/json",
            "x-youtube-client-name": String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME || 1),
            "x-youtube-client-version": context.client.clientVersion,
          },
          body: JSON.stringify({ context, continuation }),
        });
      let res = await req();
      if (!res.ok && credentials === "omit") {
        credentials = "include";
        res = await req();
      }
      if (!res.ok) throw new Error(`YouTube comments API returned ${res.status}`);
      return res.json();
    };
  }

  // ---------- comments ----------

  function parseResponse(json) {
    const payloads = new Map();
    const hearts = new Map();
    for (const m of json.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
      const p = m.payload || {};
      if (p.commentEntityPayload) {
        payloads.set(m.entityKey, p.commentEntityPayload);
        const id = p.commentEntityPayload.properties?.commentId;
        if (id) payloads.set(id, p.commentEntityPayload);
      }
      if (p.engagementToolbarStateEntityPayload) hearts.set(m.entityKey, p.engagementToolbarStateEntityPayload.heartState);
    }
    const items = [];
    for (const ep of json.onResponseReceivedEndpoints || []) {
      const c = ep.reloadContinuationItemsCommand || ep.appendContinuationItemsAction;
      if (c?.continuationItems) items.push(...c.continuationItems);
    }
    return { payloads, hearts, items };
  }

  // Normalises both the current (commentViewModel + entity payload) and legacy (commentRenderer) formats.
  function toComment(node, { payloads, hearts }) {
    let vm = node.commentViewModel;
    if (vm?.commentViewModel) vm = vm.commentViewModel;
    if (vm) {
      const p = payloads.get(vm.commentKey) || payloads.get(vm.commentId);
      if (!p) return null;
      return {
        author: p.author?.displayName || "unknown",
        isCreator: !!p.author?.isCreator,
        verified: !!p.author?.isVerified,
        text: p.properties?.content?.content || "",
        time: p.properties?.publishedTime || "",
        likes: (p.toolbar?.likeCountNotliked || "").trim() || "0",
        replyCount: p.toolbar?.replyCount || "",
        hearted: hearts.get(vm.toolbarStateKey) === "TOOLBAR_HEART_STATE_HEARTED",
        pinned: !!(vm.pinnedText || p.properties?.pinnedText),
        replies: [],
      };
    }
    const r = node.comment?.commentRenderer || node.commentRenderer;
    if (!r) return null;
    return {
      author: txt(r.authorText) || "unknown",
      isCreator: !!r.authorIsChannelOwner,
      verified: !!r.authorCommentBadge,
      text: txt(r.contentText),
      time: txt(r.publishedTimeText),
      likes: txt(r.voteCount) || "0",
      replyCount: r.replyCount || "",
      hearted: !!r.actionButtons?.commentActionButtonsRenderer?.creatorHeart?.creatorHeartRenderer?.isHearted,
      pinned: !!r.pinnedCommentBadge,
      replies: [],
    };
  }

  // Loads a paginated list of comments (top-level threads or replies), recursing into replies.
  async function loadList(api, token, state) {
    const out = [];
    while (token && !state.signal.aborted) {
      await MDC.breathe(state.opts);
      let json;
      try {
        json = await api(token, state.signal);
      } catch (e) {
        if (state.signal.aborted) break;
        throw e;
      }
      const parsed = parseResponse(json);
      token = null;
      const replyJobs = [];
      for (const it of parsed.items) {
        if (it.commentsHeaderRenderer) {
          state.headerCount = txt(it.commentsHeaderRenderer.countText) || state.headerCount;
        } else if (it.commentThreadRenderer) {
          const t = it.commentThreadRenderer;
          const c = toComment(t, parsed);
          if (!c) continue;
          out.push(c);
          state.count++;
          const rt = findToken(t.replies);
          if (rt) replyJobs.push(async () => (c.replies = await loadList(api, rt, state)));
        } else if (it.commentViewModel || it.commentRenderer) {
          const c = toComment(it, parsed);
          if (c) {
            out.push(c);
            state.count++;
          }
        } else if (it.continuationItemRenderer) {
          token = findToken(it.continuationItemRenderer);
        }
      }
      state.progress(`Loading comments… ${state.count.toLocaleString("en-US")}`);
      // Fewer parallel requests while preparing in the background.
      await MDC.pool(replyJobs, state.opts?.background ? 2 : REPLY_CONCURRENCY);
    }
    return out;
  }

  // ---------- markdown ----------

  function renderComment(c, depth) {
    const pad = "  ".repeat(depth);
    const meta = [
      `**${c.author}**${c.isCreator ? " (creator)" : ""}${c.verified ? " ✓" : ""}`,
      `👍 ${c.likes}`,
      c.time,
      c.pinned ? "📌 pinned" : "",
      c.hearted ? "❤️ by creator" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    let md = `${pad}- ${meta}\n\n${MDC.indent(c.text, pad + "  ")}\n\n`;
    for (const r of c.replies) md += renderComment(r, depth + 1);
    return md;
  }

  function videoLikes(data) {
    const exact = findAll(data, "likeCountIfIndifferentNumber")[0];
    if (exact) return MDC.fmtNum(exact);
    const seg = findAll(data, "segmentedLikeDislikeButtonViewModel")[0];
    const strs = [...findAll(seg, "accessibilityText"), ...findAll(seg, "title")].filter((s) => typeof s === "string");
    const withDigits = strs.find((s) => /\d/.test(s));
    if (withDigits) return withDigits.match(/\d[\d,.\s]*[KMBkmb]?/)[0].trim();
    const aria = document.querySelector("like-button-view-model button, #segmented-like-button button")?.getAttribute("aria-label");
    return aria?.match(/\d[\d,.\s]*[KMBkmb]?/)?.[0].trim() || "unknown";
  }

  function render({ data, player }, comments, state, commentsDisabled, opts = MDC.DEFAULT_OPTIONS) {
    const v = player.videoDetails || {};
    const mf = player.microformat?.playerMicroformatRenderer || {};
    const subs = txt(findAll(data, "subscriberCountText")[0]);
    const lines = [
      `# ${v.title || txt(findAll(data, "title")[0])}`,
      "",
      `- **Channel:** [${v.author}](https://www.youtube.com/channel/${v.channelId})${subs ? ` (${subs})` : ""}`,
      `- **URL:** https://www.youtube.com/watch?v=${v.videoId}`,
      `- **Published:** ${mf.publishDate || mf.uploadDate || "unknown"}`,
      `- **Duration:** ${v.isLiveContent && v.lengthSeconds === "0" ? "live" : fmtDuration(v.lengthSeconds)}`,
      `- **Views:** ${MDC.fmtNum(v.viewCount)}`,
      `- **Likes:** ${videoLikes(data)}`,
      `- **Comments:** ${commentsDisabled ? "turned off" : state.headerCount || "unknown"}`,
    ];
    if (mf.category) lines.push(`- **Category:** ${mf.category}`);
    if (v.keywords?.length) lines.push(`- **Tags:** ${v.keywords.join(", ")}`);
    if (opts.images && v.videoId) lines.push("", `![Thumbnail](https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg)`);
    lines.push("", "## Description", "", (v.shortDescription || "(no description)").replace(/\n/g, "  \n"), "");
    if (!commentsDisabled && opts.comments) {
      const total = state.count.toLocaleString("en-US");
      lines.push(`## Comments (${total} copied, including replies; sorted by Top)`, "");
      if (state.signal.aborted) lines.push("> Note: stopped early — this is a partial list of comments.", "");
      lines.push(comments.map((c) => renderComment(c, 0)).join("").trimEnd());
    }
    return lines.join("\n") + "\n";
  }

  async function build(progress, signal, opts = MDC.DEFAULT_OPTIONS) {
    const videoId = videoIdOf(location);
    progress("Loading video…");
    const page = await loadPage(videoId, signal);
    const section = findAll(page.data, "itemSectionRenderer").find((s) => s.sectionIdentifier === "comment-item-section");
    const token = findToken(section);
    const state = { count: 0, headerCount: "", progress, signal, opts };
    const comments = token && opts.comments ? await loadList(makeApi(page.cfg), token, state) : [];
    return render(page, comments, state, !token, opts);
  }

  MDC.sites = { ...MDC.sites, youtube: { isActive, build, extractJson, findAll } };
  if (MDC.autoMount !== false) MDC.mountButton({ label: "Copy Markdown", isActive, build });
})();
