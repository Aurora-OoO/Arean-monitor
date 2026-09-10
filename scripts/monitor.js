const BASE_URL = process.env.GLOBALCALL_BASE_URL;
const ADMIN_KEY = process.env.GLOBALCALL_ADMIN_KEY;

if (!BASE_URL || !ADMIN_KEY) {
  console.error('Missing required env: GLOBALCALL_BASE_URL, GLOBALCALL_ADMIN_KEY');
  process.exit(1);
}

const ROOT = BASE_URL.replace(/\/+$/, '');

// ─── 配置 ───────────────────────────────────────────
const LOOKBACK_MINUTES = 5;             // 回看最近 5 分钟的日志
const PAGE_SIZE = 500;                  // 单次最多拉取条数
const SUCCESS_RATE_THRESHOLD = 0.8;     // 成功率低于等于 80% 即报警
const MIN_CALLS_FOR_ALERT = 8;          // 单个模型 5 分钟内调用次数低于 8 次不报警
const REQUEST_TIMEOUT_MS = 15_000;

// ─── 构造查询时间范围 ───────────────────────────────
const endTime = new Date();
const startTime = new Date(endTime.getTime() - LOOKBACK_MINUTES * 60 * 1000);

const params = new URLSearchParams({
  startTime: startTime.toISOString(),
  endTime: endTime.toISOString(),
  logType: 'MODEL_CALL',
  pageNo: '1',
  pageSize: String(PAGE_SIZE),
});

const url = `${ROOT}/api/v1/aignite/usage-logs/query?${params}`;
console.log(`Querying usage logs: ${startTime.toISOString()} ~ ${endTime.toISOString()}`);

// ─── 请求 ───────────────────────────────────────────
// ELB 证书域名与地址不匹配，需要跳过 TLS 校验
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

