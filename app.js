const localKey = "dealer-card-tracker-records";
const dealerListKey = "dealer-card-tracker-dealers";
const statusOptionsKey = "dealer-card-tracker-status-options";
const noticeKey = "dealer-card-tracker-notice";
const pendingImportsKey = "dealer-card-tracker-pending-imports";
const unknownDriverCardsKey = "dealer-card-tracker-unknown-driver-cards";
const announceEndpoint = "https://dealer-tracker.onrender.com/announce";
const trackingCheckEndpoint = "https://dealer-tracker.onrender.com/check-trackingmy";
const recordPhotoEndpoint = "https://dealer-tracker.onrender.com/record-photo";
const defaultStatusOptions = ["未处理", "处理中", "已寄出", "已完成", "过保", "开保", "寄", "车手已签收", "弹卡", "人头关", "人头偷钱", "赔 150", "炸"];
const defaultNewRecordStatus = "寄";
const salaryStatuses = new Set(["过保", "开保", "赔 150"]);
const payrollClearStatuses = new Set(["过保", "开保", "弹卡", "人头关", "人头偷钱", "赔 150", "炸"]);
const malaysiaCouriers = [
  "Pos Laju",
  "Pos Malaysia",
  "J&T Express",
  "J&T Cargo",
  "DHL Express",
  "DHL eCommerce",
  "Ninja Van",
  "GDEX",
  "City-Link Express",
  "Flash Express",
  "SPX Express",
  "Shopee Xpress",
  "Lazada Logistics",
  "LEX MY",
  "Skynet Express",
  "ABX Express",
  "KEX Express",
  "BEST Express",
  "CJ Century",
  "Aramex",
  "FedEx",
  "UPS",
  "TNT",
  "SF Express",
  "Janio",
  "Pgeon",
  "CollectCo",
  "Delyva",
  "Teleport",
  "FMX",
  "Line Clear Express",
  "Qxpress",
  "MatDespatch",
  "Pickupp",
  "uParcel",
  "Nationwide Express",
  "TA-Q-BIN",
  "Airpak Express",
  "M Xpress",
  "TheLorry",
  "其他"
];
const isDealerPage = location.pathname.toLowerCase().endsWith("dealer.html");

let records = [];
let dealers = [];
let statusOptions = [...defaultStatusOptions];
let noticeText = "";
let pendingImports = [];
let unknownDriverCards = [];
let saveRecord;
let deleteRecord;
let saveDealer;
let deleteDealer;
let saveDealerRate;
let saveDealerExpense;
let saveDealerExtraPay;
let saveDealerBlastDeduct;
let saveStatusOption;
let deleteStatusOption;
let saveNotice;
let resolvePendingImport;
let deletePendingImport;
let deleteUnknownDriverCard;
let assignUnknownDriverCard;
let dealerPageFillForm = null;
let firebaseStatusOptionsLoaded = false;
let parsedDetailsDraft = {};
const checkingTrackingRecords = new Set();

function hasFirebaseConfig() {
  const config = window.FIREBASE_CONFIG || {};
  return Boolean(config.apiKey && config.databaseURL && config.projectId && config.appId);
}

