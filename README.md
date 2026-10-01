# Video Downloader

A Chrome extension that downloads videos from YouTube, X, Instagram, TikTok and 1,800+ other sites. It runs on your own computer. Nothing goes to a server.

It is built on the ideas and code of [yoinks](https://github.com/pablostanley/yoinks) (MIT) by Pablo Stanley. Yoinks is a terminal app. This project puts the same engine behind a Chrome popup.

## How it works

Chrome extensions can't run programs. So there are two parts:

- **The extension** (`extension/`). The popup you click.
- **The helper** (`host/`). A small Node program. It runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg for you. Chrome starts it when needed.

The extension also spots plain video files and streams (`.mp4`, `.webm`, `.m3u8`) that a page loads. A number appears on the toolbar icon. Open the popup to download them.

## Set up (once)

You need [Node.js](https://nodejs.org) 18 or newer.

1. Install the helper.
   - Mac or Linux: open a terminal in this folder and run `./scripts/install.sh`
   - Windows: open PowerShell in this folder and run `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder in this project.
5. Click the puzzle-piece icon in the toolbar and pin **Video Downloader**.
6. Open the popup. The badge should say **helper ready**.

The install script copies the helper to `~/.video-downloader/host`. You can keep this project folder anywhere, but don't delete the `extension` folder.

The first download fetches `yt-dlp` into `~/.video-downloader/bin`. This takes a few seconds. If you already have `yt-dlp` or `ffmpeg` installed, the helper uses yours.

## Use it

1. Open a page with a video.
2. Click the extension icon. The page link is already filled in.
3. Click **Find formats**.
4. Click the size you want. Or pick **audio only · mp3**.
5. Watch progress under **Downloads**. Click **Show** to open the folder.

Files go to `~/Downloads`. You can change the folder under **Settings** in the popup.

## If something goes wrong

- **Badge says "helper not installed".** Run the install script from step 1, then press **Check again**.
- **Badge says "helper problem".** Look at the log: `~/.video-downloader/host.log`. Then open `chrome://extensions`, click the reload arrow on this extension, and try again.
- **A site stopped working.** Sites change often. Delete `~/.video-downloader/bin/yt-dlp` and run a download again. It fetches the newest version. If you installed `yt-dlp` yourself, update it with your package manager.
- **No 1080p, or mp3 fails.** ffmpeg is missing. Install it, or re-run the install script.
- **Other Chromium browsers.** The install script also registers Brave, Edge and Chromium when it finds them. The extension works the same way there.

To remove the helper: `./scripts/install.sh --uninstall` (or `scripts\install.ps1 -Uninstall` on Windows).

## Files

```
extension/        the Chrome extension (no build step)
  manifest.json
  background.js   talks to the helper, tracks downloads, spots videos
  popup.html/.css/.js
host/host.js      the helper (ported from yoinks' yt-dlp code)
scripts/          install scripts for Mac, Linux and Windows
```

The extension ID is fixed by the `key` in `manifest.json`. That is how the helper knows it may talk to this extension and no other.

## A note on fair use

This is a personal tool. Downloading may break a site's terms of service. Only download what you have the right to keep.

## License

MIT. See [LICENSE](LICENSE). Includes code adapted from yoinks, (c) Pablo Stanley, MIT.
