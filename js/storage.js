// 瀏覽器暫存與匯出
//
// 在網頁上做的新增、修改、刪除，在儲存到專案之前先放在 localStorage。
// localStorage 是瀏覽器內建的小型儲存空間，只能存字串，
// 所以存的時候用 JSON.stringify 把物件轉成字串，讀的時候用 JSON.parse 轉回來。
// 資料只存在「這台裝置的這個瀏覽器」，清除瀏覽資料就會消失。
//
// 每一筆紀錄都有一個不會重複的 id（識別碼）。暫存的內容是「相對於資料檔的變更」，用 id 指出是哪一筆：
//   upserts  新增或修改後的紀錄。資料檔裡沒有這個 id 就是新增，有就是修改
//   deletes  要刪除的紀錄的 id
//
// 用 id 而不是用內容來認紀錄，是因為內容可能重複（例如連續兩天的讀值一模一樣），
// 用內容比對會分不清楚改的是哪一筆。

import { methodLabel } from './data.js';

export const CHANGES_KEY = 'reef-kh:pending';
// 舊版的暫存格式（用內容比對，沒有 id），讀到時會轉成新格式
const LEGACY_CHANGES_KEY = 'reef-kh:changes';
const LEGACY_ADDED_KEY = 'reef-kh:new-records';


// ===== 紀錄的 id、比較與整理 =====

// 產生一個新的 id：目前時間（毫秒）加上亂數，轉成 36 進位的短字串，例如 "mi4k2x9q7t3"
export function createId() {
  const random = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return Date.now().toString(36) + random;
}

