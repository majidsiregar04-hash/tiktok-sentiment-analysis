// TikTok Comment Analyzer - Background Service Worker
// Handles Gemini API calls and report data storage

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

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

// --- Gemini API Analysis ---
async function handleAnalysis(comments, apiKey) {
  if (!apiKey) throw new Error("API key Gemini belum diatur");
  if (!comments || comments.length === 0)
    throw new Error("Tidak ada komentar untuk dianalisis");

  const commentTexts = comments.map(
    (c, i) => `${i + 1}. @${c.username}: ${c.text}`
  );

  const prompt = buildPrompt(commentTexts);

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
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
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) throw new Error("Respons Gemini kosong");

  try {
    return JSON.parse(text);
  } catch (e) {
    // Try to extract JSON from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1].trim());
    }
    throw new Error("Gagal parse respons dari Gemini");
  }
}

function buildPrompt(commentTexts) {
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
