// suggestJobsForJobSeeker.prisma.js
const { prisma } = require("../../prisma");

// ---------------------------------------------------------------------------
// AI-powered profile understanding via Claude
// ---------------------------------------------------------------------------

/**
 * Build a text summary of the job seeker's full profile for the AI prompt.
 */
function buildProfileSummary({ seekerSkills, cvText, experience, education, summary, certifications, languages, interests }) {
	const parts = [];

	if (summary) parts.push(`PROFESSIONAL SUMMARY:\n${summary}`);

	if (seekerSkills.length) parts.push(`SKILLS:\n${seekerSkills.join(", ")}`);

	if (Array.isArray(experience) && experience.length) {
		const expLines = experience.map((e) => {
			const period = [e.startDate, e.isCurrent ? "Present" : e.endDate].filter(Boolean).join(" - ");
			return `- ${e.jobTitle || "Untitled"} at ${e.companyName || "Unknown"} (${period})${e.description ? "\n  " + e.description.slice(0, 300) : ""}`;
		});
		parts.push(`EXPERIENCE:\n${expLines.join("\n")}`);
	}

	if (Array.isArray(education) && education.length) {
		const eduLines = education.map((e) => `- ${e.degree || ""} ${e.fieldOfStudy || ""} at ${e.institution || "Unknown"}`);
		parts.push(`EDUCATION:\n${eduLines.join("\n")}`);
	}

	if (Array.isArray(certifications) && certifications.length) {
		const certLines = certifications.map((c) => `- ${c.name || "Untitled"}${c.issuingOrganization ? " (" + c.issuingOrganization + ")" : ""}`);
		parts.push(`CERTIFICATIONS:\n${certLines.join("\n")}`);
	}

	if (Array.isArray(languages) && languages.length) {
		const langLines = languages.map((l) => `${l.name || l}${l.proficiency ? " (" + l.proficiency + ")" : ""}`);
		parts.push(`LANGUAGES: ${langLines.join(", ")}`);
	}

	if (Array.isArray(interests) && interests.length) {
		parts.push(`INTERESTS: ${interests.join(", ")}`);
	}

	if (cvText) parts.push(`CV TEXT (excerpt):\n${cvText.slice(0, 2000)}`);

	return parts.join("\n\n");
}

/**
 * Call Claude to analyse the job seeker profile and return structured
 * preferences for job matching.  Falls back to null on any error.
 */
async function getAiJobPreferences(profileData) {
	if (!process.env.ANTHROPIC_API_KEY) return null;

	try {
		const Anthropic = require("@anthropic-ai/sdk");
		const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

		const profileText = buildProfileSummary(profileData);
		if (!profileText || profileText.length < 30) return null;

		const response = await client.messages.create({
			model: "claude-sonnet-4-20250514",
			max_tokens: 1024,
			messages: [
				{
					role: "user",
					content: `You are a job-matching expert. Analyse the following job seeker profile and return a JSON object with your best guesses for what jobs would suit them.

PROFILE:
${profileText}

Return ONLY valid JSON (no markdown fences) with this exact structure:
{
  "titles": ["<up to 10 relevant job titles they should search for>"],
  "industries": ["<up to 8 relevant industry names>"],
  "inferredSkills": ["<up to 15 skills they likely have but did not explicitly list>"],
  "experienceLevel": "<one of: Entry, Junior, Mid, Senior, Lead, Executive>",
  "preferredTypes": ["<from: FULL_TIME, PART_TIME, CONTRACT, FREELANCE, INTERNSHIP>"]
}

Be specific and practical. Base your answer only on the profile data provided.`,
				},
			],
		});

		const text = (response.content?.[0]?.text || "").trim();
		// Strip markdown fences if present
		const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
		const parsed = JSON.parse(jsonStr);

		// Validate structure
		return {
			titles: Array.isArray(parsed.titles) ? parsed.titles.map(String).slice(0, 10) : [],
			industries: Array.isArray(parsed.industries) ? parsed.industries.map(String).slice(0, 8) : [],
			inferredSkills: Array.isArray(parsed.inferredSkills) ? parsed.inferredSkills.map(String).slice(0, 15) : [],
			experienceLevel: typeof parsed.experienceLevel === "string" ? parsed.experienceLevel : null,
			preferredTypes: Array.isArray(parsed.preferredTypes) ? parsed.preferredTypes.map(String).slice(0, 5) : [],
		};
	} catch (err) {
		console.log("[suggestJobs] AI preferences call failed, falling back to keyword matching:", err.message);
		return null;
	}
}

