// src/controllers/job.controller.js
const { prisma } = require("../../prisma");

const createDraftJob = async (req, res) => {
	try {
		const userId = req.user.userId;

		const {
			title,
			description,
			vacancies = 1,
			maxApplicants = null, // null = unlimited
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

		// ✅ 0️⃣ Validate vacancies & maxApplicants
		// vacancies must be a positive int
		if (!Number.isInteger(vacancies) || vacancies < 1) {
			return res.status(400).json({
				status: "FAIL",
				message: "vacancies must be an integer greater than or equal to 1",
			});
		}

		// maxApplicants can be null (unlimited) or a positive int
		if (maxApplicants !== null && maxApplicants !== undefined) {
			if (!Number.isInteger(maxApplicants) || maxApplicants < 1) {
				return res.status(400).json({
					status: "FAIL",
					message: "maxApplicants must be null (unlimited) or an integer greater than or equal to 1",
				});
			}

			// optional business rule: maxApplicants must be >= vacancies
			if (maxApplicants < vacancies) {
				return res.status(400).json({
					status: "FAIL",
					message: "maxApplicants cannot be less than vacancies",
				});
			}
		}

		// 1️⃣ Fetch recruiter profile
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
		});

		if (!recruiterProfile) {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter profile not found",
			});
		}

		// 2️⃣ Check recruiter approval & status
		if (!recruiterProfile.isApproved || recruiterProfile.status !== "ACTIVE") {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter is not approved to post jobs",
			});
		}

		// 3️⃣ Validate industries
		if (industries.length > 0) {
			const existingIndustries = await prisma.industry.findMany({
				where: { id: { in: industries } },
				select: { id: true },
			});

			if (existingIndustries.length !== industries.length) {
				const validIds = existingIndustries.map((i) => i.id);
				const invalidIds = industries.filter((id) => !validIds.includes(id));

				return res.status(400).json({
					status: "FAIL",
					message: "One or more industries do not exist",
					invalidIndustryIds: invalidIds,
				});
			}
		}

		// 4️⃣ Validate skills
		if (skills.length > 0) {
			const existingSkills = await prisma.skill.findMany({
				where: { id: { in: skills } },
				select: { id: true },
			});

			if (existingSkills.length !== skills.length) {
				const validIds = existingSkills.map((s) => s.id);
				const invalidIds = skills.filter((id) => !validIds.includes(id));

				return res.status(400).json({
					status: "FAIL",
					message: "One or more skills do not exist",
					invalidSkillIds: invalidIds,
				});
			}
		}

		// 5️⃣ Create job (DRAFT)
		const job = await prisma.$transaction(async (tx) => {
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

					status: "DRAFT",

					companyId: recruiterProfile.companyId,
					recruiterProfileId: recruiterProfile.id,

					industries: {
						create: industries.map((industryId) => ({
							industryId,
						})),
					},

					skills: {
						create: skills.map((skillId) => ({
							skillId,
						})),
					},
				},
			});
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Job created as draft",
			data: job,
		});
	} catch (error) {
		console.error("Create draft job error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to create job",
		});
	}
};

