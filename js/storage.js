// 瀏覽器暫存與匯出
//
// 在網頁上做的新增、修改、刪除，在儲存到專案之前先放在 localStorage。
// localStorage 是瀏覽器內建的小型儲存空間，只能存字串，
// 所以存的時候用 JSON.stringify 把物件轉成字串，讀的時候用 JSON.parse 轉回來。
// 資料只存在「這台裝置的這個瀏覽器」，清除瀏覽資料就會消失。
//
// 暫存的內容是「相對於資料檔的變更」，分成三類：
//   added    新增的紀錄
//   removed  要從資料檔中刪除的紀錄
//   replaced 修改的紀錄，每一項是 { from: 資料檔裡原本的內容, to: 修改後的內容 }

import { methodLabel } from './data.js';

const STORAGE_KEY = 'reef-kh:changes';
const OLD_STORAGE_KEY = 'reef-kh:new-records'; // 最早的版本只存新增的紀錄


// ===== 紀錄的比較與整理 =====

// 把一筆紀錄補齊成完整、固定順序的欄位（舊資料可能缺少後來才加的欄位）
export function normalizeRecord(record) {
  const liters = record.water_change_l > 0 ? record.water_change_l : null;
  return {
    date: record.date,
    time: record.time ?? '',
    kh: record.kh,
    dose_ml: record.dose_ml ?? null,
    type: record.type ?? 'tank',
    method: record.method ?? '',
    exclude: record.exclude === true,
    water_change_l: liters,
    water_change_timing: liters === null ? '' : (record.water_change_timing ?? ''),
    event: record.event ?? '',
    note: record.note ?? '',
  };
}

// 判斷兩筆紀錄的內容是否完全相同：補齊欄位後轉成文字再比較
export function isSameRecord(a, b) {
  return JSON.stringify(normalizeRecord(a)) === JSON.stringify(normalizeRecord(b));
}


// ===== 讀寫暫存 =====

export function emptyChanges() {
  return { added: [], removed: [], replaced: [] };
}

// 讀出暫存的變更；沒有資料或讀取失敗時回傳空的變更
export function loadChanges() {
  const changes = emptyChanges();
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (stored) {
      changes.added = Array.isArray(stored.added) ? stored.added : [];
      changes.removed = Array.isArray(stored.removed) ? stored.removed : [];
      changes.replaced = Array.isArray(stored.replaced) ? stored.replaced : [];
    }

    // 最早的版本留下的暫存紀錄，轉成新格式後把舊的刪掉
    const old = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) ?? 'null');
    if (Array.isArray(old)) {
      changes.added = changes.added.concat(old);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
      localStorage.removeItem(OLD_STORAGE_KEY);
    }
  } catch (error) {
    console.error(error);
  }
  return changes;
}

// 存入暫存；成功回傳 true，失敗（例如無痕模式或空間已滿）回傳 false
export function saveChanges(changes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changes));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export function countChanges(changes) {
  return changes.added.length + changes.removed.length + changes.replaced.length;
}

// 例如「新增 1 筆、修改 2 筆」
export function describeChanges(changes) {
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
  return parts.join('、');
}


// ===== 把變更套用到資料檔的紀錄上 =====

// 回傳 records（套用變更後的所有紀錄）與 origin（每一筆紀錄的來源）
export function applyChanges(fileRecords, changes) {
  const origin = new Map();
  const records = [];
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
      records.push(entry.to);
      origin.set(entry.to, { kind: 'replaced', entry });
      return;
    }
    records.push(record);
    origin.set(record, { kind: 'file' });
  });

  // 新增的：接在後面。資料檔裡已經有內容相同的紀錄時不重複加入
  changes.added.forEach((record) => {
    if (fileRecords.some((item) => isSameRecord(item, record))) {
      return;
    }
    records.push(record);
    origin.set(record, { kind: 'added' });
  });

  // 依日期排序，同一天的維持原本的先後順序
  records.sort((a, b) => a.date.localeCompare(b.date));
  return { records, origin };
}

