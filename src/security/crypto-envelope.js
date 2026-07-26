import crypto from "node:crypto"

function getEncryptionSecrets() {
  const activeKid = process.env.BOOKING_CRYPTO_ACTIVE_KID ?? "v1"
  const entries = `${process.env.BOOKING_CRYPTO_KEYS ?? ""}`
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean)
  const map = new Map()
  for (const entry of entries) {
    const [kid, key] = entry.split(":")
    if (kid && key) map.set(kid.trim(), Buffer.from(key.trim(), "base64"))
  }
  if (!map.has(activeKid) && process.env.BOOKING_CRYPTO_KEY_BASE64) {
    map.set(activeKid, Buffer.from(process.env.BOOKING_CRYPTO_KEY_BASE64, "base64"))
  }
  return { activeKid, keyMap: map }
}

export function hasEnvelopeCryptoEnabled() {
  const { keyMap } = getEncryptionSecrets()
  return keyMap.size > 0
}

export function encryptEnvelope(value) {
  const payload = JSON.stringify(value ?? {})
  const { activeKid, keyMap } = getEncryptionSecrets()
  const key = keyMap.get(activeKid)
  if (!key) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    alg: "aes-256-gcm",
    kid: activeKid,
    iv: iv.toString("base64"),
    data: data.toString("base64"),
    tag: tag.toString("base64"),
  }
}

export function decryptEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new Error("Invalid encrypted envelope")
  const { keyMap } = getEncryptionSecrets()
  const key = keyMap.get(envelope.kid)
  if (!key) throw new Error("Unknown envelope key id")
  const iv = Buffer.from(`${envelope.iv ?? ""}`, "base64")
  const data = Buffer.from(`${envelope.data ?? ""}`, "base64")
  const tag = Buffer.from(`${envelope.tag ?? ""}`, "base64")
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  return JSON.parse(plain)
}

export function encryptPiiText(value) {
  if (!value) return null
  const envelope = encryptEnvelope({ value })
  return envelope ? JSON.stringify(envelope) : null
}

export function decryptPiiText(value) {
  if (!value) return null
  try {
    const envelope = JSON.parse(value)
    const decrypted = decryptEnvelope(envelope)
    return decrypted?.value ?? null
  } catch {
    return null
  }
}
