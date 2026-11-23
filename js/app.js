// 主程式：管理資料狀態，處理表單、同步與匯出，並在資料變動時更新整個畫面

import { loadRecords, buildDays, latestKhDay, currentDose, isCounted, formatShortDate } from './data.js';
import { renderCharts } from './chart.js';
import { renderTiles, renderAnalysis, renderMethods, renderTable, windowOptions } from './render.js';
import {
  emptyChanges, loadChanges, saveChanges, countChanges, describeChanges,
  applyChanges, cleanChanges, upgradeChanges, isSameRecord,
  toJsonText, toCsvText, downloadText,
} from './storage.js';
import { getToken, saveToken, removeToken, fetchRemoteRecords, pushRemoteRecords } from './github.js';
import { TARGET_KH, TANK_LITERS } from './config.js';

const TABLE_LIMIT = 30;            // 表格預設只顯示最新的幾筆
const RANGE_KEY = 'reef-kh:range'; // 記住上次選的圖表時間範圍
const DEFAULT_RANGE = 90;

const $ = (selector) => document.querySelector(selector);

const statusEl = $('#status');
const tilesEl = $('#tiles');
const tbody = $('#kh-body');
const showAllButton = $('#show-all-button');
const form = $('#record-form');
const formTitle = $('#form-title');
const formMessage = $('#form-message');
const submitButton = $('#submit-button');
const cancelButton = $('#cancel-button');
const exportInfo = $('#export-info');
const syncButton = $('#sync-button');
const syncMessage = $('#sync-message');
const discardButton = $('#discard-button');
const tokenInput = $('#token-input');
const tokenSaveButton = $('#token-save-button');
const tokenRemoveButton = $('#token-remove-button');
const tokenState = $('#token-state');
const tokenMessage = $('#token-message');
const rangeButtons = document.querySelectorAll('[data-range]');
const windowSelect = $('#window-select');
const reachDaysInput = $('#reach-days');

// 畫面顯示的資料 = 資料檔裡的紀錄 + 在瀏覽器裡做的變更
let fileRecords = [];          // 資料檔裡的紀錄（來自網站上的檔案，或 GitHub 上的最新版本）
let source = 'file';           // 資料檔的來源：'file' 或 'github'
let changes = emptyChanges();  // 尚未儲存的新增、修改、刪除
let records = [];              // 套用變更後的所有紀錄（畫面上顯示的就是這份）
let origin = new Map();        // 每一筆紀錄的來源：資料檔、新增的、還是修改過的
let days = [];                 // 由 records 整理出來的每日資料
let editing = null;            // 正在編輯的那一筆；null 代表目前是「新增」模式
let charts = null;             // 圖表只建立一次，之後用 charts.update() 重畫
let rangeDays = DEFAULT_RANGE; // 圖表顯示最近幾天；0 代表全部
let showAllRows = false;       // 表格是否顯示全部紀錄
let syncing = false;           // 是否正在同步


// ===== 重新整理整個畫面 =====

// 資料有任何變動（載入完成、新增、修改、刪除、同步）都呼叫這個函式
function refresh() {
  ({ records, origin } = applyChanges(fileRecords, changes));
  days = buildDays(records);

  // 正在編輯的紀錄如果已經不存在（例如同步後資料更新了），就回到新增模式
  if (editing !== null && !origin.has(editing)) {
    resetForm();
  }

  renderRecordsTable();
  renderSaveArea();
  statusEl.classList.remove('error');

  // 沒有任何有效讀值時，把統計、圖表、分析都藏起來
  const latest = latestKhDay(days);
  document.body.classList.toggle('no-data', latest === null);
  if (latest === null) {
    statusEl.textContent = '目前沒有可用的 KH 紀錄';
    return;
  }

  renderTiles(tilesEl, days);
  renderWindowOptions();
  renderAnalysisSection();
  renderMethods($('#methods-result'), records);

  if (charts === null) {
    charts = renderCharts({
      khBox: $('#kh-chart'),
      doseBox: $('#dose-chart'),
      area: $('#chart-area'),
      tooltip: $('#tooltip'),
      legend: $('#legend'),
      target: TARGET_KH,
    });
  }
  charts.update(days, rangeDays);

  const measuredDays = days.filter((day) => day.kh !== null).length;
  const notCounted = records.filter((record) => !isCounted(record)).length;
  statusEl.textContent =
    `${days[0].date} 至 ${days[days.length - 1].date}，共 ${measuredDays} 個測量日、${records.length} 筆讀值` +
    `（其中 ${notCounted} 筆不納入統計）`;
}

