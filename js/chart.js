// 圖表：用 SVG 畫出 KH 趨勢圖與添加量階梯圖，並處理滑鼠／觸控／鍵盤查看數值
//
// KH 趨勢圖包含：
//   - 每一筆讀值（圓點，樣式依測試方式區分；被排除的畫 ×）
//   - 近 7 天平均線
//   - 目標線、換水標記（▲）、事件分隔線

import {
  DAY_MS, isStandard, isCounted, methodLabel, trailingAverages,
  formatKh, formatDateWithWeekday,
} from './data.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// 圖表四周留白（像素）：左邊放 Y 軸刻度，右邊放最後一點的數值，下面放日期
const MARGIN = { top: 8, right: 44, bottom: 24, left: 40 };
const KH_PLOT_HEIGHT = 230;
const DOSE_PLOT_HEIGHT = 96;
const EVENT_ROW = 16;    // 事件標籤每一列的高度
const WATER_BAND = 22;   // 換水標記那一列的高度
const X_PADDING = 6;     // 第一天與最後一天離圖的左右邊緣留一點距離
const MIN_TICK_GAP = 44; // X 軸日期標籤之間最少要隔幾個像素


// ===== 小工具 =====

// 建立一個 SVG 元素並設定屬性。SVG 元素必須用 createElementNS 建立
function svgEl(name, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

// 建立一般的 HTML 元素
function htmlEl(name, className, text) {
  const el = document.createElement(name);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

// 線性比例尺：把資料的範圍 [d0, d1] 對應到畫面的像素範圍 [r0, r1]
function scale(d0, d1, r0, r1) {
  if (d0 === d1) {
    return () => (r0 + r1) / 2;
  }
  return (value) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

// 量出一段 12px 的文字畫出來有多寬（像素）。
// 借用 canvas（畫布）的 measureText 來量；量不了的時候用估計的：中文字約 12，英數字約 7
let measurer = null;
function textWidth(text) {
  if (measurer === null) {
    measurer = document.createElement('canvas').getContext('2d') ?? false;
    if (measurer) {
      measurer.font = `12px ${getComputedStyle(document.body).fontFamily}`;
    }
  }
  if (measurer) {
    return measurer.measureText(text).width;
  }
  return [...text].reduce((width, char) => width + (char.charCodeAt(0) > 0x2e7f ? 12 : 7), 0);
}

// 把文字縮短到指定寬度以內，放不下的部分用「…」代替
function fitText(text, maxWidth) {
  if (textWidth(text) <= maxWidth) {
    return text;
  }
  const chars = [...text];
  while (chars.length > 1 && textWidth(`${chars.join('')}…`) > maxWidth) {
    chars.pop();
  }
  return `${chars.join('')}…`;
}

// 讀值的種類，決定圓點的樣式
function readingKind(record) {
  if (!isCounted(record)) {
    return 'excluded';
  }
  if (record.method === 'hanna' || record.method === 'salifert') {
    return record.method;
  }
  return 'none';
}

// 畫 ×：兩條交叉的短線
function addCross(parent, cx, cy, size) {
  parent.appendChild(svgEl('line', { class: 'cross', x1: cx - size, y1: cy - size, x2: cx + size, y2: cy + size }));
  parent.appendChild(svgEl('line', { class: 'cross', x1: cx - size, y1: cy + size, x2: cx + size, y2: cy - size }));
}

// 畫 ▲
function addTriangle(parent, cx, cy, size) {
  parent.appendChild(svgEl('path', {
    class: 'water-mark',
    d: `M${cx},${cy - size} L${cx + size},${cy + size} L${cx - size},${cy + size} Z`,
  }));
}

// 圖例與提示框裡的小圖示，樣式跟圖上的標記一致
function makeKey(kind) {
  const svg = svgEl('svg', { class: 'key', viewBox: '0 0 16 12', width: 16, height: 12, 'aria-hidden': 'true' });
  if (kind === 'average' || kind === 'dose') {
    svg.appendChild(svgEl('line', { class: `line ${kind === 'dose' ? 'line-dose' : 'line-avg'}`, x1: 1, x2: 15, y1: 6, y2: 6 }));
  } else if (kind === 'excluded') {
    addCross(svg, 8, 6, 3.5);
  } else if (kind === 'water') {
    addTriangle(svg, 8, 6, 4);
  } else {
    svg.appendChild(svgEl('circle', { class: `reading reading-${kind}`, cx: 8, cy: 6, r: 3.5 }));
  }
  return svg;
}


// ===== 主函式 =====

// 只需要呼叫一次；之後資料或時間範圍變動時，呼叫回傳物件的 update() 重畫
// khBox、doseBox：放兩張圖的容器；area：包住兩張圖的外層
// tooltip：提示框；legend：圖例；target：目標 KH
export function renderCharts({ khBox, doseBox, area, tooltip, legend, target }) {
  let data = null;       // 要畫的資料（已依時間範圍篩選）
  let state = null;      // 目前這次繪圖用到的比例尺與元素
  let hoverIndex = null; // 目前查看的是第幾天

  // ----- 整理要畫的資料 -----

  // rangeDays：只顯示最近幾天；0 代表全部
  function prepare(days, rangeDays) {
    const averages = trailingAverages(days); // 用全部資料計算，範圍開頭的平均值才正確
    const end = days[days.length - 1].time;
    const start = rangeDays > 0 ? Math.max(days[0].time, end - (rangeDays - 1) * DAY_MS) : days[0].time;

    const visible = [];
    days.forEach((day, i) => {
      if (day.time >= start) {
        visible.push({ ...day, average: averages[i] });
      }
    });

    // 每一筆魚缸水的讀值都畫成一個標記
    const readings = [];
    visible.forEach((day) => {
      day.records.forEach((record) => {
        if (!isStandard(record)) {
          readings.push({ time: day.time, kh: record.kh, kind: readingKind(record) });
        }
      });
    });

    return { days: visible, readings, start, end };
  }

  // ----- 圖例 -----

  // 只列出目前範圍內實際出現的項目
  function drawLegend() {
    const kinds = new Set(data.readings.map((reading) => reading.kind));
    const hasMethod = kinds.has('hanna') || kinds.has('salifert');
    const items = [];

    if (data.days.some((day) => day.average !== null)) {
      items.push(['average', '近 7 天平均']);
    }
    if (kinds.has('hanna')) {
      items.push(['hanna', 'Hanna 讀值']);
    }
    if (kinds.has('salifert')) {
      items.push(['salifert', 'Salifert 讀值']);
    }
    if (kinds.has('none')) {
      items.push(['none', hasMethod ? '未標示測試方式的讀值' : '每筆讀值']);
    }
    if (kinds.has('excluded')) {
      items.push(['excluded', '已排除讀值']);
    }

    legend.replaceChildren(...items.map(([kind, text]) => {
      const li = document.createElement('li');
      li.append(makeKey(kind), text);
      return li;
    }));
  }

  // ----- 繪圖 -----

  function draw() {
    const width = khBox.clientWidth;
    if (width === 0 || data === null) {
      return;
    }
    const left = MARGIN.left;
    const right = width - MARGIN.right;
    const x = scale(data.start, data.end, left + X_PADDING, right - X_PADDING);
    const events = layoutEvents(x, width);

    const kh = drawKh(width, left, right, x, events);
    const dose = drawDose(width, left, right, x, events);
    state = { width, x, kh, dose };

    // 重畫後，如果原本正在查看某一天，就恢復顯示
    if (hoverIndex !== null) {
      showDay(Math.min(hoverIndex, data.days.length - 1));
    }
  }

  // 決定每個事件標籤放在哪裡：預設放在分隔線右邊，放不下就放左邊；
  // 兩邊都放不下就放在比較寬的那一邊並縮短文字；互相重疊就往下一列排
  function layoutEvents(x, width) {
    const rows = []; // 每一列目前排到的右邊界
    const events = [];

    data.days.forEach((day) => {
      if (day.events.length === 0) {
        return;
      }
      const fullLabel = day.events.join('、');
      const px = x(day.time);
      const roomRight = width - 6 - (px + 4); // 分隔線右邊還有多少空間
      const roomLeft = px - 4 - 6;            // 分隔線左邊還有多少空間

      let fitsRight = roomRight >= roomLeft;
      if (textWidth(fullLabel) <= roomRight) {
        fitsRight = true;
      } else if (textWidth(fullLabel) <= roomLeft) {
        fitsRight = false;
      }
      const label = fitText(fullLabel, fitsRight ? roomRight : roomLeft);
      const labelWidth = textWidth(label);
      const startX = fitsRight ? px + 4 : px - 4 - labelWidth;

      let row = rows.findIndex((edge) => edge + 8 <= startX);
      if (row === -1) {
        row = rows.length;
      }
      rows[row] = startX + labelWidth;
      events.push({ px, label, row, textX: fitsRight ? px + 4 : px - 4, anchor: fitsRight ? 'start' : 'end' });
    });
    return events;
  }

  // X 軸要標哪些日期
  function xTicks(x) {
    const spanDays = Math.round((data.end - data.start) / DAY_MS);
    let candidates = [];

    if (spanDays <= 45) {
      // 範圍短：從最後一天往回，每 7 天一個
      for (let time = data.end; time >= data.start; time -= 7 * DAY_MS) {
        candidates.push(time);
      }
    } else {
      // 範圍長：每月 1 日與 15 日；超過 150 天只標 1 日
      const startDate = new Date(data.start);
      const daysOfMonth = spanDays > 150 ? [1] : [1, 15];
      for (let year = startDate.getUTCFullYear(), month = startDate.getUTCMonth(); ; month++) {
        if (Date.UTC(year, month, 1) > data.end) {
          break;
        }
        daysOfMonth.forEach((dayOfMonth) => {
          const time = Date.UTC(year, month, dayOfMonth);
          if (time >= data.start && time <= data.end) {
            candidates.push(time);
          }
        });
      }
      candidates.sort((a, b) => b - a); // 由新到舊
    }

    // 由右往左挑，跟上一個標籤靠太近就跳過
    const ticks = [];
    let lastPx = Infinity;
    candidates.forEach((time) => {
      const px = x(time);
      if (lastPx - px >= MIN_TICK_GAP) {
        ticks.push(time);
        lastPx = px;
      }
    });
    return ticks;
  }

  function drawXAxis(svg, x, baseline) {
    xTicks(x).forEach((time) => {
      const date = new Date(time);
      const month = date.getUTCMonth() + 1;
      const dayOfMonth = date.getUTCDate();
      // 1 月 1 日加上年份，資料跨年時才分得出來
      const label = month === 1 && dayOfMonth === 1 ? `${date.getUTCFullYear()}/1/1` : `${month}/${dayOfMonth}`;
      svg.appendChild(svgEl('text', {
        class: 'tick', x: x(time), y: baseline + 16, 'text-anchor': 'middle',
      }, label));
    });
  }

  // 水平格線與 Y 軸刻度
  function drawYAxis(svg, ticks, y, left, right, format) {
    ticks.forEach((tick) => {
      svg.appendChild(svgEl('line', {
        class: 'grid', x1: left, x2: right, y1: y(tick), y2: y(tick),
      }));
      svg.appendChild(svgEl('text', {
        class: 'tick', x: left - 8, y: y(tick) + 4, 'text-anchor': 'end',
      }, format(tick)));
    });
  }

  // 事件分隔線
  function drawEventLines(svg, events, top, bottom) {
    events.forEach((event) => {
      svg.appendChild(svgEl('line', { class: 'event-line', x1: event.px, x2: event.px, y1: top, y2: bottom }));
    });
  }

  // 查看數值時用的元素：垂直線與圓點，平常隱藏
  function addHoverMarks(svg, top, bottom, dotClass) {
    const crosshair = svgEl('line', { class: 'crosshair', y1: top, y2: bottom, visibility: 'hidden' });
    const dot = svgEl('circle', { class: `dot ${dotClass}`, r: 5, visibility: 'hidden' });
    svg.appendChild(crosshair);
    svg.appendChild(dot);
    return { crosshair, dot };
  }

  // KH 趨勢圖
  function drawKh(width, left, right, x, events) {
    const eventRows = events.reduce((max, event) => Math.max(max, event.row + 1), 0);
    const top = MARGIN.top + eventRows * EVENT_ROW;
    const bottom = top + KH_PLOT_HEIGHT;
    const hasWater = data.days.some((day) => day.waterChange > 0);
    const baseline = bottom + (hasWater ? WATER_BAND : 0);
    const height = baseline + MARGIN.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, 'aria-hidden': 'true' });

    // Y 軸範圍：涵蓋所有讀值、平均線與目標值，並取到 0.5 的倍數
    const withAverage = data.days.filter((day) => day.average !== null);
    const values = data.readings.map((reading) => reading.kh)
      .concat(withAverage.map((day) => day.average), target);
    const min = Math.floor(Math.min(...values) * 2) / 2;
    const max = Math.max(min + 0.5, Math.ceil(Math.max(...values) * 2) / 2);
    const y = scale(min, max, bottom, top);

    const ticks = [];
    for (let i = 0; i <= Math.round((max - min) / 0.5); i++) {
      ticks.push(min + i * 0.5);
    }
    drawYAxis(svg, ticks, y, left, right, (tick) => tick.toFixed(1));
    drawXAxis(svg, x, baseline);

    // 事件：分隔線與上方的名稱
    drawEventLines(svg, events, top, bottom);
    events.forEach((event) => {
      svg.appendChild(svgEl('text', {
        class: 'event-label', x: event.textX, y: MARGIN.top + event.row * EVENT_ROW + 11, 'text-anchor': event.anchor,
      }, event.label));
    });

    // 目標線（虛線）。標籤放在線的上方，太靠近頂端時改放下方
    const targetY = y(target);
    svg.appendChild(svgEl('line', { class: 'target', x1: left, x2: right, y1: targetY, y2: targetY }));
    svg.appendChild(svgEl('text', {
      class: 'target-label', x: left + 4, y: targetY - top < 16 ? targetY + 14 : targetY - 6,
    }, `目標 ${formatKh(target)}`));

    // 換水標記：畫在圖的下緣，左邊標示「換水」
    if (hasWater) {
      svg.appendChild(svgEl('text', { class: 'tick', x: left - 8, y: bottom + 18, 'text-anchor': 'end' }, '換水'));
      data.days.forEach((day) => {
        if (day.waterChange > 0) {
          addTriangle(svg, x(day.time), bottom + 13, 4.5);
        }
      });
    }

    // 近 7 天平均線：把每一天的座標串成 "M x,y L x,y L x,y ..." 的路徑
    if (withAverage.length > 1) {
      const path = withAverage
        .map((day, i) => `${i === 0 ? 'M' : 'L'}${x(day.time).toFixed(1)},${y(day.average).toFixed(1)}`)
        .join(' ');
      svg.appendChild(svgEl('path', { class: 'line line-avg', d: path }));
    }

    // 讀值：資料越密，圓點越小。先畫沒標示方式的，再畫有標示的，最後畫被排除的
    const pixelsPerDay = (right - left) / Math.max(1, (data.end - data.start) / DAY_MS);
    const radius = pixelsPerDay >= 9 ? 3.5 : pixelsPerDay >= 4.5 ? 2.75 : 2;
    ['none', 'hanna', 'salifert'].forEach((kind) => {
      data.readings.filter((reading) => reading.kind === kind).forEach((reading) => {
        svg.appendChild(svgEl('circle', {
          class: `reading reading-${kind}`, cx: x(reading.time), cy: y(reading.kh), r: radius,
        }));
      });
    });
    data.readings.filter((reading) => reading.kind === 'excluded').forEach((reading) => {
      addCross(svg, x(reading.time), y(reading.kh), 4);
    });

    // 平均線的最後一點：標出數值
    if (withAverage.length > 0) {
      const last = withAverage[withAverage.length - 1];
      svg.appendChild(svgEl('circle', { class: 'dot dot-kh', cx: x(last.time), cy: y(last.average), r: 4 }));
      svg.appendChild(svgEl('text', {
        class: 'end-label', x: x(last.time) + 9, y: y(last.average) + 4,
      }, formatKh(last.average)));
    }

    const marks = addHoverMarks(svg, top, bottom, 'dot-kh');
    khBox.replaceChildren(svg);
    return { y, ...marks };
  }

  // 添加量階梯圖
  function drawDose(width, left, right, x, events) {
    const top = MARGIN.top;
    const bottom = top + DOSE_PLOT_HEIGHT;
    const height = bottom + MARGIN.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, 'aria-hidden': 'true' });

    const steps = data.days.filter((day) => day.doseInForce !== null);
    if (steps.length === 0) {
      drawXAxis(svg, x, bottom);
      doseBox.replaceChildren(svg);
      return null;
    }

    // Y 軸範圍：上下各多留一點，取到 2 的倍數
    const doses = steps.map((day) => day.doseInForce);
    const min = Math.max(0, Math.floor((Math.min(...doses) - 1) / 2) * 2);
    const max = Math.ceil((Math.max(...doses) + 1) / 2) * 2;
    const y = scale(min, max, bottom, top);

    // 刻度先試每 4 一格，格數太少就改成每 2 一格
    let ticks = [];
    [4, 2].forEach((step) => {
      if (ticks.length < 2) {
        ticks = [];
        for (let tick = Math.ceil(min / step) * step; tick <= max; tick += step) {
          ticks.push(tick);
        }
      }
    });
    drawYAxis(svg, ticks, y, left, right, (tick) => String(tick));
    drawXAxis(svg, x, bottom);
    drawEventLines(svg, events, top, bottom);

    // 階梯線：先水平走到下一天（H），再垂直走到新的添加量（V）
    let path = `M${x(steps[0].time).toFixed(1)},${y(steps[0].doseInForce).toFixed(1)}`;
    steps.slice(1).forEach((day) => {
      path += ` H${x(day.time).toFixed(1)} V${y(day.doseInForce).toFixed(1)}`;
    });
    svg.appendChild(svgEl('path', { class: 'line line-dose', d: path }));

    const last = steps[steps.length - 1];
    svg.appendChild(svgEl('circle', { class: 'dot dot-dose', cx: x(last.time), cy: y(last.doseInForce), r: 4 }));
    svg.appendChild(svgEl('text', {
      class: 'end-label', x: x(last.time) + 9, y: y(last.doseInForce) + 4,
    }, String(last.doseInForce)));

    const marks = addHoverMarks(svg, top, bottom, 'dot-dose');
    doseBox.replaceChildren(svg);
    return { y, ...marks };
  }

  // ----- 查看某一天的數值 -----

  function showDay(index) {
    hoverIndex = index;
    const day = data.days[index];
    const px = state.x(day.time);

    // 兩張圖的垂直線與圓點移到這一天。KH 圖的圓點優先放在平均線上
    const khValue = day.average ?? day.kh;
    moveMarks(state.kh, px, khValue === null ? null : state.kh.y(khValue));
    if (state.dose) {
      moveMarks(state.dose, px, day.doseInForce === null ? null : state.dose.y(day.doseInForce));
    }

    fillTooltip(day);

    // 提示框放在垂直線右邊；右邊放不下就改放左邊
    tooltip.hidden = false;
    const tipWidth = tooltip.offsetWidth;
    let tipLeft = px + 12;
    if (tipLeft + tipWidth > state.width) {
      tipLeft = Math.max(0, px - 12 - tipWidth);
    }
    tooltip.style.left = `${tipLeft}px`;
    tooltip.style.top = `${khBox.offsetTop + 8}px`;
  }

  function moveMarks(marks, px, py) {
    marks.crosshair.setAttribute('x1', px);
    marks.crosshair.setAttribute('x2', px);
    marks.crosshair.setAttribute('visibility', 'visible');
    if (py === null) {
      marks.dot.setAttribute('visibility', 'hidden');
      return;
    }
    marks.dot.setAttribute('cx', px);
    marks.dot.setAttribute('cy', py);
    marks.dot.setAttribute('visibility', 'visible');
  }

  function hide() {
    hoverIndex = null;
    tooltip.hidden = true;
    if (state === null) {
      return;
    }
    [state.kh, state.dose].forEach((marks) => {
      if (marks) {
        marks.crosshair.setAttribute('visibility', 'hidden');
        marks.dot.setAttribute('visibility', 'hidden');
      }
    });
  }

  // 提示框的一列：小圖示、數值（粗體）、說明
  function tipRow(kind, value, label) {
    const row = htmlEl('div', 'tip-row');
    row.append(makeKey(kind), htmlEl('strong', '', value), htmlEl('span', '', label));
    return row;
  }

  // 提示框內容。一律用 textContent 填入文字，備註不會被當成 HTML 執行
  function fillTooltip(day) {
    tooltip.replaceChildren();
    tooltip.appendChild(htmlEl('div', 'tip-date', formatDateWithWeekday(day.date)));

    if (day.average !== null) {
      tooltip.appendChild(tipRow('average', formatKh(day.average), 'dKH 近 7 天平均'));
    }
    if (day.kh !== null) {
      let label = 'dKH 當日';
      if (day.khBefore !== null && day.khAfter !== null) {
        label += `（換水後；換水前 ${formatKh(day.khBefore)}）`;
      } else if (day.counted > 1) {
        label += `（${day.counted} 筆平均）`;
      }
      tooltip.appendChild(tipRow('none', formatKh(day.kh), label));
    }
    if (day.doseInForce !== null) {
      tooltip.appendChild(tipRow('dose', String(day.doseInForce), 'mL 添加量'));
    }
    if (day.waterChange > 0) {
      tooltip.appendChild(tipRow('water', String(day.waterChange), 'L 換水'));
    }
    if (day.events.length > 0) {
      tooltip.appendChild(htmlEl('div', 'tip-event', `事件：${day.events.join('、')}`));
    }

    // 當天有多筆紀錄或有備註時，逐筆列出
    const hasDetail = day.records.length > 1 || (day.records[0].note ?? '') !== '';
    if (hasDetail) {
      const list = htmlEl('ul', 'tip-list');
      day.records.forEach((record) => {
        // 例如「8.2（Hanna，已排除）初測；可疑高值」
        const tags = [];
        if (methodLabel(record.method) !== '') {
          tags.push(methodLabel(record.method));
        }
        if (isStandard(record)) {
          tags.push('標準液');
        } else if (!isCounted(record)) {
          tags.push('已排除');
        }
        let text = formatKh(record.kh);
        text += tags.length > 0 ? `（${tags.join('，')}）` : ' ';
        text += record.note ?? '';
        list.appendChild(htmlEl('li', '', text));
      });
      tooltip.appendChild(list);
    }
  }

  // 滑鼠位置 → 最接近的那一天
  function nearestIndex(clientX) {
    const px = clientX - khBox.getBoundingClientRect().left;
    let best = 0;
    data.days.forEach((day, i) => {
      if (Math.abs(state.x(day.time) - px) < Math.abs(state.x(data.days[best].time) - px)) {
        best = i;
      }
    });
    return best;
  }

  // ----- 事件 -----

  [khBox, doseBox].forEach((box) => {
    const show = (event) => {
      if (state !== null) {
        showDay(nearestIndex(event.clientX));
      }
    };
    box.addEventListener('pointermove', show);
    box.addEventListener('pointerdown', show);
  });

  // 滑鼠移開圖表時關閉提示框。
  // 觸控螢幕的手指一離開螢幕也會觸發 pointerleave，這時要讓提示框留著，
  // 改成點圖表以外的地方才關閉，不然在手機上點一下就消失，來不及看
  area.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') {
      hide();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!area.contains(event.target)) {
      hide();
    }
  });

  // 鍵盤：圖表取得焦點後，用左右方向鍵逐日查看，Esc 關閉
  khBox.addEventListener('keydown', (event) => {
    if (state === null) {
      return;
    }
    if (event.key === 'Escape') {
      hide();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const last = data.days.length - 1;
    const current = hoverIndex === null ? last : hoverIndex;
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    showDay(Math.min(last, Math.max(0, current + step)));
  });
  khBox.addEventListener('blur', hide);

  // 視窗寬度改變時重畫，圖表才會跟著容器縮放
  new ResizeObserver(() => {
    if (!state || state.width !== khBox.clientWidth) {
      draw();
    }
  }).observe(khBox);

  return {
    update(days, rangeDays) {
      hide();
      data = prepare(days, rangeDays);
      drawLegend();
      draw();
    },
  };
}
