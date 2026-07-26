import admin from "firebase-admin"
import { readFileSync } from "node:fs"

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH

if (!admin.apps.length) {
  if (serviceAccountPath) {
    const raw = readFileSync(serviceAccountPath, "utf8")
    const parsed = JSON.parse(raw)
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
      }),
    })
  } else if (projectId && clientEmail && privateKey) {
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

export async function verifyFirebaseToken(token) {
  return admin.auth().verifyIdToken(token)
}
