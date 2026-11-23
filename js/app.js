// 主程式：管理資料狀態，處理表單、分頁、同步與匯出，並在資料變動時更新整個畫面

import {
  loadRecords, buildDays, latestKhDay, currentDose, isCounted, methodLabel,
  formatKh, formatShortDate, formatDateWithWeekday,
} from './data.js';
import { renderCharts } from './chart.js';
import {
  renderTiles, renderHero, renderRecent, renderAnalysis, renderMethods, renderTable, windowOptions,
} from './render.js';
import {
  CHANGES_KEY, createId, withIds, isSameContent,
  emptyChanges, loadChanges, saveChanges, migrateLegacyChanges, countChanges, describeChanges,
  saveBaseSnapshot, loadBaseSnapshot, clearBaseSnapshot,
  upsertRecord, deleteRecord, applyChanges, cleanChanges,
  toJsonText, toCsvText, downloadText,
} from './storage.js';
import { TOKEN_KEY, getToken, saveToken, removeToken, fetchRemoteRecords, pushRemoteRecords } from './github.js';
import { TARGET_KH, TANK_LITERS } from './config.js';

const TABLE_LIMIT = 30;                  // 表格預設只顯示最新的幾筆
const RANGE_KEY = 'reef-kh:range';       // 記住上次選的圖表時間範圍
const AUTO_SYNC_KEY = 'reef-kh:auto-sync'; // 記住「自動同步」的開關
const DEFAULT_RANGE = 90;
const REFRESH_AFTER_MS = 5 * 60 * 1000;  // 回到頁面時，距離上次讀取超過這個時間就重新讀一次

// 窄螢幕（手機）版面：底部有分頁列，一次只顯示一個分頁。這裡的寬度要跟 style.css 裡的一致
const mobileLayout = window.matchMedia('(max-width: 640px)');

const $ = (selector) => document.querySelector(selector);

const statusEl = $('#status');
const heroEl = $('#hero');
const tilesEl = $('#tiles');
const tbody = $('#kh-body');
const showAllButton = $('#show-all-button');
const form = $('#record-form');
const formTitle = $('#form-title');
const formMessage = $('#form-message');
const submitButton = $('#submit-button');
const cancelButton = $('#cancel-button');
const moreToggle = $('#more-toggle');
const moreFields = document.querySelectorAll('.more-fields');
const exportInfo = $('#export-info');
const syncButton = $('#sync-button');
const syncMessage = $('#sync-message');
const exportInlineButton = $('#export-inline-button');
const setupButton = $('#setup-button');
const discardButton = $('#discard-button');
const tokenInput = $('#token-input');
const tokenSaveButton = $('#token-save-button');
const tokenRemoveButton = $('#token-remove-button');
const tokenState = $('#token-state');
const tokenMessage = $('#token-message');
const autoSyncCheckbox = $('#auto-sync');
const settingsButton = $('#settings-button');
const tabButtons = document.querySelectorAll('[data-tab]');
const rangeButtons = document.querySelectorAll('[data-range]');
const windowSelect = $('#window-select');
const reachDaysInput = $('#reach-days');

