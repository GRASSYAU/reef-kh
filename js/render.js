// 畫面更新：把算好的資料變成統計卡片、分析結果、測試方式比較與紀錄表格
// 這個檔案只負責「顯示」，不會修改資料

import {
  DAY_MS, latestKhDay, averageKh, currentDose, isStandard, isCounted, methodLabel, waterChangeLiters,
  formatKh, formatDelta, formatShortDate,
} from './data.js';
import {
  buildPoints, estimateNewWaterKh, waterChangeRate, analyzeConsumption, compareMethods,
} from './analysis.js';
import {
  TARGET_KH, TANK_LITERS, PRODUCT, DILUTION, CALIBRATION, NEW_SALTWATER_KH, khPerMl,
} from './config.js';

// 建立一個 HTML 元素。文字一律用 textContent 填入，不會被當成 HTML 執行
function el(name, className, text) {
  const element = document.createElement(name);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

// 帶正負號、固定小數兩位：0.043 → "+0.04"
function formatSigned(value) {
  const text = Math.abs(value).toFixed(2);
  if (Number(text) === 0) {
    return '±0.00';
  }
  return (value > 0 ? '+' : '−') + text;
}

// 最後一個有事件的日子；沒有時回傳 null
function lastEventDay(days) {
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].events.length > 0) {
      return days[i];
    }
  }
  return null;
}


// ===== 統計卡片 =====

// 建立一張卡片：標題、主要數值、單位、補充說明
function createTile(label, value, unit, sub) {
  const tile = el('div', 'tile');
  const valueEl = el('div', 'tile-value', value);
  if (unit) {
    valueEl.appendChild(el('span', 'tile-unit', unit));
  }
  tile.append(el('div', 'tile-label', label), valueEl, el('div', 'tile-sub', sub));
  return tile;
}

export function renderTiles(container, days) {
  const latest = latestKhDay(days);
  container.replaceChildren();

  // 1. 最新 KH
  let latestSub = formatShortDate(latest.date);
  if (latest.khBefore !== null && latest.khAfter !== null) {
    latestSub += '，換水後';
  } else if (latest.counted > 1) {
    latestSub += `，${latest.counted} 筆平均`;
  }
  container.appendChild(createTile('最新 KH', formatKh(latest.kh), 'dKH', latestSub));

  // 2. 距離目標
  const gap = TARGET_KH - latest.kh;
  container.appendChild(gap > 0.005
    ? createTile('距離目標還差', formatKh(gap), 'dKH', `目標 ${formatKh(TARGET_KH)} dKH`)
    : createTile('距離目標', '已達標', '', `目標 ${formatKh(TARGET_KH)} dKH`));

  // 3. 近 7 天平均，並跟再往前的 7 天比較
  const week = averageKh(days, latest.time, 7);
  const previousWeek = averageKh(days, latest.time - 7 * DAY_MS, 7);
  const weekSub = previousWeek === null
    ? '沒有前 7 天的資料可比較'
    : `較前 7 天 ${formatDelta(week - previousWeek)}`;
  container.appendChild(createTile('近 7 天平均', formatKh(week), 'dKH', weekSub));

  // 4. 目前添加量
  const dose = currentDose(days);
  if (dose) {
    container.appendChild(createTile('目前添加量', String(dose.dose), 'mL／天', `自 ${formatShortDate(dose.since)} 起`));
  }
}


// ===== 消耗量與建議添加量 =====

// 「計算區間」下拉選單的選項。有事件紀錄時，多一個「自上次事件起」
export function windowOptions(days) {
  const options = [
    { value: '7', label: '最近 7 天' },
    { value: '14', label: '最近 14 天' },
    { value: '30', label: '最近 30 天' },
  ];
  const eventDay = lastEventDay(days);
  if (eventDay) {
    options.push({
      value: 'event',
      label: `自 ${formatShortDate(eventDay.date)}「${eventDay.events.join('、')}」起`,
    });
  }
  return options;
}

// 一組結果：小標題加上「名稱 — 數值與說明」的清單
function createGroup(container, title) {
  container.appendChild(el('h3', '', title));
  const list = el('dl', 'analysis-list');
  container.appendChild(list);

  return (term, value, note) => {
    const dd = el('dd');
    dd.appendChild(el('strong', '', value));
    if (note) {
      dd.appendChild(el('span', '', note));
    }
    list.append(el('dt', '', term), dd);
  };
}

