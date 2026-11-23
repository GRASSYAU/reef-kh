// 圖表：用 SVG 畫出 KH 折線圖與添加量階梯圖，並處理滑鼠／鍵盤查看數值

import { isStandard, isCounted, formatKh, formatDateWithWeekday } from './data.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// 圖表四周留白（像素）：左邊放 Y 軸刻度，右邊放最後一點的數值，下面放日期
const MARGIN = { top: 12, right: 44, bottom: 26, left: 36 };
const KH_HEIGHT = 280;
const DOSE_HEIGHT = 150;


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


// ===== 主函式 =====

// khBox、doseBox：放兩張圖的容器；area：包住兩張圖的外層；tooltip：提示框
// days：每日資料（buildDays 的結果）；records：原始紀錄；target：目標 KH
export function renderCharts({ khBox, doseBox, area, tooltip, days, records, target }) {
  let state = null;      // 目前這次繪圖用到的比例尺與元素
  let hoverIndex = null; // 目前查看的是第幾天

  // 被排除的魚缸讀值，要在圖上用 × 標出來
  const excluded = records
    .filter((record) => !isStandard(record) && !isCounted(record))
    .map((record) => ({ time: Date.parse(record.date), kh: record.kh }));

  // ----- 繪圖 -----

  function draw() {
    const width = khBox.clientWidth;
    if (width === 0) {
      return;
    }
    const left = MARGIN.left;
    const right = width - MARGIN.right;
    const x = scale(days[0].time, days[days.length - 1].time, left, right);

    const kh = drawKh(width, left, right, x);
    const dose = drawDose(width, left, right, x);
    state = { width, x, kh, dose };

    // 重畫後，如果原本正在查看某一天，就恢復顯示
    if (hoverIndex !== null) {
      showDay(hoverIndex);
    }
  }

  // X 軸：每月 1 日畫刻度；圖夠寬時 15 日也畫
  function drawXAxis(svg, x, bottom, width) {
    const start = new Date(days[0].time);
    const endTime = days[days.length - 1].time;
    const dayOfMonth = width >= 560 ? [1, 15] : [1];

    for (let year = start.getUTCFullYear(), month = start.getUTCMonth(); ; month++) {
      const monthStart = Date.UTC(year, month, 1);
      if (monthStart > endTime) {
        break;
      }
      dayOfMonth.forEach((d) => {
        const time = Date.UTC(year, month, d);
        if (time < days[0].time || time > endTime) {
          return;
        }
        const date = new Date(time);
        const label = `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
        svg.appendChild(svgEl('text', {
          class: 'tick', x: x(time), y: bottom + 18, 'text-anchor': 'middle',
        }, label));
      });
    }
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

  // 查看數值時用的元素：垂直線與圓點，平常隱藏
  function addHoverMarks(svg, top, bottom, dotClass) {
    const crosshair = svgEl('line', { class: 'crosshair', y1: top, y2: bottom, visibility: 'hidden' });
    const dot = svgEl('circle', { class: `dot ${dotClass}`, r: 5, visibility: 'hidden' });
    svg.appendChild(crosshair);
    svg.appendChild(dot);
    return { crosshair, dot };
  }

  // KH 折線圖
  function drawKh(width, left, right, x) {
    const top = MARGIN.top;
    const bottom = KH_HEIGHT - MARGIN.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${KH_HEIGHT}`, height: KH_HEIGHT, 'aria-hidden': 'true' });

    // Y 軸範圍：涵蓋所有讀值與目標值，並取到 0.5 的倍數
    const values = days.map((day) => day.kh).concat(excluded.map((item) => item.kh), target);
    const min = Math.floor(Math.min(...values) * 2) / 2;
    const max = Math.ceil(Math.max(...values) * 2) / 2;
    const y = scale(min, max, bottom, top);

    const ticks = [];
    for (let tick = min; tick <= max + 0.001; tick += 0.5) {
      ticks.push(tick);
    }
    drawYAxis(svg, ticks, y, left, right, (tick) => tick.toFixed(1));
    drawXAxis(svg, x, bottom, width);

    // 目標線（虛線）
    svg.appendChild(svgEl('line', { class: 'target', x1: left, x2: right, y1: y(target), y2: y(target) }));
    svg.appendChild(svgEl('text', { class: 'target-label', x: left + 4, y: y(target) - 6 }, `目標 ${formatKh(target)}`));

    // 被排除的讀值：畫 ×
    excluded.forEach((item) => {
      const cx = x(item.time);
      const cy = y(item.kh);
      svg.appendChild(svgEl('line', { class: 'cross', x1: cx - 4, y1: cy - 4, x2: cx + 4, y2: cy + 4 }));
      svg.appendChild(svgEl('line', { class: 'cross', x1: cx - 4, y1: cy + 4, x2: cx + 4, y2: cy - 4 }));
    });

    // 折線：把每一天的座標串成 "M x,y L x,y L x,y ..." 的路徑
    const path = days.map((day, i) => `${i === 0 ? 'M' : 'L'}${x(day.time).toFixed(1)},${y(day.kh).toFixed(1)}`).join(' ');
    svg.appendChild(svgEl('path', { class: 'line line-kh', d: path }));

    // 最後一天：畫圓點並標出數值
    const last = days[days.length - 1];
    svg.appendChild(svgEl('circle', { class: 'dot dot-kh', cx: x(last.time), cy: y(last.kh), r: 5 }));
    svg.appendChild(svgEl('text', { class: 'end-label', x: x(last.time) + 10, y: y(last.kh) + 4 }, formatKh(last.kh)));

    const marks = addHoverMarks(svg, top, bottom, 'dot-kh');
    khBox.replaceChildren(svg);
    return { y, ...marks };
  }

  // 添加量階梯圖
  function drawDose(width, left, right, x) {
    const top = MARGIN.top;
    const bottom = DOSE_HEIGHT - MARGIN.bottom;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${DOSE_HEIGHT}`, height: DOSE_HEIGHT, 'aria-hidden': 'true' });

    const withDose = days.filter((day) => day.dose != null);
    if (withDose.length === 0) {
      doseBox.replaceChildren(svg);
      return null;
    }

    // Y 軸範圍：上下各多留一點，取到 2 的倍數
    const doses = withDose.map((day) => day.dose);
    const min = Math.floor((Math.min(...doses) - 1) / 2) * 2;
    const max = Math.ceil((Math.max(...doses) + 1) / 2) * 2;
    const y = scale(min, max, bottom, top);

    const ticks = [];
    for (let tick = Math.ceil(min / 4) * 4; tick <= max; tick += 4) {
      ticks.push(tick);
    }
    drawYAxis(svg, ticks, y, left, right, (tick) => String(tick));
    drawXAxis(svg, x, bottom, width);

    // 階梯線：先水平走到下一天（H），再垂直走到新的添加量（V）
    let path = `M${x(withDose[0].time).toFixed(1)},${y(withDose[0].dose).toFixed(1)}`;
    withDose.slice(1).forEach((day) => {
      path += ` H${x(day.time).toFixed(1)} V${y(day.dose).toFixed(1)}`;
    });
    svg.appendChild(svgEl('path', { class: 'line line-dose', d: path }));

    const last = withDose[withDose.length - 1];
    svg.appendChild(svgEl('circle', { class: 'dot dot-dose', cx: x(last.time), cy: y(last.dose), r: 5 }));
    svg.appendChild(svgEl('text', { class: 'end-label', x: x(last.time) + 10, y: y(last.dose) + 4 }, String(last.dose)));

    const marks = addHoverMarks(svg, top, bottom, 'dot-dose');
    doseBox.replaceChildren(svg);
    return { y, ...marks };
  }

  // ----- 查看某一天的數值 -----

  function showDay(index) {
    hoverIndex = index;
    const day = days[index];
    const px = state.x(day.time);

    // 兩張圖的垂直線與圓點移到這一天
    moveMarks(state.kh, px, state.kh.y(day.kh));
    if (state.dose) {
      moveMarks(state.dose, px, day.dose != null ? state.dose.y(day.dose) : null);
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
    [state.kh, state.dose].forEach((marks) => {
      if (marks) {
        marks.crosshair.setAttribute('visibility', 'hidden');
        marks.dot.setAttribute('visibility', 'hidden');
      }
    });
  }

  // 提示框內容。一律用 textContent 填入文字，備註不會被當成 HTML 執行
  function fillTooltip(day) {
    tooltip.replaceChildren();
    tooltip.appendChild(htmlEl('div', 'tip-date', formatDateWithWeekday(day.date)));

    const khRow = htmlEl('div', 'tip-row');
    khRow.appendChild(htmlEl('span', 'key key-line'));
    khRow.appendChild(htmlEl('strong', '', formatKh(day.kh)));
    khRow.appendChild(htmlEl('span', '', day.counted > 1 ? `dKH（${day.counted} 筆平均）` : 'dKH'));
    tooltip.appendChild(khRow);

    if (day.dose != null) {
      const doseRow = htmlEl('div', 'tip-row');
      doseRow.appendChild(htmlEl('span', 'key key-dose'));
      doseRow.appendChild(htmlEl('strong', '', String(day.dose)));
      doseRow.appendChild(htmlEl('span', '', 'mL 添加量'));
      tooltip.appendChild(doseRow);
    }

    // 當天有多筆讀值或有備註時，逐筆列出
    const hasDetail = day.records.length > 1 || day.records[0].note !== '';
    if (hasDetail) {
      const list = htmlEl('ul', 'tip-list');
      day.records.forEach((record) => {
        let text = formatKh(record.kh);
        if (isStandard(record)) {
          text += '（標準液）';
        } else if (!isCounted(record)) {
          text += '（已排除）';
        }
        if (record.note !== '') {
          text += ` ${record.note}`;
        }
        list.appendChild(htmlEl('li', '', text));
      });
      tooltip.appendChild(list);
    }
  }

  // 滑鼠位置 → 最接近的那一天
  function nearestIndex(clientX) {
    const px = clientX - khBox.getBoundingClientRect().left;
    let best = 0;
    days.forEach((day, i) => {
      if (Math.abs(state.x(day.time) - px) < Math.abs(state.x(days[best].time) - px)) {
        best = i;
      }
    });
    return best;
  }

  // ----- 事件 -----

  [khBox, doseBox].forEach((box) => {
    box.addEventListener('pointermove', (event) => showDay(nearestIndex(event.clientX)));
    box.addEventListener('pointerdown', (event) => showDay(nearestIndex(event.clientX)));
  });
  area.addEventListener('pointerleave', hide);

  // 鍵盤：圖表取得焦點後，用左右方向鍵逐日查看，Esc 關閉
  khBox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hide();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const current = hoverIndex === null ? days.length - 1 : hoverIndex;
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    showDay(Math.min(days.length - 1, Math.max(0, current + step)));
  });
  khBox.addEventListener('blur', hide);

  // 視窗寬度改變時重畫，圖表才會跟著容器縮放
  new ResizeObserver(() => {
    if (!state || state.width !== khBox.clientWidth) {
      draw();
    }
  }).observe(khBox);

  draw();
}