// 資料檔更新後，把已經寫進資料檔的變更從暫存移除。有移除任何項目時回傳 true
export function cleanChanges(fileRecords, changes) {
  const inFile = (record) => fileRecords.some((item) => isSameRecord(item, record));
  const before = JSON.stringify(changes);

  changes.added = changes.added.filter((record) => !inFile(record));
  changes.removed = changes.removed.filter(inFile);
  changes.replaced = changes.replaced.filter((entry) => {
    if (inFile(entry.from)) {
      return true; // 資料檔裡還是舊內容，修改尚未寫入
    }
    if (!inFile(entry.to)) {
      changes.added.push(entry.to); // 原本的那筆已不在資料檔裡，修改後的內容改當成新增
    }
    return false;
  });

  return JSON.stringify(changes) !== before;
}

// 舊版（還沒有測試方式、換水、事件欄位時）存下來的變更，欄位比資料檔裡的紀錄少，直接比對會對不上。
// 這裡用舊欄位找回資料檔裡對應的紀錄，並讓修改後的內容沿用新欄位。有調整時回傳 true
export function upgradeChanges(fileRecords, changes) {
  const isLegacy = (record) => !('method' in record);
  const legacyText = (record) => JSON.stringify([
    record.date, record.time ?? '', record.kh, record.dose_ml ?? null,
    record.type ?? 'tank', record.exclude === true, record.note ?? '',
  ]);
  const findInFile = (record) => fileRecords.find((item) => legacyText(item) === legacyText(record));
  let upgraded = false;

  changes.added = changes.added.map((record) => {
    if (!isLegacy(record)) {
      return record;
    }
    upgraded = true;
    return normalizeRecord(record);
  });

  changes.removed = changes.removed.map((record) => {
    if (!isLegacy(record)) {
      return record;
    }
    upgraded = true;
    return normalizeRecord(findInFile(record) ?? record);
  });

  changes.replaced.forEach((entry) => {
    if (!isLegacy(entry.from)) {
      return;
    }
    upgraded = true;
    const match = findInFile(entry.from);
    if (match) {
      const { method, water_change_l, water_change_timing, event } = normalizeRecord(match);
      entry.to = normalizeRecord({ method, water_change_l, water_change_timing, event, ...entry.to });
      entry.from = normalizeRecord(match);
    } else {
      entry.from = normalizeRecord(entry.from);
      entry.to = normalizeRecord(entry.to);
    }
  });

  return upgraded;
}


// ===== 匯出 =====

// 把所有紀錄轉成跟 data/kh-records.json 相同的排版：一筆一行
export function toJsonText(records) {
  const lines = records.map((record) => {
    // 每個欄位轉成 "名稱": 值，再用逗號接起來。JSON.stringify 會處理引號等特殊字元
    const parts = Object.entries(normalizeRecord(record))
      .map(([key, value]) => `"${key}": ${JSON.stringify(value)}`);
    return `  {${parts.join(', ')}}`;
  });
  return '[\n' + lines.join(',\n') + '\n]\n';
}

// CSV 的一個儲存格：內容有逗號、引號或換行時要用引號包起來
// isText 為 true 的欄位（備註等自由輸入的文字），開頭如果是 = + - @，
// Excel 會把它當成公式執行，所以在前面加一個單引號讓它保持純文字
function csvCell(value, isText = false) {
  let text = String(value ?? '');
  if (isText && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

// 轉成可以用 Excel 開啟的 CSV（逗號分隔值）
export function toCsvText(records) {
  const header = ['日期', '時間', 'KH (dKH)', '添加量 (mL)', '水樣', '測試方式', '不納入統計', '換水量 (L)', '讀值在換水前或後', '事件', '備註'];
  const timing = { before: '前', after: '後' };

  const lines = records.map((item) => {
    const record = normalizeRecord(item);
    return [
      csvCell(record.date),
      csvCell(record.time),
      csvCell(record.kh),
      csvCell(record.dose_ml),
      csvCell(record.type === 'standard' ? '標準液' : '魚缸水'),
      csvCell(methodLabel(record.method)),
      csvCell(record.exclude ? '是' : ''),
      csvCell(record.water_change_l),
      csvCell(timing[record.water_change_timing] ?? ''),
      csvCell(record.event, true),
      csvCell(record.note, true),
    ].join(',');
  });

  // 開頭的 ﻿ 是 BOM（位元組順序記號），Excel 看到它才會用 UTF-8 讀檔，中文才不會變亂碼
  return '﻿' + [header.join(',')].concat(lines).join('\r\n') + '\r\n';
}

// 讓瀏覽器下載一個文字檔
export function downloadText(filename, text, mimeType = 'application/json') {
  // Blob：把文字包成「檔案內容」；createObjectURL：產生一個暫時的下載網址
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
