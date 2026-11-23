// 資料處理：讀取 JSON、整理成「每日」資料、數字格式化

const DATA_URL = 'data/kh-records.json';
const DAY_MS = 24 * 60 * 60 * 1000; // 一天有幾毫秒


// ===== 讀取 JSON 檔 =====

export async function loadRecords() {
  const response = await fetch(DATA_URL);

  // fetch 遇到 404 不會自動報錯，要自己檢查 response.ok
  if (!response.ok) {
    throw new Error(`讀取 ${DATA_URL} 失敗（HTTP ${response.status}）`);
  }
  return await response.json();
}


// ===== 判斷一筆讀值是否納入統計 =====

// 沒寫 type 的紀錄視為魚缸水；沒寫 exclude 的視為不排除
export function isStandard(record) {
  return record.type === 'standard';
}

export function isCounted(record) {
  return !isStandard(record) && record.exclude !== true;
}


// ===== 把多筆讀值整理成「一天一筆」 =====

// 回傳陣列，每個元素代表一天：
// { date, time(毫秒), kh(有效讀值平均), dose(添加量), counted(有效筆數), records(當天所有紀錄) }
export function buildDays(records) {
  // 1. 依日期分組。Map 是「鍵 → 值」的對照表，這裡是「日期 → 當天的紀錄陣列」
  const groups = new Map();
  records.forEach((record) => {
    if (!groups.has(record.date)) {
      groups.set(record.date, []);
    }
    groups.get(record.date).push(record);
  });

  // 2. 每一組算出當天的代表值
  const days = [];
  groups.forEach((dayRecords, date) => {
    const counted = dayRecords.filter(isCounted);

    // 當天沒有任何有效讀值（例如只測了標準液），就不列入每日資料
    if (counted.length === 0) {
      return;
    }

    // reduce：把陣列「累加」成一個值，這裡用來算總和
    const sum = counted.reduce((total, record) => total + record.kh, 0);

    // 添加量取當天最後一筆有填的數值
    const withDose = counted.filter((record) => record.dose_ml != null);
    const dose = withDose.length > 0 ? withDose[withDose.length - 1].dose_ml : null;

    days.push({
      date,
      time: Date.parse(date), // 'YYYY-MM-DD' 轉成毫秒，方便計算天數與畫圖
      kh: sum / counted.length,
      dose,
      counted: counted.length,
      records: dayRecords,
    });
  });

  // 3. 依日期由舊到新排序
  days.sort((a, b) => a.time - b.time);
  return days;
}


// ===== 統計 =====

// 計算某一天往前 n 天內（含當天）的 KH 平均；沒有資料時回傳 null
export function averageKh(days, endTime, n) {
  const startTime = endTime - n * DAY_MS;
  const inRange = days.filter((day) => day.time > startTime && day.time <= endTime);
  if (inRange.length === 0) {
    return null;
  }
  return inRange.reduce((total, day) => total + day.kh, 0) / inRange.length;
}

// 找出目前的添加量，以及這個添加量是從哪一天開始的
export function currentDose(days) {
  const withDose = days.filter((day) => day.dose != null);
  if (withDose.length === 0) {
    return null;
  }

  const latest = withDose[withDose.length - 1];
  let since = latest;
  // 從最後一天往回找，直到添加量不一樣為止
  for (let i = withDose.length - 1; i >= 0 && withDose[i].dose === latest.dose; i--) {
    since = withDose[i];
  }
  return { dose: latest.dose, since: since.date };
}


// ===== 格式化 =====

// KH 顯示到小數兩位，但尾巴的 0 省略一個：7.15 → "7.15"、7.6 → "7.6"、8 → "8.0"
export function formatKh(value) {
  return value.toFixed(2).replace(/0$/, '');
}

// 帶正負號的差值：0.12 → "+0.12"、-0.3 → "−0.3"
export function formatDelta(value) {
  const text = formatKh(Math.abs(value));
  if (Number(text) === 0) {
    return '±0';
  }
  return (value > 0 ? '+' : '−') + text;
}

// '2026-11-22' → '11/22'
export function formatShortDate(date) {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

// '2026-11-22' → '11/22（日）'
export function formatDateWithWeekday(date) {
  const weekday = '日一二三四五六'[new Date(Date.parse(date)).getUTCDay()];
  return `${formatShortDate(date)}（${weekday}）`;
}