const updateDraftJob = async (req, res) => {
	try {
		const userId = req.user.userId;
		const jobId = req.params.id;

		const {
			title,
			description,
			vacancies,
			maxApplicants = null, // ✅ add this (null = unlimited)
			employmentType,
			experienceLevel,
			locationName,
			latitude,
			longitude,
			isRemote,
			minSalary,
			maxSalary,
			currency,
			showSalary,
			industries = [],
			skills = [],
		} = req.body;

		// ✅ 0️⃣ Validate vacancies & maxApplicants (only if provided)
		// (since it's an update, vacancies might be undefined)
		if (vacancies !== undefined) {
			if (!Number.isInteger(vacancies) || vacancies < 1) {
				return res.status(400).json({
					status: "FAIL",
					message: "vacancies must be an integer greater than or equal to 1",
				});
			}
		}

		if (maxApplicants !== null && maxApplicants !== undefined) {
			if (!Number.isInteger(maxApplicants) || maxApplicants < 1) {
				return res.status(400).json({
					status: "FAIL",
					message: "maxApplicants must be null (unlimited) or an integer greater than or equal to 1",
				});
			}

			// If both provided, enforce relationship
			if (vacancies !== undefined && maxApplicants < vacancies) {
				return res.status(400).json({
					status: "FAIL",
					message: "maxApplicants cannot be less than vacancies",
				});
			}
		}

		// 1️⃣ Get recruiter profile
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
		});

		if (!recruiterProfile) {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter profile not found",
			});
		}

		// 2️⃣ Fetch job (ownership + status)
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				recruiterProfileId: recruiterProfile.id,
			},
			select: { id: true, status: true, vacancies: true }, // include current vacancies for validation
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not owned by you",
			});
		}

		if (job.status !== "DRAFT") {
			return res.status(400).json({
				status: "FAIL",
				message: "Only draft jobs can be updated",
			});
		}

		// ✅ If vacancies not provided but maxApplicants is, compare against existing vacancies
		if (maxApplicants !== null && maxApplicants !== undefined && vacancies === undefined) {
			if (maxApplicants < job.vacancies) {
				return res.status(400).json({
					status: "FAIL",
					message: "maxApplicants cannot be less than vacancies",
				});
			}
		}

		// 3️⃣ Validate industries
		if (industries.length > 0) {
			const validIndustries = await prisma.industry.findMany({
				where: { id: { in: industries } },
				select: { id: true },
			});

			if (validIndustries.length !== industries.length) {
				return res.status(400).json({
					status: "FAIL",
					message: "One or more industries are invalid",
				});
			}
		}

		// 4️⃣ Validate skills
		if (skills.length > 0) {
			const validSkills = await prisma.skill.findMany({
				where: { id: { in: skills } },
				select: { id: true },
			});

			if (validSkills.length !== skills.length) {
				return res.status(400).json({
					status: "FAIL",
					message: "One or more skills are invalid",
				});
			}
		}

		// 5️⃣ Transaction update
		const updatedJob = await prisma.$transaction(async (tx) => {
			// Only clear and re-create relations if they were provided
			if (industries.length > 0) {
				await tx.jobIndustry.deleteMany({ where: { jobId } });
			}
			if (skills.length > 0) {
				await tx.jobSkill.deleteMany({ where: { jobId } });
			}

			const updateData = {
				...(title !== undefined ? { title } : {}),
				...(description !== undefined ? { description } : {}),
				...(vacancies !== undefined ? { vacancies } : {}),
				...(maxApplicants !== undefined ? { maxApplicants: maxApplicants ?? null } : {}),

				...(employmentType !== undefined ? { employmentType } : {}),
				...(experienceLevel !== undefined ? { experienceLevel } : {}),

				...(isRemote !== undefined ? { isRemote } : {}),
				...(isRemote !== undefined && isRemote ? { locationName: null, latitude: null, longitude: null } : {}),
				...(!isRemote && locationName !== undefined ? { locationName } : {}),
				...(!isRemote && latitude !== undefined ? { latitude } : {}),
				...(!isRemote && longitude !== undefined ? { longitude } : {}),

				...(minSalary !== undefined ? { minSalary } : {}),
				...(maxSalary !== undefined ? { maxSalary } : {}),
				...(currency !== undefined ? { currency } : {}),
				...(showSalary !== undefined ? { showSalary } : {}),
			};

			if (industries.length > 0) {
				updateData.industries = { create: industries.map((industryId) => ({ industryId })) };
			}
			if (skills.length > 0) {
				updateData.skills = { create: skills.map((skillId) => ({ skillId })) };
			}

			return tx.job.update({
				where: { id: jobId },
				data: updateData,
			});
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Draft job updated successfully",
			data: updatedJob,
		});
	} catch (error) {
		console.error("Update draft job error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to update job",
		});
	}
};

const publishJob = async (req, res) => {
	try {
		const userId = req.user.userId;
		const jobId = req.params.id;

		// 1️⃣ Recruiter profile
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
		});

		if (!recruiterProfile) {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter profile not found",
			});
		}

		// 2️⃣ Fetch job with relations
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				recruiterProfileId: recruiterProfile.id,
			},
			include: {
				skills: true,
				industries: true,
			},
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not owned by you",
			});
		}

		if (job.status !== "DRAFT") {
			return res.status(400).json({
				status: "FAIL",
				message: "Job must be DRAFT state in order to publish",
			});
		}

		// 3️⃣ Required checks
		if (!job.title || !job.description || !job.employmentType || job.skills.length === 0 || job.industries.length === 0) {
			return res.status(400).json({
				status: "FAIL",
				message: "Job is incomplete. Fill all required fields before publishing.",
			});
		}

		// 4️⃣ Publish
		const publishedJob = await prisma.job.update({
			where: { id: jobId },
			data: {
				status: "PUBLISHED",
				publishedAt: new Date(),
			},
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Job published successfully",
			data: publishedJob,
		});
	} catch (error) {
		console.error("Publish job error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to publish job",
		});
	}
};