function setSyncStatus(mode, text) {
  const syncStatus = document.querySelector("#syncStatus");
  syncStatus.classList.remove("online", "offline");
  if (mode) syncStatus.classList.add(mode);
  syncStatus.querySelector("span:last-child").textContent = text;
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getDealerNameFromUrl() {
  return new URLSearchParams(location.search).get("name") || "";
}

function firebaseKey(value) {
  return encodeURIComponent(String(value || "").trim()).replace(/[.#$\[\]]/g, "_");
}

function malaysiaDateString(date = new Date()) {
  const local = new Date(date.getTime() + (8 * 60 * 60 * 1000));
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText || "").split("-").map(Number);
  if (!year || !month || !day || !days) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Number(days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function dealerUrl(name) {
  return `./dealer.html?name=${encodeURIComponent(name)}`;
}

function normalizeCardLookup(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function recordLookupValues(record) {
  const trackingNumber = normalizeCardLookup(record.trackingNumber);
  return [
    normalizeCardLookup(record.cardNumber),
    trackingNumber,
    normalizeCardLookup(record.tailNumber),
    trackingNumber.slice(-4),
  ].filter(Boolean);
}

function parcelReference(record) {
  const carrier = String(record.carrier || "").toUpperCase();
  const carrierCode = carrier.includes("J&T") || carrier.includes("JNT") ? "JNT"
    : carrier.includes("POS") ? "POS"
      : carrier.includes("SHOPEE") || carrier.includes("SPX") ? "SPX"
        : carrier.includes("NINJA") ? "NINJA"
          : carrier.includes("GDEX") ? "GDEX"
            : carrier.includes("SKYNET") ? "SKYNET"
              : carrier.includes("DHL") ? "DHL"
                : "PKG";
  const trackingNumber = normalizeCardLookup(record.trackingNumber);
  const tail = normalizeCardLookup(record.tailNumber) || trackingNumber.slice(-4) || "XXXX";
  return `${carrierCode}${tail}`;
}

function readJson(key, fallback = []) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(`${value}T00:00:00`));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeStatusOptions(options) {
  const names = new Set();
  for (const option of options || []) {
    const name = typeof option === "string" ? option.trim() : option?.name?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

function populateStatusSelect(select, selectedValue = "") {
  const selected = selectedValue || statusOptions[0] || "";
  const options = normalizeStatusOptions(selected ? [...statusOptions, selected] : statusOptions);
  select.textContent = "";
  for (const status of options) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    if (selected === status) option.selected = true;
    select.append(option);
  }
}

function populateCarrierSelect(select, selectedValue = "") {
  const selected = selectedValue || malaysiaCouriers[0];
  const options = malaysiaCouriers.includes(selected) ? malaysiaCouriers : [...malaysiaCouriers, selected];
  select.textContent = "";
  for (const courier of options) {
    const option = document.createElement("option");
    option.value = courier;
    option.textContent = courier;
    if (courier === selected) option.selected = true;
    select.append(option);
  }
}

function uniqueDealers() {
  const names = new Set(dealers.map((dealer) => dealer.name).filter(Boolean));
  for (const record of records) {
    if (record.dealerName) names.add(record.dealerName);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function getDealerInfo(name) {
  return dealers.find((dealer) => dealer.name === name) || { name, rate: 500 };
}

function getDealerRate(name) {
  return Number(getDealerInfo(name).rate || 500);
}

function getDealerExpense(name) {
  return Number(getDealerInfo(name).expenseCards || getDealerInfo(name).monthlyExpense || getDealerInfo(name).expensePerCard || 0);
}

function getDealerExtraPay(name) {
  return Number(getDealerInfo(name).extraPay || 0);
}

function getDealerBlastDeduct(name) {
  return Number(getDealerInfo(name).blastDeduct || getDealerInfo(name).lastMonthBlastDeduct || 0);
}

function getDealerBlastCards(name) {
  return String(getDealerInfo(name).blastCards || getDealerInfo(name).lastMonthBlastCards || "");
}

function detectSalaryBank(record) {
  const source = `${record.cardNumber || ""} ${record.bankName || ""} ${record.formattedDetails || ""}`.toUpperCase();
  const compactSource = source.replace(/[^A-Z0-9]/g, "");
  const cardToken = normalizeCardLookup(record.cardNumber);
  const tokens = source.split(/[^A-Z0-9]+/).filter(Boolean);
  const hasToken = (...items) => items.some((item) => tokens.includes(item));
  if (cardToken.startsWith("ISLAM")) return "BANK ISLAM";
  if (cardToken.startsWith("MBB")) return "MBB";
  if (cardToken.startsWith("CIMB")) return "CIMB";
  if (cardToken.startsWith("AFFIN")) return "AFFIN";
  if (cardToken.startsWith("AGRO")) return "AGRO";
  if (cardToken.startsWith("MUA")) return "MUAMALAT";
  if (/^(RAKYAT|RKT|RYT)\d{4}/.test(cardToken)) return "RAKYAT";
  if (/^(AMBANK|AM)\d{4}/.test(cardToken)) return "AMBANK";
  if (/^(ALLIANCE|ALL)\d{4}/.test(cardToken)) return "ALLIANCE";
  if (cardToken.startsWith("RHB")) return "RHB";
  if (cardToken.startsWith("HLB")) return "HLB";
  if (cardToken.startsWith("BSN")) return "BSN";
  if (source.includes("BANK ISLAM") || compactSource.includes("BANKISLAM") || source.includes("ISLAM")) return "BANK ISLAM";
  if (source.includes("MAYBANK") || source.includes("MAY BANK") || source.includes("MALAYAN BANKING") || hasToken("MBB")) return "MBB";
  if (source.includes("CIMB") || compactSource.includes("CIMBBANK")) return "CIMB";
  if (source.includes("AFFIN")) return "AFFIN";
  if (source.includes("AGRO") || source.includes("AGROBANK") || source.includes("AGRO BANK")) return "AGRO";
  if (source.includes("MUAMALAT") || source.includes("BANK MUAMALAT") || hasToken("MUA")) return "MUAMALAT";
  if (source.includes("RAKYAT") || source.includes("BANK RAKYAT") || hasToken("RYT", "RKT")) return "RAKYAT";
  if (source.includes("AMBANK") || source.includes("AM BANK") || compactSource.includes("AMBANK") || hasToken("AM")) return "AMBANK";
  if (source.includes("ALLIANCE") || hasToken("ALL")) return "ALLIANCE";
  if (source.includes("RHB")) return "RHB";
  if (source.includes("HONG LEONG") || compactSource.includes("HONGLEONG") || hasToken("HLB")) return "HLB";
  if (source.includes("BSN")) return "BSN";
  return "";
}

function calculateSalary(dealerName) {
  const rate = getDealerRate(dealerName);
  const rawExpenseCards = getDealerExpense(dealerName);
  const expenseCards = rate === 500 ? Math.max(1, rawExpenseCards) : rawExpenseCards;
  const extraPay = getDealerExtraPay(dealerName);
  const blastDeduct = getDealerBlastDeduct(dealerName);
  const expiredRecords = records.filter((record) => record.dealerName === dealerName && salaryStatuses.has(record.status));
  const fullBanks = rate === 500
    ? new Set(["MBB", "CIMB", "AMBANK", "AFFIN", "AGRO", "MUAMALAT", "ALLIANCE", "RAKYAT"])
    : new Set(["MBB", "CIMB", "AFFIN", "AGRO", "MUAMALAT", "RHB", "RAKYAT"]);
  const performanceHalfBanks = rate === 500
    ? new Set(["RHB", "HLB"])
    : new Set(["BSN", "BANK ISLAM", "HLB"]);
  const nonPerformanceHalfBanks = rate === 500
    ? new Set(["BANK ISLAM", "BSN"])
    : new Set([]);
  const fullPay = rate === 500 ? 500 : 300;
  const performanceHalfPay = rate === 500 ? 250 : 150;
  const nonPerformanceHalfPay = rate === 500 ? 150 : 150;
  let fullCount = 0;
  let performanceHalfCount = 0;
  let nonPerformanceHalfCount = 0;
  let compensationCount = 0;
  let cardPay = 0;

  for (const record of expiredRecords) {
    if (String(record.status || "").replace(/\s+/g, "") === "赔150") {
      compensationCount += 1;
      cardPay += 150;
      continue;
    }
    const bank = detectSalaryBank(record);
    if (fullBanks.has(bank)) {
      fullCount += 1;
      cardPay += fullPay;
    } else if (performanceHalfBanks.has(bank)) {
      performanceHalfCount += 1;
      cardPay += performanceHalfPay;
    } else if (nonPerformanceHalfBanks.has(bank)) {
      nonPerformanceHalfCount += 1;
      cardPay += nonPerformanceHalfPay;
    }
  }

  const performanceCount = fullCount + performanceHalfCount + compensationCount;
  const paidFullCount = Math.max(0, fullCount - expenseCards);
  const paidPerformanceHalfCount = performanceHalfCount;
  const paidCompensationCount = compensationCount;
  const paidPerformanceCount = paidFullCount + paidPerformanceHalfCount + paidCompensationCount;
  const basePay = rate === 500
    ? (paidPerformanceCount >= 10 ? 1500 : 0)
    : (paidPerformanceCount >= 7 ? 1500 : paidPerformanceCount >= 3 ? 700 : 0);
  const bonusEligibleCount = paidFullCount;
  const bonus = bonusEligibleCount >= 15 ? bonusEligibleCount * 50 : 0;
  const paidCardPay = (paidFullCount * fullPay)
    + (paidPerformanceHalfCount * performanceHalfPay)
    + (nonPerformanceHalfCount * nonPerformanceHalfPay)
    + (paidCompensationCount * 150);

  return {
    rate,
    expenseCards,
    extraPay,
    blastDeduct,
    expiredCount: expiredRecords.length,
    grossSalary: cardPay + basePay + bonus,
    salary: paidCardPay + basePay + bonus + extraPay - blastDeduct,
    cardPay: paidCardPay,
    basePay,
    fullCount,
    compensationCount,
    performanceCount,
    paidFullCount: paidPerformanceCount,
    paidOriginalCount: paidFullCount,
    paidPerformanceHalfCount,
    paidCompensationCount,
    halfCount: performanceHalfCount + nonPerformanceHalfCount,
    performanceHalfCount,
    nonPerformanceHalfCount,
    bonusEligibleCount,
    bonus
  };
}

function dealerStats(name) {
  const dealerRecords = records.filter((record) => record.dealerName === name);
  const salaryInfo = calculateSalary(name);
  const lastUpdated = dealerRecords
    .map((record) => record.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return { count: dealerRecords.length, ...salaryInfo, lastUpdated };
}

function normalizeRecord(data, id = createId()) {
  const now = new Date().toISOString();
  const firstStatus = statusOptions.includes(defaultNewRecordStatus) ? defaultNewRecordStatus : statusOptions[0] || "";
  return {
    id,
    dealerName: data.dealerName,
    customerName: (data.customerName || "").trim(),
    icNumber: (data.icNumber || "").trim(),
    bankName: (data.bankName || "").trim(),
    bankAccount: (data.bankAccount || "").trim(),
    cardNumber: data.cardNumber.trim(),
    atmPin: (data.atmPin || "").trim(),
    formattedDetails: data.formattedDetails || "",
    carrier: data.carrier.trim(),
    trackingNumber: (data.trackingNumber || "").trim(),
    trackingMoreCourierCode: (data.trackingMoreCourierCode || "").trim(),
    packageStatus: (data.packageStatus || "").trim(),
    lastTrackingNotifyStatus: (data.lastTrackingNotifyStatus || "").trim(),
    trackingMyDetail: (data.trackingMyDetail || "").trim(),
    trackingMyUrl: (data.trackingMyUrl || "").trim(),
    trackingMyCheckedAt: data.trackingMyCheckedAt || "",
    packagePhotoFileId: (data.packagePhotoFileId || "").trim(),
    packagePhotoUpdatedAt: data.packagePhotoUpdatedAt || "",
    deliveredAt: data.deliveredAt || "",
    tailNumber: data.tailNumber.trim(),
    warrantyDate: data.warrantyDate || "",
    warrantyDays: Number(data.warrantyDays || 0),
    status: data.status || firstStatus,
    notes: data.notes.trim(),
    updatedAt: now,
    createdAt: data.createdAt || now
  };
}

function recordFromPendingImport(pending, values) {
  const parsed = parseSmartDetails(pending.formattedDetails || "");
  const wantedCard = normalizeCardLookup(values.cardNumber);
  const existing = records.find((record) => normalizeCardLookup(record.cardNumber) === wantedCard);
  if (existing) {
    return {
      ...existing,
      dealerName: values.dealerName,
      cardNumber: values.cardNumber,
      carrier: pending.carrier || existing.carrier || "鍏朵粬",
      trackingNumber: values.trackingNumber || existing.trackingNumber || "",
      tailNumber: pending.tailNumber || values.trackingNumber.slice(-4) || existing.tailNumber || "",
      formattedDetails: pending.formattedDetails || existing.formattedDetails || "",
      notes: "待匹配资料已确认",
      updatedAt: new Date().toISOString()
    };
  }
  return normalizeRecord({
    ...parsed,
    dealerName: values.dealerName,
    cardNumber: values.cardNumber,
    carrier: pending.carrier || "鍏朵粬",
    trackingNumber: values.trackingNumber,
    tailNumber: pending.tailNumber || values.trackingNumber.slice(-4),
    formattedDetails: pending.formattedDetails || "",
    bankName: pending.bankName || parsed.bankName || "",
    status: defaultNewRecordStatus,
    notes: "待匹配资料已确认",
    createdAt: pending.createdAt
  });
}

function carrierFromParcelToken(parcelToken = "") {
  const token = normalizeCardLookup(parcelToken);
  if (token.startsWith("POS")) return "Pos Laju";
  if (token.startsWith("JNT") || token.startsWith("JT")) return "J&T Express";
  if (token.startsWith("SPX") || token.startsWith("SHOPEE")) return "SPX Express";
  if (token.startsWith("NINJA") || token.startsWith("NJV")) return "Ninja Van";
  if (token.startsWith("DHL")) return "DHL eCommerce";
  if (token.startsWith("GDEX")) return "GDEX";
  if (token.startsWith("SKYNET")) return "Skynet Express";
  return "";
}

function tailFromParcelToken(parcelToken = "") {
  const token = normalizeCardLookup(parcelToken);
  const digitGroups = token.match(/\d+/g) || [];
  const digits = digitGroups.join("");
  return (digits || token).slice(-4);
}

function recordFromUnknownDriverCard(item, dealerName) {
  const cardNumber = normalizeCardLookup(item.cardToken || "");
  const existing = records.find((record) => normalizeCardLookup(record.cardNumber) === cardNumber);
  const now = new Date().toISOString();
  const sharedValues = {
    dealerName,
    cardNumber,
    carrier: existing?.carrier || carrierFromParcelToken(item.parcelToken) || "其他",
    tailNumber: existing?.tailNumber || tailFromParcelToken(item.parcelToken),
    notes: existing?.notes || "从未知卡号分配",
    updatedAt: now
  };

  if (existing) {
    return {
      ...existing,
      ...sharedValues
    };
  }

  return normalizeRecord({
    dealerName,
    cardNumber,
    carrier: sharedValues.carrier,
    trackingNumber: "",
    tailNumber: sharedValues.tailNumber,
    status: defaultNewRecordStatus,
    notes: sharedValues.notes,
    createdAt: item.createdAt || now
  });
}

function parseSmartDetails(text) {
  const fields = {
    customerName: ["NAMA", "NAME"],
    icNumber: ["IC NO", "IC"],
    bankName: ["NAMA BANK", "BANK"],
    bankAccount: ["NO AKAUN", "ACC. NUMBER", "ACC NUMBER", "ACCOUNT NUMBER", "AKAUN", "ACCOUNT"],
    cardNumber: ["BANK CARD 16 DIGIT", "NO KAD", "CARD 16 DIGIT", "KAD"],
    atmPin: ["PIN KAD ATM", "ATM PIN", "PIN ATM", "PIN"]
  };
  const result = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const cleaned = line.replace(/\*/g, "").trim();
    const match = cleaned.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!match) continue;
    const label = match[1].trim().toUpperCase();
    const value = match[2].trim();
    for (const [key, labels] of Object.entries(fields)) {
      if (labels.some((item) => label === item || label.includes(item))) {
        result[key] = value;
      }
    }
  }

  return result;
}

function buildFormattedDetails(data) {
  return `*NAMA* : ${data.customerName || ""}

*IC NO*：${data.icNumber || ""}

*BANK* : ${data.bankName || ""}

*NO AKAUN* : ${data.bankAccount || ""}
----------------------
*NO KAD* : ${data.cardNumber || ""}

*PIN KAD ATM* : ${data.atmPin || ""}
----------------------`;
}

function showSuccessToast() {
  const toast = document.querySelector("#successToast");
  if (!toast) return;
  toast.hidden = false;
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });
  clearTimeout(showSuccessToast.timer);
  showSuccessToast.timer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.hidden = true;
    }, 240);
  }, 2600);
}

