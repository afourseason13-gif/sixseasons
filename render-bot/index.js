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

function parseDealer(text) {
  const value = pickLineValue(text, ["DEALER", "DEALER 名字", "代理"]);
  if (value) return value;
  const hashMatch = text.match(/#dealer\s+(.+)/i);
  if (hashMatch) return clean(hashMatch[1]);
  return "Telegram";
}

function parseCardNumber(text) {
  return pickLineValue(text, ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "卡号"]);
}

function detectBank(text) {
  const source = text.toUpperCase();
  const compact = source.replace(/[^A-Z0-9]/g, "");
  const tokens = source.split(/[^A-Z0-9]+/).filter(Boolean);
  const hasToken = (...items) => items.some((item) => tokens.includes(item));
  if (source.includes("BANK ISLAM") || compact.includes("BANKISLAM") || source.includes("ISLAM")) return "BANK ISLAM";
  if (source.includes("MUAMALAT") || hasToken("MUA")) return "MUAMALAT";
  if (source.includes("RAKYAT") || hasToken("RYT", "RKT")) return "RAKYAT";
  if (source.includes("AMBANK") || source.includes("AM BANK") || compact.includes("AMBANK") || hasToken("AM")) return "AMBANK";
  if (source.includes("ALLIANCE") || hasToken("ALL")) return "ALLIANCE";
  for (const bank of ["MBB", "CIMB", "AFFIN", "AGRO", "RHB", "HLB", "BSN"]) {
    if (source.includes(bank)) return bank;
  }
  return "";
}

function lastFour(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

async function saveTelegramRecord(text) {
  const dealerName = parseDealer(text);
  const cardNumber = parseCardNumber(text);
  const now = new Date().toISOString();
  const recordRef = db.ref("dealer-card-tracker/records").push();

  await db.ref(`dealer-card-tracker/dealers/${encodeURIComponent(dealerName)}`).update({
    name: dealerName,
    createdAt: now
  });

  await recordRef.set({
    id: recordRef.key,
    dealerName,
    customerName: pickLineValue(text, ["NAMA", "NAME"]),
    icNumber: pickLineValue(text, ["IC NO", "IC"]),
    bankName: detectBank(text),
    bankAccount: pickLineValue(text, ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]),
    cardNumber,
    atmPin: pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"]),
    formattedDetails: text,
    carrier: "其他",
    tailNumber: lastFour(cardNumber),
    warrantyDate: "",
    status: "未处理",
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
  const text = message?.text || message?.caption || "";
  const chatId = message?.chat?.id;

  if (!text || !chatId) {
    res.status(200).send("ignored");
    return;
  }

  try {
    const result = await saveTelegramRecord(text);
    await reply(chatId, `已导入 ${result.dealerName}`);
    res.status(200).send("ok");
  } catch (error) {
    console.error(error);
    if (chatId) await reply(chatId, "导入失败，请检查格式。");
    res.status(500).send("error");
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Telegram bot listening on ${port}`);
});
