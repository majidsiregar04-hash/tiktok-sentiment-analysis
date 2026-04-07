// TikTok Comment Scraper - Content Script
// Injected into tiktok.com pages to extract comments from the DOM

(function () {
  "use strict";

  const LOG_PREFIX = "[TikTok Analyzer]";

  let port = null;
  let scrapeInterval = null;
  let scrapeInProgress = false;
  let collectedComments = [];
  let commentLimit = Infinity;
  let seenTexts = new Set();

  // --- Noise patterns to filter out ---
  const NOISE_PATTERNS = [
    /^\d+(\.\d+)?[KkMm]?$/, // likes count like "1.2K"
    /^Reply$/i,
    /^Balas$/i,
    /^See translation$/i,
    /^Lihat terjemahan$/i,
    /^\d+\s*(replies|balasan)/i,
    /^View\s+\d+\s+repl(y|ies)/i,
    /^Lihat\s+\d+\s+balasan/i,
    /^\d+[smhd]\s*ago$/i,
    /^\d+\s*(detik|menit|jam|hari|minggu|bulan|tahun)\s*(lalu|yang\s*lalu)?$/i,
    /^(like|suka|share|bagikan|copy link|salin tautan|report|laporkan)$/i,
    /^\d+$/,
    /^Creator videos$/i,
    /^Comments?\s*\(\d+\)$/i,
    /^Back to top$/i,
    /^Find related content$/i,
    /^Log in to comment$/i,
    /^Add comment/i,
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
    if (seenTexts.has(normalized)) return true;
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
    const selectors = [
      '[data-e2e="view-more-replies"]',
      'p[class*="eplyAction"]',
      'span[class*="eplyAction"]',
      'div[class*="eplyAction"]',
    ];
    for (const sel of selectors) {
      const expanders = document.querySelectorAll(sel);
      expanders.forEach((el) => {
        if (el.offsetParent !== null && !el.dataset.tcsExpanded) {
          el.dataset.tcsExpanded = "1";
          try { el.click(); } catch (e) { /* ignore */ }
        }
      });
    }
  }

  // =============================================
  // MULTI-STRATEGY COMMENT EXTRACTION
  // =============================================

  function findAndExtractComments() {
    let results;

    // Strategy 1: data-e2e attributes
    results = strategyDataE2E();
    if (results.length > 0) {
      console.log(LOG_PREFIX, "Strategy 1 (data-e2e) found:", results.length, "comments");
      return results;
    }

    // Strategy 2: class pattern matching
    results = strategyClassPatterns();
    if (results.length > 0) {
      console.log(LOG_PREFIX, "Strategy 2 (class patterns) found:", results.length, "comments");
      return results;
    }

    // Strategy 3: Heuristic - walk DOM from username links
    results = strategyHeuristic();
    if (results.length > 0) {
      console.log(LOG_PREFIX, "Strategy 3 (heuristic) found:", results.length, "comments");
      return results;
    }

    console.log(LOG_PREFIX, "No comments found with any strategy");
    return [];
  }

  // --- Strategy 1: data-e2e selectors ---
  function strategyDataE2E() {
    const itemSelectors = [
      '[data-e2e="search-comment-container"]',
      '[data-e2e="comment-level-1"]',
      '[data-e2e="comment-level-2"]',
      '[data-e2e="comment-item"]',
    ];

    let items = [];
    for (const sel of itemSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        items = [...items, ...found];
      }
    }

    if (items.length === 0) return [];

    return items.map((item) => {
      const username = extractUsernameFromElement(item);
      const text = extractTextFromElement(item);
      const likes = extractLikesFromElement(item);
      return { username, text, likes };
    }).filter((c) => c.text && !isNoise(c.text));
  }

  // --- Strategy 2: class pattern matching ---
  function strategyClassPatterns() {
    const patterns = [
      '[class*="ommentItem"]',
      '[class*="omment-item"]',
      '[class*="CommentContent"]',
      '[class*="commentContent"]',
      '[class*="comment_item"]',
      '[class*="DivComment"]',
    ];

    let items = [];
    for (const sel of patterns) {
      try {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          items = [...items, ...found];
        }
      } catch (e) { /* invalid selector, skip */ }
    }

    if (items.length === 0) return [];

    // Deduplicate elements (child elements may be captured by multiple selectors)
    const uniqueItems = deduplicateElements(items);

    return uniqueItems.map((item) => {
      const username = extractUsernameFromElement(item);
      const text = extractTextFromElement(item);
      const likes = extractLikesFromElement(item);
      return { username, text, likes };
    }).filter((c) => c.text && !isNoise(c.text));
  }

  // --- Strategy 3: Heuristic - find comments via username links ---
  function strategyHeuristic() {
    // Find all profile links on the page - every comment has a /@username link
    const userLinks = document.querySelectorAll('a[href^="/@"]');
    if (userLinks.length === 0) return [];

    const comments = [];
    const processedContainers = new WeakSet();

    for (const link of userLinks) {
      const username = link.getAttribute("href").replace(/^\/@/, "");
      if (!username) continue;

      // Skip if this link is in the video creator info area or sidebar
      // Comment links are typically inside the comment panel area
      const container = findCommentContainer(link);
      if (!container || processedContainers.has(container)) continue;
      processedContainers.add(container);

      const text = extractTextFromContainer(container, link);
      if (!text || isNoise(text)) continue;

      const likes = extractLikesFromElement(container);
      comments.push({ username, text, likes });
    }

    return comments;
  }

  // --- Find the comment container element for a username link ---
  function findCommentContainer(link) {
    // Walk up the DOM tree to find a suitable comment container
    // A comment container typically contains: username, comment text, and action buttons
    let el = link.parentElement;
    for (let depth = 0; depth < 8; depth++) {
      if (!el || el === document.body) return null;

      // Check if this element looks like a comment container:
      // - Has some minimum text content
      // - Contains the username link
      // - Has siblings or children that look like comment parts
      const textContent = el.textContent || "";
      const hasEnoughContent = textContent.length > username_length(link) + 5;
      const hasReplyOrTime = /(\d+[smhd]\s*ago|Reply|Balas|\d+\s*(detik|menit|jam|hari))/i.test(textContent);

      if (hasEnoughContent && hasReplyOrTime) {
        // Make sure this isn't too large (e.g., the entire comment panel)
        const childLinks = el.querySelectorAll('a[href^="/@"]');
        if (childLinks.length <= 2) {
          return el;
        }
      }

      el = el.parentElement;
    }
    return null;
  }

  function username_length(link) {
    return (link.textContent || "").length;
  }

  // --- Extract text from a container, removing noise ---
  function extractTextFromContainer(container, usernameLink) {
    // Clone to avoid modifying the actual DOM
    const clone = container.cloneNode(true);

    // Remove elements that are definitely not comment text
    const removeSelectors = [
      'a[href^="/@"]',           // username links
      'svg',                      // icons
      'button',                   // action buttons
      'img',                      // avatars/images
      '[class*="avatar"]',
      '[class*="Avatar"]',
      '[role="button"]',
    ];

    for (const sel of removeSelectors) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }

    // Get remaining text content
    const rawText = clone.textContent || "";

    // Split into lines, filter noise
    const lines = rawText
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !isNoise(l));

    // The actual comment text is usually the longest non-noise line,
    // or the first substantial line
    if (lines.length === 0) return "";

    // Filter out timestamps and action text more aggressively
    const cleanLines = lines.filter((line) => {
      if (/^\d+[smhd]\s*ago$/i.test(line)) return false;
      if (/^\d+\s*(detik|menit|jam|hari|minggu|bulan|tahun)/i.test(line)) return false;
      if (/^(Reply|Balas)$/i.test(line)) return false;
      if (/^\d+(\.\d+)?[KkMm]?$/.test(line)) return false;
      return true;
    });

    // Return the longest clean line (most likely the comment text)
    if (cleanLines.length === 0) return "";
    return cleanLines.reduce((a, b) => (a.length >= b.length ? a : b), "");
  }

  // --- Helper: extract username from any element ---
  function extractUsernameFromElement(el) {
    // Try a[href^="/@"] inside element first
    const link = el.querySelector('a[href^="/@"]');
    if (link) {
      const href = link.getAttribute("href");
      if (href) return href.replace(/^\/@/, "");
    }

    // Try data-e2e username selectors inside element
    const userSelectors = [
      '[data-e2e="comment-username-1"]',
      '[data-e2e="comment-username"]',
      '[class*="UserName"]',
      '[class*="userName"]',
      '[class*="user-name"]',
    ];
    for (const sel of userSelectors) {
      const found = el.querySelector(sel);
      if (found) return found.textContent.trim().replace(/^@/, "");
    }

    // Walk up parent elements (up to 5 levels) to find username link
    let parent = el.parentElement;
    for (let i = 0; i < 5 && parent && parent !== document.body; i++) {
      const parentLink = parent.querySelector('a[href^="/@"]');
      if (parentLink) {
        const href = parentLink.getAttribute("href");
        if (href) return href.replace(/^\/@/, "");
      }
      for (const sel of userSelectors) {
        const found = parent.querySelector(sel);
        if (found) return found.textContent.trim().replace(/^@/, "");
      }
      parent = parent.parentElement;
    }

    // Check previous siblings
    let sibling = el.previousElementSibling;
    for (let i = 0; i < 3 && sibling; i++) {
      const sibLink = sibling.querySelector('a[href^="/@"]');
      if (sibLink) {
        const href = sibLink.getAttribute("href");
        if (href) return href.replace(/^\/@/, "");
      }
      if (sibling.matches && sibling.matches('a[href^="/@"]')) {
        const href = sibling.getAttribute("href");
        if (href) return href.replace(/^\/@/, "");
      }
      sibling = sibling.previousElementSibling;
    }

    return "unknown";
  }

  // --- Helper: extract comment text from a known comment element ---
  function extractTextFromElement(el) {
    // Try specific text selectors
    const textSelectors = [
      '[data-e2e="comment-text"]',
      '[class*="ommentText"]',
      '[class*="omment-text"]',
      'p[dir]',
      'span[dir]',
    ];

    for (const sel of textSelectors) {
      const found = el.querySelector(sel);
      if (found) {
        const text = found.textContent.trim();
        if (text && !isNoise(text)) return text;
      }
    }

    // Fallback: extract text excluding username and noise
    const link = el.querySelector('a[href^="/@"]');
    return extractTextFromContainer(el, link);
  }

  // --- Helper: extract likes count ---
  function extractLikesFromElement(el) {
    const selectors = [
      '[data-e2e="comment-like-count"]',
      '[class*="likeCount"]',
      '[class*="LikeCount"]',
      '[class*="like-count"]',
    ];
    for (const sel of selectors) {
      const found = el.querySelector(sel);
      if (found) return found.textContent.trim();
    }
    return "0";
  }

  // --- Deduplicate DOM elements (remove children if parent already captured) ---
  function deduplicateElements(elements) {
    const arr = [...elements];
    return arr.filter((el, i) => {
      for (let j = 0; j < arr.length; j++) {
        if (i !== j && arr[j].contains(el) && arr[j] !== el) {
          return false; // el is a child of another element in the list
        }
      }
      return true;
    });
  }

  // =============================================
  // SCRAPING LOGIC
  // =============================================

  function scrapeComments() {
    const found = findAndExtractComments();
    let newCount = 0;

    for (const comment of found) {
      if (collectedComments.length >= commentLimit) break;
      if (!comment.text || isDuplicate(comment.text)) continue;

      collectedComments.push(comment);
      newCount++;
    }

    return newCount;
  }

  function startScraping(limit) {
    commentLimit = limit === 0 ? Infinity : limit;
    collectedComments = [];
    seenTexts.clear();

    console.log(LOG_PREFIX, "Starting scrape, limit:", commentLimit);

    // Initial scrape
    scrapeComments();
    sendUpdate();

    // Polling every 1.5 seconds
    scrapeInterval = setInterval(() => {
      if (scrapeInProgress) return;
      scrapeInProgress = true;

      try {
        expandReplies();
        scrapeComments();
        sendUpdate();

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

  function stopScraping() {
    if (scrapeInterval) {
      clearInterval(scrapeInterval);
      scrapeInterval = null;
    }
    console.log(LOG_PREFIX, "Scraping stopped. Total:", collectedComments.length);
  }

  function sendUpdate() {
    if (port) {
      try {
        port.postMessage({
          type: "SCRAPE_UPDATE",
          total: collectedComments.length,
          limit: commentLimit === Infinity ? 0 : commentLimit,
        });
      } catch (e) {
        stopScraping();
      }
    }
  }

  // --- Listen for port connections from popup ---
  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== "tiktok-scraper") return;

    port = p;
    console.log(LOG_PREFIX, "Popup connected");

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
      console.log(LOG_PREFIX, "Popup disconnected");
    });
  });

  console.log(LOG_PREFIX, "Content script loaded on", window.location.href);
})();
