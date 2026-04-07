// TikTok Comment Analyzer - Popup Logic

(function () {
  "use strict";

  // --- DOM Elements ---
  const apiKeyInput = document.getElementById("apiKeyInput");
  const toggleKeyBtn = document.getElementById("toggleKeyBtn");
  const saveKeyBtn = document.getElementById("saveKeyBtn");
  const apiKeyStatus = document.getElementById("apiKeyStatus");
  const commentLimit = document.getElementById("commentLimit");
  const scrapeBtn = document.getElementById("scrapeBtn");
  const stopBtn = document.getElementById("stopBtn");
  const progressSection = document.getElementById("progressSection");
  const progressText = document.getElementById("progressText");
  const commentCount = document.getElementById("commentCount");
  const statusMessage = document.getElementById("statusMessage");
  const resultsSection = document.getElementById("resultsSection");
  const summaryText = document.getElementById("summaryText");
  const barPositive = document.getElementById("barPositive");
  const barNeutral = document.getElementById("barNeutral");
  const barNegative = document.getElementById("barNegative");
  const pctPositive = document.getElementById("pctPositive");
  const pctNeutral = document.getElementById("pctNeutral");
  const pctNegative = document.getElementById("pctNegative");
  const topicTags = document.getElementById("topicTags");
  const highlights = document.getElementById("highlights");
  const commentList = document.getElementById("commentList");
  const reportBtn = document.getElementById("reportBtn");
  const tabs = document.querySelectorAll(".tab");

  let port = null;
  let scrapedComments = [];
  let analysisResult = null;
  let currentFilter = "all";

  // --- Init ---
  init();

  async function init() {
    // Load saved API key
    const stored = await chrome.storage.local.get(["geminiApiKey"]);
    if (stored.geminiApiKey) {
      apiKeyInput.value = stored.geminiApiKey;
      apiKeyStatus.textContent = "API key tersimpan";
      apiKeyStatus.className = "hint success";
    }

    // Event listeners
    saveKeyBtn.addEventListener("click", saveApiKey);
    toggleKeyBtn.addEventListener("click", toggleKeyVisibility);
    scrapeBtn.addEventListener("click", startScraping);
    stopBtn.addEventListener("click", stopScraping);
    reportBtn.addEventListener("click", openReport);

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        currentFilter = tab.dataset.tab;
        renderCommentList();
      });
    });
  }

  // --- API Key ---
  async function saveApiKey() {
    const key = apiKeyInput.value.trim();
    if (!key) {
      apiKeyStatus.textContent = "Masukkan API key terlebih dahulu";
      apiKeyStatus.className = "hint error";
      return;
    }
    await chrome.storage.local.set({ geminiApiKey: key });
    apiKeyStatus.textContent = "API key berhasil disimpan!";
    apiKeyStatus.className = "hint success";
  }

  function toggleKeyVisibility() {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  }

  // --- Status ---
  function showStatus(msg, type) {
    statusMessage.textContent = msg;
    statusMessage.className = `status ${type}`;
    statusMessage.classList.remove("hidden");
  }

  function hideStatus() {
    statusMessage.classList.add("hidden");
  }

  // --- Scraping ---
  async function startScraping() {
    hideStatus();
    resultsSection.classList.add("hidden");

    // Validate TikTok page
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.url || !tab.url.includes("tiktok.com")) {
      showStatus(
        "Buka halaman video TikTok terlebih dahulu.",
        "error"
      );
      return;
    }

    // Ensure content script is injected
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/content.js"],
      });
    } catch (e) {
      // Script might already be injected, that's fine
    }

    // Small delay to let the script initialize
    await new Promise((r) => setTimeout(r, 300));

    // Connect via port
    try {
      port = chrome.tabs.connect(tab.id, { name: "tiktok-scraper" });
    } catch (e) {
      showStatus(
        "Gagal terhubung ke halaman. Coba muat ulang halaman TikTok.",
        "error"
      );
      return;
    }

    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
    });

    // Start scraping
    const limit = parseInt(commentLimit.value, 10);
    port.postMessage({ type: "START_SCRAPE", limit: limit });

    // Update UI
    scrapeBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    progressSection.classList.remove("hidden");
    commentCount.textContent = "0";
    scrapedComments = [];
  }

  function handlePortMessage(msg) {
    if (msg.type === "SCRAPE_UPDATE") {
      commentCount.textContent = msg.total;
    } else if (msg.type === "SCRAPE_COMPLETE") {
      scrapedComments = msg.comments;
      commentCount.textContent = msg.total;
      onScrapingComplete();
    }
  }

  async function stopScraping() {
    if (port) {
      port.postMessage({ type: "STOP_SCRAPE" });
    }
  }

  async function onScrapingComplete() {
    stopBtn.classList.add("hidden");
    // Hide scrape button during analysis
    scrapeBtn.classList.add("hidden");

    if (scrapedComments.length === 0) {
      progressSection.classList.add("hidden");
      scrapeBtn.classList.remove("hidden");
      showStatus(
        "Tidak ditemukan komentar. Pastikan halaman video TikTok sudah terbuka dan komentar terlihat.",
        "error"
      );
      return;
    }

    // Switch to analysis progress UI
    const progressFill = document.getElementById("progressFill");
    progressFill.classList.remove("pulsing");
    progressFill.style.width = "10%";
    progressText.innerHTML = `Menganalisis <span>${scrapedComments.length}</span> komentar dengan AI...`;

    // Get API key
    const stored = await chrome.storage.local.get(["geminiApiKey"]);
    if (!stored.geminiApiKey) {
      progressSection.classList.add("hidden");
      scrapeBtn.classList.remove("hidden");
      showStatus("Masukkan API key Gemini terlebih dahulu.", "error");
      return;
    }

    // Listen for progress updates from background
    const progressListener = (msg) => {
      if (msg.type === "ANALYSIS_PROGRESS") {
        const pct = Math.round(msg.progress * 100);
        progressFill.style.width = `${Math.max(10, pct)}%`;
        progressText.innerHTML = `Menganalisis batch <span>${msg.current}</span> dari <span>${msg.total}</span>...`;
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    // Send to background for analysis
    try {
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_COMMENTS",
        comments: scrapedComments,
        apiKey: stored.geminiApiKey,
      });

      chrome.runtime.onMessage.removeListener(progressListener);
      progressSection.classList.add("hidden");

      if (response.success) {
        analysisResult = response.data;
        renderResults();
      } else {
        scrapeBtn.classList.remove("hidden");
        showStatus(`Error: ${response.error}`, "error");
      }
    } catch (e) {
      chrome.runtime.onMessage.removeListener(progressListener);
      progressSection.classList.add("hidden");
      scrapeBtn.classList.remove("hidden");
      showStatus(`Error: ${e.message}`, "error");
    }
  }

  // --- Render Results ---
  function renderResults() {
    if (!analysisResult) return;

    resultsSection.classList.remove("hidden");

    // Summary
    summaryText.textContent = analysisResult.summary || "Tidak ada ringkasan.";

    // Sentiment bars
    const sentiment = analysisResult.sentiment || {};
    const pos = sentiment.positive || 0;
    const neu = sentiment.neutral || 0;
    const neg = sentiment.negative || 0;

    barPositive.style.width = `${pos}%`;
    barNeutral.style.width = `${neu}%`;
    barNegative.style.width = `${neg}%`;
    pctPositive.textContent = `${pos}%`;
    pctNeutral.textContent = `${neu}%`;
    pctNegative.textContent = `${neg}%`;

    // Topics
    topicTags.innerHTML = "";
    (analysisResult.topics || []).forEach((topic) => {
      const tag = document.createElement("span");
      tag.className = "topic-tag";
      tag.textContent = topic;
      topicTags.appendChild(tag);
    });

    // Highlights
    highlights.innerHTML = "";
    (analysisResult.highlights || []).forEach((h) => {
      const item = document.createElement("div");
      item.className = "highlight-item";
      item.innerHTML = `
        <div class="highlight-user">@${escapeHtml(h.username)}</div>
        <div class="highlight-text">${escapeHtml(h.text)}</div>
        <div class="highlight-reason">${escapeHtml(h.reason)}</div>
      `;
      highlights.appendChild(item);
    });

    // Comment list
    renderCommentList();
  }

  function renderCommentList() {
    commentList.innerHTML = "";
    const comments = analysisResult?.comments || [];

    const filtered =
      currentFilter === "all"
        ? comments
        : comments.filter((c) => c.sentiment === currentFilter);

    if (filtered.length === 0) {
      commentList.innerHTML =
        '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px;">Tidak ada komentar dalam kategori ini</div>';
      return;
    }

    filtered.forEach((c) => {
      const item = document.createElement("div");
      item.className = "comment-item";
      item.innerHTML = `
        <div class="comment-badge ${c.sentiment}"></div>
        <div class="comment-content">
          <div class="comment-user">@${escapeHtml(c.username)}</div>
          <div class="comment-text">${escapeHtml(c.text)}</div>
        </div>
        <span class="comment-sentiment-tag ${c.sentiment}">${c.sentiment}</span>
      `;
      commentList.appendChild(item);
    });
  }

  // --- Report ---
  async function openReport() {
    if (!analysisResult) return;

    const reportData = {
      analysis: analysisResult,
      comments: scrapedComments,
      timestamp: new Date().toISOString(),
      totalComments: scrapedComments.length,
    };

    // Save report data to chrome.storage.local (persists across service worker restarts)
    await chrome.storage.local.set({ reportData: reportData });

    // Also save to background (legacy)
    chrome.runtime.sendMessage({
      type: "SAVE_REPORT",
      data: reportData,
    });

    // Open report page
    chrome.tabs.create({
      url: chrome.runtime.getURL("report/report.html"),
    });
  }

  // --- Utilities ---
  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
