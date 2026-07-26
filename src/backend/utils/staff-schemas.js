import { z } from "zod";
const e164Phone = z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, "Phone must be E.164, e.g. +919876543210");
export const createStaffBodySchema = z.object({
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().email().max(255),
    phone: e164Phone,
    role: z.enum(["STAFF", "RECEPTIONIST"]),
});
export const updateStaffBodySchema = z.object({
    name: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().email().max(255).optional(),
    phone: e164Phone.optional(),
    role: z.enum(["STAFF", "RECEPTIONIST"]).optional(),
});
export const staffSetPasswordSchema = z.object({
    password: z.string().min(8).max(128),
});
export const staffLoginSchema = z.object({
    email: z.string().trim().email(),
    password: z.string().min(1),
});
