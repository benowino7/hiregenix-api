const { prisma } = require("../../prisma");

/**
 * Analyze one or more CVs against selected jobs using Claude AI
 * Returns skill gap analysis with scoring, ranking, and detailed breakdown
 * Supports both text-based and scanned/image PDFs via Claude Vision fallback
 */
const analyzeCv = async (req, res) => {
	try {
		// Support single file (upload.single) or multiple files (upload.array)
		const files = req.files || (req.file ? [req.file] : []);
		if (files.length === 0) {
			return res.status(400).json({ status: "FAIL", message: "At least one CV PDF file is required" });
		}

		const { jobIds } = req.body;
		if (!jobIds) {
			return res.status(400).json({ status: "FAIL", message: "jobIds is required (comma-separated or JSON array)" });
		}

		let parsedJobIds;
		try {
			parsedJobIds = typeof jobIds === "string" ? (jobIds.startsWith("[") ? JSON.parse(jobIds) : jobIds.split(",").map((s) => s.trim())) : jobIds;
		} catch {
			return res.status(400).json({ status: "FAIL", message: "Invalid jobIds format" });
		}

		if (!Array.isArray(parsedJobIds) || parsedJobIds.length === 0) {
			return res.status(400).json({ status: "FAIL", message: "At least one job ID is required" });
		}

		// Extract text from each CV PDF (with vision fallback for scanned PDFs)
		const candidates = [];
		for (const file of files) {
			const cvText = await extractCvText(file.buffer);
			if (!cvText || cvText.trim().length < 10) {
				return res.status(400).json({
					status: "FAIL",
					message: `Could not extract text from ${file.originalname || "uploaded PDF"}. The file may be corrupted or empty.`,
				});
			}
			candidates.push({
				fileName: file.originalname || "Unknown CV",
				fileSize: file.size,
				cvText,
				name: extractCandidateName(cvText),
			});
		}

		// Fetch the selected jobs with their skills
		const jobs = await prisma.job.findMany({
			where: { id: { in: parsedJobIds } },
			include: {
				company: { select: { name: true } },
				skills: { include: { skill: { select: { id: true, name: true } } } },
				industries: { include: { industry: { select: { name: true } } } },
			},
		});

		if (jobs.length === 0) {
			return res.status(404).json({ status: "FAIL", message: "No valid jobs found for the provided IDs" });
		}

		const jobSummaries = jobs.map((job) => ({
			id: job.id,
			title: job.title,
			description: (job.description || "").substring(0, 1500),
			requiredSkills: job.skills.map((s) => s.skill.name),
			industries: job.industries.map((i) => i.industry.name),
			experienceLevel: job.experienceLevel,
			employmentType: job.employmentType,
			company: job.company?.name || "Unknown",
		}));

		// Build candidate sections for AI prompt
		const candidateSections = candidates.map((c, i) => `
### Candidate ${i + 1}: ${c.name} (File: ${c.fileName})
${c.cvText.substring(0, 5000)}
`).join("\n");

		// Call Claude for comprehensive skill gap analysis
		const Anthropic = require("@anthropic-ai/sdk");
		const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

		const response = await client.messages.create({
			model: "claude-sonnet-4-20250514",
			max_tokens: 8000,
			messages: [
				{
					role: "user",
					content: `You are an expert HR analyst and recruitment specialist. Analyze each candidate's CV against each job posting and provide a comprehensive skill gap analysis with scoring and ranking.

## Candidates:
${candidateSections}

## Jobs to Analyze Against:
${JSON.stringify(jobSummaries, null, 2)}

For EACH combination of candidate and job, provide a detailed analysis. Return a JSON object with this structure:
{
  "candidates": [
    {
      "candidateIndex": 0,
      "candidateName": "Name from CV",
      "fileName": "filename.pdf",
      "analyses": [
        {
          "jobId": "the job id",
          "jobTitle": "the job title",
          "company": "company name",
          "overallScore": 0-100,
          "matchLevel": "Excellent Match" | "Strong Match" | "Partial Match" | "Weak Match",
          "tier": "excellent" | "strong" | "moderate" | "weak",
          "scoreBreakdown": {
            "skillMatch": 0-100,
            "experienceMatch": 0-100,
            "educationMatch": 0-100,
            "overallFit": 0-100
          },
          "matchedSkills": ["skill1", "skill2"],
          "missingSkills": ["skill3", "skill4"],
          "transferableSkills": ["skill that could transfer"],
          "skillGapAnalysis": "Detailed paragraph explaining the skill gaps, strengths, and what training or upskilling would bridge the gap",
          "experienceMatch": "How well the candidate's experience level and years match the role requirements",
          "educationMatch": "How the candidate's education aligns with the role",
          "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
          "weaknesses": ["specific gap 1", "specific gap 2"],
          "redFlags": ["any concerns if applicable"],
          "greenFlags": ["positive indicators"],
          "recommendation": "Detailed recommendation: should they be interviewed? What questions to ask? What to probe?",
          "interviewTalkingPoints": ["specific question 1", "specific question 2", "specific question 3"],
          "recruiterSummary": "3-4 sentence executive summary for the hiring manager explaining why this candidate does or doesn't fit"
        }
      ]
    }
  ],
  "rankings": [
    {
      "rank": 1,
      "candidateName": "Best candidate name",
      "candidateIndex": 0,
      "averageScore": 85,
      "topJobMatch": "Job Title with highest score",
      "summary": "Why this candidate is ranked here"
    }
  ]
}

Scoring guide:
- 85-100 (Excellent): Has virtually all required skills, strong relevant experience, ideal fit
- 70-84 (Strong): Has most key skills, solid experience, minor gaps that are easily addressed
- 50-69 (Moderate/Partial): Has some relevant skills but significant gaps; may need training
- 0-49 (Weak): Lacks most required skills; poor fit for the role

Be thorough, specific, and actionable. Reference specific skills and experiences from the CV.
Return ONLY valid JSON, no markdown or explanation.`,
				},
			],
		});

		const content = response.content[0].text;
		let analysis;
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			analysis = JSON.parse(jsonMatch ? jsonMatch[0] : content);
		} catch {
			// Fallback: try array format for backwards compatibility
			try {
				const arrayMatch = content.match(/\[[\s\S]*\]/);
				const arr = JSON.parse(arrayMatch ? arrayMatch[0] : content);
				// Convert old format to new format
				analysis = {
					candidates: [{
						candidateIndex: 0,
						candidateName: candidates[0]?.name || "Unknown",
						fileName: candidates[0]?.fileName || "Unknown",
						analyses: arr,
					}],
					rankings: [{
						rank: 1,
						candidateName: candidates[0]?.name || "Unknown",
						candidateIndex: 0,
						averageScore: Math.round(arr.reduce((s, a) => s + (a.overallScore || 0), 0) / arr.length),
						topJobMatch: arr.sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0))[0]?.jobTitle || "",
						summary: "Single candidate analyzed",
					}],
				};
			} catch {
				return res.status(422).json({
					status: "FAIL",
					message: "Failed to parse AI analysis response",
					rawResponse: content.substring(0, 2000),
				});
			}
		}

		// Sort each candidate's analyses by score
		if (analysis.candidates) {
			for (const candidate of analysis.candidates) {
				if (candidate.analyses) {
					candidate.analyses.sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0));
				}
			}
		}

		// Sort rankings
		if (analysis.rankings) {
			analysis.rankings.sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0));
			analysis.rankings.forEach((r, i) => r.rank = i + 1);
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: "CV analysis completed",
			data: {
				candidates: analysis.candidates || [],
				rankings: analysis.rankings || [],
				totalCandidates: candidates.length,
				totalJobsAnalyzed: jobs.length,
			},
		});
	} catch (error) {
		console.error("CV analysis error:", error);
		return res.status(500).json({ status: "ERROR", message: error.message || "Failed to analyze CV" });
	}
};

