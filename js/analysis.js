// 分析：從一段期間的 KH 紀錄與添加量，估算缸子每天消耗多少 KH
//
// 原理：KH 每天的變化 = 添加劑補充的量 − 缸子消耗的量
// 把每一天的 KH 減掉「到那天為止累積補充的量」，剩下的數值只受消耗影響，
// 會隨時間直線下降，下降的斜率就是每日消耗量。
// 斜率用「最小平方法」求出：找一條最貼近所有資料點的直線，可以降低單次測量誤差的影響。

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DAYS = 5; // 區間內至少要有幾個測量日才計算

// 最小平方法：回傳直線的斜率，以及斜率的標準誤差（估計值可能偏離多少）
function linearFit(points) {
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;

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

// days：每日資料；windowDays：往回看幾天；perMl：1 mL 添加劑提高多少 dKH
// calibrationDate、factor：這個日期之前，實際添加量 = 紀錄的設定值 × factor
// 資料不足時回傳 null
export function analyzeConsumption(days, windowDays, perMl, calibrationDate, factor) {
  // 日期字串是 'YYYY-MM-DD'，可以直接用 < 比較先後
  const actualRatio = (date) => (date < calibrationDate ? factor : 1);

  const endTime = days[days.length - 1].time;
  const windowStart = endTime - windowDays * DAY_MS;
  const firstIndex = days.findIndex((day) => day.time > windowStart);
  const inWindow = days.slice(firstIndex);
  if (inWindow.length < MIN_DAYS) {
    return null;
  }

  // 區間開始時的添加量：某天沒有記錄添加量時，沿用前一次的數值
  let dose = null;
  days.slice(0, firstIndex + 1).forEach((day) => {
    if (day.dose != null) {
      dose = day.dose;
    }
  });
  if (dose === null) {
    return null;
  }

  // 逐日累計補充量，並算出「KH − 累計補充量」
  let supplied = 0;
  const points = [];
  inWindow.forEach((day, i) => {
    if (i > 0) {
      const gapDays = (day.time - inWindow[i - 1].time) / DAY_MS;
      // 上一個測量日到這一天之間補充的量（校準前要乘上實際出水比例）
      supplied += dose * actualRatio(inWindow[i - 1].date) * perMl * gapDays;
    }
    if (day.dose != null) {
      dose = day.dose;
    }
    points.push({ x: (day.time - inWindow[0].time) / DAY_MS, y: day.kh - supplied });
  });

  const spanDays = points[points.length - 1].x;
  const fit = linearFit(points);
  const supply = supplied / spanDays; // 平均每天補充量
  const consumption = -fit.slope;     // 每日淨消耗量

  return {
    from: inWindow[0].date,
    to: inWindow[inWindow.length - 1].date,
    count: inWindow.length,
    supply,
    consumption,
    error: fit.error * 2, // 取兩倍標準誤差作為估計範圍
    change: supply - consumption, // 區間內 KH 平均每天的變化
    corrected: inWindow[0].date < calibrationDate, // 區間內是否包含校準前的資料
  };
}
