(async function () {
  "use strict";

  const reportEl = document.getElementById("report");
  const loadingEl = document.getElementById("loading");

  function showError(msg) {
    loadingEl.textContent = msg;
    loadingEl.style.color = "#ff4757";
    console.error("[TikTok Report]", msg);
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("Timeout setelah " + ms + "ms"));
        }, ms);
      }),
    ]);
  }

  // --- Load report data ---
  var reportData = null;

  // Method 1: chrome.storage.local
  try {
    console.log("[TikTok Report] Trying chrome.storage.local...");
    var stored = await withTimeout(chrome.storage.local.get(["reportData"]), 3000);
    if (stored && stored.reportData) {
      reportData = stored.reportData;
      console.log("[TikTok Report] Loaded from storage.local");
    }
  } catch (e) {
    console.error("[TikTok Report] storage.local failed:", e.message);
  }

  // Method 2: background service worker
  if (!reportData) {
    try {
      console.log("[TikTok Report] Trying sendMessage GET_REPORT...");
      var response = await withTimeout(
        chrome.runtime.sendMessage({ type: "GET_REPORT" }),
        3000
      );
      if (response && response.success && response.data) {
        reportData = response.data;
        console.log("[TikTok Report] Loaded from service worker");
      }
    } catch (e) {
      console.error("[TikTok Report] sendMessage failed:", e.message);
    }
  }

  // Method 3: retry storage after delay
  if (!reportData) {
    await new Promise(function (r) { setTimeout(r, 1000); });
    try {
      console.log("[TikTok Report] Retrying storage.local...");
      var stored2 = await withTimeout(chrome.storage.local.get(["reportData"]), 3000);
      if (stored2 && stored2.reportData) {
        reportData = stored2.reportData;
        console.log("[TikTok Report] Loaded from storage.local (retry)");
      }
    } catch (e) {
      console.error("[TikTok Report] storage.local retry failed:", e.message);
    }
  }

  if (!reportData) {
    showError("Tidak ada data laporan. Jalankan analisis terlebih dahulu.");
    return;
  }

  // --- Render report ---
  try {
    var analysis = reportData.analysis || {};
    var totalComments = reportData.totalComments || 0;
    var timestamp = reportData.timestamp;
    var date = new Date(timestamp);
    var dateStr = date.toLocaleDateString("id-ID", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    var sentiment = analysis.sentiment || {};
    var pos = sentiment.positive || 0;
    var neu = sentiment.neutral || 0;
    var neg = sentiment.negative || 0;

    function esc(str) {
      if (!str) return "";
      var d = document.createElement("div");
      d.textContent = String(str);
      return d.innerHTML;
    }

    var highlightsHtml = (analysis.highlights || [])
      .map(function (h) {
        return '<div class="highlight-item">' +
          '<div class="highlight-user">@' + esc(h ? h.username : "") + '</div>' +
          '<div class="highlight-text">' + esc(h ? h.text : "") + '</div>' +
          '<div class="highlight-reason">' + esc(h ? h.reason : "") + '</div>' +
          '</div>';
      })
      .join("");

    var commentsHtml = (analysis.comments || [])
      .map(function (c, i) {
        return '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>@' + esc(c ? c.username : "") + '</td>' +
          '<td>' + esc(c ? c.text : "") + '</td>' +
          '<td><span class="badge ' + (c ? c.sentiment : "") + '">' + (c ? c.sentiment : "") + '</span></td>' +
          '</tr>';
      })
      .join("");

    var html =
      '<button class="print-btn no-print" id="printBtn">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>' +
          '<rect x="6" y="14" width="12" height="8"/>' +
        '</svg>' +
        ' Cetak / Simpan PDF' +
      '</button>' +

      '<div class="report-header">' +
        '<h1>Laporan Analisis Sentimen TikTok</h1>' +
        '<div class="report-meta">' +
          '<span>' + esc(dateStr) + '</span>' +
          '<span>|</span>' +
          '<span>' + totalComments + ' komentar dianalisis</span>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Ringkasan</div>' +
        '<div class="summary">' + esc(analysis.summary) + '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Distribusi Sentimen</div>' +
        '<div class="sentiment-grid">' +
          '<div class="sentiment-card pos"><div class="pct">' + pos + '%</div><div class="lbl">Positif</div></div>' +
          '<div class="sentiment-card neu"><div class="pct">' + neu + '%</div><div class="lbl">Netral</div></div>' +
          '<div class="sentiment-card neg"><div class="pct">' + neg + '%</div><div class="lbl">Negatif</div></div>' +
        '</div>' +
        '<div class="bar-row">' +
          '<div class="bar-positive" style="width:' + pos + '%"></div>' +
          '<div class="bar-neutral" style="width:' + neu + '%"></div>' +
          '<div class="bar-negative" style="width:' + neg + '%"></div>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Topik Utama</div>' +
        '<div class="topic-tags">' +
          (analysis.topics || []).map(function (t) {
            return '<span class="topic-tag">' + esc(t) + '</span>';
          }).join("") +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Komentar Menarik</div>' +
        highlightsHtml +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Semua Komentar (' + (analysis.comments || []).length + ')</div>' +
        '<table class="comment-table">' +
          '<thead><tr><th>#</th><th>Username</th><th>Komentar</th><th>Sentimen</th></tr></thead>' +
          '<tbody>' + commentsHtml + '</tbody>' +
        '</table>' +
      '</div>';

    loadingEl.remove();
    reportEl.innerHTML = html;

    // Attach print handler (no inline onclick)
    var printBtn = document.getElementById("printBtn");
    if (printBtn) {
      printBtn.addEventListener("click", function () {
        window.print();
      });
    }

    console.log("[TikTok Report] Report rendered successfully");
  } catch (e) {
    showError("Error saat render laporan: " + e.message);
    console.error("[TikTok Report] Render error:", e);
  }
})();