const suspendJob = async (req, res) => {
	try {
		const userId = req.user.userId;
		const jobId = req.params.id;

		// 1️⃣ Recruiter profile
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
		});

		if (!recruiterProfile) {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter profile not found",
			});
		}

		// 2️⃣ Fetch job and confirm ownership
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				recruiterProfileId: recruiterProfile.id,
			},
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not owned by you",
			});
		}

		// 3️⃣ Check if job is already suspended
		if (job.status === "SUSPENDED") {
			return res.status(400).json({
				status: "FAIL",
				message: "Job is already suspended",
			});
		}

		// 4️⃣ Suspend job
		const suspendedJob = await prisma.job.update({
			where: { id: jobId },
			data: {
				status: "SUSPENDED",
			},
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Job suspended successfully",
			data: suspendedJob,
		});
	} catch (error) {
		console.error("Suspend job error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to suspend job",
		});
	}
};

const unsuspendJob = async (req, res) => {
	try {
		const userId = req.user.userId;
		const jobId = req.params.id;

		// 1️⃣ Recruiter profile
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
		});

		if (!recruiterProfile) {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter profile not found",
			});
		}

		// 2️⃣ Fetch job and confirm ownership
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				recruiterProfileId: recruiterProfile.id,
			},
			select: {
				id: true,
				status: true,
			},
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not owned by you",
			});
		}

		// 3️⃣ Ensure job is currently suspended
		if (job.status !== "SUSPENDED") {
			return res.status(400).json({
				status: "FAIL",
				message: "Only suspended jobs can be moved back to draft",
			});
		}

		// 4️⃣ Update status to DRAFT
		const updatedJob = await prisma.job.update({
			where: { id: jobId },
			data: {
				status: "DRAFT",
			},
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Job moved back to draft successfully",
			data: updatedJob,
		});
	} catch (error) {
		console.error("Unsuspend job error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to update job status",
		});
	}
};

const validateUserRole = (req) => {};

