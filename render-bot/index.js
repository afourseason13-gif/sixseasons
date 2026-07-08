const express = require("express");
const admin = require("firebase-admin");
const WebSocket = require("ws");
const { createWorker } = require("tesseract.js");
const https = require("https");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const databaseURL = process.env.FIREBASE_DATABASE_URL;
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const announceSecret = process.env.ANNOUNCE_SECRET || "";
const announceChatId = process.env.TELEGRAM_ANNOUNCE_CHAT_ID || "";
const trackingMoreApiKey = process.env.TRACKINGMORE_API_KEY || "";
const ocrSpaceApiKey = process.env.OCR_SPACE_API_KEY || process.env.OCRSPACE_API_KEY || "";

if (!botToken) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!databaseURL) throw new Error("Missing FIREBASE_DATABASE_URL");
if (!serviceAccountJson) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
  databaseURL
});

const db = admin.database();

function clean(value) {
  return String(value || "").trim();
}

function normalizeBankAccount(value) {
  return String(value || "").replace(/\D/g, "");
}

function firebaseKey(value) {
  return encodeURIComponent(clean(value)).replace(/[.#$\[\]]/g, "_");
}

function pickLineValue(text, labels) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const cleaned = line.replace(/\*/g, "").trim();
    const match = cleaned.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!match) continue;
    const label = match[1].trim().toUpperCase();
    if (!labels.some((item) => label === item || label.includes(item))) continue;
    const value = match[2].trim();
    if (value) return value;

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextValue = lines[nextIndex].replace(/\*/g, "").trim();
      if (!nextValue || /^-+$/.test(nextValue)) continue;
      if (/^[^:：]+[:：]/.test(nextValue)) break;
      return nextValue;
    }
  }
  return "";
}

function telegramSenderName(message) {
  const from = message?.from || {};
  const fullName = [from.first_name, from.last_name].map(clean).filter(Boolean).join(" ");
  return clean(fullName || from.username || message?.sender_chat?.title || message?.chat?.title || "");
}

function parseDealer(text, fallbackName = "") {
  const value = pickLineValue(text, ["DEALER", "DEALER 名字", "代理"]);
  if (value) return value;
  const hashMatch = text.match(/#dealer\s+(.+)/i);
  if (hashMatch) return clean(hashMatch[1]);
  const firstLine = clean(text.split(/\r?\n/).find(Boolean));
  if (/^dealer\s+/i.test(firstLine)) return clean(firstLine.replace(/^dealer\s+/i, "Dealer "));
  return clean(fallbackName) || "Telegram";
}

function isImportMessage(text, fallbackName = "") {
  const dealer = pickLineValue(text, ["DEALER", "DEALER 名字", "代理"]) || text.match(/#dealer\s+(.+)/i);

  const fields = {
    name: pickLineValue(text, ["NAMA", "NAME"]),
    ic: pickLineValue(text, ["IC NO", "IC"]),
    bank: pickLineValue(text, ["BANK", "NAMA BANK"]),
    account: pickLineValue(text, ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]),
    card: pickLineValue(text, ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "卡号"]),
    pin: pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"])
  };
  const filledCount = Object.values(fields).filter(Boolean).length;

  // Require a clearly structured customer record so ordinary group chat is ignored.
  return Boolean(dealer || clean(fallbackName))
    && Boolean(fields.name && fields.ic && fields.bank && fields.account)
    && Boolean(fields.card || fields.pin)
    && filledCount >= 5;
}

function isPotentialImportMessage(text) {
  const structuredLabels = [
    "NAMA", "NAME", "IC NO", "BANK", "NAMA BANK", "NO AKAUN",
    "ACC. NUMBER", "NO KAD", "BANK CARD 16 DIGIT", "PIN KAD ATM", "ATM PIN"
  ];
  const matchedFields = structuredLabels.filter((label) => pickLineValue(text, [label])).length;
  const hasCardOrShipment = Boolean(parseCardNumber(text) || parseShipmentCode(text).trackingNumber);
  return matchedFields >= 1 && hasCardOrShipment;
}

function parseShipmentCode(text) {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const carrierPrefixes = [
    "SHOPEEEXPRESS", "POSLAJU", "NINJAVAN", "CITYLINK",
    "SHOPEE", "SKYNET", "LAZADA", "FLASH", "GDEX",
    "NINJA", "FEDEX", "ARAMEX", "BEST", "JNT", "POS", "SPX",
    "DHL", "ABX", "KEX", "UPS", "LEX", "LAZ", "JT"
  ];
  for (const line of lines) {
    if (/^(DEALER|NAME|NAMA|IC|BANK|NO AKAUN|NO KAD|PIN|\*)/i.test(line)) continue;
    if (line.includes(":") || line.includes("：") || /^-+$/.test(line)) continue;
    const compact = line.replace(/[^A-Za-z0-9&]/g, "").toUpperCase();
    const prefixedCarrier = carrierPrefixes.find((prefix) => compact.startsWith(prefix) && compact.length > prefix.length + 2);
    if (prefixedCarrier) {
      const carrierCode = normalizeCarrierCode(prefixedCarrier);
      const rest = compact.slice(prefixedCarrier.length);
      const digits = rest.replace(/\D/g, "");
      if (digits.length >= 3) {
        return {
          carrier: carrierNameFromCode(carrierCode),
          carrierCode,
          trackingNumber: isFullTrackingNumber(rest) ? rest : compact,
          tailNumber: digits.slice(-4)
        };
      }
    }
    const match = compact.match(/^([A-Z&]+)(\d{3,})$/);
    if (match) {
      const carrierCode = normalizeCarrierCode(match[1]);
      const digits = match[2];
      const trackingNumber = digits.length >= 9 ? digits : compact;
      return {
        carrier: carrierNameFromCode(carrierCode),
        carrierCode,
        trackingNumber,
        tailNumber: match[2].slice(-4)
      };
    }
  }
  return { carrier: "", carrierCode: "", trackingNumber: "", tailNumber: "" };
}

function extractTrackingCandidates(text) {
  const candidates = [];
  const source = String(text || "").toUpperCase();
  const sources = [
    source,
    source.replace(/[^A-Z0-9]/g, ""),
    ...source.split(/\r?\n/).map((line) => line.replace(/[^A-Z0-9]/g, ""))
  ].filter(Boolean);
  const patterns = [
    /[A-Z]{2,5}\d{8,20}[A-Z]{0,3}/g,
    /\b\d{9,20}\b/g
  ];
  for (const item of sources) {
    for (const pattern of patterns) {
      for (const match of item.matchAll(pattern)) {
        const compact = match[0].replace(/[^A-Z0-9]/g, "");
        const digits = compact.replace(/\D/g, "");
        if (digits.length >= 8) candidates.push(compact);
      }
    }
  }
  return [...new Set(candidates)];
}

function candidateDigits(candidate) {
  return clean(candidate).replace(/\D/g, "");
}

function isCompleteOcrTrackingNumber(value, carrierCode) {
  const code = normalizeCarrierCode(carrierCode);
  const compact = clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digits = candidateDigits(compact);
  if (!compact) return false;

  if (["POS", "POSLAJU"].includes(code)) {
    return /^[A-Z]{2,3}\d{8,14}[A-Z]{2,3}$/.test(compact);
  }
  if (["JNT", "JT"].includes(code)) {
    return /^\d{12}$/.test(compact);
  }
  if (["SPX", "SHOPEE"].includes(code)) {
    return /^(MY|SPX)[A-Z0-9]{10,22}$/.test(compact);
  }
  if (["NINJA", "NINJAVAN"].includes(code)) {
    return /^(NV|NVMY)[A-Z0-9]{10,24}$/.test(compact);
  }
  if (["DHL"].includes(code)) {
    return /^[A-Z0-9]{10,24}$/.test(compact) && digits.length >= 10;
  }
  if (["GDEX", "SKY", "SKYNET", "CITY", "FLASH", "LAZ", "LEX", "ABX", "KEX", "BEST", "FEDEX", "UPS", "ARAMEX"].includes(code)) {
    return /^[A-Z0-9]{10,25}$/.test(compact) && digits.length >= 8;
  }
  return compact.length >= 10 && digits.length >= 8;
}

function candidateMatchesCarrier(candidate, carrierCode, tailNumber = "") {
  const code = normalizeCarrierCode(carrierCode);
  const compact = trackingNumberFromCandidate(candidate, code);
  const digits = candidateDigits(compact);
  const tail = clean(tailNumber).replace(/\D/g, "");
  if (tail && !digits.endsWith(tail)) return false;
  return isCompleteOcrTrackingNumber(compact, code);
}

function sortOcrTrackingCandidates(candidates, carrierCode) {
  const code = normalizeCarrierCode(carrierCode);
  return [...new Set(candidates)].sort((a, b) => {
    const left = trackingNumberFromCandidate(a, code);
    const right = trackingNumberFromCandidate(b, code);
    const leftComplete = isCompleteOcrTrackingNumber(left, code) ? 1 : 0;
    const rightComplete = isCompleteOcrTrackingNumber(right, code) ? 1 : 0;
    if (leftComplete !== rightComplete) return rightComplete - leftComplete;
    return right.length - left.length;
  });
}

function trackingNumberFromCandidate(candidate, carrierCode) {
  const compact = clean(candidate).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const code = normalizeCarrierCode(carrierCode);
  if (["POS", "POSLAJU"].includes(code)) {
    const posMatch = compact.match(/([A-Z]{2,3}\d{8,14}[A-Z]{2,3})$/);
    return posMatch ? posMatch[1] : compact;
  }
  if (["JNT", "JT"].includes(code)) return candidateDigits(compact);
  return compact;
}

function mergeOcrTrackingText(text, ocrText) {
  const shipment = parseShipmentCode(text);
  if (!shipment.carrierCode || !shipment.tailNumber || isFullTrackingNumber(shipment.trackingNumber)) return text;
  const candidates = extractTrackingCandidates(ocrText);
  const found = sortOcrTrackingCandidates(candidates, shipment.carrierCode)
    .find((candidate) => candidateMatchesCarrier(candidate, shipment.carrierCode, shipment.tailNumber));
  if (!found) return text;
  const fullNumber = trackingNumberFromCandidate(found, shipment.carrierCode);
  if (!fullNumber || fullNumber.length < 9) return text;
  return `${shipment.carrierCode}${fullNumber}\n${text}\n\nOCR Tracking: ${fullNumber}`;
}

async function findVerifiedOcrShipment(text, ocrText) {
  const shipment = parseShipmentCode(text);
  if (!shipment.carrierCode || !shipment.tailNumber || isFullTrackingNumber(shipment.trackingNumber)) {
    return { shipment, trackingResult: null };
  }
  const candidates = sortOcrTrackingCandidates(extractTrackingCandidates(ocrText), shipment.carrierCode)
    .filter((candidate) => candidateMatchesCarrier(candidate, shipment.carrierCode, shipment.tailNumber))
    .map((candidate) => trackingNumberFromCandidate(candidate, shipment.carrierCode));
  for (const trackingNumber of [...new Set(candidates)]) {
    const candidateShipment = {
      ...shipment,
      carrier: carrierNameFromCode(shipment.carrierCode),
      trackingNumber,
      tailNumber: shipment.tailNumber
    };
    const trackingResult = await fetchTrackingMyStatus({
      carrier: candidateShipment.carrier,
      carrierCode: candidateShipment.carrierCode,
      trackingNumber: candidateShipment.trackingNumber,
      tailNumber: candidateShipment.tailNumber
    });
    if (trackingResult.ok) return { shipment: candidateShipment, trackingResult };
  }
  return { shipment, trackingResult: null };
}

function findOcrShipmentCandidate(text, ocrText) {
  const shipment = parseShipmentCode(text);
  if (!shipment.carrierCode || !shipment.tailNumber || isFullTrackingNumber(shipment.trackingNumber)) {
    return shipment;
  }
  const candidates = sortOcrTrackingCandidates(extractTrackingCandidates(ocrText), shipment.carrierCode)
    .filter((candidate) => candidateMatchesCarrier(candidate, shipment.carrierCode, shipment.tailNumber))
    .map((candidate) => trackingNumberFromCandidate(candidate, shipment.carrierCode))
    .filter((trackingNumber) => isFullTrackingNumber(trackingNumber));
  const trackingNumber = [...new Set(candidates)][0] || "";
  if (!trackingNumber) return shipment;
  return {
    ...shipment,
    carrier: carrierNameFromCode(shipment.carrierCode),
    trackingNumber,
    tailNumber: shipment.tailNumber
  };
}

function buildMergedTrackingText(text, shipment) {
  if (!shipment?.carrierCode || !isFullTrackingNumber(shipment.trackingNumber)) return text;
  return `${shipment.carrierCode}${shipment.trackingNumber}\n${text}\n\nOCR Tracking: ${shipment.trackingNumber}`;
}

async function telegramFileUrl(fileId) {
  if (!fileId) return "";
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = await response.json().catch(() => ({}));
  const filePath = body?.result?.file_path;
  return filePath ? `https://api.telegram.org/file/bot${botToken}/${filePath}` : "";
}

async function ocrSpaceImagePayload(imageUrl) {
  try {
    const imageResponse = await fetchWithTimeout(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    }, 20000);
    if (imageResponse.ok) {
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      return { base64Image: `data:${contentType};base64,${bytes.toString("base64")}` };
    }
  } catch (error) {
    // Fall back to OCR.space fetching the Telegram file URL directly.
  }
  return { url: imageUrl };
}

