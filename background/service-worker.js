// TikTok Comment Analyzer - Background Service Worker
// Handles Gemini API calls and report data storage

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const BATCH_SIZE = 50;

// Store report data for the report page
let lastReportData = null;

chrome.runtime.onInstalled.addListener(() => {
  console.log("TikTok Comment Analyzer installed");
});

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_COMMENTS") {
    handleAnalysis(message.comments, message.apiKey)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) =>
        sendResponse({ success: false, error: err.message })
      );
    return true; // async sendResponse
  }

  if (message.type === "SAVE_REPORT") {
    lastReportData = message.data;
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "GET_REPORT") {
    sendResponse({ success: true, data: lastReportData });
    return false;
  }
});

// --- Robust JSON parser ---
function parseGeminiJSON(text) {
  // Attempt 1: direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    // continue
  }

  // Attempt 2: extract from markdown code block
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      // continue
    }
  }

  // Attempt 3: find first { and last } boundaries
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.substring(first, last + 1));
    } catch (e) {
      // continue
    }
  }

  // Attempt 4: find first [ and last ] (array response)
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.substring(firstBracket, lastBracket + 1));
    } catch (e) {
      // continue
    }
  }

  console.error("[TikTok Analyzer] Failed to parse Gemini response:", text.substring(0, 500));
  throw new Error("Gagal parse respons dari Gemini");
}