// 把一筆紀錄補齊成完整、固定順序的欄位（舊資料可能缺少後來才加的欄位）
export function normalizeRecord(record) {
  const liters = record.water_change_l > 0 ? record.water_change_l : null;
  return {
    id: record.id ?? '',
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

// 紀錄的內容（不含 id）轉成文字，用來比較兩筆的內容是否相同
function contentText(record) {
  const { id, ...content } = normalizeRecord(record);
  return JSON.stringify(content);
}

export function isSameContent(a, b) {
  return contentText(a) === contentText(b);
}

// 把文字算成一個固定的短代碼（FNV-1a 雜湊）：相同的文字一定得到相同的結果
function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// 確保每一筆紀錄都有不重複的 id。
// 資料檔裡沒有 id 的紀錄（例如手動加進去的），依內容算出固定的 id，重新整理後還是同一個；
// id 重複的（例如複製貼上整行），後面的加上編號
export function withIds(records) {
  const seenContent = new Map(); // 相同內容已經出現幾次
  const usedIds = new Set();

  return records.map((record) => {
    let id = record.id;
    if (!id) {
      const text = contentText(record);
      const count = seenContent.get(text) ?? 0;
      seenContent.set(text, count + 1);
      id = `auto-${hashText(text)}-${count}`;
    }
    for (let n = 2; usedIds.has(id); n++) {
      id = `${record.id || id}-${n}`;
    }
    usedIds.add(id);
    return id === record.id ? record : { ...record, id };
  });
}


// ===== 讀寫暫存 =====

export function emptyChanges() {
  return { upserts: [], deletes: [] };
}

// 讀出暫存的變更；沒有資料或讀取失敗時回傳空的變更
export function loadChanges() {
  try {
    const stored = JSON.parse(localStorage.getItem(CHANGES_KEY) ?? 'null');
    if (stored) {
      return {
        upserts: Array.isArray(stored.upserts) ? stored.upserts.filter((record) => record && record.id) : [],
        deletes: Array.isArray(stored.deletes) ? stored.deletes.filter((id) => typeof id === 'string') : [],
      };
    }
  } catch (error) {
    console.error(error);
  }
  return emptyChanges();
}

// 存入暫存；成功回傳 true，失敗（例如無痕模式或空間已滿）回傳 false
export function saveChanges(changes) {
  try {
    localStorage.setItem(CHANGES_KEY, JSON.stringify(changes));
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

// 把舊版格式的暫存轉成新格式，併入 changes。有轉換時回傳 true
// 舊版是用內容比對，所以這裡用內容找回資料檔裡對應的紀錄，改成用它的 id 記錄
export function migrateLegacyChanges(base, changes) {
  let legacy = null;
  try {
    const stored = JSON.parse(localStorage.getItem(LEGACY_CHANGES_KEY) ?? 'null');
    const oldest = JSON.parse(localStorage.getItem(LEGACY_ADDED_KEY) ?? 'null');
    if (stored || Array.isArray(oldest)) {
      legacy = {
        added: (Array.isArray(stored?.added) ? stored.added : []).concat(Array.isArray(oldest) ? oldest : []),
        removed: Array.isArray(stored?.removed) ? stored.removed : [],
        replaced: Array.isArray(stored?.replaced) ? stored.replaced : [],
      };
    }
  } catch (error) {
    console.error(error);
  }
  if (legacy === null) {
    return false;
  }

  // 更早的版本沒有測試方式、換水、事件欄位，只能用當時有的欄位來比對
  const hasNewFields = (record) => 'method' in record;
  const oldFieldsText = (record) => JSON.stringify([
    record.date, record.time ?? '', record.kh, record.dose_ml ?? null,
    record.type ?? 'tank', record.exclude === true, record.note ?? '',
  ]);
  const findInBase = (record) => base.find((item) => (
    hasNewFields(record) ? isSameContent(item, record) : oldFieldsText(item) === oldFieldsText(record)
  ));

  legacy.removed.forEach((record) => {
    const match = findInBase(record);
    if (match) {
      deleteRecord(changes, match.id, true);
    }
  });

  legacy.replaced.forEach((entry) => {
    const match = findInBase(entry.from);
    if (match) {
      // 修改後的內容如果沒有新欄位，沿用資料檔裡那一筆的新欄位
      const { method, water_change_l, water_change_timing, event } = normalizeRecord(match);
      const updated = hasNewFields(entry.to)
        ? entry.to
        : { method, water_change_l, water_change_timing, event, ...entry.to };
      upsertRecord(changes, { ...normalizeRecord(updated), id: match.id });
    } else if (!findInBase(entry.to)) {
      // 原本那筆已經不在資料檔裡，修改後的內容也還沒寫入：當成新增
      upsertRecord(changes, { ...normalizeRecord(entry.to), id: createId() });
    }
  });

  legacy.added.forEach((record) => {
    // 資料檔裡已經有這一筆（代表之前已經寫入）就不用再新增
    if (!findInBase(record)) {
      upsertRecord(changes, { ...normalizeRecord(record), id: createId() });
    }
  });

  try {
    localStorage.removeItem(LEGACY_CHANGES_KEY);
    localStorage.removeItem(LEGACY_ADDED_KEY);
  } catch (error) {
    console.error(error);
  }
  return true;
}


// ===== 記錄一項變更 =====

// 新增或修改：同一個 id 已經有暫存的內容就換掉，否則加在最後
export function upsertRecord(changes, record) {
  const index = changes.upserts.findIndex((item) => item.id === record.id);
  if (index === -1) {
    changes.upserts.push(record);
  } else {
    changes.upserts[index] = record;
  }
  changes.deletes = changes.deletes.filter((id) => id !== record.id);
}

// 刪除：拿掉這個 id 暫存的內容。keepMark 為 true 時另外記下「這個 id 要從資料檔刪除」
export function deleteRecord(changes, id, keepMark) {
  changes.upserts = changes.upserts.filter((item) => item.id !== id);
  if (keepMark && !changes.deletes.includes(id)) {
    changes.deletes.push(id);
  }
}

// 各有幾項變更。資料檔裡沒有的 id 算新增，有的算修改
function countByKind(base, changes) {
  const baseIds = new Set(base.map((record) => record.id));
  const added = changes.upserts.filter((record) => !baseIds.has(record.id)).length;
  return {
    added,
    modified: changes.upserts.length - added,
    deleted: changes.deletes.length,
  };
}

export function countChanges(changes) {
  return changes.upserts.length + changes.deletes.length;
}

// 例如「新增 1 筆、修改 2 筆」
export function describeChanges(base, changes) {
  const count = countByKind(base, changes);
  const parts = [];
  if (count.added > 0) {
    parts.push(`新增 ${count.added} 筆`);
  }
  if (count.modified > 0) {
    parts.push(`修改 ${count.modified} 筆`);
  }
  if (count.deleted > 0) {
    parts.push(`刪除 ${count.deleted} 筆`);
  }
  return parts.join('、');
}


// ===== 把變更套用到資料檔的紀錄上 =====

// 回傳 records（套用變更後的所有紀錄）與 kinds（每個 id 的狀態：
// 'file' 跟資料檔一樣、'added' 新增的、'modified' 修改過的）
export function applyChanges(base, changes) {
  const upserts = new Map(changes.upserts.map((record) => [record.id, record]));
  const deletes = new Set(changes.deletes);
  const baseIds = new Set(base.map((record) => record.id));
  const records = [];
  const kinds = new Map();
  const keptContent = new Set(); // 資料檔這邊最後留下來的每一筆內容

  base.forEach((record) => {
    if (deletes.has(record.id)) {
      return; // 被刪除的：跳過
    }
    const updated = upserts.get(record.id);
    if (updated) {
      records.push(updated); // 被修改的：在原本的位置放入修改後的內容
      kinds.set(record.id, isSameContent(updated, record) ? 'file' : 'modified');
    } else {
      records.push(record);
      kinds.set(record.id, 'file');
    }
    keptContent.add(contentText(updated ?? record));
  });

  // 新增的：接在後面。
  // 資料檔裡已經有內容完全相同的紀錄時不重複加入（例如同一筆讀值在手機和電腦上各輸入了一次）
  changes.upserts.forEach((record) => {
    if (!baseIds.has(record.id) && !deletes.has(record.id) && !keptContent.has(contentText(record))) {
      records.push(record);
      kinds.set(record.id, 'added');
    }
  });

  // 依日期排序，同一天的維持原本的先後順序
  records.sort((a, b) => a.date.localeCompare(b.date));
  return { records, kinds };
}

// 把已經寫進資料檔的變更從暫存移除：
//   - 資料檔裡同一個 id 的內容已經一樣（新增或修改已寫入）
//   - 要刪除的 id 已經不在資料檔裡
//   - 新增的紀錄，資料檔裡已經有另一筆內容完全相同的（別的裝置輸入過同一筆）
// 有移除任何項目時回傳 true。只能在「資料檔是最新版本」時呼叫，否則會誤刪還沒寫入的變更
export function cleanChanges(base, changes) {
  const byId = new Map(base.map((record) => [record.id, record]));
  const before = countChanges(changes);

  // 資料檔這邊最後會留下來的內容：扣掉要刪除的，被修改的以修改後的內容為準
  const upserts = new Map(changes.upserts.map((record) => [record.id, record]));
  const keptContent = new Set(
    base
      .filter((record) => !changes.deletes.includes(record.id))
      .map((record) => contentText(upserts.get(record.id) ?? record)),
  );

  changes.upserts = changes.upserts.filter((record) => {
    const inBase = byId.get(record.id);
    if (inBase) {
      return !isSameContent(inBase, record);
    }
    return !keptContent.has(contentText(record));
  });
  changes.deletes = changes.deletes.filter((id) => byId.has(id));

  return countChanges(changes) !== before;
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
  // 過一段時間再釋放這個網址。馬上釋放的話，有些手機瀏覽器會來不及開始下載
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
