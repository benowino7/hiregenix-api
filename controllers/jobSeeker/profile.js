const fs = require("fs/promises");
const fsn = require("fs");
// pdf-parse is loaded lazily in uploadCV() to prevent it from monkey-patching JSON.parse at startup
const { prisma } = require("../../prisma");
const path = require("path");

// Create Job Seeker profile
const createJobSeekerProfile = async (req, res) => {
	try {
		const userId = req.user.userId;

		// 1️⃣ Ensure user exists
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, isActive: true },
		});

		if (!user || !user.isActive) {
			return res.status(403).json({
				status: "FAIL",
				message: "User account is inactive or not found",
			});
		}

		// 2️⃣ Check if profile already exists
		const existingProfile = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (existingProfile) {
			return res.status(409).json({
				status: "FAIL",
				message: "Job seeker profile already exists",
			});
		}

		// 3️⃣ Transaction: create role (if missing) + profile
		const result = await prisma.$transaction(async (tx) => {
			// Check if JOB_SEEKER role exists
			const existingRole = await tx.userRole.findUnique({
				where: {
					userId_role: {
						userId,
						role: "JOB_SEEKER",
					},
				},
			});

			// Create role if missing or inactive
			if (!existingRole) {
				await tx.userRole.create({
					data: {
						userId,
						role: "JOB_SEEKER",
					},
				});
			} else if (!existingRole.isActive) {
				await tx.userRole.update({
					where: {
						userId_role: {
							userId,
							role: "JOB_SEEKER",
						},
					},
					data: {
						isActive: true,
					},
				});
			}

			// Create Job Seeker profile
			const profile = await tx.jobSeeker.create({
				data: {
					userId,
				},
				select: {
					id: true,
					userId: true,
					createdAt: true,
				},
			});

			return profile;
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Job seeker profile created successfully",
			data: result,
		});
	} catch (error) {
		console.error("Create job seeker profile error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to create job seeker profile",
		});
	}
};

// =======================
// Upload CV (PDF only)
// =======================
const uploadCV = async (req, res) => {
	try {
		const userId = req.user?.userId;

		if (!req.file) {
			return res.status(400).json({
				status: "FAIL",
				message: "Please upload a PDF file",
			});
		}

		// Extra safety check (in case multer is bypassed)
		if (req.file.mimetype !== "application/pdf") {
			return res.status(400).json({
				status: "FAIL",
				message: "Only PDF files are allowed",
			});
		}

		const { industryId, notes, makePrimary } = req.body;
		const makePrimaryBool = String(makePrimary).toLowerCase() === "true";

		// Validate industry (if provided)
		let validIndustryId = null;

		if (industryId) {
			const industry = await prisma.industry.findUnique({
				where: { id: industryId },
				select: { id: true },
			});

			if (!industry) {
				return res.status(400).json({
					status: "FAIL",
					message: "Invalid industry selected",
				});
			}

			validIndustryId = industry.id;
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

		// 2) Get PDF buffer (supports memory OR disk storage)
		const buffer = req.file.buffer ? req.file.buffer : await fs.readFile(req.file.path);

		// Lazy-load pdf-parse and protect JSON.parse from monkey-patching
		const originalJSONParse = JSON.parse;
		const pdfParse = require("pdf-parse");
		JSON.parse = originalJSONParse;

		const pdfData = await pdfParse(buffer);
		const extractedText = JSON.stringify(pdfData.text || "");

		// 3) Save file to your storage path (move/write)
		const cvPath = await saveCVToPath(userId, req.file);
		if (cvPath.error) {
			return res.status(500).json({ status: "ERROR", message: cvPath.message || "Failed to save CV file" });
		}

		// 4) Save DB record (transaction)
		const cv = await prisma.$transaction(async (tx) => {
			// If this one is primary, make others non-primary first
			if (makePrimaryBool) {
				await tx.jobSeekerCV.updateMany({
					where: { jobSeekerId: jobSeeker.id, isPrimary: true },
					data: { isPrimary: false },
				});
			}

			const createdCV = await tx.jobSeekerCV.create({
				data: {
					jobSeekerId: jobSeeker.id,
					filePath: cvPath.path,
					fileName: req.file.originalname,
					mimeType: req.file.mimetype,
					fileSize: req.file.size,
					extractedText,
					notes: notes?.trim() || null,
					industryId: validIndustryId,
					isPrimary: makePrimaryBool,
				},
			});

			return createdCV;
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "CV uploaded successfully",
			data: {
				id: cv.id,
				fileName: cv.fileName,
				extractedTextPreview: extractedText.slice(0, 300),
			},
		});
	} catch (error) {
		console.error(error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to upload CV",
		});
	}
};

