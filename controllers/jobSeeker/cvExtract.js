/**
 * CV Extraction Controller (Job Seeker)
 * =======================================
 * Job seeker-facing endpoints for extracting structured data from uploaded CVs.
 *
 * Endpoints:
 *   POST /job-seeker/cv/:cvId/extract           - Extract structured data from a specific CV
 *   POST /job-seeker/cv/extract-and-fill         - Extract CV data and auto-fill ALL profile fields
 */

const { prisma } = require("../../prisma");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { extractStructuredData } = require("../ai/cvExtractor");
const { findOrCreateNormalizedSkill, normalizeSkillName, inferProficiency } = require("../ai/skillNormalizer");

const UPLOADS_ROOT = path.join(__dirname, "../../uploads");

function resolveSafeUploadPath(relativePath) {
	const abs = path.resolve(UPLOADS_ROOT, relativePath);
	if (!abs.startsWith(UPLOADS_ROOT + path.sep)) {
		throw new Error("Invalid file path");
	}
	return abs;
}

/**
 * Helper: get raw text and PDF buffer from CV record, re-extracting from file if needed.
 * Returns { rawText, pdfBuffer } where pdfBuffer may be null if text was cached.
 */
async function getRawTextAndBuffer(cv) {
	let rawText = cv.extractedText || "";
	let pdfBuffer = null;

	// Fix JSON-encoded text (legacy data stored via JSON.stringify)
	if (rawText && rawText.startsWith('"') && rawText.endsWith('"')) {
		try { rawText = JSON.parse(rawText); } catch { /* keep as-is */ }
	}

	if (cv.filePath) {
		const absPath = resolveSafeUploadPath(cv.filePath);
		pdfBuffer = await fs.readFile(absPath);

		if (!rawText) {
			const { extractTextFromPDF } = require("../ai/cvExtractor");
			rawText = await extractTextFromPDF(pdfBuffer);

			// Cache the extracted text
			await prisma.jobSeekerCV.update({
				where: { id: cv.id },
				data: { extractedText: rawText },
			});
		}
	}

	return { rawText, pdfBuffer };
}

// ---------------------------------------------------------------------------
// POST /job-seeker/cv/:cvId/extract
// ---------------------------------------------------------------------------

const extractCVData = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const cvId = req.params.cvId;

		if (!cvId) {
			return res.status(400).json({
				status: "FAIL",
				message: "cvId is required",
			});
		}

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

		const cv = await prisma.jobSeekerCV.findFirst({
			where: {
				id: cvId,
				jobSeekerId: jobSeeker.id,
			},
			select: {
				id: true,
				extractedText: true,
				extractedData: true,
				fileName: true,
				filePath: true,
				mimeType: true,
			},
		});

		if (!cv) {
			return res.status(404).json({
				status: "FAIL",
				message: "CV not found or does not belong to you",
			});
		}

		// Return cached extraction if available (unless ?force=true)
		if (cv.extractedData && req.query.force !== "true") {
			return res.status(200).json({
				status: "SUCCESS",
				message: "CV data extracted successfully (cached)",
				data: {
					cvId: cv.id,
					fileName: cv.fileName,
					extractionMethod: "cached",
					aiProvider: null,
					extracted: cv.extractedData,
				},
			});
		}

		let rawText, pdfBuffer;
		try {
			({ rawText, pdfBuffer } = await getRawTextAndBuffer(cv));
		} catch (fileErr) {
			console.error("[cvExtract] Failed to read CV file:", fileErr.message);
			return res.status(422).json({
				status: "FAIL",
				message: "Could not extract text from CV file",
			});
		}

		if (!rawText || rawText.trim().length === 0) {
			return res.status(422).json({
				status: "FAIL",
				message: "No text content found in this CV",
			});
		}

		const useAI = req.query.useAI !== "false";
		const result = await extractStructuredData(rawText, { useAI, pdfBuffer });

		if (!result.success) {
			return res.status(422).json({
				status: "FAIL",
				message: result.error || "Failed to extract structured data",
			});
		}

		// Cache the structured extraction result in DB
		await prisma.jobSeekerCV.update({
			where: { id: cv.id },
			data: { extractedData: result.data },
		});

		return res.status(200).json({
			status: "SUCCESS",
			message: "CV data extracted successfully",
			data: {
				cvId: cv.id,
				fileName: cv.fileName,
				extractionMethod: result.method,
				aiProvider: result.aiProvider || null,
				extracted: result.data,
			},
		});
	} catch (error) {
		console.error("[cvExtract] extractCVData error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to extract CV data",
		});
	}
};

