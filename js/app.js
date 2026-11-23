// 主程式：讀取資料，然後更新統計卡片、圖表與表格，並處理紀錄的新增、編輯與刪除

import {
  loadRecords, buildDays, averageKh, currentDose,
  isStandard, isCounted, formatKh, formatDelta, formatShortDate,
} from './data.js';
import { renderCharts } from './chart.js';
import {
  emptyChanges, loadChanges, saveChanges, isSameRecord, toJsonText, downloadText,
} from './storage.js';

// 目標 KH（dKH）。要調整目標時只改這一行
const TARGET_KH = 8.3;

const statusEl = document.querySelector('#status');
const tilesEl = document.querySelector('#tiles');
const tbody = document.querySelector('#kh-body');
const form = document.querySelector('#record-form');
const formMessage = document.querySelector('#form-message');
const exportInfo = document.querySelector('#export-info');
const exportButton = document.querySelector('#export-button');
const discardButton = document.querySelector('#discard-button');
const formTitle = document.querySelector('#form-title');
const submitButton = document.querySelector('#submit-button');
const cancelButton = document.querySelector('#cancel-button');

// 畫面顯示的資料 = 檔案裡的紀錄 + 在瀏覽器裡做的變更
let fileRecords = [];          // data/kh-records.json 裡的紀錄
let changes = emptyChanges();  // 尚未寫入檔案的新增、修改、刪除
let records = [];              // 套用變更後的所有紀錄（畫面上顯示的就是這份）
let origin = new Map();        // 每一筆紀錄的來源：檔案、新增的、還是修改過的
let editing = null;            // 正在編輯的那一筆；null 代表目前是「新增」模式
let charts = null;             // 圖表只建立一次，之後用 charts.update() 重畫


// ===== 把變更套用到檔案紀錄上 =====

