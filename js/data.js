// 資料處理：讀取 JSON、整理成「每日」資料、統計、格式化
//
// 一筆紀錄（record）的欄位：
//   date                'YYYY-MM-DD'
//   time                'HH:MM'，沒記就是 ''
//   kh                  KH 讀值（dKH）
//   dose_ml             當時滴定機的每日添加量設定（mL），沒記就是 null
//   type                'tank' 魚缸水、'standard' 標準液
//   method              測試方式：'hanna'、'salifert'、'other'，沒標示就是 ''
//   exclude             true 代表異常或可疑讀值，不納入統計
//   water_change_l      當天的換水量（公升），沒換水就是 null
//   water_change_timing 這筆讀值是在換水 'before' 之前、'after' 之後測的；沒註明就是 ''（計算時視為換水後）
//   event               事件，例如「滴定機校準」，沒有就是 ''
//   note                備註

const DATA_URL = 'data/kh-records.json';
export const DAY_MS = 24 * 60 * 60 * 1000; // 一天有幾毫秒

// 測試方式的代碼與顯示名稱
export const METHOD_LABELS = { hanna: 'Hanna', salifert: 'Salifert', other: '其他' };


// ===== 讀取 JSON 檔 =====

export async function loadRecords() {
  // cache: 'no-cache'：每次都向伺服器確認檔案有沒有更新，避免拿到瀏覽器快取的舊資料
  const response = await fetch(DATA_URL, { cache: 'no-cache' });

  // fetch 遇到 404 不會自動報錯，要自己檢查 response.ok
  if (!response.ok) {
    throw new Error(`讀取 ${DATA_URL} 失敗（HTTP ${response.status}）`);
  }
  return await response.json();
}


// ===== 判斷一筆紀錄的性質 =====

export function isStandard(record) {
  return record.type === 'standard';
}

// 是否納入統計：魚缸水，而且沒有被標為異常
export function isCounted(record) {
  return !isStandard(record) && record.exclude !== true;
}

// 這筆紀錄標示的換水量（公升）；沒有就是 0
export function waterChangeLiters(record) {
  return !isStandard(record) && record.water_change_l > 0 ? record.water_change_l : 0;
}

// 這筆讀值是不是在換水「之前」測的
export function isBeforeChange(record) {
  return waterChangeLiters(record) > 0 && record.water_change_timing === 'before';
}

export function methodLabel(method) {
  return METHOD_LABELS[method] ?? '';
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}


// ===== 把多筆紀錄整理成「一天一筆」 =====

// 回傳陣列，每個元素代表有紀錄的一天：
//   date, time(毫秒)
//   kh          當天的代表值：有效讀值的平均；換水日取「換水後」的平均。沒有有效讀值時是 null
//   khBefore    換水日「換水前」有效讀值的平均，沒有就是 null
//   khAfter     換水日「換水後」有效讀值的平均，沒有就是 null
//   counted     kh 是由幾筆讀值平均而來
//   dose        當天紀錄的添加量設定，沒記就是 null
//   doseInForce 當天生效的添加量：當天沒記就沿用前一次的數值
//   waterChange 當天的換水量（公升），沒換水是 0
//   events      當天的事件名稱
//   records     當天所有紀錄
export function buildDays(records) {
  // 1. 依日期分組。Map 是「鍵 → 值」的對照表，這裡是「日期 → 當天的紀錄陣列」
  const groups = new Map();
  records.forEach((record) => {
    if (!groups.has(record.date)) {
      groups.set(record.date, []);
    }
    groups.get(record.date).push(record);
  });

  // 2. 每一組算出當天的數值
  const days = [];
  groups.forEach((dayRecords, date) => {
    const tank = dayRecords.filter((record) => !isStandard(record));
    const counted = tank.filter(isCounted);

    // 同一天的多筆紀錄指的是同一次換水，所以取最大值而不是加總
    const waterChange = Math.max(0, ...tank.map(waterChangeLiters));
    const before = waterChange > 0 ? counted.filter(isBeforeChange) : [];
    const after = waterChange > 0 ? counted.filter((record) => !isBeforeChange(record)) : counted;

    const khBefore = before.length > 0 ? mean(before.map((record) => record.kh)) : null;
    const khAfter = after.length > 0 ? mean(after.map((record) => record.kh)) : null;

    // 添加量取當天最後一筆有填的數值
    const withDose = tank.filter((record) => record.dose_ml != null);

    // 事件名稱去掉空白與重複。Set 是「不重複的集合」
    const events = [...new Set(dayRecords.map((record) => record.event ?? '').filter((name) => name !== ''))];

    days.push({
      date,
      time: Date.parse(date), // 'YYYY-MM-DD' 轉成毫秒，方便計算天數與畫圖
      kh: khAfter ?? khBefore,
      khBefore: waterChange > 0 ? khBefore : null,
      khAfter: waterChange > 0 ? khAfter : null,
      counted: after.length > 0 ? after.length : before.length,
      dose: withDose.length > 0 ? withDose[withDose.length - 1].dose_ml : null,
      doseInForce: null,
      waterChange,
      events,
      records: dayRecords,
    });
  });

  // 3. 依日期由舊到新排序
  days.sort((a, b) => a.time - b.time);

  // 4. 沒有記錄添加量的日子，沿用前一次的數值
  let dose = null;
  days.forEach((day) => {
    if (day.dose != null) {
      dose = day.dose;
    }
    day.doseInForce = dose;
  });

  return days;
}


// ===== 統計 =====

// 最後一個有 KH 數值的日子；沒有時回傳 null
export function latestKhDay(days) {
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].kh !== null) {
      return days[i];
    }
  }
  return null;
}

// 計算某一天往前 n 天內（含當天）的 KH 平均；有數值的日子少於 minDays 時回傳 null
export function averageKh(days, endTime, n, minDays = 1) {
  const startTime = endTime - n * DAY_MS;
  const values = days
    .filter((day) => day.kh !== null && day.time > startTime && day.time <= endTime)
    .map((day) => day.kh);
  return values.length >= minDays ? mean(values) : null;
}

// 每一天的「近 7 天平均」，用來畫趨勢線。回傳的陣列跟 days 一一對應
export function trailingAverages(days, n = 7, minDays = 3) {
  return days.map((day) => (day.kh === null ? null : averageKh(days, day.time, n, minDays)));
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
