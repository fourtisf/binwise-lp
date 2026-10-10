import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, backoff, fetchJson } from './http';

afterEach(() => vi.unstubAllGlobals());

describe('fetchJson', () => {
  it('retries 429 and 5xx, then succeeds', async () => {
    const responses = [new Response('busy', { status: 429, headers: { 'retry-after': '0.01' } }), new Response('oops', { status: 502 }), new Response('{"ok":1}')];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(await fetchJson('https://x.test/a', { retries: 3 })).toEqual({ ok: 1 });
  });
  it('does not retry client errors', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', f);
    await expect(fetchJson('https://x.test/b')).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('backs off exponentially with a cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoff(0)).toBe(500);
    expect(backoff(3)).toBe(4000);
    expect(backoff(20)).toBe(30_000);
  });
});
