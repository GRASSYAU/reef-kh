// 瀏覽器暫存：用表單新增、還沒寫入 data/kh-records.json 的紀錄，先存在 localStorage
//
// localStorage 是瀏覽器內建的小型儲存空間，只能存字串，
// 所以存的時候用 JSON.stringify 把陣列轉成字串，讀的時候用 JSON.parse 轉回來。
// 資料只存在「這台電腦的這個瀏覽器」，清除瀏覽資料就會消失，所以要定期匯出。

const STORAGE_KEY = 'reef-kh:new-records';

// 讀出暫存的紀錄；沒有資料或讀取失敗時回傳空陣列
export function loadLocalRecords() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    const records = text ? JSON.parse(text) : [];
    return Array.isArray(records) ? records : [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

// 存入暫存；成功回傳 true，失敗（例如無痕模式或空間已滿）回傳 false
export function saveLocalRecords(records) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
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
