/**
 * AI Matching Engine
 * ==================
 * Core matching engine that ranks candidates against job vacancies.
 *
 * Works in two modes:
 *   1. Algorithmic (no API key required) - keyword/skill matching, fuzzy string similarity,
 *      experience scoring, education assessment, plagiarism detection
 *   2. AI-enhanced (when ANTHROPIC_API_KEY or OPENAI_API_KEY is set) - uses Claude/GPT
 *      for semantic analysis, skill gap reasoning, and recruiter summaries
 *
 * Scoring weights:
 *   Skills 35% | Experience 25% | Education 15% | Semantic Fit 25%
 */

// ---------------------------------------------------------------------------
// Constants & stopwords (reused from suggestJobs.js pattern)
// ---------------------------------------------------------------------------

const DEFAULT_STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
	"has", "have", "he", "her", "his", "i", "in", "is", "it", "its", "me",
	"my", "not", "of", "on", "or", "our", "she", "so", "that", "the",
	"their", "them", "they", "this", "to", "was", "we", "were", "with",
	"you", "your", "responsible", "responsibilities", "experience", "skill",
	"skills", "ability", "worked", "work", "team", "teams", "project",
	"projects", "year", "years", "including", "using", "used", "also",
	"will", "can", "must", "should", "would", "could", "may", "etc",
	"such", "well", "strong", "good", "knowledge", "understanding",
]);

const EDUCATION_LEVELS = {
	"phd": 5, "doctorate": 5, "doctoral": 5, "d.phil": 5,
	"masters": 4, "master": 4, "msc": 4, "mba": 4, "ma": 4, "m.s.": 4, "m.a.": 4,
	"bachelors": 3, "bachelor": 3, "bsc": 3, "ba": 3, "b.s.": 3, "b.a.": 3, "beng": 3, "b.eng": 3,
	"associate": 2, "diploma": 2, "hnd": 2,
	"certificate": 1, "certification": 1, "high school": 0, "secondary": 0,
};

const NOTABLE_COMPANIES = [
	"google", "microsoft", "amazon", "apple", "meta", "facebook", "netflix",
	"uber", "airbnb", "stripe", "salesforce", "oracle", "ibm", "intel",
	"cisco", "adobe", "twitter", "linkedin", "tesla", "spacex", "nvidia",
	"samsung", "huawei", "deloitte", "mckinsey", "bcg", "bain", "pwc",
	"kpmg", "ernst & young", "ey", "accenture", "jpmorgan", "goldman sachs",
	"morgan stanley", "emirates", "etisalat", "du telecom", "careem",
	"souq", "noon", "majid al futtaim", "emaar", "damac",
];

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

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

