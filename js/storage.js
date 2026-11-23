// 瀏覽器暫存：在網頁上做的新增、修改、刪除，在寫入 data/kh-records.json 之前先存在 localStorage
//
// localStorage 是瀏覽器內建的小型儲存空間，只能存字串，
// 所以存的時候用 JSON.stringify 把物件轉成字串，讀的時候用 JSON.parse 轉回來。
// 資料只存在「這台電腦的這個瀏覽器」，清除瀏覽資料就會消失，所以要定期匯出。
//
// 暫存的內容是「相對於檔案的變更」，分成三類：
//   added    新增的紀錄
//   removed  要從檔案中刪除的紀錄
//   replaced 修改的紀錄，每一項是 { from: 檔案裡原本的內容, to: 修改後的內容 }

const STORAGE_KEY = 'reef-kh:changes';
const OLD_STORAGE_KEY = 'reef-kh:new-records'; // 舊版只存新增的紀錄

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

    // 舊版留下的暫存紀錄，轉成新格式後把舊的刪掉
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

// 判斷兩筆紀錄的內容是否完全相同
export function isSameRecord(a, b) {
  return a.date === b.date
    && (a.time ?? '') === (b.time ?? '')
    && a.kh === b.kh
    && (a.dose_ml ?? null) === (b.dose_ml ?? null)
    && (a.type ?? 'tank') === (b.type ?? 'tank')
    && (a.exclude === true) === (b.exclude === true)
    && (a.note ?? '') === (b.note ?? '');
}

// 把所有紀錄轉成跟 data/kh-records.json 相同的排版：一筆一行
export function toJsonText(records) {
  const lines = records.map((record) => {
    const fields = {
      date: record.date,
      time: record.time ?? '',
      kh: record.kh,
      dose_ml: record.dose_ml ?? null,
      type: record.type ?? 'tank',
      exclude: record.exclude === true,
      note: record.note ?? '',
    };
    // 每個欄位轉成 "名稱": 值，再用逗號接起來。JSON.stringify 會處理引號等特殊字元
    const parts = Object.entries(fields).map(([key, value]) => `"${key}": ${JSON.stringify(value)}`);
    return `  {${parts.join(', ')}}`;
  });
  return '[\n' + lines.join(',\n') + '\n]\n';
}

// 讓瀏覽器下載一個文字檔
export function downloadText(filename, text) {
  // Blob：把文字包成「檔案內容」；createObjectURL：產生一個暫時的下載網址
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
