/**
 * AI Rankings Controller (Recruiter)
 * ====================================
 * Recruiter-facing endpoints for AI-powered candidate matching and ranking.
 *
 * Endpoints:
 *   GET  /recruiter/jobs/:jobId/ai-rankings              - Ranked list of all applicants
 *   GET  /recruiter/jobs/:jobId/ai-rankings/:applicationId - Detailed analysis for one applicant
 *   POST /recruiter/jobs/:jobId/ai-screen                 - Trigger full AI screening
 */

const { prisma } = require("../../prisma");
const {
	rankCandidates,
	matchCandidate,
	buildJobProfile,
	buildCandidateProfile,
	isAIAvailable,
} = require("../ai/matchingEngine");

// Cache TTL: 1 hour in milliseconds
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Fetch cached rankings for a job. Returns null if no valid cache exists
 * or if the applicant count has changed (meaning new applications arrived).
 */
async function getCachedRankings(jobId, currentApplicantCount) {
	try {
		const cached = await prisma.aIRankingCache.findUnique({
			where: { jobId },
		});
		if (!cached) return null;
		// Expired?
		if (new Date() > cached.expiresAt) return null;
		// Applicant count changed? Cache is stale.
		if (cached.applicantCount !== currentApplicantCount) return null;
		return cached.rankingsJson;
	} catch (err) {
		console.error("[aiRankings] cache read error:", err.message);
		return null;
	}
}

/**
 * Store ranking results in cache, upsert by jobId.
 */
async function setCachedRankings(jobId, applicantCount, rankResult) {
	try {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
		await prisma.aIRankingCache.upsert({
			where: { jobId },
			create: {
				jobId,
				applicantCount,
				rankingsJson: rankResult,
				rankedAt: now,
				expiresAt,
			},
			update: {
				applicantCount,
				rankingsJson: rankResult,
				rankedAt: now,
				expiresAt,
			},
		});
	} catch (err) {
		console.error("[aiRankings] cache write error:", err.message);
	}
}

// ---------------------------------------------------------------------------
// GET /recruiter/jobs/:jobId/ai-rankings
// ---------------------------------------------------------------------------
// Returns a ranked list of all applicants for a job, scored and tiered
// by the matching engine. Uses cached results when available.
// Pass ?refresh=true to force re-computation.