function renderRecordsTable() {
  renderTable(tbody, records, {
    origin,
    editing,
    limit: showAllRows ? 0 : TABLE_LIMIT,
    onEdit: startEdit,
    onDelete: deleteRecord,
  });
  showAllButton.hidden = showAllRows || records.length <= TABLE_LIMIT;
  showAllButton.textContent = `顯示全部 ${records.length} 筆`;
}

// 「計算區間」選單：選項會隨資料改變（例如新增了事件），重建時保留原本選的項目
function renderWindowOptions() {
  const selected = windowSelect.value || '14';
  const options = windowOptions(days);
  windowSelect.replaceChildren(...options.map((option) => {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    return element;
  }));
  windowSelect.value = options.some((option) => option.value === selected) ? selected : '14';
}

function renderAnalysisSection() {
  renderAnalysis(
    { result: $('#analysis-result'), message: $('#analysis-message'), basis: $('#analysis-basis') },
    days,
    { windowValue: windowSelect.value, reachDays: Number(reachDaysInput.value) },
  );
}

// 表單下方的儲存狀態：還有幾項變更沒儲存，以及要顯示哪些按鈕
function renderSaveArea() {
  const count = countChanges(changes);
  const hasToken = getToken() !== '';

  discardButton.hidden = count === 0;
  syncButton.hidden = !hasToken;
  syncButton.disabled = syncing || count === 0;

  if (count === 0) {
    exportInfo.textContent = source === 'github'
      ? '所有紀錄都已同步到 GitHub。'
      : '所有紀錄都已寫入 data/kh-records.json。';
  } else if (hasToken) {
    exportInfo.textContent = `有 ${count} 項變更尚未同步到 GitHub（${describeChanges(changes)}）。`;
  } else {
    exportInfo.textContent =
      `有 ${count} 項變更只存在這個瀏覽器（${describeChanges(changes)}），尚未寫入 data/kh-records.json。`;
  }
}

// 存檔並重畫；回傳是否成功存入瀏覽器
function saveAndRefresh() {
  const saved = saveChanges(changes);
  refresh();
  return saved;
}


// ===== 表單 =====

// 今天的日期，格式 'YYYY-MM-DD'（用裝置的當地時間）
function todayText() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function showMessage(element, text, isError) {
  element.textContent = text;
  element.classList.toggle('error', isError === true);
}

// 依照目前的選擇，停用不適用的欄位：
// 標準液不是魚缸水，沒有添加量、換水、排除；沒填換水量時，不需要選換水前後
function updateFormState() {
  const fields = form.elements;
  const isTank = fields.type.value === 'tank';
  fields.dose_ml.disabled = !isTank;
  fields.water_change_l.disabled = !isTank;
  fields.exclude.disabled = !isTank;
  fields.water_change_timing.disabled = !isTank || fields.water_change_l.value === '';
}

// 新紀錄預設的測試方式：最近 10 筆有標示的紀錄中最常用的那一種
function defaultMethod() {
  const counts = {};
  records.filter((record) => record.method).slice(-10).forEach((record) => {
    counts[record.method] = (counts[record.method] ?? 0) + 1;
  });

  let best = '';
  Object.keys(counts).forEach((method) => {
    if (best === '' || counts[method] > counts[best]) {
      best = method;
    }
  });
  return best;
}

// 回到「新增」模式：清空表單，預設今天的日期、目前的添加量、最近常用的測試方式
function resetForm() {
  editing = null;
  form.reset();
  const fields = form.elements;
  fields.date.value = todayText();

  const dose = currentDose(days);
  fields.dose_ml.value = dose ? dose.dose : '';

  fields.method.value = defaultMethod();

  formTitle.textContent = '新增紀錄';
  submitButton.textContent = '新增';
  cancelButton.hidden = true;
  updateFormState();
}

