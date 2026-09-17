const BASE_URL = process.env.GLOBALCALL_BASE_URL;
const ADMIN_KEY = process.env.GLOBALCALL_ADMIN_KEY;

if (!BASE_URL || !ADMIN_KEY) {
  console.error('Missing required env: GLOBALCALL_BASE_URL, GLOBALCALL_ADMIN_KEY');
  process.exit(1);
}

const ROOT = BASE_URL.replace(/\/+$/, '');

// ─── 配置 ───────────────────────────────────────────
const LOOKBACK_HOURS = 24;      // 回看最近 24 小时
const CHUNK_HOURS = 2;          // 每次查询 2 小时，避免超过 API 10k 翻页限制
const PAGE_SIZE = 100;          // API 最大支持 100 条/页
const MAX_PAGES = 100;          // 每段最多翻 100 页（10,000 条）
const REQUEST_TIMEOUT_MS = 15_000;
const BUCKET_MINUTES = 5;       // 按 5 分钟聚合

// ─── 请求 ───────────────────────────────────────────
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function fetchPage(startTime, endTime, pageNo) {
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

async function fetchRange(startTime, endTime) {
  let records = [];
  let total = 0;
  let pageNo = 1;

  while (pageNo <= MAX_PAGES) {
    const data = await fetchPage(startTime, endTime, pageNo);
    total = data.total ?? 0;
    const pageRecords = data.records ?? [];
    records = records.concat(pageRecords);

    if (pageRecords.length < PAGE_SIZE || records.length >= total) {
      break;
    }
    pageNo++;
  }

  return { records, total, pages: pageNo };
}

// ─── 构造查询时间范围 ───────────────────────────────
const endTime = new Date();
const startTime = new Date(endTime.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

console.log(`Querying usage logs: ${startTime.toISOString()} ~ ${endTime.toISOString()}`);
console.log(`Split into ${CHUNK_HOURS}-hour chunks to avoid API pagination limit\n`);

// ─── 按时间段分段查询 ───────────────────────────────
const allRecords = [];
let totalFetched = 0;
let totalExpected = 0;
let chunkCount = 0;

let chunkStart = new Date(startTime);
while (chunkStart < endTime) {
  const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_HOURS * 60 * 60 * 1000, endTime.getTime()));
  chunkCount++;

  try {
    const { records, total, pages } = await fetchRange(chunkStart, chunkEnd);
    allRecords.push(...records);
    totalFetched += records.length;
    totalExpected += total;
    console.log(`[${chunkCount}] ${chunkStart.toISOString()} ~ ${chunkEnd.toISOString()}: ${records.length}/${total} 条 (${pages} 页)`);
  } catch (err) {
    console.error(`[${chunkCount}] 查询失败: ${err.message}`);
  }

  chunkStart = chunkEnd;
}

console.log(`\n获取 ${allRecords.length}/${totalExpected} 条调用记录（共 ${chunkCount} 段）\n`);

if (allRecords.length === 0) {
  console.log('无调用记录');
  process.exit(0);
}

// ─── 调试：看看时间字段叫什么 ───────────────────────
if (allRecords.length > 0) {
  const sample = allRecords[0];
  console.log('第一条日志字段名：');
  console.log(Object.keys(sample).sort().join(', '));

  const timeFields = ['startTime', 'endTime', 'timestamp', 'createdAt', 'callTime', 'requestTime', 'logTime', 'time'];
  console.log('时间相关字段值：');
  for (const key of timeFields) {
    if (sample[key] !== undefined) {
      console.log(`  ${key}: ${sample[key]} (${new Date(sample[key]).toISOString()})`);
    }
  }
  console.log('');
}

// 自动找到可用的时间字段
function getLogTime(log) {
  const timeFields = ['startTime', 'endTime', 'timestamp', 'createdAt', 'callTime', 'requestTime', 'logTime', 'time'];
  for (const key of timeFields) {
    if (log[key]) {
      const d = new Date(log[key]);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

// ─── 按 5 分钟时间段聚合总调用量 ─────────────────────
const buckets = {};

for (const log of allRecords) {
  const time = getLogTime(log);
  if (!time) {
    console.warn('无法解析时间字段:', JSON.stringify(log).slice(0, 200));
    continue;
  }
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