function initIndexPage() {
  const form = document.querySelector("#dealerForm");
  const newDealerName = document.querySelector("#newDealerName");
  const searchInput = document.querySelector("#searchInput");
  const noticeForm = document.querySelector("#noticeForm");
  const noticeInput = document.querySelector("#noticeInput");
  const editNoticeButton = document.querySelector("#editNoticeButton");
  const cancelNoticeButton = document.querySelector("#cancelNoticeButton");
  const announceForm = document.querySelector("#announceForm");
  const announceMessage = document.querySelector("#announceMessage");
  const announceSecret = document.querySelector("#announceSecret");
  const announceStatus = document.querySelector("#announceStatus");
  const cardFinderInput = document.querySelector("#cardFinderInput");
  const cardFinderButton = document.querySelector("#cardFinderButton");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = newDealerName.value.trim();
    if (!name) return;
    await saveDealer(name);
    newDealerName.value = "";
    newDealerName.focus();
    renderIndexPage();
  });

  editNoticeButton.addEventListener("click", () => {
    noticeInput.value = noticeText;
    noticeForm.hidden = false;
    editNoticeButton.hidden = true;
    noticeInput.focus();
  });
  cancelNoticeButton.addEventListener("click", () => {
    noticeForm.hidden = true;
    editNoticeButton.hidden = false;
  });
  noticeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveNotice(noticeInput.value.trim());
    noticeForm.hidden = true;
    editNoticeButton.hidden = false;
  });

  localStorage.removeItem("dealer-announce-secret");
  announceSecret.value = "";
  announceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = announceMessage.value.trim();
    const secret = announceSecret.value.trim();
    if (!message) {
      announceStatus.textContent = "公告不能为空";
      return;
    }
    announceStatus.textContent = "发送中...";
    try {
      const response = await fetch(announceEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, secret })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.message || "发送失败");
      announceMessage.value = "";
      announceSecret.value = "";
      announceStatus.textContent = "已发送到群";
      setTimeout(() => {
        announceStatus.textContent = "机器人公告";
      }, 1800);
    } catch (error) {
      announceSecret.value = "";
      announceStatus.textContent = error.message || "发送失败";
    }
  });

  searchInput.addEventListener("input", renderIndexPage);
  document.querySelector("#dealerSort")?.addEventListener("change", renderIndexPage);
  cardFinderInput.addEventListener("input", renderCardDealerFinder);
  cardFinderInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      renderCardDealerFinder();
    }
  });
  cardFinderButton.addEventListener("click", renderCardDealerFinder);
  const pendingList = document.querySelector("#pendingList");
  pendingList?.addEventListener("click", async (event) => {
    const card = event.target.closest(".pending-item");
    if (!card) return;
    const id = card.dataset.id;
    if (event.target.closest(".pending-delete")) {
      if (confirm("删除这条待匹配资料？")) await deletePendingImport(id);
      return;
    }
    if (event.target.closest(".pending-resolve")) {
      const dealerName = card.querySelector(".pending-dealer").value;
      const cardNumber = card.querySelector(".pending-card-number").value.trim();
      const trackingNumber = card.querySelector(".pending-tracking-number").value.trim();
      if (!dealerName) {
        alert("请先选择 Dealer");
        return;
      }
      if (!cardNumber) {
        alert("请填写卡号");
        return;
      }
      await resolvePendingImport(id, { dealerName, cardNumber, trackingNumber });
    }
  });
  document.querySelector("#unknownCardList")?.addEventListener("click", async (event) => {
    const card = event.target.closest(".unknown-card-item");
    if (!card) return;
    if (event.target.closest(".unknown-card-delete")) {
      if (confirm("移除这条未知卡号？")) await deleteUnknownDriverCard(card.dataset.id);
      return;
    }
    if (event.target.closest(".unknown-card-assign")) {
      const dealerName = card.querySelector(".unknown-card-dealer")?.value || "";
      if (!dealerName) {
        alert("请先选择 Dealer");
        return;
      }
      await assignUnknownDriverCard(card.dataset.id, dealerName);
    }
  });
  renderIndexPage();
}

function renderPendingCenter() {
  const center = document.querySelector("#pendingCenter");
  const list = document.querySelector("#pendingList");
  const count = document.querySelector("#pendingCount");
  if (!center || !list || !count) return;

  center.hidden = pendingImports.length === 0;
  count.textContent = `${pendingImports.length} 条待处理`;
  list.textContent = "";

  for (const pending of pendingImports.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))) {
    const item = document.createElement("article");
    item.className = `pending-item pending-${pending.type === "conflict" ? "conflict" : "missing"}`;
    item.dataset.id = pending.id;
    const dealerOptions = uniqueDealers().map((name) => `
      <option value="${escapeHtml(name)}" ${name === pending.suggestedDealerName ? "selected" : ""}>${escapeHtml(name)}</option>
    `).join("");
    item.innerHTML = `
      <div class="pending-item-head">
        <div>
          <span class="pending-type">${pending.type === "conflict" ? "资料冲突" : "待匹配"}</span>
          <strong>${escapeHtml(pending.cardNumber || "未知卡号")}</strong>
        </div>
        <time>${escapeHtml(formatTime(pending.createdAt))}</time>
      </div>
      <p class="pending-reason">${escapeHtml(pending.reason || "资料不完整")}</p>
      <div class="pending-fields">
        <label><span>选择 Dealer</span><select class="pending-dealer"><option value="">请选择 Dealer</option>${dealerOptions}</select></label>
        <label><span>卡号</span><input class="pending-card-number" value="${escapeHtml(pending.cardNumber || "")}" /></label>
        <label><span>包裹号码</span><input class="pending-tracking-number" value="${escapeHtml(pending.trackingNumber || "")}" /></label>
      </div>
      <div class="pending-meta">Telegram：${escapeHtml(pending.senderName || "-")} · 原 Dealer：${escapeHtml(pending.requestedDealerName || "-")}</div>
      <details><summary>查看 Telegram 原始资料</summary><pre>${escapeHtml(pending.formattedDetails || "")}</pre></details>
      <div class="pending-actions">
        <button class="ghost pending-delete" type="button">删除</button>
        <button class="primary pending-resolve" type="button">确认匹配并导入</button>
      </div>
    `;
    list.append(item);
  }
}

function renderUnknownCardCenter() {
  const center = document.querySelector("#unknownCardCenter");
  const list = document.querySelector("#unknownCardList");
  const count = document.querySelector("#unknownCardCount");
  if (!center || !list || !count) return;

  const items = unknownDriverCards
    .slice()
    .sort((a, b) => String(b.lastSeenAt || b.createdAt || "").localeCompare(String(a.lastSeenAt || a.createdAt || "")));

  center.hidden = items.length === 0;
  count.textContent = `${items.length} 条`;
  list.textContent = "";

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "unknown-card-item";
    card.dataset.id = item.id;
    const dealerOptions = uniqueDealers().map((name) => `
      <option value="${escapeHtml(name)}">${escapeHtml(name)}</option>
    `).join("");
    card.innerHTML = `
      <div>
        <span>${escapeHtml(item.parcelToken || "未知包裹")}</span>
        <strong>${escapeHtml(item.cardToken || "未知卡号")}</strong>
      </div>
      <p>${escapeHtml(item.reason || "车手已收到，但系统找不到对应资料")}</p>
      <time>${escapeHtml(formatTime(item.lastSeenAt || item.createdAt))}</time>
      <div class="unknown-card-actions">
        <select class="unknown-card-dealer">
          <option value="">选择 Dealer</option>
          ${dealerOptions}
        </select>
        <button class="primary unknown-card-assign" type="button">放入 Dealer</button>
        <button class="ghost unknown-card-delete" type="button">移除</button>
      </div>
    `;
    list.append(card);
  }
}

