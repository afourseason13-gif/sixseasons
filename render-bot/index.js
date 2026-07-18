const express = require("express");
const admin = require("firebase-admin");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const WebSocket = require("ws");
const https = require("https");
const crypto = require("crypto");

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
const gmailStockPath = "dealer-card-tracker/gmailListStock/phones";
const gmailImapUser = process.env.GMAIL_IMAP_USER || "";
const gmailImapAppPassword = process.env.GMAIL_IMAP_APP_PASSWORD || "";
const gmailImapHost = process.env.GMAIL_IMAP_HOST || "imap.gmail.com";
const gmailImapLimit = Math.max(1, Number(process.env.GMAIL_IMAP_LIMIT || 50));
const gmailListSpreadsheetId = process.env.GMAIL_LIST_SPREADSHEET_ID || "1-TchpPhupL_Dxu-RAJTF1fOsrP89W9b8unoMkUKXATg";
const gmailExportSheetName = process.env.GMAIL_LIST_SHEET_NAME || "\u5bfc\u51fa\u8bb0\u5f55";
const gmailStockSheetName = process.env.GMAIL_STOCK_SHEET_NAME || "\u5e93\u5b58\u6392\u8868";
const gmailBackendStockSheetName = process.env.GMAIL_BACKEND_STOCK_SHEET_NAME || "\u540e\u53f0\u5e93\u5b58";

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

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));
}