function extractKeywords(text, { maxKeywords = 50, stopwords = DEFAULT_STOPWORDS } = {}) {
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

// ---------------------------------------------------------------------------
// String similarity (Dice coefficient - fast bigram-based)
// ---------------------------------------------------------------------------

function bigrams(str) {
	const s = str.toLowerCase();
	const result = new Set();
	for (let i = 0; i < s.length - 1; i++) {
		result.add(s.substring(i, i + 2));
	}
	return result;
}

function diceCoefficient(a, b) {
	if (!a || !b) return 0;
	if (a.toLowerCase() === b.toLowerCase()) return 1;
	const bigramsA = bigrams(a);
	const bigramsB = bigrams(b);
	if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

	let intersection = 0;
	for (const bg of bigramsA) {
		if (bigramsB.has(bg)) intersection++;
	}
	return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

// ---------------------------------------------------------------------------
// Skill synonym map (common equivalences)
// ---------------------------------------------------------------------------

const SKILL_SYNONYMS = {
	"react": ["reactjs", "react.js"],
	"reactjs": ["react", "react.js"],
	"react.js": ["react", "reactjs"],
	"node": ["nodejs", "node.js"],
	"nodejs": ["node", "node.js"],
	"node.js": ["node", "nodejs"],
	"postgres": ["postgresql", "psql"],
	"postgresql": ["postgres", "psql"],
	"python": ["python3", "python 3"],
	"javascript": ["js", "ecmascript"],
	"js": ["javascript", "ecmascript"],
	"typescript": ["ts"],
	"ts": ["typescript"],
	"k8s": ["kubernetes"],
	"kubernetes": ["k8s"],
	"aws": ["amazon web services"],
	"gcp": ["google cloud", "google cloud platform"],
	"azure": ["microsoft azure"],
	"mongo": ["mongodb"],
	"mongodb": ["mongo"],
	"docker": ["containerization", "containers"],
	"ci/cd": ["cicd", "continuous integration", "continuous deployment"],
	"c#": ["csharp", "c sharp"],
	"c++": ["cpp"],
	"vue": ["vuejs", "vue.js"],
	"vuejs": ["vue", "vue.js"],
	"angular": ["angularjs"],
	"angularjs": ["angular"],
	"ml": ["machine learning"],
	"machine learning": ["ml"],
	"ai": ["artificial intelligence"],
	"artificial intelligence": ["ai"],
	"dl": ["deep learning"],
	"deep learning": ["dl"],
	"nlp": ["natural language processing"],
	"devops": ["dev ops", "development operations"],
};

// Transferable skill relationships (skill -> partially covers)
const TRANSFERABLE_SKILLS = {
	"angular": ["react", "vue", "frontend"],
	"react": ["angular", "vue", "frontend"],
	"vue": ["react", "angular", "frontend"],
	"express": ["fastify", "koa", "hapi", "backend"],
	"fastify": ["express", "koa", "backend"],
	"django": ["flask", "fastapi", "backend", "python"],
	"flask": ["django", "fastapi", "backend", "python"],
	"spring": ["java", "backend"],
	"mysql": ["postgresql", "sql", "database"],
	"postgresql": ["mysql", "sql", "database"],
	"mongodb": ["nosql", "database"],
	"aws": ["cloud", "gcp", "azure"],
	"gcp": ["cloud", "aws", "azure"],
	"azure": ["cloud", "aws", "gcp"],
	"java": ["kotlin", "scala"],
	"kotlin": ["java"],
	"swift": ["objective-c", "ios"],
	"objective-c": ["swift", "ios"],
	"python": ["data science", "scripting"],
	"r": ["data science", "statistics"],
	"docker": ["kubernetes", "containerization", "devops"],
	"kubernetes": ["docker", "containerization", "devops"],
	"jenkins": ["ci/cd", "devops", "github actions"],
	"github actions": ["ci/cd", "devops", "jenkins"],
	"terraform": ["infrastructure as code", "devops", "cloudformation"],
};

// ---------------------------------------------------------------------------
// Skill matching
// ---------------------------------------------------------------------------

function matchSkill(candidateSkill, jobSkill) {
	const cNorm = normalizeText(candidateSkill);
	const jNorm = normalizeText(jobSkill);

	// Exact match
	if (cNorm === jNorm) return { type: "exact", score: 1.0 };

	// Synonym match
	const synonyms = SKILL_SYNONYMS[cNorm] || [];
	if (synonyms.includes(jNorm)) return { type: "synonym", score: 0.95 };

	// Contains match (e.g. "aws ec2" contains "aws")
	if (cNorm.includes(jNorm) || jNorm.includes(cNorm)) return { type: "partial", score: 0.8 };

	// Fuzzy match via Dice coefficient
	const dice = diceCoefficient(cNorm, jNorm);
	if (dice >= 0.75) return { type: "fuzzy", score: dice * 0.9 };

	return { type: "none", score: 0 };
}

function matchSkillSets(candidateSkills, jobSkills) {
	const matched = [];
	const missing = [];
	const transferable = [];
	const matchBreakdown = {};

	const candidateSet = new Set(candidateSkills.map((s) => normalizeText(s)));

	for (const jobSkill of jobSkills) {
		const jNorm = normalizeText(jobSkill);
		let bestMatch = null;
		let bestScore = 0;

		for (const cSkill of candidateSkills) {
			const result = matchSkill(cSkill, jobSkill);
			if (result.score > bestScore) {
				bestScore = result.score;
				bestMatch = { candidateSkill: cSkill, ...result };
			}
		}

		if (bestMatch && bestScore >= 0.7) {
			matched.push({
				jobSkill,
				candidateSkill: bestMatch.candidateSkill,
				matchType: bestMatch.type,
				confidence: Number(bestScore.toFixed(2)),
			});
			matchBreakdown[jobSkill] = bestMatch.type === "exact" ? "matched" : bestMatch.type;
		} else {
			// Check transferable
			let foundTransferable = false;
			for (const cSkill of candidateSkills) {
				const cNorm = normalizeText(cSkill);
				const transfers = TRANSFERABLE_SKILLS[cNorm] || [];
				if (transfers.some((t) => normalizeText(t) === jNorm || jNorm.includes(normalizeText(t)))) {
					transferable.push({
						jobSkill,
						candidateSkill: cSkill,
						note: `${cSkill} partially covers ${jobSkill} requirement`,
					});
					matchBreakdown[jobSkill] = "transferable";
					foundTransferable = true;
					break;
				}
			}

			if (!foundTransferable) {
				missing.push(jobSkill);
				matchBreakdown[jobSkill] = "missing";
			}
		}
	}

	return { matched, missing, transferable, matchBreakdown };
}

// ---------------------------------------------------------------------------
// Experience scoring
// ---------------------------------------------------------------------------

function scoreExperience(candidateYears, requiredYears, candidateExperience = []) {
	if (!requiredYears || requiredYears <= 0) {
		// No requirement specified - give moderate score based on having any experience
		if (candidateYears >= 5) return 85;
		if (candidateYears >= 2) return 70;
		if (candidateYears > 0) return 55;
		return 30;
	}

	const ratio = candidateYears / requiredYears;

	if (ratio >= 1.5) return 95;       // Significantly exceeds
	if (ratio >= 1.0) return 90;       // Meets requirement
	if (ratio >= 0.8) return 75;       // Close to requirement
	if (ratio >= 0.6) return 60;       // Somewhat below
	if (ratio >= 0.4) return 40;       // Notably below
	return 20;                          // Far below
}

// ---------------------------------------------------------------------------
// Education scoring
// ---------------------------------------------------------------------------

function detectEducationLevel(text) {
	const lower = (text || "").toLowerCase();
	let highest = -1;

	for (const [keyword, level] of Object.entries(EDUCATION_LEVELS)) {
		if (lower.includes(keyword) && level > highest) {
			highest = level;
		}
	}

	return highest;
}

function scoreEducation(candidateEduText, requiredEduText) {
	const candidateLevel = detectEducationLevel(candidateEduText);
	const requiredLevel = detectEducationLevel(requiredEduText);

	// No education requirement specified
	if (requiredLevel < 0) {
		if (candidateLevel >= 3) return 90;
		if (candidateLevel >= 2) return 75;
		if (candidateLevel >= 1) return 60;
		return 50;
	}

	// Compare levels
	if (candidateLevel >= requiredLevel + 1) return 95;  // Exceeds
	if (candidateLevel >= requiredLevel) return 90;       // Meets
	if (candidateLevel >= requiredLevel - 1) return 65;   // Close
	if (candidateLevel >= 0) return 40;                    // Has education but lower
	return 20;                                             // No education detected
}

// ---------------------------------------------------------------------------
// Keyword overlap / semantic fit (algorithmic approximation)
// ---------------------------------------------------------------------------

function computeKeywordOverlap(cvText, jobText) {
	const cvKeywords = new Set(extractKeywords(cvText, { maxKeywords: 60 }));
	const jobKeywords = extractKeywords(jobText, { maxKeywords: 40 });

	if (jobKeywords.length === 0) return { score: 50, overlap: 0, total: 0 };

	let hits = 0;
	for (const kw of jobKeywords) {
		if (cvKeywords.has(kw)) hits++;
	}

	const ratio = hits / jobKeywords.length;
	const score = Math.min(100, Math.round(ratio * 120)); // Scale up slightly, cap at 100

	return { score, overlap: hits, total: jobKeywords.length };
}

// ---------------------------------------------------------------------------
// Plagiarism / cheating detection
// ---------------------------------------------------------------------------

function jaccardSimilarity(setA, setB) {
	if (setA.size === 0 && setB.size === 0) return 0;
	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) intersection++;
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function computeNGrams(text, n = 3) {
	const words = tokenize(text);
	const grams = new Set();
	for (let i = 0; i <= words.length - n; i++) {
		grams.add(words.slice(i, i + n).join(" "));
	}
	return grams;
}

/**
 * Detect potential plagiarism/cheating indicators for a single candidate.
 *
 * @param {string} cvText - This candidate's CV text
 * @param {string} jobDescription - The job description text
 * @param {string[]} otherCvTexts - All other candidates' CV texts (for cross-comparison)
 * @returns {{ flags: string[], scores: object }}
 */
function detectPlagiarism(cvText, jobDescription, otherCvTexts = []) {
	const flags = [];
	const scores = {};

	const cvNorm = normalizeText(cvText || "");
	const jdNorm = normalizeText(jobDescription || "");

	if (!cvNorm) return { flags: ["Empty CV text"], scores: {} };

	// 1) Job description copy-paste detection
	// If large chunks of the JD appear verbatim in the CV, that is suspicious
	const cvNGrams = computeNGrams(cvNorm, 4);
	const jdNGrams = computeNGrams(jdNorm, 4);
	const jdOverlap = jaccardSimilarity(cvNGrams, jdNGrams);
	scores.jdCopyScore = Number((jdOverlap * 100).toFixed(1));

	if (jdOverlap > 0.25) {
		flags.push("High overlap with job description text - possible copy-paste from JD");
	} else if (jdOverlap > 0.15) {
		flags.push("Moderate overlap with job description text");
	}

	// 2) Keyword stuffing detection
	// If the CV has suspiciously high density of job keywords
	const jobKeywords = extractKeywords(jdNorm, { maxKeywords: 30 });
	const cvTokens = tokenize(cvNorm);
	if (cvTokens.length > 0 && jobKeywords.length > 0) {
		let keywordOccurrences = 0;
		for (const token of cvTokens) {
			if (jobKeywords.includes(token)) keywordOccurrences++;
		}
		const keywordDensity = keywordOccurrences / cvTokens.length;
		scores.keywordDensity = Number((keywordDensity * 100).toFixed(1));

		if (keywordDensity > 0.25) {
			flags.push("Suspiciously high keyword density - potential keyword stuffing");
		}
	}

	// 3) Cross-candidate duplicate detection
	// Compare this CV text against all other candidates' CVs
	let maxCrossSimilarity = 0;
	for (const otherCv of otherCvTexts) {
		const otherNorm = normalizeText(otherCv || "");
		if (!otherNorm || otherNorm === cvNorm) continue;

		const otherNGrams = computeNGrams(otherNorm, 4);
		const similarity = jaccardSimilarity(cvNGrams, otherNGrams);
		if (similarity > maxCrossSimilarity) {
			maxCrossSimilarity = similarity;
		}
	}
	scores.crossCandidateSimilarity = Number((maxCrossSimilarity * 100).toFixed(1));

	if (maxCrossSimilarity > 0.5) {
		flags.push("Very high similarity with another candidate's CV - possible duplicate submission");
	} else if (maxCrossSimilarity > 0.3) {
		flags.push("Notable similarity with another candidate's CV");
	}

	// 4) Suspiciously perfect keyword match
	// If ALL job keywords appear in the CV, that might be suspicious
	if (jobKeywords.length >= 5) {
		const matchRate = jobKeywords.filter((kw) => cvNorm.includes(kw)).length / jobKeywords.length;
		scores.perfectMatchRate = Number((matchRate * 100).toFixed(1));

		if (matchRate >= 0.95) {
			flags.push("Nearly perfect keyword match - unusually high alignment with job requirements");
		}
	}

	return { flags, scores };
}

// ---------------------------------------------------------------------------
// Red flags / green flags detection
// ---------------------------------------------------------------------------

function detectRedFlags(candidateProfile, cvText) {
	const flags = [];
	const norm = normalizeText(cvText || "");

	// Short tenure detection (multiple jobs under 1 year)
	const experience = candidateProfile.experience || [];
	const shortTenures = experience.filter((e) => {
		const years = e.years || e.duration || 0;
		return years > 0 && years < 1;
	});
	if (shortTenures.length >= 2) {
		flags.push(`Multiple short tenures (${shortTenures.length} roles under 1 year)`);
	}

	// Employment gaps (heuristic - if we have dates)
	// This is a simplified check; AI mode does deeper analysis
	if (experience.length === 0 && norm.length > 100) {
		flags.push("No structured work experience detected despite CV content");
	}

	// No education
	if (detectEducationLevel(cvText) < 0 && norm.length > 50) {
		flags.push("No education qualifications detected");
	}

	return flags;
}

function detectGreenFlags(candidateProfile, cvText) {
	const flags = [];
	const norm = normalizeText(cvText || "");

	// Certifications
	const certKeywords = ["certified", "certification", "certificate", "aws certified",
		"pmp", "scrum master", "google certified", "microsoft certified",
		"cisco certified", "comptia", "cfa", "cpa"];
	for (const cert of certKeywords) {
		if (norm.includes(cert)) {
			flags.push(`Professional certification detected: ${cert}`);
			break; // Only flag once
		}
	}

	// Notable companies
	for (const company of NOTABLE_COMPANIES) {
		if (norm.includes(company)) {
			flags.push(`Experience at notable company: ${company}`);
			break; // Only flag the first one found
		}
	}

	// Leadership indicators
	const leadershipTerms = ["led", "managed", "directed", "headed", "supervised",
		"team lead", "tech lead", "engineering manager", "vp of", "head of",
		"director of", "chief"];
	for (const term of leadershipTerms) {
		if (norm.includes(term)) {
			flags.push("Leadership experience indicated");
			break;
		}
	}

	// Promotion indicators
	const promotionTerms = ["promoted", "promotion", "advanced to", "elevated to"];
	for (const term of promotionTerms) {
		if (norm.includes(term)) {
			flags.push("Career progression/promotions indicated");
			break;
		}
	}

	return flags;
}

// ---------------------------------------------------------------------------
// Tier & recommendation helpers
// ---------------------------------------------------------------------------

function assignTier(score) {
	if (score >= 85) return "excellent";
	if (score >= 70) return "strong";
	if (score >= 50) return "moderate";
	return "weak";
}

function assignRecommendation(score, redFlagCount, plagiarismFlagCount) {
	// Downgrade if significant red/plagiarism flags
	let adjusted = score;
	if (plagiarismFlagCount >= 2) adjusted -= 15;
	else if (plagiarismFlagCount >= 1) adjusted -= 5;
	if (redFlagCount >= 3) adjusted -= 10;

	if (adjusted >= 85) return "strong_yes";
	if (adjusted >= 70) return "yes";
	if (adjusted >= 50) return "maybe";
	return "no";
}

// ---------------------------------------------------------------------------
// AI-enhanced analysis (optional, when API keys available)
// ---------------------------------------------------------------------------

function isAIAvailable() {
	return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

function getAIProvider() {
	if (process.env.ANTHROPIC_API_KEY) return "anthropic";
	if (process.env.OPENAI_API_KEY) return "openai";
	return null;
}

async function callAI(prompt, maxTokens = 1500) {
	const provider = getAIProvider();

	if (provider === "anthropic") {
		try {
			const Anthropic = require("@anthropic-ai/sdk");
			const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
			const response = await client.messages.create({
				model: "claude-sonnet-4-20250514",
				max_tokens: maxTokens,
				messages: [{ role: "user", content: prompt }],
			});
			return response.content[0].text;
		} catch (err) {
			console.error("[MatchingEngine] Anthropic API error:", err.message);
			return null;
		}
	}

	if (provider === "openai") {
		try {
			const OpenAI = require("openai");
			const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
			const response = await client.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: prompt }],
				max_tokens: maxTokens,
			});
			return response.choices[0].message.content;
		} catch (err) {
			console.error("[MatchingEngine] OpenAI API error:", err.message);
			return null;
		}
	}

	return null;
}