function renderCardDealerFinder() {
  const input = document.querySelector("#cardFinderInput");
  const results = document.querySelector("#cardFinderResults");
  const count = document.querySelector("#cardFinderCount");
  if (!input || !results || !count) return;

  const query = normalizeCardLookup(input.value);
  results.textContent = "";
  if (!query) {
    results.hidden = true;
    count.textContent = "等待输入";
    return;
  }

  const matches = records
    .filter((record) => recordLookupValues(record).some((value) => value.includes(query)))
    .sort((a, b) => String(a.dealerName || "").localeCompare(String(b.dealerName || ""), "zh-CN"));

  results.hidden = false;
  count.textContent = matches.length ? `匹配 ${matches.length} 条记录` : "未找到匹配资料";
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "card-finder-empty";
    empty.textContent = `未找到与“${input.value.trim()}”匹配的卡号或包裹资料`;
    results.append(empty);
    return;
  }

  for (const record of matches) {
    const result = document.createElement("a");
    result.className = "card-finder-result";
    result.href = dealerUrl(record.dealerName || "");
    result.innerHTML = `
      <span class="card-finder-number">${escapeHtml(record.cardNumber || "-")}</span>
      <span class="card-finder-dealer">${escapeHtml(record.dealerName || "未知 Dealer")}</span>
      <span class="card-finder-tracking">${escapeHtml(parcelReference(record))}</span>
      <span class="card-finder-status">${escapeHtml(record.packageStatus || record.status || "-")}</span>
      <span class="card-finder-open">进入档案</span>
    `;
    results.append(result);
  }
}

function renderHomeTransitBoard() {
  const list = document.querySelector("#homeTransitList");
  const count = document.querySelector("#homeTransitCount");
  if (!list || !count) return;

  const transitRecords = records
    .filter((record) => {
      const trackingNumber = String(record.trackingNumber || "").replace(/[^A-Za-z0-9]/g, "");
      return record.status === "\u5bc4"
        && trackingNumber.length >= 9
        && !String(record.packageStatus || "").includes("\u5df2\u9001\u8fbe");
    })
    .sort((a, b) => String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")));

  list.textContent = "";
  count.textContent = `${transitRecords.length} 件`;
  if (!transitRecords.length) {
    const empty = document.createElement("div");
    empty.className = "home-transit-empty";
    empty.textContent = "目前没有待送达的包裹";
    list.append(empty);
    return;
  }

  for (const record of transitRecords) {
    const item = document.createElement("a");
    item.className = "home-transit-item";
    item.href = dealerUrl(record.dealerName || "");
    item.innerHTML = `
      <strong>${escapeHtml(record.cardNumber || "-")}</strong>
      <span>${escapeHtml(record.dealerName || "\u672a\u77e5 Dealer")} · ${escapeHtml(parcelReference(record))}</span>
      <em>${escapeHtml(record.packageStatus || "\u672a\u68c0\u67e5")}</em>
    `;
    list.append(item);
  }
}

function renderIndexPage() {
  const dealerList = document.querySelector("#dealerList");
  const emptyState = document.querySelector("#emptyState");
  const totalCount = document.querySelector("#totalCount");
  const heroDealerCount = document.querySelector("#heroDealerCount");
  const heroRecordCount = document.querySelector("#heroRecordCount");
  const noticeMessage = document.querySelector("#noticeMessage");
  const searchInput = document.querySelector("#searchInput");
  const dealerSort = document.querySelector("#dealerSort")?.value || "salary-desc";
  const query = searchInput.value.trim().toLowerCase();
  const names = uniqueDealers().filter((name) => !query || name.toLowerCase().includes(query));
  const dealerLastUpdated = (name) => records
    .filter((record) => record.dealerName === name)
    .map((record) => record.updatedAt || record.createdAt || "")
    .filter(Boolean)
    .sort()
    .at(-1) || "";
  names.sort((a, b) => {
    const statsA = dealerStats(a);
    const statsB = dealerStats(b);
    if (dealerSort === "records-desc") return statsB.count - statsA.count || a.localeCompare(b, "zh-CN");
    if (dealerSort === "latest-desc") return String(dealerLastUpdated(b)).localeCompare(String(dealerLastUpdated(a))) || a.localeCompare(b, "zh-CN");
    if (dealerSort === "name") return a.localeCompare(b, "zh-CN");
    return statsB.salary - statsA.salary || statsB.count - statsA.count || a.localeCompare(b, "zh-CN");
  });

  renderUnknownCardCenter();

  dealerList.textContent = "";
  totalCount.textContent = String(names.length);
  if (heroDealerCount) heroDealerCount.textContent = String(uniqueDealers().length);
  if (heroRecordCount) {
    const unknownCount = unknownDriverCards.length;
    heroRecordCount.textContent = unknownCount ? `${records.length}+${unknownCount}` : String(records.length);
  }
  if (noticeMessage) noticeMessage.textContent = noticeText || "暂无运营通知";
  emptyState.style.display = names.length ? "none" : "block";

  for (const [dealerIndex, name] of names.entries()) {
    const stats = dealerStats(name);
    const card = document.createElement("div");
    card.className = "dealer-card";
    card.innerHTML = `
      <span class="dealer-rank">${String(dealerIndex + 1).padStart(2, "0")}</span>
      <a class="dealer-open" href="${dealerUrl(name)}">
        <span class="dealer-title-line">
          <span class="dealer-name">${escapeHtml(name)}</span>
          <span class="dealer-count-badge">${stats.count}</span>
        </span>
        <span class="dealer-meta">RM${stats.rate} · 计薪 ${stats.expiredCount} · 工资 RM${stats.salary}</span>
      </a>
    `;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "dealer-delete";
    removeButton.textContent = "删除";
    removeButton.addEventListener("click", async () => {
      if (confirm(`删除 ${name} 和他的全部记录？`)) {
        await deleteDealer(name);
      }
    });

    card.append(removeButton);
    dealerList.append(card);
  }
  renderCardDealerFinder();
  renderHomeTransitBoard();
  renderPendingCenter();
}

function initDealerPage() {
  const dealerName = getDealerNameFromUrl();
  const dealerTitle = document.querySelector("#dealerTitle");
  const dealerRate = document.querySelector("#dealerRate");
  const dealerExpense = document.querySelector("#dealerExpense");
  const dealerExtraPay = document.querySelector("#dealerExtraPay");
  const dealerBlastDeduct = document.querySelector("#dealerBlastDeduct");
  const dealerBlastCards = document.querySelector("#dealerBlastCards");
  const recordFormPanel = document.querySelector("#recordFormPanel");
  const form = document.querySelector("#recordForm");
  const statusForm = document.querySelector("#statusOptionForm");
  const newStatusOption = document.querySelector("#newStatusOption");
  const recordId = document.querySelector("#recordId");
  const formattedDetails = document.querySelector("#formattedDetails");
  const cardNumber = document.querySelector("#cardNumber");
  const carrier = document.querySelector("#carrier");
  const tailNumber = document.querySelector("#tailNumber");
  const warrantyDate = document.querySelector("#warrantyDate");
  const statusInput = document.querySelector("#status");
  const notes = document.querySelector("#notes");
  const submitButton = document.querySelector("#submitButton");
  const resetButton = document.querySelector("#resetButton");
  const searchInput = document.querySelector("#searchInput");
  const copyDealerLink = document.querySelector("#copyDealerLink");
  const payrollClearButton = document.querySelector("#payrollClearButton");
  const detailsDialog = document.querySelector("#detailsDialog");
  const detailsContent = document.querySelector("#detailsContent");
  const closeDetailsDialog = document.querySelector("#closeDetailsDialog");
  const copyDetailsButton = document.querySelector("#copyDetailsButton");

  if (!dealerName) {
    location.href = "./index.html";
    return;
  }

  dealerTitle.textContent = dealerName;
  saveDealer(dealerName);
  dealerRate.value = String(getDealerRate(dealerName));
  dealerExpense.value = String(getDealerExpense(dealerName) || "");
  dealerExtraPay.value = String(getDealerExtraPay(dealerName) || "");
  dealerBlastDeduct.value = String(getDealerBlastDeduct(dealerName) || "");
  dealerBlastCards.value = getDealerBlastCards(dealerName);
  dealerRate.addEventListener("change", async () => {
    await saveDealerRate(dealerName, Number(dealerRate.value));
  });
  dealerExpense.addEventListener("blur", async () => {
    await saveDealerExpense(dealerName, Number(dealerExpense.value || 0));
  });
  dealerExpense.addEventListener("input", async () => {
    await saveDealerExpense(dealerName, Number(dealerExpense.value || 0));
  });
  dealerExpense.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dealerExpense.blur();
    }
  });
  dealerExtraPay.addEventListener("input", async () => {
    await saveDealerExtraPay(dealerName, Number(dealerExtraPay.value || 0));
  });
  dealerExtraPay.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dealerExtraPay.blur();
    }
  });
  dealerBlastDeduct.addEventListener("input", async () => {
    await saveDealerBlastDeduct(dealerName, Number(dealerBlastDeduct.value || 0), dealerBlastCards.value);
  });
  dealerBlastDeduct.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dealerBlastDeduct.blur();
    }
  });
  dealerBlastCards.addEventListener("input", async () => {
    await saveDealerBlastDeduct(dealerName, Number(dealerBlastDeduct.value || 0), dealerBlastCards.value);
  });
  populateCarrierSelect(carrier);
  populateStatusSelect(statusInput, defaultNewRecordStatus);

  function resetForm() {
    form.reset();
    recordId.value = "";
    parsedDetailsDraft = {};
    populateCarrierSelect(carrier);
    populateStatusSelect(statusInput, defaultNewRecordStatus);
    submitButton.textContent = "添加记录";
    formattedDetails.focus();
  }

  function fillForm(record) {
    if (recordFormPanel) recordFormPanel.open = true;
    recordId.value = record.id;
    parsedDetailsDraft = {
      customerName: record.customerName || "",
      icNumber: record.icNumber || "",
      bankName: record.bankName || "",
      bankAccount: record.bankAccount || "",
      cardNumber: record.cardNumber || "",
      atmPin: record.atmPin || ""
    };
    formattedDetails.value = record.formattedDetails || "";
    cardNumber.value = record.cardNumber || "";
    populateCarrierSelect(carrier, record.carrier || malaysiaCouriers[0]);
    tailNumber.value = record.tailNumber || "";
    warrantyDate.value = record.warrantyDate || "";
    populateStatusSelect(statusInput, record.status || statusOptions[0] || "");
    notes.value = record.notes || "";
    submitButton.textContent = "保存修改";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  dealerPageFillForm = fillForm;

  statusForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const option = newStatusOption.value.trim();
    if (!option) return;
    await saveStatusOption(option);
    newStatusOption.value = "";
    populateStatusSelect(statusInput, statusInput.value);
    renderDealerPage(dealerName, fillForm);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const existing = records.find((record) => record.id === recordId.value);
    const isNewRecord = !existing;
    const manualFormattedDetails = formattedDetails.value;
    const detailsForSave = {
      ...parsedDetailsDraft,
      customerName: parsedDetailsDraft.customerName || existing?.customerName || "",
      icNumber: parsedDetailsDraft.icNumber || existing?.icNumber || "",
      bankName: parsedDetailsDraft.bankName || existing?.bankName || "",
      bankAccount: parsedDetailsDraft.bankAccount || existing?.bankAccount || "",
      cardNumber: cardNumber.value || parsedDetailsDraft.cardNumber || existing?.cardNumber || "",
      atmPin: parsedDetailsDraft.atmPin || existing?.atmPin || ""
    };
    const nextRecord = normalizeRecord({
      ...existing,
      dealerName,
      ...detailsForSave,
      formattedDetails: manualFormattedDetails || buildFormattedDetails(detailsForSave),
      carrier: carrier.value,
      tailNumber: tailNumber.value,
      warrantyDate: warrantyDate.value,
      status: statusInput.value,
      notes: notes.value
    }, existing?.id || recordId.value || createId());
    await saveRecord(nextRecord);
    if (isNewRecord) showSuccessToast();
    resetForm();
  });

  resetButton.addEventListener("click", resetForm);
  searchInput.addEventListener("input", () => renderDealerPage(dealerName, fillForm));
  document.querySelector("#recordSort")?.addEventListener("change", () => renderDealerPage(dealerName, fillForm));
  document.querySelector("#recordsBody")?.addEventListener("click", (event) => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    if (event.target.closest("button, input, select, textarea, a, label")) return;
    const row = event.target.closest(".record-row");
    if (!row) return;
    row.classList.toggle("is-open");
    row.setAttribute("aria-expanded", String(row.classList.contains("is-open")));
  });
  document.querySelector("#recordsBody")?.addEventListener("keydown", (event) => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("button, input, select, textarea, a, label")) return;
    const row = event.target.closest(".record-row");
    if (!row) return;
    event.preventDefault();
    row.classList.toggle("is-open");
    row.setAttribute("aria-expanded", String(row.classList.contains("is-open")));
  });
  copyDealerLink.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyDealerLink.textContent = "已复制";
      setTimeout(() => {
        copyDealerLink.textContent = "复制这个 Dealer 链接";
      }, 1200);
    } catch {
      prompt("复制这个链接", location.href);
    }
  });
  closeDetailsDialog.addEventListener("click", () => detailsDialog.close());
  copyDetailsButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(detailsContent.textContent);
    copyDetailsButton.textContent = "已复制";
    setTimeout(() => {
      copyDetailsButton.textContent = "复制资料";
    }, 1200);
  });
  payrollClearButton.addEventListener("click", async () => {
    const clearRecords = records.filter((record) => {
      return record.dealerName === dealerName && payrollClearStatuses.has(record.status);
    });
    if (!clearRecords.length) {
      alert("没有需要清理的已结算资料。");
      return;
    }
    const keepCount = records.filter((record) => {
      return record.dealerName === dealerName && ["寄", "车手已签收"].includes(record.status);
    }).length;
    const ok = confirm(`确认已出工资？\n\n将删除 ${clearRecords.length} 条：过保、开保、弹卡、人头关、人头偷钱、赔 150、炸。\n会保留 ${keepCount} 条：寄、车手已签收，带去下个月。`);
    if (!ok) return;
    await Promise.all(clearRecords.map((record) => deleteRecord(record.id)));
  });

  renderDealerPage(dealerName, fillForm);
}

