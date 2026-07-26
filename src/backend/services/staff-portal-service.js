import { getFirebaseAdminAuth } from "../../lib/firebase/admin.js";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../utils/errors.js";
function staffOtpKey(userId) {
    return `staff_otp:${userId}`;
}
export class StaffPortalService {
    constructor(userRepository, verificationRepository, staffAuthService) {
        this.userRepository = userRepository;
        this.verificationRepository = verificationRepository;
        this.staffAuthService = staffAuthService;
    }
    assertStaffRole(role) {
        if (role !== "STAFF" && role !== "RECEPTIONIST") {
            throw new ForbiddenError("Not a staff account");
        }
    }
    /** Phone verified via Firebase Phone Auth (SMS). Client sends Firebase ID token after confirm(). */
    async verifyPhoneWithFirebaseIdToken(idToken) {
        let decoded;
        try {
            decoded = await getFirebaseAdminAuth().verifyIdToken(idToken);
        }
        catch {
            throw new UnauthorizedError("Invalid or expired Firebase token");
        }
        const phone = decoded.phone_number;
        if (!phone) {
            throw new BadRequestError("Firebase token has no verified phone number");
        }
        const user = await this.userRepository.findByPhone(phone);
        if (!user)
            throw new BadRequestError("No staff account found for this phone number");
        this.assertStaffRole(user.role);
        if (user.accountStatus !== "PENDING_OTP") {
            throw new BadRequestError("Phone already verified or invalid state");
        }
        await this.verificationRepository.deleteByIdentifier(staffOtpKey(user.id));
        await this.userRepository.updateStaff(user.id, {
            accountStatus: "PHONE_VERIFIED",
            firebaseUid: decoded.uid,
        });
        const setupToken = await this.staffAuthService.signSetupToken(user.id);
        return { setupToken, message: "Phone verified via Firebase. Set your password." };
    }
    async setPassword(setupToken, password) {
        const userId = await this.staffAuthService.verifySetupToken(setupToken);
        const user = await this.userRepository.findById(userId);
        if (!user)
            throw new BadRequestError("User not found");
        this.assertStaffRole(user.role);
        if (user.accountStatus !== "PHONE_VERIFIED") {
            throw new BadRequestError("Invalid account state for password setup");
        }
        const passwordHash = await this.staffAuthService.hashPassword(password);
        await this.userRepository.updateStaff(userId, {
            passwordHash,
            accountStatus: "ACTIVE",
        });
        return { message: "Password set. You can sign in." };
    }
    async login(email, password) {
        const user = await this.userRepository.findByEmail(email);
        if (!user)
            throw new UnauthorizedError("Invalid credentials");
        this.assertStaffRole(user.role);
        if (user.accountStatus === "PENDING_OTP") {
            throw new BadRequestError("VERIFY_PHONE_FIRST");
        }
        if (user.accountStatus === "PHONE_VERIFIED") {
            throw new BadRequestError("NEEDS_PASSWORD");
        }
        if (!user.passwordHash)
            throw new UnauthorizedError("Invalid credentials");
        const match = await this.staffAuthService.verifyPassword(password, user.passwordHash);
        if (!match)
            throw new UnauthorizedError("Invalid credentials");
        const accessToken = await this.staffAuthService.signAccessToken(user.id, user.role, user.name);
        await this.staffAuthService.storeSession(user.id, user.name, user.role);
        return {
            accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
            },
        };
    }
}
