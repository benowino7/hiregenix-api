const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma");
const COUNTRY_CODES = require("../countryCodes");
const fs = require("fs/promises");
const path = require("path");

// Read 2FA store to check if user has 2FA enabled
const STORE_PATH = path.join(__dirname, "../../data/two_factor_secrets.json");
async function read2FAStore() {
	try {
		const raw = await fs.readFile(STORE_PATH, "utf-8");
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/**
 * Build the full user payload (roles, profiles, etc.)
 * Shared between login and verifyLogin2FA
 */
async function buildLoginPayload(userId) {
	const rolesRows = await prisma.userRole.findMany({
		where: { userId, isActive: true },
		select: { role: true },
	});
	const roles = rolesRows.map((r) => r.role);

	const full = await prisma.user.findUnique({
		where: { id: userId },
		select: {
			id: true,
			firstName: true,
			lastName: true,
			middleName: true,
			email: true,
			phoneNumber: true,
			countryCode: true,
			isActive: true,
			jobSeekerProfile: {
				select: {
					id: true,
					skills: { select: { id: true } },
				},
			},
			recruiterProfile: {
				select: {
					id: true,
					companyId: true,
					isApproved: true,
					status: true,
					recruiterRoles: {
						where: { isActive: true },
						select: { role: true },
					},
				},
			},
			adminProfile: {
				select: { id: true },
			},
		},
	});

	const profile = {};

	if (roles.includes("JOB_SEEKER") && full.jobSeekerProfile) {
		profile.jobSeeker = {
			id: full.jobSeekerProfile.id,
			skillsCount: full.jobSeekerProfile.skills?.length ?? 0,
		};
	}

	if (roles.includes("RECRUITER") && full.recruiterProfile) {
		profile.recruiter = {
			id: full.recruiterProfile.id,
			companyId: full.recruiterProfile.companyId,
			isApproved: full.recruiterProfile.isApproved,
			status: full.recruiterProfile.status,
			roles: (full.recruiterProfile.recruiterRoles || []).map((r) => r.role),
		};
	}

	if (roles.includes("ADMIN") && full.adminProfile) {
		profile.admin = { id: full.adminProfile.id };
	}

	const payload = {
		userId: full.id,
		roles,
		isActive: full.isActive,
		user: {
			firstName: full.firstName,
			lastName: full.lastName,
			email: full.email,
			phoneNumber: full.phoneNumber,
			countryCode: full.countryCode,
		},
		profile,
	};

	return { payload, roles, profile, full };
}

const login = async (req, res) => {
	try {
		const { email, phoneNumber, countryCode, password } = req.body;

		if (!password) {
			return res.status(400).json({ status: "FAIL", message: "Password is required" });
		}

		let user = null;

		if (email) {
			user = await prisma.user.findUnique({ where: { email } });
		}

		if (!user && phoneNumber && countryCode) {
			if (!COUNTRY_CODES.includes(countryCode)) {
				return res.status(400).json({ status: "FAIL", message: "Invalid country code" });
			}

			user = await prisma.user.findFirst({
				where: { phoneNumber, countryCode },
			});
		}

		if (!user) {
			return res.status(401).json({ status: "FAIL", message: "Invalid login credentials" });
		}

		const ok = await bcrypt.compare(password, user.password);
		if (!ok) {
			return res.status(401).json({ status: "FAIL", message: "Invalid login credentials" });
		}

		// Check if user account is active
		if (!user.isActive) {
			return res.status(403).json({ status: "FAIL", message: "Your account has been deactivated. Please contact support." });
		}

		// Check if user has 2FA enabled
		const store = await read2FAStore();
		const twoFA = store[user.id];
		if (twoFA && twoFA.verified) {
			// 2FA is enabled — issue a short-lived temp token and require TOTP verification
			const tempToken = jwt.sign(
				{ userId: user.id, purpose: "2fa-login" },
				process.env.JWT_SECRET,
				{ expiresIn: "5m" }
			);
			return res.status(200).json({
				status: "2FA_REQUIRED",
				message: "Two-factor authentication required",
				requires2FA: true,
				tempToken,
			});
		}

		// No 2FA — proceed with normal login
		const { payload, roles, profile, full } = await buildLoginPayload(user.id);

		const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

		return res.status(200).json({
			status: "SUCCESS",
			message: "Login successful",
			data: {
				...payload.user,
				userId: full.id,
				roles,
				profile,
				token,
			},
		});
	} catch (error) {
		console.error("Login error:", error);
		return res.status(500).json({ status: "FAIL", message: "Something went wrong" });
	}
};

/**
 * POST /auth/verify-login-2fa
 * Verify TOTP code after password authentication for users with 2FA enabled
 */
const verifyLogin2FA = async (req, res) => {
	try {
		const { tempToken, code } = req.body;

		if (!tempToken || !code) {
			return res.status(400).json({ status: "FAIL", message: "Temporary token and authenticator code are required" });
		}

		if (code.length !== 6) {
			return res.status(400).json({ status: "FAIL", message: "Code must be 6 digits" });
		}

		// Verify the temp token
		let decoded;
		try {
			decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
		} catch (err) {
			return res.status(401).json({ status: "FAIL", message: "Session expired. Please log in again." });
		}

		if (decoded.purpose !== "2fa-login") {
			return res.status(401).json({ status: "FAIL", message: "Invalid token" });
		}

		const userId = decoded.userId;

		// Verify TOTP code
		const store = await read2FAStore();
		const entry = store[userId];
		if (!entry || !entry.verified || !entry.secret) {
			return res.status(400).json({ status: "FAIL", message: "2FA is not configured" });
		}

		// Import TOTP verification from twoFactor module
		const { verifyTOTP } = require("./twoFactor");
		if (!verifyTOTP(entry.secret, code)) {
			return res.status(400).json({ status: "FAIL", message: "Invalid authenticator code. Please try again." });
		}

		// 2FA verified — build full login payload
		const { payload, roles, profile, full } = await buildLoginPayload(userId);

		const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

		return res.status(200).json({
			status: "SUCCESS",
			message: "Login successful",
			data: {
				...payload.user,
				userId: full.id,
				roles,
				profile,
				token,
			},
		});
	} catch (error) {
		console.error("verifyLogin2FA error:", error);
		return res.status(500).json({ status: "FAIL", message: "Something went wrong" });
	}
};

module.exports = { login, verifyLogin2FA };