function renderStatusOptionsList() {
  const statusOptionList = document.querySelector("#statusOptionList");
  if (!statusOptionList) return;
  statusOptionList.textContent = "";
  for (const option of normalizeStatusOptions(statusOptions)) {
    const item = document.createElement("span");
    item.className = "status-chip";
    const name = document.createElement("span");
    name.textContent = option;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "status-chip-delete";
    removeButton.textContent = "删除";
    removeButton.addEventListener("click", async () => {
      if (confirm(`删除状态选项「${option}」？`)) {
        await deleteStatusOption(option);
      }
    });
    item.append(name, removeButton);
    statusOptionList.append(item);
  }
}

function saveRecordField(record, field, value) {
  const current = record[field] || "";
  if (value === current) return;
  const nextRecord = { ...record, [field]: value, updatedAt: new Date().toISOString() };
  if (["customerName", "icNumber", "bankName", "bankAccount", "atmPin"].includes(field)) {
    nextRecord.formattedDetails = buildFormattedDetails(nextRecord);
  }
  saveRecord(nextRecord);
}

function editableInput(record, field, type = "text") {
  const input = document.createElement("input");
  input.className = "inline-edit";
  input.type = type;
  input.value = record[field] || "";
  input.addEventListener("blur", () => saveRecordField(record, field, input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
  return input;
}

function editableCarrierSelect(record) {
  const select = document.createElement("select");
  select.className = "inline-edit";
  populateCarrierSelect(select, record.carrier || malaysiaCouriers[0]);
  select.addEventListener("change", () => saveRecordField(record, "carrier", select.value));
  return select;
}

function statusClassName(status) {
  const source = String(status || "");
  if (source.includes("过保") || source.includes("杩囦繚")) return "status-expired";
  if (source.includes("开保") || source.includes("寮€淇")) return "status-opened";
  if (source.includes("人头关") || source.includes("人头偷钱") || source.includes("赔 150") || source.includes("赔150") || source.includes("浜哄ご鍏")) return "status-closed";
  if (source.includes("弹卡") || source.includes("寮瑰崱")) return "status-bounced";
  if (source.includes("炸") || source.includes("鐐")) return "status-rejected";
  if (source.includes("车手") || source.includes("签收") || source.includes("杞︽墜") || source.includes("绛炬敹")) return "status-signed";
  if (source.includes("寄") || source.includes("瀵")) return "status-sent";
  if (source.includes("完成") || source.includes("宸插畬")) return "status-done";
  if (source.includes("处理") || source.includes("澶勭悊")) return "status-processing";
  return "status-default";
}

async function checkTrackingRecord(record) {
  if (record.status !== "寄") {
    alert("只有状态为“寄”的记录需要检查快递。开保和其他状态已停止追踪。");
    return;
  }
  if (!record.trackingNumber) {
    alert("请先填写完整包裹单号，不能只填尾号码。");
    return;
  }
  checkingTrackingRecords.add(record.id);
  renderCurrentPage();
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 35000);
    const response = await fetch(`${trackingCheckEndpoint}?id=${encodeURIComponent(record.id)}`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.message || `HTTP ${response.status}`);
    if (!result.checked && !result.deleted && !result.skippedToday) {
      alert("没有查到这个包裹。请确认包裹公司和完整单号。");
    }
  } catch (error) {
    const message = error.name === "AbortError" ? "请求超时，Render 后台太久没有回应" : (error.message || "后台没有回应");
    alert(`检查失败：${message}`);
  } finally {
    if (timeout) clearTimeout(timeout);
    checkingTrackingRecords.delete(record.id);
    renderCurrentPage();
  }
}

