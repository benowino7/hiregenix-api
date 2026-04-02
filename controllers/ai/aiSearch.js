/**
 * AI-Powered Job Search
 * =====================
 * Uses Claude to understand search intent and find the most relevant jobs.
 * Results are ranked by relevance: title > industry > skills > description.
 *
 * Flow:
 *   1. User types a search query (e.g. "banking", "remote react developer")
 *   2. Claude analyzes the query and extracts: job titles, industries, skills,
 *      employment type, location hints, experience level, remote preference
 *   3. We fetch matching jobs using broad OR conditions
 *   4. Score each job by relevance and return sorted results
 */

const Anthropic = require("@anthropic-ai/sdk");
const { prisma } = require("../../prisma");

const anthropic = new Anthropic();

/**
 * Ask Claude to interpret a search query and return structured filters.
 */
async function interpretSearchQuery(query) {
	const response = await anthropic.messages.create({
		model: "claude-sonnet-4-20250514",
		max_tokens: 500,
		messages: [
			{
				role: "user",
				content: `You are a job search assistant. Given a user's search query, extract structured search filters.

CRITICAL RULES:
1. The user's exact search term must ALWAYS appear first in jobTitles and keywords.
2. Only add CLOSELY related job titles - do NOT add loosely related roles.
   Example: "Finance Manager" should NOT include "Marketing Manager" or "Sales Manager".
   "Finance Manager" SHOULD include "Financial Manager", "Finance Director", "Senior Finance Manager".
3. For industries, only include the specific industry the search term belongs to.
4. For skills, only include skills directly required for the searched role - NOT generic skills like "Management" or "Leadership" unless the search is specifically for those.
5. Keep lists short and precise (max 5 items each). Quality over quantity.

Search query: "${query}"

Return a JSON object:
{
  "jobTitles": ["exact search term first, then 3-4 closely related titles ONLY"],
  "industries": ["specific industry only, max 2-3"],
  "skills": ["role-specific skills only, max 4-5, NO generic terms"],
  "employmentType": null or one of "FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY",
  "location": null or location string,
  "isRemote": null or true,
  "experienceLevel": null or "Junior", "Mid", "Senior", "Lead", "Executive",
  "keywords": ["original search term first, then 1-2 key variations"]
}

Examples:
- "Finance Manager" → jobTitles: ["Finance Manager", "Financial Manager", "Finance Director", "Senior Finance Manager"], industries: ["Finance", "Banking"], skills: ["Financial Planning", "Budgeting", "Financial Reporting", "Financial Analysis"], keywords: ["finance manager", "finance"]
- "Accounting Manager" → jobTitles: ["Accounting Manager", "Senior Accountant", "Accounts Manager", "Head of Accounting"], industries: ["Accounting", "Finance"], skills: ["Accounting", "Financial Reporting", "Audit", "Tax"], keywords: ["accounting manager", "accounting"]
- "react developer" → jobTitles: ["React Developer", "Frontend Developer", "React Engineer"], industries: ["Software Engineering", "Technology"], skills: ["React", "JavaScript", "TypeScript", "Frontend"], keywords: ["react developer", "react"]

Return ONLY the JSON object, no other text.`,
			},
		],
	});

	const text = response.content[0].text.trim();
	const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
	return JSON.parse(jsonStr);
}

/**
 * Build Prisma WHERE conditions from AI-extracted filters.
 */
function buildSearchConditions(aiFilters, rawQuery) {
	const orConditions = [];

	// Search raw query across key fields
	if (rawQuery) {
		orConditions.push({ title: { contains: rawQuery, mode: "insensitive" } });
		orConditions.push({ description: { contains: rawQuery, mode: "insensitive" } });
		orConditions.push({ company: { name: { contains: rawQuery, mode: "insensitive" } } });
		orConditions.push({ skills: { some: { skill: { name: { contains: rawQuery, mode: "insensitive" } } } } });
		orConditions.push({ industries: { some: { industry: { name: { contains: rawQuery, mode: "insensitive" } } } } });
	}

	// Match job titles against title field
	for (const title of aiFilters.jobTitles || []) {
		orConditions.push({ title: { contains: title, mode: "insensitive" } });
	}

	// Match industries
	for (const ind of aiFilters.industries || []) {
		orConditions.push({
			industries: {
				some: { industry: { name: { contains: ind, mode: "insensitive" } } },
			},
		});
	}

	// Match skills
	for (const skill of aiFilters.skills || []) {
		orConditions.push({
			skills: {
				some: { skill: { name: { contains: skill, mode: "insensitive" } } },
			},
		});
	}

	// Match keywords against title only (not description to reduce noise)
	for (const kw of aiFilters.keywords || []) {
		orConditions.push({ title: { contains: kw, mode: "insensitive" } });
	}

	// Hard filters (AND)
	const andConditions = [];

	if (aiFilters.employmentType) {
		andConditions.push({ employmentType: aiFilters.employmentType });
	}

	if (aiFilters.isRemote === true) {
		andConditions.push({ isRemote: true });
	}

	if (aiFilters.experienceLevel) {
		andConditions.push({
			experienceLevel: { contains: aiFilters.experienceLevel, mode: "insensitive" },
		});
	}

	if (aiFilters.location) {
		andConditions.push({
			locationName: { contains: aiFilters.location, mode: "insensitive" },
		});
	}

	return { orConditions, andConditions };
}