// GET /job-seeker/cvs
const getCVs = async (req, res) => {
	try {
		const userId = req.user?.userId;

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({ status: "FAIL", message: "Job seeker profile not found" });
		}

		const cvs = await prisma.jobSeekerCV.findMany({
			where: { jobSeekerId: jobSeeker.id },
			orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
			select: {
				id: true,
				fileName: true,
				mimeType: true,
				fileSize: true,
				notes: true,
				industryId: true,
				industry: {
					select: {
						id: true,
						name: true,
					}
				},
				isPrimary: true,
				createdAt: true,
				updatedAt: true,
			},
		});

		// Add a convenient URL for streaming/downloading
		const data = cvs.map((cv) => ({
			...cv,
			url: `/job-seeker/cvs/${cv.id}/file`,
		}));

		return res.json({ status: "SUCCESS", data });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ status: "ERROR", message: "Failed to fetch CVs" });
	}
};

// =======================
// Save CV to path
// - returns a RELATIVE path string (e.g. "cvs/cvs_1/<file>.pdf")
// - throws on error (so upload handler can catch)
// =======================
async function saveCVToPath(userId, file) {
	try {
		const MAX_FILES_PER_FOLDER = 200;
		if (!file) {
			return {
				error: true,
				message: "No file provided",
			};
		}

		// Ensure it's PDF
		if (file.mimetype !== "application/pdf") {
			return {
				error: true,
				message: "Only PDF files are allowed",
			};
		}

		// Generate filename
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `${userId}-${timestamp}.pdf`;

		// Base directory
		const baseDir = path.join(__dirname, "../../uploads/cvs");

		// Ensure base directory exists
		await fs.mkdir(baseDir, { recursive: true });

		// Get folders
		const items = await fs.readdir(baseDir, { withFileTypes: true });

		let targetFolder = null;

		// Find folder with space
		for (const item of items) {
			if (item.isDirectory() && item.name.startsWith("cvs_")) {
				const folderPath = path.join(baseDir, item.name);
				const files = await fs.readdir(folderPath);

				if (files.length < MAX_FILES_PER_FOLDER) {
					targetFolder = folderPath;
					break;
				}
			}
		}

		// If no folder found → create new
		if (!targetFolder) {
			const folderNumbers = items.filter((i) => i.isDirectory() && i.name.startsWith("cvs_")).map((i) => parseInt(i.name.split("_")[1]) || 0);

			const nextIndex = folderNumbers.length > 0 ? Math.max(...folderNumbers) + 1 : 1;

			const newFolderName = `cvs_${nextIndex}`;
			targetFolder = path.join(baseDir, newFolderName);

			await fs.mkdir(targetFolder);
			console.log(`Created folder: ${newFolderName}`);
		}

		// Save file
		const filePath = path.join(targetFolder, filename);

		// If using multer memory storage
		if (file.buffer) {
			await fs.writeFile(filePath, file.buffer);
		} else if (file.path) {
			// If using disk storage, move file
			await fs.rename(file.path, filePath);
		} else {
			return {
				error: true,
				message: "Unsupported file format",
			};
		}

		// Return relative path
		const relativePath = path.relative(path.join(__dirname, "../../uploads"), filePath).replace(/\\/g, "/");

		return {
			error: false,
			filename,
			path: relativePath, // e.g cvs/cvs_1/file.pdf
		};
	} catch (error) {
		console.error(error);

		return {
			error: true,
			message: "Failed to save CV",
		};
	}
}

const UPLOADS_ROOT = path.join(__dirname, "../../uploads");

function resolveSafeUploadPath(relativePath) {
	// normalize & resolve to absolute
	const abs = path.resolve(UPLOADS_ROOT, relativePath);

	// ensure it stays inside uploads root (prevents ../../ attacks)
	if (!abs.startsWith(UPLOADS_ROOT + path.sep)) {
		throw new Error("Invalid file path");
	}
	return abs;
}