// 進入「編輯」模式：把這筆紀錄的內容填進表單
function startEdit(record) {
  editing = record;
  const fields = form.elements;
  fields.date.value = record.date;
  fields.time.value = record.time ?? '';
  fields.kh.value = record.kh;
  fields.dose_ml.value = record.dose_ml ?? '';
  fields.type.value = record.type ?? 'tank';
  fields.method.value = record.method ?? '';
  fields.water_change_l.value = record.water_change_l ?? '';
  fields.water_change_timing.value = record.water_change_l > 0 ? (record.water_change_timing ?? '') : 'after';
  fields.event.value = record.event ?? '';
  fields.exclude.checked = record.exclude === true;
  fields.note.value = record.note ?? '';

  formTitle.textContent = `編輯紀錄（${record.date} KH ${record.kh.toFixed(1)}）`;
  submitButton.textContent = '儲存修改';
  cancelButton.hidden = false;
  showMessage(formMessage, '');
  updateFormState();
  renderRecordsTable(); // 重畫表格，標示正在編輯的那一列

  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  fields.kh.focus({ preventScroll: true });
}

function cancelEdit() {
  resetForm();
  renderRecordsTable();
  showMessage(formMessage, '已取消編輯。');
}

// 把表單欄位的內容組成一筆紀錄
function readForm() {
  // 從表單欄位讀出的值都是字串，數字要自己用 Number() 轉換
  const fields = form.elements;
  const isTank = fields.type.value === 'tank';
  const liters = isTank && fields.water_change_l.value !== '' ? Number(fields.water_change_l.value) : 0;

  return {
    date: fields.date.value,
    time: fields.time.value,
    kh: Number(fields.kh.value),
    dose_ml: isTank && fields.dose_ml.value !== '' ? Number(fields.dose_ml.value) : null,
    type: fields.type.value,
    method: fields.method.value,
    exclude: isTank && fields.exclude.checked,
    water_change_l: liters > 0 ? liters : null,
    water_change_timing: liters > 0 ? fields.water_change_timing.value : '',
    event: fields.event.value.trim(),
    note: fields.note.value.trim(),
  };
}

// 同步進行中不接受新的變更，避免同步完成時對不上。回傳 true 代表現在要先等一下
function blockedBySync() {
  if (syncing) {
    showMessage(formMessage, '同步中，請稍候再操作。', true);
  }
  return syncing;
}

function handleSubmit(event) {
  // 表單預設會重新載入頁面，這裡攔下來改由 JS 處理
  event.preventDefault();
  if (blockedBySync()) {
    return;
  }
  const record = readForm();

  // 必填、數值範圍已由 HTML 的 required、min、max 檢查，這裡補上其餘的檢查
  if (record.date > todayText()) {
    showMessage(formMessage, '日期不能是未來的日期。', true);
    return;
  }
  if (editing && isSameRecord(editing, record)) {
    resetForm();
    renderRecordsTable();
    showMessage(formMessage, '內容沒有變更。');
    return;
  }
  if (records.some((existing) => existing !== editing && isSameRecord(existing, record))) {
    showMessage(formMessage, '已經有一筆內容完全相同的紀錄。', true);
    return;
  }

  const wasEditing = editing !== null;
  if (wasEditing) {
    applyEdit(editing, record);
  } else {
    changes.added.push(record);
  }

  const saved = saveAndRefresh();
  resetForm();
  renderRecordsTable();
  if (!wasEditing) {
    form.elements.kh.focus();
  }

  const name = `${formatShortDate(record.date)} 的紀錄（KH ${record.kh.toFixed(1)}）`;
  if (!saved) {
    showMessage(formMessage, '已套用，但瀏覽器無法儲存，重新整理後會消失，請立即同步或匯出 JSON。', true);
  } else {
    const reminder = getToken() !== '' ? '記得按「同步到 GitHub」。' : '';
    showMessage(formMessage, `${wasEditing ? '已修改' : '已新增'} ${name}。${reminder}`);
  }
}


// ===== 修改與刪除 =====

// 依紀錄的來源，把修改記到對應的變更清單
function applyEdit(record, updated) {
  const from = origin.get(record);

  if (from.kind === 'added') {
    // 還沒儲存的新增紀錄：直接換成新內容
    changes.added[changes.added.indexOf(record)] = updated;
  } else if (from.kind === 'replaced') {
    // 之前改過的：更新修改後的內容；如果改回跟資料檔一樣，就等於沒改
    if (isSameRecord(from.entry.from, updated)) {
      changes.replaced = changes.replaced.filter((entry) => entry !== from.entry);
    } else {
      from.entry.to = updated;
    }
  } else {
    // 資料檔裡的紀錄：記下「從哪一筆改成什麼」
    changes.replaced.push({ from: record, to: updated });
  }
}

