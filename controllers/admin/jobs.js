const { prisma } = require("../../prisma");
const { getOrCreateCareerBox } = require("./users");

/**
 * GET /api/admin/jobs
 * List all jobs with pagination, filters, search, ordered by applicant count desc.
 *
 * Query params:
 *   page, limit, search, status, industryId, recruiterId, source
 */
const getAdminJobs = async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
		const skip = (page - 1) * limit;
		const search = (req.query.search || "").trim();
		const status = req.query.status || "";
		const industryId = req.query.industryId || "";
		const recruiterId = req.query.recruiterId || "";
		const source = req.query.source || "";

		// Build where clause
		const where = {};

		if (search) {
			where.OR = [
				{ title: { contains: search, mode: "insensitive" } },
				{ company: { name: { contains: search, mode: "insensitive" } } },
			];
		}
		if (status) where.status = status;
		if (source) where.source = source;
		if (recruiterId) where.recruiterProfileId = recruiterId;
		if (industryId) {
			where.industries = { some: { industryId } };
		}

		const [jobs, total] = await Promise.all([
			prisma.job.findMany({
				where,
				select: {
					id: true,
					title: true,
					status: true,
					employmentType: true,
					locationName: true,
					isRemote: true,
					minSalary: true,
					maxSalary: true,
					currency: true,
					showSalary: true,
					vacancies: true,
					maxApplicants: true,
					source: true,
					createdAt: true,
					publishedAt: true,
					company: {
						select: { id: true, name: true },
					},
					recruiterProfile: {
						select: {
							id: true,
							user: { select: { id: true, firstName: true, lastName: true, email: true } },
						},
					},
					_count: {
						select: {
							jobApplications: true,
							saves: true,
						},
					},
					industries: {
						select: {
							industry: { select: { id: true, name: true } },
						},
						take: 3,
					},
				},
				orderBy: [
					{ jobApplications: { _count: "desc" } },
					{ createdAt: "desc" },
				],
				skip,
				take: limit,
			}),
			prisma.job.count({ where }),
		]);

		// Flatten industry names
		const formatted = jobs.map((j) => ({
			...j,
			industries: j.industries.map((ji) => ji.industry),
			recruiter: j.recruiterProfile
				? {
						id: j.recruiterProfile.id,
						name: `${j.recruiterProfile.user.firstName || ""} ${j.recruiterProfile.user.lastName || ""}`.trim(),
						email: j.recruiterProfile.user.email,
					}
				: null,
			recruiterProfile: undefined,
		}));

		const totalPages = Math.ceil(total / limit);
		return res.json({
			status: "SUCCESS",
			data: formatted,
			meta: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
		});
	} catch (error) {
		console.error("Admin getJobs error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * GET /api/admin/jobs/stats
 * Quick stats for the dashboard cards.
 */
const getAdminJobStats = async (req, res) => {
	try {
		const [total, published, draft, closed, suspended, totalApplications] = await Promise.all([
			prisma.job.count(),
			prisma.job.count({ where: { status: "PUBLISHED" } }),
			prisma.job.count({ where: { status: "DRAFT" } }),
			prisma.job.count({ where: { status: "CLOSED" } }),
			prisma.job.count({ where: { status: "SUSPENDED" } }),
			prisma.jobApplication.count(),
		]);

		return res.json({
			status: "SUCCESS",
			data: { total, published, draft, closed, suspended, totalApplications },
		});
	} catch (error) {
		console.error("Admin job stats error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * GET /api/admin/jobs/recruiters
 * List recruiters for filter dropdown (id + name + email).
 */
const getRecruitersForFilter = async (req, res) => {
	try {
		const search = (req.query.search || "").trim();
		const where = { isApproved: true };
		if (search) {
			where.user = {
				OR: [
					{ firstName: { contains: search, mode: "insensitive" } },
					{ lastName: { contains: search, mode: "insensitive" } },
					{ email: { contains: search, mode: "insensitive" } },
				],
			};
		}

		const recruiters = await prisma.recruiterProfile.findMany({
			where,
			select: {
				id: true,
				user: { select: { firstName: true, lastName: true, email: true } },
				company: { select: { name: true } },
			},
			orderBy: { user: { firstName: "asc" } },
			take: 50,
		});

		const formatted = recruiters.map((r) => ({
			id: r.id,
			name: `${r.user.firstName || ""} ${r.user.lastName || ""}`.trim(),
			email: r.user.email,
			company: r.company?.name || "",
		}));

		return res.json({ status: "SUCCESS", data: formatted });
	} catch (error) {
		console.error("Admin getRecruiters error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * GET /api/admin/jobs/:id
 * Full job details with applications summary.
 */
const getAdminJobById = async (req, res) => {
	try {
		const { id } = req.params;
		const job = await prisma.job.findUnique({
			where: { id },
			include: {
				company: { select: { id: true, name: true } },
				recruiterProfile: {
					select: {
						id: true,
						user: { select: { firstName: true, lastName: true, email: true } },
					},
				},
				industries: { include: { industry: true } },
				skills: { include: { skill: true } },
				_count: { select: { jobApplications: true, saves: true } },
			},
		});

		if (!job) {
			return res.status(404).json({ status: "FAIL", message: "Job not found" });
		}

		// Application status breakdown
		const appStats = await prisma.jobApplication.groupBy({
			by: ["status"],
			where: { jobId: id },
			_count: true,
		});
		const applicationBreakdown = {};
		for (const s of appStats) {
			applicationBreakdown[s.status] = s._count;
		}

		return res.json({
			status: "SUCCESS",
			data: {
				...job,
				industries: job.industries.map((ji) => ji.industry),
				skills: job.skills.map((js) => js.skill),
				recruiter: job.recruiterProfile
					? {
							id: job.recruiterProfile.id,
							name: `${job.recruiterProfile.user.firstName || ""} ${job.recruiterProfile.user.lastName || ""}`.trim(),
							email: job.recruiterProfile.user.email,
						}
					: null,
				applicationBreakdown,
			},
		});
	} catch (error) {
		console.error("Admin getJobById error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * PATCH /api/admin/jobs/:id
 * Update job fields (title, description, status, employmentType, etc).
 */
const updateAdminJob = async (req, res) => {
	try {
		const { id } = req.params;
		const { title, description, status, employmentType, locationName, isRemote, minSalary, maxSalary, currency, showSalary, vacancies, maxApplicants } = req.body;

		const existing = await prisma.job.findUnique({ where: { id } });
		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "Job not found" });
		}

		const data = {};
		if (title !== undefined) data.title = title;
		if (description !== undefined) data.description = description;
		if (status !== undefined) {
			data.status = status;
			if (status === "PUBLISHED" && !existing.publishedAt) {
				data.publishedAt = new Date();
			}
		}
		if (employmentType !== undefined) data.employmentType = employmentType;
		if (locationName !== undefined) data.locationName = locationName;
		if (isRemote !== undefined) data.isRemote = isRemote;
		if (minSalary !== undefined) data.minSalary = minSalary;
		if (maxSalary !== undefined) data.maxSalary = maxSalary;
		if (currency !== undefined) data.currency = currency;
		if (showSalary !== undefined) data.showSalary = showSalary;
		if (vacancies !== undefined) data.vacancies = vacancies;
		if (maxApplicants !== undefined) data.maxApplicants = maxApplicants;

		if (Object.keys(data).length === 0) {
			return res.status(400).json({ status: "FAIL", message: "No fields to update" });
		}

		const updated = await prisma.job.update({
			where: { id },
			data,
			include: {
				company: { select: { id: true, name: true } },
				_count: { select: { jobApplications: true } },
			},
		});

		return res.json({ status: "SUCCESS", message: "Job updated", data: updated });
	} catch (error) {
		console.error("Admin updateJob error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * DELETE /api/admin/jobs/:id
 * Hard-delete a job and all related records.
 */
const deleteAdminJob = async (req, res) => {
	try {
		const { id } = req.params;
		const existing = await prisma.job.findUnique({ where: { id } });
		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "Job not found" });
		}

		// Delete related records first
		await prisma.$transaction([
			prisma.jobApplicationStatusLog.deleteMany({ where: { jobApplication: { jobId: id } } }),
			prisma.jobApplication.deleteMany({ where: { jobId: id } }),
			prisma.jobIndustry.deleteMany({ where: { jobId: id } }),
			prisma.jobSkill.deleteMany({ where: { jobId: id } }),
			prisma.savedJob.deleteMany({ where: { jobId: id } }),
			prisma.aIRankingCache.deleteMany({ where: { jobId: id } }),
			prisma.job.delete({ where: { id } }),
		]);

		return res.json({ status: "SUCCESS", message: "Job deleted" });
	} catch (error) {
		console.error("Admin deleteJob error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * GET /api/admin/jobs/:id/applications
 * Paginated list of applications for a specific job.
 */
const getJobApplications = async (req, res) => {
	try {
		const { id } = req.params;
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);
		const skip = (page - 1) * limit;
		const statusFilter = req.query.status || "";

		const where = { jobId: id };
		if (statusFilter) where.status = statusFilter;

		const [applications, total] = await Promise.all([
			prisma.jobApplication.findMany({
				where,
				select: {
					id: true,
					status: true,
					coverLetter: true,
					createdAt: true,
					updatedAt: true,
					jobSeeker: {
						select: {
							id: true,
							user: { select: { firstName: true, lastName: true, email: true, avatar: true } },
						},
					},
				},
				orderBy: { createdAt: "desc" },
				skip,
				take: limit,
			}),
			prisma.jobApplication.count({ where }),
		]);

		const totalPages = Math.ceil(total / limit);
		return res.json({
			status: "SUCCESS",
			data: applications.map((a) => ({
				...a,
				applicant: a.jobSeeker
					? {
							id: a.jobSeeker.id,
							name: `${a.jobSeeker.user.firstName || ""} ${a.jobSeeker.user.lastName || ""}`.trim(),
							email: a.jobSeeker.user.email,
							avatar: a.jobSeeker.user.avatar,
						}
					: null,
				jobSeeker: undefined,
			})),
			meta: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
		});
	} catch (error) {
		console.error("Admin getJobApplications error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * DELETE /api/admin/jobs/closed
 * Delete ALL closed jobs and their related records.
 * Returns count of deleted jobs.
 */
const deleteAllClosedJobs = async (req, res) => {
	try {
		// Archive all closed jobs (set status to ARCHIVED instead of deleting)
		const result = await prisma.job.updateMany({
			where: { status: "CLOSED" },
			data: { status: "ARCHIVED" },
		});

		if (result.count === 0) {
			return res.json({ status: "SUCCESS", message: "No closed jobs to archive", data: { archivedCount: 0 } });
		}

		return res.json({
			status: "SUCCESS",
			message: `${result.count} closed job(s) archived`,
			data: { archivedCount: result.count },
		});
	} catch (error) {
		console.error("Admin archiveAllClosedJobs error:", error);
		return res.status(500).json({ status: "ERROR", message: "Something went wrong" });
	}
};

/**
 * Get the admin's recruiter profile (tied to Career Box company).
 * Creates one if it doesn't exist yet.
 */
const getAdminRecruiterProfile = async (tx, userId) => {
	let profile = await tx.recruiterProfile.findUnique({ where: { userId } });
	if (!profile) {
		const company = await getOrCreateCareerBox(tx);

		const existingRole = await tx.userRole.findUnique({
			where: { userId_role: { userId, role: "RECRUITER" } },
		});
		if (!existingRole) {
			await tx.userRole.create({ data: { userId, role: "RECRUITER" } });
		} else if (!existingRole.isActive) {
			await tx.userRole.update({
				where: { userId_role: { userId, role: "RECRUITER" } },
				data: { isActive: true },
			});
		}

		profile = await tx.recruiterProfile.create({
			data: {
				userId,
				companyId: company.id,
				isApproved: true,
				status: "ACTIVE",
			},
		});
	}
	return profile;
};

/**
 * Create a job as admin (tied to Career Box company)
 */
const createAdminJob = async (req, res) => {
	try {
		const userId = req.user.userId;
		const {
			title,
			description,
			vacancies = 1,
			maxApplicants = null,
			employmentType,
			experienceLevel,
			locationName,
			latitude,
			longitude,
			isRemote = false,
			minSalary,
			maxSalary,
			currency,
			showSalary = false,
			industries = [],
			skills = [],
		} = req.body;

		if (!title || !description || !employmentType) {
			return res.status(400).json({
				status: "FAIL",
				message: "Title, description, and employment type are required",
			});
		}

		// Duplicate check: same title + Career Box company
		const careerBox = await prisma.$transaction(async (tx) => getOrCreateCareerBox(tx));
		const existing = await prisma.job.findFirst({
			where: {
				title: { equals: title, mode: "insensitive" },
				companyId: careerBox.id,
				status: { not: "CLOSED" },
			},
		});
		if (existing) {
			return res.status(409).json({
				status: "FAIL",
				message: `A job with title "${title}" already exists under Career Box (ID: ${existing.id})`,
			});
		}

		// Validate industries
		if (industries.length > 0) {
			const valid = await prisma.industry.findMany({
				where: { id: { in: industries } },
				select: { id: true },
			});
			if (valid.length !== industries.length) {
				return res.status(400).json({ status: "FAIL", message: "One or more industries do not exist" });
			}
		}

		// Validate skills
		if (skills.length > 0) {
			const valid = await prisma.skill.findMany({
				where: { id: { in: skills } },
				select: { id: true },
			});
			if (valid.length !== skills.length) {
				return res.status(400).json({ status: "FAIL", message: "One or more skills do not exist" });
			}
		}

		const job = await prisma.$transaction(async (tx) => {
			const profile = await getAdminRecruiterProfile(tx, userId);

			return tx.job.create({
				data: {
					title,
					description,
					vacancies,
					maxApplicants: maxApplicants ?? null,
					employmentType,
					experienceLevel,
					locationName: isRemote ? null : locationName,
					latitude: isRemote ? null : latitude,
					longitude: isRemote ? null : longitude,
					isRemote,
					minSalary,
					maxSalary,
					currency,
					showSalary,
					status: "PUBLISHED",
					publishedAt: new Date(),
					companyId: profile.companyId,
					recruiterProfileId: profile.id,
					industries: {
						create: industries.map((industryId) => ({ industryId })),
					},
					skills: {
						create: skills.map((skillId) => ({ skillId })),
					},
				},
				include: {
					industries: { include: { industry: { select: { name: true } } } },
					skills: { include: { skill: { select: { name: true } } } },
				},
			});
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Job created and published",
			data: job,
		});
	} catch (error) {
		console.error("Create admin job error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to create job" });
	}
};

/**
 * AI PDF Upload - extract job details from a PDF using Claude
 */
const parseJobPdf = async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({ status: "FAIL", message: "PDF file is required" });
		}

		const pdfParse = require("pdf-parse");
		const pdfData = await pdfParse(req.file.buffer);
		const extractedText = pdfData.text;

		if (!extractedText || extractedText.trim().length < 20) {
			return res.status(400).json({ status: "FAIL", message: "Could not extract meaningful text from PDF" });
		}

		const Anthropic = require("@anthropic-ai/sdk");
		const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

		const response = await client.messages.create({
			model: "claude-sonnet-4-20250514",
			max_tokens: 2000,
			messages: [
				{
					role: "user",
					content: `Extract job posting details from this text and return a JSON object with these fields:
- title (string): The job title
- description (string): Full job description
- employmentType (string): One of FULL_TIME, PART_TIME, CONTRACT, INTERNSHIP, TEMPORARY
- experienceLevel (string): e.g. "Junior", "Mid-Level", "Senior", "Entry-Level"
- locationName (string): Job location or null if remote
- isRemote (boolean): Whether the job is remote
- minSalary (number or null): Minimum salary
- maxSalary (number or null): Maximum salary
- currency (string): Currency code like "USD", "AED", "KES"
- vacancies (number): Number of positions, default 1
- skillNames (string[]): List of required skill names
- industryNames (string[]): List of relevant industry names

Return ONLY valid JSON, no markdown or explanation.

Text:
${extractedText.substring(0, 8000)}`,
				},
			],
		});

		const content = response.content[0].text;
		let parsed;
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
		} catch {
			return res.status(422).json({
				status: "FAIL",
				message: "Failed to parse AI response",
				rawText: extractedText.substring(0, 2000),
			});
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: "Job details extracted from PDF",
			data: parsed,
		});
	} catch (error) {
		console.error("Parse job PDF error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to parse job PDF" });
	}
};

module.exports = {
	getAdminJobs,
	getAdminJobStats,
	getRecruitersForFilter,
	getAdminJobById,
	updateAdminJob,
	deleteAdminJob,
	deleteAllClosedJobs,
	getJobApplications,
	createAdminJob,
	parseJobPdf,
};
