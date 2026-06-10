const express = require("express");
const admin = require("firebase-admin");

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

function firebaseKey(value) {
  return encodeURIComponent(clean(value)).replace(/[.#$\[\]]/g, "_");
}

function pickLineValue(text, labels) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.replace(/\*/g, "").trim();
    const match = cleaned.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!match) continue;
    const label = match[1].trim().toUpperCase();
    const value = match[2].trim();
    if (labels.some((item) => label === item || label.includes(item))) return value;
  }
  return "";
}

function telegramSenderName(message) {
  const from = message?.from || {};
  const fullName = [from.first_name, from.last_name].map(clean).filter(Boolean).join(" ");
  return clean(fullName || from.username || "");
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

  const importantFields = [
    pickLineValue(text, ["NAMA", "NAME"]),
    pickLineValue(text, ["IC NO", "IC"]),
    pickLineValue(text, ["BANK", "NAMA BANK"]),
    pickLineValue(text, ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]),
    pickLineValue(text, ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "卡号"]),
    pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"])
  ].filter(Boolean);

  return Boolean(dealer || clean(fallbackName)) && importantFields.length >= 2;
}

function parseShipmentCode(text) {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  for (const line of lines) {
    if (/^(DEALER|NAME|NAMA|IC|BANK|NO AKAUN|NO KAD|PIN|\*)/i.test(line)) continue;
    if (line.includes(":") || line.includes("：") || /^-+$/.test(line)) continue;
    const compact = line.replace(/[^A-Za-z0-9&]/g, "").toUpperCase();
    const match = compact.match(/^([A-Z&]+)(\d{3,})$/);
    if (match) {
      const carrierCode = normalizeCarrierCode(match[1]);
      const trackingNumber = compact;
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

function hasRejectedMark(text) {
  return /[❌✕×]/.test(text);
}

function problemStatusFromText(text) {
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

function undoWordsFromText(text) {
  return ["撤销导入", "撤銷導入", "取消导入", "取消導入"].some((item) => text.includes(item));
}

function parseRecordCommand(text, defaultWarrantyDate = "", replyMessageId = "") {
  const statuses = ["车手已签收", "未处理", "处理中", "已寄出", "已完成", "过保", "开保", "寄", "弹卡", "人头关", "炸"];
  const latestUndoWords = ["撤销导入", "撤銷導入", "取消导入", "取消導入"];
  const deleteWords = ["删除", "刪除", "撤回", "撤销", "撤銷", ...latestUndoWords];
  const status = statuses.find((item) => text.includes(item)) || problemStatusFromText(text);
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

async function findLatestRecordByCard(cardToken) {
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {})
    .map(([key, record]) => ({ key, ...record }))
    .filter((record) => recordMatchesCard(record, cardToken))
    .sort((a, b) => clean(b.createdAt || b.updatedAt).localeCompare(clean(a.createdAt || a.updatedAt)));
  return records[0] || null;
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

  const record = await findLatestRecordByCard(command.cardToken);
  if (!record) {
    return { ok: false, cardToken: command.cardToken, message: `找不到卡号 ${command.cardToken}` };
  }

  if (command.action === "delete") {
    await db.ref(`dealer-card-tracker/records/${record.key}`).remove();
    return { ok: true, cardNumber: record.cardNumber || command.cardToken, status: "删除" };
  }

  const updateData = {
    status: command.status,
    updatedAt: new Date().toISOString()
  };
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
  const bulkCommands = parseBulkRecordCommands(text, defaultWarrantyDate);
  if (bulkCommands.length) {
    const results = [];
    for (const command of bulkCommands) {
      results.push(await applyRecordCommand(command));
    }
    const opened = results.filter((item) => item.ok && item.status === "开保").length;
    const bounced = results.filter((item) => item.ok && item.status === "弹卡").length;
    const closed = results.filter((item) => item.ok && item.status === "人头关").length;
    const rejected = results.filter((item) => item.ok && item.status === "炸").length;
    const missing = results.filter((item) => !item.ok).map((item) => item.cardToken);
    const missingText = missing.length ? `\n找不到：${missing.join(", ")}` : "";
    return {
      handled: true,
      message: `批量更新完成：开保${opened}，弹卡${bounced}，人头关${closed}，炸${rejected}${missingText}`
    };
  }

  const command = parseRecordCommand(text, defaultWarrantyDate, replyMessageId);
  if (!command) return { handled: false };

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

async function saveTelegramRecord(text, fallbackDealerName = "", telegramMessageId = "") {
  const dealerName = await resolveDealerName(parseDealer(text, fallbackDealerName));
  const rawCardNumber = parseCardNumber(text);
  const bankName = detectBank(text);
  const shipment = parseShipmentCode(text);
  const cardNumber = displayCardNumber(text, bankName);
  const now = new Date().toISOString();
  const recordRef = db.ref("dealer-card-tracker/records").push();

  await db.ref(`dealer-card-tracker/dealers/${firebaseKey(dealerName)}`).update({
    name: dealerName,
    createdAt: now
  });

  const recordData = {
    id: recordRef.key,
    dealerName,
    customerName: pickLineValue(text, ["NAMA", "NAME"]),
    icNumber: pickLineValue(text, ["IC NO", "IC"]),
    bankName,
    bankAccount: pickLineValue(text, ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]),
    cardNumber,
    atmPin: pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"]),
    formattedDetails: text,
    carrier: shipment.carrier || detectCarrier(text, shipment.carrierCode),
    trackingNumber: isFullTrackingNumber(shipment.trackingNumber) ? shipment.trackingNumber : "",
    trackingMoreCourierCode: trackingMoreCourierCode(shipment.carrierCode),
    tailNumber: shipment.tailNumber,
    warrantyDate: "",
    status: "寄",
    notes: "Telegram 自动导入",
    telegramMessageId: String(telegramMessageId || ""),
    updatedAt: now,
    createdAt: now
  };

  await recordRef.set(recordData);
  await registerTrackingMore(recordData);

  return { dealerName, recordId: recordRef.key };
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
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const body = await response.json().catch(() => ({}));
  return body.result || {};
}

async function rememberTelegramChat(chatId) {
  await db.ref("dealer-card-tracker/settings/telegramChatId").set(String(chatId));
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
  if (source.includes("pos")) return "poslaju";
  if (source.includes("ninja")) return "ninjavan";
  if (source.includes("gdex")) return "gdex";
  if (source.includes("city")) return "citylink";
  if (source.includes("flash")) return "flash";
  if (source.includes("spx") || source.includes("shopee")) return "spx";
  if (source.includes("lazada") || source.includes("lex")) return "lazada";
  if (source.includes("skynet")) return "skynet";
  if (source.includes("abx")) return "abx";
  if (source.includes("best")) return "best";
  if (source.includes("dhl")) return "dhl";
  return "";
}

function trackingMySlugs(record) {
  const selected = trackingMySlug(record);
  const number = clean(record.trackingNumber).toUpperCase();
  const guessed = [];

  if (/^[A-Z]{2}\d{9}MY$/.test(number) || /^[A-Z]{3}\d{9,12}MY$/.test(number) || number.endsWith("MY")) {
    guessed.push("poslaju");
  }
  if (/^\d{10,15}$/.test(number) || /^6\d{9,14}$/.test(number)) {
    guessed.push("jt");
  }
  if (/^N[VJ][A-Z0-9]{8,}$/i.test(number) || number.includes("NINJA")) {
    guessed.push("ninjavan");
  }
  if (/^MY[A-Z0-9]{8,}$/i.test(number)) {
    guessed.push("spx", "lazada", "jt");
  }

  const slugs = [...new Set([selected, ...guessed].filter(Boolean))];
  return slugs.length ? slugs.slice(0, 3) : ["jt", "poslaju"];
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
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

async function fetchTrackingMyStatus(record) {
  const number = clean(record.trackingNumber);
  const slugs = trackingMySlugs(record);
  if (!number || !slugs.length) return { ok: false, reason: "missing_tracking_or_courier" };

  const encodedNumber = encodeURIComponent(number);
  const urls = slugs.flatMap((slug) => {
    const encodedSlug = encodeURIComponent(slug);
    return [`https://www.tracking.my/${encodedSlug}/${encodedNumber}`];
  });

  const trackingMyResult = await fetchStatusFromUrls(urls, "Tracking.my", number);
  if (trackingMyResult.ok) return trackingMyResult;

  const officialResult = await fetchStatusFromUrls(officialTrackingUrls(record), "\u5b98\u7f51", number);
  if (officialResult.ok) return officialResult;

  return { ok: false, reason: trackingMySlug(record) === "jt" ? "jnt_tracking_not_found" : "unable_to_parse_tracking_status" };
}

async function getTrackingChatId() {
  return announceChatId || (await db.ref("dealer-card-tracker/settings/telegramChatId").get()).val();
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

function packageStatusText(record) {
  const status = clean(record.packageStatus);
  if (status.includes("\u5df2\u9001\u8fbe") || record.lastTrackingNotifyStatus === "delivered") return "\u9001\u8fbe";
  if (status.includes("\u6d3e\u9001")) return "\u6d3e\u9001\u4e2d";
  if (status.includes("\u5f02\u5e38")) return "\u5f02\u5e38";
  if (status.includes("\u8fd0\u8f93")) return "\u8fd0\u8f93\u4e2d";
  return status || "\u672a\u68c0\u67e5";
}

function shouldIncludeTrackingSummary(record, today) {
  if (!isFullTrackingNumber(record.trackingNumber)) return false;
  if (formatDateInMalaysia(new Date(record.createdAt || record.updatedAt || Date.now())) >= today) return false;
  return !(record.packageStatus === "\u5df2\u9001\u8fbe" && record.deliveredAt && record.deliveredAt < today);
}

function buildTrackingSummaryMessage(records, today) {
  const summaryRecords = records
    .filter((record) => shouldIncludeTrackingSummary(record, today))
    .sort((a, b) => {
      return `${trackingCarrierCode(a)}${trackingTail(a)}${clean(a.cardNumber)}`.localeCompare(`${trackingCarrierCode(b)}${trackingTail(b)}${clean(b.cardNumber)}`);
    });

  if (!summaryRecords.length) return "";
  const lines = summaryRecords.map((record) => {
    return `${trackingCarrierCode(record)}(${trackingTail(record)}) ${clean(record.cardNumber || "-")} ${packageStatusText(record)}`;
  });
  return ["\u5305\u88f9\u72b6\u6001\u6c47\u603b", today, "", ...lines].join("\n");
}

async function sendTrackingSummary(records, today) {
  const chatId = await getTrackingChatId();
  if (!chatId) return false;
  const message = buildTrackingSummaryMessage(records, today);
  if (!message) return false;
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
    if (!isFullTrackingNumber(record.trackingNumber)) continue;

    if ((record.packageStatus === "\u5df2\u9001\u8fbe" || record.lastTrackingNotifyStatus === "delivered") && record.deliveredAt && record.deliveredAt < today) {
      await db.ref(`dealer-card-tracker/records/${record.key}`).remove();
      deleted += 1;
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
        trackingMyLastError: result.reason,
        trackingMyDetail: result.reason === "jnt_tracking_not_found"
          ? "Tracking.my 和 J&T 官网都暂时没有拿到真实状态，已保留原状态。"
          : (result.reason === "unable_to_parse_tracking_status" ? "Tracking.my 和官网都暂时查不到真实状态，已保留原状态。" : result.reason),
        trackingMyCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      continue;
    }

    const updateData = {
      packageStatus: result.label,
      trackingMyDetail: result.source ? `${result.source}: ${result.detail}` : result.detail,
      trackingMyUrl: result.url,
      trackingMyCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (result.status === "delivered" && !record.deliveredAt) updateData.deliveredAt = today;

    if (options.sendIndividualNotifications && record.lastTrackingNotifyStatus !== result.status && chatId) {
      const message = [
        `\u5305\u88f9${result.label}`,
        "",
        `Dealer: ${record.dealerName || "-"}`,
        `\u5361\u53f7: ${record.cardNumber || "-"}`,
        `\u5feb\u9012: ${record.carrier || "-"}`,
        `\u5355\u53f7: ${record.trackingNumber}`,
        result.source ? `来源: ${result.source}` : "",
        result.detail ? `\u72b6\u6001: ${result.detail}` : ""
      ].filter(Boolean).join("\n");
      await sendTelegramMessage(chatId, message);
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
  if (!["12:00", "13:00"].includes(time)) return;

  const slotKey = time.replace(":", "");
  const runRef = db.ref(`dealer-card-tracker/settings/trackingMySchedule/${today}/${slotKey}`);
  const alreadyRun = (await runRef.get()).val();
  if (alreadyRun) return;

  await runRef.set(new Date().toISOString());
  const result = await checkTrackingMyRecords("", { sendSummary: true });
  await db.ref("dealer-card-tracker/settings/trackingMyLastRun").set({
    ...result,
    slot: time,
    date: today,
    updatedAt: new Date().toISOString()
  });
}

app.get("/", (_req, res) => {
  res.send("Dealer Telegram bot is running.");
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

app.post("/telegram", async (req, res) => {
  const message = req.body.message || req.body.edited_message;
  const messageText = message?.text || message?.caption || "";
  const chatId = message?.chat?.id;
  const senderName = telegramSenderName(message);
  const defaultWarrantyDate = telegramMessageDate(message);
  const replyMessageId = message?.reply_to_message?.message_id ? String(message.reply_to_message.message_id) : "";

  if (!chatId) {
    res.status(200).send("ignored");
    return;
  }

  try {
    await rememberTelegramChat(chatId);
    const text = messageText;
    if (!text) {
      res.status(200).send("ignored");
      return;
    }
    const commandResult = await handleRecordCommand(text, defaultWarrantyDate, replyMessageId);
    if (commandResult.handled) {
      await reply(chatId, commandResult.message);
      res.status(200).send("ok");
      return;
    }
    if (!isImportMessage(text, senderName)) {
      res.status(200).send("ignored");
      return;
    }
    const result = await saveTelegramRecord(text, senderName, message?.message_id);
    const botReply = await reply(chatId, `已导入 ${result.dealerName}`);
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
  autoExpireWarrantyRecords().catch((error) => console.error(error));
});

setInterval(() => {
  autoExpireWarrantyRecords().catch((error) => console.error(error));
}, 60 * 60 * 1000);

setInterval(() => {
  runScheduledTrackingMyCheck().catch((error) => console.error(error));
}, 60 * 1000);
