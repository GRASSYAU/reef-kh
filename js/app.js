// 主程式：讀取資料，然後更新統計卡片、圖表與表格，並處理新增紀錄表單

import {
  loadRecords, buildDays, averageKh, currentDose,
  isStandard, isCounted, formatKh, formatDelta, formatShortDate,
} from './data.js';
import { renderCharts } from './chart.js';
import {
  loadLocalRecords, saveLocalRecords, isSameRecord, toJsonText, downloadText,
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

// 資料來源有兩個，畫面顯示的是兩者合併後的結果
let fileRecords = [];  // data/kh-records.json 裡的紀錄
let localRecords = []; // 用表單新增、暫存在瀏覽器裡的紀錄
let charts = null;     // 圖表只建立一次，之後用 charts.update() 重畫


// ===== 合併兩個資料來源 =====

function allRecords() {
  // concat 把兩個陣列接起來；sort 依日期排序，同一天的維持原本的先後順序
  return fileRecords.concat(localRecords).sort((a, b) => a.date.localeCompare(b.date));
}

function isLocal(record) {
  return localRecords.includes(record);
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

function renderTable(records) {
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
    if (isLocal(record)) {
      states.push('尚未寫入檔案');
    }

    tr.appendChild(createCell(record.date));
    tr.appendChild(createCell(record.time));
    tr.appendChild(createCell(record.kh.toFixed(1), 'num'));
    tr.appendChild(createCell(record.dose_ml ?? '', 'num'));

    const stateCell = createCell(states.join('、'));
    // 只有暫存在瀏覽器的紀錄可以在這裡刪除；檔案裡的紀錄要直接改 JSON 檔
    if (isLocal(record)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'small';
      button.textContent = '刪除';
      button.setAttribute('aria-label', `刪除 ${record.date} KH ${record.kh} 的紀錄`);
      button.addEventListener('click', () => deleteLocalRecord(record));
      stateCell.appendChild(button);
    }
    tr.appendChild(stateCell);

    tr.appendChild(createCell(record.note));
    tbody.appendChild(tr);
  });
}


// ===== 重新整理整個畫面 =====

// 資料有任何變動（載入完成、新增、刪除）都呼叫這個函式
function refresh() {
  const records = allRecords();
  const days = buildDays(records);

  renderTable(records);
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
  exportInfo.textContent = localRecords.length > 0
    ? `有 ${localRecords.length} 筆新紀錄只存在這個瀏覽器，尚未寫入 data/kh-records.json。`
    : '所有紀錄都已寫入 data/kh-records.json。';
}


// ===== 新增與刪除 =====

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

// 表單的預設值：今天的日期，以及目前的添加量
function resetForm() {
  form.reset();
  form.elements.date.value = todayText();
  const dose = currentDose(buildDays(allRecords()));
  form.elements.dose_ml.value = dose ? dose.dose : '';
}

function handleSubmit(event) {
  // 表單預設會重新載入頁面，這裡攔下來改由 JS 處理
  event.preventDefault();

  // 從表單欄位讀出的值都是字串，數字要自己用 Number() 轉換
  const fields = form.elements;
  const type = fields.type.value;
  const record = {
    date: fields.date.value,
    time: fields.time.value,
    kh: Number(fields.kh.value),
    // 標準液不是魚缸水，添加量與排除標記對它沒有意義
    dose_ml: type === 'tank' && fields.dose_ml.value !== '' ? Number(fields.dose_ml.value) : null,
    type,
    exclude: type === 'tank' && fields.exclude.checked,
    note: fields.note.value.trim(),
  };

  // 必填、數值範圍已由 HTML 的 required、min、max 檢查，這裡補上其餘的檢查
  if (record.date > todayText()) {
    showFormMessage('日期不能是未來的日期。', true);
    return;
  }
  if (allRecords().some((existing) => isSameRecord(existing, record))) {
    showFormMessage('已經有一筆內容完全相同的紀錄。', true);
    return;
  }

  localRecords.push(record);
  const saved = saveLocalRecords(localRecords);
  refresh();
  resetForm();
  fields.kh.focus();

  if (saved) {
    showFormMessage(`已新增 ${formatShortDate(record.date)} 的紀錄（KH ${record.kh.toFixed(1)}）。`, false);
  } else {
    showFormMessage('已新增，但瀏覽器無法儲存，重新整理後會消失，請立即匯出 JSON。', true);
  }
}

function deleteLocalRecord(record) {
  if (!confirm(`確定要刪除 ${record.date} KH ${record.kh.toFixed(1)} 這筆紀錄嗎？`)) {
    return;
  }
  // filter：留下「不是這一筆」的紀錄，等於把它刪掉
  localRecords = localRecords.filter((item) => item !== record);
  saveLocalRecords(localRecords);
  refresh();
  showFormMessage('已刪除。', false);
}

function handleExport() {
  downloadText('kh-records.json', toJsonText(allRecords()));
}


// ===== 主流程 =====

async function init() {
  try {
    fileRecords = await loadRecords();

    // 暫存的紀錄如果已經出現在檔案裡（代表已匯出並取代檔案），就從暫存移除
    const stored = loadLocalRecords();
    localRecords = stored.filter((local) => !fileRecords.some((item) => isSameRecord(item, local)));
    if (localRecords.length !== stored.length) {
      saveLocalRecords(localRecords);
    }

    refresh();
    resetForm();
    form.addEventListener('submit', handleSubmit);
    exportButton.addEventListener('click', handleExport);
  } catch (error) {
    // 讀檔失敗、JSON 格式錯誤、欄位缺漏，都會跑到這裡
    console.error(error);
    statusEl.textContent = `資料載入失敗：${error.message}`;
    statusEl.classList.add('error');
  }
}

init();