function renderTrackingCell(record) {
  const wrap = document.createElement("div");
  wrap.className = "tracking-cell";

  const numberInput = document.createElement("input");
  numberInput.className = "inline-edit tracking-number-input";
  numberInput.value = record.trackingNumber || "";
  numberInput.placeholder = "完整单号";
  numberInput.addEventListener("blur", () => saveRecordField(record, "trackingNumber", numberInput.value.trim()));
  numberInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      numberInput.blur();
    }
  });

  const status = document.createElement("div");
  status.className = "tracking-status";
  status.textContent = record.packageStatus || "未检查";

  const meta = document.createElement("div");
  meta.className = "tracking-meta";
  meta.textContent = record.trackingMyCheckedAt ? `检查: ${formatTime(record.trackingMyCheckedAt)}` : "今天新增不会检查";
  if (record.trackingMyDetail) meta.title = record.trackingMyDetail;

  const detail = document.createElement("div");
  detail.className = "tracking-detail";
  detail.textContent = record.trackingMyDetail || "";
  if (!record.trackingMyDetail) detail.hidden = true;

  const checkButton = document.createElement("button");
  checkButton.type = "button";
  checkButton.className = "ghost compact-button tracking-check-button";
  const trackingActive = record.status === "寄";
  checkButton.textContent = trackingActive
    ? (checkingTrackingRecords.has(record.id) ? "检查中" : "检查")
    : "已停止追踪";
  checkButton.disabled = !trackingActive || checkingTrackingRecords.has(record.id);
  checkButton.addEventListener("click", () => checkTrackingRecord(record));

  const photoLink = document.createElement("a");
  photoLink.className = "ghost compact-button package-photo-link";
  photoLink.textContent = "包裹照片";
  photoLink.target = "_blank";
  photoLink.rel = "noopener";
  if (record.packagePhotoFileId) {
    photoLink.href = `${recordPhotoEndpoint}?id=${encodeURIComponent(record.id)}`;
  } else {
    photoLink.href = "#";
    photoLink.classList.add("is-disabled");
    photoLink.setAttribute("aria-disabled", "true");
    photoLink.addEventListener("click", (event) => {
      event.preventDefault();
      alert("这条记录还没有包裹照片。");
    });
  }

  const manualSelect = document.createElement("select");
  manualSelect.className = "inline-edit tracking-manual-select";
  const manualOptions = [
    ["", "\u624b\u52a8\u66f4\u65b0"],
    ["\u8fd0\u8f93\u4e2d", "\u8fd0\u8f93\u4e2d"],
    ["\u6d3e\u9001\u4e2d", "\u6d3e\u9001\u4e2d"],
    ["\u5df2\u9001\u8fbe", "\u5df2\u9001\u8fbe"],
    ["\u5f02\u5e38", "\u5f02\u5e38"]
  ];
  for (const [value, label] of manualOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (value && record.packageStatus === value) option.selected = true;
    manualSelect.append(option);
  }
  manualSelect.addEventListener("change", async () => {
    if (!manualSelect.value) return;
    const nextRecord = {
      ...record,
      packageStatus: manualSelect.value,
      trackingMyDetail: `\u624b\u52a8\u66f4\u65b0: ${manualSelect.value}`,
      trackingMyCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (manualSelect.value === "\u5df2\u9001\u8fbe") nextRecord.deliveredAt = malaysiaDateString();
    await saveRecord(nextRecord);
  });

  wrap.append(numberInput, status, meta, detail, checkButton, photoLink, manualSelect);
  return wrap;
}

function isRecordStale(record) {
  const status = String(record.status || "");
  const completedStatuses = ["过保", "弹卡", "人头关", "人头偷钱", "赔 150", "赔150"];
  if (completedStatuses.some((item) => status.includes(item))) return false;
  const updatedAt = record.updatedAt || record.createdAt;
  if (!updatedAt) return false;
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  return Date.now() - new Date(updatedAt).getTime() > fiveDaysMs;
}

function recordStatusGroup(record) {
  const status = String(record.status || "");
  if (status.includes("过保") || status.includes("开保") || status.includes("杩囦繚") || status.includes("寮€淇")) return "active";
  if (status.includes("弹卡") || status.includes("人头关") || status.includes("人头偷钱") || status.includes("赔 150") || status.includes("赔150") || status.includes("炸") || status.includes("寮瑰崱") || status.includes("浜哄ご鍏")) return "problem";
  return "";
}

function statusBoardIssueText(record) {
  const status = String(record.status || "").trim() || "-";
  const notes = String(record.notes || "").trim();
  const packageStatus = String(record.packageStatus || "").trim();
  const detail = notes || packageStatus;
  return detail ? `${status} · ${detail}` : status;
}

function renderStatusBoard(dealerRecords) {
  const activeList = document.querySelector("#activeStatusCards");
  const problemList = document.querySelector("#problemStatusCards");
  const activeCount = document.querySelector("#activeStatusCount");
  const problemCount = document.querySelector("#problemStatusCount");
  if (!activeList || !problemList) return;

  const groups = { active: [], problem: [] };
  for (const record of dealerRecords) {
    const group = recordStatusGroup(record);
    if (group) groups[group].push(record);
  }

  const renderList = (element, items) => {
    element.textContent = "";
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "status-board-empty";
      empty.textContent = "\u6ca1\u6709\u5361";
      element.append(empty);
      return;
    }
    items
      .sort((a, b) => String(a.cardNumber || "").localeCompare(String(b.cardNumber || "")))
      .forEach((record) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "status-board-item";
        item.innerHTML = `
          <strong>${escapeHtml(record.cardNumber || "-")}</strong>
          <span>${escapeHtml(statusBoardIssueText(record))}</span>
        `;
        item.addEventListener("click", () => dealerPageFillForm?.(record));
        element.append(item);
      });
  };

  activeCount.textContent = String(groups.active.length);
  problemCount.textContent = String(groups.problem.length);
  renderList(activeList, groups.active);
  renderList(problemList, groups.problem);
}

function recordStatusPriority(record) {
  const status = String(record.status || "").replace(/\s+/g, "");
  const packageStatus = String(record.packageStatus || "");
  if (status.includes("弹卡") || status.includes("人头关") || status.includes("人头偷钱") || status.includes("炸") || status.includes("赔")) return 1;
  if (status.includes("开保")) return 2;
  if (status.includes("车手已签收") || packageStatus.includes("已送达")) return 3;
  if (status.includes("寄")) return 4;
  if (status.includes("过保")) return 5;
  return 6;
}

function renderDealerPage(dealerName, fillForm) {
  const searchInput = document.querySelector("#searchInput");
  const recordsBody = document.querySelector("#recordsBody");
  const recordsPanel = document.querySelector(".records");
  const emptyState = document.querySelector("#emptyState");
  const totalCount = document.querySelector("#totalCount");
  const rowTemplate = document.querySelector("#recordRowTemplate");
  const staleAlert = document.querySelector("#staleAlert");
  const staleAlertText = document.querySelector("#staleAlertText");
  const recordSort = document.querySelector("#recordSort")?.value || "status-priority";
  const query = searchInput.value.trim().toLowerCase();
  const dealerRecords = records.filter((record) => record.dealerName === dealerName);
  const visibleRecords = records
    .filter((record) => record.dealerName === dealerName)
    .filter((record) => {
      return !query || [
        record.cardNumber,
        record.customerName,
        record.icNumber,
        record.bankName,
        record.bankAccount,
        record.atmPin,
        record.formattedDetails,
        record.carrier,
        record.trackingNumber,
        record.packageStatus,
        record.trackingMyDetail,
        record.tailNumber,
        record.warrantyDate,
        record.status,
        record.notes
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

  const textCompare = (a, b) => String(a || "").localeCompare(String(b || ""), "zh-CN", {
    numeric: true,
    sensitivity: "base"
  });
  visibleRecords.sort((a, b) => {
    if (recordSort === "status-priority") {
      return recordStatusPriority(a) - recordStatusPriority(b)
        || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
        || textCompare(a.cardNumber, b.cardNumber);
    }
    if (recordSort === "status") return textCompare(a.status, b.status) || textCompare(a.cardNumber, b.cardNumber);
    if (recordSort === "card") return textCompare(a.cardNumber, b.cardNumber);
    if (recordSort === "carrier") return textCompare(a.carrier, b.carrier) || textCompare(a.cardNumber, b.cardNumber);
    if (recordSort === "warranty-desc") {
      return String(b.warrantyDate || "").localeCompare(String(a.warrantyDate || "")) || textCompare(a.cardNumber, b.cardNumber);
    }
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });

  renderDealerMetrics(dealerRecords);
  renderStatusBoard(dealerRecords);
  renderStatusOptionsList();
  recordsBody.textContent = "";
  totalCount.textContent = String(visibleRecords.length);
  recordsPanel.classList.toggle("is-empty", visibleRecords.length === 0);
  const staleRecords = dealerRecords.filter(isRecordStale);
  staleAlert.hidden = staleRecords.length === 0;
  staleAlertText.textContent = staleRecords.length
    ? `${staleRecords.length} 条资料超过 5 天没有更新，请检查状态或备注。`
    : "";
  emptyState.querySelector("h2").textContent = query ? "没有找到记录" : "还没有记录";
  emptyState.querySelector("p").textContent = query
    ? "换一个关键词再试。"
    : "这个 Dealer 目前没有资料，可以在上面添加。";

  for (const record of visibleRecords) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.classList.add("record-row", statusClassName(record.status));
    row.dataset.card = record.cardNumber || "CARD";
    row.dataset.status = record.status || "-";
    row.dataset.parcel = `${record.carrier || ""}${record.tailNumber ? ` ${record.tailNumber}` : ""}`.trim() || "-";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-label", `${record.cardNumber || "卡号"}，点按查看资料`);
    if (isRecordStale(record)) row.classList.add("stale-row");
    const cells = row.querySelectorAll("td");
    [
      "record-card-number",
      "record-details",
      "record-carrier",
      "record-tail",
      "record-tracking",
      "record-warranty",
      "record-status",
      "record-notes",
      "record-updated",
      "record-actions"
    ].forEach((className, index) => cells[index]?.classList.add(className));
    cells[0].append(editableInput(record, "cardNumber"));
    const detailsButton = document.createElement("button");
    detailsButton.type = "button";
    detailsButton.className = "ghost compact-button";
    detailsButton.textContent = "查看";
    detailsButton.addEventListener("click", () => {
      const detailsDialog = document.querySelector("#detailsDialog");
      const detailsContent = document.querySelector("#detailsContent");
      detailsContent.textContent = record.formattedDetails || "没有保存完整资料";
      detailsDialog.showModal();
    });
    cells[1].append(detailsButton);
    cells[2].append(editableCarrierSelect(record));
    cells[3].append(editableInput(record, "tailNumber"));
    cells[4].append(renderTrackingCell(record));
    cells[5].append(editableInput(record, "warrantyDate", "date"));

    const statusSelect = document.createElement("select");
    statusSelect.className = `status-select ${statusClassName(record.status)}`;
    populateStatusSelect(statusSelect, record.status || statusOptions[0] || "");
    statusSelect.addEventListener("change", async () => {
      await saveRecord({ ...record, status: statusSelect.value, updatedAt: new Date().toISOString() });
    });
    cells[6].append(statusSelect);
    const notesInput = document.createElement("input");
    notesInput.className = "inline-edit inline-notes";
    notesInput.value = record.notes || "";
    notesInput.placeholder = "备注";
    notesInput.addEventListener("blur", async () => {
      if (notesInput.value !== (record.notes || "")) {
        await saveRecord({ ...record, notes: notesInput.value, updatedAt: new Date().toISOString() });
      }
    });
    notesInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        notesInput.blur();
      }
    });
    cells[7].append(notesInput);
    cells[8].textContent = formatTime(record.updatedAt);

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "ghost";
    editButton.textContent = "编辑";
    editButton.addEventListener("click", () => fillForm(record));

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger";
    removeButton.textContent = "删除";
    removeButton.addEventListener("click", async () => {
      if (confirm("删除这条记录？")) await deleteRecord(record.id);
    });

    cells[9].append(editButton, removeButton);
    recordsBody.append(row);
  }
}

