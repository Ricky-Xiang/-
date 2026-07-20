(() => {
  if (window.__luopanDownloaderContentInstalled) return;
  window.__luopanDownloaderContentInstalled = true;

  const STORE_KEY = "luopanVideoDownloadSettings";
  const DEFAULT_SETTINGS = {
    delayMinMs: 4000,
    delayMaxMs: 8000,
    detailTimeoutMs: 30000,
    maxItems: 50,
    autoScroll: true,
    maxScrollRounds: 30
  };

  const state = {
    panelOpen: true,
    busy: false,
    stop: false,
    runId: 0,
    rankItems: new Map(),
    mediaItems: new Map(),
    processedMediaKeys: new Set(),
    started: 0,
    completed: 0,
    failed: 0,
    lastMessage: "就绪：先扫描或一键下载，仅下载可正常播放的视频。"
  };

  injectHook();
  window.addEventListener("message", handlePageHookMessage);

  if (isDetailPage()) {
    runDetailCollector();
    return;
  }

  installInteractiveCapture();
  createUiWhenReady();

  function injectHook() {
    if (!document.documentElement) {
      setTimeout(injectHook, 0);
      return;
    }
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-hook.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function handlePageHookMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "LUOPAN_VIDEO_CANDIDATES") return;
    addItems(Array.isArray(data.rankItems) ? data.rankItems : [], "api");
    addMediaItems(Array.isArray(data.videos) ? data.videos : [], "api-media");
  }

  function createUiWhenReady() {
    if (document.documentElement) {
      createUi();
      restoreSettings();
      return;
    }
    document.addEventListener("DOMContentLoaded", () => {
      createUi();
      restoreSettings();
    }, { once: true });
  }

  function createUi() {
    if (document.getElementById("luopan-video-downloader-root")) return;
    const root = document.createElement("div");
    root.id = "luopan-video-downloader-root";
    document.documentElement.appendChild(root);
    render();
  }

  function render() {
    const root = document.getElementById("luopan-video-downloader-root");
    if (!root) return;
    root.innerHTML = "";

    if (!state.panelOpen) {
      const mini = document.createElement("button");
      mini.className = "luopan-video-downloader-mini";
      mini.textContent = state.busy ? `下载中 ${state.completed}/${state.started}` : "罗盘下载";
      mini.addEventListener("click", () => {
        state.panelOpen = true;
        render();
      });
      root.appendChild(mini);
      return;
    }

    const panel = document.createElement("div");
    panel.className = "luopan-video-downloader-panel";
    panel.innerHTML = `
      <div class="luopan-video-downloader-header">
        <span>罗盘视频下载</span>
        <button class="luopan-video-downloader-close" title="收起">x</button>
      </div>
      <div class="luopan-video-downloader-body">
        <div class="luopan-video-downloader-status"></div>
        <label class="luopan-video-downloader-field">
          <span>下载数量</span>
          <input data-setting="maxItems" type="number" min="1" max="200" value="${DEFAULT_SETTINGS.maxItems}">
        </label>
        <label class="luopan-video-downloader-field">
          <span>自动翻页</span>
          <label><input data-setting="autoScroll" type="checkbox" checked> 开启</label>
        </label>
        <div class="luopan-video-downloader-actions">
          <button class="luopan-video-downloader-button" data-action="one-click">一键批量下载</button>
        </div>
      </div>
    `;

    panel.querySelector(".luopan-video-downloader-close").addEventListener("click", () => {
      state.panelOpen = false;
      render();
    });
    panel.querySelector('[data-action="one-click"]').addEventListener("click", () => {
      if (state.busy) stopDownload();
      else oneClickDownload();
    });
    panel.querySelector('[data-setting="maxItems"]').addEventListener("change", persistSettings);
    panel.querySelector('[data-setting="autoScroll"]').addEventListener("change", persistSettings);

    root.appendChild(panel);
    updateUi();
  }

  function updateUi() {
    const status = document.querySelector(".luopan-video-downloader-status");
    if (status) {
      status.textContent = `${state.lastMessage}\nID=${state.rankItems.size}，媒体=${state.mediaItems.size}，已处理=${state.started}，成功=${state.completed}，跳过=${state.failed}`;
    }

    const oneClickButton = document.querySelector('[data-action="one-click"]');
    if (oneClickButton) {
      oneClickButton.textContent = state.busy ? "停止下载" : "一键批量下载";
      oneClickButton.classList.toggle("stopping", state.busy);
    }
  }

  function setStatus(message) {
    state.lastMessage = message;
    updateUi();
  }

  async function restoreSettings() {
    const result = await chrome.storage.local.get(STORE_KEY).catch(() => ({}));
    const settings = { ...DEFAULT_SETTINGS, ...(result[STORE_KEY] || {}) };
    const maxItems = document.querySelector('[data-setting="maxItems"]');
    const autoScroll = document.querySelector('[data-setting="autoScroll"]');
    if (maxItems) maxItems.value = String(settings.maxItems);
    if (autoScroll) autoScroll.checked = Boolean(settings.autoScroll);
    updateUi();
  }

  async function persistSettings() {
    await chrome.storage.local.set({ [STORE_KEY]: readSettings() }).catch(() => {});
  }

  function readSettings() {
    const delayValue = document.querySelector('[data-setting="delay"]')?.value || "4000,8000";
    const [delayMinMs, delayMaxMs] = delayValue.split(",").map(Number);
    const maxItems = clamp(Number(document.querySelector('[data-setting="maxItems"]')?.value || DEFAULT_SETTINGS.maxItems), 1, 200);
    const autoScroll = Boolean(document.querySelector('[data-setting="autoScroll"]')?.checked);
    return {
      delayMinMs: Number.isFinite(delayMinMs) ? delayMinMs : DEFAULT_SETTINGS.delayMinMs,
      delayMaxMs: Number.isFinite(delayMaxMs) ? delayMaxMs : DEFAULT_SETTINGS.delayMaxMs,
      detailTimeoutMs: DEFAULT_SETTINGS.detailTimeoutMs,
      maxItems,
      autoScroll,
      maxScrollRounds: DEFAULT_SETTINGS.maxScrollRounds
    };
  }

  async function startDownload() {
    if (state.busy) return;
    state.runId += 1;
    state.stop = false;
    const runId = state.runId;
    const settings = readSettings();
    await persistSettings();
    scanPageForVideoIds(false);
    collectVisibleDetailLinks();

    const firstPassVideos = getMediaVideos(settings.maxItems);
    if (state.stop || runId !== state.runId) return;

    if (firstPassVideos.length) {
      state.busy = true;
      state.started = firstPassVideos.length;
      state.completed = 0;
      state.failed = 0;
      setStatus(`发现 ${firstPassVideos.length} 个媒体地址，正在直接提交下载...`);
      try {
        const { started, failed } = await submitMediaVideos(firstPassVideos);
        if (!state.stop && runId === state.runId) {
          state.completed = started;
          state.failed = failed;
          setStatus(`直接下载已提交。成功=${started}，失败=${failed}`);
        }
      } finally {
        state.busy = false;
        updateUi();
      }
      return;
    }

    if (state.stop || runId !== state.runId) return;

    const startResponse = await sendMessage({
      type: "SLOW_JOB_START",
      payload: { folder: makeFolderName(), settings, sourceUrl: location.href, pageTitle: document.title }
    });
    if (!startResponse?.ok) {
      setStatus(`启动失败：${startResponse?.error || "未知错误"}`);
      return;
    }

    state.busy = true;
    state.stop = false;
    state.started = 0;
    state.completed = 0;
    state.failed = 0;
    state.processedMediaKeys.clear();
    updateUi();

    try {
      await processQueue(settings, runId);
    } finally {
      await sendMessage({ type: "SLOW_JOB_STOP" });
      state.busy = false;
      updateUi();
    }
  }

  async function oneClickDownload() {
    if (state.busy) return;
    state.runId += 1;
    const runId = state.runId;
    const settings = readSettings();
    await persistSettings();

    state.busy = true;
    state.stop = false;
    state.started = 0;
    state.completed = 0;
    state.failed = 0;
    state.processedMediaKeys.clear();
    setStatus("一键下载：正在准备页面并触发播放器...");

    try {
      await runOneClickRounds(settings, runId);
    } finally {
      state.busy = false;
      updateUi();
    }
  }

  async function runOneClickRounds(settings, runId) {
    let scrollRound = 0;
    let idleRounds = 0;

    while (!state.stop && runId === state.runId && state.started < settings.maxItems) {
      scanPageForVideoIds(false);
      collectVisibleDetailLinks();

      let videos = getMediaVideos(settings.maxItems - state.started);
      if (!videos.length) {
        await triggerVisibleVideoBatch(settings.maxItems - state.started, runId);
        videos = getMediaVideos(settings.maxItems - state.started);
      }

      if (videos.length) {
        const result = await submitMediaVideos(videos);
        state.completed += result.started;
        state.failed += result.failed;
        state.started += videos.length;
        removeProcessedMedia(videos);
        closeVisiblePlayerOverlay();
        idleRounds = 0;
        setStatus(`一键下载：本轮 ${videos.length} 个。成功=${state.completed}，失败/跳过=${state.failed}`);
      } else {
        idleRounds += 1;
        setStatus(`一键下载：本屏暂无新媒体。空轮次=${idleRounds}`);
      }

      if (!settings.autoScroll || scrollRound >= settings.maxScrollRounds || idleRounds >= 5 || state.started >= settings.maxItems) break;
      scrollRound += 1;
      closeVisiblePlayerOverlay();
      const advanced = await advanceRankList(runId);
      clearVisibleProbeMarks();
      await delay(600);
      if (!advanced) {
        idleRounds += 1;
        setStatus(`一键下载：尝试翻页但列表未明显变化。空轮次=${idleRounds}`);
      }
    }

    if (!state.stop && runId === state.runId) {
      setStatus(`一键下载结束。成功=${state.completed}，跳过=${state.failed}，处理=${state.started}`);
    }
  }

  function getMediaVideos(limit) {
    const videos = [...collectVisiblePageVideos(), ...collectCapturedMediaVideos()];
    const out = [];
    for (const video of videos) {
      const key = mediaQueueKey(video);
      if (key && state.processedMediaKeys.has(key)) continue;
      out.push(video);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function submitMediaVideos(videos) {
    const batch = videos;
    if (!batch.length) return { started: 0, failed: 0, skipped: 0 };
    for (const video of batch) {
      const key = mediaQueueKey(video);
      if (key) state.processedMediaKeys.add(key);
    }

    const result = await sendMessage({
      type: "DL_VIDEO_BATCH",
      payload: {
        folder: makeFolderName(),
        videos: batch
      }
    });
    return {
      started: result?.result?.started?.length || 0,
      failed: result?.result?.failed?.length || 0
    };
  }

  function removeProcessedMedia(videos) {
    for (const video of videos) {
      const key = mediaQueueKey(video);
      if (!key) continue;
      for (const [url, item] of Array.from(state.mediaItems.entries())) {
        if (mediaQueueKey(item) === key || url === video.url || url === video.sourceUrl) {
          state.mediaItems.delete(url);
        }
      }
    }
  }

  function mediaQueueKey(video) {
    const id = String(video.videoId || video.id || "").trim();
    if (/^\d{8,}$/.test(id)) return `id:${id}`;
    const url = video.url || video.sourceUrl || video.playUrl || video.downloadUrl || "";
    if (!url) return "";
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return `url:${parsed.href}`;
    } catch {
      return `url:${url}`;
    }
  }

  function closeVisiblePlayerOverlay() {
    const closeSelectors = [
      "[aria-label*='关闭']",
      "[aria-label*='close' i]",
      "[title*='关闭']",
      "[title*='close' i]",
      "[class*='close' i]",
      "[class*='modal-close' i]",
      "[class*='drawer-close' i]",
      "[class*='DialogClose' i]",
      "[class*='ModalClose' i]",
      "button",
      "[role='button']",
      "span",
      "div"
    ];
    const closeCandidates = Array.from(document.querySelectorAll(closeSelectors.join(",")))
      .filter((element) => !isInsideDownloader(element))
      .filter(isVisible)
      .filter((element) => {
        const text = cleanText(element.innerText || element.getAttribute("aria-label") || element.title || "");
        const className = String(element.className || "");
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const looksLikeClose = /关闭|收起|close|modal-close|drawer-close|dialog-close/i.test(`${text} ${className} ${element.getAttribute("aria-label") || ""} ${element.title || ""}`);
        const isOverlayLayer = style.position === "fixed" || Boolean(element.closest("[role='dialog'],[class*='modal' i],[class*='drawer' i],[class*='popup' i]"));
        const looksLikeTopRightIcon = isOverlayLayer && rect.width <= 60 && rect.height <= 60 && rect.left > window.innerWidth * 0.55 && rect.top < window.innerHeight * 0.45;
        return looksLikeClose || looksLikeTopRightIcon;
      })
      .sort((a, b) => scoreCloseCandidate(b) - scoreCloseCandidate(a));

    if (closeCandidates[0]) {
      dispatchRealClick(closeCandidates[0]);
      return true;
    }

    dispatchEscapeKey();
    return false;
  }

  function scoreCloseCandidate(element) {
    const text = cleanText(element.innerText || element.getAttribute("aria-label") || element.title || "");
    const className = String(element.className || "");
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    let score = 0;
    if (/关闭|close/i.test(text)) score += 30;
    if (/close|modal|drawer|dialog/i.test(className)) score += 20;
    if (style.position === "fixed") score += 8;
    if (element.closest("[role='dialog'],[class*='modal' i],[class*='drawer' i],[class*='popup' i]")) score += 8;
    if (rect.left > window.innerWidth * 0.7) score += 5;
    if (rect.top < window.innerHeight * 0.35) score += 5;
    if (rect.width <= 40 && rect.height <= 40) score += 3;
    return score;
  }

  function dispatchEscapeKey() {
    const eventInit = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    for (const target of [document.activeElement, document.body, document, window].filter(Boolean)) {
      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    }
  }

  async function triggerFirstPlayableVideo(runId = state.runId) {
    const candidates = collectClickableVideoCandidates()
      .filter((element) => !element.getAttribute("data-luopan-oneclick-probed"))
      .slice(0, 2);
    if (!candidates.length) {
      setStatus("一键下载：没有找到可点击的视频入口。");
      return false;
    }

    for (const candidate of candidates) {
      if (state.stop || runId !== state.runId) return false;
      candidate.setAttribute("data-luopan-oneclick-probed", "true");
      const beforeUrl = location.href;
      const beforeMedia = collectVisiblePageVideos().length + collectCapturedMediaVideos().length;
      dispatchRealClick(candidate);
      setStatus("一键下载：已点击一个可见视频入口，等待媒体地址...");

      const ready = await waitForMediaReady(5000, beforeMedia, runId);
      if (ready > beforeMedia) return true;

      const urlVideoId = new URL(location.href).searchParams.get("video_id") || "";
      if (/^\d{8,}$/.test(urlVideoId)) return true;

      if (location.href !== beforeUrl) {
        history.back();
        await waitForUrl(beforeUrl, 3500);
      }
      await delay(500);
    }
    return false;
  }

  async function triggerVisibleVideoBatch(limit, runId = state.runId) {
    const candidates = collectClickableVideoCandidates()
      .filter((element) => !element.getAttribute("data-luopan-oneclick-probed"))
      .slice(0, Math.min(12, Math.max(1, limit)));
    if (!candidates.length) return 0;

    let captured = 0;
    for (const [index, candidate] of candidates.entries()) {
      if (state.stop || runId !== state.runId) break;
      candidate.setAttribute("data-luopan-oneclick-probed", "true");
      const beforeKeys = new Set(state.mediaItems.keys());
      const row = findRankRow(candidate);
      const rowText = cleanText(row?.innerText || "");
      const meta = {
        title: extractTitle(rowText),
        author: extractAuthor(rowText),
        rank: extractRank(rowText, state.started + captured + 1)
      };

      dispatchRealClick(candidate);
      setStatus(`批量采集：本屏 ${index + 1}/${candidates.length}，已捕获 ${captured} 个...`);
      await waitForNewCapturedMedia(beforeKeys, index === 0 ? 2500 : 1600, runId);

      for (const [url, item] of state.mediaItems.entries()) {
        if (beforeKeys.has(url)) continue;
        state.mediaItems.set(url, {
          ...item,
          title: meta.title || item.title,
          author: meta.author || item.author,
          rank: meta.rank || item.rank
        });
        captured += 1;
      }
      closeVisiblePlayerOverlay();
      await delay(180);
    }
    return captured;
  }

  async function waitForNewCapturedMedia(beforeKeys, timeoutMs, runId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (state.stop || runId !== state.runId) return false;
      if ([...state.mediaItems.keys()].some((key) => !beforeKeys.has(key))) return true;
      const visible = collectVisiblePageVideos();
      if (visible.length) {
        addMediaItems(visible, "visible-batch");
        if ([...state.mediaItems.keys()].some((key) => !beforeKeys.has(key))) return true;
      }
      await delay(200);
    }
    return false;
  }

  async function waitForMediaReady(timeoutMs, previousCount = 0, runId = state.runId) {
    const startedAt = Date.now();
    let lastCount = previousCount;
    while (Date.now() - startedAt < timeoutMs) {
      if (state.stop || runId !== state.runId) return lastCount;
      scanPageForVideoIds(false);
      collectVisibleDetailLinks();
      const count = collectVisiblePageVideos().length + collectCapturedMediaVideos().length;
      lastCount = Math.max(lastCount, count);
      if (count > previousCount || count > 0) return count;
      await delay(500);
    }
    return lastCount;
  }

  async function stopDownload() {
    state.stop = true;
    state.runId += 1;
    state.busy = false;
    setStatus("已收到停止指令。");
    await sendMessage({ type: "SLOW_JOB_STOP" });
    updateUi();
  }

  async function resetDownloadState() {
    state.busy = false;
    state.stop = false;
    state.runId += 1;
    state.started = 0;
    state.completed = 0;
    state.failed = 0;
    await sendMessage({ type: "SLOW_JOB_STOP" });
    setStatus("已重置，可以重新点击一键下载或开始。");
    updateUi();
  }


  async function processQueue(settings, runId = state.runId) {
    let idleRounds = 0;
    while (!state.stop && runId === state.runId && state.started < settings.maxItems && idleRounds < 5) {
      const beforeCount = state.rankItems.size;
      scanPageForVideoIds(false);
      collectVisibleDetailLinks();

      const queue = Array.from(state.rankItems.values()).filter((item) => !item.__handled && item.videoId);
      if (!queue.length) {
        const harvested = await harvestVideoIdsByClicking(settings.maxItems - state.started, runId);
        if (harvested > 0) {
          idleRounds = 0;
          continue;
        }
        idleRounds += 1;
        scrollRankList();
        await delay(1800);
        continue;
      }

      idleRounds = state.rankItems.size === beforeCount ? idleRounds + 1 : 0;
      for (const item of queue) {
        if (state.stop || runId !== state.runId || state.started >= settings.maxItems) break;
        item.__handled = true;
        state.started += 1;

        const token = `${Date.now()}-${state.started}-${Math.random().toString(36).slice(2)}`;
        const meta = {
          __token: token,
          videoId: item.videoId,
          shopId: item.shopId || "0",
          rank: item.rank || state.started,
          title: item.title || "",
          author: item.author || "",
          sourceRankUrl: location.href,
          source: item.source || ""
        };

        setStatus(`正在打开详情 ${state.started}/${settings.maxItems}：${meta.title || meta.videoId}`);
        const before = await getJobStatus();
        if (state.stop || runId !== state.runId) break;
        await sendMessage({ type: "SLOW_JOB_EXPECT_DETAIL", payload: { meta } });
        const openResult = await sendMessage({ type: "SLOW_OPEN_DETAIL_TAB", payload: { meta, baseUrl: location.origin } });
        if (!openResult?.ok) {
          state.failed += 1;
          setStatus(`打开详情失败：${openResult?.error || "未知错误"}`);
          continue;
        }

        await waitForOneDetailResult(before, settings.detailTimeoutMs, token, runId);
        const after = await getJobStatus();
        state.completed = after.completed || state.completed;
        state.failed = after.failed || state.failed;
        setStatus(`已处理 ${state.started} 条。成功=${state.completed}，跳过=${state.failed}`);
        await delay(randomInt(settings.delayMinMs, settings.delayMaxMs));
      }
    }
    setStatus(state.stop ? "已停止。" : "处理结束：没有更多可识别的视频。");
  }

  async function harvestVideoIdsByClicking(limit, runId = state.runId) {
    if (limit <= 0 || isDetailPage()) return 0;

    const originalUrl = location.href;
    const candidates = collectClickableVideoCandidates()
      .filter((element) => !element.getAttribute("data-luopan-dl-probed"))
      .slice(0, Math.min(limit, 8));

    let addedTotal = 0;
    for (const element of candidates) {
      if (state.stop || runId !== state.runId) break;
      element.setAttribute("data-luopan-dl-probed", "true");
      setStatus(`Probing visible video cards... total=${state.rankItems.size}`);

      const before = location.href;
      dispatchRealClick(element);
      const detail = await waitForUrlVideoId(before, 3500);
      if (detail?.videoId) {
        const row = findRankRow(element);
        const rowText = cleanText(row?.innerText || "");
        addedTotal += addItems([{
          videoId: detail.videoId,
          detailUrl: detail.url,
          shopId: detail.shopId || "0",
          title: extractTitle(rowText),
          author: extractAuthor(rowText),
          rank: extractRank(rowText, ""),
          source: "click-probe"
        }], "click-probe");

        if (location.href !== originalUrl) {
          history.back();
          await waitForUrl(originalUrl, 3500);
        }
      } else if (location.href !== before) {
        history.back();
        await waitForUrl(before, 3500);
      }
      await delay(700);
    }

    return addedTotal;
  }

  function collectClickableVideoCandidates() {
    const selectors = [
      ".playIcon-TsPgjF",
      ".playIcon-OiVpe7",
      ".playIcon-ZZZzsj",
      ".videoPlayStatus-cY4_k9",
      "[class*='playIcon']",
      "[class*='videoPlay']",
      "[class*='play']",
      "[class*='Play']",
      "[class*='Video']",
      "[class*='video']",
      "video",
      "img",
      "button",
      "[role='button']",
      "a"
    ];
    const out = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const element = node.closest("button,a,[role='button']") || node;
        if (seen.has(element) || !isVisible(element) || isInsideDownloader(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) continue;
        const text = cleanText(element.innerText || element.alt || "");
        const className = String(element.className || "");
        const score = scoreClickableCandidate(element, text, className);
        if (score <= 0) continue;
        seen.add(element);
        out.push({ element, score });
      }
    }
    return out.sort((a, b) => b.score - a.score).map((item) => item.element);
  }

  function scoreClickableCandidate(element, text, className) {
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (/play|video|播放|视频/i.test(`${text} ${className}`)) score += 10;
    if (/查看详情|详情/i.test(text)) score += 8;
    if (rect.width >= 60 && rect.height >= 60) score += 4;
    if (rect.top > 0 && rect.bottom < window.innerHeight) score += 2;
    if (/下载|开始|扫描|停止|重置|探测|Start|Scan|Stop|Luopan/i.test(text)) score -= 100;
    return score;
  }

  async function waitForUrlVideoId(previousUrl, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const url = location.href;
      const parsed = new URL(url);
      const videoId = parsed.searchParams.get("video_id") || "";
      if (url !== previousUrl && /^\d{8,}$/.test(videoId)) {
        return {
          videoId,
          shopId: parsed.searchParams.get("video_shop_id") || "0",
          url
        };
      }
      await delay(150);
    }
    return null;
  }

  async function waitForUrl(expectedUrl, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (location.href === expectedUrl) return true;
      await delay(150);
    }
    return false;
  }

  function installInteractiveCapture() {
    const capture = (event) => {
      const target = event.target?.closest?.("[class*='play'],[class*='Play'],[class*='video'],[class*='Video'],video,img,button,[role='button'],a,div,span");
      if (!target) return;
      captureNodeAndAncestors(target, event.type);
    };
    document.addEventListener("mouseover", capture, { passive: true, capture: true });
    document.addEventListener("click", capture, { passive: true, capture: true });
    document.addEventListener("pointerdown", capture, { passive: true, capture: true });
  }

  function captureNodeAndAncestors(element, source) {
    const items = [];
    let node = element;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const found = extractVideoIdFromReactFiber(node);
      if (!found?.videoId) continue;
      const row = findRankRow(node);
      const rowText = cleanText(row?.innerText || node.closest("tr")?.innerText || "");
      items.push({
        videoId: found.videoId,
        shopId: found.shopId || "",
        title: found.title || extractTitle(rowText),
        author: found.author || extractAuthor(rowText),
        rank: extractRank(rowText, ""),
        source: `interactive-${source}`
      });
    }
    addItems(items, `interactive-${source}`);
  }

  function scanPageForVideoIds(showStatus) {
    const items = [];
    for (const node of collectScanNodes()) {
      const found = extractVideoIdFromReactFiber(node);
      if (!found?.videoId) continue;
      const row = findRankRow(node);
      const rowText = cleanText(row?.innerText || node.closest("tr")?.innerText || "");
      items.push({
        videoId: found.videoId,
        shopId: found.shopId || "",
        title: found.title || extractTitle(rowText),
        author: found.author || extractAuthor(rowText),
        rank: extractRank(rowText, ""),
        source: "react-fiber"
      });
    }
    const added = addItems(items, "react-scan");
    if (showStatus) {
      const visibleVideos = collectVisiblePageVideos();
      setStatus(`扫描完成：新增ID=${added}，累计ID=${state.rankItems.size}，媒体=${state.mediaItems.size}，可见视频源=${visibleVideos.length}。`);
    }
    return added;
  }

  function probeCurrentPage() {
    const visibleVideos = collectVisiblePageVideos();
    const domVideoCount = document.querySelectorAll("video").length;
    const sourceCount = document.querySelectorAll("source").length;
    const iframeCount = document.querySelectorAll("iframe").length;
    const detailLinkCount = document.querySelectorAll("a[href*='video_id'],a[href*='rank-video']").length;
    const clickableCount = collectClickableVideoCandidates().length;
    const reactAdded = scanPageForVideoIds(false);
    const currentVideoId = new URL(location.href).searchParams.get("video_id") || "";

    setStatus([
      `探测：URL视频ID=${currentVideoId || "无"}`,
      `DOM视频=${domVideoCount}，source=${sourceCount}，iframe=${iframeCount}`,
      `可见视频源=${visibleVideos.length}，已捕获媒体=${state.mediaItems.size}`,
      `详情链接=${detailLinkCount}，可点击入口=${clickableCount}`,
      `React新增ID=${reactAdded}，累计ID=${state.rankItems.size}`
    ].join(" | "));
  }

  function addMediaItems(items, source) {
    let added = 0;
    for (const raw of items) {
      const urls = [raw.url, raw.downloadUrl, raw.playUrl, raw.videoUrl, ...(Array.isArray(raw.urls) ? raw.urls : [])].filter(Boolean);
      for (const url of urls) {
        if (!isLikelyVideoUrl(url) || state.mediaItems.has(url)) continue;
        state.mediaItems.set(url, {
          rank: state.mediaItems.size + 1,
          title: raw.title || document.title || `media_${state.mediaItems.size + 1}`,
          author: raw.author || "",
          videoId: raw.videoId || raw.id || "",
          url,
          sourceUrl: url,
          detailUrl: location.href,
          source
        });
        added += 1;
      }
    }
    if (added) setStatus(`${source}: media added=${added}, total=${state.mediaItems.size}`);
    return added;
  }

  function collectCapturedMediaVideos() {
    return Array.from(state.mediaItems.values());
  }

  function collectVisiblePageVideos() {
    const videos = Array.from(document.querySelectorAll("video, source"))
      .map((element, index) => {
        const videoElement = element.tagName === "VIDEO" ? element : element.closest("video");
        const rect = (videoElement || element).getBoundingClientRect();
        const url = element.currentSrc || element.src || element.getAttribute("src") || videoElement?.currentSrc || videoElement?.src || "";
        return {
          element: videoElement || element,
          index,
          rect,
          url,
          readyState: Number((videoElement || element).readyState || 0)
        };
      })
      .filter((item) => isLikelyVideoUrl(item.url))
      .filter((item) => item.rect.width > 20 && item.rect.height > 20 && item.rect.bottom > 0 && item.rect.right > 0 && item.rect.top < window.innerHeight)
      .sort((a, b) => b.readyState - a.readyState);

    const byUrl = new Map();
    for (const item of videos) {
      if (byUrl.has(item.url)) continue;
      byUrl.set(item.url, {
        rank: byUrl.size + 1,
        title: extractTitleFromPageForVisibleVideo(item.element) || document.title || `visible_video_${item.index + 1}`,
        author: "",
        url: item.url,
        sourceUrl: item.url,
        detailUrl: location.href,
        source: "visible-video-src"
      });
    }
    return Array.from(byUrl.values());
  }

  function extractTitleFromPageForVisibleVideo(element) {
    const row = findRankRow(element);
    const rowText = cleanText(row?.innerText || "");
    const title = extractTitle(rowText);
    return title && title.length >= 2 ? title : "";
  }

  function collectScanNodes() {
    const selectors = [
      ".playIcon-TsPgjF",
      ".playIcon-OiVpe7",
      ".playIcon-ZZZzsj",
      ".videoPlayStatus-cY4_k9",
      "[class*='playIcon']",
      "[class*='videoPlay']",
      "[class*='play']",
      "[class*='Play']",
      "[class*='Video']",
      "[class*='video']",
      "[data-row-key]",
      "[data-index]",
      "[data-id]",
      "video",
      "img",
      "button",
      "[role='button']",
      "a"
    ];
    const nodes = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        nodes.add(node);
        let parent = node.parentElement;
        for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) nodes.add(parent);
      }
    }
    return Array.from(nodes);
  }

  function extractVideoIdFromReactFiber(element) {
    let node = element;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const reactKeys = Object.getOwnPropertyNames(node).filter((key) => key.startsWith("__react"));
      for (const reactKey of reactKeys) {
        const fiber = node[reactKey];
        const direct = normalizeVideoMeta({
          videoId: fiber?.key || fiber?.return?.key || fiber?.pendingProps?.video_id || fiber?.memoizedProps?.video_id,
          shopId: fiber?.pendingProps?.shop_id || fiber?.memoizedProps?.shop_id,
          title: fiber?.pendingProps?.title || fiber?.memoizedProps?.title || fiber?.pendingProps?.desc || fiber?.memoizedProps?.desc,
          author: fiber?.pendingProps?.author || fiber?.memoizedProps?.author
        });
        if (direct?.videoId) return direct;

        const found = findVideoMetaInObject(fiber);
        if (found?.videoId) return found;
      }
    }
    return null;
  }

  function findVideoMetaInObject(root) {
    const seen = new WeakSet();
    const stack = [{ value: root, depth: 0 }];
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== "object" || depth > 12) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      const direct = normalizeVideoMeta({
        videoId: value.key || firstValueByPattern(value, /^(video_id|videoId|item_id|itemId|aweme_id|awemeId|id)$/i),
        shopId: firstValueByPattern(value, /shop_id|shopId|video_shop_id|videoShopId/i),
        title: firstValueByPattern(value, /title|name|desc|text|video_name|item_title/i),
        author: firstValueByPattern(value, /author|nickname|account|shop_name|room_name|creator/i)
      });
      if (direct?.videoId) return direct;

      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      }
    }
    return null;
  }

  function firstValueByPattern(object, pattern) {
    for (const [key, value] of Object.entries(object || {})) {
      if (pattern.test(key) && (typeof value === "string" || typeof value === "number")) return value;
    }
    return "";
  }

  function normalizeVideoMeta(meta) {
    const videoId = String(meta.videoId || "").trim();
    if (!/^\d{8,}$/.test(videoId)) return null;
    return {
      videoId,
      shopId: String(meta.shopId || ""),
      title: String(meta.title || ""),
      author: String(meta.author || "")
    };
  }

  function collectVisibleDetailLinks() {
    const links = Array.from(document.querySelectorAll("a[href*='rank-video/detail'], a[href*='rank-video?video_id'], a[href*='video_id']"));
    const items = links.map((link) => {
      const href = link.href || "";
      const videoId = new URL(href, location.href).searchParams.get("video_id") || "";
      if (!videoId) return null;
      const row = findRankRow(link);
      const rowText = cleanText(row?.innerText || "");
      return {
        videoId,
        detailUrl: href,
        title: extractTitle(rowText),
        author: extractAuthor(rowText),
        rank: extractRank(rowText, ""),
        source: "detail-link"
      };
    }).filter(Boolean);
    return addItems(items, "detail-link");
  }

  function addItems(items, source) {
    let added = 0;
    for (const raw of items) {
      const videoId = String(raw.videoId || raw.itemId || raw.awemeId || "").trim();
      if (!/^\d{8,}$/.test(videoId)) continue;
      if (state.rankItems.has(videoId)) {
        const current = state.rankItems.get(videoId);
        state.rankItems.set(videoId, { ...current, ...raw, videoId });
        continue;
      }
      state.rankItems.set(videoId, { ...raw, videoId, source: raw.source || source });
      added += 1;
    }
    if (added) setStatus(`${source}: added=${added}, total=${state.rankItems.size}`);
    return added;
  }

  async function waitForOneDetailResult(before, timeoutMs, token, runId = state.runId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const current = await getJobStatus();
      if ((current.completed || 0) > (before.completed || 0) || (current.failed || 0) > (before.failed || 0)) return current;
      if (state.stop || runId !== state.runId) return current;
      await delay(1200);
    }
    await sendMessage({ type: "SLOW_JOB_DETAIL_TIMEOUT", payload: { token, reason: "detail timeout: no video.src" } });
    return getJobStatus();
  }

  async function getJobStatus() {
    const response = await sendMessage({ type: "SLOW_JOB_STATUS" });
    return response?.result || {};
  }

  async function runDetailCollector() {
    await waitForDocumentReady();
    const init = await sendMessage({ type: "SLOW_DETAIL_READY", payload: { url: location.href, title: document.title } });
    const videoId = new URL(location.href).searchParams.get("video_id") || "";
    const meta = { ...(init?.result?.meta || {}), videoId, detailUrl: location.href, detailTitle: document.title };

    if (!init?.ok || !init?.result?.active) {
      createDirectDetailUi(meta);
      return;
    }

    await collectAndSendCurrentDetailVideo(meta);
  }

  function createDirectDetailUi(meta) {
    createUi();
    setStatus(`检测到详情页。视频ID=${meta.videoId || "无"}。点击“下载当前”即可下载当前视频。`);
    const downloadButton = document.querySelector('[data-action="one-click"]');
    if (downloadButton) {
      const directButton = downloadButton.cloneNode(true);
      directButton.textContent = "下载当前视频";
      directButton.onclick = () => startCurrentDetailDownload(meta);
      downloadButton.replaceWith(directButton);
    }
  }

  async function startCurrentDetailDownload(meta) {
    if (state.busy) return;
    if (!meta.videoId) {
      setStatus("当前 URL 没有 video_id。");
      return;
    }
    state.busy = true;
    state.started = 1;
    state.completed = 0;
    state.failed = 0;
    updateUi();

    const token = `${Date.now()}-direct-${Math.random().toString(36).slice(2)}`;
    const directMeta = {
      ...meta,
      __token: token,
      rank: 1,
      title: document.title || meta.videoId,
      source: "direct-detail"
    };

    await sendMessage({
      type: "SLOW_JOB_START",
      payload: { folder: makeFolderName(), settings: readSettings(), sourceUrl: location.href, pageTitle: document.title }
    });
    await sendMessage({ type: "SLOW_JOB_EXPECT_DETAIL", payload: { meta: directMeta } });

    try {
      await collectAndSendCurrentDetailVideo(directMeta);
      const after = await getJobStatus();
      state.completed = after.completed || 0;
      state.failed = after.failed || 0;
      setStatus(`当前详情页处理完成。成功=${state.completed}，跳过=${state.failed}`);
    } finally {
      await sendMessage({ type: "SLOW_JOB_STOP" });
      state.busy = false;
      updateUi();
    }
  }

  async function collectAndSendCurrentDetailVideo(meta) {
    try {
      const video = await findVideoSourceWithPlayback();
      if (!video?.url) throw new Error("detail page did not expose video.src");
      await sendMessage({
        type: "SLOW_DETAIL_VIDEO_FOUND",
        payload: {
          token: meta.__token,
          video: {
            ...meta,
            title: meta.title || extractTitle(document.body.innerText || "") || document.title,
            author: meta.author || extractAuthor(document.body.innerText || ""),
            url: video.url,
            sourceUrl: video.url
          }
        }
      });
    } catch (error) {
      await sendMessage({
        type: "SLOW_DETAIL_FAILED",
        payload: { token: meta.__token, meta, reason: String(error?.message || error) }
      });
    }
  }

  async function findVideoSourceWithPlayback() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 22000) {
      clickLikelyPlayer();
      const video = getBestVideoSource();
      if (video) return video;
      const captured = collectCapturedMediaVideos().find((item) => isLikelyVideoUrl(item.url));
      if (captured) return { url: captured.url, source: captured.source };
      await delay(1500);
    }
    return null;
  }

  function getBestVideoSource() {
    const videos = Array.from(document.querySelectorAll("video, source"))
      .map((element) => ({
        element,
        url: element.currentSrc || element.src || element.getAttribute("src") || "",
        readyState: Number(element.readyState || 0)
      }))
      .filter((item) => isLikelyVideoUrl(item.url))
      .sort((a, b) => b.readyState - a.readyState);
    if (!videos.length) return null;
    const video = videos[0];
    try {
      if (video.element.tagName === "VIDEO" && video.element.paused) video.element.play().catch(() => {});
    } catch {
      // Autoplay restrictions are fine.
    }
    return video;
  }

  function clickLikelyPlayer() {
    const video = document.querySelector("video");
    if (video) {
      dispatchRealClick(video);
      try { video.play().catch(() => {}); } catch {}
      return;
    }

    const candidates = Array.from(document.querySelectorAll("button, [role='button'], img, div, section"))
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element.innerText || element.alt || "") }))
      .filter(({ rect }) => rect.width >= 80 && rect.height >= 80 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight)
      .sort((a, b) => scorePlayerCandidate(b) - scorePlayerCandidate(a));
    if (candidates[0]) dispatchRealClick(candidates[0].element);
  }

  function scorePlayerCandidate(candidate) {
    const { rect, text } = candidate;
    let score = rect.width * rect.height;
    if (rect.left > window.innerWidth * 0.55) score += 200000;
    if (/play|replay|00:|video|播放|重播|视频/i.test(text)) score += 100000;
    return score;
  }

  function dispatchRealClick(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    }
  }

  function findRankRow(element) {
    let node = element;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const text = cleanText(node.innerText || "");
      if (text.length > 30 && /TOP\s*\d+|ID\s*[A-Z0-9_]+|video|rank|观看|引流|详情/i.test(text)) return node;
    }
    return element.closest("tr") || element.parentElement;
  }

  async function advanceRankList(runId = state.runId) {
    const before = getRankViewportSignature();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (state.stop || runId !== state.runId) return false;
      scrollRankList(attempt);
      await delay(1000 + attempt * 300);
      scanPageForVideoIds(false);
      collectVisibleDetailLinks();
      const after = getRankViewportSignature();
      if (after.key && after.key !== before.key) {
        return true;
      }
    }
    return false;
  }

  function scrollRankList(attempt = 0) {
    const scroller = findBestScroller();
    const candidates = collectClickableVideoCandidates()
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const lastRow = candidates.length ? findRankRow(candidates[candidates.length - 1]) : null;
    const stepRatio = attempt >= 2 ? 1.35 : 0.9;
    if (!scroller) {
      window.scrollBy({ top: Math.max(600, window.innerHeight * stepRatio), behavior: "smooth" });
      dispatchPageAdvanceKeys();
      return;
    }
    if (lastRow && attempt === 0) {
      lastRow.scrollIntoView({ block: "start", behavior: "instant" });
    }
    const before = scroller.scrollTop;
    const step = Math.max(600, scroller.clientHeight * stepRatio);
    scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + step);
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    dispatchWheel(scroller, step);
    if (scroller.scrollTop === before && scroller !== document.scrollingElement) {
      window.scrollBy({ top: step, behavior: "smooth" });
    }
    if (scroller.scrollTop === before || attempt >= 2) dispatchPageAdvanceKeys();
  }

  function findBestScroller() {
    const candidateScroller = findScrollerFromVideoCards();
    if (candidateScroller) return candidateScroller;

    const nodes = [document.scrollingElement, ...document.querySelectorAll("*")].filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const node of nodes) {
      const style = node === document.scrollingElement ? null : getComputedStyle(node);
      const canScroll = node.scrollHeight > node.clientHeight + 120;
      const overflowAllowsScroll = !style || /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
      if (!canScroll || !overflowAllowsScroll) continue;
      if (node.closest?.("#luopan-video-downloader-root")) continue;
      const rect = node === document.scrollingElement ? { width: window.innerWidth, height: window.innerHeight, top: 0, bottom: window.innerHeight } : node.getBoundingClientRect();
      if (rect.width < 320 || rect.height < 160 || rect.bottom < 80 || rect.top > window.innerHeight - 80) continue;
      const text = cleanText(node.innerText || "");
      const className = String(node.className || "");
      const id = String(node.id || "");
      let score = node.clientHeight + Math.min(1200, node.scrollHeight - node.clientHeight);
      if (/TOP\s*\d+|video|rank|观看|引流|详情|榜单|短视频/i.test(text)) score += 2500;
      if (/table|list|rank|scroll|body|content|virtual|virtuoso/i.test(`${className} ${id}`)) score += 1200;
      if (rect.top >= 0 && rect.top < window.innerHeight * 0.45) score += 400;
      if (style?.position === "fixed" && !/table|list|rank|scroll|drawer|modal/i.test(`${className} ${id}`)) score -= 1000;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best || document.scrollingElement;
  }

  function findScrollerFromVideoCards() {
    const candidates = collectClickableVideoCandidates().slice(0, 12);
    const scores = new Map();
    for (const candidate of candidates) {
      let node = candidate.parentElement;
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
        if (node.closest?.("#luopan-video-downloader-root")) continue;
        const style = getComputedStyle(node);
        const canScroll = node.scrollHeight > node.clientHeight + 80;
        const allowsScroll = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
        if (!canScroll || !allowsScroll) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 320 || rect.height < 160) continue;
        scores.set(node, (scores.get(node) || 0) + 1);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].clientHeight - b[0].clientHeight)[0]?.[0] || null;
  }

  function getRankViewportSignature() {
    const scroller = findBestScroller();
    const scrollTop = Math.round(scroller?.scrollTop || window.scrollY || document.documentElement.scrollTop || 0);
    const nodes = collectClickableVideoCandidates().slice(0, 8);
    const key = nodes.map((element) => {
      const row = findRankRow(element);
      const rect = element.getBoundingClientRect();
      return cleanText(row?.innerText || element.innerText || element.alt || "")
        .slice(0, 80) + `@${Math.round(rect.top)}`;
    }).join("|");
    return {
      key,
      scrollTop,
      mediaCount: collectVisiblePageVideos().length + collectCapturedMediaVideos().length
    };
  }

  function clearVisibleProbeMarks() {
    for (const element of document.querySelectorAll("[data-luopan-oneclick-probed], [data-luopan-dl-probed]")) {
      if (isVisible(element)) {
        element.removeAttribute("data-luopan-oneclick-probed");
        element.removeAttribute("data-luopan-dl-probed");
      }
    }
  }

  function dispatchWheel(target, deltaY) {
    const rect = target === document.scrollingElement
      ? { left: window.innerWidth / 2, top: window.innerHeight / 2 }
      : target.getBoundingClientRect();
    const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + Math.min(40, Math.max(1, (rect.width || 80) / 2))));
    const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + Math.min(40, Math.max(1, (rect.height || 80) / 2))));
    target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode: 0,
      clientX: x,
      clientY: y,
      view: window
    }));
  }

  function dispatchPageAdvanceKeys() {
    const eventInit = { key: "PageDown", code: "PageDown", keyCode: 34, which: 34, bubbles: true, cancelable: true };
    for (const target of [document.activeElement, document.body, document, window].filter(Boolean)) {
      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    }
  }

  function makeFolderName() {
    const date = new Date().toISOString().slice(0, 10);
    const pageTitle = sanitizePathSegment(cleanText(document.title || "luopan-rank"));
    return `douyin-luopan-rank-videos/${date}/${pageTitle}`;
  }

  function extractRank(text, fallback) {
    const match = cleanText(text).match(/TOP\s*(\d+)|^(\d{1,3})\b|排名\s*(\d+)/i);
    return Number(match?.[1] || match?.[2] || match?.[3] || fallback || 0) || "";
  }

  function extractTitle(text) {
    const cleaned = cleanText(text);
    const lines = cleaned.split(/\s{2,}|\n/).map(cleanText).filter(Boolean);
    return lines.find((line) => !/TOP|ID\s*[:：]?|万元|次|排名|自营|合作|查看详情|视频观看|引流直播/i.test(line)) || cleaned.slice(0, 60);
  }

  function extractAuthor(text) {
    const cleaned = cleanText(text);
    const idMatch = cleaned.match(/\bID\s*[:：]?\s*([A-Z0-9_]+)/i);
    if (idMatch) return `ID ${idMatch[1]}`;
    const douyinMatch = cleaned.match(/抖音号\s*[:：]?\s*([A-Z0-9_]+)/i);
    if (douyinMatch) return `douyin ${douyinMatch[1]}`;
    return "";
  }

  function isDetailPage() {
    return /\/shop\/chance\/rank-video/.test(location.pathname) && new URL(location.href).searchParams.has("video_id");
  }

  function isLikelyVideoUrl(value) {
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
    if (/mime_type=video|video_mp4|aweme\/v1\/play|playwm|play_addr|download_addr/.test(url)) return true;
    return /(douyinvod|douyinvideo|bytevcloud|ixigua|amemv)/.test(host) && /(video|play|vid=|mime_type=video|tos-)/.test(url);
  }

  function isBadAssetUrl(value) {
    return /\.(png|jpe?g|webp|gif|svg|ico|css|js|html?|woff2?|ttf)(\?|#|$)|tplv-[^/]+-image|avatar|cover|poster|image\.image/i.test(value);
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || 1) > 0;
  }

  function isInsideDownloader(element) {
    return Boolean(element.closest("#luopan-video-downloader-root"));
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "no response" });
      });
    });
  }

  function waitForDocumentReady() {
    if (document.readyState === "complete" || document.readyState === "interactive") return Promise.resolve();
    return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function sanitizePathSegment(value) {
    return cleanText(value).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "untitled";
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