const DEFAULT_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"for",
	"from",
	"has",
	"have",
	"he",
	"her",
	"his",
	"i",
	"in",
	"is",
	"it",
	"its",
	"me",
	"my",
	"not",
	"of",
	"on",
	"or",
	"our",
	"she",
	"so",
	"that",
	"the",
	"their",
	"them",
	"they",
	"this",
	"to",
	"was",
	"we",
	"were",
	"with",
	"you",
	"your",
	"responsible",
	"responsibilities",
	"experience",
	"skill",
	"skills",
	"ability",
	"worked",
	"work",
	"team",
	"teams",
	"project",
	"projects",
	"year",
	"years",
]);

function normalizeText(s = "") {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9\s+#.]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenize(s = "") {
	const t = normalizeText(s);
	return t ? t.split(" ").filter(Boolean) : [];
}

function extractKeywords(text, { maxKeywords = 30, stopwords = DEFAULT_STOPWORDS } = {}) {
	const tokens = tokenize(text)
		.filter((w) => w.length >= 2)
		.filter((w) => !stopwords.has(w));

	const freq = new Map();
	for (const w of tokens) freq.set(w, (freq.get(w) || 0) + 1);

	return [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, maxKeywords)
		.map(([w]) => w);
}

function daysBetween(a, b) {
	const ms = Math.abs(a.getTime() - b.getTime());
	return ms / (1000 * 60 * 60 * 24);
}

function scoreJob({ job, seekerSkillSet, keywordSet, weights, aiPrefs = null }) {
	const w = {
		skillMatch: 10,
		keywordMatch: 2,
		titleKeywordBonus: 2,
		recencyMaxBoost: 8,
		recencyHalfLifeDays: 14,
		aiTitleMatch: 8,
		aiIndustryMatch: 5,
		aiInferredSkillMatch: 4,
		aiExperienceLevelMatch: 3,
		...weights,
	};

	const jobSkillNames = (job.skills || [])
		.map((js) => js.skill?.name)
		.filter(Boolean)
		.map((s) => s.toLowerCase());

	const matchedSkills = jobSkillNames.filter((s) => seekerSkillSet.has(s));
	const skillScore = matchedSkills.length * w.skillMatch;

	const hayTitle = normalizeText(job.title || "");
	const hayDesc = normalizeText(job.description || "");
	let keywordHits = 0;
	let titleHits = 0;

	for (const kw of keywordSet) {
		if (hayTitle.includes(kw)) {
			keywordHits += 1;
			titleHits += 1;
		} else if (hayDesc.includes(kw)) {
			keywordHits += 1;
		}
	}

	const keywordScore = keywordHits * w.keywordMatch + titleHits * w.titleKeywordBonus;

	const ageDays = daysBetween(new Date(), new Date(job.createdAt));
	const decay = Math.pow(0.5, ageDays / w.recencyHalfLifeDays);
	const recencyScore = w.recencyMaxBoost * decay;

	// --- AI preference bonuses ---
	let aiScore = 0;
	let aiTitleMatches = [];
	let aiIndustryMatches = [];
	let aiInferredSkillMatches = [];

	if (aiPrefs) {
		// Title match: check if any AI-suggested title appears in the job title
		for (const aiTitle of aiPrefs.titles || []) {
			const normAiTitle = normalizeText(aiTitle);
			if (normAiTitle && hayTitle.includes(normAiTitle)) {
				aiScore += w.aiTitleMatch;
				aiTitleMatches.push(aiTitle);
			}
		}

		// Industry match: check job industries against AI-suggested industries
		const jobIndustryNames = (job.industries || [])
			.map((ji) => ji.industry?.name)
			.filter(Boolean)
			.map((s) => s.toLowerCase());
		for (const aiInd of aiPrefs.industries || []) {
			const normInd = aiInd.toLowerCase();
			if (jobIndustryNames.some((ji) => ji.includes(normInd) || normInd.includes(ji))) {
				aiScore += w.aiIndustryMatch;
				aiIndustryMatches.push(aiInd);
			}
		}

		// Inferred skill match: skills the AI thinks the seeker has but didn't list
		for (const aiSkill of aiPrefs.inferredSkills || []) {
			const normSkill = aiSkill.toLowerCase();
			if (jobSkillNames.some((js) => js === normSkill || js.includes(normSkill) || normSkill.includes(js))) {
				aiScore += w.aiInferredSkillMatch;
				aiInferredSkillMatches.push(aiSkill);
			}
		}

		// Experience level match
		if (aiPrefs.experienceLevel && job.experienceLevel) {
			if (normalizeText(job.experienceLevel).includes(normalizeText(aiPrefs.experienceLevel))) {
				aiScore += w.aiExperienceLevelMatch;
			}
		}
	}

	const total = skillScore + keywordScore + recencyScore + aiScore;

	return { total, matchedSkills, keywordHits, titleHits, ageDays, aiScore, aiTitleMatches, aiIndustryMatches, aiInferredSkillMatches };
}