async function readPhotoWithOcrSpaceEngine(imagePayload, engine = "2") {
  if (!ocrSpaceApiKey || (!imagePayload?.base64Image && !imagePayload?.url)) return "";
  const formData = new FormData();
  formData.append("apikey", ocrSpaceApiKey);
  formData.append("language", "eng");
  formData.append("scale", "true");
  formData.append("detectOrientation", "true");
  formData.append("OCREngine", engine);
  formData.append("isOverlayRequired", "false");
  if (imagePayload.base64Image) formData.append("base64Image", imagePayload.base64Image);
  else formData.append("url", imagePayload.url);

  try {
    const response = await fetchWithTimeout("https://api.ocr.space/parse/image", {
      method: "POST",
      body: formData
    }, 25000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.IsErroredOnProcessing) {
      console.error("OCR.space failed", body?.ErrorMessage || response.status);
      return "";
    }
    return (body?.ParsedResults || []).map((item) => clean(item?.ParsedText)).filter(Boolean).join("\n");
  } catch (error) {
    console.error("OCR.space failed", error);
    return "";
  }
}

async function readPhotoWithOcrSpace(imageUrl) {
  if (!ocrSpaceApiKey || !imageUrl) return "";
  const imagePayload = await ocrSpaceImagePayload(imageUrl);
  const results = [];
  for (const engine of ["2", "1"]) {
    const text = await readPhotoWithOcrSpaceEngine(imagePayload, engine);
    if (text) results.push(text);
  }
  return [...new Set(results)].join("\n");
}

async function readPhotoWithTesseract(imageUrl) {
  if (!imageUrl) return "";
  let worker;
  try {
    worker = await createWorker("eng");
    const result = await worker.recognize(imageUrl);
    return clean(result?.data?.text);
  } catch (error) {
    console.error("Tesseract OCR failed", error);
    return "";
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch (error) {
        // Ignore cleanup errors.
      }
    }
  }
}

async function readTelegramPhotoText(message) {
  const fileId = telegramLargestPhotoFileId(message);
  if (!fileId) return "";
  const imageUrl = await telegramFileUrl(fileId);
  if (!imageUrl) return "";
  const remoteText = await readPhotoWithOcrSpace(imageUrl);
  if (remoteText) return remoteText;

  // Tesseract workers can use hundreds of MB. Render's 512 MB instance is
  // killed when several Telegram photos arrive together, so local OCR is only
  // kept as a development fallback. Captions still import normally on Render.
  if (process.env.RENDER || process.env.DISABLE_LOCAL_OCR === "true") {
    console.warn("Skipping local Tesseract OCR on memory-limited runtime");
    return "";
  }
  return await readPhotoWithTesseract(imageUrl);
}

function telegramLargestPhotoFileId(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length) return clean(photos[photos.length - 1]?.file_id);
  const document = message?.document || {};
  const mimeType = clean(document.mime_type).toLowerCase();
  if (mimeType.startsWith("image/")) return clean(document.file_id);
  return "";
}

function ccidStatusLine(result) {
  if (!result?.checked) return "CCID status: CHECK FAILED. Carian 0 kali ⚠️";
  const count = Number(result.searchCount || 0);
  if (result.reportCount > 0) return `CCID status: report ${result.reportCount}. Carian ${count} kali ❌`;
  return `CCID status: NO report. Carian ${count} kali ✅`;
}

function buildTelegramFormattedDetails(fields, ccidResult) {
  const lines = [
    `*NAMA* : ${clean(fields.name)}`,
    "",
    `*IC NO* : ${clean(fields.ic)}`,
    "",
    `*BANK* : ${clean(fields.bank)}`,
    "",
    `*NO AKAUN* : ${clean(fields.account)}`,
    "----------------------",
    `*NO KAD* : ${clean(fields.card)}`,
    "",
    `*PIN KAD ATM* : ${clean(fields.pin)}`
  ];
  if (ccidResult) {
    lines.push("", "===============", ccidStatusLine(ccidResult));
  }
  return lines.join("\n");
}

async function checkCcidBankAccount(accountNumber) {
  const account = normalizeBankAccount(accountNumber);
  if (account.length < 3) {
    return { checked: false, account, searchCount: 0, reportCount: 0, statusText: "CHECK FAILED" };
  }
  try {
    const data = await postCcidSearch(account);
    if (Number(data?.status) !== 1) {
      return { checked: false, account, searchCount: 0, reportCount: 0, statusText: "CHECK FAILED" };
    }
    const reportCount = Array.isArray(data.table_data)
      ? data.table_data.reduce((sum, row) => sum + Number(Array.isArray(row) ? row[1] : row?.Repot || row?.report || 0), 0)
      : 0;
    return {
      checked: true,
      account,
      searchCount: Number(data.count || 0),
      reportCount,
      statusText: reportCount > 0 ? "REPORT FOUND" : "NO report",
      checkedAt: new Date().toISOString(),
      raw: data
    };
  } catch (error) {
    return {
      checked: false,
      account,
      searchCount: 0,
      reportCount: 0,
      statusText: "CHECK FAILED",
      error: error.message || "ccid_check_failed",
      checkedAt: new Date().toISOString()
    };
  }
}

async function updateTrackingNumberFromOcr(text, ocrText, photoFileId = "") {
  const originalShipment = parseShipmentCode(text);
  if (!originalShipment.carrierCode || !originalShipment.tailNumber || isFullTrackingNumber(originalShipment.trackingNumber)) {
    return { updated: false };
  }
  const verified = await findVerifiedOcrShipment(text, ocrText);
  const fallbackShipment = findOcrShipmentCandidate(text, ocrText);
  const fullShipment = isFullTrackingNumber(verified.shipment?.trackingNumber) ? verified.shipment : fallbackShipment;
  if (!isFullTrackingNumber(fullShipment.trackingNumber)) return { updated: false };
  const record = await findLatestRecordByParcelToken(originalShipment.trackingNumber);
  if (!record) return { updated: false, missing: true, tailNumber: originalShipment.tailNumber };
  const now = new Date().toISOString();
  const updateData = {
    carrier: fullShipment.carrier || record.carrier || "",
    trackingNumber: fullShipment.trackingNumber,
    trackingMoreCourierCode: trackingMoreCourierCode(fullShipment.carrierCode) || record.trackingMoreCourierCode || "",
    tailNumber: fullShipment.tailNumber || originalShipment.tailNumber,
    packagePhotoFileId: photoFileId || record.packagePhotoFileId || "",
    packagePhotoUpdatedAt: photoFileId ? now : (record.packagePhotoUpdatedAt || ""),
    notes: `${clean(record.notes)} \u00b7 OCR\u81ea\u52a8\u8865\u5b8c\u5305\u88f9\u5355\u53f7`.trim(),
    updatedAt: now
  };
  if (verified.trackingResult?.ok) {
    updateData.packageStatus = verified.trackingResult.label || record.packageStatus || "";
    updateData.trackingMyDetail = verified.trackingResult.source ? `${verified.trackingResult.source}: ${verified.trackingResult.detail}` : (verified.trackingResult.detail || record.trackingMyDetail || "");
    updateData.trackingLocation = verified.trackingResult.location || record.trackingLocation || "";
    updateData.trackingMyUrl = verified.trackingResult.url || record.trackingMyUrl || "";
    updateData.trackingMyLastError = null;
    updateData.trackingMyCheckedAt = now;
  }
  await db.ref(`dealer-card-tracker/records/${record.key}`).update(updateData);
  return {
    updated: true,
    dealerName: record.dealerName || "",
    cardNumber: record.cardNumber || "",
    parcelLabel: `${originalShipment.carrierCode}${originalShipment.tailNumber}`,
    trackingNumber: fullShipment.trackingNumber,
    packageStatus: verified.trackingResult?.label || "未检查"
  };
}

function normalizeCarrierCode(value) {
  return String(value || "").replace(/[^A-Z0-9]/g, "").toUpperCase();
}

function carrierNameFromCode(code) {
  const normalized = normalizeCarrierCode(code);
  const groups = [
    ["J&T Express", ["JNT", "JT"]],
    ["Pos Laju", ["POS", "POSLAJU"]],
    ["DHL Express", ["DHL"]],
    ["Ninja Van", ["NINJA", "NINJAVAN"]],
    ["GDEX", ["GDEX"]],
    ["City-Link Express", ["CITY", "CITYLINK"]],
    ["Flash Express", ["FLASH"]],
    ["SPX Express", ["SPX", "SHOPEE", "SHOPEEXPRESS"]],
    ["Lazada Logistics", ["LAZ", "LEX", "LAZADA"]],
    ["Skynet Express", ["SKYNET"]],
    ["ABX Express", ["ABX"]],
    ["KEX Express", ["KEX"]],
    ["BEST Express", ["BEST"]],
    ["FedEx", ["FEDEX"]],
    ["UPS", ["UPS"]],
    ["Aramex", ["ARAMEX"]]
  ];
  const found = groups.find(([, keys]) => keys.includes(normalized));
  return found ? found[0] : "";
}

function trackingMoreCourierCode(code) {
  const normalized = normalizeCarrierCode(code);
  const map = {
    JNT: "jtexpress-my",
    JT: "jtexpress-my",
    POS: "pos-malaysia",
    POSLAJU: "pos-malaysia",
    DHL: "dhl",
    NINJA: "ninjavan-my",
    NINJAVAN: "ninjavan-my",
    GDEX: "gdex",
    CITY: "citylinkexpress",
    CITYLINK: "citylinkexpress",
    FLASH: "flash-express",
    SPX: "shopee-express",
    SHOPEE: "shopee-express",
    LAZ: "lazada",
    LEX: "lazada",
    LAZADA: "lazada",
    SKYNET: "skynet",
    ABX: "abxexpress-my",
    KEX: "kex",
    BEST: "best-express",
    FEDEX: "fedex",
    UPS: "ups",
    ARAMEX: "aramex"
  };
  return map[normalized] || "";
}

function isFullTrackingNumber(value) {
  const compact = String(value || "").replace(/[^A-Za-z0-9]/g, "");
  const digits = compact.replace(/\D/g, "");
  return compact.length >= 9 && digits.length >= 6;
}

async function resolveDealerName(name) {
  const wanted = clean(name);
  const snapshot = await db.ref("dealer-card-tracker/dealers").get();
  const dealers = Object.values(snapshot.val() || {});
  const existing = dealers.find((dealer) => {
    return clean(dealer.name).toLowerCase() === wanted.toLowerCase();
  });
  return existing?.name || wanted;
}

async function findExistingDealerName(name) {
  const wanted = clean(name);
  if (!wanted) return "";
  const snapshot = await db.ref("dealer-card-tracker/dealers").get();
  const dealers = Object.values(snapshot.val() || {});
  const existing = dealers.find((dealer) => clean(dealer.name).toLowerCase() === wanted.toLowerCase());
  return existing?.name || "";
}

function parseCardNumber(text) {
  return pickLineValue(text, ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "卡号"]);
}

function bankAlias(bankName) {
  const map = {
    "BANK ISLAM": "ISLAM",
    "BSN": "BSN",
    "MUAMALAT": "MUA",
    "RAKYAT": "RAKYAT",
    "AMBANK": "AM",
    "ALLIANCE": "ALL",
    "MAYBANK": "MBB"
  };
  return map[bankName] || bankName || "";
}

function detectBank(text) {
  const source = text.toUpperCase();
  const compact = source.replace(/[^A-Z0-9]/g, "");
  const tokens = source.split(/[^A-Z0-9]+/).filter(Boolean);
  const hasToken = (...items) => items.some((item) => tokens.includes(item));
  if (source.includes("BANK ISLAM") || compact.includes("BANKISLAM") || source.includes("ISLAM")) return "BANK ISLAM";
  if (source.includes("MAYBANK") || source.includes("MAY BANK") || source.includes("MALAYAN BANKING") || hasToken("MBB")) return "MBB";
  if (source.includes("CIMB") || compact.includes("CIMBBANK")) return "CIMB";
  if (source.includes("AFFIN")) return "AFFIN";
  if (source.includes("AGRO") || source.includes("AGROBANK") || source.includes("AGRO BANK")) return "AGRO";
  if (source.includes("MUAMALAT") || source.includes("BANK MUAMALAT") || hasToken("MUA")) return "MUAMALAT";
  if (source.includes("RAKYAT") || source.includes("BANK RAKYAT") || hasToken("RYT", "RKT")) return "RAKYAT";
  if (source.includes("AMBANK") || source.includes("AM BANK") || compact.includes("AMBANK") || hasToken("AM")) return "AMBANK";
  if (source.includes("ALLIANCE") || hasToken("ALL")) return "ALLIANCE";
  if (source.includes("HONG LEONG") || compact.includes("HONGLEONG") || hasToken("HLB")) return "HLB";
  for (const bank of ["RHB", "BSN"]) {
    if (source.includes(bank)) return bank;
  }
  return "";
}

function lastFour(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

function displayCardNumber(text, bankName) {
  const rawCard = parseCardNumber(text);
  const last = lastFour(rawCard) || "XXXX";
  const alias = bankAlias(bankName);
  return alias ? `${alias}${last}` : last;
}

function parseCommandDate(text) {
  const isoMatch = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (isoMatch) return formatDateParts(isoMatch[1], isoMatch[2], isoMatch[3]);

  const localMatch = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
  if (localMatch) return formatDateParts(localMatch[3], localMatch[2], localMatch[1]);

  return "";
}

function formatDateParts(year, month, day) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const date = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (date.getUTCFullYear() !== Number(yyyy) || date.getUTCMonth() + 1 !== Number(mm) || date.getUTCDate() !== Number(dd)) {
    return "";
  }
  return `${yyyy}-${mm}-${dd}`;
}

function telegramMessageDate(message) {
  if (!message?.date) return formatDateInMalaysia(new Date());
  return formatDateInMalaysia(new Date(message.date * 1000));
}

