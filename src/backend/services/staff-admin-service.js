import { BadRequestError, ConflictError } from "../utils/errors.js";
function staffOtpKey(userId) {
    return `staff_otp:${userId}`;
}
export class StaffAdminService {
    constructor(userRepository, verificationRepository) {
        this.userRepository = userRepository;
        this.verificationRepository = verificationRepository;
    }
    async listStaff(limit, offset) {
        return this.userRepository.listStaff(limit, offset);
    }
    async createStaff(body) {
        const emailTaken = await this.userRepository.findByEmail(body.email);
        if (emailTaken)
            throw new ConflictError("Email already in use");
        const phoneTaken = await this.userRepository.findByPhone(body.phone);
        if (phoneTaken)
            throw new ConflictError("Phone already in use");
        const user = await this.userRepository.createStaffRecord({
            name: body.name,
            email: body.email,
            phone: body.phone,
            role: body.role,
        });
        if (!user)
            throw new BadRequestError("Failed to create staff");
        await this.verificationRepository.deleteByIdentifier(staffOtpKey(user.id));
        return {
            staff: user,
            message: "Staff created. They must verify their phone with Firebase SMS on /staff/verify-otp using this number.",
        };
    }
    async updateStaff(id, body) {
        const existing = await this.userRepository.findById(id);
        if (!existing)
            throw new BadRequestError("Staff not found");
        if (existing.role !== "STAFF" && existing.role !== "RECEPTIONIST") {
            throw new BadRequestError("Not a staff account");
        }
        if (body.email && body.email !== existing.email) {
            const taken = await this.userRepository.findByEmail(body.email);
            if (taken)
                throw new ConflictError("Email already in use");
        }
        if (body.phone && body.phone !== existing.phone) {
            const taken = await this.userRepository.findByPhone(body.phone);
            if (taken)
                throw new ConflictError("Phone already in use");
        }
        const phoneChanged = body.phone != null && body.phone !== existing.phone;
        const patch = {};
        if (body.name != null)
            patch.name = body.name;
        if (body.email != null)
            patch.email = body.email;
        if (body.phone != null)
            patch.phone = body.phone;
        if (body.role != null)
            patch.role = body.role;
        if (phoneChanged) {
            patch.accountStatus = "PENDING_OTP";
            patch.passwordHash = null;
            patch.firebaseUid = null;
            await this.verificationRepository.deleteByIdentifier(staffOtpKey(id));
        }
        if (Object.keys(patch).length === 0) {
            return { staff: existing };
        }
        const updated = await this.userRepository.updateStaff(id, patch);
        if (!updated)
            throw new BadRequestError("Update failed");
        return { staff: updated };
    }
    async deleteStaff(id) {
        const existing = await this.userRepository.findById(id);
        if (!existing)
            throw new BadRequestError("Staff not found");
        if (existing.role !== "STAFF" && existing.role !== "RECEPTIONIST") {
            throw new BadRequestError("Not a staff account");
        }
        await this.verificationRepository.deleteByIdentifier(staffOtpKey(id));
        await this.userRepository.deleteById(id);
        return { success: true };
    }
}
