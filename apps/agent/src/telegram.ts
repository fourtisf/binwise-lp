import { fetchJson } from '@binwise/chain';
import type { PrismaClient } from '@binwise/db';

/**
 * Telegram alerts via the Bot API (getUpdates long polling + sendMessage).
 * Users link a chat by sending `/start <code>` to the bot; the code comes from the app.
 */
export class Telegram {
  private offset = 0;
  private stopped = false;

  constructor(private token: string) {}

  private url(method: string) {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async send(chatId: string, text: string) {
    await fetchJson(this.url('sendMessage'), { method: 'POST', body: { chat_id: chatId, text, disable_web_page_preview: true }, retries: 2 });
  }

  /** Long-polls for `/start <code>` messages and links chats to users. */
  async poll(db: PrismaClient, log: (m: string) => void = () => {}) {
    while (!this.stopped) {
      try {
        const r = await fetchJson<{ ok: boolean; result: { update_id: number; message?: { chat: { id: number }; text?: string } }[] }>(
          this.url(`getUpdates?timeout=25&offset=${this.offset}`),
          { timeoutMs: 35_000, retries: 1 },
        );
        for (const u of r.result) {
          this.offset = u.update_id + 1;
          const m = u.message;
          const code = m?.text?.match(/^\/start\s+(\S+)/)?.[1];
          if (!m || !code) continue;
          const user = await db.user.findUnique({ where: { telegramLinkCode: code } });
          if (!user) {
            await this.send(String(m.chat.id), 'That link code is not valid. Open Binwise → Strategy → Telegram alerts to get a new one.');
            continue;
          }
          await db.user.update({ where: { id: user.id }, data: { telegramChatId: String(m.chat.id), telegramLinkCode: null } });
          await this.send(String(m.chat.id), 'Linked. Binwise will post deploys, rebalances, exits and loss stops here.');
        }
      } catch (e) {
        log(`[telegram] ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
