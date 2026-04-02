const { prisma } = require("../../prisma");

/**
 * Extract text from a CV buffer (PDF only for now).
 */
async function extractCvText(buffer, mimeType) {
	try {
		if (mimeType === "application/pdf") {
			const originalJSONParse = JSON.parse;
			const pdfParse = require("pdf-parse");
			JSON.parse = originalJSONParse;
			const pdfData = await pdfParse(buffer);
			return typeof pdfData.text === "string" ? pdfData.text : String(pdfData.text || "");
		}
		// DOCX support via mammoth
		if (
			mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
			mimeType === "application/msword"
		) {
			try {
				const mammoth = require("mammoth");
				const result = await mammoth.extractRawText({ buffer });
				return result.value || "";
			} catch {
				return "";
			}
		}
		return "";
	} catch (err) {
		console.error("[LeadCapture] CV text extraction failed:", err.message);
		return "";
	}
}

/**
 * POST /public/lead-capture
 * Save lead details + CV file from landing page, extract CV text for matching
 */
const submitLeadCapture = async (req, res) => {
	try {
		const { fullName, email, phone, hasVisa, hasWorkPermit } = req.body;

		if (!fullName || !fullName.trim()) {
			return res.status(400).json({ error: true, message: "Full name is required" });
		}
		if (!email || !email.trim()) {
			return res.status(400).json({ error: true, message: "Email is required" });
		}

		const cvFile = req.file;
		if (!cvFile) {
			return res.status(400).json({ error: true, message: "CV file is required" });
		}

		const cleanEmail = email.trim().toLowerCase();
		const cleanPhone = phone?.trim() || null;
		const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";

		// Block duplicate email
		const existingEmail = await prisma.leadCapture.findFirst({
			where: { email: cleanEmail },
			select: { id: true },
		});
		if (existingEmail) {
			return res.status(409).json({ error: true, message: "A CV has already been submitted with this email. Please login or register to see your matches." });
		}

		// Block duplicate phone (if provided)
		if (cleanPhone) {
			const existingPhone = await prisma.leadCapture.findFirst({
				where: { phone: cleanPhone },
				select: { id: true },
			});
			if (existingPhone) {
				return res.status(409).json({ error: true, message: "A CV has already been submitted with this phone number." });
			}
		}

		// Rate limit: max 3 uploads per IP
		if (clientIp !== "unknown") {
			const ipCount = await prisma.leadCapture.count({
				where: { ipAddress: clientIp },
			});
			if (ipCount >= 3) {
				return res.status(429).json({ error: true, message: "Upload limit reached. You can submit up to 3 CVs. Please login or register to continue." });
			}
		}

		// Extract text from CV for matching
		const cvText = await extractCvText(cvFile.buffer, cvFile.mimetype);

		const lead = await prisma.leadCapture.create({
			data: {
				fullName: fullName.trim(),
				email: cleanEmail,
				phone: cleanPhone,
				cvFileName: cvFile.originalname,
				cvData: cvFile.buffer,
				cvMimeType: cvFile.mimetype,
				cvText: cvText || null,
				ipAddress: clientIp,
				hasVisa: hasVisa === "true" || hasVisa === true,
				hasWorkPermit: hasWorkPermit === "true" || hasWorkPermit === true,
			},
		});

		return res.status(201).json({
			error: false,
			message: "Lead captured successfully",
			result: { id: lead.id, email: lead.email },
		});
	} catch (error) {
		console.error("submitLeadCapture error:", error);
		return res.status(500).json({ error: true, message: "Failed to save your details. Please try again." });
	}
};

/**
 * GET /public/lead-recommendations/:leadId
 * Match lead's CV text against published jobs and return scored results
 */