function formatDateInMalaysia(date) {
  const local = new Date(date.getTime() + (8 * 60 * 60 * 1000));
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

function parseWarrantyDays(text) {
  const match = text.match(/(?:保|warranty|waranti)\s*(5|7)\b|(?:^|[^\d])(5|7)\s*天/i);
  return match ? Number(match[1] || match[2]) : 0;
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText || "").split("-").map(Number);
  if (!year || !month || !day || !days) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function daysSince(dateText, todayText) {
  const start = new Date(`${dateText}T00:00:00Z`).getTime();
  const end = new Date(`${todayText}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1);
}

function hasRejectedMark(text) {
  return /[❌✕×]/.test(text);
}

function problemStatusFromText(text) {
  if (text.includes("人头偷钱")) return "人头偷钱";
  if (text.includes("赔 150") || text.includes("赔150") || text.includes("赔钱150")) return "赔 150";
  if (text.includes("人头关") || text.includes("公户")) return "人头关";
  if (text.includes("弹卡") || text.includes("有问题") || text.includes("问题")) return "弹卡";
  if (hasRejectedMark(text)) return "炸";
  return "";
}

function parseBulkRecordCommands(text, defaultWarrantyDate = "") {
  const warrantyDate = parseCommandDate(text) || defaultWarrantyDate;
  const warrantyDays = parseWarrantyDays(text);
  if (!warrantyDate || !/(开保|保\d*|\d+\s*天)/.test(text)) return [];

  const commands = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cardTokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    for (const cardToken of cardTokens) {
      if (seen.has(cardToken)) continue;
      seen.add(cardToken);
      commands.push({
        action: "status",
        status: problemStatusFromText(line) || "开保",
        cardToken,
        warrantyDate,
        warrantyDays
      });
    }
  }
  return commands;
}

function statusFromCommandLine(line) {
  const source = String(line || "");
  if (source.includes("赔 150") || source.includes("赔150") || source.includes("赔钱150")) return "赔 150";
  if (source.includes("\u4eba\u5934\u5173") || source.includes("\u516c\u6237") || source.includes("浜哄ご鍏") || source.includes("鍏埛")) return "\u4eba\u5934\u5173";
  if (source.includes("\u5f39\u5361") || source.includes("\u5077\u94b1") || source.includes("\u6709\u95ee\u9898") || source.includes("\u95ee\u9898") || source.includes("寮瑰崱")) return "\u5f39\u5361";
  if (source.includes("\u70b8") || hasRejectedMark(source)) return "\u70b8";
  if (source.includes("\u8fc7\u4fdd") || source.includes("杩囦繚")) return "\u8fc7\u4fdd";
  if (source.includes("\u5f00\u4fdd") || source.includes("寮€淇")) return "\u5f00\u4fdd";
  if (source.includes("\u5bc4") || source.includes("瀵")) return "\u5bc4";
  if (source.includes("\u8f66\u624b\u5df2\u7b7e\u6536") || source.includes("\u7b7e\u6536")) return "\u8f66\u624b\u5df2\u7b7e\u6536";
  return "";
}

function parseGeneralBulkRecordCommands(text, defaultWarrantyDate = "") {
  const commands = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const status = statusFromCommandLine(line);
    if (!status) continue;
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cardTokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    for (const cardToken of cardTokens) {
      if (seen.has(cardToken)) continue;
      seen.add(cardToken);
      commands.push({
        action: "status",
        status,
        cardToken,
        warrantyDate: parseCommandDate(text) || (status === "\u5f00\u4fdd" ? defaultWarrantyDate : ""),
        warrantyDays: parseWarrantyDays(text)
      });
    }
  }
  return commands.length > 1 ? commands : [];
}

function parseDriverSignedCommands(text) {
  const source = String(text || "");
  const hasSignedLabel = source.includes("车手已签收") || source.includes("车手已拿");
  const courierCodes = new Set([
    "JNT", "JT", "POS", "POSLAJU", "SPX", "SHOPEE", "GDEX", "NINJA",
    "NINJAVAN", "DHL", "SKY", "SKYNET", "CITY", "FLASH", "LEX", "LAZ"
  ]);

  const commands = [];
  const seen = new Set();
  for (const line of source.split(/\r?\n/)) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cardTokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    if (!cardTokens.length) continue;
    if (!hasSignedLabel) {
      const hasParcelReference = cardTokens.some((token) => {
        const code = token.replace(/\d{4}$/, "");
        return courierCodes.has(code);
      });
      const hasSeparateCard = cardTokens.some((token) => {
        const code = token.replace(/\d{4}$/, "");
        return !courierCodes.has(code);
      });
      if (!hasParcelReference || !hasSeparateCard) continue;
    }
    const cardToken = cardTokens[cardTokens.length - 1];
    const parcelToken = cardTokens.find((token) => {
      const code = token.replace(/\d{4}$/, "");
      return courierCodes.has(code);
    }) || "";
    if (seen.has(cardToken)) continue;
    seen.add(cardToken);
    commands.push({ action: "deleteDriverSigned", cardToken, parcelToken });
  }
  return commands;
}

function parseParcelCardPairs(text) {
  const courierCodes = new Set([
    "JNT", "JT", "POS", "POSLAJU", "SPX", "SHOPEE", "GDEX", "NINJA",
    "NINJAVAN", "DHL", "SKY", "SKYNET", "CITY", "FLASH", "LEX", "LAZ"
  ]);
  const pairs = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const tokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    const parcelToken = tokens.find((token) => courierCodes.has(token.replace(/\d{4}$/, "")));
    const cardToken = tokens.find((token) => !courierCodes.has(token.replace(/\d{4}$/, "")));
    if (parcelToken && cardToken) {
      pairs.push({
        parcelToken,
        parcelCode: parcelToken.replace(/\d{4}$/, ""),
        tailNumber: parcelToken.slice(-4),
        cardToken
      });
    }
  }
  return pairs;
}

function recordCarrierMatchesCode(record, parcelCode) {
  const source = `${clean(record.carrier)} ${clean(record.trackingMoreCourierCode)}`.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const code = normalizeCarrierCode(parcelCode);
  if (["JNT", "JT"].includes(code)) return source.includes("JT") || source.includes("JTEXPRESS");
  if (["POS", "POSLAJU"].includes(code)) return source.includes("POS");
  if (["SPX", "SHOPEE"].includes(code)) return source.includes("SPX") || source.includes("SHOPEE");
  if (["NINJA", "NINJAVAN"].includes(code)) return source.includes("NINJA");
  if (["SKY", "SKYNET"].includes(code)) return source.includes("SKYNET");
  return source.includes(code);
}

async function fillMissingCardsByParcelReference(text) {
  const pairs = parseParcelCardPairs(text);
  if (!pairs.length) return { filled: 0, ambiguous: 0 };
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {}).map(([key, record]) => ({ key, ...record }));
  let filled = 0;
  let ambiguous = 0;

  for (const pair of pairs) {
    const candidates = records.filter((record) => {
      const tail = clean(record.tailNumber).replace(/\D/g, "").slice(-4);
      const card = clean(record.cardNumber).toUpperCase().replace(/[^A-Z0-9]/g, "");
      const cardIsMissing = !card || card.endsWith("XXXX");
      return cardIsMissing && tail === pair.tailNumber && recordCarrierMatchesCode(record, pair.parcelCode);
    });
    if (candidates.length === 1) {
      const record = candidates[0];
      await db.ref(`dealer-card-tracker/records/${record.key}`).update({
        cardNumber: pair.cardToken,
        notes: `${clean(record.notes)} \u00b7 \u8f66\u624b\u6309\u5305\u88f9\u5c3e\u53f7\u81ea\u52a8\u8865\u4e0a\u5361\u53f7`.trim(),
        cardMatchedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      record.cardNumber = pair.cardToken;
      filled += 1;
    } else if (candidates.length > 1) {
      const pendingRef = db.ref("dealer-card-tracker/pendingImports").push();
      await pendingRef.set({
        id: pendingRef.key,
        type: "conflict",
        reason: `\u5305\u88f9 ${pair.parcelToken} \u5339\u914d\u5230 ${candidates.length} \u6761\u672a\u8865\u5361\u53f7\u8d44\u6599`,
        cardNumber: pair.cardToken,
        tailNumber: pair.tailNumber,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      ambiguous += 1;
    }
  }
  return { filled, ambiguous };
}

function undoWordsFromText(text) {
  return ["撤销导入", "撤銷導入", "取消导入", "取消導入"].some((item) => text.includes(item));
}

function parseRecordCommand(text, defaultWarrantyDate = "", replyMessageId = "") {
  const statuses = ["车手已签收", "未处理", "处理中", "已寄出", "已完成", "过保", "开保", "寄", "弹卡", "人头关", "人头偷钱", "赔 150", "炸"];
  const latestUndoWords = ["撤销导入", "撤銷導入", "取消导入", "取消導入"];
  const deleteWords = ["删除", "刪除", "撤回", "撤销", "撤銷", ...latestUndoWords];
  const status = statuses.find((item) => text.includes(item)) || statusFromCommandLine(text) || problemStatusFromText(text);
  const shouldDelete = deleteWords.some((item) => text.includes(item));
  if (!status && !shouldDelete) return null;
  if (replyMessageId && undoWordsFromText(text)) {
    return { action: "deleteReplyImport", replyMessageId };
  }

  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cardMatch = compact.match(/([A-Z]{2,12}\d{4}|\d{4})/);
  if (!cardMatch) {
    if (latestUndoWords.some((item) => text.includes(item))) return { action: "deleteLatestImport" };
    return null;
  }

  return {
    action: shouldDelete ? "delete" : "status",
    status,
    cardToken: cardMatch[1],
    warrantyDate: parseCommandDate(text) || (status === "开保" ? defaultWarrantyDate : ""),
    warrantyDays: parseWarrantyDays(text)
  };
}

function recordMatchesCard(record, cardToken) {
  const wanted = clean(cardToken).toUpperCase();
  const card = clean(record.cardNumber).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!wanted || !card) return false;
  if (/^\d{4}$/.test(wanted)) return card.endsWith(wanted);
  return card === wanted;
}

function isMissingCardNumber(value) {
  const card = clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return !card || card.endsWith("XXXX");
}

function recordDetailValue(record, field, labels) {
  const saved = clean(record?.[field]);
  if (saved) return saved;
  return pickLineValue(clean(record?.formattedDetails), labels);
}

function formatSignedRecordDetails(record) {
  const name = recordDetailValue(record, "customerName", ["NAMA", "NAME"]);
  const ic = recordDetailValue(record, "icNumber", ["IC NO", "IC"]);
  const bank = recordDetailValue(record, "bankName", ["BANK", "NAMA BANK"]);
  const account = normalizeBankAccount(recordDetailValue(record, "bankAccount", ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]));
  const cardLabel = clean(record?.cardNumber) || recordDetailValue(record, "cardNumber", ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "卡号"]);
  const fullCard = clean(record?.receivedCardNumber)
    || pickLineValue(clean(record?.formattedDetails), ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "卡号"])
    || cardLabel;
  const pin = recordDetailValue(record, "atmPin", ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"]);
  const ccidLine = clean(record?.ccidStatusLine)
    || (clean(record?.formattedDetails).match(/CCID status:.+/i)?.[0] || "");
  return [
    cardLabel || "-",
    "",
    `*NAMA* : ${name}`,
    "",
    `*IC NO* : ${ic}`,
    "",
    `*BANK* : ${bank}`,
    "",
    `*NO AKAUN* : ${account}`,
    "----------------------",
    `*NO KAD* : ${fullCard}`,
    "",
    `*PIN KAD ATM* : ${pin}`,
    "----------------------",
    ccidLine ? "" : "",
    ccidLine ? "===============" : "",
    ccidLine
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n");
}

async function ensureRecordCcidStatus(record) {
  const savedCcidLine = clean(record?.ccidStatusLine)
    || (clean(record?.formattedDetails).match(/CCID status:.+/i)?.[0] || "");
  if (savedCcidLine && !/CHECK FAILED/i.test(savedCcidLine)) return record;
  const account = normalizeBankAccount(recordDetailValue(record, "bankAccount", ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]));
  const ccidResult = await checkCcidBankAccount(account);
  const ccidLine = ccidStatusLine(ccidResult);
  const updatedRecord = {
    ...record,
    ccidStatus: ccidResult.statusText,
    ccidSearchCount: ccidResult.searchCount,
    ccidReportCount: ccidResult.reportCount,
    ccidCheckedAt: ccidResult.checkedAt || new Date().toISOString(),
    ccidStatusLine: ccidLine,
    updatedAt: new Date().toISOString()
  };
  const formattedDetails = buildTelegramFormattedDetails({
    name: recordDetailValue(updatedRecord, "customerName", ["NAMA", "NAME"]),
    ic: recordDetailValue(updatedRecord, "icNumber", ["IC NO", "IC"]),
    bank: recordDetailValue(updatedRecord, "bankName", ["BANK", "NAMA BANK"]),
    account,
    card: pickLineValue(clean(updatedRecord.formattedDetails), ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "卡号"]) || updatedRecord.cardNumber,
    pin: recordDetailValue(updatedRecord, "atmPin", ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"])
  }, ccidResult);
  updatedRecord.formattedDetails = formattedDetails;
  if (record.key || record.id) {
    await db.ref(`dealer-card-tracker/records/${record.key || record.id}`).update({
      formattedDetails,
      ccidStatus: updatedRecord.ccidStatus,
      ccidSearchCount: updatedRecord.ccidSearchCount,
      ccidReportCount: updatedRecord.ccidReportCount,
      ccidCheckedAt: updatedRecord.ccidCheckedAt,
      ccidStatusLine: ccidLine,
      updatedAt: updatedRecord.updatedAt
    });
  }
  return updatedRecord;
}

function formatDriverPickupNotice(stopped, missing = []) {
  const lines = stopped.map((result) => {
    const parcel = clean(result.parcelToken || "");
    const card = clean(result.cardNumber || result.record?.cardNumber || result.cardToken || "-");
    const dealer = clean(result.record?.dealerName || "");
    const changed = result.cardChanged
      ? `\n\u5df2\u8865\u5361\u53f7\uff1a${result.originalCardNumber || "-"} \u2192 ${result.newCardNumber || card}`
      : "";
    return `${parcel ? `${parcel} | ` : ""}${card}${dealer ? ` \u00b7 ${dealer}` : ""}${changed}`;
  });
  const missingLines = missing.length ? ["", `找不到：${missing.join(", ")}`] : [];
  return [
    `车手已拿，已停止查询 ${stopped.length} 条`,
    "",
    ...lines,
    ...missingLines
  ].filter((line, index) => index < 2 || clean(line)).join("\n");
}

async function findLatestRecordByCard(cardToken) {
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {})
    .map(([key, record]) => ({ key, ...record }))
    .filter((record) => recordMatchesCard(record, cardToken))
    .sort((a, b) => clean(b.createdAt || b.updatedAt).localeCompare(clean(a.createdAt || a.updatedAt)));
  return records[0] || null;
}

async function findLatestRecordByParcelToken(parcelToken) {
  const token = clean(parcelToken).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = token.match(/^([A-Z]{2,12})(\d{4})$/);
  if (!match) return null;
  const parcelCode = match[1];
  const tailNumber = match[2];
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {})
    .map(([key, record]) => ({ key, ...record }))
    .filter((record) => {
      const tail = clean(record.tailNumber).replace(/\D/g, "").slice(-4);
      return tail === tailNumber && recordCarrierMatchesCode(record, parcelCode);
    })
    .sort((a, b) => clean(b.createdAt || b.updatedAt).localeCompare(clean(a.createdAt || a.updatedAt)));
  return records[0] || null;
}

async function rememberUnknownDriverCard(command) {
  const parcelToken = clean(command.parcelToken || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cardToken = clean(command.cardToken || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!parcelToken && !cardToken) return;
  const id = firebaseKey(`${parcelToken || "NOPARCEL"}-${cardToken || "NOCARD"}`);
  const ref = db.ref(`dealer-card-tracker/unknownDriverCards/${id}`);
  const existing = (await ref.get()).val() || {};
  await ref.update({
    id,
    parcelToken,
    cardToken,
    reason: "车手已收到，但系统找不到对应资料",
    count: Number(existing.count || 0) + 1,
    createdAt: existing.createdAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

async function getDriverSignedDetailsFromText(text) {
  const commands = parseDriverSignedCommands(text);
  const details = [];
  const missing = [];
  for (const command of commands) {
    const record = await findLatestRecordByCard(command.cardToken)
      || await findLatestRecordByParcelToken(command.parcelToken);
    if (record) {
      const readyRecord = await ensureRecordCcidStatus(record);
      details.push(formatSignedRecordDetails(readyRecord));
    } else {
      missing.push(command.cardToken);
    }
  }
  return { details, missing };
}

async function applyRecordCommand(command) {
  if (command.action === "deleteReplyImport") {
    const record = await findTelegramImportByMessage(command.replyMessageId);
    if (!record) return { ok: false, message: "找不到这条回复对应的导入资料" };
    await db.ref(`dealer-card-tracker/records/${record.key}`).remove();
    return { ok: true, cardNumber: record.cardNumber || record.id, status: "删除" };
  }

  if (command.action === "deleteLatestImport") {
    const record = await findLatestTelegramImport();
    if (!record) return { ok: false, message: "找不到可以撤销的导入资料" };
    await db.ref(`dealer-card-tracker/records/${record.key}`).remove();
    return { ok: true, cardNumber: record.cardNumber || record.id, status: "删除" };
  }

  let record = null;
  if (command.action === "deleteDriverSigned" && command.parcelToken) {
    record = await findLatestRecordByParcelToken(command.parcelToken);
  }
  if (!record) record = await findLatestRecordByCard(command.cardToken);
  if (!record) {
    if (command.action === "deleteDriverSigned") await rememberUnknownDriverCard(command);
    return { ok: false, cardToken: command.cardToken, message: `找不到卡号 ${command.cardToken}` };
  }

  if (command.action === "delete") {
    await db.ref(`dealer-card-tracker/records/${record.key}`).remove();
    return { ok: true, cardNumber: record.cardNumber || command.cardToken, status: "删除" };
  }

  if (command.action === "deleteDriverSigned") {
    const incomingCard = clean(command.cardToken).toUpperCase();
    const savedCard = clean(record.cardNumber).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const shouldFillMissingCard = incomingCard && isMissingCardNumber(savedCard);
    const updateData = {
      status: "车手已签收",
      packageStatus: "车手已签收",
      trackingStoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (shouldFillMissingCard) {
      updateData.cardNumber = incomingCard;
      updateData.cardMatchedAt = new Date().toISOString();
      updateData.notes = `${clean(record.notes)} \u00b7 \u8f66\u624b\u6309\u5305\u88f9\u5c3e\u53f7\u81ea\u52a8\u8865\u4e0a\u5361\u53f7`.trim();
      record = { ...record, ...updateData };
    }
    await db.ref(`dealer-card-tracker/records/${record.key}`).update(updateData);
    const readyRecord = await ensureRecordCcidStatus({ ...record, ...updateData, key: record.key });
    return {
      ok: true,
      cardNumber: readyRecord.cardNumber || command.cardToken,
      cardToken: command.cardToken,
      parcelToken: command.parcelToken || "",
      cardChanged: Boolean(updateData.cardNumber),
      originalCardNumber: savedCard || "",
      newCardNumber: updateData.cardNumber || "",
      status: "车手已签收",
      record: readyRecord
    };
  }

  const updateData = {
    status: command.status,
    updatedAt: new Date().toISOString()
  };
  if (command.status !== "寄") updateData.trackingStoppedAt = new Date().toISOString();
  if (command.status === "寄") updateData.trackingStoppedAt = null;
  if (command.status === "开保" && command.warrantyDate) updateData.warrantyDate = command.warrantyDate;
  if (command.status === "开保" && command.warrantyDays) updateData.warrantyDays = command.warrantyDays;

  await db.ref(`dealer-card-tracker/records/${record.key}`).update(updateData);
  return {
    ok: true,
    cardNumber: record.cardNumber || command.cardToken,
    status: command.status,
    warrantyDate: updateData.warrantyDate || "",
    warrantyDays: updateData.warrantyDays || 0
  };
}

async function findLatestTelegramImport() {
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {})
    .map(([key, record]) => ({ key, ...record }))
    .filter((record) => clean(record.notes).includes("Telegram 自动导入"))
    .sort((a, b) => clean(b.createdAt || b.updatedAt).localeCompare(clean(a.createdAt || a.updatedAt)));
  return records[0] || null;
}

async function findTelegramImportByMessage(messageId) {
  const wanted = String(messageId || "");
  if (!wanted) return null;
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {})
    .map(([key, record]) => ({ key, ...record }))
    .filter((record) => String(record.telegramMessageId || "") === wanted || String(record.telegramBotReplyMessageId || "") === wanted)
    .sort((a, b) => clean(b.createdAt || b.updatedAt).localeCompare(clean(a.createdAt || a.updatedAt)));
  return records[0] || null;
}

async function autoExpireWarrantyRecords() {
  const today = formatDateInMalaysia(new Date());
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const updates = {};
  for (const [key, record] of Object.entries(snapshot.val() || {})) {
    const days = Number(record.warrantyDays || 0);
    const expireDate = addDays(record.warrantyDate, days);
    if (record.status === "开保" && days > 0 && expireDate && today >= expireDate) {
      updates[`dealer-card-tracker/records/${key}/status`] = "过保";
      updates[`dealer-card-tracker/records/${key}/updatedAt`] = new Date().toISOString();
    }
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
  return Object.keys(updates).length / 2;
}

async function handleRecordCommand(text, defaultWarrantyDate = "", replyMessageId = "") {
  await autoExpireWarrantyRecords();
  const cardFillResult = await fillMissingCardsByParcelReference(text);
  const signedCommands = parseDriverSignedCommands(text);
  if (signedCommands.length) {
    const results = [];
    for (const command of signedCommands) {
      results.push(await applyRecordCommand(command));
    }
    const stopped = results.filter((result) => result.ok);
    const missing = results.filter((result) => !result.ok).map((result) => result.cardToken);
    const missingText = missing.length ? `\n找不到：${missing.join(", ")}` : "";
    return {
      handled: true,
      message: `车手已签收，已停止查询 ${stopped.length} 条${missingText}`,
      pickupNotice: formatDriverPickupNotice(stopped, missing)
    };
  }

  const generalBulkCommands = parseGeneralBulkRecordCommands(text, defaultWarrantyDate);
  if (generalBulkCommands.length) {
    const results = [];
    for (const command of generalBulkCommands) {
      results.push(await applyRecordCommand(command));
    }
    const summary = {};
    for (const item of results.filter((result) => result.ok)) {
      summary[item.status] = (summary[item.status] || 0) + 1;
    }
    const summaryText = Object.entries(summary).map(([status, count]) => `${status}${count}`).join("\uff0c") || "0";
    const missing = results.filter((item) => !item.ok).map((item) => item.cardToken);
    const missingText = missing.length ? `\n\u627e\u4e0d\u5230\uff1a${missing.join(", ")}` : "";
    return {
      handled: true,
      message: `\u6279\u91cf\u66f4\u65b0\u5b8c\u6210\uff1a${summaryText}${missingText}`
    };
  }

  const bulkCommands = parseBulkRecordCommands(text, defaultWarrantyDate);
  if (bulkCommands.length) {
    const results = [];
    for (const command of bulkCommands) {
      results.push(await applyRecordCommand(command));
    }
    const opened = results.filter((item) => item.ok && item.status === "开保").length;
    const bounced = results.filter((item) => item.ok && item.status === "弹卡").length;
    const closed = results.filter((item) => item.ok && item.status === "人头关").length;
    const stolen = results.filter((item) => item.ok && item.status === "人头偷钱").length;
    const rejected = results.filter((item) => item.ok && item.status === "炸").length;
    const missing = results.filter((item) => !item.ok).map((item) => item.cardToken);
    const missingText = missing.length ? `\n找不到：${missing.join(", ")}` : "";
    return {
      handled: true,
      message: `批量更新完成：开保${opened}，弹卡${bounced}，人头关${closed}，人头偷钱${stolen}，炸${rejected}${missingText}`
    };
  }

  const command = parseRecordCommand(text, defaultWarrantyDate, replyMessageId);
  if (!command) {
    if (cardFillResult.filled || cardFillResult.ambiguous) {
      return {
        handled: true,
        message: [
          cardFillResult.filled ? `\u5df2\u6309\u5305\u88f9\u5c3e\u53f7\u81ea\u52a8\u8865\u4e0a ${cardFillResult.filled} \u4e2a\u5361\u53f7` : "",
          cardFillResult.ambiguous ? `${cardFillResult.ambiguous} \u6761\u5339\u914d\u5230\u591a\u4efd\u8d44\u6599\uff0c\u5df2\u653e\u5165\u5f85\u5339\u914d\u4e2d\u5fc3` : ""
        ].filter(Boolean).join("\n")
      };
    }
    return { handled: false };
  }

  const result = await applyRecordCommand(command);
  if (!result.ok) return { handled: true, message: result.message };
  if (result.status === "删除") return { handled: true, message: `已删除 ${result.cardNumber}` };
  const dateText = result.warrantyDate ? ` 日期：${result.warrantyDate}` : "";
  return { handled: true, message: `已更新 ${result.cardNumber}：${result.status}${dateText}` };
}

function detectCarrier(text, carrierCode = "") {
  const source = `${carrierCode} ${text}`.toUpperCase();
  const compact = source.replace(/[^A-Z0-9]/g, "");
  const checks = [
    ["J&T Express", ["J&T", "JNT", "JT"]],
    ["Pos Laju", ["POSLAJU", "POS LAJU", "POS"]],
    ["DHL Express", ["DHL"]],
    ["Ninja Van", ["NINJA"]],
    ["GDEX", ["GDEX", "GDex"]],
    ["City-Link Express", ["CITYLINK", "CITY-LINK", "CITY LINK"]],
    ["Flash Express", ["FLASH"]],
    ["SPX Express", ["SPX", "SHOPEE XPRESS", "SHOPEE EXPRESS"]],
    ["Lazada Logistics", ["LAZADA", "LEX"]],
    ["Skynet Express", ["SKYNET"]],
    ["ABX Express", ["ABX"]],
    ["KEX Express", ["KEX"]],
    ["BEST Express", ["BEST"]],
    ["FedEx", ["FEDEX"]],
    ["UPS", ["UPS"]],
    ["Aramex", ["ARAMEX"]]
  ];
  for (const [carrier, keys] of checks) {
    if (keys.some((key) => source.includes(key) || compact.includes(key.replace(/[^A-Z0-9]/g, "")))) return carrier;
  }
  return "其他";
}

async function saveTelegramRecord(text, fallbackDealerName = "", telegramMessageId = "", photoFileId = "") {
  const requestedDealerName = parseDealer(text, fallbackDealerName);
  const existingDealerName = await findExistingDealerName(requestedDealerName);
  const rawCardNumber = parseCardNumber(text);
  const rawBankName = pickLineValue(text, ["BANK", "NAMA BANK"]);
  const bankName = detectBank(text);
  const shipment = parseShipmentCode(text);
  const cardNumber = displayCardNumber(text, bankName);
  const bankAccount = normalizeBankAccount(pickLineValue(text, ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]));
  const formattedDetails = buildTelegramFormattedDetails({
    name: pickLineValue(text, ["NAMA", "NAME"]),
    ic: pickLineValue(text, ["IC NO", "IC"]),
    bank: rawBankName || bankName,
    account: bankAccount,
    card: rawCardNumber || cardNumber,
    pin: pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"])
  });
  const now = new Date().toISOString();
  const recordsSnapshot = await db.ref("dealer-card-tracker/records").get();
  const existingRecords = Object.entries(recordsSnapshot.val() || {}).map(([id, record]) => ({ id, ...record }));
  const normalizeLookup = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normalizedCard = normalizeLookup(cardNumber);
  const normalizedTracking = normalizeLookup(shipment.trackingNumber);
  const cardMatch = normalizedCard && !normalizedCard.endsWith("XXXX")
    ? existingRecords.find((record) => normalizeLookup(record.cardNumber) === normalizedCard)
    : null;
  const trackingMatch = normalizedTracking
    ? existingRecords.find((record) => normalizeLookup(record.trackingNumber) === normalizedTracking)
    : null;
  const messageMatch = telegramMessageId
    ? existingRecords.find((record) => String(record.telegramMessageId || "") === String(telegramMessageId))
    : null;
  const existingRecord = messageMatch || cardMatch || null;

  let pendingReason = "";
  let pendingType = "missing";
  const requiredFields = {
    "姓名": pickLineValue(text, ["NAMA", "NAME"]),
    "IC": pickLineValue(text, ["IC NO", "IC"]),
    "银行": rawBankName || bankName,
    "银行账号": bankAccount,
    "卡号": rawCardNumber
  };
  const missingFields = Object.entries(requiredFields).filter(([, value]) => !clean(value)).map(([label]) => label);
  // New and incomplete records are saved under the Telegram sender first.
  // A later driver message can attach the missing card by parcel reference.
  const dealerName = existingDealerName || requestedDealerName || fallbackDealerName || "Telegram";

  if (!dealerName) {
    pendingReason = `找不到 Dealer：${requestedDealerName || "未提供"}`;
  } else if (!existingRecord && trackingMatch && normalizeLookup(trackingMatch.cardNumber) !== normalizedCard) {
    pendingType = "conflict";
    pendingReason = `包裹号码已绑定 ${trackingMatch.cardNumber || "其他卡号"}`;
  }

  if (pendingReason) {
    const pendingSnapshot = await db.ref("dealer-card-tracker/pendingImports").get();
    const duplicatePending = Object.values(pendingSnapshot.val() || {}).find((item) => (
      telegramMessageId && String(item.telegramMessageId || "") === String(telegramMessageId)
    ));
    if (duplicatePending) {
      return { pending: true, reason: duplicatePending.reason || pendingReason, cardNumber: duplicatePending.cardNumber || cardNumber };
    }
    const pendingRef = db.ref("dealer-card-tracker/pendingImports").push();
    await pendingRef.set({
      id: pendingRef.key,
      type: pendingType,
      reason: pendingReason,
      suggestedDealerName: dealerName || "",
      requestedDealerName,
      senderName: fallbackDealerName,
      cardNumber,
      rawCardNumber,
      bankName: rawBankName || bankName,
      carrier: shipment.carrier || detectCarrier(text, shipment.carrierCode),
      trackingNumber: isFullTrackingNumber(shipment.trackingNumber) ? shipment.trackingNumber : "",
      tailNumber: shipment.tailNumber,
      formattedDetails,
      ccidStatus: "",
      ccidSearchCount: 0,
      ccidReportCount: 0,
      ccidCheckedAt: "",
      ccidStatusLine: "",
      telegramMessageId: String(telegramMessageId || ""),
      createdAt: now,
      updatedAt: now
    });
    return { pending: true, reason: pendingReason, cardNumber };
  }
  const recordKey = existingRecord?.id || existingRecord?.key || db.ref("dealer-card-tracker/records").push().key;

  await db.ref(`dealer-card-tracker/dealers/${firebaseKey(dealerName)}`).update({
    name: dealerName,
    createdAt: now
  });

  const nextTrackingNumber = isFullTrackingNumber(shipment.trackingNumber) ? shipment.trackingNumber : (existingRecord?.trackingNumber || "");
  const nextCarrier = shipment.carrier || detectCarrier(text, shipment.carrierCode) || existingRecord?.carrier || "Other";
  const nextTailNumber = shipment.tailNumber || existingRecord?.tailNumber || "";
  const recordData = {
    id: recordKey,
    dealerName,
    customerName: pickLineValue(text, ["NAMA", "NAME"]),
    icNumber: pickLineValue(text, ["IC NO", "IC"]),
    bankName: rawBankName || bankName,
    bankAccount,
    cardNumber,
    atmPin: pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"]),
    formattedDetails,
    ccidStatus: existingRecord?.ccidStatus || "",
    ccidSearchCount: existingRecord?.ccidSearchCount || 0,
    ccidReportCount: existingRecord?.ccidReportCount || 0,
    ccidCheckedAt: existingRecord?.ccidCheckedAt || "",
    ccidStatusLine: existingRecord?.ccidStatusLine || "",
    carrier: nextCarrier,
    trackingNumber: nextTrackingNumber,
    trackingMoreCourierCode: trackingMoreCourierCode(shipment.carrierCode) || existingRecord?.trackingMoreCourierCode || "",
    tailNumber: nextTailNumber,
    warrantyDate: existingRecord?.warrantyDate || "",
    warrantyDays: existingRecord?.warrantyDays || 0,
    status: existingRecord?.status || "\u5bc4",
    notes: missingFields.length
      ? `Telegram 自动导入 · 待补资料：${missingFields.join("、")}`
      : "Telegram 自动导入",
    missingFields,
    telegramMessageId: String(telegramMessageId || existingRecord?.telegramMessageId || ""),
    telegramBotReplyMessageId: existingRecord?.telegramBotReplyMessageId || "",
    packagePhotoFileId: photoFileId || existingRecord?.packagePhotoFileId || "",
    packagePhotoUpdatedAt: photoFileId ? now : (existingRecord?.packagePhotoUpdatedAt || ""),
    packageStatus: existingRecord?.packageStatus || "",
    trackingMyDetail: existingRecord?.trackingMyDetail || "",
    trackingLocation: existingRecord?.trackingLocation || "",
    trackingStoppedAt: existingRecord?.trackingStoppedAt || "",
    updatedAt: now,
    createdAt: existingRecord?.createdAt || now
  };

  await db.ref(`dealer-card-tracker/records/${recordKey}`).set(recordData);
  await registerTrackingMore(recordData);

  return { dealerName, recordId: recordKey, updatedExisting: Boolean(existingRecord) };
}

async function rememberTelegramBotReply(recordId, messageId) {
  if (!recordId || !messageId) return;
  await db.ref(`dealer-card-tracker/records/${recordId}`).update({
    telegramBotReplyMessageId: String(messageId)
  });
}


async function registerTrackingMore(record) {
  if (!trackingMoreApiKey || !record.trackingNumber || !record.trackingMoreCourierCode) return;
  try {
    const response = await fetch("https://api.trackingmore.com/v3/trackings/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tracking-Api-Key": trackingMoreApiKey
      },
      body: JSON.stringify([{
        tracking_number: record.trackingNumber,
        courier_code: record.trackingMoreCourierCode,
        order_number: record.id,
        title: record.cardNumber || record.dealerName,
        note: `${record.dealerName} ${record.cardNumber || ""}`.trim(),
        lang: "en"
      }])
    });
    const body = await response.text();
    if (!response.ok && !body.toLowerCase().includes("already")) {
      throw new Error(`TrackingMore register failed: ${response.status} ${body}`);
    }
    await db.ref(`dealer-card-tracker/trackingNumbers/${record.trackingNumber}`).set({
      recordId: record.id,
      cardNumber: record.cardNumber || "",
      dealerName: record.dealerName || "",
      carrier: record.carrier || "",
      trackingNumber: record.trackingNumber,
      courierCode: record.trackingMoreCourierCode,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
  }
}

async function reply(chatId, text) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > 3900) {
    let splitAt = remaining.lastIndexOf("\n\n", 3900);
    if (splitAt < 1000) splitAt = 3900;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);

  let lastResult = {};
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk })
    });
    const body = await response.json().catch(() => ({}));
    lastResult = body.result || lastResult;
  }
  return lastResult;
}

async function ensureTelegramWebhook() {
  const externalUrl = clean(process.env.RENDER_EXTERNAL_URL).replace(/\/$/, "");
  const webhookUrl = externalUrl ? `${externalUrl}/telegram` : "";
  if (!webhookUrl) {
    console.warn("RENDER_EXTERNAL_URL is unavailable; Telegram webhook was not refreshed");
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      drop_pending_updates: false,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram webhook refresh failed: ${result.description || response.status}`);
  }
  console.log(`Telegram webhook refreshed: ${webhookUrl}`);
}

