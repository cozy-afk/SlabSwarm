import type {
  AlertChannelStatus,
  AlertDeliveryReceipt,
  AlertRule,
} from '../src/types/graph.ts';
import { dispatchHermesWebhook } from './hermesBridge.ts';

function validateDiscordWebhookUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('DISCORD_WEBHOOK_URL is not a valid URL.');
  }

  const allowedHosts = new Set([
    'discord.com',
    'discordapp.com',
    'canary.discord.com',
    'ptb.discord.com',
  ]);

  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      'DISCORD_WEBHOOK_URL must use HTTPS on discord.com or discordapp.com.'
    );
  }

  if (!parsed.pathname.startsWith('/api/webhooks/')) {
    throw new Error('DISCORD_WEBHOOK_URL must point to /api/webhooks/<id>/<token>.');
  }

  return parsed;
}

export function getAlertChannelStatus(): AlertChannelStatus {
  const discordRaw = process.env.DISCORD_WEBHOOK_URL?.trim() || '';
  const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const tgChatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';
  const hermesUrl = process.env.HERMES_WEBHOOK_URL?.trim() || '';

  return {
    discord: {
      configured: Boolean(discordRaw),
      hint: discordRaw ? 'Configured via DISCORD_WEBHOOK_URL' : 'Set DISCORD_WEBHOOK_URL in .env',
    },
    telegram: {
      configured: Boolean(tgToken && tgChatId),
      hint:
        tgToken && tgChatId
          ? `Configured for chat ${tgChatId.slice(0, 4)}***`
          : 'Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env',
    },
    hermes: {
      configured: Boolean(hermesUrl),
      hint: hermesUrl ? 'Configured via HERMES_WEBHOOK_URL' : 'Set HERMES_WEBHOOK_URL in .env',
    },
  };
}

export async function dispatchAlertToChannel(params: {
  channel: AlertRule['channel'];
  headline: string;
  detail: string;
  severity: 'HIGH' | 'MEDIUM' | 'CRITICAL';
  payload?: Record<string, unknown>;
}): Promise<AlertDeliveryReceipt> {
  const now = new Date().toISOString();
  const id = `DLV-${Date.now()}`;

  if (params.channel === 'Terminal Feed') {
    return {
      id,
      channel: 'Terminal Feed',
      headline: params.headline,
      delivered: true,
      httpStatus: 200,
      timestamp: now,
      detail: 'Logged in terminal alert feed.',
    };
  }

  if (params.channel === 'Discord Webhook') {
    const rawUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
    if (!rawUrl) {
      throw new Error(
        'DISCORD_WEBHOOK_URL is not set on the server. Add it to your .env file to enable live Discord alerts.'
      );
    }
    const validUrl = validateDiscordWebhookUrl(rawUrl);
    const color =
      params.severity === 'CRITICAL'
        ? 0xef4444
        : params.severity === 'HIGH'
          ? 0xf59e0b
          : 0x10b981;

    const res = await fetch(validUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'SlabGraph Alert Agent',
        embeds: [
          {
            title: `[${params.severity}] ${params.headline}`,
            description: params.detail,
            color,
            timestamp: now,
            footer: { text: 'SlabGraph Deterministic Knowledge Graph' },
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord webhook rejected request (${res.status}): ${body.slice(0, 180)}`);
    }

    return {
      id,
      channel: 'Discord Webhook',
      headline: params.headline,
      delivered: true,
      httpStatus: res.status,
      timestamp: now,
      detail: `Dispatched to Discord (HTTP ${res.status}).`,
    };
  }

  if (params.channel === 'Telegram Bot') {
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!botToken || !chatId) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set in server .env for Telegram delivery.'
      );
    }
    if (!/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
      throw new Error('TELEGRAM_BOT_TOKEN format appears invalid.');
    }

    const messageText = `SlabGraph [${params.severity}]\n${params.headline}\n\n${params.detail}`;
    const res = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: messageText,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram Bot API error (${res.status}): ${body.slice(0, 180)}`);
    }

    return {
      id,
      channel: 'Telegram Bot',
      headline: params.headline,
      delivered: true,
      httpStatus: res.status,
      timestamp: now,
      detail: `Delivered to Telegram chat (HTTP ${res.status}).`,
    };
  }

  // Hermes Webhook
  const hermesResult = await dispatchHermesWebhook(
    String(params.payload?.event || 'SLABGRAPH_ALERT'),
    {
      severity: params.severity,
      headline: params.headline,
      detail: params.detail,
      ...(params.payload || {}),
    }
  );

  return {
    id,
    channel: 'Hermes Webhook',
    headline: params.headline,
    delivered: hermesResult.delivered,
    httpStatus: hermesResult.httpStatus,
    timestamp: now,
    detail: `Sent to Hermes Gateway (HTTP ${hermesResult.httpStatus}${hermesResult.signed ? ', HMAC signed' : ''}).`,
  };
}
