import Redis from 'ioredis';
import type { Logger, RedisConfig } from '../types.js';

type RedisInstance = InstanceType<typeof Redis.default>;

export class RedisClient {
  readonly client: RedisInstance;
  private logger: Logger;

  constructor(config: string | RedisConfig, logger: Logger) {
    this.logger = logger;

    const RedisConstructor = Redis.default ?? Redis;

    if (typeof config === 'string') {
      this.client = new (RedisConstructor as typeof Redis.default)(config, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
        // TLS is auto-enabled for rediss:// URLs by ioredis
        tls: config.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
      });
    } else {
      this.client = new (RedisConstructor as typeof Redis.default)({
        host: config.host,
        port: config.port ?? 6379,
        password: config.password ?? undefined,
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
      });
    }

    this.client.on('connect', () => { this.logger.info('Redis connected'); });
    this.client.on('error', (err: Error) => { this.logger.error('Redis error', { error: err.message }); });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
    this.logger.info('Redis connection closed');
  }
}