// GET /job-seeker/cvs/:id/file
const serveCV = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const cvId = req.params.id;

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({ status: "FAIL", message: "Job seeker profile not found" });
		}

		const cv = await prisma.jobSeekerCV.findFirst({
			where: {
				id: cvId,
				jobSeekerId: jobSeeker.id, // ✅ ownership check
			},
			select: {
				id: true,
				filePath: true,
				fileName: true,
				mimeType: true,
			},
		});

		if (!cv) {
			return res.status(404).json({ status: "FAIL", message: "CV not found" });
		}

		const absPath = resolveSafeUploadPath(cv.filePath);

		// Check file exists
		await fs.access(absPath);

		// Block download for trial users
		const download = String(req.query.download).toLowerCase() === "true";
		if (download && req.isTrial) {
			return res.status(403).json({
				status: "FAIL",
				message: "PDF download requires a paid subscription. Please upgrade.",
				requiresUpgrade: true,
			});
		}
		res.setHeader("Content-Type", cv.mimeType || "application/pdf");
		res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(cv.fileName || "cv.pdf")}"`);

		// Stream the file
		const stream = fsn.createReadStream(absPath);
		stream.on("error", (e) => {
			console.error(e);
			return res.status(500).end();
		});
		stream.pipe(res);
	} catch (err) {
		console.error(err);
		return res.status(500).json({ status: "ERROR", message: "Failed to serve CV" });
	}
};

// PATCH /job-seeker/cvs/:id
// body (form-data or json): industryId?, notes?, makePrimary?
// optional file (form-data): file (pdf)
const updateCV = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const cvId = req.params.id;

		// If you send multipart/form-data, fields come from req.body
		const { industryId, notes, makePrimary } = req.body;
		const makePrimaryBool = makePrimary !== undefined ? String(makePrimary).toLowerCase() === "true" : undefined;

		// 1) Get job seeker
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({ status: "FAIL", message: "Job seeker profile not found" });
		}

		// 2) Validate industry if provided
		let validIndustryId = undefined; // undefined = don't change
		if (industryId !== undefined) {
			if (!industryId) {
				validIndustryId = null; // allow clearing
			} else {
				const industry = await prisma.industry.findUnique({
					where: { id: industryId },
					select: { id: true },
				});
				if (!industry) {
					return res.status(400).json({ status: "FAIL", message: "Invalid industry selected" });
				}
				validIndustryId = industry.id;
			}
		}

		// 3) Fetch CV (ownership check)
		const existing = await prisma.jobSeekerCV.findFirst({
			where: { id: cvId, jobSeekerId: jobSeeker.id },
			select: { id: true, filePath: true, fileName: true, mimeType: true, fileSize: true },
		});

		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "CV not found" });
		}

		// 4) If replacing file, validate + save new one
		let newFilePath;
		let newFileName;
		let newMimeType;
		let newFileSize;

		if (req.file) {
			if (req.file.mimetype !== "application/pdf") {
				return res.status(400).json({ status: "FAIL", message: "Only PDF files are allowed" });
			}

			const saveResult = await saveCVToPath(userId, req.file);
			if (saveResult.error) {
				return res.status(500).json({ status: "ERROR", message: saveResult.message || "Failed to save CV file" });
			}
			newFilePath = saveResult.path;
			newFileName = req.file.originalname;
			newMimeType = req.file.mimetype;
			newFileSize = req.file.size;
		}

		const updated = await prisma.$transaction(async (tx) => {
			// If setting primary true, clear other primaries first
			if (makePrimaryBool === true) {
				await tx.jobSeekerCV.updateMany({
					where: { jobSeekerId: jobSeeker.id, isPrimary: true },
					data: { isPrimary: false },
				});
			}

			const dataToUpdate = {
				...(notes !== undefined && { notes: notes?.trim() || null }),
				...(validIndustryId !== undefined && { industryId: validIndustryId }),
				...(makePrimaryBool !== undefined && { isPrimary: makePrimaryBool }),

				...(newFilePath && {
					filePath: newFilePath,
					fileName: newFileName,
					mimeType: newMimeType,
					fileSize: newFileSize,
				}),
			};

			const cv = await tx.jobSeekerCV.update({
				where: { id: existing.id },
				data: dataToUpdate,
			});

			return cv;
		});

		// 5) If file replaced, delete old file AFTER successful DB update
		if (newFilePath && existing.filePath) {
			try {
				const oldAbs = resolveSafeUploadPath(existing.filePath);
				await fs.unlink(oldAbs);
			} catch (e) {
				// don't fail the request if cleanup fails
				console.warn("Failed to delete old CV file:", e?.message || e);
			}
		}

		return res.json({ status: "SUCCESS", message: "CV updated successfully", data: updated });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ status: "ERROR", message: "Failed to update CV" });
	}
};