function parseAIJson(text) {
	if (!text) return null;
	try {
		let clean = text.trim();
		// Strip markdown code fences
		if (clean.startsWith("```json")) clean = clean.slice(7);
		else if (clean.startsWith("```")) clean = clean.slice(3);
		if (clean.endsWith("```")) clean = clean.slice(0, -3);
		clean = clean.trim();
		return JSON.parse(clean);
	} catch (err) {
		console.error("[MatchingEngine] AI JSON parse failed:", err.message);
		return null;
	}
}

async function aiSemanticAnalysis(candidateProfile, jobProfile, skillGapResult) {
	const candidateSkills = (candidateProfile.skills || []).join(", ") || "None listed";
	const cvText = (candidateProfile.cvText || "").slice(0, 2000);
	const jobSkills = (jobProfile.requiredSkills || []).join(", ");
	const preferredSkills = (jobProfile.preferredSkills || []).join(", ");

	const prompt = `You are a senior technical recruiter with 15 years of experience.
Perform a deep semantic assessment of this candidate-job fit.

CANDIDATE
Name: ${candidateProfile.name || "Unknown"}
Total Experience: ${candidateProfile.totalYears || "?"} years
Skills: ${candidateSkills}
Education: ${candidateProfile.education || "Not specified"}

Resume Text (excerpt):
${cvText}

JOB: ${jobProfile.title || "Not specified"} at ${jobProfile.company || "Not specified"}
Required Skills: ${jobSkills || "Not specified"}
Preferred Skills: ${preferredSkills || "Not specified"}
Min Experience: ${jobProfile.minYearsExperience || "Not specified"} years
Education Required: ${jobProfile.educationRequirement || "Not specified"}

Job Description:
${(jobProfile.description || "").slice(0, 1500)}

SKILL GAP RESULTS (from algorithmic analysis):
Match Score: ${skillGapResult.skillScore}/100
Matched: ${skillGapResult.matched.map((m) => m.jobSkill).join(", ")}
Missing: ${skillGapResult.missing.join(", ")}
Transferable: ${skillGapResult.transferable.map((t) => t.note).join("; ")}

Assess:
1. Experience depth - relevance, growth trajectory
2. Soft skills - infer from language
3. Seniority fit
4. Education fit
5. Red flags - gaps, short tenures
6. Green flags - certifications, notable companies, promotions

Be honest. Do NOT inflate scores.

Return ONLY valid JSON:
{
  "semantic_match_score": <0-100>,
  "experience_relevance_score": <0-100>,
  "education_fit_score": <0-100>,
  "soft_skills_detected": ["specific soft skills"],
  "key_strengths": ["3-5 strongest points for THIS role"],
  "key_concerns": ["2-4 genuine risks or gaps"],
  "recommendation_summary": "3-4 sentence recruiter summary with clear hire/interview/pass recommendation.",
  "interview_talking_points": ["4-6 specific questions to probe"],
  "overall_recommendation": "strong_yes | yes | maybe | no",
  "seniority_fit": "under | matched | over",
  "red_flags": ["specific red flags"],
  "green_flags": ["specific green flags"]
}`;

	const raw = await callAI(prompt, 1500);
	return parseAIJson(raw);
}