let data;
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
    console.error(`API returned ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  data = await res.json();
} catch (err) {
  clearTimeout(timeout);
  console.error(`Request failed: ${err.message}`);
  process.exit(1);
}

// ─── 校验响应 ───────────────────────────────────────
if (data.code !== 0 || data.success !== true) {
  console.error(`API 业务异常: code=${data.code}, message=${data.message}`);
  process.exit(1);
}

const { records, total } = data.data;

if (!Array.isArray(records) || records.length === 0) {
  console.log(`最近 ${LOOKBACK_MINUTES} 分钟内无调用记录（total=${total}），视为正常。`);
  process.exit(0);
}

console.log(`获取 ${records.length}/${total} 条调用记录\n`);

// ─── 按模型统计 ─────────────────────────────────────
const modelStats = {};
let sampleFailedLog = null;

for (const log of records) {
  const model = log.modelName || 'unknown';
  const isFailed = log.status !== 'SUCCESS' || log.rejected === true;

  if (!modelStats[model]) {
    modelStats[model] = { total: 0, errors: 0, errorDetails: [], tracePairs: [] };
  }

  modelStats[model].total++;

  if (isFailed) {
    // 跳过客户端错误（4xx 但 429 除外），只关注模型侧/服务端异常
    const upstream = log.upstreamStatus;
    const isClientError = upstream && upstream >= 400 && upstream < 500 && upstream !== 429;
    if (isClientError) continue;

    modelStats[model].errors++;
    if (!sampleFailedLog) sampleFailedLog = log;

    // 按失败记录收集 traceId 和上游 request_id（同一行展示，最多保留 5 条）
    const traceId = findTraceId(log);
    const upstreamRequestId = findUpstreamRequestId(log);
    if ((traceId || upstreamRequestId) && modelStats[model].tracePairs.length < 5) {
      modelStats[model].tracePairs.push({
        traceId: traceId || null,
        requestId: upstreamRequestId || null,
      });
    }

    if (modelStats[model].errorDetails.length < 3) {
      const code = log.errorCode ?? log.errorCategory ?? 'UNKNOWN';
      const msg = log.errorMessage ?? '';
      modelStats[model].errorDetails.push(`${code}${msg ? ': ' + msg : ''}`);
    }
  }
}

// 调试：如果存在失败记录却一条排查 ID 都没收集到，打印一次原始字段名和候选值
if (sampleFailedLog) {
  const anyTracePairs = Object.values(modelStats).some(s => s.tracePairs.length > 0);
  if (!anyTracePairs) {
    console.log('⚠ 失败日志中未找到 traceId / request_id，原始字段名：');
    console.log(Object.keys(sampleFailedLog).sort().join(', '));
    const idFields = ['traceId', 'trace_id', 'callId', 'call_id', 'requestId', 'request_id', 'upstreamRequestId'];
    for (const key of idFields) {
      if (sampleFailedLog[key]) console.log(`  ${key}: ${sampleFailedLog[key]}`);
    }
  }
}

// 从日志记录中查找 traceId（兼容多种字段命名）
function findTraceId(log) {
  const candidates = ['traceId', 'trace_id', 'traceID', 'callId', 'call_id', 'callID'];
  for (const key of candidates) {
    if (log[key]) return String(log[key]);
  }
  return null;
}

// 查找上游 request_id：优先取日志字段，其次从 errorMessage 中解析
function findUpstreamRequestId(log) {
  const fieldCandidates = ['upstreamRequestId', 'requestId', 'request_id', 'upstreamRequestID'];
  for (const key of fieldCandidates) {
    if (log[key]) return String(log[key]);
  }

  const errorMessage = log.errorMessage;
  if (!errorMessage) return null;
  const patterns = [
    /request\s*id[:\s]+([a-zA-Z0-9_-]+)/i,
    /request-id[:\s]+([a-zA-Z0-9_-]+)/i,
    /requestId[:\s]+([a-zA-Z0-9_-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = String(errorMessage).match(pattern);
    if (match) return match[1];
  }
  return null;
}

// 拼接排查 ID：同一失败记录的 request_id 和 traceId 在同一行，超过 5 行则提示信息过长
function formatTraceInfo(m) {
  const pairs = m.tracePairs;
  if (pairs.length === 0) return '';

  let lines = pairs.map(pair => {
    const parts = [];
    if (pair.requestId) parts.push(`request_id: ${pair.requestId}`);
    if (pair.traceId) parts.push(`traceId: ${pair.traceId}`);
    return parts.join(', ');
  });

  if (lines.length > 5) {
    lines = [...lines.slice(0, 5), '信息过长'];
  }
  return '\n' + lines.map(line => `  - ${line}`).join('\n');
}

// ─── 逐模型判定 ─────────────────────────────────────
const downModels = [];

for (const [model, stats] of Object.entries(modelStats)) {
  const errorRate = stats.errors / stats.total;
  const successRate = 1 - errorRate;
  const icon = successRate < SUCCESS_RATE_THRESHOLD ? '✗' : '✓';
  console.log(`${icon} ${model}: ${stats.total} 次调用, ${stats.errors} 次失败, 成功率 ${(successRate * 100).toFixed(1)}%`);
  for (const detail of stats.errorDetails) {
    console.log(`    → ${detail}`);
  }

  // 成功率低于等于阈值且样本数足够才判定为异常
  if (stats.total >= MIN_CALLS_FOR_ALERT && successRate <= SUCCESS_RATE_THRESHOLD) {
    downModels.push({
      name: model,
      errors: stats.errors,
      total: stats.total,
      successRate,
      details: stats.errorDetails,
      tracePairs: stats.tracePairs,
    });
  }
}

// ─── 判定结果 ───────────────────────────────────────
if (downModels.length > 0) {
  console.error(`\n[ALERT] ${downModels.length} 个模型异常：`);
  for (const m of downModels) {
    console.error(`  - ${m.name}: ${m.errors}/${m.total} 失败, 成功率 ${(m.successRate * 100).toFixed(1)}%${formatTraceInfo(m)}`);
  }

  // 将失败摘要写入 GitHub Actions output 供 notify.js 使用
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import('node:fs');
    const summary = downModels
      .map(m => {
        // 只取错误码部分，截断过长的描述
        let errorCode = m.details[0] ?? '未知';
        const colonIdx = errorCode.indexOf(': ');
        if (colonIdx > 0) errorCode = errorCode.substring(0, colonIdx);
        if (errorCode.length > 50) errorCode = errorCode.substring(0, 50) + '...';

        return `${m.name} 调用失败 ${m.errors} 次/总 ${m.total} 次，成功率 ${(m.successRate * 100).toFixed(1)}%，错误码 ${errorCode}${formatTraceInfo(m)}`;
      })
      .join('|');
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `alert_summary=${summary}\n`
    );
  }

  process.exit(1);
}

console.log(`\n[PASS] 所有模型运行正常（共 ${Object.keys(modelStats).length} 个模型）。`);