/**
 * Extract text from PDF buffer, with Claude Vision fallback for scanned/image PDFs
 */
async function extractCvText(pdfBuffer) {
	// Try text extraction first
	try {
		const originalJSONParse = JSON.parse;
		const pdfParse = require("pdf-parse");
		JSON.parse = originalJSONParse;

		const pdfData = await pdfParse(pdfBuffer);
		const text = typeof pdfData.text === "string" ? pdfData.text : String(pdfData.text || "");

		if (text.trim().length >= 50) {
			return text;
		}
	} catch (e) {
		console.log("pdf-parse failed, trying vision fallback:", e.message);
	}

	// Fallback: use Claude Vision to read the PDF as base64
	try {
		const Anthropic = require("@anthropic-ai/sdk");
		const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

		const base64Pdf = pdfBuffer.toString("base64");

		const response = await client.messages.create({
			model: "claude-sonnet-4-20250514",
			max_tokens: 4000,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "document",
							source: {
								type: "base64",
								media_type: "application/pdf",
								data: base64Pdf,
							},
						},
						{
							type: "text",
							text: "Extract ALL text content from this CV/resume document. Return the complete text exactly as it appears, preserving the structure. Include name, contact info, education, work experience, skills, certifications - everything. Return ONLY the extracted text, no commentary.",
						},
					],
				},
			],
		});

		const extractedText = response.content[0].text;
		if (extractedText && extractedText.trim().length >= 20) {
			return extractedText;
		}
	} catch (e) {
		console.error("Claude Vision PDF extraction failed:", e.message);
	}

	return "";
}

/**
 * Simple heuristic to extract candidate name from CV text
 */
function extractCandidateName(text) {
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length > 0) {
		const firstLine = lines[0].trim();
		if (firstLine.length < 60 && !firstLine.includes("@") && !firstLine.toLowerCase().includes("curriculum")) {
			return firstLine;
		}
	}
	return "Unknown Candidate";
}

/**
 * Get all published jobs for the CV analysis job selector
 */
const getJobsForAnalysis = async (req, res) => {
	try {
		const { search, page = 1, limit = 50 } = req.query;
		const skip = (Number(page) - 1) * Number(limit);

		// Load all published jobs (admin + recruiter posted)
		const where = { status: "PUBLISHED" };
		if (search) {
			where.AND = [
				{ OR: [
					{ title: { contains: search, mode: "insensitive" } },
					{ company: { name: { contains: search, mode: "insensitive" } } },
				] },
			];
		}

		const [jobs, total] = await Promise.all([
			prisma.job.findMany({
				where,
				skip,
				take: Number(limit),
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					title: true,
					employmentType: true,
					experienceLevel: true,
					company: { select: { name: true } },
					skills: { include: { skill: { select: { name: true } } } },
				},
			}),
			prisma.job.count({ where }),
		]);

		return res.status(200).json({
			status: "SUCCESS",
			data: jobs,
			meta: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) },
		});
	} catch (error) {
		console.error("Get jobs for analysis error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to fetch jobs" });
	}
};

module.exports = {
	analyzeCv,
	getJobsForAnalysis,
};
