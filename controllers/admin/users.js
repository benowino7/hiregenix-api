const { prisma } = require("../../prisma");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const getUsers = async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
		const skip = (page - 1) * limit;
		const role = req.query.role || "";
		const search = (req.query.search || "").trim();
		const status = req.query.status || ""; // "active", "suspended", "pending"

		// Build where clause
		const where = {};

		// Role filter via subquery
		if (role) {
			const roles = await prisma.userRole.findMany({
				where: { role, isActive: true },
				select: { userId: true },
			});
			const userIdsWithRole = roles.map((r) => r.userId);
			if (userIdsWithRole.length === 0) {
				return res.status(200).json({
					status: "SUCCESS",
					data: [],
					meta: { total: 0, page, limit, totalPages: 0 },
				});
			}
			where.id = { in: userIdsWithRole };
		}

		// Search filter (server-side)
		if (search) {
			where.OR = [
				{ firstName: { contains: search, mode: "insensitive" } },
				{ lastName: { contains: search, mode: "insensitive" } },
				{ email: { contains: search, mode: "insensitive" } },
				{ phoneNumber: { contains: search } },
			];
		}

		// Status filter
		if (status === "suspended") {
			where.isActive = false;
		} else if (status === "active") {
			where.isActive = true;
		}
		// "pending" handled after fetch via recruiterProfile

		// For pending filter, get pending recruiter user ids
		if (status === "pending") {
			const pendingRecruiters = await prisma.recruiterProfile.findMany({
				where: { status: "PENDING" },
				select: { userId: true },
			});
			const pendingIds = pendingRecruiters.map((r) => r.userId);
			if (pendingIds.length === 0) {
				return res.status(200).json({
					status: "SUCCESS",
					data: [],
					meta: { total: 0, page, limit, totalPages: 0 },
				});
			}
			where.id = where.id ? { in: where.id.in.filter((id) => pendingIds.includes(id)) } : { in: pendingIds };
		}

		const [users, total] = await Promise.all([
			prisma.user.findMany({
				where,
				skip,
				take: limit,
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					firstName: true,
					lastName: true,
					email: true,
					isActive: true,
					countryCode: true,
					phoneNumber: true,
					createdAt: true,
					roles: {
						where: { isActive: true },
						select: { role: true },
					},
					recruiterProfile: {
						select: {
							id: true,
							companyId: true,
							isApproved: true,
							recruiterRoles: true,
							company: {
								select: {
									id: true,
									name: true,
									website: true,
									address: true,
									country: true,
									isVerified: true,
								},
							},
							status: true,
							statusLogs: {
								select: {
									oldStatus: true,
									newStatus: true,
									reason: true,
									createdAt: true,
								},
								orderBy: { createdAt: "desc" },
								take: 5,
							},
							createdAt: true,
						},
					},
					jobSeekerProfile: {
						select: {
							id: true,
							createdAt: true,
						},
					},
					adminProfile: {
						select: {
							id: true,
							createdAt: true,
						},
					},
				},
			}),
			prisma.user.count({ where }),
		]);

		const formattedUsers = users.map((u) => ({
			...u,
			roles: u.roles.map((r) => r.role),
		}));

		const totalPages = Math.ceil(total / limit);
		return res.status(200).json({
			status: "SUCCESS",
			data: formattedUsers,
			meta: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
		});
	} catch (error) {
		console.error("Get users error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to fetch users" });
	}
};

/**
 * GET /api/admin/users/stats
 */