async function rememberTelegramChat(chatId) {
  await db.ref("dealer-card-tracker/settings/telegramChatId").set(String(chatId));
}

async function setTrackingNotificationChat(chatId) {
  await db.ref("dealer-card-tracker/settings/trackingNotificationChatId").set(String(chatId));
}

async function setTelegramRoleChat(role, chatId) {
  const roleKeys = {
    import: "importChatId",
    warranty: "warrantyChatId",
    tracking: "trackingNotificationChatId",
    pickup: "driverPickupNotificationChatId"
  };
  const key = roleKeys[role];
  if (!key) return;
  await db.ref(`dealer-card-tracker/settings/${key}`).set(String(chatId));
}

async function getTelegramRoleChats() {
  const snapshot = await db.ref("dealer-card-tracker/settings").get();
  const settings = snapshot.val() || {};
  return {
    import: clean(settings.importChatId),
    warranty: clean(settings.warrantyChatId),
    tracking: clean(settings.trackingNotificationChatId),
    pickup: clean(settings.driverPickupNotificationChatId)
  };
}

function chatMatchesRole(chatId, roleChatId) {
  return !roleChatId || String(chatId) === String(roleChatId);
}

function telegramRoleSummary(chatId, roles) {
  const current = String(chatId);
  const assigned = [];
  if (roles.import === current) assigned.push("资料导入群");
  if (roles.warranty === current) assigned.push("开保状态群");
  if (roles.tracking === current) assigned.push("包裹通知群");
  return assigned.length ? assigned.join("、") : "未分配任务";
}

