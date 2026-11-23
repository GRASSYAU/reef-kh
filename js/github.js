// GitHub 同步：透過 GitHub 的 API（應用程式介面）直接讀寫存放庫裡的資料檔
//
// 用途：手機沒有 VS Code，沒辦法「匯出檔案 → 取代 → 提交」。
// 有了權杖（token，一組代表你身分的密碼），網頁可以直接把變更提交到 GitHub。
//
// 安全性：
//   - 權杖只存在這台裝置的瀏覽器（localStorage），不會寫進專案，也只會傳給 api.github.com。
//   - 請使用「只能存取這個存放庫、只有 Contents 權限」的細部權限權杖，就算外流，影響也只限這個存放庫。

import { GITHUB } from './config.js';

export const TOKEN_KEY = 'reef-kh:github-token';
const API_ROOT = 'https://api.github.com';
const TIMEOUT_MS = 15000; // 等待 GitHub 回應的時間上限


// ===== 權杖的存取 =====

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch (error) {
    return '';
  }
}

// 成功回傳 true；瀏覽器無法儲存（例如無痕模式）時回傳 false
export function saveToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch (error) {
    return false;
  }
}

export function removeToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    // 無法存取 localStorage 時，本來就沒有存任何東西
  }
}


// ===== 呼叫 GitHub API =====

// 帶有 HTTP 狀態碼的錯誤，呼叫的地方可以依狀態碼決定要不要重試
class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function statusMessage(status) {
  const messages = {
    401: '權杖無效或已過期，請重新產生並設定。',
    403: '權杖沒有這個存放庫的寫入權限，或短時間內使用太多次。',
    404: `找不到 ${GITHUB.owner}/${GITHUB.repo} 的資料檔，請確認權杖可以存取這個存放庫，而且 ${GITHUB.branch} 分支上有 ${GITHUB.path}。`,
    409: '資料剛好被其他裝置修改，請再試一次。',
    422: 'GitHub 無法接受這次的內容，請重新整理頁面後再試。',
  };
  return messages[status] ?? `GitHub 回應錯誤（HTTP ${status}）。`;
}

async function request(token, url, options = {}) {
  // AbortController：超過時間上限就中止連線，避免網路不穩時一直卡住
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      cache: 'no-store', // 不使用快取，確保拿到的是最新內容
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) {
      throw new GitHubError(statusMessage(response.status), response.status);
    }
    // 回應的內容也要在時間上限內讀完，所以計時器要等這一步完成才停
    return await response.json();
  } catch (error) {
    if (error instanceof GitHubError) {
      throw error;
    }
    // 其餘的錯誤（連不上、逾時被中止、內容讀到一半斷線）都當成連線問題
    throw new GitHubError('無法連線到 GitHub，或等待回應逾時，請檢查網路。', 0);
  } finally {
    clearTimeout(timer);
  }
}

function fileUrl() {
  return `${API_ROOT}/repos/${GITHUB.owner}/${GITHUB.repo}/contents/${encodeURI(GITHUB.path)}`;
}


// ===== 文字與 Base64 的轉換 =====

// GitHub API 用 Base64（一種把任意內容轉成英數字的編碼）傳送檔案內容。
// 瀏覽器內建的 btoa／atob 只能處理英數字，中文要先轉成 UTF-8 的位元組。

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}


// ===== 讀取與寫入資料檔 =====

// 讀取 GitHub 上最新的資料檔。回傳 records（紀錄陣列）與 sha（這個版本的識別碼，寫入時要帶回去）
export async function fetchRemoteRecords(token) {
  const data = await request(token, `${fileUrl()}?ref=${encodeURIComponent(GITHUB.branch)}`);
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new GitHubError('GitHub 回傳的檔案格式不符，無法讀取。', 0);
  }

  let records;
  try {
    records = JSON.parse(decodeBase64(data.content));
  } catch (error) {
    throw new GitHubError('GitHub 上的資料檔不是正確的 JSON 格式。', 0);
  }
  if (!Array.isArray(records)) {
    throw new GitHubError('GitHub 上的資料檔內容不是紀錄陣列。', 0);
  }
  return { records, sha: data.sha };
}

// 把新內容提交到 GitHub。sha 必須是剛才讀到的版本；
// 如果這段時間有其他裝置改過檔案，GitHub 會回 409，避免互相覆蓋
export async function pushRemoteRecords(token, text, sha, message) {
  const data = await request(token, fileUrl(), {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: encodeBase64(text),
      sha,
      branch: GITHUB.branch,
    }),
  });
  return data.content.sha;
}
