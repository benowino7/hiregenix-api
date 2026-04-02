const { prisma } = require("../../prisma");

const applyForJob = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const jobId = req.params.jobId;
		const { cvId, coverLetter } = req.body;

		// 1) Get job seeker
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
			});
		}

		// statuses that count towards applicant cap
		const COUNTED_STATUSES = ["SUBMITTED", "REVIEWING", "SHORTLISTED", "HIRED"];

		// 2) Apply (atomic) + enforce maxApplicants cap
		const application = await prisma.$transaction(
			async (tx) => {
				// 2a) Ensure job exists + published + fetch maxApplicants
				const job = await tx.job.findUnique({
					where: { id: jobId },
					select: { id: true, status: true, maxApplicants: true },
				});

				if (!job) {
					const err = new Error("JOB_NOT_FOUND");
					err.code = "JOB_NOT_FOUND";
					throw err;
				}

				if (job.status !== "PUBLISHED") {
					const err = new Error("JOB_NOT_APPLICABLE");
					err.code = "JOB_NOT_APPLICABLE";
					throw err;
				}

				// 2b) Enforce maxApplicants (if set)
				if (job.maxApplicants !== null && job.maxApplicants !== undefined) {
					const currentApplicants = await tx.jobApplication.count({
						where: {
							jobId,
							status: { in: COUNTED_STATUSES },
						},
					});

					if (currentApplicants >= job.maxApplicants) {
						const err = new Error("MAX_APPLICANTS_REACHED");
						err.code = "MAX_APPLICANTS_REACHED";
						err.meta = { maxApplicants: job.maxApplicants, currentApplicants };
						throw err;
					}
				}

				// 3) Determine CV to use
				let finalCvId = null;

				if (cvId) {
					const cv = await tx.jobSeekerCV.findFirst({
						where: { id: cvId, jobSeekerId: jobSeeker.id },
						select: { id: true },
					});

					if (!cv) {
						const err = new Error("INVALID_CV");
						err.code = "INVALID_CV";
						throw err;
					}

					finalCvId = cv.id;
				} else {
					const defaultCv = await tx.jobSeekerCV.findFirst({
						where: { jobSeekerId: jobSeeker.id },
						orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
						select: { id: true },
					});

					finalCvId = defaultCv?.id || null;
				}

				// 4) Create application + initial status log
				const created = await tx.jobApplication.create({
					data: {
						jobId,
						jobSeekerId: jobSeeker.id,
						cvId: finalCvId,
						coverLetter: coverLetter?.trim() || null,
						// status defaults to SUBMITTED
					},
					select: {
						id: true,
						status: true,
						createdAt: true,
						jobId: true,
						jobSeekerId: true,
						cvId: true,
					},
				});

				await tx.jobApplicationStatusLog.create({
					data: {
						jobApplicationId: created.id,
						fromStatus: null,
						toStatus: created.status, // SUBMITTED
						changedByUserId: userId || null,
						note: "Application submitted",
					},
					select: { id: true },
				});

				return created;
			},
			// ✅ Optional but recommended for Postgres to reduce race conditions.
			// If your Prisma version/db doesn’t support this, remove this 2nd argument.
			// { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);

		return res.status(201).json({
			status: "SUCCESS",
			message: "Application submitted successfully",
			data: application,
		});
	} catch (error) {
		console.error(error);

		// Custom errors thrown inside transaction
		if (error?.code === "JOB_NOT_FOUND") {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found",
			});
		}

		if (error?.code === "JOB_NOT_APPLICABLE") {
			return res.status(400).json({
				status: "FAIL",
				message: "You cannot apply for this job",
			});
		}

		if (error?.code === "INVALID_CV") {
			return res.status(400).json({
				status: "FAIL",
				message: "Invalid cvId (CV not found for this job seeker)",
			});
		}

		if (error?.code === "MAX_APPLICANTS_REACHED") {
			return res.status(409).json({
				status: "FAIL",
				message: "This job has reached the maximum number of applicants",
				meta: error?.meta || {},
			});
		}

		// Prisma unique constraint violation (duplicate application)
		if (error?.code === "P2002") {
			return res.status(409).json({
				status: "FAIL",
				message: "You have already applied for this job",
			});
		}

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to apply for job",
		});
	}
};