/** ✅ NEW: score a job seeker against a job (reverse matching) */
function scoreJobSeekerForJob({ jobSkillSet, jobKeywordSet, jobSeekerSkills, cvText, weights }) {
	const w = {
		skillMatch: 10,
		keywordMatch: 2,
		...weights,
	};

	const seekerSkillSet = new Set((jobSeekerSkills || []).map((s) => (s || "").toLowerCase()));

	const matchedSkills = [...jobSkillSet].filter((s) => seekerSkillSet.has(s));
	const skillScore = matchedSkills.length * w.skillMatch;

	const hay = normalizeText(cvText || "");
	let keywordHits = 0;
	for (const kw of jobKeywordSet) {
		if (hay.includes(kw)) keywordHits += 1;
	}
	const keywordScore = keywordHits * w.keywordMatch;

	const total = skillScore + keywordScore;
	return { total, matchedSkills, keywordHits };
}

async function handlesuggestJobsForJobSeeker(prisma, jobSeekerUserId, opts = {}) {
	const {
		page = 1,
		limit = 20,

		cvId = null,
		candidatePool = 300,
		keywordMax = 30,
		minSkillMatches = 1,
		extraText = "",
		weights = {},
	} = opts;

	const safePage = Math.max(1, parseInt(page, 10) || 1);
	const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));

	const jobSeeker = await prisma.jobSeeker.findUnique({
		where: { userId: jobSeekerUserId },
		select: {
			id: true,
			skills: { select: { skill: { select: { name: true } } } },
			experience: true,
			education: true,
			summary: true,
			certifications: true,
			languages: true,
			interests: true,
		},
	});

	if (!jobSeeker) {
		return {
			jobs: [],
			pagination: { total: 0, page: safePage, limit: safeLimit, totalPages: 0 },
			meta: { error: "Job seeker not found" },
		};
	}

	const seekerSkills = (jobSeeker.skills || []).map((s) => s.skill?.name).filter(Boolean);
	const seekerSkillSet = new Set(seekerSkills.map((s) => s.toLowerCase()));

	let pickedCv = null;

	if (cvId) {
		pickedCv = await prisma.jobSeekerCV.findFirst({
			where: { id: cvId, jobSeekerId: jobSeeker.id },
			select: {
				id: true,
				extractedText: true,
				industryId: true,
				fileName: true,
				isPrimary: true,
				createdAt: true,
			},
		});

		if (!pickedCv) {
			return {
				jobs: [],
				pagination: { total: 0, page: safePage, limit: safeLimit, totalPages: 0 },
				meta: { error: "CV not found for this job seeker" },
			};
		}
	} else {
		pickedCv = await prisma.jobSeekerCV.findFirst({
			where: { jobSeekerId: jobSeeker.id },
			orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
			select: {
				id: true,
				extractedText: true,
				industryId: true,
				fileName: true,
				isPrimary: true,
				createdAt: true,
			},
		});
	}

	const cvText = pickedCv?.extractedText || "";
	const keywords = extractKeywords(`${cvText}\n${extraText}`, { maxKeywords: keywordMax });
	const keywordSet = new Set(keywords);

	// --- AI-powered profile understanding ---
	const aiPrefs = await getAiJobPreferences({
		seekerSkills,
		cvText,
		experience: jobSeeker.experience,
		education: jobSeeker.education,
		summary: jobSeeker.summary,
		certifications: jobSeeker.certifications,
		languages: jobSeeker.languages,
		interests: jobSeeker.interests,
	});

	// Merge AI-inferred skills into the seeker skill set for broader matching
	const allSkillNames = [...seekerSkills];
	if (aiPrefs?.inferredSkills?.length) {
		for (const s of aiPrefs.inferredSkills) {
			const lower = s.toLowerCase();
			if (!seekerSkillSet.has(lower)) {
				allSkillNames.push(s);
				// Don't add to seekerSkillSet — keep it for "explicit skill" scoring only
			}
		}
	}

	// --- Build smarter DB query using AI preferences ---
	const orConditions = [];

	// Condition 1: jobs matching seeker's explicit skills (original behaviour)
	if (seekerSkills.length && minSkillMatches > 0) {
		orConditions.push({
			skills: {
				some: {
					skill: { name: { in: seekerSkills } },
				},
			},
		});
	}

	// Condition 2: jobs matching AI-inferred skills
	if (aiPrefs?.inferredSkills?.length) {
		orConditions.push({
			skills: {
				some: {
					skill: { name: { in: aiPrefs.inferredSkills, mode: "insensitive" } },
				},
			},
		});
	}

	// Condition 3: jobs with titles matching AI-suggested titles
	if (aiPrefs?.titles?.length) {
		for (const title of aiPrefs.titles) {
			orConditions.push({
				title: { contains: title, mode: "insensitive" },
			});
		}
	}

	// Condition 4: jobs in AI-suggested industries
	if (aiPrefs?.industries?.length) {
		orConditions.push({
			industries: {
				some: {
					industry: { name: { in: aiPrefs.industries, mode: "insensitive" } },
				},
			},
		});
	}

	const whereClause = {
		status: "PUBLISHED",
		...(orConditions.length > 0 ? { OR: orConditions } : {}),
	};

	const candidates = await prisma.job.findMany({
		where: whereClause,
		orderBy: { createdAt: "desc" },
		take: candidatePool,
		include: {
			company: { select: { id: true, name: true, country: true } },
			skills: { include: { skill: true } },
			industries: { include: { industry: true } },
		},
	});

	const scored = candidates.map((job) => {
		const s = scoreJob({ job, seekerSkillSet, keywordSet, weights, aiPrefs });
		return { job, score: s.total, debug: s };
	});

	scored.sort((a, b) => b.score - a.score);

	const total = scored.length;
	const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);
	const pageClamped = totalPages === 0 ? 1 : Math.min(safePage, totalPages);

	const start = (pageClamped - 1) * safeLimit;
	const end = start + safeLimit;

	const pageItems = scored.slice(start, end).map((x) => ({
		...x.job,
		recommendation: {
			score: Number(x.score.toFixed(2)),
			matchedSkills: x.debug.matchedSkills.slice(0, 10),
			keywordHits: x.debug.keywordHits,
			titleHits: x.debug.titleHits,
			ageDays: Number(x.debug.ageDays.toFixed(1)),
			aiScore: x.debug.aiScore || 0,
			aiTitleMatches: x.debug.aiTitleMatches || [],
			aiIndustryMatches: x.debug.aiIndustryMatches || [],
			aiInferredSkillMatches: x.debug.aiInferredSkillMatches || [],
			cvUsed: pickedCv ? { id: pickedCv.id, isPrimary: pickedCv.isPrimary, fileName: pickedCv.fileName, createdAt: pickedCv.createdAt } : null,
		},
	}));

	return {
		jobs: pageItems,
		pagination: { total, page: pageClamped, limit: safeLimit, totalPages },
		meta: {
			seekerSkillsCount: seekerSkills.length,
			candidatesFetched: candidates.length,
			keywordsUsed: keywords.slice(0, 20),
			cvPicked: pickedCv ? { id: pickedCv.id, industryId: pickedCv.industryId, fileName: pickedCv.fileName } : null,
			returned: pageItems.length,
			aiEnhanced: !!aiPrefs,
			aiPreferences: aiPrefs || null,
		},
	};
}