// 畫面顯示的資料 = 資料檔裡的紀錄 + 在瀏覽器裡做的變更
let base = [];                 // 資料檔裡的紀錄（來自網站上的檔案，或 GitHub 上的最新版本）
let source = 'file';           // 資料檔的來源：'file' 或 'github'
let baseIsLatest = true;       // 手上的資料檔是不是最新版本。讀不到 GitHub 而改用舊資料時是 false
let lastRemoteRead = 0;        // 上次成功讀到 GitHub 資料的時間（毫秒）
let changes = emptyChanges();  // 尚未儲存的新增、修改、刪除
let records = [];              // 套用變更後的所有紀錄（畫面上顯示的就是這份）
let kinds = new Map();         // 每筆紀錄的狀態：跟資料檔一樣、新增的、還是修改過的
let days = [];                 // 由 records 整理出來的每日資料
let editingId = null;          // 正在編輯的紀錄的 id；null 代表目前是「新增」模式
let returnView = null;         // 手機上編輯完成後，要回到哪一個分頁
let defaultDate = '';          // 表單自動帶入的日期，用來判斷使用者有沒有自己改過
let charts = null;             // 圖表只建立一次，之後用 charts.update() 重畫
let rangeDays = DEFAULT_RANGE; // 圖表顯示最近幾天；0 代表全部
let showAllRows = false;       // 表格是否顯示全部紀錄
let loading = false;           // 是否正在讀取資料檔
let syncing = false;           // 是否正在同步
let syncQueued = false;        // 讀取或同步進行中又要求同步：等目前的工作完成後再同步一次
let refreshing = false;        // 是否正在背景重新讀取資料


// ===== 重新整理整個畫面 =====

// 資料有任何變動（載入完成、新增、修改、刪除、同步）都呼叫這個函式
function refresh() {
  ({ records, kinds } = applyChanges(base, changes));
  days = buildDays(records);

  // 正在編輯的紀錄如果已經不存在（例如在另一個分頁被刪除了），就回到新增模式
  if (editingId !== null && !records.some((record) => record.id === editingId)) {
    resetForm();
  }

  renderRecordsTable();
  renderRecent($('#recent'), records, kinds);
  renderSaveArea();
  statusEl.classList.remove('error');

  // 沒有任何有效讀值時，把統計、圖表、分析都藏起來
  const latest = latestKhDay(days);
  document.body.classList.toggle('no-data', latest === null);
  if (latest === null) {
    statusEl.textContent = '目前沒有可用的 KH 紀錄';
    return;
  }

  renderHero(heroEl, days, todayText());
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
    kinds,
    editingId,
    limit: showAllRows ? 0 : TABLE_LIMIT,
    onEdit: startEdit,
    onDelete: handleDelete,
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
  const detail = describeChanges(base, changes);

  // 有變更才需要這些按鈕。有權杖用「立即同步」，沒有權杖則提供「匯出 JSON」與設定同步的入口
  discardButton.hidden = count === 0;
  syncButton.hidden = !hasToken || count === 0;
  syncButton.disabled = syncing;
  exportInlineButton.hidden = hasToken || count === 0;
  setupButton.hidden = hasToken || count === 0;

  if (count === 0) {
    exportInfo.textContent = source === 'github'
      ? '所有紀錄都已同步到 GitHub。'
      : '所有紀錄都已寫入 data/kh-records.json。';
  } else if (hasToken) {
    exportInfo.textContent = `有 ${count} 項變更尚未同步到 GitHub（${detail}）。`;
  } else {
    exportInfo.textContent = `有 ${count} 項變更只存在這個瀏覽器（${detail}），尚未寫入 data/kh-records.json。`;
  }
}

// 變更之後：整理暫存、存檔並重畫。回傳是否成功存入瀏覽器
function commitChanges() {
  // 手上的資料檔是最新版本時，把「改回跟資料檔一樣」這類已經不算變更的項目清掉。
  // 同步進行中先不整理：這時手上的資料檔還是同步前的版本，等同步完成再一起處理
  if (baseIsLatest && !syncing) {
    cleanChanges(base, changes);
  }
  const saved = saveChanges(changes);
  refresh();
  return saved;
}


// ===== 分頁（手機版面） =====

// 切換顯示的分頁。電腦上所有區塊都會顯示，這個設定只在窄螢幕有作用
function setView(name) {
  document.body.dataset.view = name;
  tabButtons.forEach((button) => {
    // aria-current：告訴螢幕閱讀器目前在哪一個分頁
    if (button.dataset.tab === name) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });
  settingsButton.setAttribute('aria-pressed', String(name === 'settings'));
  window.scrollTo(0, 0);
}

