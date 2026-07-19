import Redis from 'ioredis';
import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

export function redisCheck(redisUrl: string): Check {
  return makeCheck('redis-connection', async () => {
    const redis = new Redis(redisUrl, { connectTimeout: 5000, lazyConnect: true });
    try {
      await redis.connect();
      const pong = await redis.ping();
      if (pong !== 'PONG') {
        throw new Error(`unexpected PING reply: ${pong}`);
      }
      const info = await redis.info('server');
      const versionMatch = info.match(/redis_version:([^\r\n]+)/);
      return versionMatch ? `redis ${versionMatch[1]}` : 'redis responded';
    } finally {
      redis.disconnect();
    }
  });
}
