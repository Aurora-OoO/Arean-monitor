#!/usr/bin/env node
/**
 * 发送钉钉报警通知
 *
 * 环境变量：
 * - DINGTALK_WEBHOOK_URL: 钉钉机器人 Webhook
 * - RUN_URL: 本次 GitHub Actions run 链接
 */

const webhookUrl = process.env.DINGTALK_WEBHOOK_URL || '';
const runUrl = process.env.RUN_URL || '';

if (!webhookUrl) {
  console.warn('[Notify] DINGTALK_WEBHOOK_URL 未配置，跳过通知');
  process.exit(0);
}

async function sendDingtalk() {
  const title = '❌ Global Call 网关异常';
  let text = `### ${title}\n\n`;
  text += 'Global Call 管理后台 API 检查失败，可能不可用。\n\n';

  if (runUrl) {
    text += `[查看运行日志](${runUrl})\n`;
  }

  const body = {
    msgtype: 'markdown',
    markdown: {
      title,
      text,
    },
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`钉钉通知发送失败: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errcode !== 0) {
    throw new Error(`钉钉通知错误: ${result.errmsg}`);
  }

  console.log('[Notify] 钉钉通知发送成功');
}

sendDingtalk().catch((err) => {
  console.error('[Notify] 发送失败:', err);
  process.exit(1);
});