// DELETE /job-seeker/cvs/:id
const deleteCV = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const cvId = req.params.id;

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({ status: "FAIL", message: "Job seeker profile not found" });
		}

		const existing = await prisma.jobSeekerCV.findFirst({
			where: { id: cvId, jobSeekerId: jobSeeker.id },
			select: { id: true, filePath: true, isPrimary: true },
		});

		if (!existing) {
			return res.status(404).json({ status: "FAIL", message: "CV not found" });
		}

		// Delete DB record first (transaction if you want to reassign primary)
		await prisma.$transaction(async (tx) => {
			await tx.jobSeekerCV.delete({ where: { id: existing.id } });

			// Optional: if deleted CV was primary, set newest remaining to primary
			if (existing.isPrimary) {
				const latest = await tx.jobSeekerCV.findFirst({
					where: { jobSeekerId: jobSeeker.id },
					orderBy: { createdAt: "desc" },
					select: { id: true },
				});

				if (latest) {
					await tx.jobSeekerCV.update({
						where: { id: latest.id },
						data: { isPrimary: true },
					});
				}
			}
		});

		// Delete file from disk (best-effort)
		if (existing.filePath) {
			try {
				const abs = resolveSafeUploadPath(existing.filePath);
				await fs.unlink(abs);
			} catch (e) {
				console.warn("Failed to delete CV file:", e?.message || e);
			}
		}

		return res.json({ status: "SUCCESS", message: "CV deleted successfully" });
	} catch (err) {
		console.error(err);
		return res.status(500).json({ status: "ERROR", message: "Failed to delete CV" });
	}
};

// GET /job-seeker/profile
const getJobSeekerProfile = async (req, res) => {
	try {
		const userId = req.user.userId;

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: {
				id: true,
				firstName: true,
				middleName: true,
				lastName: true,
				email: true,
				countryCode: true,
				phoneNumber: true,
				isActive: true,
				createdAt: true,
				jobSeekerProfile: {
					select: {
						id: true,
						summary: true,
						experience: true,
						education: true,
						certifications: true,
						languages: true,
						awards: true,
						interests: true,
						hasVisa: true,
						hasWorkPermit: true,
						skills: {
							select: {
								id: true,
								proficiency: true,
								skill: { select: { id: true, name: true } },
							},
						},
						cvs: {
							orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
							select: {
								id: true,
								fileName: true,
								isPrimary: true,
								notes: true,
								industry: { select: { id: true, name: true } },
								createdAt: true,
							},
						},
						createdAt: true,
					},
				},
			},
		});

		if (!user) {
			return res.status(404).json({
				status: "FAIL",
				message: "User not found",
			});
		}

		if (!user.jobSeekerProfile) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found. Please create a profile first.",
			});
		}

		// Read experience, education, certifications from DB JSON fields
		const experience = Array.isArray(user.jobSeekerProfile.experience) ? user.jobSeekerProfile.experience : [];
		const education = Array.isArray(user.jobSeekerProfile.education) ? user.jobSeekerProfile.education : [];
		const certifications = Array.isArray(user.jobSeekerProfile.certifications) ? user.jobSeekerProfile.certifications : [];

		return res.status(200).json({
			status: "SUCCESS",
			data: {
				...user,
				jobSeekerProfile: {
					...user.jobSeekerProfile,
					experience,
					education,
					certifications,
				},
			},
		});
	} catch (error) {
		console.error("Get job seeker profile error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to fetch profile",
		});
	}
};

module.exports = { createJobSeekerProfile, getJobSeekerProfile, uploadCV, getCVs, serveCV, updateCV, deleteCV };