/**
 * ✅ NEW: Recruiter asks: for THIS job, which job seekers would it be suggested to?
 * Computes on the fly.
 */
async function handleSuggestJobSeekersForRecruiter(prisma, companyId, jobId, opts = {}) {
	const {
		page = 1,
		limit = 20,

		keywordMax = 30,
		batchSize = 300, // scan seekers in batches
		weights = {},
	} = opts;

	const safePage = Math.max(1, parseInt(page, 10) || 1);
	const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));

	// 1) Validate recruiter owns this job + load job details
	const job = await prisma.job.findFirst({
		where: { id: jobId, companyId, status: "PUBLISHED" },
		select: {
			id: true,
			title: true,
			description: true,
			createdAt: true,
			skills: { select: { skill: { select: { name: true } } } },
		},
	});

	if (!job) {
		return {
			jobSeekers: [],
			pagination: { total: 0, page: safePage, limit: safeLimit, totalPages: 0 },
			meta: { error: "Job not found or access denied" },
		};
	}

	const jobSkills = (job.skills || []).map((s) => s.skill?.name).filter(Boolean);
	const jobSkillSet = new Set(jobSkills.map((s) => s.toLowerCase()));

	const jobKeywords = extractKeywords(`${job.title || ""}\n${job.description || ""}`, { maxKeywords: keywordMax });
	const jobKeywordSet = new Set(jobKeywords);

	// 2) Scan job seekers in batches and score them
	let skip = 0;
	const scored = [];

	while (true) {
		const seekers = await prisma.jobSeeker.findMany({
			skip,
			take: batchSize,
			orderBy: { createdAt: "desc" },
			select: {
				id: true,
				createdAt: true,
				user: { select: { id: true, firstName: true, lastName: true, email: true, phoneNumber: true, countryCode: true } },
				skills: {
					select: {
						id: true,
						proficiency: true,
						skill: {
							select: {
								id: true,
								name: true,
							},
						},
					},
				},
				cvs: {
					orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
					take: 1,
					select: { id: true, extractedText: true, fileName: true, isPrimary: true, createdAt: true },
				},
			},
		});

		if (!seekers.length) break;

		for (const s of seekers) {
			const seekerSkills = (s.skills || []).map((x) => x.skill?.name).filter(Boolean);
			const cv = s.cvs?.[0] || null;
			const cvText = cv?.extractedText || "";

			// quick prune: if no overlap + no cv text, skip
			const hasSkillOverlap = jobSkillSet.size === 0 ? false : seekerSkills.some((sk) => jobSkillSet.has((sk || "").toLowerCase()));

			if (!hasSkillOverlap && !cvText) continue;

			const sc = scoreJobSeekerForJob({
				jobSkillSet,
				jobKeywordSet,
				jobSeekerSkills: seekerSkills,
				cvText,
				weights,
			});

			if (sc.total <= 0) continue;

			scored.push({
				jobSeeker: {
					id: s.id,
					createdAt: s.createdAt,
					user: s.user,
					skills: s.skills || [],
					cvUsed: cv ? { id: cv.id, fileName: cv.fileName, isPrimary: cv.isPrimary, createdAt: cv.createdAt } : null,
				},
				recommendation: {
					score: Number(sc.total.toFixed(2)),
					matchedSkills: sc.matchedSkills.slice(0, 10),
					keywordHits: sc.keywordHits,
				},
			});
		}

		skip += seekers.length;
	}

	// 3) Sort + paginate
	scored.sort((a, b) => b.recommendation.score - a.recommendation.score);

	const total = scored.length;
	const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);
	const pageClamped = totalPages === 0 ? 1 : Math.min(safePage, totalPages);

	const start = (pageClamped - 1) * safeLimit;
	const end = start + safeLimit;

	return {
		job: { id: job.id, title: job.title, createdAt: job.createdAt },
		jobSkills,
		jobSeekers: scored.slice(start, end),
		pagination: { total, page: pageClamped, limit: safeLimit, totalPages },
		meta: {
			keywordsUsed: jobKeywords.slice(0, 20),
			returned: Math.min(safeLimit, Math.max(0, total - start)),
		},
	};
}