// 「計算依據」：把設定值與推算出來的數字列出來，方便核對
function renderBasis(list, perMl, newWater, litersPerDay) {
  const items = [
    `系統水量 ${TANK_LITERS} L。`,
    `${PRODUCT.name}：每 ${PRODUCT.labelLiters} L 添加 ${PRODUCT.labelMl} mL 原液，提高 ${PRODUCT.labelRise} dKH。`,
    `稀釋比例：原液 ${DILUTION.stockMl} mL 加水至 ${DILUTION.totalMl} mL。換算後，1 mL 稀釋液約提高 ${perMl.toFixed(4)} dKH。`,
    `滴定機於 ${CALIBRATION.date} 校準。校準前實際出水量為設定值的 ${CALIBRATION.factorLow * 100}% 至 ${CALIBRATION.factorHigh * 100}%，` +
      `計算時以 ${CALIBRATION.factor * 100}% 換算，並把上下限算進估計範圍。`,
    `換水習慣：最近 28 天平均每週換水 ${(litersPerDay * 7).toFixed(1)} L。建議添加量假設之後維持相同的換水量。`,
  ];

  if (newWater === null) {
    items.push('換水紀錄不足，無法推算新海水的 KH，所以沒有把換水的影響分開計算。');
  } else if (newWater.measured) {
    items.push(`新海水 KH：${formatKh(newWater.value)} dKH（實測值，設定在 js/config.js）。`);
  } else {
    items.push(
      `新海水 KH：沒有實測值，由 ${newWater.count} 次換水前後的讀值推算約 ${newWater.value.toFixed(1)} dKH` +
      `（範圍 ${newWater.low.toFixed(1)} 至 ${newWater.high.toFixed(1)}）。` +
      '實際量過新海水後，填入 js/config.js 的 NEW_SALTWATER_KH 會更準確。',
    );
  }
  items.push('「目前的 KH」以近 7 天平均計算，比單日讀值穩定。');

  list.replaceChildren(...items.map((text) => el('li', '', text)));
}

