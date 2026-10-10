import { KEYS, makeRedis } from './redis';

/** Global kill switch: `pnpm --filter @binwise/agent kill on|off|status` */
const arg = process.argv[2] ?? 'status';
const r = makeRedis();
if (arg === 'on') await r.set(KEYS.kill, '1');
else if (arg === 'off') await r.del(KEYS.kill);
else if (arg !== 'status') {
  console.error('Usage: kill on|off|status');
  process.exit(1);
}
console.log(`Kill switch is ${(await r.get(KEYS.kill)) === '1' ? 'ON: no trades will be sent' : 'off'}.`);
await r.quit();