async function sendTelegramMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
  if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
}

function pickWebhookTracking(body) {
  const data = Array.isArray(body?.data) ? body.data[0] : body?.data || body;
  return {
    trackingNumber: clean(data?.tracking_number || data?.trackingNumber || data?.number),
    status: clean(data?.delivery_status || data?.status || data?.tag || data?.substatus || data?.sub_status),
    checkpoint: clean(
      data?.latest_checkpoint ||
      data?.latest_event ||
      data?.latestEvent ||
      data?.lastEvent ||
      data?.origin_info?.trackinfo?.[0]?.StatusDescription ||
      data?.origin_info?.trackinfo?.[0]?.checkpoint_status
    )
  };
}

function normalizeTrackingStatus(status, checkpoint = "") {
  const source = `${status} ${checkpoint}`.toLowerCase();
  if (source.includes("delivered") || source.includes("已送达") || source.includes("已签收")) return "delivered";
  if (source.includes("pickup") || source.includes("out for delivery") || source.includes("派送")) return "pickup";
  if (source.includes("exception") || source.includes("failed") || source.includes("异常")) return "exception";
  return "";
}

async function notifyTrackingUpdate(body) {
  const event = pickWebhookTracking(body);
  const normalizedStatus = normalizeTrackingStatus(event.status, event.checkpoint);
  if (!event.trackingNumber || !normalizedStatus) return { notified: false };

  const trackingSnapshot = await db.ref(`dealer-card-tracker/trackingNumbers/${event.trackingNumber}`).get();
  const trackingInfo = trackingSnapshot.val() || {};
  const recordId = trackingInfo.recordId;
  const recordSnapshot = recordId ? await db.ref(`dealer-card-tracker/records/${recordId}`).get() : null;
  const record = recordSnapshot?.val() || trackingInfo;
  if (!record) return { notified: false };
  // Package tracking remains active only while the record is marked as sent.
  if (clean(record.status) !== "寄") return { notified: false };
  if (record.lastTrackingNotifyStatus === normalizedStatus) return { notified: false };

  const labelMap = {
    pickup: "派送中",
    delivered: "已送达",
    exception: "异常"
  };
  const label = labelMap[normalizedStatus] || event.status;
  const chatId = announceChatId || (await db.ref("dealer-card-tracker/settings/telegramChatId").get()).val();
  if (!chatId) return { notified: false };

  const message = [
    `包裹${label}`,
    "",
    `Dealer: ${record.dealerName || "-"}`,
    `卡号: ${record.cardNumber || "-"}`,
    `快递: ${record.carrier || trackingInfo.carrier || "-"}`,
    `单号: ${event.trackingNumber}`,
    event.checkpoint ? `状态: ${event.checkpoint}` : ""
  ].filter(Boolean).join("\n");

  await sendTelegramMessage(chatId, message);
  if (recordId) {
    await db.ref(`dealer-card-tracker/records/${recordId}`).update({
      packageStatus: label,
      lastTrackingNotifyStatus: normalizedStatus,
      updatedAt: new Date().toISOString()
    });
  }
  await db.ref(`dealer-card-tracker/trackingNumbers/${event.trackingNumber}`).update({
    lastTrackingNotifyStatus: normalizedStatus,
    packageStatus: label,
    updatedAt: new Date().toISOString()
  });
  return { notified: true };
}

function trackingMySlug(record) {
  const source = `${record.carrier || ""} ${record.carrierCode || ""} ${record.trackingMoreCourierCode || ""}`.toLowerCase();
  if (source.includes("j&t") || source.includes("jnt") || source.includes("jtexpress") || source.includes("jt")) return "jt";
  if (source.includes("pos")) return "pos";
  if (source.includes("ninja")) return "ninjavan";
  if (source.includes("gdex")) return "gdex";
  if (source.includes("city")) return "citylink";
  if (source.includes("flash")) return "flash";
  if (source.includes("spx") || source.includes("shopee")) return "shopee";
  if (source.includes("lazada") || source.includes("lex")) return "lazada";
  if (source.includes("skynet")) return "skynet";
  if (source.includes("abx")) return "abx";
  if (source.includes("best")) return "best";
  if (source.includes("dhl") && source.includes("ecommerce")) return "dhl-ecommerce";
  if (source.includes("dhl")) return "dhl";
  return "";
}