// ---------------------------------------------------------------------------
// Main matching function: match ONE candidate against ONE job
// ---------------------------------------------------------------------------

/**
 * Match a single candidate against a job vacancy.
 *
 * @param {object} params
 * @param {object} params.jobProfile - { title, description, requiredSkills[], preferredSkills[],
 *                                       minYearsExperience, educationRequirement, company }
 * @param {object} params.candidateProfile - { name, email, skills[], cvText, totalYears,
 *                                              education, experience[], certifications[] }
 * @param {string[]} params.otherCvTexts - CV texts from other candidates (for plagiarism check)
 * @param {boolean} params.useAI - Whether to attempt AI-enhanced analysis
 * @returns {object} Match result
 */
async function matchCandidate({ jobProfile, candidateProfile, otherCvTexts = [], useAI = true }) {
	const cvText = candidateProfile.cvText || "";
	const jobText = `${jobProfile.title || ""} ${jobProfile.description || ""}`;

	// --- 1. Skill matching (35% weight) ---
	const allJobSkills = [
		...(jobProfile.requiredSkills || []),
		...(jobProfile.preferredSkills || []),
	];
	const candidateSkills = candidateProfile.skills || [];

	// Match against required skills
	const requiredMatch = matchSkillSets(candidateSkills, jobProfile.requiredSkills || []);
	// Match against preferred skills
	const preferredMatch = matchSkillSets(candidateSkills, jobProfile.preferredSkills || []);

	// Compute skill score
	const requiredTotal = (jobProfile.requiredSkills || []).length || 1;
	const preferredTotal = (jobProfile.preferredSkills || []).length || 1;

	const requiredMatchRate = requiredMatch.matched.length / requiredTotal;
	const preferredMatchRate = preferredMatch.matched.length / preferredTotal;
	const transferableBonus = (requiredMatch.transferable.length * 0.3) / requiredTotal;

	// Required skills weighted more heavily than preferred
	let skillScore = Math.round(
		(requiredMatchRate * 0.75 + preferredMatchRate * 0.15 + transferableBonus * 0.10) * 100
	);
	skillScore = Math.min(100, Math.max(0, skillScore));

	// --- 2. Experience scoring (25% weight) ---
	const candidateYears = candidateProfile.totalYears || 0;
	const requiredYears = jobProfile.minYearsExperience || 0;
	let experienceScore = scoreExperience(candidateYears, requiredYears, candidateProfile.experience);

	// --- 3. Education scoring (15% weight) ---
	const candidateEdu = candidateProfile.education || cvText;
	const requiredEdu = jobProfile.educationRequirement || jobProfile.description || "";
	let educationScore = scoreEducation(candidateEdu, requiredEdu);

	// --- 4. Semantic fit / keyword overlap (25% weight) ---
	const keywordResult = computeKeywordOverlap(cvText, jobText);
	let semanticScore = keywordResult.score;

	// --- 5. Plagiarism detection ---
	const plagiarism = detectPlagiarism(cvText, jobProfile.description || "", otherCvTexts);

	// --- 6. Red/green flags ---
	let redFlags = detectRedFlags(candidateProfile, cvText);
	let greenFlags = detectGreenFlags(candidateProfile, cvText);

	// --- 7. AI enhancement (if available and requested) ---
	let aiAnalysis = null;
	let interviewTalkingPoints = [];
	let recruiterSummary = "";
	let softSkills = [];

	if (useAI && isAIAvailable()) {
		try {
			aiAnalysis = await aiSemanticAnalysis(candidateProfile, jobProfile, {
				skillScore,
				matched: requiredMatch.matched,
				missing: requiredMatch.missing,
				transferable: requiredMatch.transferable,
			});

			if (aiAnalysis) {
				// Blend AI scores with algorithmic scores
				semanticScore = Math.round(
					(semanticScore * 0.4 + (aiAnalysis.semantic_match_score || semanticScore) * 0.6)
				);
				experienceScore = Math.round(
					(experienceScore * 0.4 + (aiAnalysis.experience_relevance_score || experienceScore) * 0.6)
				);
				educationScore = Math.round(
					(educationScore * 0.4 + (aiAnalysis.education_fit_score || educationScore) * 0.6)
				);

				interviewTalkingPoints = aiAnalysis.interview_talking_points || [];
				recruiterSummary = aiAnalysis.recommendation_summary || "";
				softSkills = aiAnalysis.soft_skills_detected || [];

				// Merge AI-detected flags
				if (aiAnalysis.red_flags) {
					redFlags = [...new Set([...redFlags, ...aiAnalysis.red_flags])];
				}
				if (aiAnalysis.green_flags) {
					greenFlags = [...new Set([...greenFlags, ...aiAnalysis.green_flags])];
				}
			}
		} catch (err) {
			console.error("[MatchingEngine] AI analysis error:", err.message);
			// Continue with algorithmic results
		}
	}

	// If no AI, generate basic interview points and summary
	if (!aiAnalysis) {
		if (requiredMatch.missing.length > 0) {
			interviewTalkingPoints.push(
				`Assess knowledge of missing required skills: ${requiredMatch.missing.slice(0, 3).join(", ")}`
			);
		}
		if (requiredMatch.transferable.length > 0) {
			interviewTalkingPoints.push(
				`Explore transferable experience: ${requiredMatch.transferable.slice(0, 2).map((t) => t.note).join("; ")}`
			);
		}
		if (candidateYears < requiredYears) {
			interviewTalkingPoints.push(
				`Discuss experience depth - candidate has ${candidateYears} years vs ${requiredYears} required`
			);
		}
		interviewTalkingPoints.push("Assess communication skills and cultural fit");
		interviewTalkingPoints.push("Verify key technical claims with practical questions");
	}

	// --- 8. Compute overall composite score ---
	const overallScore = Number(
		(
			skillScore * 0.35 +
			experienceScore * 0.25 +
			educationScore * 0.15 +
			semanticScore * 0.25
		).toFixed(1)
	);
	const clampedScore = Math.min(100, Math.max(0, overallScore));

	// --- 9. Tier & recommendation ---
	const tier = assignTier(clampedScore);
	const recommendation = aiAnalysis?.overall_recommendation ||
		assignRecommendation(clampedScore, redFlags.length, plagiarism.flags.length);

	// Generate recruiter summary if AI didn't provide one
	if (!recruiterSummary) {
		const matchedCount = requiredMatch.matched.length;
		const totalRequired = (jobProfile.requiredSkills || []).length;
		recruiterSummary = `Candidate matches ${matchedCount} of ${totalRequired} required skills (${skillScore}% skill match). `;
		recruiterSummary += `Experience: ${candidateYears} years${requiredYears ? ` vs ${requiredYears} required` : ""}. `;
		recruiterSummary += `Overall ${tier} match at ${clampedScore}/100. `;
		recruiterSummary += `Recommendation: ${recommendation.replace("_", " ")}.`;
	}

	return {
		candidate: {
			name: candidateProfile.name || "Unknown",
			email: candidateProfile.email || "",
			id: candidateProfile.id || null,
			jobSeekerId: candidateProfile.jobSeekerId || null,
			applicationId: candidateProfile.applicationId || null,
		},
		scores: {
			overall: clampedScore,
			skills: skillScore,
			experience: experienceScore,
			education: educationScore,
			semanticFit: semanticScore,
		},
		weights: {
			skills: 0.35,
			experience: 0.25,
			education: 0.15,
			semanticFit: 0.25,
		},
		tier,
		recommendation,
		skillGap: {
			matchedRequired: requiredMatch.matched,
			missingRequired: requiredMatch.missing,
			matchedPreferred: preferredMatch.matched,
			missingPreferred: preferredMatch.missing,
			transferableSkills: [
				...requiredMatch.transferable,
				...preferredMatch.transferable,
			],
			matchBreakdown: {
				...requiredMatch.matchBreakdown,
				...preferredMatch.matchBreakdown,
			},
		},
		plagiarism: {
			flags: plagiarism.flags,
			scores: plagiarism.scores,
		},
		redFlags,
		greenFlags,
		interviewTalkingPoints,
		recruiterSummary,
		softSkills,
		meta: {
			aiEnhanced: !!aiAnalysis,
			aiProvider: aiAnalysis ? getAIProvider() : null,
			matchedAt: new Date().toISOString(),
		},
	};
}

