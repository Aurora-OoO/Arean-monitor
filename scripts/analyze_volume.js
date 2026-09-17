const BASE_URL = process.env.GLOBALCALL_BASE_URL;
const ADMIN_KEY = process.env.GLOBALCALL_ADMIN_KEY;

if (!BASE_URL || !ADMIN_KEY) {
  console.error('Missing required env: GLOBALCALL_BASE_URL, GLOBALCALL_ADMIN_KEY');
  process.exit(1);
}

const ROOT = BASE_URL.replace(/\/+$/, '');

// ─── 配置 ───────────────────────────────────────────
const LOOKBACK_HOURS = 24;      // 回看最近 24 小时
const PAGE_SIZE = 100;          // API 最大支持 100 条/页
const MAX_PAGES = 200;          // 最多翻 200 页（20,000 条）
const REQUEST_TIMEOUT_MS = 15_000;
const BUCKET_MINUTES = 5;       // 按 5 分钟聚合

// ─── 构造查询时间范围 ───────────────────────────────
const endTime = new Date();
const startTime = new Date(endTime.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

console.log(`Querying usage logs: ${startTime.toISOString()} ~ ${endTime.toISOString()}`);

// ─── 请求 ───────────────────────────────────────────
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function fetchPage(pageNo) {
  const params = new URLSearchParams({
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    logType: 'MODEL_CALL',
    pageNo: String(pageNo),
    pageSize: String(PAGE_SIZE),
  });
  const url = `${ROOT}/api/v1/aignite/usage-logs/query?${params}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        'X-Global-Call-Admin-Key': ADMIN_KEY,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`API returned ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (data.code !== 0 || data.success !== true) {
      throw new Error(`API 业务异常: code=${data.code}, message=${data.message}`);
    }
    return data.data;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

let allRecords = [];
let total = 0;
let pageNo = 1;

while (pageNo <= MAX_PAGES) {
  const data = await fetchPage(pageNo);
  total = data.total ?? 0;
  const records = data.records ?? [];
  allRecords = allRecords.concat(records);

  if (records.length < PAGE_SIZE || allRecords.length >= total) {
    break;
  }
  pageNo++;
}

console.log(`获取 ${allRecords.length}/${total} 条调用记录（共 ${pageNo} 页）\n`);

if (allRecords.length === 0) {
  console.log('无调用记录');
  process.exit(0);
}

// ─── 按 5 分钟时间段聚合总调用量 ─────────────────────
const buckets = {};

for (const log of allRecords) {
  const time = new Date(log.startTime ?? log.createdAt ?? log.timestamp ?? Date.now());
  // 向下取整到 5 分钟桶
  const bucketTime = new Date(
    Math.floor(time.getTime() / (BUCKET_MINUTES * 60 * 1000)) * (BUCKET_MINUTES * 60 * 1000)
  );
  const key = bucketTime.toISOString();
  buckets[key] = (buckets[key] || 0) + 1;
}

// ─── 输出 ───────────────────────────────────────────
const sortedKeys = Object.keys(buckets).sort();

console.log('时间段                      总调用量');
console.log('----------------------------------------');

let minVolume = Infinity;
let maxVolume = 0;
let totalVolume = 0;

for (const key of sortedKeys) {
  const count = buckets[key];
  const localTime = new Date(key).toLocaleString('zh-CN', { hour12: false });
  console.log(`${localTime.padEnd(24)} ${String(count).padStart(6)}`);

  if (count < minVolume) minVolume = count;
  if (count > maxVolume) maxVolume = count;
  totalVolume += count;
}

console.log('----------------------------------------');
console.log(`总计: ${totalVolume} 次调用, ${sortedKeys.length} 个时间段`);
console.log(`平均每 5 分钟: ${(totalVolume / sortedKeys.length).toFixed(1)} 次`);
console.log(`最少: ${minVolume} 次/5分钟, 最多: ${maxVolume} 次/5分钟`);
