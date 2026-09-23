const BASE_URL = process.env.GLOBALCALL_BASE_URL;
const ADMIN_KEY = process.env.GLOBALCALL_ADMIN_KEY;

if (!BASE_URL || !ADMIN_KEY) {
  console.error('Missing required env: GLOBALCALL_BASE_URL, GLOBALCALL_ADMIN_KEY');
  process.exit(1);
}

const ROOT = BASE_URL.replace(/\/+$/, '');

// ─── 配置 ───────────────────────────────────────────
const LOOKBACK_MINUTES = 5;             // 回看最近 5 分钟的日志
const PAGE_SIZE = 100;                  // API 最大支持 100 条/页
const MAX_PAGES = 100;                  // 最多翻 100 页（10,000 条），防止异常时无限请求
const MIN_CALLS_FOR_ALERT = 4;          // 单个模型 5 分钟内调用次数低于 4 次不报警
const MIN_TOTAL_CALLS = 20;             // 5 分钟总调用量低于 40 报警
const REQUEST_TIMEOUT_MS = 15_000;

// 按调用量分档判定是否异常
function getAlertThreshold(total) {
  if (total >= 4 && total <= 5) return 0.4;   // 4-5 次：成功率低于 40% 报警
  if (total >= 6 && total <= 8) return 0.6;   // 6-8 次：成功率低于 60% 报警
  if (total >= 9) return 0.8;                 // 9 次及以上：成功率低于 80% 报警
  return null;                                // 样本不足，不报警
}

// 将告警摘要写入 GitHub Actions output
async function writeAlertSummary(text) {
  if (!process.env.GITHUB_OUTPUT) return;
  const fs = await import('node:fs');
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `alert_summary<<__ALERT_SUMMARY_EOF__\n${text}\n__ALERT_SUMMARY_EOF__\n`
  );
}

// ─── 构造查询时间范围 ───────────────────────────────
// 支持通过环境变量指定固定时间范围（调试用途）
const endTime = process.env.MONITOR_END_TIME ? new Date(process.env.MONITOR_END_TIME) : new Date();
const startTime = process.env.MONITOR_START_TIME ? new Date(process.env.MONITOR_START_TIME) : new Date(endTime.getTime() - LOOKBACK_MINUTES * 60 * 1000);

console.log(`Querying usage logs: ${startTime.toISOString()} ~ ${endTime.toISOString()}`);

