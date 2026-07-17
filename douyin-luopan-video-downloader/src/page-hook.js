(() => {
  if (window.__luopanVideoHookInstalled) return;
  window.__luopanVideoHookInstalled = true;

  const EVENT_NAME = "LUOPAN_VIDEO_CANDIDATES";
  const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;
  const RESPONSE_HINT_RE = /\.(mp4|m3u8|mov|webm)(\?|$)|playwm|play_addr|download_addr|video_id|aweme_id|vid=|douyinvod|aweme\/v1\/play/i;
  const MEDIA_FILE_RE = /\.(mp4|m3u8|mov|webm)(\?|#|$)/i;
  const BAD_ASSET_RE = /\.(png|jpe?g|webp|gif|svg|ico|css|js|html?|woff2?|ttf)(\?|#|$)|tplv-[^/]+-image|avatar|cover|poster|image\.image/i;
  const TITLE_KEYS = new Set(["title", "desc", "description", "video_name", "item_title", "text"]);
  const AUTHOR_KEYS = new Set(["author", "author_name", "nickname", "account_name", "creator_name"]);
  const ID_KEYS = new Set(["id", "item_id", "aweme_id", "video_id", "vid"]);

  patchFetch();
  patchXhr();

  window.postMessage({ source: EVENT_NAME, type: "HOOK_READY" }, "*");

  function patchFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") return;

    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      inspectResponse(response.clone(), urlFromFetchArgs(args));
      return response;
    };
  }

  function patchXhr() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__luopanVideoHookPatched) return;
    proto.__luopanVideoHookPatched = true;

    const originalOpen = proto.open;

    proto.open = function patchedOpen(method, url, ...rest) {
      this.__luopanVideoHookUrl = String(url || "");
      this.addEventListener("load", () => {
        const requestUrl = this.__luopanVideoHookUrl || "";
        const contentType = this.getResponseHeader("content-type") || "";
        if (!isLikelyUseful(requestUrl, contentType)) return;
        const text = typeof this.responseText === "string" ? this.responseText : "";
        inspectText(text, requestUrl);
      });
      return originalOpen.call(this, method, url, ...rest);
    };
  }

  async function inspectResponse(response, requestUrl) {
    const contentType = response.headers.get("content-type") || "";
    if (!isLikelyUseful(requestUrl, contentType)) return;

    try {
      const text = await response.text();
      inspectText(text, requestUrl);
    } catch {
      // Some streams cannot be cloned/read. Ignore them.
    }
  }

  function inspectText(text, requestUrl) {
    if (!text || !RESPONSE_HINT_RE.test(text)) return;

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const candidates = parsed ? extractFromJson(parsed) : extractUrlsFromText(text).map((url) => ({ urls: [url] }));
    const normalized = normalizeCandidates(candidates, requestUrl);
    const rankItems = parsed ? extractRankItems(parsed, requestUrl) : [];
    if (!normalized.length && !rankItems.length) return;

    window.postMessage(
      {
        source: EVENT_NAME,
        type: "VIDEO_CANDIDATES",
        requestUrl,
        videos: normalized,
        rankItems
      },
      "*"
    );
  }

  function extractRankItems(root, requestUrl) {
    if (!/video_rank|rank-video|bring_good_flow_hot|hot_v2|video-rank/i.test(requestUrl)) return [];

    const items = [];
    walk(root, [], (node, path) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;

      const videoId = firstValueByPattern(node, /^(video_id|videoId|item_id|itemId|aweme_id|awemeId|id)$/i);
      if (!videoId || !/^\d{8,}$/.test(String(videoId))) return;

      const title = firstValueByPattern(node, /title|name|desc|text|video_name|item_title/i);
      const author = firstValueByPattern(node, /author|nickname|account|shop_name|room_name|creator/i);
      const rank = firstValueByPattern(node, /rank|ranking|top|order|index/i);
      const shopId = firstValueByPattern(node, /shop_id|shopId|video_shop_id|videoShopId/i);

      items.push({
        videoId: String(videoId),
        shopId: shopId == null ? "0" : String(shopId),
        title: stringifyValue(title),
        author: stringifyValue(author),
        rank: Number(rank) || "",
        sourcePath: path.join("."),
        requestUrl
      });
    });

    const byId = new Map();
    for (const item of items) {
      if (!byId.has(item.videoId)) byId.set(item.videoId, item);
      else byId.set(item.videoId, { ...byId.get(item.videoId), ...item, title: byId.get(item.videoId).title || item.title });
    }
    return Array.from(byId.values());
  }

  function firstValueByPattern(node, pattern) {
    for (const [key, value] of Object.entries(node)) {
      if (!pattern.test(key)) continue;
      if (typeof value === "string" || typeof value === "number") return value;
    }
    return "";
  }

  function extractFromJson(root) {
    const found = [];

    walk(root, [], (node, path) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;

      const urls = extractUrlsFromNode(node);
      const id = findValueByKeys(node, ID_KEYS);
      const title = findValueByKeys(node, TITLE_KEYS);
      const author = findValueByKeys(node, AUTHOR_KEYS);

      if (urls.length || id || looksLikeVideoObject(node, path)) {
        found.push({
          id: stringifyValue(id),
          title: stringifyValue(title),
          author: stringifyValue(author),
          urls
        });
      }
    });

    return found;
  }

  function extractUrlsFromNode(node) {
    const urls = [];

    walk(node, [], (value, path) => {
      if (typeof value !== "string") return;
      if (isLikelyVideoUrl(value, path)) {
        urls.push(value);
      }
    });

    return dedupe(urls);
  }

  function extractUrlsFromText(text) {
    return dedupe((text.match(URL_RE) || []).filter((url) => isLikelyVideoUrl(url, [])));
  }

  function normalizeCandidates(candidates, requestUrl) {
    const byKey = new Map();

    for (const raw of candidates) {
      const urls = dedupe([raw.url, raw.downloadUrl, raw.playUrl, raw.videoUrl, ...(raw.urls || [])].filter(Boolean));
      if (!urls.length) continue;

      const bestUrl = pickBestUrl(urls);
      const key = raw.id || bestUrl;
      const previous = byKey.get(key) || {};

      byKey.set(key, {
        ...previous,
        id: raw.id || previous.id || key,
        title: raw.title || previous.title || "",
        author: raw.author || previous.author || "",
        url: bestUrl,
        urls: dedupe([...(previous.urls || []), ...urls]),
        requestUrl
      });
    }

    return Array.from(byKey.values());
  }

  function pickBestUrl(urls) {
    const sorted = [...urls].sort((a, b) => scoreUrl(b) - scoreUrl(a));
    return sorted[0];
  }

  function scoreUrl(url) {
    let score = 0;
    if (/\.mp4(\?|#|$)/i.test(url)) score += 20;
    if (/\.m3u8(\?|#|$)/i.test(url)) score += 14;
    if (/douyinvod|aweme\/v1\/play|play_addr|download_addr|video/i.test(url)) score += 8;
    if (/watermark|playwm/i.test(url)) score -= 2;
    if (BAD_ASSET_RE.test(url)) score -= 100;
    return score;
  }

  function isLikelyVideoUrl(value, path) {
    if (!/^https?:\/\//i.test(value)) return false;
    if (BAD_ASSET_RE.test(value)) return false;

    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }

    const url = decodeURIComponent(value).toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const keyText = path.map((key) => String(key).toLowerCase()).join(".");

    if (MEDIA_FILE_RE.test(url)) return true;
    if (/aweme\/v1\/play|playwm|play_addr|download_addr|main_url|backup_url|video_url/.test(url)) return true;
    if (/(douyinvod|douyinvideo|bytevcloud|ixigua|amemv)/.test(host) && /(video|play|vid=|mime_type=video|tos-)/.test(url)) return true;
    if (/(play|download|video).*(url|addr)|main_url|backup_url/.test(keyText) && !/(cover|avatar|image|poster|icon|logo)/.test(keyText)) {
      return /(video|play|vid=|mime_type=video|douyinvod|\.mp4|\.m3u8)/.test(url);
    }

    return false;
  }

  function looksLikeVideoObject(node, path) {
    const keyText = Object.keys(node).join(" ").toLowerCase();
    return /video|aweme|item/.test(keyText) || path.some((key) => /video|aweme|item|rank/i.test(String(key)));
  }

  function findValueByKeys(node, keys) {
    for (const [key, value] of Object.entries(node)) {
      if (!keys.has(key)) continue;
      if (typeof value === "string" || typeof value === "number") return value;
    }
    return "";
  }

  function stringifyValue(value) {
    if (value == null) return "";
    return String(value).trim();
  }

  function walk(value, path, visitor, depth = 0, seen = new WeakSet()) {
    if (depth > 8) return;
    visitor(value, path);

    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], path.concat(index), visitor, depth + 1, seen);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      walk(child, path.concat(key), visitor, depth + 1, seen);
    }
  }

  function urlFromFetchArgs(args) {
    const input = args[0];
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isLikelyUseful(url, contentType) {
    const haystack = `${url} ${contentType}`;
    return /json|text|rank|video|aweme|item|compass|luopan|live/i.test(haystack);
  }

  function dedupe(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }
})();