function trackingMySlugs(record) {
  const selected = trackingMySlug(record);
  const number = clean(record.trackingNumber).toUpperCase();
  const guessed = [];

  if (/^[A-Z]{2}\d{9}MY$/.test(number) || /^[A-Z]{3}\d{9,12}MY$/.test(number) || number.endsWith("MY")) {
    guessed.push("poslaju", "pos-malaysia", "pos");
  }
  if (/^\d{12}$/.test(number)) {
    guessed.push("jt");
  }
  if (/^N[VJ][A-Z0-9]{8,}$/i.test(number) || number.includes("NINJA")) {
    guessed.push("ninjavan");
  }
  if (/^MY[A-Z0-9]{8,}$/i.test(number)) {
    guessed.push("shopee", "spx", "lazada", "jt");
  }
  if (/^\d{14,20}$/.test(number)) {
    guessed.push("dhl-ecommerce", "dhl");
  }

  const slugs = [...new Set([selected, ...guessed].filter(Boolean))];
  return slugs.length ? slugs.slice(0, 5) : ["jt", "poslaju", "pos-malaysia", "pos"];
}

function officialTrackingUrls(record) {
  const number = encodeURIComponent(clean(record.trackingNumber));
  const slug = trackingMySlug(record) || trackingMySlugs(record)[0] || "";
  const urlsBySlug = {
    jt: [
      `https://www.jtexpress.my/tracking`
    ],
    poslaju: [
      `https://tracking.pos.com.my/tracking/${number}`,
      `https://www.pos.com.my/track-trace/${number}`,
      `https://www.pos.com.my/track-trace?trackingNumber=${number}`
    ],
    ninjavan: [
      `https://www.ninjavan.co/en-my/tracking?id=${number}`,
      `https://www.ninjavan.co/en-my/tracking/${number}`
    ],
    gdex: [
      `https://www.gdexpress.com/malaysia/e-tracking/?trackingno=${number}`,
      `https://www.gdexpress.com/track/${number}`
    ],
    citylink: [
      `https://www.citylinkexpress.com/wp/track-your-shipment/?tracking_no=${number}`
    ],
    flash: [
      `https://www.flashexpress.my/tracking/?se=${number}`
    ],
    spx: [
      `https://spx.com.my/m/track?tracking_number=${number}`
    ],
    lazada: [
      `https://tracker.lel.asia/?trackingNumber=${number}`
    ],
    skynet: [
      `https://www.skynet.com.my/track?tracking=${number}`
    ]
  };
  return urlsBySlug[slug] || [];
}

function plainPageText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isTrackingMyTemporaryFailure(text) {
  const source = String(text || "").toLowerCase();
  return [
    "sorry, tracking failed",
    "tracking failed",
    "server is currently inaccessible",
    "please refresh this page",
    "try tracking your shipment again",
    "our device caused this to happen"
  ].some((item) => source.includes(item));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function postJsonWithInsecureTls(url, payload, headers = {}, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(url, {
      method: "POST",
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers
      }
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${responseBody.slice(0, 120)}`));
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("request_timeout"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function postCcidSearch(account) {
  const payload = {
    data: {
      category: "bank",
      bankAccount: normalizeBankAccount(account),
      telNo: "",
      companyName: "",
      captcha: "",
      captchaHash: ""
    }
  };
  const headers = {
    apikey: "j3j389#nklala2",
    Origin: "https://semakmule.rmp.gov.my",
    Referer: "https://semakmule.rmp.gov.my/",
    "User-Agent": "Mozilla/5.0"
  };
  try {
    const response = await fetchWithTimeout("https://semakmule.rmp.gov.my/api/mule/get_search_data.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(payload)
    }, 18000);
    return await response.json();
  } catch (error) {
    if (!/certificate|UNABLE_TO_VERIFY|SELF_SIGNED|TLS|fetch failed/i.test(error.message || "")) throw error;
    return await postJsonWithInsecureTls("https://semakmule.rmp.gov.my/api/mule/get_search_data.php", payload, headers, 18000);
  }
}

function normalizeTrackingMyLatestStatus(status) {
  const source = String(status || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["delivered", "completed"].includes(source)) return "delivered";
  if (["out_for_delivery", "outfordelivery", "on_delivery", "ondelivery"].includes(source)) return "out_for_delivery";
  if (["exception", "attempt_fail", "attemptfail", "delivery_failed", "failed"].includes(source)) return "exception";
  if (["in_transit", "intransit", "transit", "pending", "info_received"].includes(source)) return "in_transit";
  return "";
}

function trackingMyLatestCheckpoint(result) {
  return trackingMyCheckpoints(result)[0] || {};
}

function trackingMyCheckpoints(result) {
  return Array.isArray(result?.result)
    ? result.result
    : Array.isArray(result?.checkpoints)
      ? result.checkpoints
      : [];
}

function trackingMyResultLocation(result) {
  const checkpoints = trackingMyCheckpoints(result);
  const latest = checkpoints[0] || {};
  const valuesWithLocations = [latest, ...checkpoints.slice(1), result];
  for (const value of valuesWithLocations) {
    const candidates = [
      value?.location,
      value?.checkpoint_location,
      value?.event_location,
      value?.office,
      value?.facility,
      value?.hub,
      value?.area,
      value?.city,
      value?.state,
      value?.branch,
      value?.latest_location
    ];
    for (const candidate of candidates) {
      const location = typeof candidate === "object"
        ? Object.values(candidate || {}).map(clean).filter(Boolean).join(", ")
        : clean(candidate);
      if (location) return location.replace(/\s+/g, " ").slice(0, 90);
    }
  }

  const locationKeys = /(location|place|city|state|branch|office|facility|hub|area|station|centre|center|depot)/i;
  const findNestedLocation = (value, key = "", depth = 0) => {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string" || typeof value === "number") {
      return locationKeys.test(key) ? clean(value) : "";
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findNestedLocation(item, key, depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) {
        const found = findNestedLocation(childValue, childKey, depth + 1);
        if (found) return found;
      }
    }
    return "";
  };
  for (const value of valuesWithLocations) {
    const nestedLocation = findNestedLocation(value);
    if (nestedLocation) return nestedLocation.replace(/\s+/g, " ").slice(0, 90);
  }

  for (const checkpoint of checkpoints) {
    const checkpointText = [checkpoint.description, checkpoint.details, checkpoint.status].map(clean).join(" ");
    const explicitLocation = checkpointText.match(/(?:hub|facility|centre|center|branch|station|depot)\s*:\s*([^,;|]+)/i);
    if (explicitLocation?.[1]) return clean(explicitLocation[1]).replace(/\s+/g, " ").slice(0, 90);
  }

  const checkpointText = checkpoints
    .flatMap((checkpoint) => [checkpoint.description, checkpoint.details, checkpoint.status])
    .map(clean)
    .join(" ")
    .toUpperCase();
  const malaysiaPlaces = [
    "JOHOR BAHRU", "KUALA LUMPUR", "KOTA KINABALU", "GEORGE TOWN",
    "JOHOR", "PERAK", "SELANGOR", "PENANG", "KEDAH", "MELAKA", "MALACCA",
    "PAHANG", "KELANTAN", "TERENGGANU", "NEGERI SEMBILAN", "PERLIS",
    "SABAH", "SARAWAK", "PUTRAJAYA", "LABUAN"
  ];
  const place = malaysiaPlaces.find((item) => checkpointText.includes(item));
  if (place) return place;
  return "";
}

function trackingMyResultDetail(result, status) {
  const latest = trackingMyLatestCheckpoint(result);
  const parts = [
    latest.status,
    latest.description,
    latest.details,
    latest.location,
    latest.date,
    latest.datetime
  ].map(clean).filter(Boolean);
  return parts.join(" - ").slice(0, 220) || trackingStatusLabel(status);
}

function trackingMySocketPayload(html, slug, trackingNumber) {
  const source = String(html || "");
  const matches = [...source.matchAll(/socket\.send\("((?:[^"\\]|\\.)*)"\)/g)];
  for (const match of matches) {
    const decoded = decodeHtmlEntities(match[1]).replace(/\\"/g, "\"");
    try {
      const payload = JSON.parse(decoded);
      if (
        payload.action === "tracking" &&
        clean(payload.courier).toLowerCase() === clean(slug).toLowerCase() &&
        clean(payload.tracking_number) === clean(trackingNumber)
      ) {
        return payload;
      }
    } catch (error) {
      // Ignore unrelated socket messages on the page.
    }
  }
  return null;
}

function requestTrackingMySocketResponse(payload, acceptResult, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const socket = new WebSocket("wss://www.tracking.my/websocket", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Origin": "https://www.tracking.my"
      }
    });
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch (error) {
        // Socket may already be closed.
      }
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);

    socket.on("open", () => socket.send(JSON.stringify(payload)));
    socket.on("message", (data) => {
      try {
        const result = JSON.parse(data.toString());
        if (acceptResult(result)) finish(result);
      } catch (error) {
        // Ignore non-result messages and wait for the tracking response.
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

function requestTrackingMySocket(payload, timeoutMs = 15000) {
  return requestTrackingMySocketResponse(payload, (result) => Boolean(result?.latest_status), timeoutMs);
}

function detectedTrackingMySlugs(result) {
  const found = [];
  const knownSlugs = new Set([
    "jt", "pos", "poslaju", "pos-malaysia", "posmalaysia", "ninjavan",
    "ninja-van", "gdex", "citylink", "flash", "spx", "shopee", "shopee-express",
    "lazada", "skynet", "abx", "best", "dhl", "dhl-ecommerce"
  ]);
  const visit = (value, key = "") => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
      return;
    }
    if (typeof value !== "string") return;
    const normalizedKey = key.toLowerCase();
    const normalizedValue = value.trim().toLowerCase();
    if (
      /^[a-z0-9-]{2,40}$/.test(normalizedValue) &&
      (["courier", "courier_code", "courier_slug", "slug", "code"].includes(normalizedKey) || knownSlugs.has(normalizedValue))
    ) {
      found.push(normalizedValue);
    }
  };
  visit(result);
  return [...new Set(found)];
}

async function detectTrackingMySlugs(trackingNumber) {
  const result = await requestTrackingMySocketResponse(
    { action: "detect", tracking_number: clean(trackingNumber) },
    (response) => detectedTrackingMySlugs(response).length > 0,
    12000
  );
  return detectedTrackingMySlugs(result);
}

async function fetchTrackingMySocketStatus(slug, trackingNumber) {
  const url = `https://www.tracking.my/${encodeURIComponent(slug)}/${encodeURIComponent(trackingNumber)}`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9,ms;q=0.8",
        "Cache-Control": "no-cache"
      }
    }, 10000);
    if (!response.ok) return { ok: false };
    const html = await response.text();
    const payload = trackingMySocketPayload(html, slug, trackingNumber);
    if (!payload) return { ok: false };

    const result = await requestTrackingMySocket(payload);
    const status = normalizeTrackingMyLatestStatus(result?.latest_status);
    if (!status) return { ok: false };
    return {
      ok: true,
      status,
      label: trackingStatusLabel(status),
      detail: trackingMyResultDetail(result, status),
      location: trackingMyResultLocation(result),
      url,
      source: "Tracking.my"
    };
  } catch (error) {
    console.error(error);
    return { ok: false };
  }
}

function normalizeTrackingMyStatus(text) {
  const source = String(text || "").toLowerCase();
  const hasAny = (items) => items.some((item) => source.includes(item));
  const hasWord = (word) => new RegExp(`\\b${word}\\b`, "i").test(source);
  if (isTrackingMyTemporaryFailure(source)) return "";
  if (
    hasWord("delivered") ||
    hasAny([
      "successfully delivered",
      "parcel delivered",
      "shipment delivered",
      "delivered to",
      "\u5df2\u9001\u8fbe",
      "\u5df2\u7b7e\u6536",
      "\u7b7e\u6536"
    ])
  ) return "delivered";
  if (
    hasAny(["on delivery"]) ||
    hasAny([
      "out for delivery",
      "with delivery courier",
      "courier is delivering",
      "\u6d3e\u9001",
      "\u6d3e\u4ef6"
    ])
  ) return "out_for_delivery";
  if (
    hasAny([
      "delivery failed",
      "delivery unsuccessful",
      "unsuccessful delivery",
      "undelivered",
      "delivery exception",
      "shipment exception",
      "parcel exception",
      "return to sender",
      "recipient not available",
      "\u6d3e\u9001\u5931\u8d25",
      "\u6d3e\u4ef6\u5931\u8d25",
      "\u5feb\u9012\u5f02\u5e38",
      "\u5305\u88f9\u5f02\u5e38",
      "\u95ee\u9898\u4ef6"
    ])
  ) return "exception";
  if (
    hasAny([
      "in transit",
      "departure",
      "arrived at",
      "departed from",
      "sorting",
      "warehouse",
      "hub",
      "\u8fd0\u8f93",
      "\u8f6c\u8fd0",
      "\u4ed3\u5e93",
      "\u5230\u8fbe"
    ])
  ) return "in_transit";
  return "";
}

function trackingStatusLabel(status) {
  const labels = {
    delivered: "\u5df2\u9001\u8fbe",
    out_for_delivery: "\u6d3e\u9001\u4e2d",
    exception: "\u5f02\u5e38",
    in_transit: "\u8fd0\u8f93\u4e2d"
  };
  return labels[status] || "";
}

function trackingStatusSnippet(text, status) {
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  const keywords = {
    delivered: ["delivered", "\u5df2\u9001\u8fbe", "\u7b7e\u6536"],
    out_for_delivery: ["out for delivery", "on delivery", "\u6d3e\u9001", "\u6d3e\u4ef6"],
    exception: ["exception", "failed", "unsuccessful", "\u5f02\u5e38", "\u5931\u8d25"],
    in_transit: ["transit", "arrived", "warehouse", "\u8fd0\u8f93", "\u8f6c\u8fd0", "\u5230\u8fbe"]
  }[status] || [];
  const lower = cleanText.toLowerCase();
  const index = keywords.reduce((found, keyword) => {
    if (found >= 0) return found;
    return lower.indexOf(String(keyword).toLowerCase());
  }, -1);
  if (index < 0) return cleanText.slice(0, 160);
  return cleanText.slice(Math.max(0, index - 50), index + 140);
}

