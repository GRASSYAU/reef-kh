// ===== 第 1 段：設定與取得頁面元素 =====

// JSON 檔的路徑（相對於 index.html）
const DATA_URL = 'data/kh-records.json';

// 先把之後會用到的 HTML 元素找出來
const tbody = document.querySelector('#kh-body');
const statusEl = document.querySelector('#status');


// ===== 第 2 段：讀取 JSON 檔 =====

// async 代表這個函式裡面可以用 await「等待」非同步工作完成
async function loadRecords() {
  // 第一次等待：等伺服器回應
  const response = await fetch(DATA_URL);

  // fetch 遇到 404 不會自動報錯，要自己檢查 response.ok
  if (!response.ok) {
    throw new Error(`讀取 ${DATA_URL} 失敗（HTTP ${response.status}）`);
  }

  // 第二次等待：把回應的文字解析成 JS 的陣列
  return await response.json();
}


// ===== 第 3 段：建立一個儲存格 <td> =====

// text：要顯示的內容；className：要加上的 CSS class（可不給）
function createCell(text, className) {
  const td = document.createElement('td');

  // 用 textContent 而不是 innerHTML：內容只會被當成純文字，不會被當成 HTML 執行
  td.textContent = text;

  if (className) {
    td.classList.add(className);
  }
  return td;
}


// ===== 第 4 段：把資料陣列畫成表格 =====

function renderTable(records) {
  // 先清空，避免重複呼叫時資料列越加越多
  tbody.replaceChildren();

  // 陣列裡的每一筆 record 都產生一列 <tr>
  records.forEach((record) => {
    const tr = document.createElement('tr');

    tr.appendChild(createCell(record.date));
    tr.appendChild(createCell(record.time));
    // toFixed(1)：固定顯示小數一位，例如 8 會顯示成 8.0
    tr.appendChild(createCell(record.kh.toFixed(1), 'num'));
    tr.appendChild(createCell(record.dose_ml, 'num'));
    tr.appendChild(createCell(record.note));

    tbody.appendChild(tr);
  });
}


// ===== 第 5 段：主流程與錯誤處理 =====

async function init() {
  try {
    const records = await loadRecords();
    renderTable(records);
    statusEl.textContent = `共 ${records.length} 筆紀錄`;
  } catch (error) {
    // 讀檔失敗、JSON 格式錯誤、欄位缺漏，都會跑到這裡
    console.error(error);
    statusEl.textContent = `資料載入失敗：${error.message}`;
    statusEl.classList.add('error');
  }
}

// 執行主流程
init();
