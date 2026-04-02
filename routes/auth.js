const express = require("express");
const { check, query, body, validationResult } = require("express-validator");
const validateRequest = require("../middlewares/validateMiddleware");
const Router = express.Router();

const { register } = require("../controllers/auth/register");
const { login, verifyLogin2FA } = require("../controllers/auth/login");
const { forgotPassword, resetPassword } = require("../controllers/auth/passwordReset");
Router.post(
	"/register",
	[
		body("firstName").notEmpty().withMessage("First name is required"),
		body("middleName").optional(),
		body("lastName").notEmpty().withMessage("Last name is required"),
		body("email")
			.notEmpty()
			.withMessage("Email is required")
			.isEmail()
			.withMessage("Must be a valid email address")
			.normalizeEmail({ gmail_remove_dots: false }), // converts to lowercase and trims spaces
		body("phoneNumber").notEmpty().withMessage("Phone number is required").isNumeric().withMessage("Phone number must contain only digits"),
		body("countryCode")
			.notEmpty()
			.withMessage("Country code is required")
			.matches(/^\+\d{1,4}$/)
			.withMessage("Country code must be in E.164 format"),
		body("password").notEmpty().withMessage("Password is required").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
		body("role").notEmpty().isIn(["JOB_SEEKER", "RECRUITER"]).withMessage("Role must be either JOB_SEEKER or RECRUITER"),
	],
	validateRequest,
	register,
);
Router.post(
	"/login",
	[
		// Password
		body("password").notEmpty().withMessage("Password is required").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),

		// Email (optional but must be valid if present)
		body("email").optional().isEmail().withMessage("Invalid email format").normalizeEmail({ gmail_remove_dots: false }),

		// Phone number (optional)
		body("phoneNumber")
			.optional()
			.isString()
			.withMessage("Phone number must be a string")
			.isLength({ min: 6, max: 15 })
			.withMessage("Invalid phone number"),

		// Country code (optional)
		body("countryCode").optional().isString().withMessage("Country code must be a string"),
		// Cross-field validation (email OR phone+countryCode)
		body().custom((value) => {
			if (value.email) return true;

			if (value.phoneNumber && value.countryCode) return true;

			throw new Error("Provide either email or phoneNumber with countryCode");
		}),
	],
	validateRequest,
	login,
);

// Password Reset
Router.post(
	"/forgot-password",
	[
		body("email")
			.notEmpty()
			.withMessage("Email is required")
			.isEmail()
			.withMessage("Must be a valid email address")
			.normalizeEmail({ gmail_remove_dots: false }),
	],
	validateRequest,
	forgotPassword,
);
Router.post(
	"/reset-password",
	[
		body("token").notEmpty().withMessage("Reset token is required"),
		body("newPassword")
			.notEmpty()
			.withMessage("New password is required")
			.isLength({ min: 8 })
			.withMessage("Password must be at least 8 characters"),
	],
	validateRequest,
	resetPassword,
);

// 2FA
const { authenticate } = require("../middlewares/authorizationMiddleware");
const { setup2FA, verify2FA, get2FAStatus, disable2FA, check2FAByEmail, resetPasswordWith2FA } = require("../controllers/auth/twoFactor");

// Public 2FA endpoints
Router.post("/verify-login-2fa", verifyLogin2FA);
Router.post("/check-2fa-enabled", check2FAByEmail);
Router.post(
	"/reset-password-2fa",
	[
		body("email").notEmpty().isEmail().normalizeEmail({ gmail_remove_dots: false }),
		body("code").notEmpty().isLength({ min: 6, max: 6 }),
		body("newPassword").notEmpty().isLength({ min: 8 }),
	],
	validateRequest,
	resetPasswordWith2FA,
);

// Authenticated 2FA endpoints
Router.post("/setup-2fa", authenticate, setup2FA);
Router.post("/verify-2fa", authenticate, verify2FA);
Router.get("/2fa-status", authenticate, get2FAStatus);
Router.post("/disable-2fa", authenticate, disable2FA);

module.exports = Router;
