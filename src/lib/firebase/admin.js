import { cert, getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { readFileSync } from "node:fs";
function normalizePrivateKey(value) {
    const unquoted = value.startsWith("\"") && value.endsWith("\"")
        ? value.slice(1, -1)
        : value;
    return unquoted.replace(/\\n/g, "\n");
}
export function getFirebaseAdminAuth() {
    if (!getApps().length) {
        const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
        if (serviceAccountPath) {
            const raw = readFileSync(serviceAccountPath, "utf8");
            const parsed = JSON.parse(raw);
            initializeApp({
                credential: cert({
                    projectId: parsed.project_id,
                    clientEmail: parsed.client_email,
                    privateKey: parsed.private_key,
                }),
            });
        }
        else {
            const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
            const privateKey = privateKeyRaw
                ? normalizePrivateKey(privateKeyRaw)
                : undefined;
            if (!process.env.FIREBASE_PROJECT_ID ||
                !process.env.FIREBASE_CLIENT_EMAIL ||
                !privateKey) {
                throw new Error("Firebase Admin credentials missing: set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY");
            }
            initializeApp({
                credential: cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey,
                }),
            });
        }
    }
    return getAuth(getApp());
}
