const localKey = "dealer-card-tracker-records";
const dealerListKey = "dealer-card-tracker-dealers";
const statusOptionsKey = "dealer-card-tracker-status-options";
const noticeKey = "dealer-card-tracker-notice";
const defaultStatusOptions = ["未处理", "处理中", "已寄出", "已完成", "过保", "开保", "寄", "车手已签收", "弹卡", "人头关", "炸"];
const defaultNewRecordStatus = "寄";
const salaryStatuses = new Set(["过保", "开保"]);
const payrollClearStatuses = new Set(["过保", "开保", "弹卡", "人头关", "炸"]);
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
let saveRecord;
let deleteRecord;
let saveDealer;
let deleteDealer;
let saveDealerRate;
let saveDealerExpense;
let saveDealerExtraPay;
let saveStatusOption;
let deleteStatusOption;
let saveNotice;
let dealerPageFillForm = null;
let firebaseStatusOptionsLoaded = false;
let parsedDetailsDraft = {};

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

function dealerUrl(name) {
  return `./dealer.html?name=${encodeURIComponent(name)}`;
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

function detectSalaryBank(record) {
  const source = `${record.cardNumber || ""} ${record.bankName || ""} ${record.formattedDetails || ""}`.toUpperCase();
  const compactSource = source.replace(/[^A-Z0-9]/g, "");
  const tokens = source.split(/[^A-Z0-9]+/).filter(Boolean);
  const hasToken = (...items) => items.some((item) => tokens.includes(item));
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
  const expenseCards = getDealerExpense(dealerName);
  const extraPay = getDealerExtraPay(dealerName);
  const expiredRecords = records.filter((record) => record.dealerName === dealerName && salaryStatuses.has(record.status));
  const fullBanks = new Set(["MBB", "CIMB", "AFFIN", "AGRO", "MUAMALAT", "RHB", "HLB", "RAKYAT", "AMBANK", "ALLIANCE"]);
  const halfBanks = new Set(["BSN", "BANK ISLAM"]);
  const performanceHalfBanks = new Set(["BSN"]);
  const fullPay = rate === 500 ? 500 : 300;
  const halfPay = rate === 500 ? 200 : 150;
  let fullCount = 0;
  let halfCount = 0;
  let performanceHalfCount = 0;
  let cardPay = 0;

  for (const record of expiredRecords) {
    const bank = detectSalaryBank(record);
    if (fullBanks.has(bank)) {
      fullCount += 1;
      cardPay += fullPay;
    } else if (halfBanks.has(bank)) {
      halfCount += 1;
      cardPay += halfPay;
      if (performanceHalfBanks.has(bank)) performanceHalfCount += 1;
    }
  }

  const performanceCount = fullCount + performanceHalfCount;
  const paidFullCount = Math.max(0, performanceCount - expenseCards);
  const basePay = rate === 500
    ? (paidFullCount >= 10 ? 1500 : 0)
    : (paidFullCount >= 7 ? 1500 : paidFullCount >= 3 ? 700 : 0);
  const bonus = paidFullCount >= 15 ? paidFullCount * 50 : 0;
  const paidCardPay = (paidFullCount * fullPay) + (halfCount * halfPay);

  return {
    rate,
    expenseCards,
    extraPay,
    expiredCount: expiredRecords.length,
    grossSalary: cardPay + basePay + bonus,
    salary: paidCardPay + basePay + bonus + extraPay,
    basePay,
    fullCount,
    performanceCount,
    paidFullCount,
    halfCount,
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
    tailNumber: data.tailNumber.trim(),
    warrantyDate: data.warrantyDate || "",
    status: data.status || firstStatus,
    notes: data.notes.trim(),
    updatedAt: now,
    createdAt: data.createdAt || now
  };
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

  searchInput.addEventListener("input", renderIndexPage);
  renderIndexPage();
}

function renderIndexPage() {
  const dealerList = document.querySelector("#dealerList");
  const emptyState = document.querySelector("#emptyState");
  const totalCount = document.querySelector("#totalCount");
  const heroDealerCount = document.querySelector("#heroDealerCount");
  const noticeMessage = document.querySelector("#noticeMessage");
  const searchInput = document.querySelector("#searchInput");
  const query = searchInput.value.trim().toLowerCase();
  const names = uniqueDealers().filter((name) => !query || name.toLowerCase().includes(query));

  dealerList.textContent = "";
  totalCount.textContent = String(names.length);
  if (heroDealerCount) heroDealerCount.textContent = String(uniqueDealers().length);
  if (noticeMessage) noticeMessage.textContent = noticeText || "暂无通知";
  emptyState.style.display = names.length ? "none" : "block";

  for (const name of names) {
    const stats = dealerStats(name);
    const card = document.createElement("div");
    card.className = "dealer-card";
    card.innerHTML = `
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
}

function initDealerPage() {
  const dealerName = getDealerNameFromUrl();
  const dealerTitle = document.querySelector("#dealerTitle");
  const dealerRate = document.querySelector("#dealerRate");
  const dealerExpense = document.querySelector("#dealerExpense");
  const dealerExtraPay = document.querySelector("#dealerExtraPay");
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
    const ok = confirm(`确认已出工资？\n\n将删除 ${clearRecords.length} 条：过保、开保、弹卡、人头关。\n会保留 ${keepCount} 条：寄、车手已签收，带去下个月。`);
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

function isRecordStale(record) {
  const updatedAt = record.updatedAt || record.createdAt;
  if (!updatedAt) return false;
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  return Date.now() - new Date(updatedAt).getTime() > fiveDaysMs;
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
        record.tailNumber,
        record.warrantyDate,
        record.status,
        record.notes
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  renderDealerMetrics(dealerRecords);
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
    if (isRecordStale(record)) row.classList.add("stale-row");
    const cells = row.querySelectorAll("td");
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
    cells[4].append(editableInput(record, "warrantyDate", "date"));

    const statusSelect = document.createElement("select");
    statusSelect.className = "status-select";
    populateStatusSelect(statusSelect, record.status || statusOptions[0] || "");
    statusSelect.addEventListener("change", async () => {
      await saveRecord({ ...record, status: statusSelect.value, updatedAt: new Date().toISOString() });
    });
    cells[5].append(statusSelect);
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
    cells[6].append(notesInput);
    cells[7].textContent = formatTime(record.updatedAt);

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

    cells[8].append(editButton, removeButton);
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
  if (!metricTotal || !metricExpired || !metricSalary || !metricUpdated) return;

  const dealerName = getDealerNameFromUrl();
  const salaryInfo = calculateSalary(dealerName);
  const lastUpdated = dealerRecords
    .map((record) => record.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  metricTotal.textContent = String(dealerRecords.length);
  metricExpired.textContent = String(salaryInfo.expiredCount);
  metricSalary.textContent = `RM${salaryInfo.salary}`;
  if (metricSalaryNote) {
    metricSalaryNote.textContent =
      `原价${salaryInfo.fullCount} · 半价${salaryInfo.halfCount} · 业绩${salaryInfo.performanceCount} · 开销${salaryInfo.expenseCards} · 计薪${salaryInfo.paidFullCount} · 底薪RM${salaryInfo.basePay} · 加钱RM${salaryInfo.bonus} · 额外RM${salaryInfo.extraPay}`;
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

async function initLocalMode() {
  records = readJson(localKey);
  dealers = readJson(dealerListKey);
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

  setSyncStatus("offline", "本机保存，未开启同步");
}

async function initFirebaseMode() {
  try {
    const [{ initializeApp }, database] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js")
    ]);
    const { getDatabase, ref, onValue, set, remove, update } = database;
    const app = initializeApp(window.FIREBASE_CONFIG);
    const db = getDatabase(app);
    const recordsRef = ref(db, "dealer-card-tracker/records");
    const dealersRef = ref(db, "dealer-card-tracker/dealers");
    const statusOptionsRef = ref(db, "dealer-card-tracker/statusOptions");
    const noticeRef = ref(db, "dealer-card-tracker/notice");

    saveDealer = async (name) => {
      await update(ref(db, `dealer-card-tracker/dealers/${encodeURIComponent(name)}`), {
        name,
        createdAt: getDealerInfo(name).createdAt || new Date().toISOString()
      });
    };
    saveDealerRate = async (name, rate) => {
      await update(ref(db, `dealer-card-tracker/dealers/${encodeURIComponent(name)}`), {
        name,
        rate,
        updatedAt: new Date().toISOString()
      });
    };
    saveDealerExpense = async (name, expenseCards) => {
      await update(ref(db, `dealer-card-tracker/dealers/${encodeURIComponent(name)}`), {
        name,
        expenseCards,
        updatedAt: new Date().toISOString()
      });
    };
    saveDealerExtraPay = async (name, extraPay) => {
      await update(ref(db, `dealer-card-tracker/dealers/${encodeURIComponent(name)}`), {
        name,
        extraPay,
        updatedAt: new Date().toISOString()
      });
    };
    deleteDealer = async (name) => {
      const deleteTasks = records
        .filter((record) => record.dealerName === name)
        .map((record) => remove(ref(db, `dealer-card-tracker/records/${record.id}`)));
      deleteTasks.push(remove(ref(db, `dealer-card-tracker/dealers/${encodeURIComponent(name)}`)));
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
}

initApp();