function deleteRecord(record) {
  if (blockedBySync()) {
    return;
  }
  if (!confirm(`確定要刪除 ${record.date} KH ${record.kh.toFixed(1)} 這筆紀錄嗎？`)) {
    return;
  }
  const from = origin.get(record);

  if (from.kind === 'added') {
    // filter：留下「不是這一筆」的紀錄，等於把它刪掉
    changes.added = changes.added.filter((item) => item !== record);
  } else if (from.kind === 'replaced') {
    // 改過又刪除：取消修改，並把資料檔裡原本那筆記為刪除
    changes.replaced = changes.replaced.filter((entry) => entry !== from.entry);
    changes.removed.push(from.entry.from);
  } else {
    changes.removed.push(record);
  }

  saveAndRefresh();
  showMessage(formMessage, '已刪除。儲存前可用「捨棄未儲存的變更」復原。');
}

function handleDiscard() {
  if (blockedBySync()) {
    return;
  }
  if (!confirm(`確定要捨棄 ${countChanges(changes)} 項尚未儲存的變更嗎？畫面會回到資料檔裡的內容。`)) {
    return;
  }
  changes = emptyChanges();
  saveAndRefresh();
  resetForm();
  renderRecordsTable();
  showMessage(formMessage, '已捨棄所有未儲存的變更。');
}


// ===== GitHub 同步 =====

function renderTokenState() {
  const hasToken = getToken() !== '';
  tokenState.textContent = hasToken
    ? '已設定權杖，這個瀏覽器可以直接讀寫 GitHub 上的資料。'
    : '尚未設定權杖。';
  tokenRemoveButton.hidden = !hasToken;
}

// 「儲存並測試」：先用權杖讀一次資料檔，成功才存起來
async function handleTokenSave() {
  const token = tokenInput.value.trim();
  if (token === '') {
    showMessage(tokenMessage, '請先貼上權杖。', true);
    return;
  }

  tokenSaveButton.disabled = true;
  showMessage(tokenMessage, '測試連線中…');
  try {
    await fetchRemoteRecords(token);
    if (!saveToken(token)) {
      throw new Error('瀏覽器無法儲存權杖（可能是無痕模式）。');
    }
    tokenInput.value = '';
    renderTokenState();
    await loadData();
    showMessage(tokenMessage, '連線成功，權杖已儲存在這個瀏覽器。寫入權限會在第一次同步時確認。');
  } catch (error) {
    showMessage(tokenMessage, `設定失敗：${error.message}`, true);
  } finally {
    tokenSaveButton.disabled = false;
  }
}

async function handleTokenRemove() {
  if (!confirm('確定要移除這個瀏覽器裡的權杖嗎？移除後無法直接同步到 GitHub。')) {
    return;
  }
  removeToken();
  renderTokenState();
  showMessage(tokenMessage, '已移除權杖。');
  try {
    await loadData();
  } catch (error) {
    showLoadError(error);
  }
}

// 把尚未儲存的變更提交到 GitHub
async function handleSync() {
  const token = getToken();
  if (token === '' || syncing) {
    return;
  }

  syncing = true;
  renderSaveArea();
  showMessage(syncMessage, '同步中…');
  try {
    // 最多試 3 次：如果讀取之後、寫入之前，剛好有其他裝置改了檔案（409），就重新讀取再套用一次
    for (let attempt = 1; ; attempt++) {
      const remote = await fetchRemoteRecords(token);
      upgradeChanges(remote.records, changes);
      const merged = applyChanges(remote.records, changes).records;
      const text = toJsonText(merged);

      try {
        // 內容跟 GitHub 上的一樣時（例如另一台裝置已經同步過），不需要再提交
        if (text !== toJsonText(remote.records)) {
          await pushRemoteRecords(token, text, remote.sha, `更新 KH 紀錄（${describeChanges(changes)}）`);
        }
      } catch (error) {
        if (error.status === 409 && attempt < 3) {
          continue;
        }
        throw error;
      }

      fileRecords = merged;
      source = 'github';
      break;
    }

    // 已經寫進資料檔的變更從暫存移除；同步期間新增的變更會留著
    cleanChanges(fileRecords, changes);
    saveChanges(changes);
    const time = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    showMessage(syncMessage, `已同步到 GitHub（${time}）。`);
  } catch (error) {
    showMessage(syncMessage, `同步失敗：${error.message}變更仍保留在這個瀏覽器。`, true);
  } finally {
    syncing = false;
    refresh();
  }
}


