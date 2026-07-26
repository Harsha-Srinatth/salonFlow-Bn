import { v2 as cloudinary } from "cloudinary"

let configured = false

function ensureCloudinaryConfigured() {
  if (configured) return true
  const cloudName = `${process.env.CLOUDINARY_CLOUD_NAME ?? ""}`.trim()
  const apiKey = `${process.env.CLOUDINARY_API_KEY ?? ""}`.trim()
  const apiSecret = `${process.env.CLOUDINARY_API_SECRET ?? ""}`.trim()
  if (!cloudName || !apiKey || !apiSecret) return false
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  })
  configured = true
  return true
}

export async function uploadServiceImageDataUri(dataUri) {
  if (!ensureCloudinaryConfigured()) {
    throw Object.assign(new Error("Cloudinary is not configured"), { code: "CLOUDINARY_NOT_CONFIGURED" })
  }
  const value = `${dataUri ?? ""}`.trim()
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value)) {
    throw Object.assign(new Error("Only image files are supported"), { code: "BAD_REQUEST" })
  }
  // Rough guardrail to avoid huge payloads over JSON.
  if (value.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error("Image is too large"), { code: "BAD_REQUEST" })
  }
  const uploaded = await cloudinary.uploader.upload(value, {
    folder: "sahasra/services",
    resource_type: "image",
  })
  return {
    url: uploaded.secure_url ?? uploaded.url ?? "",
    publicId: uploaded.public_id ?? "",
  }
}
