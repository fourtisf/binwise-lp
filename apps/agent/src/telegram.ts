import { fetchJson } from '@binwise/chain';

/**
 * Minimal Telegram Bot API client (https://core.telegram.org/bots/api): long polling with
 * getUpdates, messages with inline buttons, and callback answers. No webhook or extra server needed.
 */

export type Button = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = Button[][];

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
}

export interface TgCallback {
  id: string;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

/** What the bot needs from Telegram; tests swap in a fake. */
export interface TelegramApi {
  send(chatId: string, text: string, opts?: { html?: boolean; keyboard?: Keyboard }): Promise<void>;
  edit(chatId: string, messageId: number, text: string, opts?: { html?: boolean; keyboard?: Keyboard }): Promise<void>;
  answer(callbackId: string, text?: string): Promise<void>;
}

export class Telegram implements TelegramApi {
  private offset = 0;
  private stopped = false;

  constructor(private token: string) {}

  private async call<T = unknown>(method: string, body: object, timeoutMs?: number) {
    try {
      return await fetchJson<{ ok: boolean; result: T }>(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        body,
        retries: 2,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    } catch (e) {
      // Errors carry the request URL, which contains the bot token: never let it reach the logs.
      throw new Error((e as Error).message.split(this.token).join('***'));
    }
  }

  private static body(text: string, opts: { html?: boolean; keyboard?: Keyboard } = {}) {
    return {
      text,
      ...(opts.html ? { parse_mode: 'HTML' } : {}),
      link_preview_options: { is_disabled: true },
      ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
    };
  }

  async send(chatId: string, text: string, opts?: { html?: boolean; keyboard?: Keyboard }) {
    await this.call('sendMessage', { chat_id: chatId, ...Telegram.body(text, opts) });
  }

  async edit(chatId: string, messageId: number, text: string, opts?: { html?: boolean; keyboard?: Keyboard }) {
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, ...Telegram.body(text, opts) });
    } catch (e) {
      // Pressing the same button twice yields "message is not modified": harmless.
      if (!/not modified/i.test((e as Error).message)) throw e;
    }
  }

  async answer(callbackId: string, text?: string) {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }).catch(() => {});
  }

  /** The "/" menu Telegram shows next to the message box. */
  async setCommands(commands: { command: string; description: string }[]) {
    await this.call('setMyCommands', { commands });
  }

  /** Long-polls for messages and button presses and hands each one to `onUpdate`. */
  async poll(onUpdate: (u: TgUpdate) => Promise<void>, log: (m: string) => void = () => {}) {
    while (!this.stopped) {
      try {
        const r = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          35_000,
        );
        for (const u of r.result) {
          this.offset = u.update_id + 1;
          await onUpdate(u).catch((e) => log(`[telegram] update ${u.update_id}: ${(e as Error).message}`));
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
