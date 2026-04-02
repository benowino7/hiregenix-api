const { prisma } = require("../../prisma");
const fs = require("fs");
const path = require("path");

const getJobApplications = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const jobId = req.params.jobId;

		// pagination (optional but recommended)
		const page = Math.max(1, parseInt(req.query.page, 10) || 1);
		const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
		const skip = (page - 1) * limit;

		const status = req.query.status || null;

		// 1) Check recruiter
		const recruiter = await prisma.recruiterProfile.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!recruiter) {
			return res.status(403).json({
				status: "FAIL",
				message: "Not authorized",
			});
		}

		// 2) Check job ownership (by recruiterProfileId)
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				recruiterProfileId: recruiter.id,
			},
			select: { id: true },
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not authorized",
			});
		}

		const where = {
			jobId,
			...(status && { status }),
		};

		// 3) Fetch applications + logs
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

					jobSeeker: {
						select: {
							id: true,
							hasVisa: true,
							hasWorkPermit: true,
							user: {
								select: {
									firstName: true,
									lastName: true,
									email: true,
									phoneNumber: true,
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

					// ✅ INCLUDE STATUS LOGS
					statusLogs: {
						orderBy: { createdAt: "desc" }, // latest first
						select: {
							id: true,
							fromStatus: true,
							toStatus: true,
							note: true,
							createdAt: true,

							changedByUser: {
								select: {
									id: true,
									firstName: true,
									lastName: true,
									email: true,
								},
							},
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

const ALLOWED_TRANSITIONS = {
	SUBMITTED: ["REVIEWING", "WITHDRAWN"],
	REVIEWING: ["SHORTLISTED", "REJECTED", "WITHDRAWN"],
	SHORTLISTED: ["HIRED", "REJECTED", "WITHDRAWN"],
	REJECTED: [],
	WITHDRAWN: [],
	HIRED: [],
};

const updateApplicationStatusByRecruiter = async (req, res) => {
	try {
		const userId = req.user?.userId;

		const jobApplicationId = req.params.jobApplicationId;
		const { status: toStatus, note } = req.body;

		// Get recruiter profile
		const recruiter = await prisma.recruiterProfile.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!recruiter) {
			return res.status(403).json({ status: "FAIL", message: "Access denied" });
		}

		if (!jobApplicationId) {
			return res.status(400).json({ status: "FAIL", message: "jobApplicationId is required" });
		}

		if (!toStatus || (!ALLOWED_TRANSITIONS[toStatus] && !Object.keys(ALLOWED_TRANSITIONS).includes(toStatus))) {
			return res.status(400).json({ status: "FAIL", message: "Invalid status value" });
		}

		// 1) Load application + job to verify ownership
		const application = await prisma.jobApplication.findUnique({
			where: { id: jobApplicationId },
			select: {
				id: true,
				status: true,
				job: { select: { id: true, recruiterProfileId: true } },
			},
		});

		if (!application) {
			return res.status(404).json({ status: "FAIL", message: "Application not found" });
		}

		if (!application.job || application.job.recruiterProfileId !== recruiter.id) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: application does not belong to your jobs",
			});
		}

		// 2) Validate transition
		const fromStatus = application.status;
		const allowedNext = ALLOWED_TRANSITIONS[fromStatus] || [];

		// Recruiter should NOT set WITHDRAWN (job seeker does that)
		if (toStatus === "WITHDRAWN") {
			return res.status(400).json({
				status: "FAIL",
				message: "Recruiter cannot set status to WITHDRAWN",
			});
		}

		if (!allowedNext.includes(toStatus)) {
			return res.status(400).json({
				status: "FAIL",
				message: `Invalid transition: ${fromStatus} -> ${toStatus}`,
			});
		}

		// 3) Update + log atomically
		const updated = await prisma.$transaction(async (tx) => {
			const updatedApp = await tx.jobApplication.update({
				where: { id: jobApplicationId },
				data: { status: toStatus },
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
					toStatus,
					changedByUserId: userId,
					note: note?.trim() || null,
				},
				select: { id: true },
			});

			return updatedApp;
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "Application status updated",
			data: updated,
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to update application status",
		});
	}
};

// ✅ Set this to where you store CVs (recommended)
// Example: /var/www/app/uploads/cvs
const CV_UPLOADS_ROOT = path.join(__dirname, "../../uploads");

/**
 * Serve a job seeker's CV to a recruiter for a specific job application
 * Route example: GET /recruiter/applications/:jobApplicationId/cv
 */
const serveJobSeekerCv = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const jobApplicationId = req.params.jobApplicationId;

		if (!userId) {
			return res.status(401).json({
				status: "FAIL",
				message: "Unauthorized",
			});
		}

		// Get recruiter profile
		const recruiter = await prisma.recruiterProfile.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!recruiter) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: recruiter not found",
			});
		}

		if (!jobApplicationId) {
			return res.status(400).json({
				status: "FAIL",
				message: "jobApplicationId is required",
			});
		}

		// 1) Fetch the application + job + cv in one query
		const application = await prisma.jobApplication.findUnique({
			where: { id: jobApplicationId },
			select: {
				id: true,
				job: {
					select: {
						id: true,
						recruiterProfileId: true,
						title: true,
					},
				},
				cv: {
					select: {
						id: true,
						jobSeekerId: true,
						filePath: true,
						fileName: true,
						mimeType: true,
						fileSize: true,
					},
				},
			},
		});

		if (!application) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job application not found",
			});
		}

		if (!application.job || application.job.recruiterProfileId !== recruiter.id) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: application does not belong to your jobs",
			});
		}

		if (!application.cv?.filePath) {
			return res.status(404).json({
				status: "FAIL",
				message: "CV not found for this application",
			});
		}

		// 2) Resolve and validate file path is inside CV_UPLOADS_ROOT
		// If you store absolute paths in DB, this still works.
		const absolutePath = path.isAbsolute(application.cv.filePath) ? application.cv.filePath : path.resolve(CV_UPLOADS_ROOT, application.cv.filePath);

		const normalizedRoot = path.resolve(CV_UPLOADS_ROOT) + path.sep;
		const normalizedFile = path.resolve(absolutePath);

		if (!normalizedFile.startsWith(normalizedRoot)) {
			return res.status(403).json({
				status: "FAIL",
				message: "Invalid file path",
			});
		}

		if (!fs.existsSync(normalizedFile)) {
			return res.status(404).json({
				status: "FAIL",
				message: "CV file missing on server",
			});
		}

		// 3) Stream the file
		const mimeType = application.cv.mimeType || "application/octet-stream";

		const fileName = application.cv.fileName || path.basename(normalizedFile);

		res.setHeader("Content-Type", mimeType);

		// Use inline to open in browser (pdf) OR attachment to force download
		// Change to "attachment" if you always want download
		res.setHeader("Content-Disposition", `inline; filename="${fileName.replace(/"/g, "")}"`);

		const stream = fs.createReadStream(normalizedFile);

		stream.on("error", (err) => {
			console.error("CV stream error:", err);
			if (!res.headersSent) {
				return res.status(500).json({
					status: "ERROR",
					message: "Failed to read CV file",
				});
			}
			res.end();
		});

		return stream.pipe(res);
	} catch (error) {
		console.error(error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to serve CV",
		});
	}
};

module.exports = { getJobApplications, updateApplicationStatusByRecruiter, serveJobSeekerCv };