// ---------------------------------------------------------------------------
// POST /job-seeker/cv/extract-and-fill
// ---------------------------------------------------------------------------
// Extracts structured data from a CV and auto-fills ALL profile fields:
// - User profile (name, phone)
// - Skills (JobSeekerSkill)
// - Experience (JobSeeker.experience JSON)
// - Education (JobSeeker.education JSON)
// - Certifications (JobSeeker.certifications JSON)

const extractAndFillProfile = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { cvId } = req.body;

		if (!cvId) {
			return res.status(400).json({
				status: "FAIL",
				message: "cvId is required in request body",
			});
		}

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: {
				id: true,
				skills: {
					include: { skill: { select: { id: true, name: true } } },
				},
			},
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
			});
		}

		const cv = await prisma.jobSeekerCV.findFirst({
			where: {
				id: cvId,
				jobSeekerId: jobSeeker.id,
			},
			select: {
				id: true,
				extractedText: true,
				extractedData: true,
				fileName: true,
				filePath: true,
			},
		});

		if (!cv) {
			return res.status(404).json({
				status: "FAIL",
				message: "CV not found or does not belong to you",
			});
		}

		// Use cached extraction if available, otherwise extract fresh
		let extractedData;
		let extractionMethod = "cached";
		let aiProvider = null;

		if (cv.extractedData) {
			extractedData = cv.extractedData;
		} else {
			let rawText, pdfBuffer;
			try {
				({ rawText, pdfBuffer } = await getRawTextAndBuffer(cv));
			} catch (fileErr) {
				console.error("[cvExtract] Failed to read CV file:", fileErr.message);
				return res.status(422).json({
					status: "FAIL",
					message: "Could not extract text from CV file",
				});
			}

			if (!rawText || rawText.trim().length === 0) {
				return res.status(422).json({
					status: "FAIL",
					message: "No text content found in this CV",
				});
			}

			const useAI = req.query.useAI !== "false";
			const result = await extractStructuredData(rawText, { useAI, pdfBuffer });

			if (!result.success) {
				return res.status(422).json({
					status: "FAIL",
					message: result.error || "Failed to extract structured data",
				});
			}

			extractedData = result.data;
			extractionMethod = result.method;
			aiProvider = result.aiProvider || null;

			// Cache extraction
			await prisma.jobSeekerCV.update({
				where: { id: cv.id },
				data: { extractedData },
			});
		}

		// Fetch existing profile data for merge logic
		const existingProfile = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: {
				experience: true,
				education: true,
				certifications: true,
				summary: true,
				languages: true,
				awards: true,
				interests: true,
			},
		});

		const autoFillResults = {
			profileUpdated: false,
			summarySaved: false,
			skillsAdded: [],
			skillsSkipped: [],
			experienceSaved: 0,
			experienceMerged: 0,
			educationSaved: 0,
			educationMerged: 0,
			certificationsSaved: 0,
			certificationsMerged: 0,
			languagesSaved: 0,
			awardsSaved: 0,
			interestsSaved: 0,
		};

		// 1) Auto-fill user profile (name, phone)
		if (extractedData.name) {
			const parts = extractedData.name.split(" ");
			const updateData = {};
			if (parts[0]) updateData.firstName = parts[0];
			if (parts.length > 1) updateData.lastName = parts.slice(1).join(" ");
			if (extractedData.phone) {
				const digits = extractedData.phone.replace(/[^\d+]/g, "");
				updateData.phoneNumber = digits.replace(/^\+\d{1,4}/, "") || digits;
			}
			if (Object.keys(updateData).length > 0) {
				await prisma.user.update({
					where: { id: userId },
					data: updateData,
				});
				autoFillResults.profileUpdated = true;
			}
		}

		// 2) Auto-fill skills (with semantic normalization)
		const totalYears = extractedData.totalYearsExperience || 0;
		if (extractedData.skills && extractedData.skills.length > 0) {
			const existingSkillIds = new Set(
				(jobSeeker.skills || []).map((s) => s.skill?.id).filter(Boolean)
			);
			const existingSkillNames = new Set(
				(jobSeeker.skills || []).map((s) => normalizeSkillName(s.skill?.name || "").toLowerCase())
			);

			for (const skillName of extractedData.skills) {
				const raw = (typeof skillName === "string" ? skillName : "").trim();
				if (!raw || raw.length < 2) continue;

				const canonical = normalizeSkillName(raw);
				if (existingSkillNames.has(canonical.toLowerCase())) {
					autoFillResults.skillsSkipped.push({
						name: raw,
						canonical,
						reason: "Already exists on profile",
					});
					continue;
				}

				const resolved = await findOrCreateNormalizedSkill(prisma, raw);
				if (!resolved) {
					autoFillResults.skillsSkipped.push({ name: raw, reason: "Could not resolve skill" });
					continue;
				}

				if (existingSkillIds.has(resolved.skillId)) {
					autoFillResults.skillsSkipped.push({ name: raw, canonical: resolved.name, reason: "Already linked" });
					continue;
				}

				try {
					const proficiency = inferProficiency(totalYears);
					await prisma.jobSeekerSkill.create({
						data: { jobSeekerId: jobSeeker.id, skillId: resolved.skillId, proficiency },
					});
					autoFillResults.skillsAdded.push({ id: resolved.skillId, name: resolved.name, proficiency });
					existingSkillIds.add(resolved.skillId);
					existingSkillNames.add(resolved.name.toLowerCase());
				} catch (linkErr) {
					autoFillResults.skillsSkipped.push({
						name: raw,
						reason: linkErr.code === "P2002" ? "Already linked" : "Failed to link",
					});
				}
			}
		}

		// 3) Auto-fill experience (MERGE with existing, don't overwrite)
		if (extractedData.experience && extractedData.experience.length > 0) {
			const existing = Array.isArray(existingProfile?.experience) ? existingProfile.experience : [];
			const merged = [...existing];

			for (const e of extractedData.experience) {
				const newTitle = (e.role || e.title || "").toLowerCase().trim();
				const newCompany = (e.company || "").toLowerCase().trim();

				// Check for duplicate by company + title match
				const matchIdx = merged.findIndex((ex) => {
					const exTitle = (ex.jobTitle || "").toLowerCase().trim();
					const exCompany = (ex.companyName || "").toLowerCase().trim();
					return (exCompany === newCompany && exTitle === newTitle) ||
						(exCompany === newCompany && (exTitle.includes(newTitle) || newTitle.includes(exTitle)));
				});

				if (matchIdx >= 0) {
					// Update existing entry with richer data (longer description wins)
					const ex = merged[matchIdx];
					const newDesc = e.description || "";
					if (newDesc.length > (ex.description || "").length) {
						ex.description = newDesc;
					}
					if (!ex.location && e.location) ex.location = e.location;
					if (!ex.startDate && e.start_date) ex.startDate = parseFlexibleDate(e.start_date);
					if (!ex.endDate && e.end_date && e.end_date !== "Present") ex.endDate = parseFlexibleDate(e.end_date);
					autoFillResults.experienceMerged++;
				} else {
					merged.push({
						id: crypto.randomUUID(),
						jobTitle: e.role || e.title || "Untitled",
						companyName: e.company || "Unknown",
						location: e.location || null,
						startDate: parseFlexibleDate(e.start_date),
						endDate: e.end_date === "Present" ? null : parseFlexibleDate(e.end_date),
						isCurrent: e.end_date === "Present" || e.isCurrent || false,
						description: e.description || null,
						createdAt: new Date().toISOString(),
					});
					autoFillResults.experienceSaved++;
				}
			}

			await prisma.jobSeeker.update({
				where: { userId },
				data: { experience: merged },
			});
		}

		// 4) Auto-fill education (MERGE with existing)
		if (extractedData.education && extractedData.education.length > 0) {
			const existing = Array.isArray(existingProfile?.education) ? existingProfile.education : [];
			const merged = [...existing];

			for (const e of extractedData.education) {
				const newInst = (e.institution || "").toLowerCase().trim();
				const newDegree = (e.degree || "").toLowerCase().trim();

				const matchIdx = merged.findIndex((ex) => {
					const exInst = (ex.institution || "").toLowerCase().trim();
					const exDegree = (ex.degree || "").toLowerCase().trim();
					return (exInst === newInst && exDegree === newDegree) ||
						(exInst === newInst && (exDegree.includes(newDegree) || newDegree.includes(exDegree)));
				});

				if (matchIdx >= 0) {
					const ex = merged[matchIdx];
					if (!ex.fieldOfStudy && (e.field || e.fieldOfStudy)) ex.fieldOfStudy = e.field || e.fieldOfStudy;
					if (!ex.grade && e.grade) ex.grade = e.grade;
					const newDesc = e.description || "";
					if (newDesc.length > (ex.description || "").length) ex.description = newDesc;
					autoFillResults.educationMerged++;
				} else {
					merged.push({
						id: crypto.randomUUID(),
						institution: e.institution || "Unknown",
						degree: e.degree || "Degree",
						fieldOfStudy: e.field || e.fieldOfStudy || null,
						startDate: parseFlexibleDate(e.start_date),
						endDate: parseFlexibleDate(e.end_date),
						isCurrent: false,
						grade: e.grade || null,
						description: e.description || null,
						createdAt: new Date().toISOString(),
					});
					autoFillResults.educationSaved++;
				}
			}

			await prisma.jobSeeker.update({
				where: { userId },
				data: { education: merged },
			});
		}

		// 5) Auto-fill certifications (MERGE with existing)
		if (extractedData.certifications && extractedData.certifications.length > 0) {
			const existing = Array.isArray(existingProfile?.certifications) ? existingProfile.certifications : [];
			const merged = [...existing];

			for (const c of extractedData.certifications) {
				const cert = typeof c === "string" ? { name: c } : c;
				const newName = (cert.name || "").toLowerCase().trim();

				const matchIdx = merged.findIndex((ex) => {
					const exName = (ex.name || "").toLowerCase().trim();
					return exName === newName || exName.includes(newName) || newName.includes(exName);
				});

				if (matchIdx >= 0) {
					const ex = merged[matchIdx];
					if ((!ex.issuingOrganization || ex.issuingOrganization === "N/A") && (cert.organization || cert.issuingOrganization)) {
						ex.issuingOrganization = cert.organization || cert.issuingOrganization;
					}
					if (!ex.issueDate && (cert.issue_date || cert.issueDate)) {
						ex.issueDate = parseFlexibleDate(cert.issue_date || cert.issueDate);
					}
					autoFillResults.certificationsMerged++;
				} else {
					merged.push({
						id: crypto.randomUUID(),
						name: cert.name || "Certification",
						issuingOrganization: cert.organization || cert.issuingOrganization || "N/A",
						issueDate: parseFlexibleDate(cert.issue_date || cert.issueDate),
						expiryDate: null,
						credentialId: null,
						credentialUrl: null,
						description: null,
						createdAt: new Date().toISOString(),
					});
					autoFillResults.certificationsSaved++;
				}
			}

			await prisma.jobSeeker.update({
				where: { userId },
				data: { certifications: merged },
			});
		}

		// 6) Save summary, languages, awards, interests to new DB fields
		const profileUpdate = {};

		if (extractedData.summary) {
			profileUpdate.summary = extractedData.summary;
			autoFillResults.summarySaved = true;
		}

		if (extractedData.languages && extractedData.languages.length > 0) {
			const langs = extractedData.languages.map((l) =>
				typeof l === "string" ? { name: l, proficiency: null } : l
			);
			// Merge with existing
			const existingLangs = Array.isArray(existingProfile?.languages) ? existingProfile.languages : [];
			const existingNames = new Set(existingLangs.map((l) => (l.name || "").toLowerCase()));
			const merged = [...existingLangs];
			for (const lang of langs) {
				if (!existingNames.has((lang.name || "").toLowerCase())) {
					merged.push(lang);
				}
			}
			profileUpdate.languages = merged;
			autoFillResults.languagesSaved = langs.length;
		}

		if (extractedData.awards && extractedData.awards.length > 0) {
			const awards = extractedData.awards.map((a) =>
				typeof a === "string" ? { title: a, issuer: null, date: null, description: null } : a
			);
			const existingAwards = Array.isArray(existingProfile?.awards) ? existingProfile.awards : [];
			const existingTitles = new Set(existingAwards.map((a) => (a.title || "").toLowerCase()));
			const merged = [...existingAwards];
			for (const award of awards) {
				if (!existingTitles.has((award.title || "").toLowerCase())) {
					merged.push(award);
				}
			}
			profileUpdate.awards = merged;
			autoFillResults.awardsSaved = awards.length;
		}

		if (extractedData.interests && extractedData.interests.length > 0) {
			const existingInterests = Array.isArray(existingProfile?.interests) ? existingProfile.interests : [];
			const existingSet = new Set(existingInterests.map((i) => (typeof i === "string" ? i : "").toLowerCase()));
			const merged = [...existingInterests];
			for (const interest of extractedData.interests) {
				if (typeof interest === "string" && !existingSet.has(interest.toLowerCase())) {
					merged.push(interest);
				}
			}
			profileUpdate.interests = merged;
			autoFillResults.interestsSaved = extractedData.interests.length;
		}

		if (Object.keys(profileUpdate).length > 0) {
			await prisma.jobSeeker.update({
				where: { userId },
				data: profileUpdate,
			});
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: "CV data extracted and profile fully updated",
			data: {
				cvId: cv.id,
				fileName: cv.fileName,
				extractionMethod,
				aiProvider,
				extracted: extractedData,
				autoFill: autoFillResults,
			},
		});
	} catch (error) {
		console.error("[cvExtract] extractAndFillProfile error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to extract and fill profile",
		});
	}
};

/**
 * Parse flexible date strings like "Jan 2020", "2020", "March 2018", "2020-01-01"
 * Returns ISO string or null.
 */
function parseFlexibleDate(dateStr) {
	if (!dateStr) return null;
	const s = String(dateStr).trim();
	if (!s) return null;

	// Already ISO
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
		const d = new Date(s);
		return isNaN(d.getTime()) ? null : d.toISOString();
	}

	// Year only: "2020"
	if (/^\d{4}$/.test(s)) {
		return new Date(`${s}-01-01`).toISOString();
	}

	// Month Year: "Jan 2020", "January 2020"
	const d = new Date(s);
	if (!isNaN(d.getTime())) {
		return d.toISOString();
	}

	return null;
}

module.exports = {
	extractCVData,
	extractAndFillProfile,
};