async function fetchStatusFromUrls(urls, sourceName, trackingNumber = "") {
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,ms;q=0.8",
            "Cache-Control": "no-cache"
          }
        });
        if (!response.ok) continue;
        const html = await response.text();
        const text = plainPageText(html);
        if (sourceName === "Tracking.my" && isTrackingMyTemporaryFailure(text)) {
          if (attempt < 2) await sleep(1200);
          continue;
        }
        const status = normalizeTrackingMyStatus(text);
        if (status) {
          return {
            ok: true,
            status,
            label: trackingStatusLabel(status),
            detail: trackingStatusSnippet(text, status),
            url,
            source: sourceName
          };
        }
      } catch (error) {
        console.error(error);
        if (attempt < 2) await sleep(1200);
      }
    }
  }
  return { ok: false };
}

async function fetchPosMalaysiaApiStatus(trackingNumber) {
  const number = clean(trackingNumber);
  if (!number) return { ok: false };
  const apiUrl = `https://apis.pos.com.my/apigateway/as2corporate/api/v2trackntracewebapijson/v1/?id=${encodeURIComponent(number)}`;
  const officialUrl = `https://tracking.pos.com.my/tracking/${encodeURIComponent(number)}`;
  try {
    const response = await fetchWithTimeout(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://tracking.pos.com.my/"
      }
    }, 12000);
    if (!response.ok) return { ok: false };
    const result = await response.json();
    const text = JSON.stringify(result);
    if (!text || text === "{}" || text === "[]" || /not found|no record|invalid/i.test(text)) return { ok: false };
    const status = normalizeTrackingMyStatus(text);
    if (!status) return { ok: false };
    return {
      ok: true,
      status,
      label: trackingStatusLabel(status),
      detail: trackingStatusSnippet(text, status),
      location: trackingMyResultLocation(result),
      url: officialUrl,
      source: "Pos Malaysia"
    };
  } catch (error) {
    console.error(error);
    return { ok: false };
  }
}

function ninjaVanLocationFromOrder(order) {
  const events = Array.isArray(order?.events) ? order.events : [];
  const latestWithLocation = [...events].reverse().find((event) => {
    const data = event?.data || {};
    return clean(data.hub_name || data.dp_name || data.waypoint_name || data.station_name || data.sorting_hub_name);
  }) || {};
  const data = latestWithLocation.data || {};
  const candidates = [
    data.hub_name,
    data.dp_name,
    data.waypoint_name,
    data.station_name,
    data.sorting_hub_name,
    order?.to_address?.city,
    order?.to_address?.state
  ];
  return candidates.map(clean).find(Boolean) || "";
}

function ninjaVanDetail(order) {
  const events = Array.isArray(order?.events) ? order.events : [];
  const latest = events[events.length - 1] || {};
  const parts = [
    order?.granular_status,
    order?.status,
    latest.type,
    ninjaVanLocationFromOrder(order),
    latest.time
  ].map(clean).filter(Boolean);
  return parts.join(" - ").slice(0, 220);
}

function shouldUseNinjaVanOfficial(record, trackingNumber) {
  const source = `${record.carrier || ""} ${record.carrierCode || ""}`.toUpperCase();
  const number = clean(trackingNumber).toUpperCase();
  return source.includes("NINJA") || /^NV[A-Z0-9]{8,}$/i.test(number);
}

async function fetchNinjaVanApiStatus(trackingNumber) {
  const number = clean(trackingNumber).toUpperCase();
  if (!number) return { ok: false };
  const apiUrl = `https://walrus.ninjavan.co/my/dash/1.2/public/orders?tracking_id=${encodeURIComponent(number)}`;
  const officialUrl = `https://www.ninjavan.co/en-my/tracking?id=${encodeURIComponent(number)}`;
  try {
    const response = await fetchWithTimeout(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Origin": "https://www.ninjavan.co",
        "Referer": officialUrl
      }
    }, 12000);
    if (!response.ok) return { ok: false };
    const order = await response.json();
    const text = [
      order?.granular_status,
      order?.status,
      JSON.stringify(order?.events || [])
    ].map(clean).join(" ");
    if (!text || /not found|invalid|missing/i.test(text)) return { ok: false };
    const status = normalizeTrackingMyStatus(text);
    if (!status) return { ok: false };
    return {
      ok: true,
      status,
      label: trackingStatusLabel(status),
      detail: ninjaVanDetail(order) || trackingStatusSnippet(text, status),
      location: ninjaVanLocationFromOrder(order),
      url: officialUrl,
      source: "Ninja Van"
    };
  } catch (error) {
    console.error(error);
    return { ok: false };
  }
}

async function fetchTrackingMyStatus(record) {
  const number = clean(record.trackingNumber);
  if (!number) return { ok: false, reason: "missing_tracking_or_courier" };

  if (shouldUseNinjaVanOfficial(record, number)) {
    const ninjaResult = await fetchNinjaVanApiStatus(number);
    if (ninjaResult.ok) return ninjaResult;
  }

  const detectedSlugs = await detectTrackingMySlugs(number);
  const slugs = [...new Set([...detectedSlugs, ...trackingMySlugs(record)])];
  if (!slugs.length) return { ok: false, reason: "missing_tracking_or_courier" };

  if (slugs.some((slug) => slug.includes("pos"))) {
    const posResult = await fetchPosMalaysiaApiStatus(number);
    if (posResult.ok) return posResult;
  }

  for (const slug of slugs) {
    const socketResult = await fetchTrackingMySocketStatus(slug, number);
    if (socketResult.ok) return socketResult;
  }

  return { ok: false, reason: "unable_to_parse_tracking_status" };
}

async function getTrackingChatId() {
  const selectedChatId = (await db.ref("dealer-card-tracker/settings/trackingNotificationChatId").get()).val();
  return selectedChatId || announceChatId || (await db.ref("dealer-card-tracker/settings/telegramChatId").get()).val();
}

function trackingCarrierCode(record) {
  const source = `${record.carrier || ""} ${record.carrierCode || ""}`.toUpperCase();
  if (source.includes("J&T") || source.includes("JNT") || source.includes("JT")) return "JNT";
  if (source.includes("POS")) return "POS";
  if (source.includes("NINJA")) return "NINJA";
  if (source.includes("GDEX")) return "GDEX";
  if (source.includes("CITY")) return "CITY";
  if (source.includes("FLASH")) return "FLASH";
  if (source.includes("SPX") || source.includes("SHOPEE")) return "SPX";
  if (source.includes("LAZ") || source.includes("LEX")) return "LEX";
  if (source.includes("SKYNET")) return "SKY";
  return clean(record.carrier || "PKG").split(/\s+/)[0].toUpperCase().slice(0, 6) || "PKG";
}

function trackingTail(record) {
  const tail = clean(record.tailNumber).replace(/\D/g, "").slice(-4);
  if (tail) return tail;
  const digits = clean(record.trackingNumber).replace(/\D/g, "");
  return digits.slice(-4) || "XXXX";
}

function packageStatusText(record, today = formatDateInMalaysia(new Date())) {
  const status = clean(record.packageStatus);
  if (status.includes("\u5df2\u9001\u8fbe") || record.lastTrackingNotifyStatus === "delivered") {
    const deliveredDays = daysSince(record.deliveredAt || today, today);
    return deliveredDays <= 1 ? "\u5df2\u9001\u8fbe" : `\u5df2\u9001\u8fbe\u7b2c${deliveredDays}\u5929`;
  }
  if (status.includes("\u6d3e\u9001")) return "\u6d3e\u9001\u4e2d";
  if (status.includes("\u5f02\u5e38")) return "\u5f02\u5e38\u6709\u95ee\u9898";
  if (status.includes("\u8fd0\u8f93")) return "\u8fd0\u8f93\u4e2d";
  if (status.includes("\u6682\u65f6\u67e5\u4e0d\u5230")) return "\u6682\u65f6\u67e5\u4e0d\u5230";
  return status || "\u672a\u68c0\u67e5";
}

function shouldIncludeTrackingSummary(record, today) {
  if (clean(record.status) !== "\u5bc4") return false;
  if (!isFullTrackingNumber(record.trackingNumber)) return false;
  if (formatDateInMalaysia(new Date(record.createdAt || record.updatedAt || Date.now())) >= today) return false;
  if (record.packageStatus === "\u5df2\u9001\u8fbe" || record.lastTrackingNotifyStatus === "delivered") return true;
  if (!record.trackingMyCheckedAt || formatDateInMalaysia(new Date(record.trackingMyCheckedAt)) !== today) return false;
  return true;
}

function wasTakenByDriverToday(record, today) {
  if (clean(record.status) !== "车手已签收") return false;
  if (!record.trackingStoppedAt) return false;
  return formatDateInMalaysia(new Date(record.trackingStoppedAt)) === today;
}

function trackingSummaryLocation(record) {
  const saved = clean(record.trackingLocation);
  if (saved) return saved;
  const detail = clean(record.trackingMyDetail);
  if (!detail) return "";
  const withoutPrefix = detail.replace(/^[^:]+:\s*/i, "");
  const parts = withoutPrefix.split(/\s+-\s+/).map(clean).filter(Boolean);
  if (parts.length >= 2) {
    const candidates = parts.slice(1).filter((part) => {
      return !/^\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?$/.test(part)
        && !/^(delivered|in_transit|out_for_delivery|exception)$/i.test(part);
    });
    if (candidates.length) return candidates[0];
  }
  return "";
}

function trackingLocationGroup(location) {
  const source = clean(location).toUpperCase();
  if (!source) return "位置待确认";
  if (source.includes("IPOH") || source.includes("KINTA")) return "IPOH / KINTA";
  if (source.includes("JOHOR BAHRU") || source.includes("JHR")) return "JOHOR BAHRU";
  if (source.includes("KAMPAR")) return "KAMPAR";
  if (source.includes("PERAK") || source.includes("PRK")) return "PERAK";
  if (source.includes("SELANGOR") || source.includes("SGR")) return "SELANGOR";
  if (source.includes("KUALA LUMPUR") || source.includes("KUL")) return "KUALA LUMPUR";
  if (source.includes("PENANG") || source.includes("PULAU PINANG") || source.includes("PEN")) return "PENANG";
  if (source.includes("JOHOR")) return "JOHOR";
  return source.replace(/\s+/g, " ").slice(0, 42);
}

function buildTrackingSummaryMessage(records, today, options = {}) {
  const summaryRecords = records
    .filter((record) => shouldIncludeTrackingSummary(record, today))
    .sort((a, b) => {
      const aGroup = trackingLocationGroup(trackingSummaryLocation(a));
      const bGroup = trackingLocationGroup(trackingSummaryLocation(b));
      return `${aGroup === "位置待确认" ? "ZZZ" : aGroup}${trackingCarrierCode(a)}${trackingTail(a)}${clean(a.cardNumber)}`
        .localeCompare(`${bGroup === "位置待确认" ? "ZZZ" : bGroup}${trackingCarrierCode(b)}${trackingTail(b)}${clean(b.cardNumber)}`);
    });

  if (!summaryRecords.length) return "";
  const groupedLines = new Map();
  for (const record of summaryRecords) {
    const location = trackingSummaryLocation(record);
    const group = trackingLocationGroup(location);
    const parcelLabel = `${trackingCarrierCode(record)}${trackingTail(record)}`;
    const line = `${parcelLabel} | ${clean(record.cardNumber || "-")} ${packageStatusText(record, today)}`;
    if (!groupedLines.has(group)) groupedLines.set(group, []);
    groupedLines.get(group).push(line);
  }
  const lines = [];
  for (const [group, groupLines] of groupedLines) {
    lines.push(`【${group}】`, ...groupLines, "");
  }
  if (lines.at(-1) === "") lines.pop();
  const hasReadyForPickup = summaryRecords.some((record) => {
    const status = packageStatusText(record, today);
    return status === "\u6d3e\u9001\u4e2d" || status.startsWith("\u5df2\u9001\u8fbe");
  });
  const driverTookPackagesToday = records.some((record) => wasTakenByDriverToday(record, today));
  const footer = options.addPickupSummary && driverTookPackagesToday && !hasReadyForPickup
    ? ["", "今天没有待拿的包裹了。"]
    : [];
  return ["\u5305\u88f9\u72b6\u6001", today, "", ...lines, ...footer].join("\n");
}

async function sendTrackingSummary(records, today, options = {}) {
  const chatId = await getTrackingChatId();
  if (!chatId) return false;
  const message = buildTrackingSummaryMessage(records, today, options);
  if (!message) {
    if (!options.notifyEmpty) return false;
    if (options.requireDriverPickupForEmpty && !records.some((record) => wasTakenByDriverToday(record, today))) return false;
    await sendTelegramMessage(chatId, `包裹状态\n${today}\n\n今天没有待拿的包裹了。`);
    return true;
  }
  await sendTelegramMessage(chatId, message);
  return true;
}

