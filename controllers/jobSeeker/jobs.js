// controllers/jobSeeker/savedJobs.controller.js
const { prisma } = require("../../prisma");

// POST /jobs/:jobId/save
const saveJob = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { jobId } = req.params;
		const { note } = req.body || {};

		if (!userId) {
			return res.status(401).json({ error: true, message: "Unauthorized", result: {} });
		}

		if (!jobId) {
			return res.status(400).json({ error: true, message: "jobId is required", result: {} });
		}

		// 1) get job seeker profile
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(403).json({
				error: true,
				message: "Job seeker profile not found",
				result: {},
			});
		}

		// 2) confirm job exists (optional but recommended)
		const job = await prisma.job.findUnique({
			where: { id: jobId },
			select: { id: true },
		});

		if (!job) {
			return res.status(404).json({
				error: true,
				message: "Job not found",
				result: {},
			});
		}

		// 3) create saved job (idempotent via upsert)
		const saved = await prisma.savedJob.upsert({
			where: {
				jobSeekerId_jobId: {
					jobSeekerId: jobSeeker.id,
					jobId,
				},
			},
			update: {
				note: typeof note === "string" ? note : undefined,
			},
			create: {
				jobSeekerId: jobSeeker.id,
				jobId,
				note: typeof note === "string" ? note : null,
			},
			select: {
				id: true,
				jobId: true,
				note: true,
				savedAt: true,
			},
		});

		return res.status(200).json({
			error: false,
			message: "Job saved successfully",
			result: saved,
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			error: true,
			message: error.message || "Failed to save job",
			result: {},
		});
	}
};

const getSavedJobs = async (req, res) => {
	try {
		const userId = req.user?.userId;

		if (!userId) {
			return res.status(401).json({
				error: true,
				message: "Unauthorized",
				result: [],
			});
		}

		const { page = 1, limit = 20, search } = req.query;

		const pageNum = Math.max(parseInt(page) || 1, 1);
		const limitNum = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
		const skip = (pageNum - 1) * limitNum;

		// 1) Get job seeker profile
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(403).json({
				error: true,
				message: "Job seeker profile not found",
				result: [],
			});
		}

		// 2) Build filter
		const where = {
			jobSeekerId: jobSeeker.id,
			...(search && {
				job: {
					title: {
						contains: search,
						mode: "insensitive",
					},
				},
			}),
		};

		// 3) Fetch data
		const [total, savedJobs] = await Promise.all([
			prisma.savedJob.count({ where }),
			prisma.savedJob.findMany({
				where,
				orderBy: { savedAt: "desc" },
				skip,
				take: limitNum,
				select: {
					// keep saved job metadata if you still want it (optional)
					id: true, // savedJobId (you can drop this later)
					note: true,
					savedAt: true,

					// return FULL job object shape
					job: {
						select: {
							id: true,
							title: true,
							description: true,
							vacancies: true,
							employmentType: true,
							experienceLevel: true,
							locationName: true,
							latitude: true,
							longitude: true,
							isRemote: true,
							minSalary: true,
							maxSalary: true,
							currency: true,
							showSalary: true,
							status: true,
							companyId: true,
							recruiterProfileId: true,
							createdAt: true,
							updatedAt: true,
							publishedAt: true,
							externalId: true,
							applicationUrl: true,
							source: true,

							company: {
								select: {
									id: true,
									name: true,
									website: true,
									country: true,
								},
							},

							industries: {
								select: {
									jobId: true,
									industryId: true,
									createdAt: true,
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
								select: {
									id: true,
									jobId: true,
									skillId: true,
									createdAt: true,
									skill: {
										select: {
											id: true,
											name: true,
										},
									},
								},
							},
						},
					},
				},
			}),
		]);

		// // If you want the output to be ONLY the job objects (exactly like your sample),
		// // map before returning:
		// const result = savedJobs.map((s) => ({
		// 	...s.job,
		// 	// optionally include saved metadata:
		// 	savedJob: { id: s.id, note: s.note, savedAt: s.savedAt },
		// }));

		// then return `result` instead of `savedJobs`

		return res.status(200).json({
			error: false,
			message: "Saved jobs fetched successfully",
			meta: {
				page: pageNum,
				limit: limitNum,
				total,
				totalPages: Math.ceil(total / limitNum),
			},
			result: savedJobs,
			
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			error: true,
			message: error.message || "Failed to fetch saved jobs",
			result: [],
		});
	}
};

// DELETE /jobs/:jobId/save
const unsaveJob = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { jobId } = req.params;

		if (!userId) {
			return res.status(401).json({ error: true, message: "Unauthorized", result: {} });
		}

		if (!jobId) {
			return res.status(400).json({ error: true, message: "jobId is required", result: {} });
		}

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(403).json({
				error: true,
				message: "Job seeker profile not found",
				result: {},
			});
		}

		// deleteMany makes it safe even if it doesn't exist
		const deleted = await prisma.savedJob.deleteMany({
			where: {
				jobSeekerId: jobSeeker.id,
				jobId,
			},
		});

		if (deleted.count === 0) {
			return res.status(404).json({
				error: true,
				message: "Saved job not found",
				result: {},
			});
		}

		return res.status(200).json({
			error: false,
			message: "Job removed from saved list",
			result: { jobId },
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			error: true,
			message: error.message || "Failed to unsave job",
			result: {},
		});
	}
};

module.exports = { saveJob, getSavedJobs, unsaveJob };