const suggestJobsForJobSeeker = async (req, res) => {
	try {
		const userId = req.user?.userId;

		const page = req.query.page;
		const limit = req.query.limit;
		const q = req.query.q || "";
		const cvId = req.query.cv || null;

		const result = await handlesuggestJobsForJobSeeker(prisma, userId, {
			page,
			limit,
			extraText: q,
			cvId,
		});

		if (result?.meta?.error === "CV not found for this job seeker") {
			return res.status(404).json({ status: "FAIL", message: result });
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: result,
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			status: "FAIL",
			message: "Something went wrong",
		});
	}
};

/**
 * ✅ NEW controller: recruiter gets job seekers suggested for a job
 * Route idea: GET /recruiter/jobs/:jobId/suggested-job-seekers?page=1&limit=20
 */
const suggestJobSeekers = async (req, res) => {
	try {
		const companyId = req.user?.profile?.recruiter?.companyId;
		const jobId = req.params.jobId;

		if (!companyId) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: recruiter company not found",
			});
		}

		const page = req.query.page;
		const limit = req.query.limit;

		const result = await handleSuggestJobSeekersForRecruiter(prisma, companyId, jobId, {
			page,
			limit,
		});

		if (result?.meta?.error === "Job not found or access denied") {
			return res.status(404).json({ status: "FAIL", message: result });
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: result,
		});
	} catch (error) {
		console.log(error);
		return res.status(500).json({
			status: "FAIL",
			message: "Something went wrong",
		});
	}
};

module.exports = { suggestJobsForJobSeeker, suggestJobSeekers };