function renderDealerMetrics(dealerRecords) {
  const metricTotal = document.querySelector("#metricTotal");
  const metricExpired = document.querySelector("#metricExpired");
  const metricSalary = document.querySelector("#metricSalary");
  const metricSalaryNote = document.querySelector("#metricSalaryNote");
  const metricUpdated = document.querySelector("#metricUpdated");
  const dealerRate = document.querySelector("#dealerRate");
  if (!metricTotal || !metricSalary || !metricUpdated) return;

  const dealerName = getDealerNameFromUrl();
  const salaryInfo = calculateSalary(dealerName);
  const lastUpdated = dealerRecords
    .map((record) => record.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  metricTotal.textContent = String(dealerRecords.length);
  if (metricExpired) metricExpired.textContent = String(salaryInfo.expiredCount);
  metricSalary.textContent = `RM${salaryInfo.salary}`;
  if (metricSalaryNote) {
    const breakdownGroups = [
      ["卡量结构", "cards", [
        ["原价", salaryInfo.fullCount, "main"],
        ["半价算业绩", salaryInfo.performanceHalfCount, "normal"],
        ["半价不算", salaryInfo.nonPerformanceHalfCount, "muted"],
        ["赔150", salaryInfo.compensationCount, "normal"]
      ]],
      ["计薪口径", "calc", [
        ["业绩", salaryInfo.performanceCount, "main"],
        ["开销扣卡", salaryInfo.expenseCards, "deduct"],
        ["计薪原价", salaryInfo.paidFullCount, "main"],
        ["加钱张数", salaryInfo.bonusEligibleCount, "normal"]
      ]],
      ["金额结算", "money", [
        ["卡钱", `RM${salaryInfo.cardPay}`, "main"],
        ["底薪", `RM${salaryInfo.basePay}`, "main"],
        ["加钱", `RM${salaryInfo.bonus}`, "normal"],
        ["额外", `RM${salaryInfo.extraPay}`, "normal"],
        ["上月炸扣", `RM${salaryInfo.blastDeduct}`, "deduct"]
      ]]
    ];
    metricSalaryNote.innerHTML = breakdownGroups.map(([title, tone, items]) => `
      <span class="salary-group salary-group-${escapeHtml(tone)}">
        <small class="salary-group-title">${escapeHtml(title)}</small>
        <span class="salary-group-lines">
          ${items.map(([label, value, emphasis]) => `
            <span class="salary-line salary-line-${escapeHtml(emphasis)}">
              <b>${escapeHtml(label)}</b>
              <small>${escapeHtml(value)}</small>
            </span>
          `).join("")}
        </span>
      </span>
    `).join("");
  }
  metricUpdated.textContent = lastUpdated ? formatTime(lastUpdated) : "-";
  if (dealerRate) dealerRate.value = String(salaryInfo.rate);
  const dealerExpense = document.querySelector("#dealerExpense");
  if (dealerExpense && document.activeElement !== dealerExpense) {
    dealerExpense.value = salaryInfo.expenseCards ? String(salaryInfo.expenseCards) : "";
  }
  const dealerExtraPay = document.querySelector("#dealerExtraPay");
  if (dealerExtraPay && document.activeElement !== dealerExtraPay) {
    dealerExtraPay.value = salaryInfo.extraPay ? String(salaryInfo.extraPay) : "";
  }
  const dealerBlastDeduct = document.querySelector("#dealerBlastDeduct");
  if (dealerBlastDeduct && document.activeElement !== dealerBlastDeduct) {
    dealerBlastDeduct.value = salaryInfo.blastDeduct ? String(salaryInfo.blastDeduct) : "";
  }
  const dealerBlastCards = document.querySelector("#dealerBlastCards");
  if (dealerBlastCards && document.activeElement !== dealerBlastCards) {
    dealerBlastCards.value = getDealerBlastCards(getDealerNameFromUrl());
  }
}

function renderCurrentPage() {
  if (isDealerPage) {
    const title = document.querySelector("#dealerTitle");
    if (title && dealerPageFillForm) {
      populateStatusSelect(document.querySelector("#status"), document.querySelector("#status").value);
      renderDealerPage(getDealerNameFromUrl(), dealerPageFillForm);
    }
  } else {
    renderIndexPage();
  }
}

async function autoExpireWarrantyRecords(updateRecord) {
  if (typeof updateRecord !== "function") return;
  const today = malaysiaDateString();
  const expiringRecords = records.filter((record) => {
    const days = Number(record.warrantyDays || 0);
    const expireDate = addDays(record.warrantyDate, days);
    return record.status === "开保" && days > 0 && expireDate && today >= expireDate;
  });
  for (const record of expiringRecords) {
    await updateRecord({
      ...record,
      status: "过保",
      updatedAt: new Date().toISOString()
    });
  }
}

async function initLocalMode() {
  records = readJson(localKey);
  dealers = readJson(dealerListKey);
  pendingImports = readJson(pendingImportsKey);
  unknownDriverCards = readJson(unknownDriverCardsKey);
  statusOptions = normalizeStatusOptions(readJson(statusOptionsKey, defaultStatusOptions));
  noticeText = localStorage.getItem(noticeKey) || "";

  saveDealer = async (name) => {
    if (!dealers.some((dealer) => dealer.name === name)) {
      dealers.push({ name, rate: 500, createdAt: new Date().toISOString() });
      writeJson(dealerListKey, dealers);
    }
    renderCurrentPage();
  };
  saveDealerRate = async (name, rate) => {
    const existing = getDealerInfo(name);
    const index = dealers.findIndex((dealer) => dealer.name === name);
    const nextDealer = { ...existing, name, rate, updatedAt: new Date().toISOString() };
    if (index >= 0) dealers[index] = nextDealer;
    else dealers.push(nextDealer);
    writeJson(dealerListKey, dealers);
    renderCurrentPage();
  };
  saveDealerExpense = async (name, expenseCards) => {
    const existing = getDealerInfo(name);
    const index = dealers.findIndex((dealer) => dealer.name === name);
    const nextDealer = { ...existing, name, expenseCards, updatedAt: new Date().toISOString() };
    if (index >= 0) dealers[index] = nextDealer;
    else dealers.push(nextDealer);
    writeJson(dealerListKey, dealers);
    renderCurrentPage();
  };
  saveDealerExtraPay = async (name, extraPay) => {
    const existing = getDealerInfo(name);
    const index = dealers.findIndex((dealer) => dealer.name === name);
    const nextDealer = { ...existing, name, extraPay, updatedAt: new Date().toISOString() };
    if (index >= 0) dealers[index] = nextDealer;
    else dealers.push(nextDealer);
    writeJson(dealerListKey, dealers);
    renderCurrentPage();
  };
  saveDealerBlastDeduct = async (name, blastDeduct, blastCards = getDealerBlastCards(name)) => {
    const existing = getDealerInfo(name);
    const index = dealers.findIndex((dealer) => dealer.name === name);
    const nextDealer = { ...existing, name, blastDeduct, blastCards, updatedAt: new Date().toISOString() };
    if (index >= 0) dealers[index] = nextDealer;
    else dealers.push(nextDealer);
    writeJson(dealerListKey, dealers);
    renderCurrentPage();
  };
  deleteDealer = async (name) => {
    dealers = dealers.filter((dealer) => dealer.name !== name);
    records = records.filter((record) => record.dealerName !== name);
    writeJson(dealerListKey, dealers);
    writeJson(localKey, records);
    renderCurrentPage();
  };
  saveStatusOption = async (name) => {
    statusOptions = normalizeStatusOptions([...statusOptions, name]);
    writeJson(statusOptionsKey, statusOptions);
    renderCurrentPage();
  };
  deleteStatusOption = async (name) => {
    statusOptions = statusOptions.filter((option) => option !== name);
    writeJson(statusOptionsKey, statusOptions);
    renderCurrentPage();
  };
  saveNotice = async (message) => {
    noticeText = message;
    localStorage.setItem(noticeKey, message);
    renderCurrentPage();
  };
  saveRecord = async (record) => {
    const index = records.findIndex((item) => item.id === record.id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    writeJson(localKey, records);
    await saveDealer(record.dealerName);
    renderCurrentPage();
  };
  deleteRecord = async (id) => {
    records = records.filter((record) => record.id !== id);
    writeJson(localKey, records);
    renderCurrentPage();
  };
  resolvePendingImport = async (id, values) => {
    const pending = pendingImports.find((item) => item.id === id);
    if (!pending) return;
    const record = recordFromPendingImport(pending, values);
    await saveRecord(record);
    pendingImports = pendingImports.filter((item) => item.id !== id);
    writeJson(pendingImportsKey, pendingImports);
    renderCurrentPage();
  };
  deletePendingImport = async (id) => {
    pendingImports = pendingImports.filter((item) => item.id !== id);
    writeJson(pendingImportsKey, pendingImports);
    renderCurrentPage();
  };
  deleteUnknownDriverCard = async (id) => {
    unknownDriverCards = unknownDriverCards.filter((item) => item.id !== id);
    writeJson(unknownDriverCardsKey, unknownDriverCards);
    renderCurrentPage();
  };
  assignUnknownDriverCard = async (id, dealerName) => {
    const item = unknownDriverCards.find((entry) => entry.id === id);
    if (!item) return;
    const record = recordFromUnknownDriverCard(item, dealerName);
    await saveRecord(record);
    unknownDriverCards = unknownDriverCards.filter((entry) => entry.id !== id);
    writeJson(unknownDriverCardsKey, unknownDriverCards);
    renderCurrentPage();
  };

  setSyncStatus("offline", "本机保存，未开启同步");
  await autoExpireWarrantyRecords(saveRecord);
}

async function initFirebaseMode() {
  try {
    const [{ initializeApp }, database] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js")
    ]);
    const { getDatabase, ref, get, onValue, set, remove, update } = database;
    const app = initializeApp(window.FIREBASE_CONFIG);
    const db = getDatabase(app);
    const recordsRef = ref(db, "dealer-card-tracker/records");
    const dealersRef = ref(db, "dealer-card-tracker/dealers");
    const statusOptionsRef = ref(db, "dealer-card-tracker/statusOptions");
    const humanStealingStatusMigrationRef = ref(db, "dealer-card-tracker/settings/migrations/humanStealingStatus");
    const compensationStatusMigrationRef = ref(db, "dealer-card-tracker/settings/migrations/compensation150Status");
    const noticeRef = ref(db, "dealer-card-tracker/notice");
    const pendingImportsRef = ref(db, "dealer-card-tracker/pendingImports");
    const unknownDriverCardsRef = ref(db, "dealer-card-tracker/unknownDriverCards");
    let isAutoExpiring = false;

    saveDealer = async (name) => {
      await update(ref(db, `dealer-card-tracker/dealers/${firebaseKey(name)}`), {
        name,
        createdAt: getDealerInfo(name).createdAt || new Date().toISOString()
      });
    };
    saveDealerRate = async (name, rate) => {
      await update(ref(db, `dealer-card-tracker/dealers/${firebaseKey(name)}`), {
        name,
        rate,
        updatedAt: new Date().toISOString()
      });
    };
    saveDealerExpense = async (name, expenseCards) => {
      await update(ref(db, `dealer-card-tracker/dealers/${firebaseKey(name)}`), {
        name,
        expenseCards,
        updatedAt: new Date().toISOString()
      });
    };
    saveDealerExtraPay = async (name, extraPay) => {
      await update(ref(db, `dealer-card-tracker/dealers/${firebaseKey(name)}`), {
        name,
        extraPay,
        updatedAt: new Date().toISOString()
      });
    };
    saveDealerBlastDeduct = async (name, blastDeduct, blastCards = getDealerBlastCards(name)) => {
      await update(ref(db, `dealer-card-tracker/dealers/${firebaseKey(name)}`), {
        name,
        blastDeduct,
        blastCards,
        updatedAt: new Date().toISOString()
      });
    };
    deleteDealer = async (name) => {
      const deleteTasks = records
        .filter((record) => record.dealerName === name)
        .map((record) => remove(ref(db, `dealer-card-tracker/records/${record.id}`)));
      deleteTasks.push(remove(ref(db, `dealer-card-tracker/dealers/${firebaseKey(name)}`)));
      await Promise.all(deleteTasks);
    };
    saveStatusOption = async (name) => set(ref(db, `dealer-card-tracker/statusOptions/${encodeURIComponent(name)}`), {
      name,
      createdAt: new Date().toISOString()
    });
    deleteStatusOption = async (name) => remove(ref(db, `dealer-card-tracker/statusOptions/${encodeURIComponent(name)}`));
    saveNotice = async (message) => set(noticeRef, {
      message,
      updatedAt: new Date().toISOString()
    });
    saveRecord = async (record) => {
      await saveDealer(record.dealerName);
      await set(ref(db, `dealer-card-tracker/records/${record.id}`), record);
    };
    deleteRecord = async (id) => remove(ref(db, `dealer-card-tracker/records/${id}`));
    resolvePendingImport = async (id, values) => {
      const pending = pendingImports.find((item) => item.id === id);
      if (!pending) return;
      const record = recordFromPendingImport(pending, values);
      await saveRecord(record);
      await remove(ref(db, `dealer-card-tracker/pendingImports/${id}`));
    };
    deletePendingImport = async (id) => remove(ref(db, `dealer-card-tracker/pendingImports/${id}`));
    deleteUnknownDriverCard = async (id) => remove(ref(db, `dealer-card-tracker/unknownDriverCards/${id}`));
    assignUnknownDriverCard = async (id, dealerName) => {
      const item = unknownDriverCards.find((entry) => entry.id === id);
      if (!item) return;
      const record = recordFromUnknownDriverCard(item, dealerName);
      await saveRecord(record);
      await remove(ref(db, `dealer-card-tracker/unknownDriverCards/${id}`));
    };

    if (!(await get(humanStealingStatusMigrationRef)).val()) {
      await set(ref(db, `dealer-card-tracker/statusOptions/${encodeURIComponent("人头偷钱")}`), {
        name: "人头偷钱",
        createdAt: new Date().toISOString()
      });
      await set(humanStealingStatusMigrationRef, true);
    }
    if (!(await get(compensationStatusMigrationRef)).val()) {
      await set(ref(db, `dealer-card-tracker/statusOptions/${encodeURIComponent("赔 150")}`), {
        name: "赔 150",
        createdAt: new Date().toISOString()
      });
      await set(compensationStatusMigrationRef, true);
    }

    onValue(dealersRef, (snapshot) => {
      dealers = Object.values(snapshot.val() || {});
      setSyncStatus("online", "多人实时同步已开启");
      renderCurrentPage();
    });
    onValue(statusOptionsRef, (snapshot) => {
      statusOptions = normalizeStatusOptions(Object.values(snapshot.val() || {}));
      setSyncStatus("online", "多人实时同步已开启");
      renderCurrentPage();
    });
    onValue(noticeRef, (snapshot) => {
      noticeText = snapshot.val()?.message || "";
      setSyncStatus("online", "多人实时同步已开启");
      renderCurrentPage();
    });
    onValue(recordsRef, (snapshot) => {
      const value = snapshot.val() || {};
      records = Object.entries(value).map(([id, record]) => ({ id, ...record }));
      setSyncStatus("online", "多人实时同步已开启");
      renderCurrentPage();
      if (!isAutoExpiring) {
        isAutoExpiring = true;
        autoExpireWarrantyRecords(async (record) => {
          await update(ref(db, `dealer-card-tracker/records/${record.id}`), {
            status: record.status,
            updatedAt: record.updatedAt
          });
        }).finally(() => {
          isAutoExpiring = false;
        });
      }
    });
    onValue(pendingImportsRef, (snapshot) => {
      pendingImports = Object.entries(snapshot.val() || {}).map(([id, item]) => ({ id, ...item }));
      setSyncStatus("online", "多人实时同步已开启");
      renderCurrentPage();
    });
    onValue(unknownDriverCardsRef, (snapshot) => {
      unknownDriverCards = Object.entries(snapshot.val() || {}).map(([id, item]) => ({ id, ...item }));
      setSyncStatus("online", "多人实时同步已开启");
      renderCurrentPage();
    });
  } catch {
    await initLocalMode();
    setSyncStatus("offline", "同步载入失败，先使用本机保存");
  }
}