const getAllJobs = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const {
			status: rawStatus = "PUBLISHED", // default: public jobs
			search,
			industryId,
			industryName,
			skillId,
			isRemote,
			hasApplications,
			employmentType,
			experienceLevel,
			location,
			currency,
			salaryMin,
			salaryMax,
			page = 1,
			limit = 20,
		} = req.query;

		// Only scope to recruiter's company when authenticated as a recruiter
		let recruiterProfile = null;
		if (userId) {
			recruiterProfile = await prisma.recruiterProfile.findUnique({
				where: { userId },
				select: { companyId: true },
			});
		}

		// Validate status against Prisma enum; map legacy values
		const VALID_STATUSES = ["DRAFT", "PUBLISHED", "CLOSED", "SUSPENDED"];
		const STATUS_MAP = { ACTIVE: "PUBLISHED", PAUSED: "SUSPENDED" };
		const status = STATUS_MAP[rawStatus] || (VALID_STATUSES.includes(rawStatus) ? rawStatus : "");

		const skip = (Number(page) - 1) * Number(limit);

		// Normalize employmentType filter — accept human-readable values
		const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"];
		const EMPLOYMENT_MAP = {
			"full-time": "FULL_TIME", "full time": "FULL_TIME", "fulltime": "FULL_TIME",
			"part-time": "PART_TIME", "part time": "PART_TIME", "parttime": "PART_TIME",
			"contract": "CONTRACT", "internship": "INTERNSHIP",
			"temporary": "TEMPORARY", "temp": "TEMPORARY",
		};
		let normalizedEmploymentType = null;
		if (employmentType) {
			const upper = employmentType.toUpperCase().replace(/-/g, "_");
			if (EMPLOYMENT_TYPES.includes(upper)) {
				normalizedEmploymentType = upper;
			} else {
				normalizedEmploymentType = EMPLOYMENT_MAP[employmentType.toLowerCase()] || null;
			}
		}

		// Build global search condition — matches across title, description,
		// location, company name, skill names, and industry names
		let searchCondition = {};
		if (search && search.trim()) {
			const q = search.trim();
			const qLower = q.toLowerCase();

			// employmentType is an enum — match search terms to enum values
			const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"];
			const matchedTypes = EMPLOYMENT_TYPES.filter((t) =>
				t.toLowerCase().includes(qLower) || qLower.includes(t.toLowerCase().replace("_", " "))
			);

			const orConditions = [
				{ title: { contains: q, mode: "insensitive" } },
				{ description: { contains: q, mode: "insensitive" } },
				{ locationName: { contains: q, mode: "insensitive" } },
				{ currency: { contains: q, mode: "insensitive" } },
				{ experienceLevel: { contains: q, mode: "insensitive" } },
				{ company: { name: { contains: q, mode: "insensitive" } } },
				{ skills: { some: { skill: { name: { contains: q, mode: "insensitive" } } } } },
				{ industries: { some: { industry: { name: { contains: q, mode: "insensitive" } } } } },
			];

			// Add enum match for employment type if search term matches
			if (matchedTypes.length > 0) {
				orConditions.push({ employmentType: { in: matchedTypes } });
			}

			// Check if search term looks like "remote"
			if ("remote".includes(qLower) || qLower.includes("remote")) {
				orConditions.push({ isRemote: true });
			}

			searchCondition = { OR: orConditions };
		}

		const where = {
			...(status && { status }),

			// Scope to this recruiter's jobs (includes feed jobs assigned to them)
			...(recruiterProfile?.id && { recruiterProfileId: recruiterProfile.id }),

			// Global search across multiple fields
			...searchCondition,

			...(isRemote !== undefined && {
				isRemote: isRemote === "true",
			}),

			...(industryId && {
				industries: {
					some: { industryId },
				},
			}),
			// Filter by industry name (from job seeker frontend category dropdown)
			...(!industryId && industryName && {
				industries: {
					some: { industry: { name: { contains: industryName, mode: "insensitive" } } },
				},
			}),
			...(skillId && {
				skills: {
					some: { skillId },
				},
			}),

			...(normalizedEmploymentType && { employmentType: normalizedEmploymentType }),
			...(experienceLevel && { experienceLevel: { contains: experienceLevel, mode: "insensitive" } }),
			...(location && { locationName: { contains: location, mode: "insensitive" } }),
			...(currency && { currency: { equals: currency, mode: "insensitive" } }),
			...(salaryMin && { maxSalary: { gte: Number(salaryMin) } }),
			...(salaryMax && { minSalary: { lte: Number(salaryMax) } }),

			// Only return jobs that have at least one application
			...(hasApplications === "true" && {
				jobApplications: {
					some: {},
				},
			}),
		};

		const [jobs, total] = await prisma.$transaction([
			prisma.job.findMany({
				where,
				skip,
				take: Number(limit),
				orderBy: { createdAt: "desc" },
				include: {
					company: {
						select: {
							id: true,
							name: true,
							website: true,
							country: true,
						},
					},

					// 🔗 Job ↔ Industries
					industries: {
						include: {
							industry: {
								select: {
									id: true,
									name: true,
									slug: true,
								},
							},
						},
					},

					// 🔗 Job ↔ Skills
					skills: {
						include: {
							skill: {
								select: {
									id: true,
									name: true,
								},
							},
						},
					},

					// Application count
					_count: {
						select: { jobApplications: true },
					},
				},
			}),
			prisma.job.count({ where }),
		]);

		return res.status(200).json({
			status: "SUCCESS",
			data: jobs,
			meta: {
				total,
				page: Number(page),
				limit: Number(limit),
				totalPages: Math.ceil(total / limit),
			},
		});
	} catch (error) {
		console.error("Get jobs error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to fetch jobs",
		});
	}
};