const getUserStats = async (req, res) => {
	try {
		const [total, jobSeekers, recruiters, pendingRecruiters, activeRecruiters, suspended] = await Promise.all([
			prisma.user.count(),
			prisma.userRole.count({ where: { role: "JOB_SEEKER", isActive: true } }),
			prisma.userRole.count({ where: { role: "RECRUITER", isActive: true } }),
			prisma.recruiterProfile.count({ where: { status: "PENDING" } }),
			prisma.recruiterProfile.count({ where: { status: "ACTIVE" } }),
			prisma.user.count({ where: { isActive: false } }),
		]);

		return res.json({
			status: "SUCCESS",
			data: { total, jobSeekers, recruiters, pendingRecruiters, activeRecruiters, suspended },
		});
	} catch (error) {
		console.error("User stats error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * PATCH /api/admin/users/:id
 * Update user name and email
 */
const updateUser = async (req, res) => {
	try {
		const { id } = req.params;
		const { firstName, lastName, email } = req.body;

		const existing = await prisma.user.findUnique({ where: { id } });
		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "User not found" });
		}

		// Check email uniqueness if changed
		if (email && email !== existing.email) {
			const emailExists = await prisma.user.findFirst({ where: { email, id: { not: id } } });
			if (emailExists) {
				return res.status(409).json({ status: "FAIL", message: "Email already in use by another user" });
			}
		}

		const data = {};
		if (firstName !== undefined) data.firstName = firstName;
		if (lastName !== undefined) data.lastName = lastName;
		if (email !== undefined) data.email = email;

		if (Object.keys(data).length === 0) {
			return res.status(400).json({ status: "FAIL", message: "No fields to update" });
		}

		const updated = await prisma.user.update({
			where: { id },
			data,
			select: { id: true, firstName: true, lastName: true, email: true },
		});

		return res.json({ status: "SUCCESS", message: "User updated", data: updated });
	} catch (error) {
		console.error("Update user error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * DELETE /api/admin/users/:id
 * Hard-delete a user and all related data
 */
const deleteUser = async (req, res) => {
	try {
		const { id } = req.params;

		const existing = await prisma.user.findUnique({
			where: { id },
			include: { roles: { select: { role: true } } },
		});
		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "User not found" });
		}

		// Prevent deleting admin users
		const isAdmin = existing.roles.some((r) => r.role === "ADMIN");
		if (isAdmin) {
			return res.status(403).json({ status: "FAIL", message: "Cannot delete admin users" });
		}

		// Prevent self-delete
		if (id === req.user.userId) {
			return res.status(400).json({ status: "FAIL", message: "Cannot delete your own account" });
		}

		// Delete in order to respect foreign keys
		// Job seeker related
		const jobSeekerProfile = await prisma.jobSeeker.findUnique({ where: { userId: id } });
		if (jobSeekerProfile) {
			await prisma.jobApplicationStatusLog.deleteMany({ where: { jobApplication: { jobSeekerId: jobSeekerProfile.id } } });
			await prisma.jobApplication.deleteMany({ where: { jobSeekerId: jobSeekerProfile.id } });
			await prisma.savedJob.deleteMany({ where: { jobSeekerId: jobSeekerProfile.id } });
			await prisma.jobSeekerSkill.deleteMany({ where: { jobSeekerId: jobSeekerProfile.id } });
			await prisma.jobSeekerCV.deleteMany({ where: { jobSeekerId: jobSeekerProfile.id } });
			await prisma.jobSeeker.delete({ where: { userId: id } });
		}

		// Recruiter related
		const recruiterProfile = await prisma.recruiterProfile.findUnique({ where: { userId: id } });
		if (recruiterProfile) {
			// Delete jobs created by this recruiter
			const recruiterJobs = await prisma.job.findMany({ where: { recruiterProfileId: recruiterProfile.id }, select: { id: true } });
			for (const job of recruiterJobs) {
				await prisma.jobApplicationStatusLog.deleteMany({ where: { jobApplication: { jobId: job.id } } });
				await prisma.jobApplication.deleteMany({ where: { jobId: job.id } });
				await prisma.jobIndustry.deleteMany({ where: { jobId: job.id } });
				await prisma.jobSkill.deleteMany({ where: { jobId: job.id } });
				await prisma.savedJob.deleteMany({ where: { jobId: job.id } });
				await prisma.aIRankingCache.deleteMany({ where: { jobId: job.id } });
			}
			await prisma.job.deleteMany({ where: { recruiterProfileId: recruiterProfile.id } });
			await prisma.recruiterStatusLog.deleteMany({ where: { recruiterId: recruiterProfile.id } });
			await prisma.recruiterProfile.delete({ where: { userId: id } });
		}

		// Admin profile
		await prisma.adminProfile.deleteMany({ where: { userId: id } });

		// User roles, sessions, tokens
		await prisma.userRole.deleteMany({ where: { userId: id } });
		await prisma.refreshToken.deleteMany({ where: { userId: id } });

		// Delete the user
		await prisma.user.delete({ where: { id } });

		return res.json({ status: "SUCCESS", message: "User deleted" });
	} catch (error) {
		console.error("Delete user error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * Approve a recruiter (Admin only)
 */
const approveRecruiter = async (req, res) => {
	try {
		// const adminId = req.user.userId; // Admin performing the action
		const { recruiterId, reason } = req.body;

		if (!recruiterId) {
			return res.status(400).json({
				status: "FAIL",
				message: "Recruiter ID is required",
			});
		}

		// 1️⃣ Fetch recruiter
		const recruiter = await prisma.recruiterProfile.findUnique({
			where: { id: recruiterId },
		});

		if (!recruiter) {
			return res.status(404).json({
				status: "FAIL",
				message: "Recruiter not found",
			});
		}

		if (recruiter.isApproved) {
			return res.status(400).json({
				status: "FAIL",
				message: "Recruiter is already approved",
			});
		}

		// 2️⃣ Transaction: update profile + create status log
		const updatedRecruiter = await prisma.$transaction(async (tx) => {
			// Update recruiter
			const updated = await tx.recruiterProfile.update({
				where: { id: recruiterId },
				data: {
					isApproved: true,
					status: "ACTIVE",
				},
			});

			// Verify company
			await tx.company.update({
				where: { id: recruiter.companyId },
				data: {
					isVerified: true,
				},
			});

			// Create status log
			await tx.recruiterStatusLog.create({
				data: {
					recruiterId,
					oldStatus: recruiter.status,
					newStatus: "ACTIVE",
					//   changedById: adminId,
					reason: reason || "Approved by admin",
				},
			});

			return updated;
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Recruiter approved successfully",
			data: updatedRecruiter,
		});
	} catch (error) {
		console.error("Approve recruiter error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

const getCompanies = async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 100);

		// optional filters (safe defaults)
		const search = (req.query.search || "").trim();
		const isVerified = req.query.isVerified === undefined ? undefined : req.query.isVerified === "true";
		const industry = (req.query.industry || "").trim();

		const where = {
			// Only show companies that have at least one published job
			jobs: { some: { status: "PUBLISHED" } },
		};

		if (search) {
			where.OR = [
				{ name: { contains: search, mode: "insensitive" } },
				{ registrationNumber: { contains: search, mode: "insensitive" } },
				{ industries: { some: { industry: { name: { contains: search, mode: "insensitive" } } } } },
			];
		}

		if (isVerified !== undefined) {
			where.isVerified = isVerified;
		}

		if (industry) {
			where.industries = {
				some: { industry: { name: { contains: industry, mode: "insensitive" } } },
			};
		}

		// Fetch all matching companies then sort by published job count
		const [total, allCompanies] = await Promise.all([
			prisma.company.count({ where }),
			prisma.company.findMany({
				where,
				include: {
					industries: {
						select: {
							industry: {
								select: { id: true, name: true },
							},
						},
					},
					_count: {
						select: {
							jobs: { where: { status: "PUBLISHED" } },
						},
					},
					jobs: {
						where: { status: "PUBLISHED" },
						select: {
							vacancies: true,
							recruiterProfile: {
								select: {
									company: { select: { id: true, name: true } },
								},
							},
						},
					},
				},
			}),
		]);

		// Compute total vacancies and distinct recruiter companies per company
		for (const company of allCompanies) {
			company.totalVacancies = (company.jobs || []).reduce((sum, j) => sum + (j.vacancies || 1), 0);
			// Get unique recruiter companies (agencies posting jobs for this company)
			const recruiterMap = new Map();
			for (const job of company.jobs || []) {
				const rc = job.recruiterProfile?.company;
				if (rc && rc.id !== company.id) {
					recruiterMap.set(rc.id, rc.name);
				}
			}
			company.recruiterCompanies = Array.from(recruiterMap, ([id, name]) => ({ id, name }));
			delete company.jobs;
		}

		// Sort by published job count descending
		allCompanies.sort((a, b) => (b._count?.jobs || 0) - (a._count?.jobs || 0));

		// Manual pagination after sorting
		const skip = (page - 1) * limit;
		const companies = allCompanies.slice(skip, skip + limit);
		const totalPages = Math.ceil(total / limit);

		return res.status(200).json({
			status: "SUCCESS",
			message: "Companies retrieved successfully",
			result: {
				pagination: {
					page,
					limit,
					total,
					totalPages,
					hasNext: page < totalPages,
					hasPrev: page > 1,
				},
				data: companies,
			},
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({
			status: "FAIL",
			message: "Failed to retrieve companies",
			error: error.message,
		});
	}
};

/**
 * GET /public/companies/:id — Get single company details
 */
const getCompanyById = async (req, res) => {
	try {
		const { id } = req.params;

		const company = await prisma.company.findUnique({
			where: { id },
			include: {
				industries: {
					select: {
						industry: { select: { id: true, name: true, slug: true } },
					},
				},
				_count: {
					select: {
						jobs: { where: { status: "PUBLISHED" } },
					},
				},
			},
		});

		if (!company) {
			return res.status(404).json({ status: "FAIL", message: "Company not found" });
		}

		return res.status(200).json({ status: "SUCCESS", data: company });
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to retrieve company" });
	}
};

/**
 * GET /public/companies/:id/jobs — Get paginated jobs for a company
 */
const getCompanyJobs = async (req, res) => {
	try {
		const { id } = req.params;
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
		const skip = (page - 1) * limit;
		const industryName = (req.query.industry || "").trim();

		const where = {
			companyId: id,
			status: "PUBLISHED",
		};

		if (industryName) {
			where.industries = {
				some: { industry: { name: { contains: industryName, mode: "insensitive" } } },
			};
		}

		const [total, jobs] = await Promise.all([
			prisma.job.count({ where }),
			prisma.job.findMany({
				where,
				orderBy: { publishedAt: "desc" },
				skip,
				take: limit,
				include: {
					industries: {
						include: { industry: { select: { id: true, name: true, slug: true } } },
					},
					skills: {
						include: { skill: { select: { id: true, name: true } } },
					},
					_count: { select: { jobApplications: true } },
				},
			}),
		]);

		const totalPages = Math.ceil(total / limit);

		return res.status(200).json({
			status: "SUCCESS",
			data: jobs,
			meta: { total, page, limit, totalPages },
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({ status: "FAIL", message: "Failed to retrieve company jobs" });
	}
};

/**
 * Reject a recruiter (Admin only)
 * POST /admin/recruiter/reject
 */
const rejectRecruiter = async (req, res) => {
	try {
		const { recruiterId, reason } = req.body;

		if (!recruiterId) {
			return res.status(400).json({
				status: "FAIL",
				message: "Recruiter ID is required",
			});
		}

		const recruiter = await prisma.recruiterProfile.findUnique({
			where: { id: recruiterId },
		});

		if (!recruiter) {
			return res.status(404).json({
				status: "FAIL",
				message: "Recruiter not found",
			});
		}

		if (recruiter.status === "DEACTIVATED") {
			return res.status(400).json({
				status: "FAIL",
				message: "Recruiter is already deactivated",
			});
		}

		const updatedRecruiter = await prisma.$transaction(async (tx) => {
			const updated = await tx.recruiterProfile.update({
				where: { id: recruiterId },
				data: {
					isApproved: false,
					status: "DEACTIVATED",
				},
			});

			await tx.recruiterStatusLog.create({
				data: {
					recruiterId,
					oldStatus: recruiter.status,
					newStatus: "DEACTIVATED",
					reason: reason || "Rejected by admin",
				},
			});

			return updated;
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Recruiter rejected successfully",
			data: updatedRecruiter,
		});
	} catch (error) {
		console.error("Reject recruiter error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Update user active status (suspend/reactivate)
 * PATCH /admin/users/:id/status
 */
const updateUserStatus = async (req, res) => {
	try {
		const userId = req.params.id;
		const { isActive } = req.body;

		if (typeof isActive !== "boolean") {
			return res.status(400).json({
				status: "FAIL",
				message: "isActive (boolean) is required",
			});
		}

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, isActive: true, firstName: true, lastName: true },
		});

		if (!user) {
			return res.status(404).json({
				status: "FAIL",
				message: "User not found",
			});
		}

		if (user.isActive === isActive) {
			return res.status(400).json({
				status: "FAIL",
				message: `User is already ${isActive ? "active" : "suspended"}`,
			});
		}

		// Prevent admin from deactivating themselves
		if (userId === req.user.userId && !isActive) {
			return res.status(400).json({
				status: "FAIL",
				message: "You cannot deactivate your own account",
			});
		}

		const updatedUser = await prisma.user.update({
			where: { id: userId },
			data: { isActive },
			select: {
				id: true,
				firstName: true,
				lastName: true,
				email: true,
				isActive: true,
			},
		});

		const action = isActive ? "reactivated" : "suspended";

		return res.status(200).json({
			status: "SUCCESS",
			message: `User ${action} successfully`,
			data: updatedUser,
		});
	} catch (error) {
		console.error("Update user status error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Get or create the "Career Box" system company used by admin-posted jobs
 */
const getOrCreateCareerBox = async (tx) => {
	const REG_NUMBER = "CAREERBOX-SYSTEM-001";
	let company = await tx.company.findUnique({
		where: { registrationNumber: REG_NUMBER },
	});
	if (!company) {
		company = await tx.company.create({
			data: {
				name: "Career Box",
				registrationNumber: REG_NUMBER,
				website: "https://hiregenix.io",
				address: "Dubai, United Arab Emirates",
				country: "UAE",
				isVerified: true,
			},
		});
	}
	return company;
};

/**
 * Admin creates a new user (JOB_SEEKER or RECRUITER)
 * Returns the plain-text password so admin can copy it
 */
const createUser = async (req, res) => {
	try {
		const { firstName, lastName, email, phoneNumber, countryCode, role } = req.body;

		if (!firstName || !lastName || !email || !phoneNumber || !countryCode || !role) {
			return res.status(400).json({ status: "FAIL", message: "All fields are required" });
		}

		const allowedRoles = ["JOB_SEEKER", "RECRUITER"];
		if (!allowedRoles.includes(role)) {
			return res.status(400).json({ status: "FAIL", message: "Role must be JOB_SEEKER or RECRUITER" });
		}

		const existingEmail = await prisma.user.findUnique({ where: { email } });
		if (existingEmail) {
			return res.status(409).json({ status: "FAIL", message: "Email already in use" });
		}

		const existingPhone = await prisma.user.findFirst({ where: { phoneNumber, countryCode } });
		if (existingPhone) {
			return res.status(409).json({ status: "FAIL", message: "Phone number already in use" });
		}

		// Generate a random 12-char password
		const plainPassword = crypto.randomBytes(6).toString("base64url");
		const hashedPassword = await bcrypt.hash(plainPassword, 12);

		const result = await prisma.$transaction(async (tx) => {
			const user = await tx.user.create({
				data: {
					firstName,
					lastName,
					email,
					phoneNumber,
					countryCode,
					password: hashedPassword,
				},
			});

			await tx.userRole.create({
				data: { userId: user.id, role },
			});

			if (role === "JOB_SEEKER") {
				await tx.jobSeeker.create({ data: { userId: user.id } });
			}

			if (role === "RECRUITER") {
				const company = await getOrCreateCareerBox(tx);
				const recruiterProfile = await tx.recruiterProfile.create({
					data: {
						userId: user.id,
						companyId: company.id,
						isApproved: true,
						status: "ACTIVE",
					},
				});
				await tx.recruiterStatusLog.create({
					data: {
						recruiterId: recruiterProfile.id,
						oldStatus: "PENDING",
						newStatus: "ACTIVE",
						reason: "Created by admin",
					},
				});
			}

			return user;
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "User created successfully",
			data: {
				id: result.id,
				firstName: result.firstName,
				lastName: result.lastName,
				email: result.email,
				phoneNumber: result.phoneNumber,
				countryCode: result.countryCode,
				role,
				plainPassword,
			},
		});
	} catch (error) {
		console.error("Create user error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to create user" });
	}
};

module.exports = {
	getUsers,
	getUserStats,
	updateUser,
	deleteUser,
	approveRecruiter,
	rejectRecruiter,
	updateUserStatus,
	getCompanies,
	getCompanyById,
	getCompanyJobs,
	createUser,
	getOrCreateCareerBox,
};