// ─── 请求 ───────────────────────────────────────────
// ELB 证书域名与地址不匹配，需要跳过 TLS 校验
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function fetchPage(logType, pageNo) {
  const params = new URLSearchParams({
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    logType,
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

async function fetchAllRecords(logType) {
  const records = [];
  let total = 0;
  let pageNo = 1;

  while (pageNo <= MAX_PAGES) {
    const data = await fetchPage(logType, pageNo);
    total = data.total ?? 0;
    const pageRecords = data.records ?? [];

    // 把 logType 补到每条记录上（兼容 API 未返回该字段的情况）
    for (const log of pageRecords) {
      if (!log.logType) log.logType = logType;
    }
    records.push(...pageRecords);

    if (pageRecords.length < PAGE_SIZE || records.length >= total) {
      break;
    }
    pageNo++;
  }

  return { records, total, pages: pageNo };
}

let allRecords = [];
let totalModelCall = 0;
let totalTaskSettlement = 0;
let pagesModelCall = 0;
let pagesTaskSettlement = 0;

try {
  const modelCallResult = await fetchAllRecords('MODEL_CALL');
  const taskSettlementResult = await fetchAllRecords('TASK_SETTLEMENT');

  allRecords = modelCallResult.records.concat(taskSettlementResult.records);
  totalModelCall = modelCallResult.total;
  totalTaskSettlement = taskSettlementResult.total;
  pagesModelCall = modelCallResult.pages;
  pagesTaskSettlement = taskSettlementResult.pages;
} catch (err) {
  console.error(`[API ERROR] 查询失败: ${err.message}`);
  await writeAlertSummary(`监控接口异常告警：无法查询 Global Call 使用日志，${err.message}`);
  process.exit(1);
}

if (allRecords.length === 0) {
  console.log(`最近 ${LOOKBACK_MINUTES} 分钟内无调用记录，视为正常。`);
  process.exit(0);
}

console.log(`获取 ${allRecords.length} 条调用记录`);
console.log(`  - MODEL_CALL: ${totalModelCall} 条（${pagesModelCall} 页）`);
console.log(`  - TASK_SETTLEMENT: ${totalTaskSettlement} 条（${pagesTaskSettlement} 页）\n`);
const records = allRecords;

// 已过期任务不计入模型成功率/失败统计，但保留在总调用量中
const modelStatsRecords = records.filter(log => log.status !== 'EXPIRED');
const expiredCount = records.length - modelStatsRecords.length;
if (expiredCount > 0) {
  console.log(`（其中 ${expiredCount} 条 EXPIRED 已过期任务不计入模型告警统计）\n`);
}

// ─── 总调用量告警 ───────────────────────────────────
const volumeAlert = records.length < MIN_TOTAL_CALLS
  ? `平台总调用量异常告警：近 ${LOOKBACK_MINUTES} 分钟仅 ${records.length} 次调用（阈值 ${MIN_TOTAL_CALLS} 次）`
  : null;

if (volumeAlert) {
  console.error(`[VOLUME ALERT] ${volumeAlert}`);
}

// ─── 按日志类型 + 模型统计 ───────────────────────────
function getLogTypeLabel(logType) {
  if (logType === 'TASK_SETTLEMENT') return '生图模型';
  if (logType === 'MODEL_CALL') return '问答模型';
  return '其他模型';
}

const modelStats = {};
let sampleFailedLog = null;

for (const log of modelStatsRecords) {
  const model = log.modelName || 'unknown';
  const logType = log.logType || 'MODEL_CALL';
  const typeLabel = getLogTypeLabel(logType);
  const key = `${logType}::${model}`;
  const isSuccess = log.status === 'SUCCESS' || log.status === 'SUCCEEDED';
  const isFailed = !isSuccess || log.rejected === true;

  if (!modelStats[key]) {
    modelStats[key] = {
      model,
      logType,
      typeLabel,
      total: 0,
      errors: 0,
      errorDetails: [],
      tracePairs: [],
    };
  }

  modelStats[key].total++;

  if (isFailed) {
    // 跳过客户端错误（4xx 但 429 除外），只关注模型侧/服务端异常
    const upstream = log.upstreamStatus;
    const isClientError = upstream && upstream >= 400 && upstream < 500 && upstream !== 429;
    if (isClientError) continue;

    modelStats[key].errors++;
    if (!sampleFailedLog) sampleFailedLog = log;

    // 按失败记录收集 traceId 和上游 request_id（同一行展示，最多保留 5 条）
    const traceId = findTraceId(log);
    const upstreamRequestId = findUpstreamRequestId(log);
    if ((traceId || upstreamRequestId) && modelStats[key].tracePairs.length < 5) {
      modelStats[key].tracePairs.push({
        traceId: traceId || null,
        requestId: upstreamRequestId || null,
      });
    }

    if (modelStats[key].errorDetails.length < 3) {
      let code = log.errorCode ?? log.errorCategory ?? '';
      const msg = log.errorMessage ?? '';
      if (!code && msg) {
        code = msg;
      }
      if (!code) {
        code = 'UNKNOWN';
      }
      modelStats[key].errorDetails.push(`${code}${msg && msg !== code ? ': ' + msg : ''}`);
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

for (const [key, stats] of Object.entries(modelStats)) {
  const errorRate = stats.errors / stats.total;
  const successRate = 1 - errorRate;
  const threshold = getAlertThreshold(stats.total);
  const isAbnormal = threshold !== null && successRate <= threshold;
  const icon = isAbnormal ? '✗' : '✓';
  const thresholdText = threshold !== null ? `阈值 ${(threshold * 100).toFixed(0)}%` : '样本不足';
  console.log(`${icon} 【${stats.typeLabel}】${stats.model}: ${stats.total} 次调用, ${stats.errors} 次失败, 成功率 ${(successRate * 100).toFixed(1)}% (${thresholdText})`);
  for (const detail of stats.errorDetails) {
    console.log(`    → ${detail}`);
  }

  // 样本数足够且成功率低于对应档位阈值才判定为异常
  if (isAbnormal) {
    downModels.push({
      name: stats.model,
      typeLabel: stats.typeLabel,
      errors: stats.errors,
      total: stats.total,
      successRate,
      threshold,
      details: stats.errorDetails,
      tracePairs: stats.tracePairs,
    });
  }
}

// ─── 判定结果 ───────────────────────────────────────
const hasModelAlert = downModels.length > 0;
const hasVolumeAlert = volumeAlert !== null;

if (hasModelAlert) {
  console.error(`\n[ALERT] ${downModels.length} 个模型异常：`);
  for (const m of downModels) {
    console.error(`  - ${m.name}: ${m.errors}/${m.total} 失败, 成功率 ${(m.successRate * 100).toFixed(1)}% (阈值 ${(m.threshold * 100).toFixed(0)}%)${formatTraceInfo(m)}`);
  }
}

if (hasModelAlert || hasVolumeAlert) {
  const parts = [];

  if (hasVolumeAlert) {
    parts.push(volumeAlert);
  }

  if (hasModelAlert) {
    const modelSummary = downModels
      .map(m => {
        // 只取错误码部分，截断过长的描述
        let errorCode = m.details[0] ?? '未知';
        const colonIdx = errorCode.indexOf(': ');
        if (colonIdx > 0) errorCode = errorCode.substring(0, colonIdx);
        if (errorCode.length > 50) errorCode = errorCode.substring(0, 50) + '...';

        return `【${m.typeLabel}】${m.name} 模型异常告警：调用失败 ${m.errors} 次/总 ${m.total} 次，成功率 ${(m.successRate * 100).toFixed(1)}% (阈值 ${(m.threshold * 100).toFixed(0)}%)，错误码 ${errorCode}${formatTraceInfo(m)}`;
      })
      .join('|');
    parts.push(modelSummary);
  }

  const summary = parts.join('|');
  await writeAlertSummary(summary);

  process.exit(1);
}

console.log(`\n[PASS] 所有模型运行正常（共 ${Object.keys(modelStats).length} 个模型），5 分钟总调用量 ${records.length} 次。`);
