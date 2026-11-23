// 分析：估算缸子每天消耗多少 KH、換水的影響，以及不同測試方式的差距
//
// 原理：KH 的變化 = 添加劑補充的量 + 換水帶來的變化 − 缸子消耗的量
//
// 1. 添加劑：每天補充「添加量 × 每 mL 的效果」。
// 2. 換水：換掉一部分的水，KH 會往新海水的 KH 靠近。
//      換水後 KH = 換水前 KH + 換水比例 ×（新海水 KH − 換水前 KH）
// 3. 把每個觀測值減掉「累計的添加劑補充量」和「累計的換水變化」，剩下的數值只受消耗影響，
//    會隨時間直線下降，下降的斜率就是每日消耗量。
//    斜率用「最小平方法」求出：找一條最貼近所有資料點的直線，可以降低單次測量誤差的影響。

import { DAY_MS, isCounted, isBeforeChange } from './data.js';

const MIN_POINTS = 5; // 區間內至少要有幾個觀測值才計算

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

// 中位數：排序後位於正中間的值，不容易被少數極端值影響
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// 最小平方法：回傳直線的斜率，以及斜率的標準誤差（估計值可能偏離多少）
function linearFit(points) {
  const n = points.length;
  const meanX = mean(points.map((p) => p.x));
  const meanY = mean(points.map((p) => p.y));

  let sxx = 0;
  let sxy = 0;
  points.forEach((p) => {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
  });
  const slope = sxy / sxx;

  // 殘差：每個點離直線多遠。殘差越大，斜率越不可靠
  const intercept = meanY - slope * meanX;
  const sse = points.reduce((sum, p) => sum + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const error = Math.sqrt(sse / (n - 2) / sxx);

  return { slope, error };
}


// ===== 觀測點 =====

// 把每日資料轉成依時間排列的「觀測點」。一般的日子是一個點；
// 換水日如果換水前後都有讀值，會拆成兩個點。
// 每個點的 changed 是「上一個點到這個點之間換了幾公升的水」。
export function buildPoints(days) {
  const points = [];
  let pending = 0; // 已經換水、但還沒有下一個讀值可以對應的水量

  const add = (day, kh, changed) => {
    points.push({
      date: day.date,
      time: day.time,
      x: (day.time - days[0].time) / DAY_MS, // 距離第一天幾天
      kh,
      dose: day.doseInForce,
      changed,
    });
  };

  days.forEach((day) => {
    if (day.waterChange === 0) {
      if (day.kh !== null) {
        add(day, day.kh, pending);
        pending = 0;
      }
      return;
    }
    // 換水日
    if (day.khBefore !== null) {
      add(day, day.khBefore, pending);
      pending = 0;
    }
    if (day.khAfter !== null) {
      add(day, day.khAfter, pending + day.waterChange);
      pending = 0;
    } else {
      pending += day.waterChange; // 當天只有換水前的讀值，換水的影響會出現在下一個讀值
    }
  });
  return points;
}


// ===== 新海水的 KH =====

// 沒有實際量過新海水時，用歷次換水前後的讀值推算。
// 資料不足（少於 3 次可用的換水）時回傳 null。
export function estimateNewWaterKh(points, tankLiters) {
  // 1. 先算出「沒有換水的相鄰兩天，KH 平均變化多少」，用來扣掉換水當天原本就會有的變化
  const drifts = [];
  points.forEach((point, i) => {
    if (i > 0 && point.changed === 0 && point.x - points[i - 1].x === 1) {
      drifts.push(point.kh - points[i - 1].kh);
    }
  });
  const drift = drifts.length > 0 ? mean(drifts) : 0;

  // 2. 每一次換水：由「換水前後的 KH 差」和「換水比例」反推新海水的 KH
  const estimates = [];
  points.forEach((point, i) => {
    if (i === 0 || point.changed === 0) {
      return;
    }
    const previous = points[i - 1];
    const gap = point.x - previous.x;
    if (gap > 1) {
      return; // 前後讀值隔太久，不適合用來推算
    }
    const fraction = Math.min(1, point.changed / tankLiters);
    const jump = point.kh - previous.kh - drift * gap;
    estimates.push(previous.kh + jump / fraction);
  });
  if (estimates.length < 3) {
    return null;
  }

  // 3. 取中位數，並用各次結果的分散程度估計範圍
  const value = median(estimates);
  const spread = 1.4826 * median(estimates.map((item) => Math.abs(item - value)));
  const error = (2 * 1.2533 * spread) / Math.sqrt(estimates.length);
  return { value, low: value - error, high: value + error, count: estimates.length };
}

// 最近一段期間平均每天換幾公升的水（代表目前的換水習慣）
export function waterChangeRate(days, periodDays = 28) {
  const end = days[days.length - 1].time;
  const start = Math.max(days[0].time, end - (periodDays - 1) * DAY_MS);
  const liters = days
    .filter((day) => day.time >= start)
    .reduce((total, day) => total + day.waterChange, 0);
  const spanDays = (end - start) / DAY_MS + 1;
  return liters / spanDays;
}


// ===== 每日消耗量 =====

// points：觀測點；startTime：區間開始的時間（毫秒）
// perMl：1 mL 添加劑提高多少 dKH；tankLiters：系統水量
// newWaterKh：新海水 KH，null 代表不分開計算換水的影響
// calibrationDate、factor：這個日期之前，實際添加量 = 紀錄的設定值 × factor
// 資料不足時回傳 null
export function analyzeConsumption(points, { startTime, perMl, tankLiters, newWaterKh, calibrationDate, factor }) {
  const first = points.findIndex((point) => point.time >= startTime);
  const inWindow = first === -1 ? [] : points.slice(first);
  if (inWindow.length < MIN_POINTS || inWindow.some((point) => point.dose === null)) {
    return null;
  }
  const spanDays = inWindow[inWindow.length - 1].x - inWindow[0].x;
  if (spanDays < 3) {
    return null;
  }

  // 日期字串是 'YYYY-MM-DD'，可以直接用 < 比較先後
  const actualRatio = (date) => (date < calibrationDate ? factor : 1);

  let supplied = 0;    // 累計的添加劑補充量
  let jumped = 0;      // 累計的換水變化
  let liters = 0;      // 區間內換了幾公升
  let changeCount = 0; // 區間內換水幾次
  const fitPoints = [];

  inWindow.forEach((point, i) => {
    if (i > 0) {
      const previous = inWindow[i - 1];
      // 上一個觀測點到這一點之間補充的量（校準前要乘上實際出水比例）
      supplied += previous.dose * actualRatio(previous.date) * perMl * (point.x - previous.x);

      if (point.changed > 0) {
        liters += point.changed;
        changeCount += 1;
        if (newWaterKh !== null) {
          const fraction = Math.min(1, point.changed / tankLiters);
          jumped += fraction * (newWaterKh - previous.kh);
        }
      }
    }
    fitPoints.push({ x: point.x - inWindow[0].x, y: point.kh - supplied - jumped });
  });

  const fit = linearFit(fitPoints);
  const supply = supplied / spanDays;     // 平均每天由添加劑補充的量
  const waterSupply = jumped / spanDays;  // 平均每天由換水帶來的變化
  const consumption = -fit.slope;         // 每日消耗量

  return {
    from: inWindow[0].date,
    to: inWindow[inWindow.length - 1].date,
    count: new Set(inWindow.map((point) => point.date)).size, // 幾個測量日
    supply,
    waterSupply,
    consumption,
    error: fit.error * 2, // 取兩倍標準誤差作為估計範圍
    change: supply + waterSupply - consumption, // 區間內 KH 平均每天的變化
    liters,
    changeCount,
    corrected: inWindow[0].date < calibrationDate, // 區間內是否包含校準前的資料
  };
}


// ===== 測試方式比較 =====

// 找出同一天（而且同樣在換水前或換水後）兩種方式都有有效讀值的日子，比較兩者的差距
export function compareMethods(records, first = 'hanna', second = 'salifert') {
  const groups = new Map();
  records.filter(isCounted).forEach((record) => {
    const key = `${record.date}|${isBeforeChange(record) ? 'before' : 'after'}`;
    if (!groups.has(key)) {
      groups.set(key, { date: record.date, [first]: [], [second]: [] });
    }
    const group = groups.get(key);
    if (record.method === first || record.method === second) {
      group[record.method].push(record.kh);
    }
  });

  const pairs = [];
  groups.forEach((group) => {
    if (group[first].length > 0 && group[second].length > 0) {
      const a = mean(group[first]);
      const b = mean(group[second]);
      pairs.push({ date: group.date, first: a, second: b, diff: a - b });
    }
  });

  return {
    pairs,
    meanDiff: pairs.length > 0 ? mean(pairs.map((pair) => pair.diff)) : null,
    unlabeled: records.filter((record) => isCounted(record) && !record.method).length,
  };
}