// --- Call Gemini API ---
async function callGemini(prompt, apiKey) {
  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 65536,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    if (response.status === 400) {
      throw new Error("API key tidak valid atau request salah");
    } else if (response.status === 429) {
      throw new Error("Rate limit tercapai. Coba lagi nanti.");
    }
    throw new Error(`Gemini API error (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    console.error("[TikTok Analyzer] Empty Gemini response. Finish reason:", finishReason);
    throw new Error("Respons Gemini kosong");
  }

  console.log("[TikTok Analyzer] Gemini response length:", text.length);
  return parseGeminiJSON(text);
}

// --- Broadcast progress to popup ---
function broadcastProgress(current, total) {
  chrome.runtime.sendMessage({
    type: "ANALYSIS_PROGRESS",
    current: current,
    total: total,
    progress: current / total,
  }).catch(() => {
    // popup might be closed, ignore
  });
}

// --- Split into batches ---
function splitIntoBatches(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

// --- Main analysis handler ---
async function handleAnalysis(comments, apiKey) {
  if (!apiKey) throw new Error("API key Gemini belum diatur");
  if (!comments || comments.length === 0)
    throw new Error("Tidak ada komentar untuk dianalisis");

  console.log("[TikTok Analyzer] Analyzing", comments.length, "comments");

  // Small batch: single call with full prompt
  if (comments.length <= BATCH_SIZE) {
    broadcastProgress(1, 2);
    const commentTexts = comments.map(
      (c, i) => `${i + 1}. @${c.username}: ${c.text}`
    );
    const prompt = buildFullPrompt(commentTexts);
    const result = await callGemini(prompt, apiKey);
    broadcastProgress(2, 2);
    return result;
  }

  // Large batch: classify in batches, then summarize
  console.log("[TikTok Analyzer] Using batched analysis for", comments.length, "comments");

  const batches = splitIntoBatches(comments, BATCH_SIZE);
  const allClassified = [];
  let globalIndex = 0;

  const totalSteps = batches.length + 1; // batches + summary

  for (let i = 0; i < batches.length; i++) {
    console.log("[TikTok Analyzer] Processing batch", i + 1, "of", batches.length);

    // Send progress to popup
    broadcastProgress(i + 1, totalSteps);

    const batch = batches[i];
    const commentTexts = batch.map(
      (c, j) => `${globalIndex + j + 1}. @${c.username}: ${c.text}`
    );

    const prompt = buildClassificationPrompt(commentTexts, globalIndex);
    const result = await callGemini(prompt, apiKey);

    const classified = result.comments || result;
    if (Array.isArray(classified)) {
      allClassified.push(...classified);
    }

    globalIndex += batch.length;
  }

  // Final summary call with a sample of comments
  console.log("[TikTok Analyzer] Generating summary...");
  broadcastProgress(totalSteps, totalSteps);
  const sampleSize = Math.min(comments.length, 80);
  const step = Math.max(1, Math.floor(comments.length / sampleSize));
  const sampleComments = [];
  for (let i = 0; i < comments.length && sampleComments.length < sampleSize; i += step) {
    sampleComments.push(comments[i]);
  }

  const sampleTexts = sampleComments.map(
    (c, i) => `${i + 1}. @${c.username}: ${c.text}`
  );
  const summaryPrompt = buildSummaryPrompt(sampleTexts, comments.length);
  const summaryResult = await callGemini(summaryPrompt, apiKey);

  return {
    summary: summaryResult.summary || "Tidak ada ringkasan.",
    sentiment: summaryResult.sentiment || { positive: 33, negative: 33, neutral: 34 },
    topics: summaryResult.topics || [],
    highlights: summaryResult.highlights || [],
    comments: allClassified,
  };
}

// --- Prompts ---

function buildFullPrompt(commentTexts) {
  return `Kamu adalah analis sentimen media sosial. Analisis komentar TikTok berikut dan berikan hasil dalam format JSON.

Komentar:
${commentTexts.join("\n")}

Berikan respons dalam format JSON berikut (TANPA markdown code block, langsung JSON):
{
  "summary": "Ringkasan keseluruhan komentar dalam 2-3 kalimat bahasa Indonesia",
  "sentiment": {
    "positive": <persentase 0-100>,
    "negative": <persentase 0-100>,
    "neutral": <persentase 0-100>
  },
  "topics": ["topik1", "topik2", "topik3"],
  "highlights": [
    {
      "text": "teks komentar menarik",
      "username": "username",
      "reason": "alasan mengapa menarik"
    }
  ],
  "comments": [
    {
      "index": <nomor komentar>,
      "username": "username",
      "text": "teks komentar",
      "sentiment": "positif|negatif|netral",
      "confidence": <0.0-1.0>
    }
  ]
}

Pastikan:
- Persentase sentiment harus berjumlah 100
- Setiap komentar harus diklasifikasi
- Highlights maksimal 5 komentar paling menarik
- Topics maksimal 5 topik utama
- Semua teks output dalam bahasa Indonesia`;
}

function buildClassificationPrompt(commentTexts, startIndex) {
  return `Klasifikasikan sentimen setiap komentar TikTok berikut. Berikan respons dalam format JSON.

Komentar:
${commentTexts.join("\n")}

Berikan respons dalam format JSON berikut (TANPA markdown code block, langsung JSON):
{
  "comments": [
    {
      "index": <nomor komentar>,
      "username": "username",
      "text": "teks komentar",
      "sentiment": "positif|negatif|netral",
      "confidence": <0.0-1.0>
    }
  ]
}

Pastikan setiap komentar diklasifikasi. Sentiment harus salah satu dari: "positif", "negatif", atau "netral".`;
}

function buildSummaryPrompt(sampleTexts, totalCount) {
  return `Kamu adalah analis sentimen media sosial. Berikut adalah sampel dari ${totalCount} komentar TikTok. Berikan ringkasan dan analisis keseluruhan.

Sampel komentar:
${sampleTexts.join("\n")}

Berikan respons dalam format JSON berikut (TANPA markdown code block, langsung JSON):
{
  "summary": "Ringkasan keseluruhan komentar dalam 2-3 kalimat bahasa Indonesia",
  "sentiment": {
    "positive": <persentase 0-100>,
    "negative": <persentase 0-100>,
    "neutral": <persentase 0-100>
  },
  "topics": ["topik1", "topik2", "topik3"],
  "highlights": [
    {
      "text": "teks komentar menarik dari sampel",
      "username": "username",
      "reason": "alasan mengapa menarik"
    }
  ]
}

Pastikan:
- Persentase sentiment harus berjumlah 100
- Highlights maksimal 5 komentar paling menarik
- Topics maksimal 5 topik utama
- Semua teks output dalam bahasa Indonesia`;
}