const bulkCreateJobs = async (req, res) => {
	try {
		const userId = req.user.userId;
		const { jobs } = req.body;

		if (!Array.isArray(jobs) || jobs.length === 0) {
			return res.status(400).json({
				status: "FAIL",
				message: "jobs must be a non-empty array",
			});
		}

		if (jobs.length > 50) {
			return res.status(400).json({
				status: "FAIL",
				message: "Maximum 50 jobs can be created at once",
			});
		}

		// Fetch recruiter profile
		const recruiterProfile = await prisma.recruiterProfile.findUnique({
			where: { userId },
		});

		if (!recruiterProfile) {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter profile not found",
			});
		}

		if (!recruiterProfile.isApproved || recruiterProfile.status !== "ACTIVE") {
			return res.status(403).json({
				status: "FAIL",
				message: "Recruiter is not approved to post jobs",
			});
		}

		const results = [];

		for (let i = 0; i < jobs.length; i++) {
			const jobEntry = jobs[i];
			try {
				const {
					title,
					description,
					vacancies = 1,
					maxApplicants = null,
					employmentType = "FULL_TIME",
					experienceLevel = "Mid-Level",
					locationName,
					latitude,
					longitude,
					isRemote = false,
					minSalary,
					maxSalary,
					currency = "AED",
					showSalary = false,
					industries = [],
					skills = [],
					autoPublish = false,
				} = jobEntry;

				if (!title || !description) {
					results.push({ index: i, title: title || "(untitled)", status: "FAIL", message: "title and description are required" });
					continue;
				}

				if (!employmentType || !["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"].includes(employmentType)) {
					results.push({ index: i, title, status: "FAIL", message: "Invalid employmentType" });
					continue;
				}

				// Validate industries exist
				let validIndustryIds = [];
				if (industries.length > 0) {
					const existingIndustries = await prisma.industry.findMany({
						where: { id: { in: industries } },
						select: { id: true },
					});
					validIndustryIds = existingIndustries.map((ind) => ind.id);
				}

				// Validate skills exist
				let validSkillIds = [];
				if (skills.length > 0) {
					const existingSkills = await prisma.skill.findMany({
						where: { id: { in: skills } },
						select: { id: true },
					});
					validSkillIds = existingSkills.map((s) => s.id);
				}

				const job = await prisma.$transaction(async (tx) => {
					return tx.job.create({
						data: {
							title: title.trim(),
							description: description.trim(),
							vacancies: Number(vacancies) || 1,
							maxApplicants: maxApplicants ? Number(maxApplicants) : null,
							employmentType,
							experienceLevel: experienceLevel || "Mid-Level",
							locationName: isRemote ? null : (locationName || null),
							latitude: isRemote ? null : (latitude ? parseFloat(latitude) : null),
							longitude: isRemote ? null : (longitude ? parseFloat(longitude) : null),
							isRemote: !!isRemote,
							minSalary: minSalary ? Number(minSalary) : null,
							maxSalary: maxSalary ? Number(maxSalary) : null,
							currency: currency || "AED",
							showSalary: !!showSalary,
							status: autoPublish ? "PUBLISHED" : "DRAFT",
							publishedAt: autoPublish ? new Date() : null,
							companyId: recruiterProfile.companyId,
							recruiterProfileId: recruiterProfile.id,
							industries: {
								create: validIndustryIds.map((industryId) => ({ industryId })),
							},
							skills: {
								create: validSkillIds.map((skillId) => ({ skillId })),
							},
						},
					});
				});

				results.push({ index: i, title, status: "SUCCESS", jobId: job.id, jobStatus: job.status });
			} catch (err) {
				results.push({ index: i, title: jobEntry.title || "(untitled)", status: "ERROR", message: err.message });
			}
		}

		const successCount = results.filter((r) => r.status === "SUCCESS").length;
		const failCount = results.length - successCount;

		return res.status(201).json({
			status: "SUCCESS",
			message: `Bulk upload complete: ${successCount} succeeded, ${failCount} failed`,
			data: { results, successCount, failCount },
		});
	} catch (error) {
		console.error("Bulk create jobs error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to bulk create jobs",
		});
	}
};

const getJobById = async (req, res) => {
	try {
		const { id } = req.params;

		const job = await prisma.job.findUnique({
			where: { id },
			include: {
				company: {
					select: {
						id: true,
						name: true,
						website: true,
						country: true,
					},
				},
				industries: {
					include: {
						industry: {
							select: {
								id: true,
								name: true,
								slug: true,
							},
						},
					},
				},
				skills: {
					include: {
						skill: {
							select: {
								id: true,
								name: true,
							},
						},
					},
				},
			},
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found",
			});
		}

		return res.status(200).json({
			status: "SUCCESS",
			data: job,
		});
	} catch (error) {
		console.error("Get job by ID error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to fetch job",
		});
	}
};

module.exports = {
	createDraftJob,
	updateDraftJob,
	publishJob,
	suspendJob,
	unsuspendJob,
	getAllJobs,
	getJobById,
	bulkCreateJobs,
};
