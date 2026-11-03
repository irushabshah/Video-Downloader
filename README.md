# Yoink

A Chrome extension that saves videos and audio from more than 1,800 sites. It runs on your own computer. Nothing goes to a server.

It's built on the ideas and code of [yoinks](https://github.com/pablostanley/yoinks) (MIT) by Pablo Stanley. Yoinks is a terminal app. This project puts the same engine behind a Chrome popup.

## How it works

Chrome extensions can't run programs. So there are two parts:

- **The extension** (`extension/`). The popup you click.
- **The helper** (`host/`). A small Node program. It runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg for you. Chrome starts it when needed.

## What it does

- Paste a link and pick a quality: 1080p, 720p and so on, or audio only.
- Lists the videos a page plays, with their sizes. A number on the toolbar icon says how many it found.
- Joins split video and audio tracks into one file.
- Estimates the size of a streamed video before you download it.
- Right-click any video or link and choose **Download with Yoink**.
- Press **Alt+Shift+Y** to download the page you're on. You can change the key at `chrome://extensions/shortcuts`.
- Uses your logins, so videos you can see when signed in work too. Turn it off under **Settings** in the popup.
- Tells you when a right-click or shortcut download is done.

## Set up (once)

You need [Node.js](https://nodejs.org) 18 or newer.

On a Mac, you also need [Homebrew](https://brew.sh). The install script uses it to install `yt-dlp` and ffmpeg. (macOS blocks the downloadable `yt-dlp` when Chrome starts it.)

1. Install the helper.
   - Mac or Linux: open a terminal in this folder and run `./scripts/install.sh`
   - Windows: open PowerShell in this folder and run `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder in this project.
5. Click the puzzle-piece icon in the toolbar and pin **Yoink**.
6. Open the popup. The badge should say **helper ready**.

If you install Yoink from the Chrome Web Store, the popup links to the helper download. Unzip it and run the same install script.

The install script copies the helper to `~/.yoink/helper`. You can keep this project folder anywhere, but don't delete the `extension` folder.

On Windows and Linux, the first download fetches `yt-dlp` into `~/.yoink/bin`. This takes a few seconds. If you already have `yt-dlp` or ffmpeg installed, the helper uses yours.

## Use it

1. Open a page with a video.
2. Click the Yoink icon. The page link is already filled in.
3. Click **Find formats**.
4. Click the size you want. Or pick **audio only · mp3**.
5. Watch progress under **Downloads**. Click **Show** to open the folder.

Files go to `~/Downloads`. You can change the folder under **Settings** in the popup.

## If something goes wrong

- **Badge says "helper not installed".** Run the install script, then press **Check again**.
- **Badge says "helper problem".** Look at the log: `~/.yoink/helper.log`. Then open `chrome://extensions`, click the reload arrow on Yoink, and try again.
- **A site stopped working.** Sites change often. On a Mac, run `brew upgrade yt-dlp`. On Windows and Linux, delete `~/.yoink/bin/yt-dlp` and run a download again. It fetches the newest version.
- **No 1080p, or mp3 fails.** ffmpeg is missing. Install it, or run the install script again.
- **Other Chromium browsers.** The install script also registers Brave, Edge and Chromium when it finds them.

To remove the helper: `./scripts/install.sh --uninstall` (or `scripts\install.ps1 -Uninstall` on Windows).

## Files

```
extension/          the Chrome extension (no build step)
  manifest.json
  background.js     talks to the helper, tracks downloads, spots videos
  popup.html/.css/.js
host/host.js        the helper (ported from yoinks' yt-dlp code)
scripts/install.*   install scripts for Mac, Linux and Windows
scripts/build.sh    builds the store, helper and full zips into dist/
store/              store listing text, privacy policy and images
PUBLISHING.md       how to publish to the Chrome Web Store
```

The unpacked extension's ID is fixed by the `key` in `manifest.json`. The store copy gets its own ID, which goes into the install scripts. That's how the helper knows which extensions may talk to it.

## A note on fair use

This is a personal archiving tool. Downloading may break a site's terms of service. Only download what you have the right to keep.

## License

MIT. See [LICENSE](LICENSE). Includes code adapted from yoinks, (c) Pablo Stanley, MIT. Some feature ideas came from [OmniGet](https://github.com/OpenSelena/omniget). No OmniGet code is included.