// ===== 匯出與圖表範圍 =====

function handleExportJson() {
  downloadText('kh-records.json', toJsonText(records));
}

function handleExportCsv() {
  downloadText('kh-records.csv', toCsvText(records), 'text/csv');
}

// 讀出上次選的範圍；沒有紀錄，或不是畫面上有的選項，就用預設值
function readStoredRange() {
  let stored = null;
  try {
    stored = localStorage.getItem(RANGE_KEY);
  } catch (error) {
    // 無法讀取時用預設值
  }
  const available = [...rangeButtons].map((button) => Number(button.dataset.range));
  return stored !== null && available.includes(Number(stored)) ? Number(stored) : DEFAULT_RANGE;
}

function setRange(value) {
  rangeDays = value;
  try {
    localStorage.setItem(RANGE_KEY, String(value));
  } catch (error) {
    // 存不了也沒關係，只是下次要重新選
  }
  // aria-pressed：告訴螢幕閱讀器哪一個按鈕目前被選取
  rangeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.range) === rangeDays));
  });
  if (charts !== null) {
    charts.update(days, rangeDays);
  }
}


// ===== 載入資料 =====

// 有設定權杖時，優先讀 GitHub 上的最新版本；讀不到或沒有權杖，就讀網站上的資料檔
async function loadData() {
  const token = getToken();
  let warning = '';
  let loaded = false;

  if (token !== '') {
    try {
      fileRecords = (await fetchRemoteRecords(token)).records;
      source = 'github';
      loaded = true;
    } catch (error) {
      warning = `無法從 GitHub 讀取最新資料（${error.message}）目前顯示的是網站上的資料檔，可能不是最新的。`;
    }
  }
  if (!loaded) {
    fileRecords = await loadRecords();
    source = 'file';
  }

  // 整理暫存的變更：先把舊版格式對應到現在的欄位，再移除已經寫進資料檔的項目
  const upgraded = upgradeChanges(fileRecords, changes);
  const cleaned = cleanChanges(fileRecords, changes);
  if (upgraded || cleaned) {
    saveChanges(changes);
  }

  refresh();
  resetForm();
  showMessage(syncMessage, warning, warning !== '');
}

function showLoadError(error) {
  // 讀檔失敗、JSON 格式錯誤、欄位缺漏，都會跑到這裡
  console.error(error);
  fileRecords = [];
  refresh();
  statusEl.textContent = `資料載入失敗：${error.message}`;
  statusEl.classList.add('error');
}

async function init() {
  changes = loadChanges();
  form.elements.water_change_l.max = TANK_LITERS;

  // 先綁定所有按鈕與欄位的事件。就算資料載入失敗，設定權杖等功能還是要能用
  form.addEventListener('submit', handleSubmit);
  form.elements.type.addEventListener('change', updateFormState);
  form.elements.water_change_l.addEventListener('input', updateFormState);
  cancelButton.addEventListener('click', cancelEdit);
  discardButton.addEventListener('click', handleDiscard);
  syncButton.addEventListener('click', handleSync);
  tokenSaveButton.addEventListener('click', handleTokenSave);
  tokenRemoveButton.addEventListener('click', handleTokenRemove);
  $('#export-button').addEventListener('click', handleExportJson);
  $('#csv-button').addEventListener('click', handleExportCsv);
  showAllButton.addEventListener('click', () => {
    showAllRows = true;
    renderRecordsTable();
  });
  rangeButtons.forEach((button) => {
    button.addEventListener('click', () => setRange(Number(button.dataset.range)));
  });
  // 改變計算區間或天數時，只需要重算分析的部分
  windowSelect.addEventListener('change', renderAnalysisSection);
  reachDaysInput.addEventListener('input', renderAnalysisSection);

  setRange(readStoredRange());
  renderTokenState();

  try {
    await loadData();
  } catch (error) {
    showLoadError(error);
  }
}

init();