const getAIRankings = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const companyId = req.user?.profile?.recruiter?.companyId;
		const recruiterProfileId = req.user?.profile?.recruiter?.id;
		const jobId = req.params.jobId;

		if (!companyId && !recruiterProfileId) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: recruiter company not found",
			});
		}

		// Pagination
		const page = Math.max(1, parseInt(req.query.page, 10) || 1);
		const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

		// Optional filter by tier
		const tierFilter = req.query.tier || null; // excellent, strong, moderate, weak

		// Whether to use AI (defaults to true if available, can be forced off)
		const useAI = req.query.useAI !== "false";

		// Force refresh cache?
		const forceRefresh = req.query.refresh === "true";

		// 1) Validate job ownership (match by company OR recruiter profile)
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				OR: [
					{ companyId },
					...(recruiterProfileId ? [{ recruiterProfileId }] : []),
				],
			},
			include: {
				company: { select: { id: true, name: true, country: true } },
				skills: { include: { skill: true } },
				industries: { include: { industry: true } },
			},
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not authorized",
			});
		}

		// 2) Count applications for cache check
		const applicantCount = await prisma.jobApplication.count({ where: { jobId } });

		if (applicantCount === 0) {
			return res.status(200).json({
				status: "SUCCESS",
				message: {
					job: { id: job.id, title: job.title },
					totalApplicants: 0,
					rankings: [],
					pagination: { total: 0, page, limit, totalPages: 0 },
					meta: { aiAvailable: isAIAvailable(), aiUsed: false, cached: false },
				},
			});
		}

		// 3) Check cache (unless force refresh)
		let rankResult = null;
		let fromCache = false;
		let jobProfile = null;
		if (!forceRefresh) {
			const cached = await getCachedRankings(jobId, applicantCount);
			if (cached) {
				rankResult = cached;
				fromCache = true;
			}
		}

		// 4) If no cache, compute fresh rankings
		if (!rankResult) {
			const applications = await prisma.jobApplication.findMany({
				where: { jobId },
				orderBy: { createdAt: "desc" },
				include: {
					jobSeeker: {
						include: {
							user: {
								select: {
									id: true,
									firstName: true,
									lastName: true,
									email: true,
									phoneNumber: true,
									countryCode: true,
								},
							},
							skills: {
								include: {
									skill: { select: { id: true, name: true } },
								},
							},
						},
					},
					cv: {
						select: {
							id: true,
							extractedText: true,
							fileName: true,
							isPrimary: true,
							fileSize: true,
						},
					},
				},
			});

			jobProfile = buildJobProfile(job);
			const candidates = applications.map((app) => buildCandidateProfile(app));

			rankResult = await rankCandidates({
				jobProfile,
				candidates,
				useAI: useAI && isAIAvailable(),
			});

			// Store in cache (fire and forget)
			setCachedRankings(jobId, applicantCount, rankResult);
		}

		// 5) Apply tier filter if specified
		let filteredRankings = rankResult.rankings;
		if (tierFilter) {
			filteredRankings = filteredRankings.filter(
				(r) => r.tier === tierFilter.toLowerCase()
			);
		}

		// 6) Paginate
		const total = filteredRankings.length;
		const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
		const pageClamped = totalPages === 0 ? 1 : Math.min(page, totalPages);
		const start = (pageClamped - 1) * limit;
		const end = start + limit;

		const pageItems = filteredRankings.slice(start, end).map((r) => ({
			rank: r.rank,
			candidate: r.candidate,
			scores: r.scores,
			tier: r.tier,
			recommendation: r.recommendation,
			recruiterSummary: r.recruiterSummary,
			skillGap: {
				matchedCount: r.skillGap.matchedRequired.length,
				missingCount: r.skillGap.missingRequired.length,
				transferableCount: r.skillGap.transferableSkills.length,
				missingRequired: r.skillGap.missingRequired,
			},
			plagiarism: r.plagiarism,
			redFlagCount: r.redFlags.length,
			greenFlagCount: r.greenFlags.length,
			meta: r.meta,
		}));

		return res.status(200).json({
			status: "SUCCESS",
			message: {
				job: {
					id: job.id,
					title: job.title,
					company: job.company?.name || "",
					requiredSkills: jobProfile?.requiredSkills || [],
					preferredSkills: jobProfile?.preferredSkills || [],
				},
				totalApplicants: applicantCount,
				rankings: pageItems,
				summary: rankResult.summary,
				pagination: {
					total,
					page: pageClamped,
					limit,
					totalPages,
				},
				meta: {
					aiAvailable: isAIAvailable(),
					aiUsed: rankResult.summary?.aiEnhanced || false,
					rankedAt: rankResult.rankedAt,
					cached: fromCache,
					filters: {
						tier: tierFilter || "ALL",
					},
				},
			},
		});
	} catch (error) {
		console.error("[aiRankings] getAIRankings error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to generate AI rankings",
		});
	}
};

// ---------------------------------------------------------------------------
// GET /recruiter/jobs/:jobId/ai-rankings/:applicationId
// ---------------------------------------------------------------------------
// Returns detailed match analysis for a single applicant, including full
// skill gap breakdown, all flags, interview talking points, etc.

