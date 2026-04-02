/**
 * AI Job Parser Controller
 * ========================
 * Accepts PDF/DOCX file uploads containing job descriptions,
 * extracts structured data using Claude AI, matches skills/industries
 * to existing DB records, and returns pre-populated job creation data.
 *
 * Endpoints:
 *   POST /recruiter/ai-jobs/parse     - Parse uploaded files
 *   POST /recruiter/ai-jobs/publish   - Publish one or more parsed jobs
 */

const Anthropic = require("@anthropic-ai/sdk");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { prisma } = require("../../prisma");

const anthropic = new Anthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---------------------------------------------------------------------------
// Text extraction from PDF / DOCX buffers
// ---------------------------------------------------------------------------

async function extractTextFromPdf(buffer) {
	const data = await pdfParse(buffer);
	return cleanText(data.text);
}

async function extractTextFromDocx(buffer) {
	const result = await mammoth.extractRawText({ buffer });
	return cleanText(result.value);
}

function cleanText(text) {
	return text
		.replace(/\n{3,}/g, "\n\n")
		.replace(/ {2,}/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Claude AI extraction — structured job data from raw text
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a job description parser. Extract structured job data from the provided text.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "title": "Job title",
  "description": "Full job description text suitable for a job posting. Include responsibilities, requirements, about the company, and benefits. Format with paragraphs.",
  "employmentType": "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERNSHIP" | "TEMPORARY",
  "experienceLevel": "Junior" | "Mid" | "Senior" | "Lead" | "Executive" | null,
  "isRemote": true | false,
  "locationName": "City, Country" or null if remote,
  "minSalary": number or null (annual, convert hourly to annual if needed: hourly * 2080),
  "maxSalary": number or null (annual, convert hourly to annual if needed: hourly * 2080),
  "currency": "USD" | "CAD" | "AED" | "GBP" | "EUR" etc. or null,
  "vacancies": number (default 1),
  "skills": ["skill1", "skill2", ...] (ALL mentioned technical skills, tools, frameworks, certifications, software - max 15),
  "industries": ["industry1", "industry2"] (broad industry categories like "Information Technology", "Healthcare", "Banking", "Marketing" - max 3),
  "company": "Company name" or null
}

Rules:
- For employmentType: "contract" → "CONTRACT", "part-time" → "PART_TIME", "full-time/permanent" → "FULL_TIME", "internship" → "INTERNSHIP", "temporary/temp" → "TEMPORARY"
- Convert hourly wages to annual (hourly × 2080). Keep monthly × 12.
- For salary ranges like "From $25/hour", use that as minSalary only.
- Extract ALL skills mentioned: programming languages, frameworks, tools, certifications, software, methodologies.
- For industries, use broad categories. A dental job is "Healthcare". A developer job is "Information Technology".
- If hybrid/onsite, isRemote = false and include the city in locationName.
- description should be a clean, professional job posting text.`;

async function parseJobWithClaude(rawText) {
	const response = await anthropic.messages.create({
		model: "claude-haiku-4-5-20251001",
		max_tokens: 2000,
		messages: [
			{
				role: "user",
				content: `${EXTRACTION_PROMPT}\n\n--- JOB DESCRIPTION TEXT ---\n${rawText.substring(0, 8000)}`,
			},
		],
	});

	const content = response.content[0]?.text || "";
	// Strip any markdown fences if present
	const jsonStr = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
	return JSON.parse(jsonStr);
}

// ---------------------------------------------------------------------------
// Skill & Industry matching — fuzzy match extracted names to DB records
// ---------------------------------------------------------------------------

async function matchSkillsToDb(skillNames) {
	if (!skillNames || skillNames.length === 0) return [];

	const matched = [];
	for (const name of skillNames) {
		// Try exact match first (case-insensitive)
		let skill = await prisma.skill.findFirst({
			where: { name: { equals: name, mode: "insensitive" } },
			select: { id: true, name: true },
		});

		// Try contains match
		if (!skill) {
			skill = await prisma.skill.findFirst({
				where: { name: { contains: name, mode: "insensitive" } },
				select: { id: true, name: true },
			});
		}

		// Try the reverse — skill name contained in the extracted name
		if (!skill && name.length > 3) {
			skill = await prisma.skill.findFirst({
				where: { name: { contains: name.substring(0, 4), mode: "insensitive" } },
				select: { id: true, name: true },
			});
		}

		if (skill) {
			matched.push(skill);
		} else {
			// Create the skill if it doesn't exist
			try {
				const created = await prisma.skill.create({
					data: { name },
					select: { id: true, name: true },
				});
				matched.push(created);
			} catch (err) {
				// Unique constraint — try finding again
				const existing = await prisma.skill.findFirst({
					where: { name: { equals: name, mode: "insensitive" } },
					select: { id: true, name: true },
				});
				if (existing) matched.push(existing);
			}
		}
	}

	// Deduplicate by id
	const seen = new Set();
	return matched.filter((s) => {
		if (seen.has(s.id)) return false;
		seen.add(s.id);
		return true;
	});
}

// Use SIC-like canonical taxonomy for better industry matching
const { matchIndustriesToDb: taxonomyMatchIndustries } = require("../ai/industryTaxonomy");

async function matchIndustriesToDb(industryNames) {
	return taxonomyMatchIndustries(industryNames);
}

// ---------------------------------------------------------------------------
// POST /recruiter/ai-jobs/parse
// ---------------------------------------------------------------------------
// Accepts multipart file upload (multiple PDF/DOCX files).
// Returns parsed + matched job data for each file.

const parseJobFiles = async (req, res) => {
	try {
		const files = req.files;
		if (!files || files.length === 0) {
			return res.status(400).json({
				status: "FAIL",
				message: "No files uploaded. Please upload PDF or DOCX files.",
			});
		}

		const results = [];
		const errors = [];

		for (const file of files) {
			try {
				const ext = (file.originalname || "").toLowerCase();
				let rawText;

				if (ext.endsWith(".pdf") || file.mimetype === "application/pdf") {
					rawText = await extractTextFromPdf(file.buffer);
				} else if (
					ext.endsWith(".docx") ||
					file.mimetype ===
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
				) {
					rawText = await extractTextFromDocx(file.buffer);
				} else {
					errors.push({
						fileName: file.originalname,
						error: "Unsupported file type. Only PDF and DOCX are supported.",
					});
					continue;
				}

				if (!rawText || rawText.length < 50) {
					errors.push({
						fileName: file.originalname,
						error: "Could not extract sufficient text from file.",
					});
					continue;
				}

				// Extract structured data with Claude
				const parsed = await parseJobWithClaude(rawText);

				// Match skills and industries to DB
				const [matchedSkills, matchedIndustries] = await Promise.all([
					matchSkillsToDb(parsed.skills || []),
					matchIndustriesToDb(parsed.industries || []),
				]);

				// Normalize employmentType — Claude may return an array
				let empType = parsed.employmentType || "FULL_TIME";
				if (Array.isArray(empType)) empType = empType[0] || "FULL_TIME";
				const validTypes = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"];
				if (!validTypes.includes(empType)) empType = "FULL_TIME";

				results.push({
					fileName: file.originalname,
					parsed: {
						title: parsed.title || "Untitled Position",
						description: parsed.description || rawText.substring(0, 2000),
						employmentType: empType,
						experienceLevel: parsed.experienceLevel || null,
						isRemote: parsed.isRemote || false,
						locationName: parsed.locationName || null,
						minSalary: parsed.minSalary || null,
						maxSalary: parsed.maxSalary || null,
						currency: parsed.currency || null,
						vacancies: parsed.vacancies || 1,
						company: parsed.company || null,
					},
					matchedSkills,
					matchedIndustries,
					rawSkills: parsed.skills || [],
					rawIndustries: parsed.industries || [],
				});
			} catch (err) {
				console.error(`[aiJobParser] Error parsing ${file.originalname}:`, err.message);
				errors.push({
					fileName: file.originalname,
					error: `Failed to parse: ${err.message}`,
				});
			}
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: {
				parsed: results,
				errors,
				totalFiles: files.length,
				successCount: results.length,
				errorCount: errors.length,
			},
		});
	} catch (error) {
		console.error("[aiJobParser] parseJobFiles error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to parse job files",
		});
	}
};

// ---------------------------------------------------------------------------
// POST /recruiter/ai-jobs/publish
// ---------------------------------------------------------------------------
// Accepts an array of job data objects and creates them as DRAFT jobs
// tied to the recruiter's company. Optionally publishes them.

const publishParsedJobs = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const { jobs, publishImmediately } = req.body;

		if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
			return res.status(400).json({
				status: "FAIL",
				message: "No jobs provided.",
			});
		}

		// Get recruiter profile
		const recruiterProfile = await prisma.recruiterProfile.findFirst({
			where: { userId },
			select: { id: true, companyId: true, isApproved: true, status: true },
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
				message: "Your recruiter account is not active or approved.",
			});
		}

		const created = [];
		const errors = [];

		for (const jobData of jobs) {
			try {
				// Validate minimum required fields
				if (!jobData.title || !jobData.description) {
					errors.push({
						title: jobData.title || "Unknown",
						error: "Title and description are required",
					});
					continue;
				}

				if (!jobData.skills || jobData.skills.length === 0) {
					errors.push({
						title: jobData.title,
						error: "At least one skill is required",
					});
					continue;
				}

				if (!jobData.industries || jobData.industries.length === 0) {
					errors.push({
						title: jobData.title,
						error: "At least one industry is required",
					});
					continue;
				}

				const status = publishImmediately ? "PUBLISHED" : "DRAFT";

				const job = await prisma.job.create({
					data: {
						title: jobData.title,
						description: jobData.description,
						employmentType: jobData.employmentType || "FULL_TIME",
						experienceLevel: jobData.experienceLevel || null,
						isRemote: jobData.isRemote || false,
						locationName: jobData.isRemote ? null : (jobData.locationName || null),
						latitude: jobData.isRemote ? null : (jobData.latitude || null),
						longitude: jobData.isRemote ? null : (jobData.longitude || null),
						minSalary: jobData.minSalary || null,
						maxSalary: jobData.maxSalary || null,
						currency: jobData.currency || null,
						showSalary: !!(jobData.minSalary || jobData.maxSalary),
						vacancies: jobData.vacancies || 1,
						status,
						publishedAt: publishImmediately ? new Date() : null,
						companyId: recruiterProfile.companyId,
						recruiterProfileId: recruiterProfile.id,
						source: "PLATFORM",
						skills: {
							create: jobData.skills.map((skillId) => ({ skillId })),
						},
						industries: {
							create: jobData.industries.map((industryId) => ({ industryId })),
						},
					},
					include: {
						skills: { include: { skill: true } },
						industries: { include: { industry: true } },
					},
				});

				created.push(job);
			} catch (err) {
				console.error(`[aiJobParser] Error creating job ${jobData.title}:`, err.message);
				errors.push({
					title: jobData.title || "Unknown",
					error: err.message,
				});
			}
		}

		return res.status(201).json({
			status: "SUCCESS",
			message: {
				created,
				errors,
				totalRequested: jobs.length,
				successCount: created.length,
				errorCount: errors.length,
			},
		});
	} catch (error) {
		console.error("[aiJobParser] publishParsedJobs error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to publish jobs",
		});
	}
};

module.exports = {
	parseJobFiles,
	publishParsedJobs,
};