/**
 * Score a job's relevance to the search query and AI filters.
 * Higher score = more relevant. Title matches are weighted highest.
 */
function scoreJob(job, rawQuery, aiFilters) {
	let score = 0;
	const titleLower = (job.title || "").toLowerCase();
	const queryLower = rawQuery.toLowerCase();
	const queryWords = queryLower.split(/\s+/).filter(Boolean);
	const jobSkills = (job.skills || []).map(s => (s.skill?.name || "").toLowerCase());
	const jobIndustries = (job.industries || []).map(i => (i.industry?.name || "").toLowerCase());
	const descLower = (job.description || "").toLowerCase();

	// --- TITLE MATCHING (highest weight) ---

	// Exact title match (e.g. "Finance Manager" === "Finance Manager")
	if (titleLower === queryLower) {
		score += 1000;
	}
	// Title contains the full search query
	else if (titleLower.includes(queryLower)) {
		score += 500;
	}
	// Search query contains the title (e.g. query "senior finance manager", title "Finance Manager")
	else if (queryLower.includes(titleLower)) {
		score += 400;
	}

	// Each query word found in title
	for (const word of queryWords) {
		if (word.length < 3) continue; // skip short words
		if (titleLower.includes(word)) {
			score += 100;
		}
	}

	// AI-suggested title matches
	for (const aiTitle of (aiFilters.jobTitles || []).slice(0, 5)) {
		if (titleLower.includes(aiTitle.toLowerCase())) {
			score += 80;
		}
	}

	// --- INDUSTRY MATCHING (medium weight) ---
	for (const aiInd of (aiFilters.industries || []).slice(0, 3)) {
		const indLower = aiInd.toLowerCase();
		for (const jobInd of jobIndustries) {
			if (jobInd.includes(indLower) || indLower.includes(jobInd)) {
				score += 50;
				break;
			}
		}
	}

	// Raw query matches industry
	for (const jobInd of jobIndustries) {
		if (jobInd.includes(queryLower) || queryLower.includes(jobInd)) {
			score += 60;
		}
	}

	// --- SKILL MATCHING (medium weight) ---
	for (const aiSkill of (aiFilters.skills || []).slice(0, 5)) {
		const skillLower = aiSkill.toLowerCase();
		for (const jobSkill of jobSkills) {
			if (jobSkill.includes(skillLower) || skillLower.includes(jobSkill)) {
				score += 30;
				break;
			}
		}
	}

	// Raw query matches a skill
	for (const jobSkill of jobSkills) {
		if (jobSkill.includes(queryLower) || queryLower.includes(jobSkill)) {
			score += 40;
		}
	}

	// --- DESCRIPTION MATCHING (low weight) ---
	if (descLower.includes(queryLower)) {
		score += 20;
	}
	for (const word of queryWords) {
		if (word.length < 3) continue;
		if (descLower.includes(word)) {
			score += 5;
		}
	}

	// --- RECENCY BOOST (small) ---
	const daysOld = (Date.now() - new Date(job.createdAt).getTime()) / (1000 * 60 * 60 * 24);
	if (daysOld < 7) score += 15;
	else if (daysOld < 30) score += 10;
	else if (daysOld < 90) score += 5;

	return score;
}

/**
 * GET /api/v1/public/jobs/ai-search?q=banking&page=1&limit=24
 */
