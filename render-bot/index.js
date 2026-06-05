const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json({ limit: "1mb" }));

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const databaseURL = process.env.FIREBASE_DATABASE_URL;
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

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
      return {
        carrier: carrierNameFromCode(carrierCode),
        carrierCode,
        tailNumber: match[2].slice(-4)
      };
    }
  }
  return { carrier: "", carrierCode: "", tailNumber: "" };
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

function hasRejectedMark(text) {
  return /[❌✕×]/.test(text);
}

function parseBulkRecordCommands(text) {
  const warrantyDate = parseCommandDate(text);
  if (!warrantyDate || !/(开保|保\d*)/.test(text)) return [];

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
        status: hasRejectedMark(line) ? "炸" : "开保",
        cardToken,
        warrantyDate
      });
    }
  }
  return commands;
}

function parseRecordCommand(text) {
  const statuses = ["车手已签收", "未处理", "处理中", "已寄出", "已完成", "过保", "开保", "寄", "弹卡", "人头关", "炸"];
  const deleteWords = ["删除", "刪除", "撤回", "取消导入", "取消導入"];
  const status = statuses.find((item) => text.includes(item)) || (hasRejectedMark(text) ? "炸" : "");
  const shouldDelete = deleteWords.some((item) => text.includes(item));
  if (!status && !shouldDelete) return null;

  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cardMatch = compact.match(/([A-Z]{2,12}\d{4}|\d{4})/);
  if (!cardMatch) return null;

  return {
    action: shouldDelete ? "delete" : "status",
    status,
    cardToken: cardMatch[1],
    warrantyDate: parseCommandDate(text)
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

  await db.ref(`dealer-card-tracker/records/${record.key}`).update(updateData);
  return {
    ok: true,
    cardNumber: record.cardNumber || command.cardToken,
    status: command.status,
    warrantyDate: updateData.warrantyDate || ""
  };
}

async function handleRecordCommand(text) {
  const bulkCommands = parseBulkRecordCommands(text);
  if (bulkCommands.length) {
    const results = [];
    for (const command of bulkCommands) {
      results.push(await applyRecordCommand(command));
    }
    const opened = results.filter((item) => item.ok && item.status === "开保").length;
    const rejected = results.filter((item) => item.ok && item.status === "炸").length;
    const missing = results.filter((item) => !item.ok).map((item) => item.cardToken);
    const missingText = missing.length ? `\n找不到：${missing.join(", ")}` : "";
    return {
      handled: true,
      message: `批量更新完成：开保${opened}，炸${rejected}${missingText}`
    };
  }

  const command = parseRecordCommand(text);
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

  await recordRef.set({
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
    tailNumber: shipment.tailNumber,
    warrantyDate: "",
    status: "寄",
    notes: "Telegram 自动导入",
    updatedAt: now,
    createdAt: now
  });

  return { dealerName, recordId: recordRef.key };
}

async function reply(chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

app.get("/", (_req, res) => {
  res.send("Dealer Telegram bot is running.");
});

app.post("/telegram", async (req, res) => {
  const message = req.body.message || req.body.edited_message;
  const messageText = message?.text || message?.caption || "";
  const chatId = message?.chat?.id;
  const senderName = telegramSenderName(message);

  if (!chatId) {
    res.status(200).send("ignored");
    return;
  }

  try {
    const text = messageText;
    if (!text) {
      res.status(200).send("ignored");
      return;
    }
    const commandResult = await handleRecordCommand(text);
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
});