async function initApp() {
  if (hasFirebaseConfig()) {
    await initFirebaseMode();
  } else {
    await initLocalMode();
  }

  if (isDealerPage) {
    initDealerPage();
  } else {
    initIndexPage();
  }

  setMobileViewFromHash();
  window.addEventListener("hashchange", setMobileViewFromHash);
}

function setMobileViewFromHash() {
  const id = decodeURIComponent(location.hash || "").replace(/^#/, "");
  const viewById = {
    mobileHome: "home",
    mobilePackages: "packages",
    mobileDealers: "dealers",
    mobileAddDealer: "add",
    dealerRecords: "records",
    recordFormPanel: "add"
  };
  const nextView = viewById[id] || (isDealerPage ? "records" : "home");
  document.body.dataset.mobileView = nextView;
  document.querySelectorAll(".mobile-tabbar a").forEach((link) => {
    const linkId = decodeURIComponent(link.hash || "").replace(/^#/, "");
    link.classList.toggle("active", (viewById[linkId] || "") === nextView);
  });
  const target = document.getElementById(id);
  if (target?.tagName === "DETAILS") target.open = true;
}

document.querySelector('.dealer-page .mobile-tabbar a[href="#recordFormPanel"]')?.addEventListener("click", () => {
  document.body.dataset.mobileView = "add";
  const panel = document.querySelector("#recordFormPanel");
  if (panel) panel.open = true;
  document.querySelectorAll(".mobile-tabbar a").forEach((link) => {
    link.classList.toggle("active", link.hash === "#recordFormPanel");
  });
});

initApp();
