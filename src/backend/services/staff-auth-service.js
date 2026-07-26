import { ACCESS_TOKEN_TTL_SEC, SESSION_CACHE_PREFIX, SETUP_TOKEN_TTL_SEC, } from "../constants/staff-auth.js";
import { cacheStore } from "../utils/cache-store.js";
import * as bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";
function getJwtSecretKey() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 16) {
        throw new Error("JWT_SECRET environment variable must be set (min 16 characters)");
    }
    return new TextEncoder().encode(secret);
}
export class StaffAuthService {
    async hashPassword(plain) {
        return bcrypt.hash(plain, 12);
    }
    async verifyPassword(plain, hash) {
        return bcrypt.compare(plain, hash);
    }
    async signSetupToken(userId) {
        return new SignJWT({ typ: "setup_password" })
            .setProtectedHeader({ alg: "HS256" })
            .setSubject(userId)
            .setIssuedAt()
            .setExpirationTime(`${SETUP_TOKEN_TTL_SEC}s`)
            .sign(getJwtSecretKey());
    }
    async signAccessToken(userId, role, name) {
        return new SignJWT({ role, name, typ: "access" })
            .setProtectedHeader({ alg: "HS256" })
            .setSubject(userId)
            .setIssuedAt()
            .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
            .sign(getJwtSecretKey());
    }
    async verifySetupToken(token) {
        const { payload } = await jwtVerify(token, getJwtSecretKey());
        const p = payload;
        if (p.typ !== "setup_password" || typeof p.sub !== "string") {
            throw new UnauthorizedError("Invalid setup token");
        }
        return p.sub;
    }
    async verifyAccessToken(token) {
        const { payload } = await jwtVerify(token, getJwtSecretKey());
        const p = payload;
        if (p.typ !== "access" || typeof p.sub !== "string" || typeof p.role !== "string") {
            throw new UnauthorizedError("Invalid access token");
        }
        if (p.role !== "STAFF" && p.role !== "RECEPTIONIST") {
            throw new ForbiddenError("Staff access only");
        }
        return p;
    }
    async storeSession(userId, name, role) {
        await cacheStore.set(`${SESSION_CACHE_PREFIX}${userId}`, JSON.stringify({ name, role }), ACCESS_TOKEN_TTL_SEC);
    }
    async clearSession(userId) {
        await cacheStore.del(`${SESSION_CACHE_PREFIX}${userId}`);
    }
}
