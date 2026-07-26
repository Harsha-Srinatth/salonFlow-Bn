import admin from "firebase-admin"
import { readFileSync, existsSync } from "node:fs"

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH

let privateKey = process.env.FIREBASE_PRIVATE_KEY
if (privateKey) {
  privateKey = privateKey.trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n")
}

if (!admin.apps.length) {
  let initialized = false

  if (serviceAccountPath && existsSync(serviceAccountPath)) {
    try {
      const raw = readFileSync(serviceAccountPath, "utf8")
      const parsed = JSON.parse(raw)
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
        }),
      })
      initialized = true
    } catch (err) {
      console.warn("Failed to initialize Firebase Admin using serviceAccountPath:", err.message)
    }
  }

  if (!initialized) {
    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      })
    } else {
      admin.initializeApp()
    }
  }
}

export async function verifyFirebaseToken(token) {
  return admin.auth().verifyIdToken(token)
}