// 前往「同步與匯出」：手機切換分頁，電腦捲動到那個區塊
function openSettings() {
  if (mobileLayout.matches) {
    setView('settings');
  } else {
    $('#settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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

// 手機上展開或收起「更多欄位」
function setMoreFields(open) {
  moreFields.forEach((group) => group.classList.toggle('collapsed', !open));
  moreToggle.setAttribute('aria-expanded', String(open)); // 告訴螢幕閱讀器目前是展開還是收起
  renderMoreSummary();
}

// 「更多欄位」按鈕上的文字：收起時列出會一起存入的內容，讓人不用展開也知道存了什麼
function renderMoreSummary() {
  const fields = form.elements;
  const parts = [];
  if (fields.date.value) {
    parts.push(formatDateWithWeekday(fields.date.value));
  }
  if (fields.type.value === 'standard') {
    parts.push('標準液');
  } else if (fields.dose_ml.value !== '') {
    parts.push(`添加量 ${fields.dose_ml.value} mL`);
  }
  if (fields.method.value) {
    parts.push(methodLabel(fields.method.value));
  }
  if (fields.water_change_l.value !== '' && !fields.water_change_l.disabled) {
    parts.push(`換水 ${fields.water_change_l.value} L`);
  }
  if (fields.exclude.checked && !fields.exclude.disabled) {
    parts.push('不納入統計');
  }

  $('#more-summary').textContent = parts.join(' · ');
  $('#more-label').textContent = moreToggle.getAttribute('aria-expanded') === 'true' ? '收起' : '更多欄位';
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
  editingId = null;
  form.reset();
  const fields = form.elements;
  defaultDate = todayText();
  fields.date.value = defaultDate;

  const dose = currentDose(days);
  fields.dose_ml.value = dose ? dose.dose : '';
  fields.method.value = defaultMethod();

  // KH 欄位留空，只用淡色字提示上次的讀值，避免沒輸入就把舊數字存進去
  const latest = latestKhDay(days);
  fields.kh.placeholder = latest ? `上次 ${formatKh(latest.kh)}` : '';

  formTitle.textContent = '新增紀錄';
  submitButton.textContent = mobileLayout.matches ? '儲存' : '新增';
  cancelButton.hidden = true;
  updateFormState();
  setMoreFields(false);
}

// 頁面開著過了午夜，表單上自動帶入的日期還是昨天。
// 回到這個頁面或點進表單時檢查一次：使用者沒改過日期的話，更新成今天
function refreshDefaultDate() {
  const today = todayText();
  if (editingId === null && form.elements.date.value === defaultDate && defaultDate !== today) {
    defaultDate = today;
    form.elements.date.value = today;
    renderMoreSummary();
    if (latestKhDay(days) !== null) {
      renderHero(heroEl, days, today); // 「今天已記錄」也要跟著換日
    }
  }
}

// 手機上的加減按鈕。欄位是空的時候，第一次按先帶入上次的讀值；之後每按一次加減 0.1
function stepKh(delta) {
  const field = form.elements.kh;
  let value;
  if (field.value === '') {
    const latest = latestKhDay(days);
    value = latest ? latest.kh : 8;
  } else {
    value = Number(field.value) + delta;
  }
  // 先乘 10 四捨五入再除回來，避免 7.6 + 0.1 變成 7.699999 這類小數誤差
  value = Math.round(value * 10) / 10;
  field.value = Math.min(20, Math.max(0.1, value)).toFixed(1);
}

// 進入「編輯」模式：把這筆紀錄的內容填進表單
function startEdit(record) {
  editingId = record.id;
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
  setMoreFields(true); // 編輯時所有欄位都要看得到
  renderRecordsTable(); // 重畫表格，標示正在編輯的那一列

  if (mobileLayout.matches) {
    // 手機：表單在「記錄」分頁。記下原本的分頁，編輯完再回去
    if (document.body.dataset.view !== 'record') {
      returnView = document.body.dataset.view;
    }
    setView('record');
  } else {
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    fields.kh.focus({ preventScroll: true });
  }
}

// 結束編輯：手機上回到原本的分頁
function leaveEdit() {
  if (returnView !== null) {
    setView(returnView);
    returnView = null;
  }
}

function cancelEdit() {
  resetForm();
  renderRecordsTable();
  showMessage(formMessage, '已取消編輯。');
  leaveEdit();
}

// 檢查表單內容。有問題時回傳 { field, message }，沒問題回傳 null
function validateForm() {
  const fields = form.elements;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date.value)) {
    return { field: fields.date, message: '請選擇日期。' };
  }
  if (fields.date.value > todayText()) {
    return { field: fields.date, message: '日期不能是未來的日期。' };
  }

  // 數字欄位輸入了不是數字的內容時，value 會是空字串
  const kh = Number(fields.kh.value);
  if (fields.kh.value === '' || !Number.isFinite(kh)) {
    return { field: fields.kh, message: '請輸入 KH 讀值。' };
  }
  if (kh < 0.1 || kh > 20) {
    return { field: fields.kh, message: 'KH 請輸入 0.1 到 20 之間的數值。' };
  }

  if (!fields.dose_ml.disabled && (fields.dose_ml.validity.badInput || Number(fields.dose_ml.value) < 0)) {
    return { field: fields.dose_ml, message: '添加量請輸入 0 以上的數值。' };
  }
  const liters = Number(fields.water_change_l.value);
  if (!fields.water_change_l.disabled && (fields.water_change_l.validity.badInput || liters < 0 || liters > TANK_LITERS)) {
    return { field: fields.water_change_l, message: `換水量請輸入 0 到 ${TANK_LITERS} 之間的數值。` };
  }
  return null;
}

// 把表單欄位的內容組成一筆紀錄（還沒有 id）
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

function handleSubmit(event) {
  // 表單預設會重新載入頁面，這裡攔下來改由 JS 處理
  event.preventDefault();

  const problem = validateForm();
  if (problem !== null) {
    showMessage(formMessage, problem.message, true);
    // 有問題的欄位如果在收起來的「更多欄位」裡，先展開才看得到
    if (problem.field.closest('.more-fields')) {
      setMoreFields(true);
    }
    problem.field.focus();
    return;
  }

  const record = readForm();
  const current = records.find((item) => item.id === editingId) ?? null; // 正在編輯的那一筆

  if (current !== null && isSameContent(current, record)) {
    resetForm();
    renderRecordsTable();
    showMessage(formMessage, '內容沒有變更。');
    leaveEdit();
    return;
  }
  if (records.some((existing) => existing.id !== editingId && isSameContent(existing, record))) {
    showMessage(formMessage, '已經有一筆內容完全相同的紀錄。', true);
    return;
  }

  // 編輯沿用原本的 id，新增則產生新的 id
  upsertRecord(changes, { id: current !== null ? current.id : createId(), ...record });
  const saved = commitChanges();
  resetForm();
  renderRecordsTable();

  if (current !== null) {
    leaveEdit();
  } else if (mobileLayout.matches) {
    document.activeElement?.blur(); // 手機：收起螢幕鍵盤，才看得到上方更新後的數字
  } else {
    form.elements.kh.focus();
  }

  const name = `${formatShortDate(record.date)} 的紀錄（KH ${record.kh.toFixed(1)}）`;
  if (!saved) {
    showMessage(formMessage, '已套用，但瀏覽器無法儲存，重新整理後會消失，請立即同步或匯出 JSON。', true);
  } else {
    const reminder = getToken() !== '' && !autoSyncEnabled() ? '記得按「立即同步」。' : '';
    showMessage(formMessage, `${current !== null ? '已修改' : '已新增'} ${name}。${reminder}`);
  }
  autoSync();
}

function handleDelete(record) {
  if (!confirm(`確定要刪除 ${record.date} KH ${record.kh.toFixed(1)} 這筆紀錄嗎？`)) {
    return;
  }

  // 資料檔裡有這一筆，就要記下「這個 id 要刪除」；還沒儲存過的新紀錄，直接拿掉即可。
  // 手上的資料檔不是最新版本，或同步正在進行時，無法確定它是不是已經寫入，一律記下來比較保險
  const inBase = base.some((item) => item.id === record.id);
  deleteRecord(changes, record.id, inBase || !baseIsLatest || syncing);
  commitChanges();
  showMessage(formMessage, '已刪除。');
  autoSync();
}

function handleDiscard() {
  if (syncing) {
    showMessage(formMessage, '同步中，請稍候再操作。', true);
    return;
  }
  if (!confirm(`確定要捨棄 ${countChanges(changes)} 項尚未儲存的變更嗎？畫面會回到資料檔裡的內容。`)) {
    return;
  }
  changes = emptyChanges();
  commitChanges();
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

// 「自動同步」的開關，預設開啟
function autoSyncEnabled() {
  try {
    return localStorage.getItem(AUTO_SYNC_KEY) !== '0';
  } catch (error) {
    return true;
  }
}

// 讀取 GitHub 上最新的資料檔，確保每一筆都有 id，並在這台裝置存一份備份
async function readRemote(token) {
  const remote = await fetchRemoteRecords(token);
  const remoteRecords = withIds(remote.records);
  lastRemoteRead = Date.now();
  saveBaseSnapshot(remoteRecords);
  return { records: remoteRecords, sha: remote.sha };
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
    autoSync();
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
  clearBaseSnapshot();
  renderTokenState();
  showMessage(tokenMessage, '已移除權杖。');
  try {
    await loadData();
  } catch (error) {
    showLoadError(error);
  }
}

// 有設定權杖、開啟自動同步，而且有還沒儲存的變更時，自動同步到 GitHub
function autoSync() {
  if (getToken() === '' || !autoSyncEnabled() || countChanges(changes) === 0) {
    return;
  }
  handleSync();
}

// 把尚未儲存的變更提交到 GitHub
async function handleSync() {
  const token = getToken();
  if (token === '') {
    return;
  }
  // 正在讀取資料檔或已經在同步：先記下來，等目前的工作完成後再同步。
  // 兩件事同時進行的話，較晚回來的舊資料可能蓋掉剛同步好的內容
  if (loading || syncing) {
    syncQueued = true;
    return;
  }

  syncing = true;
  renderSaveArea();
  showMessage(syncMessage, '同步中…');
  const time = () => new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

  try {
    // 最多試 3 次：如果讀取之後、寫入之前，剛好有其他裝置改了檔案（409），就重新讀取再套用一次
    for (let attempt = 1; ; attempt++) {
      const remote = await readRemote(token);
      const merged = applyChanges(remote.records, changes).records;
      const text = toJsonText(merged);

      try {
        // 內容跟 GitHub 上的一樣時（例如另一台裝置已經同步過），不需要再提交
        if (text !== toJsonText(remote.records)) {
          const message = `更新 KH 紀錄（${describeChanges(remote.records, changes)}）`;
          await pushRemoteRecords(token, text, remote.sha, message);
        }
      } catch (error) {
        if (error.status === 409 && attempt < 3) {
          continue;
        }
        throw error;
      }

      base = merged;
      source = 'github';
      baseIsLatest = true;
      saveBaseSnapshot(base);
      break;
    }

    // 已經寫進資料檔的變更從暫存移除；同步期間新做的變更會留著，等下一次同步
    cleanChanges(base, changes);
    saveChanges(changes);
    showMessage(syncMessage, `已同步到 GitHub（${time()}）。`);
  } catch (error) {
    // 連線中斷或伺服器錯誤時，不確定最後一次寫入有沒有成功。
    // 重新讀一次 GitHub 上的內容來確認，以實際的內容為準
    let confirmed = false;
    if (error.status === 0 || error.status >= 500) {
      try {
        base = (await readRemote(token)).records;
        source = 'github';
        baseIsLatest = true;
        cleanChanges(base, changes);
        saveChanges(changes);
        confirmed = countChanges(changes) === 0;
      } catch (retryError) {
        baseIsLatest = false; // 連讀都讀不到：手上的資料檔可能已經不是最新的
      }
    }
    if (confirmed) {
      showMessage(syncMessage, `已同步到 GitHub（${time()}）。寫入時連線曾中斷，已重新確認內容正確。`);
    } else {
      // 連不上的話，恢復連線時會自動再試；其他原因（例如權杖過期）要處理完再同步
      const retry = error.status === 0 ? '，連線恢復後會再試一次' : '';
      showMessage(syncMessage, `同步失敗：${error.message}變更仍保留在這個瀏覽器${retry}。`, true);
    }
  } finally {
    syncing = false;
    refresh();
    runQueuedSync();
  }
}

// 剛才因為忙碌而延後的同步，現在補做
function runQueuedSync() {
  if (syncQueued) {
    syncQueued = false;
    if (countChanges(changes) > 0) {
      handleSync();
    }
  }
}

// 回到這個頁面或恢復連線時：資料可能已經在其他裝置更新過，重新讀取一次，
// 並把還沒同步的變更送出去
async function refreshFromRemote() {
  if (getToken() === '' || syncing || refreshing) {
    return;
  }
  if (!baseIsLatest || Date.now() - lastRemoteRead > REFRESH_AFTER_MS) {
    refreshing = true;
    try {
      await loadData({ keepForm: true }); // 不清空表單，避免打到一半的內容不見
    } catch (error) {
      console.error(error);
    } finally {
      refreshing = false;
    }
  }
  // 還是讀不到 GitHub 就先不同步：一定會失敗，還會把「目前顯示的是備份」的提醒蓋掉
  if (baseIsLatest) {
    autoSync();
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

// 有設定權杖時，優先讀 GitHub 上的最新版本；讀不到就用這台裝置上次同步的備份；
// 沒有權杖或沒有備份，就讀網站上的資料檔
// keepForm：為 true 時不清空表單（背景重新讀取時使用）
async function loadData({ keepForm = false } = {}) {
  const token = getToken();
  let warning = '';
  let loaded = false;

  loading = true;
  try {
    if (token !== '') {
      try {
        base = (await readRemote(token)).records;
        source = 'github';
        baseIsLatest = true;
        loaded = true;
      } catch (error) {
        const snapshot = loadBaseSnapshot();
        if (snapshot !== null) {
          base = withIds(snapshot.records);
          source = 'github';
          baseIsLatest = false; // 備份可能比 GitHub 上的舊，不能拿來判斷哪些變更已經寫入
          loaded = true;
          warning = `讀不到 GitHub 上的最新資料（${error.message}）目前顯示的是這台裝置上次同步的資料。新的變更會先保留，連線恢復後再同步。`;
        } else {
          warning = `無法從 GitHub 讀取最新資料（${error.message}）目前顯示的是網站上的資料檔，可能不是最新的。`;
        }
      }
    }
    if (!loaded) {
      base = withIds(await loadRecords());
      source = 'file';
      // 有權杖卻讀不到 GitHub：網站上的檔案可能比 GitHub 上的舊
      baseIsLatest = token === '';
    }
  } finally {
    loading = false;
  }

  // 整理暫存的變更：舊版格式轉成新格式，並移除已經寫進資料檔的項目
  const migrated = migrateLegacyChanges(base, changes);
  const cleaned = baseIsLatest && cleanChanges(base, changes);
  if (migrated || cleaned) {
    saveChanges(changes);
  }

  refresh();
  if (!keepForm) {
    resetForm();
  }
  showMessage(syncMessage, warning, warning !== '');
  runQueuedSync(); // 讀取期間有人要求同步（例如資料還沒載完就按了儲存）
}

function showLoadError(error) {
  // 讀檔失敗、JSON 格式錯誤、欄位缺漏，都會跑到這裡
  console.error(error);
  base = [];
  baseIsLatest = false;
  refresh();
  heroEl.replaceChildren();
  statusEl.textContent = `資料載入失敗：${error.message}`;
  statusEl.classList.add('error');
}

async function init() {
  changes = loadChanges();
  form.elements.water_change_l.max = TANK_LITERS;
  autoSyncCheckbox.checked = autoSyncEnabled();

  // 先綁定所有按鈕與欄位的事件。就算資料載入失敗，設定權杖等功能還是要能用
  form.addEventListener('submit', handleSubmit);
  form.addEventListener('focusin', refreshDefaultDate);
  // 表單任何欄位有變動：更新欄位的停用狀態，以及「更多欄位」按鈕上的摘要
  form.addEventListener('input', () => {
    updateFormState();
    renderMoreSummary();
  });
  moreToggle.addEventListener('click', () => {
    setMoreFields(moreToggle.getAttribute('aria-expanded') !== 'true');
  });
  $('#kh-minus').addEventListener('click', () => stepKh(-0.1));
  $('#kh-plus').addEventListener('click', () => stepKh(0.1));
  cancelButton.addEventListener('click', cancelEdit);
  discardButton.addEventListener('click', handleDiscard);
  syncButton.addEventListener('click', handleSync);
  setupButton.addEventListener('click', openSettings);
  $('#reload-button').addEventListener('click', () => location.reload());
  tokenSaveButton.addEventListener('click', handleTokenSave);
  tokenRemoveButton.addEventListener('click', handleTokenRemove);
  autoSyncCheckbox.addEventListener('change', () => {
    try {
      localStorage.setItem(AUTO_SYNC_KEY, autoSyncCheckbox.checked ? '1' : '0');
    } catch (error) {
      // 瀏覽器不允許儲存時，這個開關不會生效，會維持預設（開啟）
      autoSyncCheckbox.checked = true;
    }
    autoSync();
  });
  document.querySelectorAll('.export-json').forEach((button) => button.addEventListener('click', handleExportJson));
  document.querySelectorAll('.export-csv').forEach((button) => button.addEventListener('click', handleExportCsv));
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

  // 分頁列與「設定」按鈕
  tabButtons.forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.tab));
  });
  settingsButton.addEventListener('click', () => {
    setView(document.body.dataset.view === 'settings' ? 'record' : 'settings');
  });

  // 回到這個頁面時（例如手機重新打開 App）：更新表單的預設日期，並重新讀取資料
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshDefaultDate();
      refreshFromRemote();
    }
  });
  window.addEventListener('focus', refreshDefaultDate);
  // 網路恢復連線：把離線時記下的變更送出去
  window.addEventListener('online', refreshFromRemote);

  // 同一個瀏覽器的另一個分頁改了暫存的變更或權杖時，這個分頁跟著更新，避免互相覆蓋
  window.addEventListener('storage', (event) => {
    if (event.key === CHANGES_KEY && !syncing) {
      changes = loadChanges();
      refresh();
    }
    if (event.key === TOKEN_KEY) {
      renderTokenState();
      renderSaveArea();
    }
  });

  setView('record');
  setRange(readStoredRange());
  renderTokenState();

  try {
    await loadData();
    // 上次離線時留下、還沒同步的變更。這次如果還是讀不到 GitHub，就等恢復連線再送
    if (baseIsLatest) {
      autoSync();
    }
  } catch (error) {
    showLoadError(error);
  }

  // 服務工作線程（service worker）：把網頁的檔案存在裝置裡，沒有網路時也能開啟。
  // 只在正式網站（https）啟用。本機開發用的網址不啟用，以免影響同一個網址上的其他專案
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((error) => console.error(error));
  }
}

init();
