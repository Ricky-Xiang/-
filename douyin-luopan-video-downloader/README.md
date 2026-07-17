# Douyin Luopan Rank Video Downloader

Chrome / Edge MV3 extension for assisted low-speed downloading on Douyin Luopan rank pages.

Target page:

`抖音罗盘 -> 短视频 -> 行业竞对 -> 视频榜单 -> 引流直播榜`

## Current Strategy

This version only downloads videos that the logged-in Luopan page can already access normally.

Flow:

1. Scan the rank page for `video_id`.
   - First from Luopan API responses captured by `page-hook.js`.
   - Then from page DOM / React fiber, inspired by the existing "罗盘抖音链接助手" plugin.
   - Then from visible detail links when available.
2. Open each Luopan detail page slowly in a background tab.
3. Trigger the preview player.
4. Read the real `<video src>` / `<source src>` exposed by the page.
5. Submit that media URL to the browser download manager.
6. If no `video_id` or no downloadable `video.src` is exposed, skip the item and count it as failed/skipped.

It does not bypass permissions, captcha, paid access, DRM, or platform risk controls.

## Install

1. Open Edge: `edge://extensions`
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select:

   `C:\Users\1\Documents\内容营销方向赋能\douyin-luopan-video-downloader`

Chrome can load it from `chrome://extensions` in the same way.

After code changes, click `Reload` on the extension page and refresh the Luopan tab.

## Usage

1. Log in to Douyin Luopan in the same browser.
2. Open the target rank page.
3. Use the floating panel:
   - `扫描视频ID`: scan the current visible page and React data.
   - `开始下载`: start the slow detail-page download flow.
   - `停止`: stop after the current detail page finishes.
4. Start with `最多处理 = 1` or `5` for testing.

Downloads are saved under:

`Downloads/douyin-luopan-rank-videos/YYYY-MM-DD/<page title>/`

## Expected Skips

The plugin will skip a video when:

- no `video_id` can be found on the page;
- the Luopan detail page cannot be opened;
- the detail page opens but the preview player never exposes a media URL;
- the media URL looks like an image, HTML, CSS, JS, or another non-video asset;
- the platform shows a verification or risk page.

These skips are expected for videos that the frontend itself cannot open or play.

## Files

- `manifest.json`: Chrome / Edge extension config.
- `src/content.js`: floating panel, rank-page scanner, React fiber `video_id` extraction, detail-page `video.src` extraction.
- `src/background.js`: slow job state, detail tab opening, browser download submission, failure counting.
- `src/page-hook.js`: fetch/XHR observer for rank API `video_id` extraction.
- `src/content.css`: floating panel styles.
