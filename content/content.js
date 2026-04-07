// TikTok Comment Scraper - Content Script
// Injected into tiktok.com pages to extract comments from the DOM

(function () {
  "use strict";

  let port = null;
  let scrapeInterval = null;
  let scrapeInProgress = false;
  let collectedComments = [];
  let commentLimit = Infinity;
  let seenTexts = new Set();

  // --- Selectors ---
  const SELECTORS = {
    commentContainer:
      '[class*="DivCommentListContainer"], [class*="comment-list"], [data-e2e="comment-list"]',
    commentItem:
      '[class*="DivCommentItemContainer"], [class*="DivCommentContentContainer"], [data-e2e="comment-item"]',
    commentText:
      '[class*="SpanCommentText"], [data-e2e="comment-text"], [class*="comment-text"]',
    username:
      '[data-e2e="comment-username-1"], [class*="SpanUserNameText"], a[class*="StyledLink"][href*="/@"]',
    replyExpander:
      '[class*="ReplyActionText"], [data-e2e="view-more-replies"], [class*="view-more"]',
    likesCount:
      '[class*="SpanCount"], [data-e2e="comment-like-count"]',
  };

  // --- Noise patterns to filter out ---
  const NOISE_PATTERNS = [
    /^\d+(\.\d+)?[KkMm]?$/, // likes count like "1.2K"
    /^Reply$/i,
    /^Balas$/i,
    /^See translation$/i,
    /^Lihat terjemahan$/i,
    /^\d+\s*(replies|balasan)/i,
    /^View\s+\d+\s+replies?/i,
    /^Lihat\s+\d+\s+balasan/i,
    /^\d+[smhd] ago$/i, // timestamps
    /^\d+\s*(detik|menit|jam|hari|minggu|bulan|tahun)/i,
    /^(like|suka|share|bagikan|copy link|salin tautan|report|laporkan)$/i,
    /^\d+$/,
  ];

  // --- Bigram Dice Coefficient for fuzzy dedup ---
  function getBigrams(str) {
    const s = str.toLowerCase().trim();
    const bigrams = new Set();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.substring(i, i + 2));
    }
    return bigrams;
  }

  function diceCoefficient(a, b) {
    const bigramsA = getBigrams(a);
    const bigramsB = getBigrams(b);
    if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
    if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
    let intersection = 0;
    for (const bigram of bigramsA) {
      if (bigramsB.has(bigram)) intersection++;
    }
    return (2 * intersection) / (bigramsA.size + bigramsB.size);
  }

  function isDuplicate(text) {
    const normalized = text.toLowerCase().trim();
    // Exact match
    if (seenTexts.has(normalized)) return true;
    // Fuzzy match
    for (const seen of seenTexts) {
      if (diceCoefficient(normalized, seen) > 0.85) return true;
    }
    seenTexts.add(normalized);
    return false;
  }

  // --- Filter noise ---
  function isNoise(text) {
    const trimmed = text.trim();
    if (trimmed.length < 2) return true;
    for (const pattern of NOISE_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
    return false;
  }

  // --- Try to expand reply threads ---
  function expandReplies() {
    const expanders = document.querySelectorAll(SELECTORS.replyExpander);
    expanders.forEach((el) => {
      if (
        el.offsetParent !== null &&
        !el.dataset.tcsExpanded
      ) {
        el.dataset.tcsExpanded = "1";
        el.click();
      }
    });
  }

  // --- Extract username from a comment item ---
  function extractUsername(commentEl) {
    const userEl = commentEl.querySelector(SELECTORS.username);
    if (userEl) {
      // Try href first for cleaner username
      const href = userEl.getAttribute("href");
      if (href && href.startsWith("/@")) {
        return href.substring(2);
      }
      return userEl.textContent.trim().replace(/^@/, "");
    }
    return "unknown";
  }

  // --- Extract comments from DOM ---
  function scrapeComments() {
    const items = document.querySelectorAll(SELECTORS.commentItem);
    let newCount = 0;

    items.forEach((item) => {
      if (collectedComments.length >= commentLimit) return;

      const textEl = item.querySelector(SELECTORS.commentText);
      if (!textEl) return;

      const text = textEl.textContent.trim();
      if (!text || isNoise(text) || isDuplicate(text)) return;

      const username = extractUsername(item);

      // Extract likes count if available
      const likesEl = item.querySelector(SELECTORS.likesCount);
      const likes = likesEl ? likesEl.textContent.trim() : "0";

      collectedComments.push({
        username: username,
        text: text,
        likes: likes,
      });
      newCount++;
    });

    return newCount;
  }

  // --- Start scraping loop ---
  function startScraping(limit) {
    commentLimit = limit === 0 ? Infinity : limit;
    collectedComments = [];
    seenTexts.clear();

    // Initial scrape
    scrapeComments();
    sendUpdate();

    // Polling every 1.5 seconds
    scrapeInterval = setInterval(() => {
      if (scrapeInProgress) return;
      scrapeInProgress = true;

      try {
        expandReplies();
        const newCount = scrapeComments();

        sendUpdate();

        // Auto-stop if limit reached
        if (collectedComments.length >= commentLimit) {
          stopScraping();
          if (port) {
            port.postMessage({
              type: "SCRAPE_COMPLETE",
              comments: collectedComments,
              total: collectedComments.length,
            });
          }
        }
      } finally {
        scrapeInProgress = false;
      }
    }, 1500);
  }

  // --- Stop scraping ---
  function stopScraping() {
    if (scrapeInterval) {
      clearInterval(scrapeInterval);
      scrapeInterval = null;
    }
  }

  // --- Send update to popup ---
  function sendUpdate() {
    if (port) {
      try {
        port.postMessage({
          type: "SCRAPE_UPDATE",
          total: collectedComments.length,
          limit: commentLimit === Infinity ? 0 : commentLimit,
        });
      } catch (e) {
        // Port disconnected
        stopScraping();
      }
    }
  }

  // --- Listen for port connections from popup ---
  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== "tiktok-scraper") return;

    port = p;

    port.onMessage.addListener((msg) => {
      if (msg.type === "START_SCRAPE") {
        startScraping(msg.limit || 0);
      } else if (msg.type === "STOP_SCRAPE") {
        stopScraping();
        port.postMessage({
          type: "SCRAPE_COMPLETE",
          comments: collectedComments,
          total: collectedComments.length,
        });
      }
    });

    port.onDisconnect.addListener(() => {
      stopScraping();
      port = null;
    });
  });
})();
