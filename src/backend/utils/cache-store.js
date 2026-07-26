import Redis from "ioredis";
class CacheStore {
    constructor() {
        this.redis = null;
        this.memory = new Map();
        if (process.env.REDIS_URL) {
            this.redis = new Redis(process.env.REDIS_URL, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
            });
            this.redis.connect().catch(() => {
                this.redis = null;
            });
        }
    }
    async get(key) {
        if (this.redis) {
            try {
                return await this.redis.get(key);
            }
            catch {
                this.redis = null;
            }
        }
        const current = this.memory.get(key);
        if (!current || current.expiresAtMs <= Date.now()) {
            this.memory.delete(key);
            return null;
        }
        return current.value;
    }
    async set(key, value, ttlSeconds) {
        if (this.redis) {
            try {
                await this.redis.set(key, value, "EX", ttlSeconds);
                return;
            }
            catch {
                this.redis = null;
            }
        }
        this.memory.set(key, {
            value,
            expiresAtMs: Date.now() + ttlSeconds * 1000,
        });
    }
    async increment(key, ttlSeconds) {
        if (this.redis) {
            try {
                const value = await this.redis.incr(key);
                if (value === 1) {
                    await this.redis.expire(key, ttlSeconds);
                }
                return value;
            }
            catch {
                this.redis = null;
            }
        }
        const now = Date.now();
        const existing = this.memory.get(key);
        if (!existing || existing.expiresAtMs <= now) {
            this.memory.set(key, {
                value: "1",
                expiresAtMs: now + ttlSeconds * 1000,
            });
            return 1;
        }
        const next = Number(existing.value) + 1;
        this.memory.set(key, { ...existing, value: String(next) });
        return next;
    }
    async del(key) {
        if (this.redis) {
            try {
                await this.redis.del(key);
                return;
            }
            catch {
                this.redis = null;
            }
        }
        this.memory.delete(key);
    }
}
export const cacheStore = new CacheStore();
