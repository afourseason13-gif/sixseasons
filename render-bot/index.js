const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json({ limit: "1mb" }));

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

function parseRecordCommand(text, defaultWarrantyDate = "") {
  const statuses = ["车手已签收", "未处理", "处理中", "已寄出", "已完成", "过保", "开保", "寄", "弹卡", "人头关", "炸"];
  const deleteWords = ["删除", "刪除", "撤回", "取消导入", "取消導入"];
  const status = statuses.find((item) => text.includes(item)) || problemStatusFromText(text);
  const shouldDelete = deleteWords.some((item) => text.includes(item));
  if (!status && !shouldDelete) return null;

  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cardMatch = compact.match(/([A-Z]{2,12}\d{4}|\d{4})/);
  if (!cardMatch) {
    if (shouldDelete) return { action: "deleteLatestImport" };
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

async function handleRecordCommand(text, defaultWarrantyDate = "") {
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

  const command = parseRecordCommand(text, defaultWarrantyDate);
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

async function saveTelegramRecord(text, fallbackDealerName = "") {
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
    updatedAt: now,
    createdAt: now
  };

  await recordRef.set(recordData);
  await registerTrackingMore(recordData);

  return { dealerName, recordId: recordRef.key };
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
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
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

app.post("/telegram", async (req, res) => {
  const message = req.body.message || req.body.edited_message;
  const messageText = message?.text || message?.caption || "";
  const chatId = message?.chat?.id;
  const senderName = telegramSenderName(message);
  const defaultWarrantyDate = telegramMessageDate(message);

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
    const commandResult = await handleRecordCommand(text, defaultWarrantyDate);
    if (commandResult.handled) {
      await reply(chatId, commandResult.message);
      res.status(200).send("ok");
      return;
    }
    if (!isImportMessage(text, senderName)) {
      res.status(200).send("ignored");
      return;
    }
    const result = await saveTelegramRecord(text, senderName);
    await reply(chatId, `已导入 ${result.dealerName}`);
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