const aiSearchJobs = async (req, res) => {
	try {
		const { q, page = 1, limit = 24, location, category, jobType, experience, salaryMin, salaryMax, isRemote } = req.query;

		if (!q || !q.trim()) {
			return res.status(400).json({
				status: "ERROR",
				message: "Search query (q) is required",
			});
		}

		const rawQuery = q.trim();
		const pageNum = Number(page);
		const limitNum = Number(limit);

		// 1. Ask Claude to interpret the search query
		const aiFilters = await interpretSearchQuery(rawQuery);

		// Merge explicit URL filters into AI filters so they act as hard AND conditions
		if (location && !aiFilters.location) aiFilters.location = location;
		if (isRemote === "true" && aiFilters.isRemote == null) aiFilters.isRemote = true;
		if (jobType && !aiFilters.employmentType) aiFilters.employmentType = jobType;
		if (experience && !aiFilters.experienceLevel) aiFilters.experienceLevel = experience;

		// 2. Build Prisma conditions
		const { orConditions, andConditions } = buildSearchConditions(aiFilters, rawQuery);

		// Add explicit filter params as AND conditions
		if (category) {
			andConditions.push({
				industries: { some: { industry: { name: { contains: category, mode: "insensitive" } } } },
			});
		}
		if (salaryMin) {
			andConditions.push({ maxSalary: { gte: Number(salaryMin) } });
		}
		if (salaryMax) {
			andConditions.push({ minSalary: { lte: Number(salaryMax) } });
		}

		const where = {
			status: "PUBLISHED",
			...(orConditions.length > 0 && { OR: orConditions }),
			...(andConditions.length > 0 && { AND: andConditions }),
		};

		// 3. Fetch MORE results than needed so we can rank and paginate properly
		// Fetch up to 200 for scoring, then paginate the scored results
		const maxFetch = Math.min(200, limitNum * 5);

		const [allJobs, total] = await prisma.$transaction([
			prisma.job.findMany({
				where,
				take: maxFetch,
				orderBy: { createdAt: "desc" },
				include: {
					company: {
						select: { id: true, name: true, website: true, country: true },
					},
					industries: {
						include: {
							industry: { select: { id: true, name: true, slug: true } },
						},
					},
					skills: {
						include: {
							skill: { select: { id: true, name: true } },
						},
					},
					_count: { select: { jobApplications: true } },
				},
			}),
			prisma.job.count({ where }),
		]);

		// 4. Score and sort by relevance
		const scoredJobs = allJobs.map(job => ({
			...job,
			_relevanceScore: scoreJob(job, rawQuery, aiFilters),
		}));

		scoredJobs.sort((a, b) => b._relevanceScore - a._relevanceScore);

		// 5. Paginate the scored results
		const skip = (pageNum - 1) * limitNum;
		const paginatedJobs = scoredJobs.slice(skip, skip + limitNum);

		// Include relevance score in response (normalized to 0-100%)
		const maxScore = scoredJobs.length > 0 ? scoredJobs[0]._relevanceScore : 1;
		const responseJobs = paginatedJobs.map(({ _relevanceScore, ...job }) => ({
			...job,
			matchScore: maxScore > 0 ? Math.round((_relevanceScore / maxScore) * 100) : 0,
		}));

		return res.status(200).json({
			status: "SUCCESS",
			data: responseJobs,
			meta: {
				total,
				page: pageNum,
				limit: limitNum,
				totalPages: Math.ceil(total / limitNum),
			},
			aiFilters,
		});
	} catch (error) {
		console.error("AI search error:", error);

		// Fallback: if AI fails, do a simple text search with relevance scoring
		try {
			const { q, page = 1, limit = 24 } = req.query;
			const searchTerm = (q || "").trim();
			const pageNum = Number(page);
			const limitNum = Number(limit);

			const where = {
				status: "PUBLISHED",
				OR: [
					{ title: { contains: searchTerm, mode: "insensitive" } },
					{ description: { contains: searchTerm, mode: "insensitive" } },
					{ company: { name: { contains: searchTerm, mode: "insensitive" } } },
					{ skills: { some: { skill: { name: { contains: searchTerm, mode: "insensitive" } } } } },
					{ industries: { some: { industry: { name: { contains: searchTerm, mode: "insensitive" } } } } },
				],
			};

			const maxFetch = Math.min(200, limitNum * 5);

			const [allJobs, total] = await prisma.$transaction([
				prisma.job.findMany({
					where,
					take: maxFetch,
					orderBy: { createdAt: "desc" },
					include: {
						company: {
							select: { id: true, name: true, website: true, country: true },
						},
						industries: {
							include: {
								industry: { select: { id: true, name: true, slug: true } },
							},
						},
						skills: {
							include: {
								skill: { select: { id: true, name: true } },
							},
						},
						_count: { select: { jobApplications: true } },
					},
				}),
				prisma.job.count({ where }),
			]);

			// Score by simple relevance even in fallback
			const scoredJobs = allJobs.map(job => {
				let score = 0;
				const titleLower = (job.title || "").toLowerCase();
				const queryLower = searchTerm.toLowerCase();
				if (titleLower === queryLower) score += 1000;
				else if (titleLower.includes(queryLower)) score += 500;
				else if (queryLower.includes(titleLower)) score += 400;
				for (const word of queryLower.split(/\s+/)) {
					if (word.length >= 3 && titleLower.includes(word)) score += 100;
				}
				const jobSkills = (job.skills || []).map(s => (s.skill?.name || "").toLowerCase());
				for (const sk of jobSkills) {
					if (sk.includes(queryLower) || queryLower.includes(sk)) score += 40;
				}
				const jobInds = (job.industries || []).map(i => (i.industry?.name || "").toLowerCase());
				for (const ind of jobInds) {
					if (ind.includes(queryLower) || queryLower.includes(ind)) score += 60;
				}
				return { ...job, _score: score };
			});

			scoredJobs.sort((a, b) => b._score - a._score);

			const skip = (pageNum - 1) * limitNum;
			const paginatedJobs = scoredJobs.slice(skip, skip + limitNum);
			const responseJobs = paginatedJobs.map(({ _score, ...job }) => job);

			return res.status(200).json({
				status: "SUCCESS",
				data: responseJobs,
				meta: {
					total,
					page: pageNum,
					limit: limitNum,
					totalPages: Math.ceil(total / limitNum),
				},
				aiFilters: null,
			});
		} catch (fallbackError) {
			console.error("Fallback search also failed:", fallbackError);
			return res.status(500).json({
				status: "ERROR",
				message: "Failed to search jobs",
			});
		}
	}
};

module.exports = { aiSearchJobs };