function buildRecords() {
  origin = new Map();
  const result = [];
  const removed = changes.removed.slice(); // 複製一份，比對到一筆就拿掉一筆

  fileRecords.forEach((record) => {
    // 被刪除的：跳過
    const removedIndex = removed.findIndex((item) => isSameRecord(item, record));
    if (removedIndex !== -1) {
      removed.splice(removedIndex, 1);
      return;
    }
    // 被修改的：在原本的位置放入修改後的內容
    const entry = changes.replaced.find((item) => isSameRecord(item.from, record));
    if (entry) {
      result.push(entry.to);
      origin.set(entry.to, { kind: 'replaced', entry });
      return;
    }
    result.push(record);
    origin.set(record, { kind: 'file' });
  });

  // 新增的：接在後面
  changes.added.forEach((record) => {
    result.push(record);
    origin.set(record, { kind: 'added' });
  });

  // 依日期排序，同一天的維持原本的先後順序
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

// 檔案更新後（例如匯出並取代了檔案），把已經寫入檔案的變更從暫存移除
function cleanChanges() {
  const inFile = (record) => fileRecords.some((item) => isSameRecord(item, record));
  const before = JSON.stringify(changes);

  changes.added = changes.added.filter((record) => !inFile(record));
  changes.removed = changes.removed.filter(inFile);
  changes.replaced = changes.replaced.filter((entry) => {
    if (inFile(entry.from)) {
      return true; // 檔案裡還是舊內容，修改尚未寫入
    }
    if (!inFile(entry.to)) {
      changes.added.push(entry.to); // 原本的那筆已不在檔案裡，修改後的內容改當成新增
    }
    return false;
  });

  if (JSON.stringify(changes) !== before) {
    saveChanges(changes);
  }
}

function changeCount() {
  return changes.added.length + changes.removed.length + changes.replaced.length;
}


// ===== 統計卡片 =====

// 建立一張卡片：標題、主要數值、單位、補充說明
function createTile(label, value, unit, sub) {
  const tile = document.createElement('div');
  tile.className = 'tile';

  const labelEl = document.createElement('div');
  labelEl.className = 'tile-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  valueEl.className = 'tile-value';
  valueEl.textContent = value;
  if (unit) {
    const unitEl = document.createElement('span');
    unitEl.className = 'tile-unit';
    unitEl.textContent = unit;
    valueEl.appendChild(unitEl);
  }

  const subEl = document.createElement('div');
  subEl.className = 'tile-sub';
  subEl.textContent = sub;

  tile.append(labelEl, valueEl, subEl);
  return tile;
}

function renderTiles(days) {
  const latest = days[days.length - 1];
  tilesEl.replaceChildren();

  // 1. 最新 KH
  const latestSub = latest.counted > 1
    ? `${formatShortDate(latest.date)}，${latest.counted} 筆平均`
    : formatShortDate(latest.date);
  tilesEl.appendChild(createTile('最新 KH', formatKh(latest.kh), 'dKH', latestSub));

  // 2. 距離目標
  const gap = TARGET_KH - latest.kh;
  const gapTile = gap > 0.005
    ? createTile('距離目標還差', formatKh(gap), 'dKH', `目標 ${formatKh(TARGET_KH)} dKH`)
    : createTile('距離目標', '已達標', '', `目標 ${formatKh(TARGET_KH)} dKH`);
  tilesEl.appendChild(gapTile);

  // 3. 近 7 天平均，並跟再往前的 7 天比較
  const week = averageKh(days, latest.time, 7);
  const previousWeek = averageKh(days, latest.time - 7 * 24 * 60 * 60 * 1000, 7);
  const weekSub = previousWeek === null
    ? '沒有前 7 天的資料可比較'
    : `較前 7 天 ${formatDelta(week - previousWeek)}`;
  tilesEl.appendChild(createTile('近 7 天平均', formatKh(week), 'dKH', weekSub));

  // 4. 目前添加量
  const dose = currentDose(days);
  if (dose) {
    tilesEl.appendChild(createTile('目前添加量', String(dose.dose), 'mL／天', `自 ${formatShortDate(dose.since)} 起`));
  }
}


// ===== 表格 =====

function createCell(text, className) {
  const td = document.createElement('td');
  // 用 textContent 而不是 innerHTML：內容只會被當成純文字，不會被當成 HTML 執行
  td.textContent = text;
  if (className) {
    td.classList.add(className);
  }
  return td;
}

function createButton(text, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small';
  button.textContent = text;
  button.setAttribute('aria-label', label); // 給螢幕閱讀器的完整說明
  button.addEventListener('click', onClick);
  return button;
}

function renderTable() {
  tbody.replaceChildren();

  // 最新的排在最上面。slice() 先複製一份再反轉，不會改到原本的陣列
  records.slice().reverse().forEach((record) => {
    const tr = document.createElement('tr');

    // 狀態欄可能同時有好幾個標記，先收集到陣列再用頓號接起來
    const states = [];
    if (isStandard(record)) {
      states.push('標準液');
    } else if (!isCounted(record)) {
      states.push('已排除');
    }
    if (states.length > 0) {
      tr.classList.add('not-counted');
    }
    const kind = origin.get(record).kind;
    if (kind === 'added') {
      states.push('新增，尚未寫入檔案');
    } else if (kind === 'replaced') {
      states.push('已修改，尚未寫入檔案');
    }
    if (record === editing) {
      tr.classList.add('editing');
    }

    tr.appendChild(createCell(record.date));
    tr.appendChild(createCell(record.time));
    tr.appendChild(createCell(record.kh.toFixed(1), 'num'));
    tr.appendChild(createCell(record.dose_ml ?? '', 'num'));
    tr.appendChild(createCell(states.join('、')));
    tr.appendChild(createCell(record.note));

    const name = `${record.date} KH ${record.kh.toFixed(1)}`;
    const actions = document.createElement('td');
    actions.appendChild(createButton('編輯', `編輯 ${name} 的紀錄`, () => startEdit(record)));
    actions.appendChild(createButton('刪除', `刪除 ${name} 的紀錄`, () => deleteRecord(record)));
    tr.appendChild(actions);

    tbody.appendChild(tr);
  });
}


// ===== 重新整理整個畫面 =====

// 資料有任何變動（載入完成、新增、修改、刪除）都呼叫這個函式
function refresh() {
  records = buildRecords();
  const days = buildDays(records);

  renderTable();
  renderExportInfo();

  if (days.length === 0) {
    statusEl.textContent = '目前沒有可用的 KH 紀錄';
    return;
  }

  renderTiles(days);
  if (charts === null) {
    charts = renderCharts({
      khBox: document.querySelector('#kh-chart'),
      doseBox: document.querySelector('#dose-chart'),
      area: document.querySelector('#chart-area'),
      tooltip: document.querySelector('#tooltip'),
      days,
      records,
      target: TARGET_KH,
    });
  } else {
    charts.update(days, records);
  }

  const notCounted = records.filter((record) => !isCounted(record)).length;
  statusEl.textContent =
    `${days[0].date} 至 ${days[days.length - 1].date}，共 ${days.length} 個測量日、${records.length} 筆讀值` +
    `（其中 ${notCounted} 筆不納入統計）`;
}

function renderExportInfo() {
  const count = changeCount();
  discardButton.hidden = count === 0;

  if (count === 0) {
    exportInfo.textContent = '所有紀錄都已寫入 data/kh-records.json。';
    return;
  }
  const parts = [];
  if (changes.added.length > 0) {
    parts.push(`新增 ${changes.added.length} 筆`);
  }
  if (changes.replaced.length > 0) {
    parts.push(`修改 ${changes.replaced.length} 筆`);
  }
  if (changes.removed.length > 0) {
    parts.push(`刪除 ${changes.removed.length} 筆`);
  }
  exportInfo.textContent =
    `有 ${count} 項變更只存在這個瀏覽器（${parts.join('、')}），尚未寫入 data/kh-records.json。`;
}

// 存檔並重畫；回傳是否成功存入瀏覽器
function saveAndRefresh() {
  const saved = saveChanges(changes);
  refresh();
  return saved;
}


// ===== 表單 =====

// 今天的日期，格式 'YYYY-MM-DD'（用電腦的當地時間）
function todayText() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function showFormMessage(text, isError) {
  formMessage.textContent = text;
  formMessage.classList.toggle('error', isError);
}

// 回到「新增」模式：清空表單，預設今天的日期與目前的添加量
function resetForm() {
  editing = null;
  form.reset();
  form.elements.date.value = todayText();
  const dose = currentDose(buildDays(records));
  form.elements.dose_ml.value = dose ? dose.dose : '';

  formTitle.textContent = '新增紀錄';
  submitButton.textContent = '新增';
  cancelButton.hidden = true;
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
  fields.exclude.checked = record.exclude === true;
  fields.note.value = record.note ?? '';

  formTitle.textContent = `編輯紀錄（${record.date} KH ${record.kh.toFixed(1)}）`;
  submitButton.textContent = '儲存修改';
  cancelButton.hidden = false;
  showFormMessage('', false);
  renderTable(); // 重畫表格，標示正在編輯的那一列

  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  fields.kh.focus({ preventScroll: true });
}

function cancelEdit() {
  resetForm();
  renderTable();
  showFormMessage('已取消編輯。', false);
}

// 把表單欄位的內容組成一筆紀錄
function readForm() {
  // 從表單欄位讀出的值都是字串，數字要自己用 Number() 轉換
  const fields = form.elements;
  const type = fields.type.value;
  return {
    date: fields.date.value,
    time: fields.time.value,
    kh: Number(fields.kh.value),
    // 標準液不是魚缸水，添加量與排除標記對它沒有意義
    dose_ml: type === 'tank' && fields.dose_ml.value !== '' ? Number(fields.dose_ml.value) : null,
    type,
    exclude: type === 'tank' && fields.exclude.checked,
    note: fields.note.value.trim(),
  };
}

function handleSubmit(event) {
  // 表單預設會重新載入頁面，這裡攔下來改由 JS 處理
  event.preventDefault();
  const record = readForm();

  // 必填、數值範圍已由 HTML 的 required、min、max 檢查，這裡補上其餘的檢查
  if (record.date > todayText()) {
    showFormMessage('日期不能是未來的日期。', true);
    return;
  }
  if (editing && isSameRecord(editing, record)) {
    resetForm();
    renderTable();
    showFormMessage('內容沒有變更。', false);
    return;
  }
  if (records.some((existing) => existing !== editing && isSameRecord(existing, record))) {
    showFormMessage('已經有一筆內容完全相同的紀錄。', true);
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
  renderTable();
  if (!wasEditing) {
    form.elements.kh.focus();
  }

  const name = `${formatShortDate(record.date)} 的紀錄（KH ${record.kh.toFixed(1)}）`;
  if (saved) {
    showFormMessage(wasEditing ? `已修改 ${name}。` : `已新增 ${name}。`, false);
  } else {
    showFormMessage('已套用，但瀏覽器無法儲存，重新整理後會消失，請立即匯出 JSON。', true);
  }
}


// ===== 修改與刪除 =====

// 依紀錄的來源，把修改記到對應的變更清單
function applyEdit(record, updated) {
  const source = origin.get(record);

  if (source.kind === 'added') {
    // 還沒寫入檔案的新增紀錄：直接換成新內容
    changes.added[changes.added.indexOf(record)] = updated;
  } else if (source.kind === 'replaced') {
    // 之前改過的：更新修改後的內容；如果改回跟檔案一樣，就等於沒改
    if (isSameRecord(source.entry.from, updated)) {
      changes.replaced = changes.replaced.filter((entry) => entry !== source.entry);
    } else {
      source.entry.to = updated;
    }
  } else {
    // 檔案裡的紀錄：記下「從哪一筆改成什麼」
    changes.replaced.push({ from: record, to: updated });
  }
}

function deleteRecord(record) {
  if (!confirm(`確定要刪除 ${record.date} KH ${record.kh.toFixed(1)} 這筆紀錄嗎？`)) {
    return;
  }
  const source = origin.get(record);

  if (source.kind === 'added') {
    // filter：留下「不是這一筆」的紀錄，等於把它刪掉
    changes.added = changes.added.filter((item) => item !== record);
  } else if (source.kind === 'replaced') {
    // 改過又刪除：取消修改，並把檔案裡原本那筆記為刪除
    changes.replaced = changes.replaced.filter((entry) => entry !== source.entry);
    changes.removed.push(source.entry.from);
  } else {
    changes.removed.push(record);
  }

  const wasEditingThis = editing === record;
  saveAndRefresh();
  if (wasEditingThis) {
    resetForm();
  }
  showFormMessage('已刪除。寫入檔案前，可用「捨棄未寫入的變更」復原。', false);
}

function handleDiscard() {
  if (!confirm(`確定要捨棄 ${changeCount()} 項尚未寫入檔案的變更嗎？畫面會回到檔案裡的內容。`)) {
    return;
  }
  changes = emptyChanges();
  saveAndRefresh();
  resetForm();
  renderTable();
  showFormMessage('已捨棄所有未寫入的變更。', false);
}

function handleExport() {
  downloadText('kh-records.json', toJsonText(records));
}


// ===== 主流程 =====

async function init() {
  try {
    fileRecords = await loadRecords();
    changes = loadChanges();
    cleanChanges();

    refresh();
    resetForm();
    form.addEventListener('submit', handleSubmit);
    cancelButton.addEventListener('click', cancelEdit);
    exportButton.addEventListener('click', handleExport);
    discardButton.addEventListener('click', handleDiscard);
  } catch (error) {
    // 讀檔失敗、JSON 格式錯誤、欄位缺漏，都會跑到這裡
    console.error(error);
    statusEl.textContent = `資料載入失敗：${error.message}`;
    statusEl.classList.add('error');
  }
}

init();