const getMyApplications = async (req, res) => {
	try {
		const userId = req.user?.userId;

		// pagination
		const page = Math.max(1, parseInt(req.query.page, 10) || 1);
		const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
		const skip = (page - 1) * limit;

		// optional status filter
		const status = req.query.status || null;

		// 1) Get job seeker
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
			});
		}

		const where = {
			jobSeekerId: jobSeeker.id,
			...(status && { status }), // ✅ filter if provided
		};

		// 2) Fetch total + applications (transaction for consistency)
		const [total, applications] = await prisma.$transaction([
			prisma.jobApplication.count({ where }),
			prisma.jobApplication.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip,
				take: limit,
				select: {
					id: true,
					status: true,
					coverLetter: true,
					createdAt: true,
					updatedAt: true,

					job: {
						select: {
							id: true,
							title: true,
							locationName: true,
							latitude: true,
							longitude: true,
							isRemote: true,
							minSalary: true,
							maxSalary: true,
							currency: true,
							showSalary: true,
							createdAt: true,

							company: {
								select: {
									id: true,
									name: true,
									isVerified: true,
									country: true,
									website: true,
									address: true,
								},
							},
						},
					},

					cv: {
						select: {
							id: true,
							fileName: true,
							fileSize: true,
						},
					},
				},
			}),
		]);

		const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

		return res.json({
			status: "SUCCESS",
			message: {
				applications,
				pagination: {
					total,
					page,
					limit,
					totalPages,
				},
				filters: {
					status: status || "ALL",
				},
			},
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to fetch applications",
		});
	}
};

const withdrawJobApplication = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const jobApplicationId = req.params.jobApplicationId;
		const { note } = req.body;

		if (!userId) {
			return res.status(401).json({ status: "FAIL", message: "Unauthorized" });
		}

		if (!jobApplicationId) {
			return res.status(400).json({ status: "FAIL", message: "jobApplicationId is required" });
		}

		// 1) Get job seeker
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
			});
		}

		// 2) Load application and verify ownership
		const application = await prisma.jobApplication.findUnique({
			where: { id: jobApplicationId },
			select: {
				id: true,
				status: true,
				jobSeekerId: true,
				job: { select: { id: true, title: true } },
			},
		});

		if (!application) {
			return res.status(404).json({ status: "FAIL", message: "Application not found" });
		}

		if (application.jobSeekerId !== jobSeeker.id) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: this application does not belong to you",
			});
		}

		// 3) Guard: only allow withdraw if not final
		if (["WITHDRAWN", "REJECTED", "HIRED"].includes(application.status)) {
			return res.status(400).json({
				status: "FAIL",
				message: `You cannot withdraw an application in status: ${application.status}`,
			});
		}

		const fromStatus = application.status;

		// 4) Update + log atomically
		const updated = await prisma.$transaction(async (tx) => {
			const updatedApp = await tx.jobApplication.update({
				where: { id: jobApplicationId },
				data: { status: "WITHDRAWN" },
				select: {
					id: true,
					jobId: true,
					jobSeekerId: true,
					status: true,
					updatedAt: true,
				},
			});

			await tx.jobApplicationStatusLog.create({
				data: {
					jobApplicationId,
					fromStatus,
					toStatus: "WITHDRAWN",
					changedByUserId: userId,
					note: note?.trim() || "Withdrawn by job seeker",
				},
				select: { id: true },
			});

			return updatedApp;
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Application withdrawn successfully",
			data: updated,
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to withdraw application",
		});
	}
};

module.exports = { applyForJob, getMyApplications, withdrawJobApplication };