const getLeadRecommendations = async (req, res) => {
	try {
		const { leadId } = req.params;
		const { page = 1, limit = 24 } = req.query;
		const pageNum = Number(page);
		const limitNum = Number(limit);

		const lead = await prisma.leadCapture.findUnique({
			where: { id: leadId },
			select: { id: true, cvText: true, fullName: true, email: true },
		});

		if (!lead) {
			return res.status(404).json({ error: true, message: "Lead not found" });
		}

		if (!lead.cvText || lead.cvText.trim().length < 50) {
			return res.status(400).json({ error: true, message: "CV text could not be extracted. Please upload a PDF." });
		}

		// Extract keywords from CV text
		const cvLower = lead.cvText.toLowerCase();
		const stopWords = new Set(["the", "and", "for", "are", "with", "this", "that", "from", "will", "have", "has", "was", "were", "been", "being", "can", "could", "would", "should", "may", "might", "shall", "not", "but", "also", "its", "our", "your", "his", "her", "their", "all", "any", "each", "every", "more", "most", "other", "some", "such", "than", "too", "very", "just", "over", "into", "through", "during", "before", "after", "above", "below", "between", "under", "again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "both", "few", "many", "much", "own", "same", "about", "which", "who", "whom", "what"]);
		const words = cvLower.match(/[a-z]{3,}/g) || [];
		const wordFreq = {};
		for (const w of words) {
			if (!stopWords.has(w) && w.length > 2) {
				wordFreq[w] = (wordFreq[w] || 0) + 1;
			}
		}

		// Get top keywords by frequency
		const topKeywords = Object.entries(wordFreq)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 30)
			.map(([word]) => word);

		if (topKeywords.length === 0) {
			return res.status(400).json({ error: true, message: "Could not extract meaningful keywords from CV" });
		}

		// Try AI interpretation of CV for better matching
		let aiFilters = null;
		try {
			const Anthropic = require("@anthropic-ai/sdk");
			const anthropic = new Anthropic();
			const cvSnippet = lead.cvText.substring(0, 3000);
			const aiResponse = await anthropic.messages.create({
				model: "claude-sonnet-4-20250514",
				max_tokens: 500,
				messages: [{
					role: "user",
					content: `Analyze this CV/resume text and extract structured job search filters for matching.

CV Text:
${cvSnippet}

Return a JSON object:
{
  "jobTitles": ["up to 5 most relevant job titles this person should apply for"],
  "industries": ["up to 3 relevant industries"],
  "skills": ["up to 10 key technical/professional skills found"],
  "experienceLevel": "Junior" or "Mid" or "Senior" or "Lead" or "Executive",
  "keywords": ["up to 5 key search terms"]
}

Return ONLY the JSON object.`,
				}],
			});
			const text = aiResponse.content[0].text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
			aiFilters = JSON.parse(text);
		} catch (err) {
			console.log("[LeadRec] AI interpretation failed, using keyword fallback:", err.message);
		}

		// Build search conditions
		const orConditions = [];

		if (aiFilters) {
			for (const title of (aiFilters.jobTitles || []).slice(0, 5)) {
				orConditions.push({ title: { contains: title, mode: "insensitive" } });
			}
			for (const ind of (aiFilters.industries || []).slice(0, 3)) {
				orConditions.push({ industries: { some: { industry: { name: { contains: ind, mode: "insensitive" } } } } });
			}
			for (const skill of (aiFilters.skills || []).slice(0, 10)) {
				orConditions.push({ skills: { some: { skill: { name: { contains: skill, mode: "insensitive" } } } } });
			}
			for (const kw of (aiFilters.keywords || []).slice(0, 5)) {
				orConditions.push({ title: { contains: kw, mode: "insensitive" } });
			}
		}

		// Fallback: use top CV keywords
		for (const kw of topKeywords.slice(0, 10)) {
			orConditions.push({ title: { contains: kw, mode: "insensitive" } });
			orConditions.push({ skills: { some: { skill: { name: { contains: kw, mode: "insensitive" } } } } });
		}

		const where = {
			status: "PUBLISHED",
			...(orConditions.length > 0 && { OR: orConditions }),
		};

		const maxFetch = 200;
		// Run queries separately (no transaction needed for read-only)
		const [allJobs, total] = await Promise.all([
			prisma.job.findMany({
				where,
				take: maxFetch,
				orderBy: { createdAt: "desc" },
				include: {
					company: { select: { id: true, name: true, website: true, country: true } },
					industries: { include: { industry: { select: { id: true, name: true, slug: true } } } },
					skills: { include: { skill: { select: { id: true, name: true } } } },
					_count: { select: { jobApplications: true } },
				},
			}),
			prisma.job.count({ where }),
		]);

		// Score each job against CV
		const scoredJobs = allJobs.map((job) => {
			let score = 0;
			const titleLower = (job.title || "").toLowerCase();
			const descLower = (job.description || "").toLowerCase();
			const jobSkills = (job.skills || []).map((s) => (s.skill?.name || "").toLowerCase());
			const jobIndustries = (job.industries || []).map((i) => (i.industry?.name || "").toLowerCase());

			// Keyword hits in CV vs job
			for (const kw of topKeywords) {
				if (titleLower.includes(kw)) score += 15;
				if (descLower.includes(kw)) score += 3;
				for (const sk of jobSkills) {
					if (sk.includes(kw) || kw.includes(sk)) { score += 10; break; }
				}
			}

			// AI filter matches
			if (aiFilters) {
				for (const aiTitle of (aiFilters.jobTitles || [])) {
					if (titleLower.includes(aiTitle.toLowerCase())) score += 80;
				}
				for (const aiInd of (aiFilters.industries || [])) {
					for (const ji of jobIndustries) {
						if (ji.includes(aiInd.toLowerCase()) || aiInd.toLowerCase().includes(ji)) { score += 40; break; }
					}
				}
				for (const aiSkill of (aiFilters.skills || [])) {
					for (const sk of jobSkills) {
						if (sk.includes(aiSkill.toLowerCase()) || aiSkill.toLowerCase().includes(sk)) { score += 25; break; }
					}
				}
			}

			// Recency bonus
			const daysOld = (Date.now() - new Date(job.createdAt).getTime()) / (1000 * 60 * 60 * 24);
			if (daysOld < 7) score += 15;
			else if (daysOld < 30) score += 10;
			else if (daysOld < 90) score += 5;

			return { ...job, _score: score };
		});

		scoredJobs.sort((a, b) => b._score - a._score);

		// Normalize scores to 0-100%
		const maxScore = scoredJobs.length > 0 ? scoredJobs[0]._score : 1;
		const skip = (pageNum - 1) * limitNum;
		const paginatedJobs = scoredJobs.slice(skip, skip + limitNum);

		const responseJobs = paginatedJobs.map(({ _score, ...job }) => ({
			...job,
			matchScore: maxScore > 0 ? Math.round((_score / maxScore) * 100) : 0,
		}));

		return res.status(200).json({
			status: "SUCCESS",
			data: responseJobs,
			meta: {
				total: Math.min(total, maxFetch),
				page: pageNum,
				limit: limitNum,
				totalPages: Math.ceil(Math.min(total, maxFetch) / limitNum),
			},
			leadInfo: { name: lead.fullName, email: lead.email },
			aiFilters,
		});
	} catch (error) {
		console.error("getLeadRecommendations error:", error);
		return res.status(500).json({ error: true, message: "Failed to get recommendations" });
	}
};

/**
 * GET /public/check-email?email=xxx
 * Check if an email already has an account
 */
const checkEmail = async (req, res) => {
	try {
		const { email } = req.query;
		if (!email) return res.status(400).json({ error: true, message: "Email is required" });

		const user = await prisma.user.findUnique({
			where: { email: email.trim().toLowerCase() },
			select: { id: true },
		});

		return res.status(200).json({
			error: false,
			exists: !!user,
		});
	} catch (error) {
		console.error("checkEmail error:", error);
		return res.status(500).json({ error: true, message: "Failed to check email" });
	}
};

module.exports = { submitLeadCapture, getLeadRecommendations, checkEmail };
