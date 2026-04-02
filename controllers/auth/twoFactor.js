const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs/promises");
const path = require("path");
const { prisma } = require("../../prisma");

// File-based 2FA secret store (since we can't easily add Prisma columns)
const STORE_DIR = path.join(__dirname, "../../data");
const STORE_PATH = path.join(STORE_DIR, "two_factor_secrets.json");

async function readStore() {
	try {
		await fs.mkdir(STORE_DIR, { recursive: true });
		const raw = await fs.readFile(STORE_PATH, "utf-8");
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

async function writeStore(data) {
	await fs.mkdir(STORE_DIR, { recursive: true });
	await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2));
}

// ── Base32 encoding/decoding ──
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
	let bits = "";
	for (const byte of buffer) {
		bits += byte.toString(2).padStart(8, "0");
	}
	let result = "";
	for (let i = 0; i < bits.length; i += 5) {
		const chunk = bits.substring(i, i + 5).padEnd(5, "0");
		result += BASE32_ALPHABET[parseInt(chunk, 2)];
	}
	return result;
}

function base32Decode(str) {
	let bits = "";
	for (const char of str.toUpperCase().replace(/=+$/, "")) {
		const idx = BASE32_ALPHABET.indexOf(char);
		if (idx === -1) continue;
		bits += idx.toString(2).padStart(5, "0");
	}
	const bytes = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		bytes.push(parseInt(bits.substring(i, i + 8), 2));
	}
	return Buffer.from(bytes);
}

// ── TOTP generation and verification ──
function generateTOTP(secret, timeStep = Math.floor(Date.now() / 1000 / 30)) {
	const buffer = Buffer.alloc(8);
	// Write as big-endian 64-bit integer
	for (let i = 7; i >= 0; i--) {
		buffer[i] = timeStep & 0xff;
		timeStep = Math.floor(timeStep / 256);
	}

	const key = base32Decode(secret);
	const hmac = crypto.createHmac("sha1", key);
	hmac.update(buffer);
	const hash = hmac.digest();

	const offset = hash[hash.length - 1] & 0xf;
	const code =
		(((hash[offset] & 0x7f) << 24) |
			((hash[offset + 1] & 0xff) << 16) |
			((hash[offset + 2] & 0xff) << 8) |
			(hash[offset + 3] & 0xff)) %
		1000000;

	return code.toString().padStart(6, "0");
}

function verifyTOTP(secret, token) {
	const time = Math.floor(Date.now() / 1000 / 30);
	// Allow 1 step before and after (90 second window)
	for (let i = -1; i <= 1; i++) {
		if (generateTOTP(secret, time + i) === token) return true;
	}
	return false;
}

// ── API Endpoints ──

/**
 * POST /auth/setup-2fa (authenticated)
 * Generate a TOTP secret and return the otpauth URI for QR code scanning
 */
