// src/services/auth.service.js
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma");
const COUNTRY_CODES = require("../countryCodes");

const register = async (req, res) => {
	try {
		const {
			firstName,
			middleName,
			lastName,
			email,
			phoneNumber,
			countryCode,
			password,
			role, // JOB_SEEKER | RECRUITER
			hasVisa,
			hasWorkPermit,
		} = req.body;

		// Country code validation
		if (!COUNTRY_CODES.includes(countryCode)) {
			return res.status(400).json({ status: "FAIL", message: "Invalid country code" });
		}

		// Role validation (public signup)
		const allowedRoles = ["JOB_SEEKER", "RECRUITER"];
		if (!allowedRoles.includes(role)) {
			return res.status(400).json({ status: "FAIL", message: "Invalid role" });
		}

		// Email uniqueness
		const existingEmail = await prisma.user.findUnique({ where: { email } });
		if (existingEmail) {
			return res.status(409).json({ status: "FAIL", message: "Email already in use" });
		}

		// Phone uniqueness
		const existingPhone = await prisma.user.findFirst({
			where: { phoneNumber, countryCode },
		});
		if (existingPhone) {
			return res.status(409).json({ status: "FAIL", message: "Phone number already in use" });
		}

		const hashedPassword = await bcrypt.hash(password, 12);

		const result = await prisma.$transaction(async (tx) => {
			// 1) Create user
			const createdUser = await tx.user.create({
				data: {
					firstName,
					middleName: middleName || null,
					lastName,
					email,
					phoneNumber,
					countryCode,
					password: hashedPassword,
					// isActive is default true in your schema; include if you want:
					// isActive: true,
				},
				select: {
					id: true,
					firstName: true,
					lastName: true,
					email: true,
					phoneNumber: true,
					countryCode: true,
					isActive: true,
				},
			});

			// 2) Ensure user is active (matches your profile-creation rule)
			if (!createdUser.isActive) {
				const err = new Error("User account is inactive");
				err.statusCode = 403;
				throw err;
			}

			// 3) Create selected role (JOB_SEEKER or RECRUITER)
			// If you have a compound unique like userId_role, use it.
			// Also handle isActive if your UserRole model has it.
			const existingRole = await tx.userRole.findUnique({
				where: {
					userId_role: {
						userId: createdUser.id,
						role,
					},
				},
			});

			if (!existingRole) {
				await tx.userRole.create({
					data: {
						userId: createdUser.id,
						role,
					},
				});
			} else if (existingRole.isActive === false) {
				await tx.userRole.update({
					where: {
						userId_role: {
							userId: createdUser.id,
							role,
						},
					},
					data: { isActive: true },
				});
			}

			// 4) If role is JOB_SEEKER: ensure profile does not exist, then create it
			let jobSeekerProfile = null;

			if (role === "JOB_SEEKER") {
				const existingProfile = await tx.jobSeeker.findUnique({
					where: { userId: createdUser.id },
					select: { id: true },
				});

				if (existingProfile) {
					const err = new Error("Job seeker profile already exists");
					err.statusCode = 409;
					throw err;
				}

				// Also ensure JOB_SEEKER role is present/active (exactly like your function)
				const jsRole = await tx.userRole.findUnique({
					where: {
						userId_role: {
							userId: createdUser.id,
							role: "JOB_SEEKER",
						},
					},
				});

				if (!jsRole) {
					await tx.userRole.create({
						data: {
							userId: createdUser.id,
							role: "JOB_SEEKER",
						},
					});
				} else if (jsRole.isActive === false) {
					await tx.userRole.update({
						where: {
							userId_role: {
								userId: createdUser.id,
								role: "JOB_SEEKER",
							},
						},
						data: { isActive: true },
					});
				}

				jobSeekerProfile = await tx.jobSeeker.create({
					data: {
						userId: createdUser.id,
						hasVisa: hasVisa === true || hasVisa === "true",
						hasWorkPermit: hasWorkPermit === true || hasWorkPermit === "true",
					},
					select: { id: true, userId: true, createdAt: true },
				});

				// No free trial — users must subscribe to at least Silver after registration
			}

			return { user: createdUser, jobSeekerProfile };
		});

		const token = jwt.sign({ userId: result.user.id, roles: [role] }, process.env.JWT_SECRET, { expiresIn: "7d" });

		return res.status(201).json({
			status: "SUCCESS",
			message: "Account created successfully",
			data: {
				id: result.user.id,
				firstName: result.user.firstName,
				lastName: result.user.lastName,
				email: result.user.email,
				phoneNumber: result.user.phoneNumber,
				countryCode: result.user.countryCode,
				roles: [role],
				jobSeekerProfile: result.jobSeekerProfile, // null if recruiter
				token,
			},
		});
	} catch (error) {
		console.error(error);

		return res.status(error.statusCode || 500).json({
			status: "FAIL",
			message: error.statusCode ? error.message : "Something went wrong",
		});
	}
};

module.exports = { register };
