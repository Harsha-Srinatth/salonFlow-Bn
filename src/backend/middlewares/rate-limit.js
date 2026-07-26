import { ForbiddenError } from "../utils/errors.js";
import { cacheStore } from "../utils/cache-store.js";
export async function enforceRateLimit(request, config) {
    const forwardedFor = request.headers.get("x-forwarded-for") ?? "unknown";
    const key = `${config.keyPrefix}:${forwardedFor.split(",")[0]?.trim()}`;
    const ttlSeconds = Math.max(1, Math.ceil(config.windowMs / 1000));
    const count = await cacheStore.increment(key, ttlSeconds);
    if (count > config.max) {
        throw new ForbiddenError("Rate limit exceeded");
    }
}