const getApplicationAIAnalysis = async (req, res) => {
	try {
		const companyId = req.user?.profile?.recruiter?.companyId;
		const recruiterProfileId = req.user?.profile?.recruiter?.id;
		const { jobId, applicationId } = req.params;

		// Whether to use AI
		const useAI = req.query.useAI !== "false";

		if (!companyId && !recruiterProfileId) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: recruiter company not found",
			});
		}

		// 1) Validate job ownership (match by company OR recruiter profile)
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				OR: [
					{ companyId },
					...(recruiterProfileId ? [{ recruiterProfileId }] : []),
				],
			},
			include: {
				company: { select: { id: true, name: true } },
				skills: { include: { skill: true } },
			},
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not authorized",
			});
		}

		// 2) Fetch the specific application
		const application = await prisma.jobApplication.findFirst({
			where: {
				id: applicationId,
				jobId,
			},
			include: {
				jobSeeker: {
					include: {
						user: {
							select: {
								id: true,
								firstName: true,
								lastName: true,
								email: true,
								phoneNumber: true,
								countryCode: true,
							},
						},
						skills: {
							include: {
								skill: { select: { id: true, name: true } },
							},
						},
					},
				},
				cv: {
					select: {
						id: true,
						extractedText: true,
						fileName: true,
						isPrimary: true,
						fileSize: true,
					},
				},
				statusLogs: {
					orderBy: { createdAt: "desc" },
					take: 5,
					select: {
						id: true,
						fromStatus: true,
						toStatus: true,
						note: true,
						createdAt: true,
					},
				},
			},
		});

		if (!application) {
			return res.status(404).json({
				status: "FAIL",
				message: "Application not found for this job",
			});
		}

		// 3) Fetch other candidates' CV texts for plagiarism detection
		const otherApplications = await prisma.jobApplication.findMany({
			where: {
				jobId,
				id: { not: applicationId },
			},
			select: {
				cv: { select: { extractedText: true } },
			},
		});
		const otherCvTexts = otherApplications
			.map((a) => a.cv?.extractedText || "")
			.filter(Boolean);

		// 4) Build profiles and run matching
		const jobProfile = buildJobProfile(job);
		const candidateProfile = buildCandidateProfile(application);

		const matchResult = await matchCandidate({
			jobProfile,
			candidateProfile,
			otherCvTexts,
			useAI: useAI && isAIAvailable(),
		});

		// 5) Return full detailed analysis
		return res.status(200).json({
			status: "SUCCESS",
			message: {
				job: {
					id: job.id,
					title: job.title,
					company: job.company?.name || "",
				},
				application: {
					id: application.id,
					status: application.status,
					coverLetter: application.coverLetter,
					appliedAt: application.createdAt,
					statusLogs: application.statusLogs,
					cv: application.cv
						? {
								id: application.cv.id,
								fileName: application.cv.fileName,
								isPrimary: application.cv.isPrimary,
								fileSize: application.cv.fileSize,
							}
						: null,
				},
				analysis: {
					candidate: matchResult.candidate,
					scores: matchResult.scores,
					weights: matchResult.weights,
					tier: matchResult.tier,
					recommendation: matchResult.recommendation,
					recruiterSummary: matchResult.recruiterSummary,
					skillGap: matchResult.skillGap,
					plagiarism: matchResult.plagiarism,
					redFlags: matchResult.redFlags,
					greenFlags: matchResult.greenFlags,
					interviewTalkingPoints: matchResult.interviewTalkingPoints,
					softSkills: matchResult.softSkills,
					meta: matchResult.meta,
				},
			},
		});
	} catch (error) {
		console.error("[aiRankings] getApplicationAIAnalysis error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to generate AI analysis for this application",
		});
	}
};

// ---------------------------------------------------------------------------
// POST /recruiter/jobs/:jobId/ai-screen
// ---------------------------------------------------------------------------
// Triggers a full AI screening of all applicants for a job.
// This is the same as getAIRankings but always uses AI (if available)
// and returns the complete analysis for every candidate.

