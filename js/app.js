// 主程式：讀取資料，然後更新統計卡片、圖表與表格

import {
  loadRecords, buildDays, averageKh, currentDose,
  isStandard, isCounted, formatKh, formatDelta, formatShortDate,
} from './data.js';
import { renderCharts } from './chart.js';

// 目標 KH（dKH）。要調整目標時只改這一行
const TARGET_KH = 8.3;

const statusEl = document.querySelector('#status');
const tilesEl = document.querySelector('#tiles');
const tbody = document.querySelector('#kh-body');


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

    let state = '';
    if (isStandard(record)) {
      state = '標準液';
    } else if (!isCounted(record)) {
      state = '已排除';
    }
    if (state !== '') {
      tr.classList.add('not-counted');
    }

    tr.appendChild(createCell(record.date));
    tr.appendChild(createCell(record.time));
    tr.appendChild(createCell(record.kh.toFixed(1), 'num'));
    tr.appendChild(createCell(record.dose_ml ?? '', 'num'));
    tr.appendChild(createCell(state));
    tr.appendChild(createCell(record.note));

    tbody.appendChild(tr);
  });
}


// ===== 主流程 =====

async function init() {
  try {
    const records = await loadRecords();
    const days = buildDays(records);

    if (days.length === 0) {
      statusEl.textContent = '目前沒有可用的 KH 紀錄';
      return;
    }

    renderTiles(days);
    renderCharts({
      khBox: document.querySelector('#kh-chart'),
      doseBox: document.querySelector('#dose-chart'),
      area: document.querySelector('#chart-area'),
      tooltip: document.querySelector('#tooltip'),
      days,
      records,
      target: TARGET_KH,
    });
    renderTable(records);

    const notCounted = records.filter((record) => !isCounted(record)).length;
    statusEl.textContent =
      `${days[0].date} 至 ${days[days.length - 1].date}，共 ${days.length} 個測量日、${records.length} 筆讀值` +
      `（其中 ${notCounted} 筆不納入統計）`;
  } catch (error) {
    // 讀檔失敗、JSON 格式錯誤、欄位缺漏，都會跑到這裡
    console.error(error);
    statusEl.textContent = `資料載入失敗：${error.message}`;
    statusEl.classList.add('error');
  }
}

init();
