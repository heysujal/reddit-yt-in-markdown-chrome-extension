<img src="icons/icon-128.png" width="96" alt="Copy as Markdown icon" />

# Copy as Markdown: Reddit + YouTube

A Chrome extension that turns a Reddit thread or a YouTube video into clean Markdown with one click. It includes the post or video, its metadata, and every comment and reply. Copy it to the clipboard or download it as a `.md` file.

Paste the result into an LLM, your notes app, Obsidian, or a GitHub issue. No API key, account, or server is needed.

## Features

**Reddit** (`reddit.com/r/*/comments/*`)
- Title, subreddit, author, score, upvote ratio, date, flair, and crosspost source
- Post body, images, galleries, and video links
- The full comment tree, with author, score, and date on every comment, plus OP, pinned, and edited markers
- Expands "load more" and "continue this thread" branches automatically

**YouTube** (`youtube.com/watch?v=*`)
- Title, channel, subscribers, publish date, duration, views, likes, category, tags, description, and thumbnail
- Every comment with all its replies, likes, and age, plus pinned and creator-heart markers

**Both**
- A floating **Copy Markdown** button in the bottom-right corner
- A **⬇ Download** button next to it that saves the Markdown as a `.md` file named after the post or video title
- A **⋯** menu with **Include comments** and **Include images** toggles, remembered between visits
- Live progress on large threads
- Click again while it is loading to stop early and keep what has loaded so far

## Install

The extension is not on the Chrome Web Store yet. To install it from this repo:

1. Download it: **Code → Download ZIP** on GitHub, then unzip it. You can also run `git clone https://github.com/heysujal/reddit-yt-in-markdown-chrome-extension.git`.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
4. Reload any Reddit or YouTube tab that was already open.

It also works in Chromium-based browsers such as Edge, Brave, and Arc.

## Usage

1. Open a Reddit post or a YouTube video.
2. Click **Copy Markdown** to copy it, or **⬇** to download it as a `.md` file.
3. Wait for the "Copied ✓" or "Downloaded ✓" confirmation.

## Example output

```markdown
# What's a tool you can't live without?

- **Subreddit:** r/programming
- **Author:** u/example_user
- **Posted:** 2026-11-10 14:32 UTC
- **Score:** 1,284 (96% upvoted)
- **Comments:** 312
- **URL:** https://www.reddit.com/r/programming/comments/...

---

Post body here...

---

## Comments (312 copied)

- **u/someone** · ⬆ 412 · 2026-11-10 15:01 UTC

  First comment text.

  - **u/example_user** (OP) · ⬆ 88 · 2026-11-10 15:20 UTC

    A nested reply.
```

## Privacy

- **No external calls.** The extension uses the same endpoints the sites already use, sent from your own tab:
  - Reddit: `/comments/<id>.json` and `/api/morechildren.json`
  - YouTube: the watch page's embedded data and `/youtubei/v1/next` for comment pages
- **No data collection.** Nothing leaves your browser. The output goes to your clipboard or a file you choose to download.
- **Permissions:** `clipboardWrite` to copy, and `storage` to remember your two toggles.

## Project structure

```
├── manifest.json     # Manifest V3 config and content-script matches
├── icons/            # Extension icons (SVG masters + PNG sizes)
└── src/
    ├── common.js     # Floating button, options menu, clipboard, download, helpers
    ├── reddit.js     # Reddit thread → Markdown
    └── youtube.js    # YouTube video + comments → Markdown
```

## Development

There is no build step. Edit the files in `src/`, then click the reload icon on the extension card in `chrome://extensions` and refresh the tab.

## License

[MIT](LICENSE) © Sujal Gupta

This project is not affiliated with or endorsed by Reddit or YouTube. Use it in line with each site's terms of service.