function firstClean(...values) {
  return values.map(clean).find(Boolean) || "";
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlBuffer(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function googleAccessToken(scope) {
  const serviceAccount = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: serviceAccount.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(serviceAccount.private_key);
  const assertion = `${unsigned}.${base64UrlBuffer(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }).toString()
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`google_token_failed:${body.error_description || body.error || response.status}`);
  }
  return body.access_token;
}

async function googleSheetsApi(path, options = {}) {
  const token = await googleAccessToken("https://www.googleapis.com/auth/spreadsheets");
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`google_sheets_failed:${body?.error?.message || response.status}`);
  }
  return body;
}

function sheetColumnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function todayListDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "numeric",
    year: "numeric"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${Number(map.day)}/${Number(map.month)}/${map.year}`;
}

function normalizePhoneList(values) {
  const phones = Array.isArray(values) ? values : [];
  return [...new Set(phones
    .map((value) => String(value || "").replace(/\D/g, ""))
    .filter((value) => value.length >= 9 && value.length <= 13))];
}

function extractPhonesFromRows(rows, startRowIndex = 0) {
  return normalizePhoneList((rows || [])
    .slice(startRowIndex)
    .flatMap((row) => row || []));
}

function extractStockLeadsFromRows(rows) {
  const leads = [];
  const seen = new Set();
  const tableRows = rows || [];
  for (let rowIndex = 1; rowIndex < tableRows.length; rowIndex += 1) {
    const row = tableRows[rowIndex] || [];
    const tablePhone = normalizePhoneList([row[2]])[0];
    if (tablePhone) {
      if (!seen.has(tablePhone)) {
        seen.add(tablePhone);
        leads.push({
          date: clean(row[0]) || todayListDate(),
          name: clean(row[1]) || "gmail",
          phone: tablePhone,
          source: clean(row[3]) || gmailStockSheetName,
          importedAt: clean(row[4]) || new Date().toISOString()
        });
      }
      continue;
    }

    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const phone = normalizePhoneList([row[columnIndex]])[0];
      if (!phone || seen.has(phone)) continue;
      const previousRow = tableRows[rowIndex - 1] || [];
      const nextRow = tableRows[rowIndex + 1] || [];
      const previousText = clean(previousRow[columnIndex]);
      const nextText = clean(nextRow[columnIndex]);
      const name = previousText && !normalizePhoneList([previousText])[0]
        ? previousText
        : (nextText && !normalizePhoneList([nextText])[0] ? nextText : "gmail");
      seen.add(phone);
      leads.push({
        date: todayListDate(),
        name,
        phone,
        source: gmailStockSheetName,
        importedAt: new Date().toISOString()
      });
    }
  }
  return leads;
}

function parseGmailLeadText(text, source = "gmail") {
  const sourceText = String(text || "").replace(/\r/g, "\n");
  const lines = sourceText
    .split(/\n+/)
    .map((line) => clean(line.replace(/\s+/g, " ")))
    .filter(Boolean);
  const leads = [];
  const seen = new Set();

  const addLead = (phone, name, rawText = "") => {
    const normalizedPhone = normalizePhoneList([phone])[0];
    if (!normalizedPhone || seen.has(normalizedPhone)) return;
    seen.add(normalizedPhone);
    leads.push({
      date: todayListDate(),
      name: clean(name) || "gmail",
      phone: normalizedPhone,
      source,
      importedAt: new Date().toISOString(),
      rawText: clean(rawText).slice(0, 500)
    });
  };

  lines.forEach((line, index) => {
    const phones = normalizePhoneList([line]);
    phones.forEach((phone) => {
      let name = "";
      for (let back = index - 1; back >= Math.max(0, index - 3); back -= 1) {
        const candidate = lines[back];
        if (!normalizePhoneList([candidate])[0] && /[a-zA-Z]/.test(candidate)) {
          name = candidate;
          break;
        }
      }
      if (!name) {
        const beforePhone = line.split(phone.replace(/^60/, "0"))[0] || line.split(phone)[0] || "";
        name = clean(beforePhone.replace(/[^\p{L}\s.'-]/gu, " "));
      }
      addLead(phone, name, line);
    });
  });

  const inlineMatches = sourceText.match(/(?:\+?60|0)?1[\d\s-]{7,13}\d/g) || [];
  inlineMatches.forEach((phone) => {
    const index = sourceText.indexOf(phone);
    const before = sourceText.slice(Math.max(0, index - 80), index);
    const nameMatch = before.match(/([A-Za-z][A-Za-z\s.'-]{1,60})\s*$/);
    addLead(phone, nameMatch ? nameMatch[1] : "gmail", sourceText.slice(Math.max(0, index - 120), index + 30));
  });

  return leads;
}

async function appendGmailStockRows(leads) {
  const rows = (leads || []).map((lead) => [
    lead.date || todayListDate(),
    lead.name || "gmail",
    normalizeLeadPhone ? normalizeLeadPhone(lead.phone) : normalizePhoneList([lead.phone])[0],
    lead.source || "gmail",
    lead.importedAt || new Date().toISOString(),
    "\u672a\u9886\u53d6"
  ]).filter((row) => row[2]);
  if (!rows.length) return { appended: 0 };
  const appendRange = encodeURIComponent(gmailStockSheetName) + "!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
  await googleSheetsApi(gmailListSpreadsheetId + "/values/" + appendRange, { method: "POST", body: JSON.stringify({ values: rows }) });
  return { appended: rows.length };
}

async function saveGmailLeads(leads) {
  const stockSnap = await db.ref(gmailStockPath).get();
  const current = stockSnap.val() || {};
  const updates = {};
  const newLeads = [];
  const now = new Date().toISOString();
  (leads || []).forEach((lead) => {
    const phone = normalizePhoneList([lead.phone])[0];
    if (!phone) return;
    const key = firebaseKey(phone);
    if (current[key] || updates[`${gmailStockPath}/${key}`]) return;
    const saved = {
      phone,
      name: clean(lead.name) || "gmail",
      source: clean(lead.source) || "gmail",
      stockDate: clean(lead.date) || todayListDate(),
      importedAt: clean(lead.importedAt) || now,
      syncedAt: now,
      exportedAt: "",
      exportedDealer: "",
      rawText: clean(lead.rawText).slice(0, 500)
    };
    updates[`${gmailStockPath}/${key}`] = saved;
    newLeads.push(saved);
  });
  if (Object.keys(updates).length) {
    await db.ref().update(updates);
    await appendGmailStockRows(newLeads);
  }
  return { imported: newLeads.length, leads: newLeads };
}


function normalizeLeadPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("6001") && digits.length >= 12) digits = "60" + digits.slice(3);
  if (digits.startsWith("60") && digits.length >= 10 && digits.length <= 12 && digits[2] === "1") return digits;
  if (digits.startsWith("0") && digits.length >= 10 && digits.length <= 11 && digits[1] === "1") return "6" + digits;
  if (digits.startsWith("1") && digits.length >= 9 && digits.length <= 10) return "60" + digits;
  return "";
}

function extractLeadPhones(value) {
  const source = String(value || "");
  const matches = source.match(/(?:\+?60|0)?1[\d\s().-]{7,15}\d/g) || [];
  return [...new Set(matches.map(normalizeLeadPhone).filter(Boolean))];
}


function parseGmailLeadTextV2(text, source = "gmail") {
  const sourceText = String(text || "").replace(/\r/g, "\n");
  const lines = sourceText.split(/\n+/).map((line) => clean(line.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))).filter(Boolean);
  const leads = [];
  const seen = new Set();
  const labelValue = (labels) => {
    for (const line of lines) {
      const match = line.match(/^([^:\uFF1A]+)[:\uFF1A]\s*(.+)$/u);
      if (!match) continue;
      const label = match[1].trim().toLowerCase();
      if (labels.some((item) => label.includes(item))) return clean(match[2]);
    }
    return "";
  };
  const labeled = {
    name: labelValue(["nama", "name"]),
    phone: labelValue(["no.hubungi", "no hubungi", "telefon", "phone", "whatsapp", "contact"]),
    amount: labelValue(["jumlah pinjaman", "pinjaman", "amount"]),
    location: labelValue(["lokasi", "location", "alamat"]),
    job: labelValue(["pekerjaan", "occupation", "kerja", "job"])
  };
  const addLead = (phone, data = {}, rawText = "") => {
    const normalizedPhone = normalizeLeadPhone(phone);
    if (!normalizedPhone || seen.has(normalizedPhone)) return;
    seen.add(normalizedPhone);
    leads.push({ date: todayListDate(), name: clean(data.name) || "gmail", phone: normalizedPhone, amount: clean(data.amount), location: clean(data.location), job: clean(data.job), source, importedAt: new Date().toISOString(), rawText: clean(rawText || sourceText).slice(0, 500) });
  };
  extractLeadPhones(labeled.phone).forEach((phone) => addLead(phone, labeled, sourceText));
  lines.forEach((line, index) => {
    const phones = extractLeadPhones(line);
    phones.forEach((phone) => {
      let name = "";
      for (let back = index - 1; back >= Math.max(0, index - 3); back -= 1) {
        const candidate = lines[back];
        if (!extractLeadPhones(candidate).length && /[a-zA-Z]/.test(candidate)) { name = candidate; break; }
      }
      if (!name) {
        const localPhone = phone.replace(/^60/, "0");
        const beforePhone = line.split(localPhone)[0] || line.split(phone)[0] || "";
        name = clean(beforePhone.replace(/[^\p{L}\s.'-]/gu, " "));
      }
      const nextLines = lines.slice(index + 1, index + 5);
      const amount = labeled.amount || nextLines.find((item) => /\b\d+\s*k\b/i.test(item) || /^\d{3,6}$/.test(item)) || "";
      const location = labeled.location || nextLines.find((item) => !extractLeadPhones(item).length && /[a-zA-Z]/.test(item) && item !== amount) || "";
      const job = labeled.job || nextLines.find((item) => !extractLeadPhones(item).length && /[a-zA-Z]/.test(item) && item !== amount && item !== location) || "";
      addLead(phone, { name: labeled.name || name, amount, location, job }, line);
    });
  });
  return leads;
}

async function appendGmailStockRowsV2(leads) {
  const rows = (leads || []).map((lead) => [lead.date || todayListDate(), lead.name || "gmail", normalizeLeadPhone(lead.phone), lead.amount || "", lead.location || "", lead.job || "", lead.source || "gmail", lead.importedAt || new Date().toISOString(), "\u672a\u9886\u53d6", "", ""]).filter((row) => row[2]);
  if (!rows.length) return { appended: 0 };
  const appendRange = encodeURIComponent(gmailStockSheetName) + "!A:K:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
  await googleSheetsApi(gmailListSpreadsheetId + "/values/" + appendRange, { method: "POST", body: JSON.stringify({ values: rows }) });
  return { appended: rows.length };
}

async function readGmailStockSheetPhones() {
  const readRange = encodeURIComponent(gmailStockSheetName) + "!A1:K2000";
  const read = await googleSheetsApi(gmailListSpreadsheetId + "/values/" + readRange);
  const rows = read.values || [];
  return new Set(rows.slice(1).map((row) => normalizeLeadPhone((row || [])[2])).filter(Boolean));
}

async function saveGmailLeadsV2(leads) {
  const stockSnap = await db.ref(gmailStockPath).get();
  const current = stockSnap.val() || {};
  const existingSheetPhones = await readGmailStockSheetPhones().catch(() => new Set());
  const updates = {};
  const newLeads = [];
  const appendLeads = [];
  const now = new Date().toISOString();
  (leads || []).forEach((lead) => {
    const phone = normalizeLeadPhone(lead.phone);
    if (!phone) return;
    const key = firebaseKey(phone);
    if (current[key] || updates[gmailStockPath + "/" + key]) return;
    const saved = { phone, name: clean(lead.name) || "gmail", amount: clean(lead.amount), location: clean(lead.location), job: clean(lead.job), source: clean(lead.source) || "gmail", stockDate: clean(lead.date) || todayListDate(), importedAt: clean(lead.importedAt) || now, syncedAt: now, exportedAt: "", exportedDealer: "", rawText: clean(lead.rawText).slice(0, 500) };
    updates[gmailStockPath + "/" + key] = saved;
    newLeads.push(saved);
    if (!existingSheetPhones.has(phone)) {
      existingSheetPhones.add(phone);
      appendLeads.push(saved);
    }
  });
  if (Object.keys(updates).length) {
    await db.ref().update(updates);
    await appendGmailStockRowsV2(appendLeads);
  }
  return { imported: newLeads.length, leads: newLeads };
}

async function markGmailStockRowsClaimed(phones, dealer) {
  const selected = new Set((phones || []).map(normalizeLeadPhone).filter(Boolean));
  if (!selected.size) return { marked: 0 };
  const readRange = encodeURIComponent(gmailStockSheetName) + "!A1:K1000";
  const read = await googleSheetsApi(gmailListSpreadsheetId + "/values/" + readRange);
  const rows = read.values || [];
  let marked = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const phone = normalizeLeadPhone((rows[index] || [])[2]);
    if (!phone || !selected.has(phone)) continue;
    const status = clean((rows[index] || [])[8]);
    if (status === "\u5df2\u62ff") continue;
    const rowNumber = index + 1;
    const writeRange = encodeURIComponent(gmailStockSheetName) + "!I" + rowNumber + ":K" + rowNumber;
    await googleSheetsApi(gmailListSpreadsheetId + "/values/" + writeRange + "?valueInputOption=USER_ENTERED", { method: "PUT", body: JSON.stringify({ range: gmailStockSheetName + "!I" + rowNumber + ":K" + rowNumber, majorDimension: "ROWS", values: [["\u5df2\u62ff", clean(dealer), new Date().toISOString()]] }) });
    marked += 1;
  }
  return { marked };
}

function gmailAccounts() {
  if (process.env.GMAIL_IMAP_ACCOUNTS) {
    try {
      const parsed = JSON.parse(process.env.GMAIL_IMAP_ACCOUNTS);
      return Array.isArray(parsed) ? parsed.filter((item) => item?.user && (item.appPassword || item.password)) : [];
    } catch (error) {
      console.error("Invalid GMAIL_IMAP_ACCOUNTS JSON", error);
    }
  }
  if (!gmailImapUser || !gmailImapAppPassword) return [];
  return [{ user: gmailImapUser, appPassword: gmailImapAppPassword, host: gmailImapHost }];
}

function formatImapError(error) {
  const parts = [
    error?.message,
    error?.code,
    error?.response,
    error?.serverResponse,
    error?.status,
    error?.authenticationFailed ? "authentication_failed" : ""
  ].map((value) => clean(value)).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(" | ") : String(error || "unknown_imap_error");
}

async function syncUnreadGmailLists() {
  const accounts = gmailAccounts();
  if (!accounts.length) {
    return { ok: false, message: "missing_gmail_imap_config", imported: 0, checked: 0 };
  }
  let imported = 0;
  let checked = 0;
  const errors = [];

  for (const account of accounts) {
    const client = new ImapFlow({
      host: account.host || gmailImapHost,
      port: Number(account.port || 993),
      secure: true,
      auth: {
        user: account.user,
        pass: account.appPassword || account.password
      },
      logger: false
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const unseen = await client.search({ seen: false });
        const targets = unseen.slice(-gmailImapLimit);
        for (const uid of targets) {
          const message = await client.fetchOne(uid, { source: true, envelope: true });
          checked += 1;
          const parsed = await simpleParser(message.source);
          const text = [
            parsed.subject || message.envelope?.subject || "",
            parsed.text || "",
            parsed.html ? String(parsed.html).replace(/<[^>]+>/g, "\n") : ""
          ].join("\n");
          const leads = parseGmailLeadTextV2(text, account.user);
          const saved = await saveGmailLeadsV2(leads);
          imported += saved.imported;
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (error) {
      errors.push(`${account.user}:${formatImapError(error)}`);
      console.error("Gmail IMAP sync failed", {
        user: account.user,
        message: error?.message,
        code: error?.code,
        response: error?.response,
        serverResponse: error?.serverResponse,
        status: error?.status,
        authenticationFailed: error?.authenticationFailed
      });
      try {
        await client.logout();
      } catch (_) {
        // ignore logout errors
      }
    }
  }
  return { ok: !errors.length, imported, checked, errors };
}

function singaporeDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function findListExportSlot(rows, dateText, dealerName) {
  const dateRow = rows[0] || [];
  const dealerRow = rows[1] || [];
  const usedWidth = Math.max(dateRow.length, dealerRow.length);
  let dateStart = dateRow.findIndex((value) => clean(value) === dateText);
  if (dateStart < 0) {
    return {
      columnIndex: Math.max(usedWidth + (usedWidth ? 1 : 0), 0),
      startRowIndex: 0,
      sequence: 1,
      appendExisting: false,
      isNewDate: true
    };
  }

  let nextDate = dateRow.length;
  for (let index = dateStart + 1; index < dateRow.length; index += 1) {
    if (clean(dateRow[index])) {
      nextDate = index;
      break;
    }
  }

  const normalizedDealer = clean(dealerName).toLowerCase();
  for (let index = dateStart; index < nextDate; index += 1) {
    if (clean(dealerRow[index]).toLowerCase() !== normalizedDealer) continue;
    let lastDataRow = 2;
    for (let rowIndex = 3; rowIndex < rows.length; rowIndex += 1) {
      if (clean((rows[rowIndex] || [])[index])) lastDataRow = rowIndex;
    }
    const sequence = Number(clean((rows[2] || [])[index])) || (dealerRow.slice(dateStart, index + 1).filter((value) => clean(value)).length || 1);
    return {
      columnIndex: index,
      startRowIndex: lastDataRow + 1,
      sequence,
      appendExisting: true,
      isNewDate: false
    };
  }

  for (let index = dateStart; index < nextDate; index += 1) {
    if (!clean(dealerRow[index])) {
      const usedBefore = dealerRow.slice(dateStart, index).filter((value) => clean(value)).length;
      return { columnIndex: index, startRowIndex: 0, sequence: usedBefore + 1, appendExisting: false, isNewDate: false };
    }
  }

  const usedBefore = dealerRow.slice(dateStart, nextDate).filter((value) => clean(value)).length;
  return {
    columnIndex: nextDate >= usedWidth ? usedWidth + 1 : nextDate,
    startRowIndex: 0,
    sequence: usedBefore + 1,
    appendExisting: false,
    isNewDate: nextDate >= usedWidth
  };
}

async function exportGmailListToSheet({ dealer, phones }) {
  const selected = normalizePhoneList(phones);
  if (!clean(dealer)) throw new Error("missing_dealer");
  if (!selected.length) throw new Error("missing_phones");
  const dateText = todayListDate();
  const readRange = `${encodeURIComponent(gmailExportSheetName)}!A1:AZ300`;
  const read = await googleSheetsApi(`${gmailListSpreadsheetId}/values/${readRange}`);
  const rows = read.values || [];
  const target = findListExportSlot(rows, dateText, dealer);
  const column = sheetColumnName(target.columnIndex);
  const values = target.appendExisting
    ? selected.map((phone) => [phone])
    : [[dateText], [clean(dealer)], [String(target.sequence)], ...selected.map((phone) => [phone])];
  const startRow = target.startRowIndex + 1;
  const endRow = target.startRowIndex + values.length;
  const writeRange = `${encodeURIComponent(gmailExportSheetName)}!${column}${startRow}:${column}${endRow}`;
  await googleSheetsApi(`${gmailListSpreadsheetId}/values/${writeRange}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ range: `${gmailExportSheetName}!${column}${startRow}:${column}${endRow}`, majorDimension: "ROWS", values })
  });
  return {
    date: dateText,
    dealer: clean(dealer),
    count: selected.length,
    column,
    sequence: target.sequence,
    appended: target.appendExisting,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${gmailListSpreadsheetId}/edit#gid=333333002`
  };
}

async function getGmailListStock() {
  const now = new Date().toISOString();
  const stockSnap = await db.ref(gmailStockPath).get();
  const rawStock = stockSnap.val() || {};
  const cleanup = {};
  const records = [];
  Object.entries(rawStock).forEach(([key, item]) => {
    const phone = normalizeLeadPhone(item && item.phone);
    if (!item || !phone) { cleanup[gmailStockPath + "/" + key] = null; return; }
    records.push({ ...item, key, phone });
  });
  if (Object.keys(cleanup).length) await db.ref().update(cleanup);
  records.sort((a, b) => clean(a.importedAt).localeCompare(clean(b.importedAt)) || clean(a.phone).localeCompare(clean(b.phone)));
  const today = singaporeDateKey();
  const availableRecords = records.filter((item) => !item.exportedAt);
  const exportedRecords = records.filter((item) => item.exportedAt);
  const todayAdded = records.filter((item) => singaporeDateKey(new Date(item.importedAt || item.syncedAt || now)) === today).length;
  const todayTakenRecords = exportedRecords.filter((item) => singaporeDateKey(new Date(item.exportedAt)) === today);
  const dealerTaken = todayTakenRecords.reduce((acc, item) => { const dealer = clean(item.exportedDealer) || "-"; acc[dealer] = (acc[dealer] || 0) + 1; return acc; }, {});
  return { total: records.length, exported: exportedRecords.length, available: availableRecords.map((item) => item.phone), availableRecords, count: availableRecords.length, todayAdded, todayTaken: todayTakenRecords.length, dealerTaken, dealerTakenList: Object.entries(dealerTaken).map(([dealer, count]) => ({ dealer, count })), imported: 0, checkedAt: now, cleaned: Object.keys(cleanup).length };
}

async function takeGmailListStock({ dealer, count }) {
  const requested = Math.max(1, Number(count || 0));
  if (!clean(dealer)) throw new Error("missing_dealer");
  const stock = await getGmailListStock();
  const selectedRecords = stock.availableRecords.slice(0, requested);
  const selected = selectedRecords.map((item) => item.phone);
  if (!selected.length) throw new Error("stock_empty");
  const exported = await exportGmailListToSheet({ dealer, phones: selected });
  const exportedAt = new Date().toISOString();
  const updates = {};
  selectedRecords.forEach((record) => {
    const key = record.key || firebaseKey(record.phone);
    updates[gmailStockPath + "/" + key + "/exportedAt"] = exportedAt;
    updates[gmailStockPath + "/" + key + "/exportedDealer"] = clean(dealer);
    updates[gmailStockPath + "/" + key + "/exportDate"] = todayListDate();
  });
  await db.ref().update(updates);
  await markGmailStockRowsClaimed(selected, dealer);
  const dealerTaken = { ...(stock.dealerTaken || {}) };
  dealerTaken[clean(dealer)] = (dealerTaken[clean(dealer)] || 0) + selected.length;
  return { ...exported, requested, phones: selected, remaining: Math.max(0, stock.count - selected.length), stockBefore: stock.count, todayTaken: stock.todayTaken + selected.length, todayAdded: stock.todayAdded, dealerTaken, dealerTakenList: Object.entries(dealerTaken).map(([name, total]) => ({ dealer: name, count: total })) };
}

async function writeGmailBackendStockSheet(stock, sync = {}) {
  const now = new Date();
  const checkedText = now.toLocaleString("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const statusText = sync.message === "missing_gmail_imap_config"
    ? "\u672a\u8bbe\u7f6e Gmail"
    : sync.errors?.length
      ? "\u540c\u6b65\u6709\u9519\u8bef"
      : "\u6b63\u5e38";
  const rows = [
    ["\u9879\u76ee", "\u6570\u91cf", "\u8bf4\u660e", "\u6700\u540e\u68c0\u6d4b", "\u9891\u7387"],
    ["\u5e93\u5b58\u53f7\u7801", Number(stock.total || 0), "\u540e\u53f0\u603b\u53f7\u7801\uff0c\u5305\u542b\u5df2\u9886\u53d6", checkedText, "10\u5206\u949f"],
    ["\u5df2\u5bfc\u51fa", Number(stock.exported || 0), "\u5df2\u9886\u53d6\u5e76\u5199\u5165\u5bfc\u51fa\u8bb0\u5f55", checkedText, "-"],
    ["\u5269\u4f59\u5e93\u5b58", Number(stock.count || 0), "\u624b\u673a List \u53ef\u9886\u53d6\u6570\u91cf", checkedText, "-"],
    ["\u4eca\u65e5\u65b0\u589e", Number(stock.todayAdded || 0), "\u4eca\u5929 Gmail \u5bfc\u5165\u7684\u53f7\u7801", checkedText, "-"],
    ["\u4eca\u65e5\u5df2\u62ff", Number(stock.todayTaken || 0), "\u4eca\u5929\u5df2\u5206\u914d\u7ed9 Dealer", checkedText, "-"],
    ["\u72b6\u6001", statusText, sync.imported ? `\u521a\u540c\u6b65 ${sync.imported} \u6761` : "\u65e0\u65b0\u90ae\u4ef6", checkedText, "-"]
  ];
  const writeRange = encodeURIComponent(gmailBackendStockSheetName) + "!A1:E7?valueInputOption=USER_ENTERED";
  await googleSheetsApi(gmailListSpreadsheetId + "/values/" + writeRange, {
    method: "PUT",
    body: JSON.stringify({
      range: gmailBackendStockSheetName + "!A1:E7",
      majorDimension: "ROWS",
      values: rows
    })
  });
  return {
    sheetName: gmailBackendStockSheetName,
    status: statusText,
    lastChecked: checkedText
  };
}


function pickLineValue(text, labels) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const cleaned = lines[index].replace(/\*/g, "").trim();
    const match = cleaned.match(/^([^:\uFF1A]+)[:\uFF1A]\s*(.*)$/u);
    if (!match) continue;
    const label = match[1].trim().toUpperCase();
    if (!labels.some((item) => label === item || label.includes(item))) continue;
    const value = match[2].trim();
    if (value) return value;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextValue = lines[nextIndex].replace(/\*/g, "").trim();
      if (!nextValue || /^-+$/.test(nextValue)) continue;
      if (/^[^:\uFF1A]+[:\uFF1A]/u.test(nextValue)) break;
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
  const value = pickLineValue(text, ["DEALER", "DEALER NAME"]);
  if (value) return value;
  const hashMatch = String(text || "").match(/#dealer\s+(.+)/i);
  if (hashMatch) return clean(hashMatch[1]);
  const firstLine = clean(String(text || "").split(/\r?\n/).find(Boolean));
  if (/^dealer\s+/i.test(firstLine)) return clean(firstLine.replace(/^dealer\s+/i, "Dealer "));
  return clean(fallbackName) || "Telegram";
}


function isImportMessage(text, fallbackName = "") {
  const dealer = pickLineValue(text, ["DEALER", "DEALER NAME"]) || String(text || "").match(/#dealer\s+(.+)/i);
  const fields = {
    name: pickLineValue(text, ["NAMA", "NAME"]),
    ic: pickLineValue(text, ["IC NO", "IC"]),
    bank: pickLineValue(text, ["BANK", "NAMA BANK"]),
    account: pickLineValue(text, ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]),
    card: pickLineValue(text, ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "CARD", "KAD"]),
    pin: pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"])
  };
  const filledCount = Object.values(fields).filter(Boolean).length;
  return Boolean(dealer || clean(fallbackName)) && Boolean(fields.name && fields.ic && fields.bank && fields.card) && filledCount >= 4;
}

function isPotentialImportMessage(text) {
  const structuredLabels = [
    "NAMA", "NAME", "IC NO", "BANK", "NAMA BANK", "NO AKAUN",
    "ACC. NUMBER", "NO KAD", "BANK CARD 16 DIGIT", "PIN KAD ATM", "ATM PIN"
  ];
  const matchedFields = structuredLabels.filter((label) => pickLineValue(text, [label])).length;
  const hasCardOrShipment = Boolean(parseCardNumber(text) || parseShipmentCode(text).trackingNumber);
  const upper = String(text || "").toUpperCase();
  const hasImportWords = /\b(NAMA|NAME|IC|BANK|AKAUN|ACCOUNT|ACC\.?\s*NUMBER|NO\s*KAD|CARD\s*16|PIN\s*KAD|ATM\s*PIN)\b/.test(upper);
  return matchedFields >= 2 || (matchedFields >= 1 && hasCardOrShipment) || (hasImportWords && matchedFields >= 1);
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
    if (line.includes(":") || line.includes("\uFF1A") || /^-+$/.test(line)) continue;
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

async function telegramFileUrl(fileId) {
  if (!fileId) return "";
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = await response.json().catch(() => ({}));
  const filePath = body?.result?.file_path;
  return filePath ? `https://api.telegram.org/file/bot${botToken}/${filePath}` : "";
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
  if (!result?.checked) return "CCID status: CHECK FAILED. Carian 0 kali \u26A0";
  const count = Number(result.searchCount || 0);
  if (result.reportCount > 0) return "CCID status: report " + result.reportCount + ". Carian " + count + " kali \u274C";
  return "CCID status: NO report. Carian " + count + " kali \u2705";
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

async function ensureDealer(name) {
  const dealerName = clean(name) || "Telegram";
  const key = firebaseKey(dealerName);
  const ref = db.ref(`dealer-card-tracker/dealers/${key}`);
  const snapshot = await ref.get();
  const existing = snapshot.val() || {};
  await ref.update({
    ...existing,
    name: existing.name || dealerName,
    rate: Number(existing.rate || 500),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return key;
}


function parseCardNumber(text) {
  return pickLineValue(text, ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "CARD", "KAD"]);
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

  const shortLocalMatch = text.match(/\b(\d{1,2})[-/.](\d{1,2})(?![-/.]\d)\b/);
  if (shortLocalMatch) return formatDateParts(new Date().getFullYear(), shortLocalMatch[2], shortLocalMatch[1]);

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
  const match = String(text || "").match(/(?:\u4fdd|warranty|waranti)\s*(5|7)\b|(?:^|[^\d])(5|7)\s*\u5929/i);
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
  return /[xX\u2716\u00d7]/.test(String(text || ""));
}


function problemStatusFromText(text) {
  const source = String(text || "");
  if (source.includes("\u4eba\u5934\u5077\u94b1")) return "\u4eba\u5934\u5077\u94b1";
  if (source.includes("\u8d54150") || source.includes("\u8d54 150")) return "\u8d54 150";
  if (source.includes("\u4eba\u5934\u5173") || source.includes("\u516c\u6237")) return "\u4eba\u5934\u5173";
  if (source.includes("\u5f39\u5361") || source.includes("\u5f39") || source.includes("\u5077\u94b1") || source.includes("\u6709\u95ee\u9898") || source.includes("\u95ee\u9898")) return "\u5f39\u5361";
  if (source.includes("\u70b8") || hasRejectedMark(source)) return "\u70b8";
  return "";
}


function parseBulkRecordCommands(text, defaultWarrantyDate = "") {
  const source = String(text || "");
  const warrantyDate = parseCommandDate(source) || defaultWarrantyDate;
  const warrantyDays = parseWarrantyDays(source);
  if (!warrantyDate) return [];
  const hasWarrantyMarker = /(\u5f00\u4fdd|\u4fdd\d*|\d+\s*\u5929)/.test(source);
  const hasCardList = /[A-Z]{2,12}\s*[-_.]?\s*\d{4}/i.test(source);
  if (!hasWarrantyMarker && !hasCardList) return [];
  const commands = [];
  const seen = new Set();
  for (const line of source.split(/\r?\n/)) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cardTokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    for (const cardToken of cardTokens) {
      if (seen.has(cardToken)) continue;
      seen.add(cardToken);
      commands.push({ action: "status", status: problemStatusFromText(line) || "\u5f00\u4fdd", cardToken, warrantyDate, warrantyDays });
    }
  }
  return commands;
}

function displayWarrantyNoticeDate(dateText) {
  const [year, month, day] = String(dateText || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  return `${day}/${month}`;
}

function buildWarrantyGroupNotification(text, defaultWarrantyDate = "") {
  const source = String(text || "");
  const warrantyDate = parseCommandDate(source) || defaultWarrantyDate;
  if (!warrantyDate) return "";

  const warrantyDays = parseWarrantyDays(source);
  const rows = [];
  const statusSet = new Set();
  let sectionStatus = source.match(/(\u5f00\u4fdd|\u4fdd\d*|\d+\s*\u5929)/) || parseCommandDate(source) ? "\u5f00\u4fdd" : "";
  const seen = new Set();

  for (const line of source.split(/\r?\n/)) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cardTokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    const inlineStatus = statusFromCommandLine(line);
    if (!cardTokens.length) {
      if (inlineStatus) sectionStatus = inlineStatus;
      else if (line.includes("\u5f00\u4fdd") || parseWarrantyDays(line) || parseCommandDate(line)) sectionStatus = "\u5f00\u4fdd";
      continue;
    }

    const status = inlineStatus || sectionStatus || "\u5f00\u4fdd";
    for (const cardToken of cardTokens) {
      if (seen.has(cardToken)) continue;
      seen.add(cardToken);
      if (status) statusSet.add(status);
      rows.push(status === "\u5f00\u4fdd" ? cardToken : `${cardToken} ${status}`);
    }
  }

  if (!rows.length) return "";
  const statuses = Array.from(statusSet);
  const titleStatuses = statuses.length ? statuses.join(" ") : "\u5f00\u4fdd";
  const dateLine = `${displayWarrantyNoticeDate(warrantyDate)}${warrantyDays ? ` \u4fdd${warrantyDays}` : ""}`;
  return `\u5df2\u66f4\u65b0 ${titleStatuses}\n\u8bf7\u901a\u77e5\u5220\u9664online app \uff01\uff01\uff01\n\n${dateLine}\n${rows.join("\n")}`;
}


function statusFromCommandLine(line) {
  const source = String(line || "");
  if (source.includes("\u8d54150") || source.includes("\u8d54 150")) return "\u8d54 150";
  if (source.includes("\u4eba\u5934\u5077\u94b1")) return "\u4eba\u5934\u5077\u94b1";
  if (source.includes("\u4eba\u5934\u5173") || source.includes("\u516c\u6237")) return "\u4eba\u5934\u5173";
  if (source.includes("\u5f39\u5361") || source.includes("\u5f39") || source.includes("\u5077\u94b1") || source.includes("\u6709\u95ee\u9898") || source.includes("\u95ee\u9898")) return "\u5f39\u5361";
  if (source.includes("\u70b8") || hasRejectedMark(source)) return "\u70b8";
  if (source.includes("\u8fc7\u4fdd")) return "\u8fc7\u4fdd";
  if (source.includes("\u5f00\u4fdd")) return "\u5f00\u4fdd";
  if (source.includes("\u5bc4")) return "\u5bc4";
  if (source.includes("\u8f66\u624b\u5df2\u7b7e\u6536") || source.includes("\u8f66\u624b\u5df2\u62ff") || source.includes("\u7b7e\u6536")) return "\u8f66\u624b\u5df2\u7b7e\u6536";
  return "";
}


function parseGeneralBulkRecordCommands(text, defaultWarrantyDate = "") {
  const commands = [];
  const seen = new Set();
  const source = String(text || "");
  const warrantyDate = parseCommandDate(source) || defaultWarrantyDate;
  const warrantyDays = parseWarrantyDays(source);
  let sectionStatus = "";
  for (const line of source.split(/\r?\n/)) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cardTokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    const inlineStatus = statusFromCommandLine(line);
    if (!cardTokens.length) {
      if (inlineStatus) sectionStatus = inlineStatus;
      else if (line.includes("\u5f00\u4fdd") || parseWarrantyDays(line)) sectionStatus = "\u5f00\u4fdd";
      continue;
    }
    const status = inlineStatus || sectionStatus;
    if (!status) continue;
    for (const cardToken of cardTokens) {
      if (seen.has(cardToken)) continue;
      seen.add(cardToken);
      commands.push({ action: "status", status, cardToken, warrantyDate: status === "\u5f00\u4fdd" ? warrantyDate : "", warrantyDays: status === "\u5f00\u4fdd" ? warrantyDays : 0 });
    }
  }
  return commands;
}


function parseDriverSignedCommands(text) {
  const source = String(text || "");
  const hasSignedLabel = source.includes("\u8f66\u624b\u5df2\u7b7e\u6536") || source.includes("\u8f66\u624b\u5df2\u62ff");
  const courierCodes = new Set(["JNT", "JT", "POS", "POSLAJU", "SPX", "SHOPEE", "GDEX", "NINJA", "NINJAVAN", "DHL", "SKY", "SKYNET", "CITY", "FLASH", "LEX", "LAZ"]);
  const commands = [];
  const seen = new Set();
  for (const line of source.split(/\r?\n/)) {
    const compact = line.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cardTokens = compact.match(/[A-Z]{2,12}\d{4}/g) || [];
    if (!cardTokens.length) continue;
    if (!hasSignedLabel) {
      const hasParcelReference = cardTokens.some((token) => courierCodes.has(token.replace(/\d{4}$/, "")));
      const hasSeparateCard = cardTokens.some((token) => !courierCodes.has(token.replace(/\d{4}$/, "")));
      if (!hasParcelReference || !hasSeparateCard) continue;
    }
    const cardToken = cardTokens[cardTokens.length - 1];
    const parcelToken = cardTokens.find((token) => courierCodes.has(token.replace(/\d{4}$/, ""))) || "";
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
  const source = String(text || "");
  return ["\u64a4\u9500\u5bfc\u5165", "\u53d6\u6d88\u5bfc\u5165", "undo import", "delete import"].some((item) => source.toLowerCase().includes(item.toLowerCase()));
}


function parseRecordCommand(text, defaultWarrantyDate = "", replyMessageId = "") {
  const source = String(text || "");
  const statuses = ["\u8f66\u624b\u5df2\u7b7e\u6536", "\u672a\u5904\u7406", "\u5904\u7406\u4e2d", "\u5df2\u5bc4\u51fa", "\u5df2\u5b8c\u6210", "\u8fc7\u4fdd", "\u5f00\u4fdd", "\u5bc4", "\u5f39\u5361", "\u4eba\u5934\u5173", "\u4eba\u5934\u5077\u94b1", "\u8d54 150", "\u70b8"];
  const latestUndoWords = ["\u64a4\u9500\u5bfc\u5165", "\u53d6\u6d88\u5bfc\u5165", "undo import", "delete import"];
  const deleteWords = ["\u5220\u9664", "delete", ...latestUndoWords];
  const status = statuses.find((item) => source.includes(item)) || statusFromCommandLine(source) || problemStatusFromText(source);
  const shouldDelete = deleteWords.some((item) => source.toLowerCase().includes(item.toLowerCase()));
  if (!status && !shouldDelete) return null;
  if (replyMessageId && undoWordsFromText(source)) return { action: "deleteReplyImport", replyMessageId };
  const compact = source.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cardMatch = compact.match(/([A-Z]{2,12}\d{4}|\d{4})/);
  if (!cardMatch) {
    if (latestUndoWords.some((item) => source.toLowerCase().includes(item.toLowerCase()))) return { action: "deleteLatestImport" };
    return null;
  }
  return { action: shouldDelete ? "delete" : "status", status, cardToken: cardMatch[1], warrantyDate: parseCommandDate(source) || (status === "\u5f00\u4fdd" ? defaultWarrantyDate : ""), warrantyDays: parseWarrantyDays(source) };
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
  const cardLabel = clean(record?.cardNumber) || recordDetailValue(record, "cardNumber", ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "CARD", "KAD"]);
  const fullCard = clean(record?.receivedCardNumber)
    || pickLineValue(clean(record?.formattedDetails), ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "CARD", "KAD"])
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
    card: pickLineValue(clean(updatedRecord.formattedDetails), ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "CARD", "KAD"]) || updatedRecord.cardNumber,
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
    const changed = result.cardChanged ? "\n\u5df2\u8865\u5361\u53f7\uff1a" + (result.originalCardNumber || "-") + " -> " + (result.newCardNumber || card) : "";
    return (parcel ? parcel + " | " : "") + card + (dealer ? " ? " + dealer : "") + changed;
  });
  const missingLines = missing.length ? ["", "\u627e\u4e0d\u5230\u8d44\u6599: " + missing.join(", ")] : [];
  return ["\u8f66\u624b\u5df2\u7b7e\u6536\uff0c\u5df2\u505c\u6b62\u67e5\u8be2 " + stopped.length + " \u6761", "\u8bf7\u5728 App \u67e5\u770b\u660e\u7ec6", "", ...lines, ...missingLines].filter((line, index) => index < 3 || clean(line)).join("\n");
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
    reason: command.reason || "card_not_found",
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
    if (!record) return { ok: false, message: "record_not_found" };
    await db.ref("dealer-card-tracker/records/" + record.key).remove();
    return { ok: true, cardNumber: record.cardNumber || record.id, status: "\u5220\u9664" };
  }

  if (command.action === "deleteLatestImport") {
    const record = await findLatestTelegramImport();
    if (!record) return { ok: false, message: "latest_import_not_found" };
    await db.ref("dealer-card-tracker/records/" + record.key).remove();
    return { ok: true, cardNumber: record.cardNumber || record.id, status: "\u5220\u9664" };
  }

  let record = null;
  if (command.action === "deleteDriverSigned" && command.parcelToken) record = await findLatestRecordByParcelToken(command.parcelToken);
  if (!record) record = await findLatestRecordByCard(command.cardToken);
  if (!record) {
    if (command.action !== "delete" && command.action !== "deleteReplyImport" && command.action !== "deleteLatestImport") {
      await rememberUnknownDriverCard({ ...command, reason: command.action === "deleteDriverSigned" ? "driver_card_not_found" : "warranty_card_not_found" });
    }
    return { ok: false, cardToken: command.cardToken, message: "record_not_found:" + command.cardToken };
  }

  if (command.action === "delete") {
    await db.ref("dealer-card-tracker/records/" + record.key).remove();
    return { ok: true, cardNumber: record.cardNumber || command.cardToken, status: "\u5220\u9664" };
  }

  if (command.action === "deleteDriverSigned") {
    const incomingCard = clean(command.cardToken).toUpperCase();
    const savedCard = clean(record.cardNumber).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const shouldFillMissingCard = incomingCard && isMissingCardNumber(savedCard);
    const updateData = { status: "\u8f66\u624b\u5df2\u7b7e\u6536", packageStatus: "\u8f66\u624b\u5df2\u7b7e\u6536", trackingStoppedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (shouldFillMissingCard) {
      updateData.cardNumber = incomingCard;
      updateData.cardMatchedAt = new Date().toISOString();
      updateData.notes = (clean(record.notes) + " ? " + "\u8f66\u624b\u6309\u5305\u88f9\u5c3e\u53f7\u81ea\u52a8\u8865\u4e0a\u5361\u53f7").trim();
      record = { ...record, ...updateData };
    }
    await db.ref("dealer-card-tracker/records/" + record.key).update(updateData);
    const readyRecord = await ensureRecordCcidStatus({ ...record, ...updateData, key: record.key });
    return { ok: true, cardNumber: readyRecord.cardNumber || command.cardToken, cardToken: command.cardToken, parcelToken: command.parcelToken || "", cardChanged: Boolean(updateData.cardNumber), originalCardNumber: savedCard || "", newCardNumber: updateData.cardNumber || "", status: "\u8f66\u624b\u5df2\u7b7e\u6536", record: readyRecord };
  }

  const updateData = { status: command.status, updatedAt: new Date().toISOString() };
  if (command.status !== "\u5bc4") updateData.trackingStoppedAt = new Date().toISOString();
  if (command.status === "\u5bc4") updateData.trackingStoppedAt = null;
  if (command.status === "\u5f00\u4fdd" && command.warrantyDate) updateData.warrantyDate = command.warrantyDate;
  if (command.status === "\u5f00\u4fdd" && command.warrantyDays) updateData.warrantyDays = command.warrantyDays;
  await db.ref("dealer-card-tracker/records/" + record.key).update(updateData);
  return { ok: true, cardNumber: record.cardNumber || command.cardToken, status: command.status, warrantyDate: updateData.warrantyDate || "", warrantyDays: updateData.warrantyDays || 0 };
}

async function findLatestTelegramImport() {
  const snapshot = await db.ref("dealer-card-tracker/records").get();
  const records = Object.entries(snapshot.val() || {})
    .map(([key, record]) => ({ key, ...record }))
    .filter((record) => clean(record.notes).includes("Telegram"))
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
    if (record.status === "\u5f00\u4fdd" && days > 0 && expireDate && today >= expireDate) {
      updates["dealer-card-tracker/records/" + key + "/status"] = "\u8fc7\u4fdd";
      updates["dealer-card-tracker/records/" + key + "/updatedAt"] = new Date().toISOString();
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
    for (const command of signedCommands) results.push(await applyRecordCommand(command));
    return { handled: true, message: "" };
  }
  if (cardFillResult.filled || cardFillResult.ambiguous) return { handled: true, message: "\u5df2\u8865\u5361\u53f7 " + cardFillResult.filled + " \u6761" };
  const bulkCommands = [
    ...parseBulkRecordCommands(text, defaultWarrantyDate),
    ...parseGeneralBulkRecordCommands(text, defaultWarrantyDate)
  ];
  if (bulkCommands.length) {
    const results = [];
    for (const command of bulkCommands) results.push(await applyRecordCommand(command));
    const ok = results.filter((result) => result.ok);
    const failed = results.filter((result) => !result.ok);
    if (!failed.length) return { handled: true, reactionOnly: true, reaction: "\u2705", message: "" };
    return { handled: true, message: "\u5df2\u66f4\u65b0 " + ok.length + " \u6761" + "\n\u5931\u8d25 " + failed.length + " \u6761" };
  }
  const command = parseRecordCommand(text, defaultWarrantyDate, replyMessageId);
  if (!command) return { handled: false, message: "" };
  const result = await applyRecordCommand(command);
  if (result.ok) return { handled: true, reactionOnly: true, reaction: "\u2705", message: "" };
  return { handled: true, message: result.message };
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
  return "\u5176\u4ed6";
}

async function saveTelegramRecord(text, fallbackDealerName = "Telegram", telegramMessageId = "", senderName = "") {
  const requestedDealerName = parseDealer(text, fallbackDealerName);
  const existingDealerName = await findExistingDealerName(requestedDealerName);
  const rawCardNumber = parseCardNumber(text);
  const rawBankName = pickLineValue(text, ["BANK", "NAMA BANK"]);
  const bankName = detectBank((rawBankName || "") + "\n" + text);
  const shipment = parseShipmentCode(text);
  const cardNumber = displayCardNumber(text, bankName);
  const bankAccount = normalizeBankAccount(pickLineValue(text, ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"]));
  const atmPin = pickLineValue(text, ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"]);
  const formattedDetails = buildTelegramFormattedDetails({
    name: pickLineValue(text, ["NAMA", "NAME"]),
    ic: pickLineValue(text, ["IC NO", "IC"]),
    bank: rawBankName || bankName,
    account: bankAccount,
    card: rawCardNumber || cardNumber,
    pin: atmPin
  });

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
    NAMA: pickLineValue(text, ["NAMA", "NAME"]),
    "IC NO": pickLineValue(text, ["IC NO", "IC"]),
    BANK: rawBankName || bankName,
    "NO AKAUN": bankAccount,
    "NO KAD": rawCardNumber
  };
  const missingFields = Object.entries(requiredFields).filter(([, value]) => !clean(value)).map(([label]) => label);
  const dealerName = existingDealerName || requestedDealerName || fallbackDealerName || "Telegram";

  if (!dealerName) {
    pendingReason = "Dealer not found: " + (requestedDealerName || "unknown");
  } else if (!existingRecord && trackingMatch && normalizeLookup(trackingMatch.cardNumber) !== normalizedCard) {
    pendingType = "conflict";
    pendingReason = "Tracking number already belongs to " + (trackingMatch.cardNumber || "another card");
  }

  if (pendingReason) {
    const pendingSnapshot = await db.ref("dealer-card-tracker/pendingImports").get();
    const duplicatePending = Object.values(pendingSnapshot.val() || {}).find((item) => (
      telegramMessageId && String(item.telegramMessageId || "") === String(telegramMessageId)
    ));
    if (duplicatePending) {
      return { ok: false, pending: true, duplicate: true, reason: pendingReason, dealerName, cardNumber };
    }
    const pendingRef = db.ref("dealer-card-tracker/pendingImports").push();
    await pendingRef.set(stripUndefined({
      type: pendingType,
      reason: pendingReason,
      missingFields,
      dealerName,
      senderName,
      text,
      formattedDetails,
      cardNumber,
      bankName,
      rawBankName,
      bankAccount,
      trackingNumber: shipment.trackingNumber,
      carrier: shipment.carrier,
      trackingTail: shipment.tailNumber,
      telegramMessageId,
      createdAt: new Date().toISOString()
    }));
    return { ok: false, pending: true, reason: pendingReason, dealerName, cardNumber };
  }

  const dealerId = await ensureDealer(dealerName);
  const mergedCardNumber = existingRecord ? firstClean(cardNumber === "XXXX" ? "" : cardNumber, existingRecord.cardNumber) : cardNumber;
  const mergedCarrier = existingRecord ? firstClean(shipment.carrier, existingRecord.carrier) : shipment.carrier;
  const mergedTrackingTail = existingRecord ? firstClean(shipment.tailNumber, existingRecord.trackingTail, existingRecord.tailNumber) : shipment.tailNumber;
  const mergedTrackingNumber = existingRecord ? firstClean(shipment.trackingNumber, existingRecord.trackingNumber) : shipment.trackingNumber;
  const mergedFormattedDetails = existingRecord ? buildTelegramFormattedDetails({
    name: firstClean(pickLineValue(text, ["NAMA", "NAME"]), recordDetailValue(existingRecord, "customerName", ["NAMA", "NAME"])),
    ic: firstClean(pickLineValue(text, ["IC NO", "IC"]), recordDetailValue(existingRecord, "icNumber", ["IC NO", "IC"])),
    bank: firstClean(rawBankName || bankName, recordDetailValue(existingRecord, "bankName", ["BANK", "NAMA BANK"])),
    account: firstClean(bankAccount, recordDetailValue(existingRecord, "bankAccount", ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"])),
    card: firstClean(rawCardNumber || mergedCardNumber, pickLineValue(clean(existingRecord.formattedDetails), ["NO KAD", "BANK CARD 16 DIGIT", "CARD 16 DIGIT", "CARD", "KAD"]), existingRecord.cardNumber),
    pin: firstClean(atmPin, recordDetailValue(existingRecord, "atmPin", ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"]))
  }) : formattedDetails;
  const baseUpdate = stripUndefined({
    dealerId,
    dealerName,
    cardNumber: mergedCardNumber,
    carrier: mergedCarrier,
    trackingTail: mergedTrackingTail,
    trackingNumber: mergedTrackingNumber,
    note: "Telegram \u81ea\u52a8\u5bfc\u5165",
    formattedDetails: mergedFormattedDetails,
    telegramMessageId,
    telegramSenderName: senderName,
    importedFromTelegram: true,
    updatedAt: Date.now()
  });

  if (existingRecord) {
    await db.ref("dealer-card-tracker/records/" + existingRecord.id).update(baseUpdate);
    return { ok: true, updated: true, recordId: existingRecord.id, dealerName, cardNumber: mergedCardNumber };
  }

  const recordRef = db.ref("dealer-card-tracker/records").push();
  await recordRef.set({
    ...baseUpdate,
    status: "\u5bc4",
    createdAt: Date.now()
  });
  return { ok: true, created: true, recordId: recordRef.key, dealerName, cardNumber };
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

async function replyToTelegramMessage(chatId, messageId, text) {
  if (!chatId || !messageId) return false;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_parameters: {
        message_id: messageId,
        allow_sending_without_reply: true
      }
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    console.error(`Telegram proof reply failed: chat=${chatId} message=${messageId} ${result.description || response.status}`);
    return false;
  }
  return true;
}

async function reactToTelegramMessage(chatId, messageId, emoji = "\u2705") {
  if (!chatId || !messageId) return false;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
      is_big: false
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    console.error(`Telegram reaction failed: chat=${chatId} message=${messageId} emoji=${emoji} ${result.description || response.status}`);
    return false;
  }
  return true;
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
  return Boolean(roleChatId) && String(chatId) === String(roleChatId);
}

function chatMatchesAnyRole(chatId, roles = {}, names = []) {
  return names.some((name) => roles[name] && String(chatId) === String(roles[name]));
}

function chatMatchesDataGroup(chatId, roles = {}) {
  if (roles.import) return chatMatchesRole(chatId, roles.import);
  return chatMatchesRole(chatId, roles.tracking);
}

async function writeBotNotice(message) {
  const text = clean(message);
  if (!text) return;
  await db.ref("dealer-card-tracker/botNotice").set({
    message: text,
    updatedAt: new Date().toISOString()
  });
  await db.ref("dealer-card-tracker/notice").set({
    message: text,
    updatedAt: new Date().toISOString()
  });
}

function telegramRoleSummary(chatId, roles) {
  const current = String(chatId);
  const assigned = [];
  if (roles.import === current) assigned.push("\u5361\u53f7\u8d44\u6599\u5bfc\u5165\u7fa4");
  if (roles.warranty === current) assigned.push("\u5f00\u4fdd/\u95ee\u9898\u72b6\u6001\u7fa4");
  if (roles.tracking === current) assigned.push("\u5305\u88f9\u72b6\u6001\u4e0e\u8f66\u624b\u7fa4");
  return assigned.length ? assigned.join(" / ") : "\u672a\u6307\u5b9a\u7fa4\u7528\u9014";
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
  if (source.includes("delivered") || source.includes("delivery completed") || source.includes("\u5df2\u9001\u8fbe") || source.includes("\u9001\u8fbe")) return "delivered";
  if (source.includes("pickup") || source.includes("out for delivery") || source.includes("on delivery") || source.includes("\u6d3e\u9001")) return "pickup";
  if (source.includes("exception") || source.includes("failed") || source.includes("inaccessible") || source.includes("\u5f02\u5e38")) return "exception";
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
  if (clean(record.status) !== "\u5bc4") return { notified: false };
  if (record.lastTrackingNotifyStatus === normalizedStatus) return { notified: false };

  const labelMap = {
    pickup: "\u6d3e\u9001\u4e2d",
    delivered: "\u5df2\u9001\u8fbe",
    exception: "\u5f02\u5e38"
  };
  const label = labelMap[normalizedStatus] || event.status;
  const chatId = announceChatId || (await db.ref("dealer-card-tracker/settings/telegramChatId").get()).val();
  if (!chatId) return { notified: false };

  const message = [
    "\u5305\u88f9" + label,
    "",
    `Dealer: ${record.dealerName || "-"}`,
    `\u5361\u53f7: ${record.cardNumber || "-"}`,
    `\u5feb\u9012: ${record.carrier || trackingInfo.carrier || "-"}`,
    `\u5355\u53f7: ${event.trackingNumber}`,
    event.checkpoint ? `\u4f4d\u7f6e: ${event.checkpoint}` : ""
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
  const snapshot = await db.ref("dealer-card-tracker/settings").get();
  const settings = snapshot.val() || {};
  return settings.importChatId || settings.trackingNotificationChatId || announceChatId || settings.telegramChatId;
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
  if (clean(record.status) !== "\u8f66\u624b\u5df2\u7b7e\u6536") return false;
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
  if (!source) return "\u672a\u77e5\u5730\u533a";
  if (source.includes("IPOH") || source.includes("KINTA")) return "IPOH / KINTA";
  if (source.includes("JOHOR BAHRU") || source.includes("JHR")) return "JOHOR BAHRU";
  if (source.includes("KAMPAR")) return "KAMPAR";
  if (source.includes("SHAH ALAM")) return "SHAH ALAM";
  if (source.includes("KUALA LANGAT")) return "KUALA LANGAT";
  if (source.includes("PERAK") || source.includes("PRK")) return "PERAK";
  if (source.includes("SELANGOR") || source.includes("SGR")) return "SELANGOR";
  if (source.includes("KUALA LUMPUR") || source.includes("WANGSA MAJU") || source.includes("BANDAR TUN RAZAK") || source.includes("KUL")) return "KUALA LUMPUR";
  if (source.includes("PENANG") || source.includes("PULAU PINANG") || source.includes("PEN")) return "PENANG";
  if (source.includes("SERIAN")) return "SERIAN";
  if (source.includes("BAGAN SERAI")) return "BAGAN SERAI";
  if (source.includes("LAYANG-LAYANG")) return "LAYANG-LAYANG";
  if (source.includes("KOTA TINGGI")) return "KOTA TINGGI";
  if (source.includes("JOHOR")) return "JOHOR";
  return source.replace(/\s+/g, " ").slice(0, 42);
}

function buildTrackingSummaryMessage(records, today, options = {}) {
  const unknownGroup = "\u672a\u77e5\u5730\u533a";
  const sortKey = (record) => {
    const group = trackingLocationGroup(trackingSummaryLocation(record));
    return `${group === unknownGroup ? "ZZZ" : group}${trackingCarrierCode(record)}${trackingTail(record)}${clean(record.cardNumber)}`;
  };
  const summaryRecords = records
    .filter((record) => shouldIncludeTrackingSummary(record, today))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  if (!summaryRecords.length) return "";
  const groupedLines = new Map();
  for (const record of summaryRecords) {
    const location = trackingSummaryLocation(record);
    const group = trackingLocationGroup(location);
    const parcelLabel = `${trackingCarrierCode(record)}${trackingTail(record)}`;
    const statusText = packageStatusText(record, today);
    const line = `${parcelLabel} | ${clean(record.cardNumber || "-")} ${statusText}`;
    if (!groupedLines.has(group)) groupedLines.set(group, []);
    groupedLines.get(group).push(line);
  }
  const lines = [];
  for (const [group, groupLines] of groupedLines) {
    lines.push(`[${group}]`, ...groupLines, "");
  }
  if (lines.at(-1) === "") lines.pop();
  const hasReadyForPickup = summaryRecords.some((record) => {
    const status = packageStatusText(record, today);
    return status === "\u6d3e\u9001\u4e2d" || status.startsWith("\u5df2\u9001\u8fbe");
  });
  const driverTookPackagesToday = records.some((record) => wasTakenByDriverToday(record, today));
  const footer = options.addPickupSummary && driverTookPackagesToday && !hasReadyForPickup
    ? ["", "\u4eca\u5929\u6ca1\u6709\u5f85\u62ff\u7684\u5305\u88f9\u4e86"]
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
    await sendTelegramMessage(chatId, `\u5305\u88f9\u72b6\u6001\n${today}\n\n\u4eca\u5929\u6ca1\u6709\u5f85\u62ff\u7684\u5305\u88f9\u4e86`);
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
          ? "Tracking.my \u6682\u65f6\u6ca1\u6709\u62ff\u5230\u771f\u5b9e\u72b6\u6001"
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
      res.status(403).json({ ok: false, message: "\u516c\u544a\u5bc6\u7801\u9519\u8bef" });
      return;
    }
    if (!message) {
      res.status(400).json({ ok: false, message: "\u516c\u544a\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a" });
      return;
    }

    const savedChatId = (await db.ref("dealer-card-tracker/settings/telegramChatId").get()).val();
    const targetChatId = announceChatId || savedChatId;
    if (!targetChatId) {
      res.status(400).json({ ok: false, message: "\u8fd8\u6ca1\u6709\u8bbe\u7f6e Telegram \u7fa4 ID" });
      return;
    }

    await sendTelegramMessage(targetChatId, `\u7fa4\u516c\u544a\n${message}`);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: "\u53d1\u9001\u5931\u8d25\uff0c\u8bf7\u770b Render Logs" });
  }
});

app.options("/gmail/export-list", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.status(204).send("");
});

app.post("/gmail/export-list", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const result = await exportGmailListToSheet({
      dealer: req.body?.dealer,
      phones: req.body?.phones
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    res.status(200).json({ ok: false, message: error.message || "gmail_export_failed" });
  }
});

app.get("/gmail/stock", async (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const sync = await syncUnreadGmailLists();
    const stock = await getGmailListStock();
    const backendSheet = await writeGmailBackendStockSheet(stock, sync);
    res.json({
      ok: true,
      count: stock.count,
      total: stock.total,
      exported: stock.exported,
      todayAdded: stock.todayAdded,
      todayTaken: stock.todayTaken,
      dealerTaken: stock.dealerTaken,
      dealerTakenList: stock.dealerTakenList,
      imported: sync.imported || 0,
      checked: sync.checked || 0,
      gmailReady: sync.message !== "missing_gmail_imap_config",
      syncErrors: sync.errors || [],
      checkedAt: stock.checkedAt,
      backendSheet
    });
  } catch (error) {
    console.error(error);
    res.status(200).json({ ok: false, message: error.message || "gmail_stock_failed" });
  }
});

app.post("/gmail/sync", async (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const sync = await syncUnreadGmailLists();
    const stock = await getGmailListStock();
    const backendSheet = await writeGmailBackendStockSheet(stock, sync);
    res.json({
      ok: true,
      ...sync,
      stock: stock.count,
      todayAdded: stock.todayAdded,
      todayTaken: stock.todayTaken,
      dealerTaken: stock.dealerTaken,
      dealerTakenList: stock.dealerTakenList,
      backendSheet
    });
  } catch (error) {
    console.error(error);
    res.status(200).json({ ok: false, message: error.message || "gmail_sync_failed" });
  }
});

app.post("/gmail/take-list", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const result = await takeGmailListStock({
      dealer: req.body?.dealer,
      count: req.body?.count
    });
    const stock = await getGmailListStock();
    const backendSheet = await writeGmailBackendStockSheet(stock, { imported: 0 });
    res.json({ ok: true, ...result, backendSheet });
  } catch (error) {
    console.error(error);
    res.status(200).json({ ok: false, message: error.message || "gmail_take_failed" });
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
    const text = messageText;
    if (!text) {
      res.status(200).send("ignored");
      return;
    }

    const lowerText = text.toLowerCase();
    if (lowerText.startsWith("/setimportgroup")) {
      await setTelegramRoleChat("import", chatId);
      await reply(chatId, `已设置这里为卡号资料导入群\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (lowerText.startsWith("/setwarrantygroup")) {
      await setTelegramRoleChat("warranty", chatId);
      await reply(chatId, `已设置这里为开保/问题状态群\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (lowerText.startsWith("/setnotifygroup")) {
      await setTelegramRoleChat("tracking", chatId);
      await reply(chatId, `已设置这里为包裹状态与车手群\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (lowerText.startsWith("/setpickupgroup")) {
      await setTelegramRoleChat("pickup", chatId);
      await reply(chatId, `已设置这里为车手通知群\n车手发 jnt1234 mbb1234 后，会通知到这里\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (lowerText.startsWith("/grouprole")) {
      const roles = await getTelegramRoleChats();
      await reply(chatId, `当前群用途: ${telegramRoleSummary(chatId, roles)}\n群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }
    if (lowerText.startsWith("/chatid")) {
      await reply(chatId, `群 ID: ${chatId}`);
      res.status(200).send("ok");
      return;
    }

    const roles = await getTelegramRoleChats();
    const looksLikeImport = isImportMessage(text, senderName) || isPotentialImportMessage(text);
    const importRoleAllowed = looksLikeImport || chatMatchesRole(chatId, roles.import);

    if (/^(\u5bfc\u5165|\u88dc\u5bfc\u5165|\u8865\u5bfc\u5165|import)$/i.test(clean(text)) && replyText) {
      if (!isImportMessage(replyText, senderName) && !isPotentialImportMessage(replyText)) {
        await writeBotNotice("补导入失败：回复内容不像卡资料");
        await replyToTelegramMessage(chatId, message?.message_id, "这条回复内容不像卡资料，没导入。");
        res.status(200).send("ok");
        return;
      }

      const importResult = await saveTelegramRecord(replyText, senderName, replyMessageId || message?.message_id, senderName);
      if (importResult.pending) {
        await replyToTelegramMessage(chatId, message?.message_id, `已放入待处理\n卡号: ${importResult.cardNumber || "-"}\n原因: ${importResult.reason || "-"}`);
        await writeBotNotice(`补导入待处理：${importResult.cardNumber || "-"} · ${importResult.reason || "-"}`);
      } else {
        const proof = `${importResult.updated ? "已更新" : "已导入"} ${importResult.dealerName || ""}`.trim();
        const sent = await replyToTelegramMessage(chatId, message?.message_id, proof);
        if (!sent) await reply(chatId, proof);
        await writeBotNotice(`${importResult.updated ? "补导入已更新" : "补导入成功"}：${importResult.dealerName || ""} · ${importResult.cardNumber || "-"}`);
      }
      res.status(200).send("ok");
      return;
    }

    if (undoWordsFromText(text) && (chatMatchesRole(chatId, roles.import) || !chatMatchesAnyRole(chatId, roles, ["warranty", "tracking", "pickup"]))) {
      const commandResult = await handleRecordCommand(text, defaultWarrantyDate, replyMessageId);
      if (commandResult.handled) {
        if (commandResult.message) await writeBotNotice(commandResult.message);
        res.status(200).send("ok");
        return;
      }
    }

    if (clean(text) === "资料" && replyText && chatMatchesDataGroup(chatId, roles)) {
      const detailResult = await getDriverSignedDetailsFromText(replyText);
      if (!detailResult.details.length) {
        await reply(chatId, detailResult.missing.length ? `找不到：${detailResult.missing.join(", ")}` : "找不到这条车手记录的资料");
        res.status(200).send("ok");
        return;
      }
      for (const detail of detailResult.details) await reply(chatId, detail);
      if (detailResult.missing.length) await reply(chatId, `找不到：${detailResult.missing.join(", ")}`);
      res.status(200).send("ok");
      return;
    }

    if (lowerText.startsWith("/checktracking")) {
      if (!chatMatchesDataGroup(chatId, roles)) {
        res.status(200).send("ignored");
        return;
      }
      const checkResult = await checkTrackingMyRecords("", { sendSummary: true });
      await reply(chatId, checkResult.summarySent ? "已检查并发送包裹状态" : "已检查，没有需要发送的包裹");
      res.status(200).send("ok");
      return;
    }

    const isDriverSignedCommand = parseDriverSignedCommands(text).length > 0;
    const commandRoleAllowed = isDriverSignedCommand ? chatMatchesDataGroup(chatId, roles) : chatMatchesRole(chatId, roles.warranty);
    if (commandRoleAllowed) {
      const commandResult = await handleRecordCommand(text, defaultWarrantyDate, replyMessageId);
      if (commandResult.handled) {
        if (!isDriverSignedCommand && chatMatchesRole(chatId, roles.warranty)) {
          const noticeText = commandResult.message
            ? `开保群已处理：${clean(text).slice(0, 120)} · ${commandResult.message}`
            : `开保群已处理：${clean(text).slice(0, 120)}`;
          await writeBotNotice(noticeText);
          const warrantyNotice = buildWarrantyGroupNotification(text, defaultWarrantyDate);
          if (warrantyNotice && roles.tracking && String(roles.tracking) !== String(chatId)) {
            await sendTelegramMessage(roles.tracking, warrantyNotice);
          }
          res.status(200).send("ok");
          return;
        }
        if (commandResult.reactionOnly) {
          await reactToTelegramMessage(chatId, message?.message_id, commandResult.reaction || "✅");
          await writeBotNotice(`状态已更新：${clean(text).slice(0, 120)}`);
          if (commandResult.message) await reply(chatId, commandResult.message);
        } else if (commandResult.message) {
          await reply(chatId, commandResult.message);
        }
        for (const item of commandResult.messages || []) await reply(chatId, item);
        if (isDriverSignedCommand && commandResult.pickupNotice && roles.pickup && String(roles.pickup) !== String(chatId)) await sendTelegramMessage(roles.pickup, commandResult.pickupNotice);
        res.status(200).send("ok");
        return;
      }
    }

    if (!importRoleAllowed) {
      if (looksLikeImport) await writeBotNotice(`导入被忽略：这个群不是导入群。群ID ${chatId}`);
      res.status(200).send("ignored");
      return;
    }
    if (!looksLikeImport) {
      res.status(200).send("ignored");
      return;
    }

    const result = await saveTelegramRecord(text, senderName, message?.message_id, senderName);
    if (result.pending) {
      await reply(chatId, `已放入待处理\n卡号: ${result.cardNumber || "-"}\n原因: ${result.reason || "-"}`);
      await writeBotNotice(`导入待处理：${result.cardNumber || "-"} · ${result.reason || "-"}`);
      res.status(200).send("ok");
      return;
    }

    const importProof = `${result.updated ? "已更新" : "已导入"} ${result.dealerName || ""}`.trim();
    const importProofSent = await replyToTelegramMessage(chatId, message?.message_id, importProof);
    if (!importProofSent) await reply(chatId, importProof);
    await writeBotNotice(`${result.updated ? "导入已更新" : "导入成功"}：${result.dealerName || ""} · ${result.cardNumber || "-"}`);
    res.status(200).send("ok");
  } catch (error) {
    console.error(error);
    await writeBotNotice(`机器人错误：${error.message || error}`);
    res.status(200).send("error handled");
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Telegram bot listening on ${port}`);
  ensureTelegramWebhook().catch((error) => console.error(error));
  autoExpireWarrantyRecords().catch((error) => console.error(error));
  runScheduledTrackingMyCheck().catch((error) => console.error(error));
  syncUnreadGmailLists().catch((error) => console.error(error));
});

setInterval(() => {
  autoExpireWarrantyRecords().catch((error) => console.error(error));
}, 60 * 60 * 1000);

setInterval(() => {
  runScheduledTrackingMyCheck().catch((error) => console.error(error));
}, 60 * 1000);

setInterval(() => {
  syncUnreadGmailLists().catch((error) => console.error(error));
}, 10 * 60 * 1000);