// ---------------------------------------------------------------------------
// Batch matching: match ALL candidates against ONE job, return ranked list
// ---------------------------------------------------------------------------

/**
 * Rank multiple candidates against a single job.
 *
 * @param {object} params
 * @param {object} params.jobProfile - Job profile data
 * @param {object[]} params.candidates - Array of candidate profiles
 * @param {boolean} params.useAI - Whether to use AI enhancement
 * @returns {object} Ranked results
 */
async function rankCandidates({ jobProfile, candidates, useAI = true }) {
	// Collect all CV texts for cross-candidate plagiarism detection
	const allCvTexts = candidates.map((c) => c.cvText || "");

	const results = [];

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		// Other CV texts = all except this candidate
		const otherCvTexts = allCvTexts.filter((_, idx) => idx !== i);

		try {
			const matchResult = await matchCandidate({
				jobProfile,
				candidateProfile: candidate,
				otherCvTexts,
				useAI,
			});
			results.push(matchResult);
		} catch (err) {
			console.error(`[MatchingEngine] Error matching candidate ${candidate.name || i}:`, err.message);
			// Include a failed result so it's not silently dropped
			results.push({
				candidate: {
					name: candidate.name || "Unknown",
					email: candidate.email || "",
					id: candidate.id || null,
					jobSeekerId: candidate.jobSeekerId || null,
					applicationId: candidate.applicationId || null,
				},
				scores: { overall: 0, skills: 0, experience: 0, education: 0, semanticFit: 0 },
				tier: "weak",
				recommendation: "no",
				skillGap: { matchedRequired: [], missingRequired: [], matchedPreferred: [], missingPreferred: [], transferableSkills: [], matchBreakdown: {} },
				plagiarism: { flags: [], scores: {} },
				redFlags: ["Matching engine error - manual review required"],
				greenFlags: [],
				interviewTalkingPoints: [],
				recruiterSummary: "Analysis failed for this candidate. Manual review recommended.",
				softSkills: [],
				meta: { aiEnhanced: false, aiProvider: null, matchedAt: new Date().toISOString(), error: err.message },
			});
		}
	}

	// Sort by overall score descending
	results.sort((a, b) => b.scores.overall - a.scores.overall);

	// Assign ranks
	results.forEach((r, idx) => {
		r.rank = idx + 1;
	});

	// Summary stats
	const tierCounts = { excellent: 0, strong: 0, moderate: 0, weak: 0 };
	for (const r of results) {
		tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
	}

	return {
		job: {
			title: jobProfile.title,
			company: jobProfile.company,
			requiredSkills: jobProfile.requiredSkills,
			preferredSkills: jobProfile.preferredSkills,
		},
		totalCandidates: candidates.length,
		rankings: results,
		summary: {
			tierCounts,
			averageScore: results.length > 0
				? Number((results.reduce((sum, r) => sum + r.scores.overall, 0) / results.length).toFixed(1))
				: 0,
			topCandidate: results.length > 0 ? results[0].candidate.name : null,
			aiEnhanced: results.some((r) => r.meta.aiEnhanced),
		},
		rankedAt: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Helper: build job profile from Prisma Job model
// ---------------------------------------------------------------------------

function buildJobProfile(job) {
	const requiredSkills = (job.skills || [])
		.map((js) => js.skill?.name)
		.filter(Boolean);

	// Try to extract preferred skills from description (heuristic)
	const description = job.description || "";
	const preferredSkills = [];

	// Look for "nice to have" / "preferred" sections
	const niceToHaveMatch = description.match(/(?:nice to have|preferred|bonus|plus|advantageous)[:\s]*([^]*?)(?:\n\n|\n[A-Z]|$)/i);
	if (niceToHaveMatch) {
		const lines = niceToHaveMatch[1].split(/[\n,;]/).map((l) => l.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
		preferredSkills.push(...lines.slice(0, 10));
	}

	// Extract experience requirement from description
	let minYearsExperience = null;
	const expMatch = description.match(/(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:experience|exp)/i);
	if (expMatch) {
		minYearsExperience = parseInt(expMatch[1], 10);
	}

	// Parse experience level from job
	if (!minYearsExperience && job.experienceLevel) {
		const level = (job.experienceLevel || "").toLowerCase();
		if (level.includes("senior") || level.includes("lead")) minYearsExperience = 5;
		else if (level.includes("mid")) minYearsExperience = 3;
		else if (level.includes("junior") || level.includes("entry")) minYearsExperience = 1;
	}

	return {
		title: job.title || "",
		description: description,
		company: job.company?.name || "",
		requiredSkills,
		preferredSkills,
		minYearsExperience,
		educationRequirement: job.experienceLevel || "",
		employmentType: job.employmentType || "",
	};
}

// ---------------------------------------------------------------------------
// Helper: build candidate profile from Prisma data
// ---------------------------------------------------------------------------

function buildCandidateProfile(application) {
	const jobSeeker = application.jobSeeker || {};
	const user = jobSeeker.user || {};
	const skills = (jobSeeker.skills || []).map((s) => s.skill?.name).filter(Boolean);
	const cv = application.cv || {};
	const cvText = cv.extractedText || "";

	// Try to estimate total years from CV text
	let totalYears = 0;
	const yearsMatch = (cvText || "").match(/(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:experience|exp)/i);
	if (yearsMatch) {
		totalYears = parseInt(yearsMatch[1], 10);
	}

	return {
		id: user.id || null,
		jobSeekerId: jobSeeker.id || null,
		applicationId: application.id || null,
		name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Unknown",
		email: user.email || "",
		phone: user.phoneNumber || "",
		skills,
		cvText,
		totalYears,
		education: cvText, // Education is parsed from CV text
		experience: [],     // Would need structured experience data
		certifications: [],
	};
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
	// Core matching
	matchCandidate,
	rankCandidates,

	// Profile builders
	buildJobProfile,
	buildCandidateProfile,

	// Utilities (exported for testing/reuse)
	normalizeText,
	tokenize,
	extractKeywords,
	matchSkill,
	matchSkillSets,
	diceCoefficient,
	scoreExperience,
	scoreEducation,
	detectEducationLevel,
	computeKeywordOverlap,
	detectPlagiarism,
	detectRedFlags,
	detectGreenFlags,
	assignTier,
	assignRecommendation,
	isAIAvailable,
	jaccardSimilarity,
};
