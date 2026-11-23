// 服務工作線程（service worker）：瀏覽器在背景執行的一小段程式，負責把網頁的檔案存在裝置裡，
// 讓網頁在沒有網路時也能開啟。
//
// 策略是「網路優先」：
//   - 有網路：一律向伺服器要最新的檔案，並順手存一份到快取。所以程式更新後，重新開啟就是新版。
//   - 沒網路（或等太久）：改用上次存下來的那一份。
//
// 只處理這個網站自己的檔案。對 GitHub API 的連線（讀寫資料檔）不經過這裡，也不會被快取。

const CACHE = 'reef-kh-v1';
const NETWORK_TIMEOUT_MS = 4000; // 已經有快取時，網路等超過這個時間就先用快取

// 第一次安裝時先存好的檔案，確保安裝完就能離線開啟
const CORE_FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/app.js',
  'js/analysis.js',
  'js/chart.js',
  'js/config.js',
  'js/data.js',
  'js/github.js',
  'js/render.js',
  'js/storage.js',
  'data/kh-records.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐一下載並存入快取。allSettled：個別檔案失敗不影響其他檔案
    await Promise.allSettled(CORE_FILES.map((url) => cache.add(new Request(url, { cache: 'no-cache' }))));
    await self.skipWaiting(); // 不用等舊版的頁面全部關閉，直接啟用
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉舊版本留下的快取（只清這個專案的）
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('reef-kh-') && name !== CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim(); // 立刻接手已經開啟的頁面
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // 只處理「讀取這個網站自己的檔案」；其他請求（例如 GitHub API）照原本的方式連線
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(networkFirst(request));
});

// 等待一段時間後失敗，用來替網路連線設定時間上限
function timeout(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('timeout')), ms);
  });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  // ignoreSearch：網址後面有沒有 ?參數 都視為同一個檔案
  const cached = await cache.match(request, { ignoreSearch: true });

  try {
    // cache: 'no-cache'：要求瀏覽器向伺服器確認檔案有沒有更新，不直接用瀏覽器自己的暫存
    const fetching = fetch(request.url, { cache: 'no-cache' });
    const response = await (cached ? Promise.race([fetching, timeout(NETWORK_TIMEOUT_MS)]) : fetching);

    if (response.ok) {
      // 回應只能讀一次，所以存進快取的是複製的那一份
      cache.put(request.url, response.clone());
    }
    // 經過轉址的回應不能直接用來回覆頁面的載入，重新包裝一次
    if (response.redirected) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  } catch (error) {
    if (cached) {
      return cached;
    }
    throw error;
  }
}