async function checkTrackingMyRecords(targetRecordId = "", options = {}) {
  const today = formatDateInMalaysia(new Date());
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {}).map(([key, record]) => ({ key, ...record }));
  const chatId = await getTrackingChatId();
  let checked = 0;
  let notified = 0;
  let deleted = 0;
  let skippedToday = 0;

  for (const record of records) {
    if (targetRecordId && record.key !== targetRecordId && record.id !== targetRecordId) continue;
    if (clean(record.status) !== "\u5bc4") continue;
    if (!isFullTrackingNumber(record.trackingNumber)) continue;
    if (
      options.onlyNeedsEveningCheck &&
      packageStatusText(record) !== "\u6d3e\u9001\u4e2d" &&
      !(record.trackingMyLastError || !record.trackingMyCheckedAt || formatDateInMalaysia(new Date(record.trackingMyCheckedAt)) !== today)
    ) continue;

    if (
      !targetRecordId
      && (record.packageStatus === "\u5df2\u9001\u8fbe" || record.lastTrackingNotifyStatus === "delivered")
      && trackingSummaryLocation(record)
    ) {
      continue;
    }

    if (!targetRecordId && formatDateInMalaysia(new Date(record.createdAt || record.updatedAt || Date.now())) === today) {
      skippedToday += 1;
      continue;
    }

    checked += 1;
    const result = await fetchTrackingMyStatus(record);
    if (!result.ok) {
      await db.ref(`dealer-card-tracker/records/${record.key}`).update({
        packageStatus: "\u6682\u65f6\u67e5\u4e0d\u5230",
        trackingMyLastError: result.reason,
        trackingMyDetail: result.reason === "unable_to_parse_tracking_status"
          ? "Tracking.my 暂时没有返回这个单号的真实状态，已保留原状态。"
          : result.reason,
        trackingMyCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      continue;
    }

    const updateData = {
      packageStatus: result.label,
      trackingMyDetail: result.source ? `${result.source}: ${result.detail}` : result.detail,
      trackingLocation: result.location || trackingSummaryLocation({ trackingMyDetail: result.detail }),
      trackingMyUrl: result.url,
      trackingMyLastError: null,
      trackingMyCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (result.status === "delivered" && !record.deliveredAt) updateData.deliveredAt = today;

    if (result.status === "delivered" && record.lastTrackingNotifyStatus !== "delivered") {
      updateData.lastTrackingNotifyStatus = result.status;
      notified += 1;
    }

    await db.ref(`dealer-card-tracker/records/${record.key}`).update(updateData);
  }

  let summarySent = false;
  if (options.sendSummary) {
    const latestSnapshot = await db.ref("dealer-card-tracker/records").get();
    const latestRecords = Object.entries(latestSnapshot.val() || {}).map(([key, record]) => ({ key, ...record }));
    summarySent = await sendTrackingSummary(latestRecords, today);
  }

  return { checked, notified, deleted, skippedToday, summarySent };
}

async function runScheduledTrackingMyCheck() {
  const now = new Date();
  const malaysia = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const today = formatDateInMalaysia(now);
  const time = `${String(malaysia.getUTCHours()).padStart(2, "0")}:${String(malaysia.getUTCMinutes()).padStart(2, "0")}`;
  const slots = [
    { time: "13:00", action: "checkAndSummary" }
  ];

  for (const slot of slots) {
    if (time < slot.time) continue;
    const slotKey = slot.time.replace(":", "");
    const runRef = db.ref(`dealer-card-tracker/settings/trackingMySchedule/${today}/${slotKey}`);
    if ((await runRef.get()).val()) continue;
    await runRef.set({
      startedAt: new Date().toISOString(),
      status: "running"
    });

    let result;
    if (slot.action === "check") {
      result = await checkTrackingMyRecords();
    } else if (slot.action === "summary") {
      const latestSnapshot = await db.ref("dealer-card-tracker/records").get();
      const latestRecords = Object.entries(latestSnapshot.val() || {}).map(([key, record]) => ({ key, ...record }));
      result = {
        checked: 0,
        notified: 0,
        deleted: 0,
        skippedToday: 0,
        summarySent: await sendTrackingSummary(latestRecords, today, {
          notifyEmpty: true,
          requireDriverPickupForEmpty: true
        })
      };
    } else {
      result = await checkTrackingMyRecords();
      const latestSnapshot = await db.ref("dealer-card-tracker/records").get();
      const latestRecords = Object.entries(latestSnapshot.val() || {}).map(([key, record]) => ({ key, ...record }));
      result.summarySent = await sendTrackingSummary(latestRecords, today, {
        notifyEmpty: true,
        requireDriverPickupForEmpty: true,
        addPickupSummary: true
      });
    }

    await runRef.update({
      finishedAt: new Date().toISOString(),
      status: "done"
    });
    await db.ref("dealer-card-tracker/settings/trackingMyLastRun").set({
      ...result,
      slot: slot.time,
      date: today,
      updatedAt: new Date().toISOString()
    });
  }
}

app.get("/", (_req, res) => {
  res.send("Dealer Telegram bot is running.");
  runScheduledTrackingMyCheck().catch((error) => console.error(error));
});

app.options("/announce", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.status(204).send("");
});

app.post("/announce", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const message = clean(req.body?.message);
    const secret = clean(req.body?.secret);
    if (!announceSecret || secret !== announceSecret) {
      res.status(403).json({ ok: false, message: "密码不正确" });
      return;
    }
    if (!message) {
      res.status(400).json({ ok: false, message: "公告不能为空" });
      return;
    }

    const savedChatId = (await db.ref("dealer-card-tracker/settings/telegramChatId").get()).val();
    const targetChatId = announceChatId || savedChatId;
    if (!targetChatId) {
      res.status(400).json({ ok: false, message: "机器人还没有记录群聊，请先在群里发一条消息" });
      return;
    }

    await sendTelegramMessage(targetChatId, `公告\n\n${message}`);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: "发送失败，请查看 Render Logs" });
  }
});

app.post("/trackingmore-webhook", async (req, res) => {
  try {
    const result = await notifyTrackingUpdate(req.body || {});
    res.json({ ok: true, notified: result.notified });
  } catch (error) {
    console.error(error);
    res.status(200).json({ ok: false });
  }
});

app.get("/check-trackingmy", async (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const result = await checkTrackingMyRecords(clean(_req.query?.id));
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    res.status(200).json({ ok: false, message: error.message || "trackingmy_check_failed" });
  }
});

app.get("/record-photo", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const recordId = clean(req.query?.id);
    if (!recordId) {
      res.status(400).send("missing record id");
      return;
    }
    const snapshot = await db.ref(`dealer-card-tracker/records/${recordId}`).get();
    const record = snapshot.val() || {};
    const fileId = clean(record.packagePhotoFileId);
    if (!fileId) {
      res.status(404).send("photo not found");
      return;
    }
    const imageUrl = await telegramFileUrl(fileId);
    if (!imageUrl) {
      res.status(404).send("photo not found");
      return;
    }
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      res.status(502).send("photo fetch failed");
      return;
    }
    const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "private, max-age=300");
    res.send(bytes);
  } catch (error) {
    console.error(error);
    res.status(500).send("photo error");
  }
});

app.post("/telegram", async (req, res) => {
  const message = req.body.message
    || req.body.edited_message
    || req.body.channel_post
    || req.body.edited_channel_post;
  const messageText = message?.text || message?.caption || "";
  const chatId = message?.chat?.id;
  const senderName = telegramSenderName(message);
  const defaultWarrantyDate = telegramMessageDate(message);
  const replyMessageId = message?.reply_to_message?.message_id ? String(message.reply_to_message.message_id) : "";
  const replyText = message?.reply_to_message?.text || message?.reply_to_message?.caption || "";

  if (!chatId) {
    res.status(200).send("ignored");
    return;
  }

  try {
    await rememberTelegramChat(chatId);
    const photoFileId = telegramLargestPhotoFileId(message);
    const photoText = await readTelegramPhotoText(message);
    const verifiedOcr = photoText ? await findVerifiedOcrShipment(messageText, photoText) : null;
    const ocrShipment = verifiedOcr?.trackingResult?.ok
      ? verifiedOcr.shipment
      : (photoText ? findOcrShipmentCandidate(messageText, photoText) : null);
    const text = isFullTrackingNumber(ocrShipment?.trackingNumber)
      ? buildMergedTrackingText(messageText, ocrShipment)
      : messageText;
    if (!text) {
      res.status(200).send("ignored");
      return;
    }
    if (["设置导入群", "\/setimportgroup", "\/setimportgroup@"].some((command) => text.toLowerCase().startsWith(command.toLowerCase()))) {
      await setTelegramRoleChat("import", chatId);
      await reply(chatId, `已设置这里为资料导入群\n只有这个群会自动导入新卡资料\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (["设置开保群", "设置状态群", "\/setwarrantygroup", "\/setwarrantygroup@"].some((command) => text.toLowerCase().startsWith(command.toLowerCase()))) {
      await setTelegramRoleChat("warranty", chatId);
      await reply(chatId, `已设置这里为开保状态群\n只有这个群会处理开保、过保、弹卡、人头关、人头偷钱和炸\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (["设置通知群", "\/setnotifygroup", "\/setnotifygroup@"].some((command) => text.toLowerCase().startsWith(command.toLowerCase()))) {
      await setTelegramRoleChat("tracking", chatId);
      await reply(chatId, `已设置这里为包裹通知群\n包裹状态会发送到这里，也可在这里发送车手已签收 / 已拿\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (text === "查看群设置" || text.toLowerCase().startsWith("/grouprole")) {
      const roles = await getTelegramRoleChats();
      await reply(chatId, `这个群：${telegramRoleSummary(chatId, roles)}\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (["\u8bbe\u7f6e\u8f66\u624b\u901a\u77e5\u7fa4", "/setpickupgroup", "/setpickupgroup@"].some((command) => text.toLowerCase().startsWith(command.toLowerCase()))) {
      await setTelegramRoleChat("pickup", chatId);
      await reply(chatId, `\u5df2\u8bbe\u7f6e\u8fd9\u91cc\u4e3a\u8f66\u624b\u901a\u77e5\u7fa4\n\u8f66\u624b\u53d1 jnt1234 mbb1234 \u540e\uff0c\u4f1a\u901a\u77e5\u5230\u8fd9\u91cc\n\u7fa4 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (text.toLowerCase().startsWith("/chatid") || text === "群ID" || text === "群 ID") {
      await reply(chatId, `这个群的 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    const roles = await getTelegramRoleChats();
    if (undoWordsFromText(text) && chatMatchesRole(chatId, roles.import)) {
      const commandResult = await handleRecordCommand(text, defaultWarrantyDate, replyMessageId);
      if (commandResult.handled) {
        await reply(chatId, commandResult.message);
        res.status(200).send("ok");
        return;
      }
    }
    if (
      photoText &&
      chatMatchesRole(chatId, roles.import) &&
      !isImportMessage(text, senderName) &&
      !isPotentialImportMessage(text)
    ) {
      const trackingUpdate = await updateTrackingNumberFromOcr(messageText, photoText, photoFileId);
      if (trackingUpdate.updated) {
        await reply(chatId, `已补完整单号 ${trackingUpdate.parcelLabel}\n${trackingUpdate.cardNumber || trackingUpdate.dealerName || "-"}\n${trackingUpdate.trackingNumber}\n状态：${trackingUpdate.packageStatus || "-"}`);
        res.status(200).send("ok");
        return;
      }
      if (trackingUpdate.invalidTracking) {
        await reply(chatId, `OCR 有读到疑似单号，但 Tracking.my 查不到真实状态，已跳过保存。\n尾号：${trackingUpdate.tailNumber || "-"}`);
        res.status(200).send("ok");
        return;
      }
    }
    if (clean(text) === "\u8d44\u6599" && replyText && chatMatchesRole(chatId, roles.tracking)) {
      const detailResult = await getDriverSignedDetailsFromText(replyText);
      if (!detailResult.details.length) {
        await reply(chatId, detailResult.missing.length ? `\u627e\u4e0d\u5230\uff1a${detailResult.missing.join(", ")}` : "\u627e\u4e0d\u5230\u8fd9\u6761\u8f66\u624b\u8bb0\u5f55\u7684\u8d44\u6599");
        res.status(200).send("ok");
        return;
      }
      for (const detail of detailResult.details) {
        await reply(chatId, detail);
      }
      if (detailResult.missing.length) {
        await reply(chatId, `\u627e\u4e0d\u5230\uff1a${detailResult.missing.join(", ")}`);
      }
      res.status(200).send("ok");
      return;
    }
    if (text === "立即发送包裹通知") {
      if (!chatMatchesRole(chatId, roles.tracking)) {
        res.status(200).send("ignored");
        return;
      }
      await setTrackingNotificationChat(chatId);
      const result = await checkTrackingMyRecords("", { sendSummary: true });
      await reply(chatId, result.summarySent ? "已发送今天的包裹通知" : "目前没有可以发送的包裹记录");
      res.status(200).send("ok");
      return;
    }
    const isDriverSignedCommand = parseDriverSignedCommands(text).length > 0;
    const commandRoleAllowed = isDriverSignedCommand
      ? chatMatchesRole(chatId, roles.tracking)
      : chatMatchesRole(chatId, roles.warranty);
    if (commandRoleAllowed) {
      const commandResult = await handleRecordCommand(text, defaultWarrantyDate, replyMessageId);
      if (commandResult.handled) {
        await reply(chatId, commandResult.message);
        for (const message of commandResult.messages || []) {
          await reply(chatId, message);
        }
        if (isDriverSignedCommand && commandResult.pickupNotice && roles.pickup && String(roles.pickup) !== String(chatId)) {
          await sendTelegramMessage(roles.pickup, commandResult.pickupNotice);
        }
        res.status(200).send("ok");
        return;
      }
    }
    if (!chatMatchesRole(chatId, roles.import)) {
      res.status(200).send("ignored");
      return;
    }
    if (!isImportMessage(text, senderName) && !isPotentialImportMessage(text)) {
      res.status(200).send("ignored");
      return;
    }
    const result = await saveTelegramRecord(text, senderName, message?.message_id, photoFileId);
    if (result.pending) {
      await reply(chatId, `已保存到待匹配资料\n卡号：${result.cardNumber || "-"}\n原因：${result.reason}`);
      res.status(200).send("ok");
      return;
    }
    const botReply = await reply(chatId, `${result.updatedExisting ? "已更新" : "已导入"} ${result.dealerName}`);
    await rememberTelegramBotReply(result.recordId, botReply.message_id);
    res.status(200).send("ok");
  } catch (error) {
    console.error(error);
    res.status(200).send("error handled");
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Telegram bot listening on ${port}`);
  ensureTelegramWebhook().catch((error) => console.error(error));
  autoExpireWarrantyRecords().catch((error) => console.error(error));
  runScheduledTrackingMyCheck().catch((error) => console.error(error));
});

setInterval(() => {
  autoExpireWarrantyRecords().catch((error) => console.error(error));
}, 60 * 60 * 1000);

setInterval(() => {
  runScheduledTrackingMyCheck().catch((error) => console.error(error));
}, 60 * 1000);