const triggerAIScreen = async (req, res) => {
	try {
		const companyId = req.user?.profile?.recruiter?.companyId;
		const recruiterProfileId = req.user?.profile?.recruiter?.id;
		const jobId = req.params.jobId;

		if (!companyId && !recruiterProfileId) {
			return res.status(403).json({
				status: "FAIL",
				message: "Access denied: recruiter company not found",
			});
		}

		// Optional: minimum tier filter (only return candidates above this tier)
		const minTier = (req.body.minTier || "").toLowerCase();
		const tierOrder = { excellent: 4, strong: 3, moderate: 2, weak: 1 };
		const minTierValue = tierOrder[minTier] || 0;

		// 1) Validate job ownership (match by company OR recruiter profile)
		const job = await prisma.job.findFirst({
			where: {
				id: jobId,
				OR: [
					{ companyId },
					...(recruiterProfileId ? [{ recruiterProfileId }] : []),
				],
			},
			include: {
				company: { select: { id: true, name: true } },
				skills: { include: { skill: true } },
			},
		});

		if (!job) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job not found or not authorized",
			});
		}

		// 2) Fetch all applications
		const applications = await prisma.jobApplication.findMany({
			where: { jobId },
			include: {
				jobSeeker: {
					include: {
						user: {
							select: {
								id: true,
								firstName: true,
								lastName: true,
								email: true,
								phoneNumber: true,
								countryCode: true,
							},
						},
						skills: {
							include: {
								skill: { select: { id: true, name: true } },
							},
						},
					},
				},
				cv: {
					select: {
						id: true,
						extractedText: true,
						fileName: true,
						isPrimary: true,
						fileSize: true,
					},
				},
			},
		});

		if (applications.length === 0) {
			return res.status(200).json({
				status: "SUCCESS",
				message: {
					job: { id: job.id, title: job.title },
					totalApplicants: 0,
					screenedAt: new Date().toISOString(),
					aiUsed: false,
					results: [],
				},
			});
		}

		// 3) Build profiles
		const jobProfile = buildJobProfile(job);
		const candidates = applications.map((app) => buildCandidateProfile(app));

		// 4) Run full ranking
		const rankResult = await rankCandidates({
			jobProfile,
			candidates,
			useAI: isAIAvailable(), // Always use AI for screening if available
		});

		// 4b) Update cache with fresh results
		setCachedRankings(jobId, applications.length, rankResult);

		// 5) Apply minimum tier filter
		let results = rankResult.rankings;
		if (minTierValue > 0) {
			results = results.filter((r) => (tierOrder[r.tier] || 0) >= minTierValue);
		}

		// 6) Return full results (no pagination - this is a screening report)
		return res.status(200).json({
			status: "SUCCESS",
			message: {
				job: {
					id: job.id,
					title: job.title,
					company: job.company?.name || "",
					requiredSkills: jobProfile.requiredSkills,
					preferredSkills: jobProfile.preferredSkills,
					minYearsExperience: jobProfile.minYearsExperience,
				},
				totalApplicants: applications.length,
				totalScreened: results.length,
				screenedAt: new Date().toISOString(),
				aiUsed: rankResult.summary.aiEnhanced,
				aiAvailable: isAIAvailable(),
				summary: rankResult.summary,
				results: results.map((r) => ({
					rank: r.rank,
					candidate: r.candidate,
					scores: r.scores,
					tier: r.tier,
					recommendation: r.recommendation,
					recruiterSummary: r.recruiterSummary,
					skillGap: r.skillGap,
					plagiarism: r.plagiarism,
					redFlags: r.redFlags,
					greenFlags: r.greenFlags,
					interviewTalkingPoints: r.interviewTalkingPoints,
					softSkills: r.softSkills,
					meta: r.meta,
				})),
			},
		});
	} catch (error) {
		console.error("[aiRankings] triggerAIScreen error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to run AI screening",
		});
	}
};

module.exports = {
	getAIRankings,
	getApplicationAIAnalysis,
	triggerAIScreen,
};
