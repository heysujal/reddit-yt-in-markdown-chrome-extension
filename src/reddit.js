// Reddit: fetches the post's JSON (same-origin) and expands every "load more comments" node.
(() => {
  const MDC = globalThis.MDC;
  const POST_RE = /\/comments\/([a-z0-9]+)/i;
  const MAX_REQUESTS = 400;

  const isActive = (loc) => POST_RE.test(loc.pathname);

  async function getJson(url, signal) {
    const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" }, signal });
    if (!res.ok) throw new Error(`Reddit returned ${res.status}`);
    return res.json();
  }

  const emptyListing = () => ({ kind: "Listing", data: { children: [] } });

  // Finds every "more" node in the tree along with the array that holds it.
  // With topLevelOnly, only the root list is searched, so replies are never expanded.
  function collectMores(list, out, topLevelOnly = false) {
    for (const node of list) {
      if (node.kind === "more") out.push({ list, node });
      else if (!topLevelOnly && node.kind === "t1" && node.data.replies) collectMores(node.data.replies.data.children, out);
    }
    return out;
  }

  // Replaces `node` inside `list` with `things`, de-duplicating by id.
  function splice(list, node, things) {
    const seen = new Set(list.filter((n) => n.kind === "t1").map((n) => n.data.id));
    const fresh = things.filter((t) => !(t.kind === "t1" && seen.has(t.data.id)));
    list.splice(list.indexOf(node), 1, ...fresh);
  }

  async function expandMore(rootList, postId, origin, progress, signal, opts) {
    let requests = 0;
    let loaded = 0;
    while (!signal.aborted) {
      await MDC.breathe(opts);
      const mores = collectMores(rootList, [], opts?.topLevelOnly);
      if (!mores.length) return { complete: true };
      if (requests >= MAX_REQUESTS) return { complete: false };
      const { list, node } = mores[0];
      const d = node.data;
      try {
        if (!d.children.length) {
          // "Continue this thread": re-fetch the thread rooted at the parent comment.
          const parentId = d.parent_id.split("_")[1];
          requests++;
          const [, comments] = await getJson(`${origin}/comments/${postId}/_/${parentId}.json?limit=500&raw_json=1`, signal);
          const parent = comments.data.children.find((c) => c.kind === "t1" && c.data.id === parentId);
          splice(list, node, parent?.data.replies?.data.children || []);
        } else {
          const ids = d.children.slice(0, 100);
          requests++;
          const json = await getJson(
            `${origin}/api/morechildren.json?api_type=json&raw_json=1&limit_children=false&link_id=t3_${postId}&children=${ids.join(",")}`,
            signal
          );
          const things = json?.json?.data?.things || [];
          // morechildren returns a flat list; rebuild the hierarchy using parent_id.
          const byName = new Map();
          for (const t of things) {
            if (t.kind === "t1") {
              t.data.replies = emptyListing();
              byName.set(t.data.name, t);
            }
          }
          const top = [];
          for (const t of things) {
            const parent = byName.get(t.data.parent_id);
            if (parent) parent.data.replies.data.children.push(t);
            else top.push(t);
          }
          // Keep the remaining ids (beyond 100) as a "more" node.
          if (d.children.length > 100) top.push({ kind: "more", data: { ...d, children: d.children.slice(100) } });
          splice(list, node, top);
          loaded += things.length;
        }
      } catch (e) {
        if (signal.aborted) break;
        // Drop the node we could not expand so we don't loop forever.
        console.warn("[Copy Markdown] could not expand comments", e);
        list.splice(list.indexOf(node), 1);
      }
      progress(`Loading comments… +${loaded.toLocaleString("en-US")}`);
    }
    return { complete: false };
  }

  function postMedia(p) {
    const out = [];
    if (p.is_gallery && p.media_metadata) {
      const order = p.gallery_data?.items?.map((i) => i.media_id) || Object.keys(p.media_metadata);
      for (const id of order) {
        const m = p.media_metadata[id];
        const src = m?.s?.u || m?.s?.gif || m?.s?.mp4;
        if (src) out.push(`![](${src})`);
      }
    } else if (p.post_hint === "image" && p.url) {
      out.push(`![](${p.url})`);
    }
    const video = p.media?.reddit_video?.fallback_url || p.secure_media?.reddit_video?.fallback_url;
    if (video) out.push(`Video: ${video}`);
    return out;
  }

  function renderComment(c, depth, counter, topLevelOnly = false) {
    if (c.kind !== "t1") return "";
    const d = c.data;
    counter.n++;
    const pad = "  ".repeat(depth);
    const meta = [
      `**u/${d.author}**${d.is_submitter ? " (OP)" : ""}${d.distinguished ? ` [${d.distinguished}]` : ""}`,
      d.score_hidden ? "⬆ score hidden" : `⬆ ${MDC.fmtNum(d.score)}`,
      MDC.fmtDate(d.created_utc),
      d.edited ? "edited" : "",
      d.stickied ? "📌 pinned" : "",
      d.author_flair_text ? `flair: ${d.author_flair_text}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    let md = `${pad}- ${meta}\n\n${MDC.indent(d.body, pad + "  ")}\n\n`;
    if (topLevelOnly) return md;
    for (const r of d.replies?.data?.children || []) md += renderComment(r, depth + 1, counter);
    return md;
  }

  function render(p, comments, complete, opts = MDC.DEFAULT_OPTIONS) {
    const lines = [
      `# ${p.title}`,
      "",
      `- **Subreddit:** r/${p.subreddit}`,
      `- **Author:** u/${p.author}`,
      `- **Posted:** ${MDC.fmtDate(p.created_utc)}${p.edited ? " (edited)" : ""}`,
      `- **Score:** ${MDC.fmtNum(p.score)} (${Math.round((p.upvote_ratio || 0) * 100)}% upvoted)`,
      `- **Comments:** ${MDC.fmtNum(p.num_comments)}`,
    ];
    if (p.link_flair_text) lines.push(`- **Flair:** ${p.link_flair_text}`);
    if (p.over_18) lines.push(`- **NSFW:** yes`);
    lines.push(`- **URL:** https://www.reddit.com${p.permalink}`);
    if (!p.is_self && p.url && !p.url.includes(p.permalink)) lines.push(`- **Link:** ${p.url}`);
    const cross = p.crosspost_parent_list?.[0];
    if (cross) lines.push(`- **Crossposted from:** r/${cross.subreddit} — https://www.reddit.com${cross.permalink}`);
    lines.push("", "---", "");
    const body = p.selftext || cross?.selftext;
    if (body) lines.push(body, "");
    const media = postMedia(cross || p).filter((m) => opts.images || !m.startsWith("!["));
    if (media.length) lines.push(...media, "");

    if (!opts.comments) return lines.join("\n").trimEnd() + "\n";

    const counter = { n: 0 };
    const commentsMd = comments.map((c) => renderComment(c, 0, counter, opts.topLevelOnly)).join("");
    lines.push("---", "", `## Comments (${counter.n} copied${opts.topLevelOnly ? ", top-level only" : ""})`, "");
    if (!complete) lines.push("> Note: some deeply nested or collapsed comments were not loaded.", "");
    return lines.join("\n") + "\n" + commentsMd.trimEnd() + "\n";
  }

  async function build(progress, signal, opts = MDC.DEFAULT_OPTIONS) {
    const postId = location.pathname.match(POST_RE)[1];
    const origin = location.origin;
    progress("Fetching post…");
    // Top-level only: depth=1 asks Reddit to leave nested replies out of the response.
    const depth = opts.topLevelOnly ? "&depth=1" : "";
    const [listing, commentListing] = await getJson(`${origin}/comments/${postId}.json?limit=500&raw_json=1${depth}`, signal);
    const post = listing.data.children[0].data;
    const comments = commentListing.data.children;
    const { complete } = opts.comments ? await expandMore(comments, postId, origin, progress, signal, opts) : { complete: true };
    return render(post, comments, complete, opts);
  }

  MDC.sites = { ...MDC.sites, reddit: { isActive, build, render } };
  if (MDC.autoMount !== false) MDC.mountButton({ label: "Copy Markdown", isActive, build });
})();