const setup2FA = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ status: "FAIL", message: "Unauthorized" });
		}

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, email: true },
		});

		if (!user) {
			return res.status(404).json({ status: "FAIL", message: "User not found" });
		}

		// Generate a 20-byte random secret and encode as base32
		const secretBytes = crypto.randomBytes(20);
		const secret = base32Encode(secretBytes);

		// Build otpauth URI
		const issuer = "HireGeniX";
		const label = encodeURIComponent(`${issuer}:${user.email}`);
		const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

		// Store secret temporarily (not yet verified)
		const store = await readStore();
		store[userId] = { secret, verified: false, createdAt: new Date().toISOString() };
		await writeStore(store);

		return res.status(200).json({
			status: "SUCCESS",
			message: "Scan the QR code with Google Authenticator",
			result: {
				secret,
				otpauthUri,
				qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(otpauthUri)}`,
			},
		});
	} catch (error) {
		console.error("setup2FA error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to set up 2FA" });
	}
};

/**
 * POST /auth/verify-2fa (authenticated)
 * Verify TOTP code and enable 2FA for the user
 */
const verify2FA = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { code } = req.body;

		if (!userId) {
			return res.status(401).json({ status: "FAIL", message: "Unauthorized" });
		}
		if (!code || code.length !== 6) {
			return res.status(400).json({ status: "FAIL", message: "6-digit code is required" });
		}

		const store = await readStore();
		const entry = store[userId];

		if (!entry || !entry.secret) {
			return res.status(400).json({ status: "FAIL", message: "No 2FA setup in progress. Please set up 2FA first." });
		}

		if (!verifyTOTP(entry.secret, code)) {
			return res.status(400).json({ status: "FAIL", message: "Invalid code. Please try again." });
		}

		// Mark as verified
		store[userId] = { ...entry, verified: true, verifiedAt: new Date().toISOString() };
		await writeStore(store);

		return res.status(200).json({
			status: "SUCCESS",
			message: "2FA has been enabled successfully!",
		});
	} catch (error) {
		console.error("verify2FA error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to verify 2FA" });
	}
};

/**
 * GET /auth/2fa-status (authenticated)
 * Check if user has 2FA enabled
 */
const get2FAStatus = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ status: "FAIL", message: "Unauthorized" });
		}

		const store = await readStore();
		const entry = store[userId];
		const enabled = !!(entry && entry.verified);

		return res.status(200).json({
			status: "SUCCESS",
			result: { enabled },
		});
	} catch (error) {
		console.error("get2FAStatus error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to get 2FA status" });
	}
};

/**
 * POST /auth/disable-2fa (authenticated)
 * Disable 2FA - requires valid TOTP code
 */
const disable2FA = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { code } = req.body;

		if (!userId) {
			return res.status(401).json({ status: "FAIL", message: "Unauthorized" });
		}
		if (!code) {
			return res.status(400).json({ status: "FAIL", message: "Authenticator code is required" });
		}

		const store = await readStore();
		const entry = store[userId];

		if (!entry || !entry.verified) {
			return res.status(400).json({ status: "FAIL", message: "2FA is not enabled" });
		}

		if (!verifyTOTP(entry.secret, code)) {
			return res.status(400).json({ status: "FAIL", message: "Invalid code" });
		}

		delete store[userId];
		await writeStore(store);

		return res.status(200).json({
			status: "SUCCESS",
			message: "2FA has been disabled",
		});
	} catch (error) {
		console.error("disable2FA error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to disable 2FA" });
	}
};

/**
 * POST /auth/check-2fa-enabled (public)
 * Check if a user has 2FA enabled by email (for forgot-password flow)
 */
const check2FAByEmail = async (req, res) => {
	try {
		const { email } = req.body;
		if (!email) {
			return res.status(400).json({ status: "FAIL", message: "Email is required" });
		}

		const user = await prisma.user.findUnique({
			where: { email: email.toLowerCase().trim() },
			select: { id: true },
		});

		if (!user) {
			// Don't reveal if user exists
			return res.status(200).json({ status: "SUCCESS", result: { has2FA: false } });
		}

		const store = await readStore();
		const entry = store[user.id];
		const has2FA = !!(entry && entry.verified);

		return res.status(200).json({
			status: "SUCCESS",
			result: { has2FA },
		});
	} catch (error) {
		console.error("check2FAByEmail error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to check 2FA status" });
	}
};

/**
 * POST /auth/reset-password-2fa (public)
 * Reset password using email + TOTP code (no email token needed)
 */
const resetPasswordWith2FA = async (req, res) => {
	try {
		const { email, code, newPassword } = req.body;

		if (!email || !code || !newPassword) {
			return res.status(400).json({ status: "FAIL", message: "Email, authenticator code, and new password are required" });
		}

		if (newPassword.length < 8) {
			return res.status(400).json({ status: "FAIL", message: "Password must be at least 8 characters" });
		}

		const user = await prisma.user.findUnique({
			where: { email: email.toLowerCase().trim() },
			select: { id: true, isActive: true },
		});

		if (!user || !user.isActive) {
			return res.status(400).json({ status: "FAIL", message: "Invalid email or authenticator code" });
		}

		const store = await readStore();
		const entry = store[user.id];

		if (!entry || !entry.verified) {
			return res.status(400).json({ status: "FAIL", message: "2FA is not enabled for this account" });
		}

		if (!verifyTOTP(entry.secret, code)) {
			return res.status(400).json({ status: "FAIL", message: "Invalid authenticator code" });
		}

		// Reset the password
		const hashedPassword = await bcrypt.hash(newPassword, 12);
		await prisma.user.update({
			where: { id: user.id },
			data: { password: hashedPassword },
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Password has been reset successfully. You can now log in with your new password.",
		});
	} catch (error) {
		console.error("resetPasswordWith2FA error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to reset password" });
	}
};

module.exports = { setup2FA, verify2FA, get2FAStatus, disable2FA, check2FAByEmail, resetPasswordWith2FA, verifyTOTP };