// els：{ result, message, basis } 三個容器
// windowValue：計算區間（'7'、'14'、'30' 或 'event'）；reachDays：預計幾天到達目標
export function renderAnalysis(els, days, { windowValue, reachDays }) {
  const perMl = khPerMl();
  const latest = latestKhDay(days);
  const points = buildPoints(days);
  const messages = [];

  els.result.replaceChildren();
  const showMessages = () => {
    els.message.textContent = messages.join(' ');
    els.message.hidden = messages.length === 0;
  };

  // 新海水的 KH：有實測值就用實測值，否則用換水前後的讀值推算
  let newWater = null;
  if (NEW_SALTWATER_KH !== null) {
    newWater = { value: NEW_SALTWATER_KH, low: NEW_SALTWATER_KH, high: NEW_SALTWATER_KH, measured: true };
  } else {
    const estimate = estimateNewWaterKh(points, TANK_LITERS);
    if (estimate !== null) {
      newWater = { ...estimate, measured: false };
    }
  }
  const litersPerDay = waterChangeRate(days);
  renderBasis(els.basis, perMl, newWater, litersPerDay);

  // 計算區間從哪一天開始
  const eventDay = lastEventDay(days);
  const startTime = windowValue === 'event' && eventDay
    ? eventDay.time
    : latest.time - (Number(windowValue === 'event' ? 14 : windowValue) - 1) * DAY_MS;

  const run = (factor, newKh) => analyzeConsumption(points, {
    startTime,
    perMl,
    tankLiters: TANK_LITERS,
    newWaterKh: newKh,
    calibrationDate: CALIBRATION.date,
    factor,
  });
  const main = run(CALIBRATION.factor, newWater ? newWater.value : null);
  if (main === null) {
    messages.push('這個區間的有效讀值不足 5 筆、涵蓋不到 3 天，或沒有添加量紀錄，無法計算。請改選較長的區間。');
    showMessages();
    return;
  }

  // ----- 第一組：消耗量 -----

  const now = averageKh(days, latest.time, 7);
  const gap = TARGET_KH - now;
  const reachValid = Number.isInteger(reachDays) && reachDays >= 3 && reachDays <= 60;

  // 由一組計算結果算出各種情況下需要的添加量
  const dosing = (result, newKh) => {
    // 換水平均每天帶來的 KH 變化：缸子的 KH 越接近新海水，換水補充得越少
    const water = (kh) => (newKh === null ? 0 : (litersPerDay / TANK_LITERS) * (newKh - kh));
    const hold = (kh) => (result.consumption - water(kh)) / perMl;
    return {
      consumption: result.consumption,
      holdNow: hold(now),
      holdTarget: hold(TARGET_KH),
      reach: (result.consumption - water((now + TARGET_KH) / 2) + gap / (reachValid ? reachDays : 14)) / perMl,
    };
  };
  const center = dosing(main, newWater ? newWater.value : null);

  // 估計範圍：把「校準前出水比例」和「新海水 KH」的上下限各算一次，取最小與最大，
  // 再加上測量誤差造成的範圍
  const factors = main.corrected
    ? [CALIBRATION.factorLow, CALIBRATION.factor, CALIBRATION.factorHigh]
    : [CALIBRATION.factor];
  let waters = [null];
  if (newWater !== null) {
    waters = newWater.measured ? [newWater.value] : [newWater.low, newWater.value, newWater.high];
  }
  const range = {};
  factors.forEach((factor) => {
    waters.forEach((newKh) => {
      const result = run(factor, newKh);
      const values = dosing(result, newKh);
      Object.keys(values).forEach((key) => {
        const error = key === 'consumption' ? result.error : result.error / perMl;
        const [low, high] = range[key] ?? [Infinity, -Infinity];
        range[key] = [Math.min(low, values[key] - error), Math.max(high, values[key] + error)];
      });
    });
  });
  const mlRange = (key) => `估計範圍 ${Math.max(0, range[key][0]).toFixed(1)} 至 ${Math.max(0, range[key][1]).toFixed(1)} mL`;

  const addUsage = createGroup(
    els.result,
    `消耗量（${formatShortDate(main.from)} 至 ${formatShortDate(main.to)}，${main.count} 個測量日）`,
  );
  addUsage(
    '添加劑補充（理論）',
    `${main.supply.toFixed(2)} dKH／天`,
    `平均實際添加 ${(main.supply / perMl).toFixed(1)} mL／天` +
      (main.corrected ? `（校準前以設定值的 ${CALIBRATION.factor * 100}% 計）` : ''),
  );
  if (newWater !== null) {
    addUsage(
      '換水補充（估計）',
      `${formatSigned(main.waterSupply)} dKH／天`,
      main.changeCount > 0 ? `區間內換水 ${main.changeCount} 次，共 ${main.liters} L` : '區間內沒有換水',
    );
  }
  addUsage('KH 平均變化', `${formatSigned(main.change)} dKH／天`, '補充的量減去消耗的量');
  addUsage(
    '每日消耗量',
    `${main.consumption.toFixed(2)} dKH／天`,
    `估計範圍 ${Math.max(0, range.consumption[0]).toFixed(2)} 至 ${range.consumption[1].toFixed(2)}`,
  );

  if (main.consumption <= 0) {
    messages.push('算出的消耗量不是正數，代表這段期間的資料無法反映實際消耗（例如測量誤差過大），請改選其他區間。');
    showMessages();
    return;
  }

  // ----- 第二組：建議添加量 -----

  const addDose = createGroup(els.result, '建議添加量');
  const dose = currentDose(days);
  if (dose) {
    addDose(
      `目前設定 ${dose.dose} mL／天`,
      `預計每天 ${formatSigned((dose.dose - center.holdNow) * perMl)} dKH`,
      `估計範圍 ${formatSigned((dose.dose - range.holdNow[1]) * perMl)} 至 ${formatSigned((dose.dose - range.holdNow[0]) * perMl)}`,
    );
  }
  addDose(`維持目前的 KH（${formatKh(now)}）`, `約 ${center.holdNow.toFixed(1)} mL／天`, mlRange('holdNow'));

  if (gap <= 0.005) {
    addDose(`目標 ${formatKh(TARGET_KH)}`, '已達標', '維持上面的添加量即可');
  } else {
    if (reachValid) {
      const risePerDay = gap / reachDays;
      addDose(
        `${reachDays} 天到達 ${formatKh(TARGET_KH)}`,
        `約 ${center.reach.toFixed(1)} mL／天`,
        `每天上升 ${risePerDay.toFixed(2)} dKH；${mlRange('reach')}`,
      );
      if (risePerDay > 0.5) {
        messages.push('每天上升超過 0.5 dKH，變化偏快，建議拉長天數。');
      }
    } else {
      messages.push('「預計幾天到達目標」請輸入 3 到 60 的整數。');
    }
    addDose(
      `到達 ${formatKh(TARGET_KH)} 之後維持`,
      `約 ${center.holdTarget.toFixed(1)} mL／天`,
      mlRange('holdTarget') + (newWater !== null && newWater.value > TARGET_KH ? '；KH 越高，換水補充得越少，所以比目前的維持量多' : ''),
    );
  }
  showMessages();
}


// ===== 測試方式比較 =====

