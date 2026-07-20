const DEFAULT_FOLDER = "douyin-luopan-rank-videos";
const DOWNLOADED_KEY = "luopanDownloadedVideoKeys";

const slowJob = {
  active: false,
  folder: DEFAULT_FOLDER,
  settings: {},
  currentMeta: null,
  currentToken: "",
  completed: 0,
  failed: 0,
  failures: []
};

chrome.action.onClicked.addListener((tab) => {
  injectPanelIntoTab(tab).catch((error) => {
    console.warn("Failed to inject Luopan downloader panel:", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "SLOW_JOB_START") {
    startSlowJob(message.payload);
    sendResponse({ ok: true, result: publicSlowJobStatus() });
    return false;
  }

  if (message.type === "SLOW_JOB_STOP") {
    slowJob.active = false;
    slowJob.currentMeta = null;
    slowJob.currentToken = "";
    sendResponse({ ok: true, result: publicSlowJobStatus() });
    return false;
  }

  if (message.type === "SLOW_JOB_EXPECT_DETAIL") {
    slowJob.currentMeta = message.payload?.meta || null;
    slowJob.currentToken = slowJob.currentMeta?.__token || "";
    sendResponse({ ok: true, result: publicSlowJobStatus() });
    return false;
  }

  if (message.type === "SLOW_OPEN_DETAIL_TAB") {
    openDetailTab(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "SLOW_JOB_STATUS") {
    publicSlowJobStatusAsync()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "DEDUP_CLEAR") {
    chromeStorageSet({ [DOWNLOADED_KEY]: [] })
      .then(() => sendResponse({ ok: true, result: { dedupeCount: 0 } }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "SLOW_DETAIL_READY") {
    sendResponse({
      ok: true,
      result: {
        active: slowJob.active,
        meta: slowJob.currentMeta
      }
    });
    return false;
  }

  if (message.type === "SLOW_DETAIL_VIDEO_FOUND") {
    handleSlowDetailVideo(message.payload, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message.type === "SLOW_DETAIL_FAILED" || message.type === "SLOW_JOB_DETAIL_TIMEOUT") {
    recordSlowFailure(message.payload?.reason || "detail page did not expose video.src", sender, message.payload?.token);
    sendResponse({ ok: true, result: publicSlowJobStatus() });
    return false;
  }

  if (message.type === "DL_VIDEO_BATCH") {
    downloadBatch(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});

async function injectPanelIntoTab(tab = {}) {
  if (!tab.id || !/^https?:\/\/([^/]+\.)?(jinritemai|douyinec)\.com\//i.test(tab.url || "")) {
    throw new Error("Open a Luopan page before clicking the extension icon.");
  }

  await chromeScriptingInsertCSS({
    target: { tabId: tab.id },
    files: ["src/content.css"]
  });
  await chromeScriptingExecuteScript({
    target: { tabId: tab.id },
    files: ["src/content.js"]
  });
}

function chromeScriptingInsertCSS(options) {
  return new Promise((resolve, reject) => {
    chrome.scripting.insertCSS(options, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function chromeScriptingExecuteScript(options) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(options, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function startSlowJob(payload = {}) {
  slowJob.active = true;
  slowJob.folder = sanitizeDownloadPath(payload.folder || DEFAULT_FOLDER);
  slowJob.settings = payload.settings || {};
  slowJob.currentMeta = null;
  slowJob.currentToken = "";
  slowJob.completed = 0;
  slowJob.failed = 0;
  slowJob.failures = [];
}

function publicSlowJobStatus() {
  return {
    active: slowJob.active,
    folder: slowJob.folder,
    completed: slowJob.completed,
    failed: slowJob.failed,
    failures: slowJob.failures.slice(-10)
  };
}

async function publicSlowJobStatusAsync() {
  const keys = await readDownloadedKeys();
  return {
    ...publicSlowJobStatus(),
    dedupeCount: keys.size
  };
}

async function openDetailTab(payload = {}) {
  const meta = payload.meta || {};
  if (!meta.videoId) throw new Error("missing videoId");

  let url;
  if (meta.detailUrl && /^https?:\/\//i.test(meta.detailUrl)) {
    url = new URL(meta.detailUrl);
  } else {
    const baseUrl = payload.baseUrl || "https://compass.jinritemai.com";
    url = new URL("/shop/chance/rank-video", baseUrl);
    url.searchParams.set("video_id", meta.videoId);
    url.searchParams.set("video_shop_id", meta.shopId || "0");
    url.searchParams.set("source", "shipinxiaoliangbang");
    url.searchParams.set("from_page", "/shop/chance/rank-video/detail");
  }

  const tab = await chromeCreateTab({ url: url.toString(), active: false });
  return { tabId: tab.id, url: tab.url };
}

function chromeCreateTab(options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(options, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

async function handleSlowDetailVideo(payload = {}, sender = {}) {
  if (!slowJob.active) return publicSlowJobStatus();
  if (payload.token && payload.token !== slowJob.currentToken) {
    closeSenderTabLater(sender);
    return publicSlowJobStatus();
  }

  const video = {
    ...(slowJob.currentMeta || {}),
    ...(payload.video || {})
  };

  const result = await downloadBatch({
    folder: slowJob.folder,
    videos: [video]
  });

  if (result.started.length) {
    slowJob.completed += 1;
  } else if (result.skipped?.length) {
    slowJob.failed += 1;
    slowJob.failures.push({
      reason: result.skipped[0]?.reason || "already downloaded",
      title: video.title || video.detailTitle || "",
      url: video.url || ""
    });
  } else {
    slowJob.failed += 1;
    slowJob.failures.push({
      reason: result.failed[0]?.reason || "download submit failed",
      title: video.title || video.detailTitle || "",
      url: video.url || ""
    });
  }

  slowJob.currentMeta = null;
  slowJob.currentToken = "";
  closeSenderTabLater(sender);
  return publicSlowJobStatus();
}

function recordSlowFailure(reason, sender = {}, token = "") {
  if (!slowJob.active && !slowJob.currentMeta) return;
  if (token && slowJob.currentToken && token !== slowJob.currentToken) {
    closeSenderTabLater(sender);
    return;
  }

  slowJob.failed += 1;
  slowJob.failures.push({
    reason,
    title: slowJob.currentMeta?.title || "",
    videoId: slowJob.currentMeta?.videoId || "",
    url: sender.tab?.url || ""
  });
  slowJob.currentMeta = null;
  slowJob.currentToken = "";
  closeSenderTabLater(sender);
}

async function downloadBatch(payload = {}) {
  const videos = Array.isArray(payload.videos) ? payload.videos : [];
  const folder = sanitizeDownloadPath(payload.folder || DEFAULT_FOLDER);
  const downloadedKeys = await readDownloadedKeys();
  const started = [];
  const failed = [];
  const skipped = [];

  for (const [index, video] of videos.entries()) {
    const url = pickDownloadUrl(video);
    if (!url) {
      failed.push({ index, reason: "no downloadable video URL", video });
      continue;
    }

    const validation = await validateDownloadUrl(url);
    if (!validation.ok) {
      failed.push({ index, reason: validation.reason, url, video });
      continue;
    }

    const ext = extensionFromUrl(validation.finalUrl || url, validation.contentType);
    const rankPrefix = video.rank ? `${String(video.rank).padStart(3, "0")}_` : `${String(index + 1).padStart(3, "0")}_`;
    const title = sanitizePathSegment(video.title || video.author || video.videoId || `video_${index + 1}`);
    const filename = `${folder}/${rankPrefix}${title}.${ext}`;
    const keys = makeDedupeKeys(video, validation.finalUrl || url, filename);
    const matchedKey = keys.find((key) => downloadedKeys.has(key));
    if (matchedKey) {
      skipped.push({ index, reason: "already downloaded", key: matchedKey, url, filename, video });
      continue;
    }

    if (await hasExistingDownload(filename)) {
      for (const key of keys) downloadedKeys.add(key);
      skipped.push({ index, reason: "same filename already exists in browser download history", key: `file:${filename}`, url, filename, video });
      continue;
    }

    try {
      const downloadId = await chromeDownload({
        url: validation.finalUrl || url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      started.push({ index, downloadId, filename, url });
      for (const key of keys) downloadedKeys.add(key);
      await delay(250);
    } catch (error) {
      failed.push({ index, reason: String(error?.message || error), video });
    }
  }

  if (started.length || skipped.length) await writeDownloadedKeys(downloadedKeys);
  return { requested: videos.length, started, failed, skipped };
}

async function readDownloadedKeys() {
  const result = await chromeStorageGet(DOWNLOADED_KEY).catch(() => ({}));
  return new Set(Array.isArray(result[DOWNLOADED_KEY]) ? result[DOWNLOADED_KEY] : []);
}

async function writeDownloadedKeys(keys) {
  const values = Array.from(keys).slice(-5000);
  await chromeStorageSet({ [DOWNLOADED_KEY]: values }).catch(() => {});
}

function chromeStorageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function chromeStorageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function makeDedupeKeys(video, url, filename) {
  const keys = [];
  const id = String(video.videoId || video.id || "").trim();
  if (/^\d{8,}$/.test(id)) keys.push(`id:${id}`);
  keys.push(`url:${normalizeMediaUrl(url)}`);
  if (filename) {
    keys.push(`file:${filename.toLowerCase()}`);
    keys.push(`name:${pathBasename(filename).replace(/\s+\(\d+\)(?=\.[^.]+$)/, "").toLowerCase()}`);
  }
  return Array.from(new Set(keys.filter(Boolean)));
}

function normalizeMediaUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(x-expires|expires|expire|sign|signature|token|auth|br|btm_|ts|t)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || "");
  }
}

async function hasExistingDownload(filename) {
  const base = pathBasename(filename);
  const normalizedBase = base.replace(/\s+\(\d+\)(?=\.[^.]+$)/, "").toLowerCase();
  const stem = normalizedBase.replace(/\.[^.]+$/, "");
  const query = stem.length > 6 ? stem.slice(0, Math.min(stem.length, 32)) : stem;
  const matches = await chromeDownloadsSearch({ query: query ? [query] : [], limit: 200 }).catch(() => []);
  return matches.some((item) => {
    const itemBase = pathBasename(item.filename || "").replace(/\s+\(\d+\)(?=\.[^.]+$)/, "").toLowerCase();
    return itemBase === normalizedBase && item.exists !== false;
  });
}

function chromeDownloadsSearch(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.search(options, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items || []);
    });
  });
}

function pathBasename(value) {
  return String(value || "").split(/[\\/]+/).pop() || "";
}

function chromeDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

function closeSenderTabLater(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isFinite(tabId)) return;
  setTimeout(() => {
    chrome.tabs.remove(tabId, () => {
      // Ignore close failures; the user may have closed the detail tab already.
    });
  }, 1200);
}

function pickDownloadUrl(video) {
  const candidates = [
    video.downloadUrl,
    video.url,
    video.playUrl,
    video.videoUrl,
    video.sourceUrl,
    ...(Array.isArray(video.urls) ? video.urls : [])
  ].filter(Boolean);
  return candidates.find((url) => /^https?:\/\//i.test(url));
}

async function validateDownloadUrl(url) {
  if (!isLikelyMediaUrl(url)) {
    return { ok: false, reason: "URL does not look like video media" };
  }

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      cache: "no-store",
      credentials: "include"
    });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || url;

    if (isRejectedContentType(contentType) || !isLikelyMediaUrl(finalUrl)) {
      return { ok: false, reason: `not video response: ${contentType || "unknown"}`, contentType, finalUrl };
    }

    if (contentType && !isAcceptedContentType(contentType) && !isLikelyMediaUrl(finalUrl)) {
      return { ok: false, reason: `unsupported content type: ${contentType}`, contentType, finalUrl };
    }

    return { ok: true, contentType, finalUrl };
  } catch {
    return { ok: true, contentType: "", finalUrl: url };
  }
}

function extensionFromUrl(url, contentType = "") {
  const type = String(contentType).toLowerCase();
  if (type.includes("mpegurl") || type.includes("m3u8")) return "m3u8";
  if (type.includes("quicktime")) return "mov";
  if (type.includes("webm")) return "webm";
  if (type.includes("mp4") || type.includes("video/")) return "mp4";

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.includes(".m3u8")) return "m3u8";
    if (pathname.includes(".mov")) return "mov";
    if (pathname.includes(".webm")) return "webm";
  } catch {
    // Fall through to mp4.
  }
  return "mp4";
}

function isLikelyMediaUrl(value) {
  if (!value || !/^https?:\/\//i.test(value) || isBadAssetUrl(value)) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const url = decodeURIComponent(String(value)).toLowerCase();
  const host = parsed.hostname.toLowerCase();

  if (/\.(mp4|m3u8|mov|webm)(\?|#|$)/i.test(url)) return true;
  if (/mime_type=video|video_mp4|aweme\/v1\/play|playwm|play_addr|download_addr|main_url|backup_url|video_url/.test(url)) return true;
  return /(douyinvod|douyinvideo|bytevcloud|ixigua|amemv)/.test(host) && /(video|play|vid=|mime_type=video|tos-)/.test(url);
}

function isBadAssetUrl(value) {
  return /\.(png|jpe?g|webp|gif|svg|ico|css|js|html?|woff2?|ttf)(\?|#|$)|tplv-[^/]+-image|avatar|cover|poster|image\.image/i.test(value);
}

function isRejectedContentType(contentType) {
  return /image\/|text\/html|text\/css|javascript|font\/|svg/.test(contentType);
}

function isAcceptedContentType(contentType) {
  return /video\/|mpegurl|mp4|octet-stream|application\/vnd\.apple\.mpegurl/.test(contentType);
}

function sanitizePathSegment(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

function sanitizeDownloadPath(value) {
  return String(value)
    .split(/[\\/]+/)
    .map(sanitizePathSegment)
    .filter(Boolean)
    .join("/") || DEFAULT_FOLDER;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
