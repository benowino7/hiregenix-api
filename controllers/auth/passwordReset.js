const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs/promises");
const path = require("path");
const { prisma } = require("../../prisma");

// =======================
// Token store (file-based)
// =======================
// Since we cannot run prisma migrate, we use a simple JSON file
// to store password reset tokens. In production, consider adding
// a PasswordResetToken model to the Prisma schema.
const TOKEN_STORE_DIR = path.join(__dirname, "../../data");
const TOKEN_STORE_PATH = path.join(TOKEN_STORE_DIR, "password_reset_tokens.json");
const TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

async function readTokenStore() {
	try {
		await fs.mkdir(TOKEN_STORE_DIR, { recursive: true });
		const raw = await fs.readFile(TOKEN_STORE_PATH, "utf-8");
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function writeTokenStore(tokens) {
	await fs.mkdir(TOKEN_STORE_DIR, { recursive: true });
	await fs.writeFile(TOKEN_STORE_PATH, JSON.stringify(tokens, null, 2));
}

// =======================
// FORGOT PASSWORD
// =======================
// POST /auth/forgot-password
// Accepts email, generates a reset token, stores it, and returns success.
// In production, you would send the token via email instead of returning it.
const forgotPassword = async (req, res) => {
	try {
		const { email } = req.body;

		if (!email) {
			return res.status(400).json({
				status: "FAIL",
				message: "Email is required",
			});
		}

		// 1) Find user by email
		const user = await prisma.user.findUnique({
			where: { email: email.toLowerCase().trim() },
			select: { id: true, email: true, isActive: true },
		});

		// Always return success to prevent email enumeration attacks
		if (!user || !user.isActive) {
			return res.status(200).json({
				status: "SUCCESS",
				message: "If an account with that email exists, a password reset link has been sent",
			});
		}

		// 2) Generate a secure random token
		const resetToken = crypto.randomBytes(32).toString("hex");
		const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

		// 3) Store token with expiry
		const tokens = await readTokenStore();

		// Remove any existing tokens for this user (only one active reset at a time)
		const filteredTokens = tokens.filter((t) => t.userId !== user.id);

		filteredTokens.push({
			userId: user.id,
			email: user.email,
			token: hashedToken,
			expiresAt: new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString(),
			createdAt: new Date().toISOString(),
		});

		await writeTokenStore(filteredTokens);

		// 4) In production, send email with reset link containing the raw token.
		// For now, we log it and return success.
		// The reset link would be: https://hiregenix.io/reset-password?token=<resetToken>
		console.log(`Password reset token generated for ${user.email}: ${resetToken}`);

		return res.status(200).json({
			status: "SUCCESS",
			message: "If an account with that email exists, a password reset link has been sent",
			// Include token in response for development/testing only.
			// REMOVE THIS IN PRODUCTION - send via email instead.
			...(process.env.NODE_ENV !== "production" && { resetToken }),
		});
	} catch (error) {
		console.error("Forgot password error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to process password reset request",
		});
	}
};

// =======================
// RESET PASSWORD
// =======================
// POST /auth/reset-password
// Accepts token + new password, validates token, updates password.
const resetPassword = async (req, res) => {
	try {
		const { token, newPassword } = req.body;

		if (!token || !newPassword) {
			return res.status(400).json({
				status: "FAIL",
				message: "Token and newPassword are required",
			});
		}

		if (newPassword.length < 8) {
			return res.status(400).json({
				status: "FAIL",
				message: "Password must be at least 8 characters",
			});
		}

		// 1) Hash the incoming token to compare with stored hash
		const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

		// 2) Find matching token in store
		const tokens = await readTokenStore();
		const tokenEntry = tokens.find((t) => t.token === hashedToken);

		if (!tokenEntry) {
			return res.status(400).json({
				status: "FAIL",
				message: "Invalid or expired reset token",
			});
		}

		// 3) Check if token has expired
		if (new Date(tokenEntry.expiresAt) < new Date()) {
			// Remove expired token
			const filteredTokens = tokens.filter((t) => t.token !== hashedToken);
			await writeTokenStore(filteredTokens);

			return res.status(400).json({
				status: "FAIL",
				message: "Reset token has expired. Please request a new one.",
			});
		}

		// 4) Hash the new password
		const hashedPassword = await bcrypt.hash(newPassword, 12);

		// 5) Update the user's password
		await prisma.user.update({
			where: { id: tokenEntry.userId },
			data: { password: hashedPassword },
		});

		// 6) Remove the used token (and any other expired tokens while we're at it)
		const now = new Date();
		const cleanedTokens = tokens.filter(
			(t) => t.token !== hashedToken && new Date(t.expiresAt) > now
		);
		await writeTokenStore(cleanedTokens);

		return res.status(200).json({
			status: "SUCCESS",
			message: "Password has been reset successfully. You can now log in with your new password.",
		});
	} catch (error) {
		console.error("Reset password error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to reset password",
		});
	}
};

module.exports = { forgotPassword, resetPassword };