export function renderMethods(container, records) {
  const result = compareMethods(records, 'hanna', 'salifert');
  container.replaceChildren();

  if (result.pairs.length === 0) {
    container.appendChild(el('p', '', '目前沒有同一天用 Hanna 和 Salifert 兩種方式測量的有效讀值，無法比較兩者的差距。'));
  } else {
    const diff = result.meanDiff;
    const summary = Math.abs(diff) < 0.005
      ? '兩者平均沒有差距'
      : `Hanna 平均比 Salifert ${diff > 0 ? '高' : '低'} ${Math.abs(diff).toFixed(2)} dKH`;
    container.appendChild(el('p', '', `同一天用兩種方式測量的有 ${result.pairs.length} 天，${summary}。`));

    const table = el('table', 'mini-table');
    const head = el('tr');
    ['日期', 'Hanna', 'Salifert', '差距'].forEach((text, i) => {
      const th = el('th', i > 0 ? 'num' : '', text);
      th.scope = 'col';
      head.appendChild(th);
    });
    const thead = el('thead');
    thead.appendChild(head);
    const tbody = el('tbody');
    result.pairs.forEach((pair) => {
      const tr = el('tr');
      tr.append(
        el('td', '', pair.date),
        el('td', 'num', formatKh(pair.first)),
        el('td', 'num', formatKh(pair.second)),
        el('td', 'num', formatDelta(pair.diff)),
      );
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    container.appendChild(table);
    container.appendChild(el('p', 'hint', '比對的天數少時，差距可能只是單次測量的誤差；累積更多天，才看得出有沒有固定的偏差。'));
  }

  if (result.unlabeled > 0) {
    container.appendChild(el('p', 'hint', `另有 ${result.unlabeled} 筆有效讀值沒有標示測試方式，可以在下方的紀錄按「編輯」補上。`));
  }
}


// ===== 紀錄表格 =====

// 一個儲存格。label 與 unit 是手機版面用的：窄螢幕沒有表頭，改在數值前後顯示名稱與單位
function createCell(text, className, label, unit) {
  const td = el('td', className, text === '' ? undefined : String(text));
  if (label) {
    td.dataset.label = label;
  }
  if (unit) {
    td.dataset.unit = unit;
  }
  return td;
}

function createButton(text, label, onClick) {
  const button = el('button', 'small', text);
  button.type = 'button';
  button.setAttribute('aria-label', label); // 給螢幕閱讀器的完整說明
  button.addEventListener('click', onClick);
  return button;
}

// origin：每一筆紀錄的來源（資料檔、新增的、修改過的）；editing：正在編輯的那一筆
// limit：最多顯示幾筆，0 代表全部；onEdit、onDelete：按下按鈕時要呼叫的函式
export function renderTable(tbody, records, { origin, editing, limit, onEdit, onDelete }) {
  tbody.replaceChildren();

  // 最新的排在最上面。slice() 先複製一份再反轉，不會改到原本的陣列
  const newestFirst = records.slice().reverse();
  const visible = limit > 0 ? newestFirst.slice(0, limit) : newestFirst;

  visible.forEach((record) => {
    const tr = el('tr');

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
      states.push('新增，尚未儲存');
    } else if (kind === 'replaced') {
      states.push('已修改，尚未儲存');
    }
    if (record === editing) {
      tr.classList.add('editing');
    }

    let water = '';
    const liters = waterChangeLiters(record);
    if (liters > 0) {
      const timing = { before: '（前）', after: '（後）' }[record.water_change_timing] ?? '';
      water = `${liters} L${timing}`;
    }

    tr.appendChild(createCell(record.date, 'cell-date'));
    tr.appendChild(createCell(record.time ?? '', ''));
    tr.appendChild(createCell(record.kh.toFixed(1), 'num cell-kh', 'KH'));
    tr.appendChild(createCell(record.dose_ml ?? '', 'num', '添加量', 'mL'));
    tr.appendChild(createCell(methodLabel(record.method), '', '測試'));
    tr.appendChild(createCell(water, '', '換水'));
    tr.appendChild(createCell(states.join('、'), 'cell-state'));

    // 備註欄：有事件時先顯示事件，再顯示備註
    const noteCell = el('td', 'cell-note');
    if (record.event) {
      noteCell.appendChild(el('span', 'event-tag', `事件：${record.event}`));
    }
    if (record.note) {
      noteCell.appendChild(document.createTextNode(record.note));
    }
    tr.appendChild(noteCell);

    const name = `${record.date} KH ${record.kh.toFixed(1)}`;
    const actions = el('td', 'cell-actions');
    actions.appendChild(createButton('編輯', `編輯 ${name} 的紀錄`, () => onEdit(record)));
    actions.appendChild(createButton('刪除', `刪除 ${name} 的紀錄`, () => onDelete(record)));
    tr.appendChild(actions);

    tbody.appendChild(tr);
  });
}
