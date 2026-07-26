import { getFirebaseAdminAuth } from "../../lib/firebase/admin.js";
import { UnauthorizedError } from "../utils/errors.js";
import { cacheStore } from "../utils/cache-store.js";
const CACHE_TTL_MS = 30 * 1000;
export async function authenticateRequest(request) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
        throw new UnauthorizedError("Missing bearer token");
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const now = Date.now();
    const cacheKey = `firebase-token:${token}`;
    const cached = await cacheStore.get(cacheKey);
    if (cached) {
        return JSON.parse(cached);
    }
    let decoded;
    try {
        decoded = await getFirebaseAdminAuth().verifyIdToken(token);
    }
    catch {
        throw new UnauthorizedError("Invalid or expired Firebase token");
    }
    const ttlSeconds = Math.max(1, Math.floor(CACHE_TTL_MS / 1000));
    const tokenExpSeconds = decoded.exp ? Math.max(1, decoded.exp - Math.floor(now / 1000)) : ttlSeconds;
    await cacheStore.set(cacheKey, JSON.stringify(decoded), Math.min(ttlSeconds, tokenExpSeconds));
    return decoded;
}
