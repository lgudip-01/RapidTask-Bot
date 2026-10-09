/**
 * Manage the Telegram webhook.
 *   npm run telegram -- set-webhook     register PUBLIC_BASE_URL/webhooks/telegram with the secret
 *   npm run telegram -- delete-webhook  required before switching back to polling (getUpdates 409s otherwise)
 *   npm run telegram -- info            show the current webhook registration
 */
import { loadEnv } from '../env';
import { TelegramApi } from './telegram';

async function main() {
  const env = loadEnv();
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN in .env');
  const api = new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  const cmd = process.argv[2];

  if (cmd === 'set-webhook') {
    if (!env.PUBLIC_BASE_URL) throw new Error('Set PUBLIC_BASE_URL (https) in .env');
    if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error('Set TELEGRAM_WEBHOOK_SECRET in .env');
    const url = new URL('/webhooks/telegram', env.PUBLIC_BASE_URL);
    if (url.protocol !== 'https:') throw new Error('Telegram webhooks require https');
    await api.setWebhook(url.toString(), env.TELEGRAM_WEBHOOK_SECRET);
    console.warn(`Webhook set to ${url}. Set TELEGRAM_MODE=webhook on the server.`);
  } else if (cmd === 'delete-webhook') {
    await api.deleteWebhook();
    console.warn('Webhook deleted. Polling (TELEGRAM_MODE=polling) will work again.');
  } else if (cmd === 'info') {
    const info = await api.getWebhookInfo();
    console.warn(
      JSON.stringify(
        {
          url: info.url || '(none: polling)',
          pending: info.pending_update_count,
          lastError: info.last_error_message ?? null,
        },
        null,
        2,
      ),
    );
  } else {
    throw new Error('Usage: npm run telegram -- set-webhook | delete-webhook | info');
  }
}

main().catch((e: Error) => {
  // Telegram error text never contains the token; the request URL (which does) is never printed.
  console.error(`telegram: ${e.message}`);
  process.exit(1);
});
