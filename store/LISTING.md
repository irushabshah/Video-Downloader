# Chrome Web Store listing

Copy each part into the matching box in the Chrome Web Store developer dashboard.

## Store listing tab

**Name:** Yoink

**Summary** (from the manifest, 106 characters):

Save videos and audio from 1,800+ sites. Pick a quality, right-click any video, or grab what a page plays.

**Category:** Tools

**Language:** English

**Description:**

```
Yoink saves videos and audio to your computer.

Open a page with a video and click Yoink. Pick a quality, like 1080p, 720p or audio only. The file goes to your Downloads folder.

What you can do
• Download from more than 1,800 sites.
• See the videos a page plays, with their sizes.
• Get split video and audio back as one file.
• See how big a streamed video is before you download it.
• Right-click any video or link and choose Download with Yoink.
• Press Alt+Shift+Y to download the page you are on.
• Watch the speed and time left, then open the file with one click.
• Use your own logins, so videos you can see when signed in work too. You can turn this off.

How it works
Yoink uses a small free helper on your computer. The helper runs yt-dlp and ffmpeg, two open source tools. You install it once, and the popup shows you how. You need Node.js 18 or newer. On a Mac you also need Homebrew.

Your privacy
Everything happens on your computer. Yoink has no servers and no accounts. It does not collect, sell or share your data. Your logins only go to the helper on your computer, and only for the link you download.

Please download only what you have the right to keep.
```

**Images** (all in `store/images/`):

| Box in the dashboard | File |
|---|---|
| Store icon | `store-icon-128.png` |
| Screenshots | `screenshot-1-quality.png`, `screenshot-2-found.png`, `screenshot-3-right-click.png`, `screenshot-4-progress.png` |
| Small promo tile | `promo-small-440x280.png` |
| Marquee promo tile | `promo-marquee-1400x560.png` |

**Homepage URL:** https://github.com/irushabshah/Video-Downloader

**Support URL:** https://github.com/irushabshah/Video-Downloader/issues

## Privacy practices tab

**Single purpose:**

```
Yoink downloads videos and audio from web pages to the user's computer, using a helper app the user installs locally.
```

**Permission justifications:**

| Permission | Why Yoink needs it |
|---|---|
| nativeMessaging | Talks to the Yoink helper on the user's computer, which does the downloading. |
| downloads | Saves plain video files a page plays through Chrome's own downloads. |
| storage | Remembers the save folder, settings and the recent downloads list. |
| webRequest | Spots video files and streams a page loads, so the popup can list them. It only reads response headers and never blocks or changes requests. |
| tabs | Reads the address and title of the current tab, to fill in the link and name the file. |
| cookies | When "Use my logins" is on, passes the cookies for the link being downloaded to the local helper, so videos the user can see when signed in work too. The cookies never leave the computer. |
| contextMenus | Adds "Download with Yoink" to the right-click menu. |
| notifications | Says when a download started from the right-click menu or shortcut is saved or fails. |
| Host permission (all sites) | Videos can be on any site. Yoink needs to see video responses and read stream playlists to estimate their size. |

**Remote code:** No, I am not using remote code.

**Data usage:** Tick these, because Yoink handles them on the user's computer:

- Authentication information (cookies, only when "Use my logins" is on)
- Website content (video links and page titles)

Then tick all three statements: no selling of data, no use for unrelated purposes, no use for credit decisions.

**Privacy policy URL:** https://github.com/irushabshah/Video-Downloader/blob/main/store/PRIVACY.md
