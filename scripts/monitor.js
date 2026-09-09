#!/usr/bin/env node
/**
 * 监控 Global Call 模型网关可用性
 *
 * 环境变量：
 * - GLOBALCALL_BASE_URL: 网关地址，如 https://your-global-call-url/
 * - GLOBALCALL_ADMIN_KEY: 管理后台的 X-Global-Call-Admin-Key
 */

const baseUrl = (process.env.GLOBALCALL_BASE_URL || '').replace(/\/$/, '');
const adminKey = process.env.GLOBALCALL_ADMIN_KEY || '';

if (!baseUrl || !adminKey) {
  console.error('[Monitor] 错误: GLOBALCALL_BASE_URL 或 GLOBALCALL_ADMIN_KEY 未配置');
  process.exit(1);
}

async function checkAvailability() {
  // 调用轻量的模型列表接口，判断网关是否可用
  const url = `${baseUrl}/models?pageNo=1&pageSize=1`;

  console.log(`[Monitor] 正在检查: ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Global-Call-Admin-Key': adminKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status !== 200) {
      console.error(`[Monitor] 异常: HTTP ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const data = await response.json().catch(() => null);
    if (!data) {
      console.error('[Monitor] 异常: 响应不是有效 JSON');
      process.exit(1);
    }

    console.log(`[Monitor] 正常: HTTP 200`);
    process.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error(`[Monitor] 异常: ${error.message}`);
    process.exit(1);
  }
}

checkAvailability();
