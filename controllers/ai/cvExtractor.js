/**
 * CV Data Extractor
 * =================
 * Extracts structured data from uploaded CV files (PDF).
 *
 * Works in two modes:
 *   1. Regex/heuristic extraction (no API key required)
 *      - Extracts: name, email, phone, skills, experience, education, certifications
 *      - Uses pattern matching and section detection
 *
 *   2. AI-enhanced extraction (when ANTHROPIC_API_KEY or OPENAI_API_KEY is set)
 *      - Sends extracted text to Claude/GPT for more accurate structured extraction
 *      - Returns richer, more accurate parsed data
 *
 * Depends on pdf-parse (already in package.json).
 */

const fs = require("fs/promises");
const path = require("path");

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

/**
 * Extract raw text from a PDF buffer.
 * Uses the pdf-parse library already available in the project.
 *
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromPDF(pdfBuffer) {
	// Protect JSON.parse from pdf-parse monkey-patching
	const originalJSONParse = JSON.parse;
	const pdfParse = require("pdf-parse");
	JSON.parse = originalJSONParse;

	const pdfData = await pdfParse(pdfBuffer);
	const text = pdfData.text;

	// pdfParse returns { text, numpages, info, metadata, version }
	if (typeof text === "string") return text;
	if (Array.isArray(text)) return text.join("\n");
	if (text && typeof text === "object") {
		// Try common properties
		if (typeof text.text === "string") return text.text;
		// Flatten array-like structures
		return Object.values(text).filter(v => typeof v === "string").join("\n");
	}
	return String(text);
}

// ---------------------------------------------------------------------------
// Regex-based extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract email addresses from text.
 */
function extractEmails(text) {
	const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
	const matches = text.match(emailRegex) || [];
	return [...new Set(matches)];
}

/**
 * Extract phone numbers from text.
 */
function extractPhones(text) {
	const phoneRegex = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,4}\)?[\s\-.]?\d{2,4}[\s\-.]?\d{2,4}(?:[\s\-.]?\d{1,4})?/g;
	const matches = text.match(phoneRegex) || [];
	// Filter out short numbers (likely not phones) and clean up
	return [...new Set(
		matches
			.map((p) => p.trim())
			.filter((p) => p.replace(/[\s\-().+]/g, "").length >= 7)
	)];
}

/**
 * Extract name from the beginning of CV text.
 * Heuristic: First non-empty line that looks like a name.
 */
function extractName(text) {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

	for (let i = 0; i < Math.min(5, lines.length); i++) {
		const line = lines[i];

		// Skip lines that are obviously not names
		if (line.length > 60) continue;
		if (line.match(/^(curriculum|resume|cv|profile|about|summary|objective)/i)) continue;
		if (line.includes("@")) continue; // email
		if (line.match(/^\+?\d/)) continue; // phone number
		if (line.match(/^(http|www)/i)) continue; // URL

		// Name should be 2-5 words, alphabetic
		const words = line.split(/\s+/).filter((w) => w.match(/^[a-zA-Z.\-']+$/));
		if (words.length >= 2 && words.length <= 5 && line.length <= 50) {
			return words.map((w) =>
				w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
			).join(" ");
		}
	}

	return null;
}

/**
 * Detect section boundaries in CV text.
 * Returns a map of section names to their text content.
 */
function detectSections(text) {
	const sectionHeaders = {
		skills: /^(?:skills|technical skills|core competencies|key skills|top skills|technologies|proficiencies|tools & technologies|expertise|competencies|areas of expertise|professional skills|soft skills|hard skills|transferable skills)/im,
		experience: /^(?:experience|work experience|professional experience|employment|employment history|work history|career history|relevant experience|clinical experience|teaching experience|industry experience|internships?)/im,
		education: /^(?:education|academic|qualifications|degrees|educational background|academic qualifications|training|academic history)/im,
		certifications: /^(?:certifications?|certificates?|professional certifications?|licenses?|credentials|professional development|continuing education|accreditations?|professional licenses?)/im,
		summary: /^(?:summary|professional summary|profile|about|objective|career objective|personal statement|executive summary|professional profile|overview)/im,
		projects: /^(?:projects|key projects|selected projects|notable projects|portfolio|case studies)/im,
		languages: /^(?:languages|language skills|language proficiency|spoken languages)/im,
		volunteer: /^(?:volunteer|volunteering|community service|community involvement|civic engagement)/im,
		publications: /^(?:publications?|research|papers|presentations|conferences)/im,
		awards: /^(?:awards?|honors?|achievements?|recognition|accomplishments|key achievements)/im,
		interests: /^(?:interests?|hobbies|personal interests|activities|extracurricular)/im,
		references: /^(?:references?|referees?)/im,
	};

	const lines = text.split("\n");
	const sections = {};
	let currentSection = "header";
	let currentContent = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			currentContent.push("");
			continue;
		}

		let foundSection = false;
		for (const [sectionName, regex] of Object.entries(sectionHeaders)) {
			if (regex.test(trimmed) && trimmed.length < 60) {
				// Save previous section
				if (currentContent.length > 0) {
					sections[currentSection] = currentContent.join("\n").trim();
				}
				currentSection = sectionName;
				currentContent = [];
				foundSection = true;
				break;
			}
		}

		if (!foundSection) {
			currentContent.push(trimmed);
		}
	}

	// Save last section
	if (currentContent.length > 0) {
		sections[currentSection] = currentContent.join("\n").trim();
	}

	return sections;
}

/**
 * Extract skills from text (skills section or full text).
 */
function extractSkillsFromText(text) {
	if (!text) return [];

	// Common skill patterns: comma-separated, pipe-separated, bullet-separated
	const skills = new Set();

	// Split by common delimiters
	const parts = text.split(/[,|;\n\r]/).map((s) => s.trim()).filter(Boolean);

	for (let part of parts) {
		// Clean up bullet points, dashes, numbers
		part = part.replace(/^[\-*\u2022\u2023\u25E6\d.)\]]+\s*/, "").trim();

		// Skip very long strings (likely sentences, not skill names)
		if (part.length > 50) continue;
		// Skip very short strings
		if (part.length < 2) continue;
		// Skip if looks like a sentence
		if (part.split(" ").length > 5) continue;
		// Skip emails, phones, URLs, addresses
		if (part.includes("@") || part.match(/^\+?\d{7,}/) || part.match(/^(http|www)/i)) continue;
		if (part.match(/^\d+\s+\w+\s+(drive|street|road|ave|blvd)/i)) continue;

		skills.add(part);
	}

	return [...skills];
}

/**
 * Extract experience entries from text.
 * Handles multiple common CV formats:
 *   - "Job Title at Company (Date - Date)"
 *   - "Company\nJob Title\nDate - Date"
 *   - "• Role – Company" (bullet format)
 *   - "Role | Company | Date"
 */
function extractExperience(text) {
	if (!text) return [];

	const entries = [];
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

	const datePattern = /(?:(\w+\s+)?(\d{4})\s*[-–—]\s*(present|(?:\w+\s+)?\d{4})|(\w+\s+\d{4})\s*[-–—]\s*(present|\w+\s+\d{4}))/i;
	// Match: "Title at Company", "Title – Company", "Title | Company", "Title - Company"
	const titleCompanyPattern = /^[\u2022\-*]*\s*(.+?)(?:\s+(?:at|@)\s+|\s+[-–—|]+\s+)(.+?)$/i;

	let currentEntry = null;
	let descriptionLines = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Remove leading bullet chars for analysis
		const cleanBullet = line.replace(/^[\u2022\u2023\u25E6\-*]+\s*/, "").trim();
		const hasDate = datePattern.test(line);
		const tcMatch = cleanBullet.match(titleCompanyPattern);

		// Check if this looks like a new entry header (has title-company pattern or a date line)
		const isNewEntry = (tcMatch && cleanBullet.length < 120) || hasDate;

		// Also detect: lines that are just a company or role name (no bullet, short, followed by date)
		const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
		const isCompanyLine = !line.startsWith("\u2022") && !line.startsWith("-") && !line.startsWith("*")
			&& line.length < 80 && line.length > 3 && !hasDate && datePattern.test(nextLine);

		if (isNewEntry) {
			// Save previous entry
			if (currentEntry) {
				currentEntry.description = descriptionLines.join(" ").trim();
				entries.push(currentEntry);
				descriptionLines = [];
			}

			// Extract dates
			const dateMatch = line.match(datePattern);
			let startDate = null;
			let endDate = null;
			let isCurrent = false;

			if (dateMatch) {
				// Group 1+2 or 4: start part, Group 3 or 5: end part
				const startPart = dateMatch[4] || ((dateMatch[1] || "") + dateMatch[2]).trim();
				const endPart = dateMatch[5] || dateMatch[3];

				startDate = startPart || null;
				if (endPart && endPart.toLowerCase() === "present") {
					isCurrent = true;
					endDate = "Present";
				} else {
					endDate = endPart || null;
				}
			}

			// Clean line of dates and parens for title/company
			const lineClean = cleanBullet.replace(datePattern, "").replace(/[()]/g, "").replace(/\s{2,}/g, " ").trim();

			currentEntry = {
				title: tcMatch ? tcMatch[1].trim() : lineClean,
				company: tcMatch ? tcMatch[2].trim() : "",
				startDate,
				endDate,
				isCurrent,
				startYear: startDate ? parseInt((startDate.match(/(\d{4})/) || [])[1]) || null : null,
				endYear: endDate && endDate !== "Present" ? parseInt((endDate.match(/(\d{4})/) || [])[1]) || null : (isCurrent ? new Date().getFullYear() : null),
				description: "",
			};
			if (currentEntry.startYear && currentEntry.endYear) {
				currentEntry.years = currentEntry.endYear - currentEntry.startYear;
			}
		} else if (isCompanyLine && !currentEntry) {
			// This is a company name line followed by a date line — next iteration will create the entry
			// Save previous
			if (currentEntry) {
				currentEntry.description = descriptionLines.join(" ").trim();
				entries.push(currentEntry);
				descriptionLines = [];
			}

			// Peek ahead for title and date
			const dateMatch = nextLine.match(datePattern);
			let startDate = null, endDate = null, isCurrent = false;
			if (dateMatch) {
				const startPart = dateMatch[4] || ((dateMatch[1] || "") + dateMatch[2]).trim();
				const endPart = dateMatch[5] || dateMatch[3];
				startDate = startPart || null;
				if (endPart && endPart.toLowerCase() === "present") { isCurrent = true; endDate = "Present"; }
				else { endDate = endPart || null; }
			}

			// Check if there's a title line between company and date
			const titleLine = nextLine.replace(datePattern, "").replace(/[()]/g, "").trim();

			currentEntry = {
				title: titleLine || line,
				company: line,
				startDate,
				endDate,
				isCurrent,
				startYear: startDate ? parseInt((startDate.match(/(\d{4})/) || [])[1]) || null : null,
				endYear: endDate && endDate !== "Present" ? parseInt((endDate.match(/(\d{4})/) || [])[1]) || null : (isCurrent ? new Date().getFullYear() : null),
				description: "",
			};
			if (currentEntry.startYear && currentEntry.endYear) {
				currentEntry.years = currentEntry.endYear - currentEntry.startYear;
			}
			i++; // Skip the date line we already consumed
		} else if (currentEntry) {
			const cleaned = cleanBullet;
			if (cleaned.length > 5) {
				descriptionLines.push(cleaned);
			}
		}
	}

	// Don't forget the last entry
	if (currentEntry) {
		currentEntry.description = descriptionLines.join(" ").trim();
		entries.push(currentEntry);
	}

	return entries;
}

/**
 * Extract education entries from text.
 */
function extractEducation(text) {
	if (!text) return [];

	const entries = [];
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

	const degreePattern = /(?:ph\.?d|doctorate|master(?:'s)?|m\.?s\.?c?|m\.?b\.?a|m\.?a\.?|bachelor(?:'s)?|b\.?s\.?c?|b\.?a\.?|b\.?eng|associate|diploma|hnd|certificate)/i;
	const yearPattern = /\b(19|20)\d{2}\b/;

	for (const line of lines) {
		if (degreePattern.test(line) || yearPattern.test(line)) {
			const degreeMatch = line.match(degreePattern);
			const yearMatch = line.match(yearPattern);

			// Try to split degree from institution
			const parts = line.split(/[-–|,]/).map((p) => p.trim()).filter(Boolean);

			entries.push({
				degree: degreeMatch ? degreeMatch[0] : parts[0] || line,
				institution: parts.length > 1 ? parts[1].replace(yearPattern, "").trim() : "",
				year: yearMatch ? parseInt(yearMatch[0]) : null,
				raw: line,
			});
		}
	}

	return entries;
}

/**
 * Extract certifications from text.
 */
function extractCertifications(text) {
	if (!text) return [];

	const certs = [];
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

	const certKeywords = [
		// General
		"certified", "certification", "certificate", "licensed", "license",
		"accredited", "accreditation", "chartered", "registered", "diploma",
		"professional", "associate", "expert", "specialist", "practitioner",
		// Tech
		"aws", "azure", "gcp", "cisco", "comptia", "microsoft", "google",
		"oracle", "itil", "scrum", "agile", "prince2", "devops", "kubernetes",
		// Project Management
		"pmp", "capm", "six sigma", "lean", "pmbok",
		// Finance & Accounting
		"cfa", "cpa", "acca", "cima", "cfp", "frm", "caia", "fmva", "cia",
		// Healthcare & Medical
		"bls", "acls", "pals", "rn", "lpn", "cna", "phlebotomy", "hipaa",
		"nursing", "paramedic", "emt", "first aid", "cpr", "medical",
		// Legal
		"bar admission", "paralegal", "notary", "legal", "compliance",
		// Construction & Engineering
		"osha", "nebosh", "iosh", "leed", "pmp", "pe ", "eit",
		"safety", "hazmat", "forklift", "crane", "welding",
		// Hospitality & Food
		"haccp", "servsafe", "food safety", "hygiene", "sommelier",
		"hospitality", "tourism", "hotel management",
		// Education
		"tefl", "tesol", "celta", "teaching", "pedagogy",
		// HR & Management
		"shrm", "cipd", "sphr", "phr", "coaching",
		// Real Estate
		"real estate", "property", "rera", "valuation",
		// Marketing & Digital
		"hubspot", "salesforce", "seo", "adwords", "analytics",
		// Logistics & Supply Chain
		"cscp", "cpim", "cltd", "supply chain", "logistics",
	];

	for (const line of lines) {
		const lower = line.toLowerCase();
		const cleaned = line.replace(/^[\-*\u2022\u2023\u25E6\d.)\]]+\s*/, "").trim();

		if (cleaned.length < 5 || cleaned.length > 120) continue;

		// Check if line contains certification-related keywords
		if (certKeywords.some((kw) => lower.includes(kw))) {
			certs.push(cleaned);
		}
	}

	return [...new Set(certs)];
}

// ---------------------------------------------------------------------------
// Affinda extraction (optional, requires AFFINDA_API_KEY)
// ---------------------------------------------------------------------------

async function extractWithAffinda(pdfBuffer) {
	if (!process.env.AFFINDA_API_KEY) return null;

	try {
		const { AffindaAPI, AffindaCredential } = require("@affinda/affinda");
		const credential = new AffindaCredential(process.env.AFFINDA_API_KEY);
		const client = new AffindaAPI(credential);

		const doc = await client.createDocument({
			file: pdfBuffer,
			workspace: process.env.AFFINDA_WORKSPACE || undefined,
			wait: true,
		});

		if (!doc || !doc.data) return null;
		const d = doc.data;

		return {
			name: d.name?.raw || null,
			title: d.profession || d.jobTitle || null,
			email: d.emails?.[0] || null,
			phone: d.phoneNumbers?.[0] || null,
			location: d.location?.rawInput || d.location?.formatted || null,
			summary: d.summary || d.objective || null,
			skills: (d.skills || []).map((s) => s.name || s).filter(Boolean),
			experience: (d.workExperience || []).map((w) => ({
				role: w.jobTitle || "",
				company: w.organization || "",
				location: w.location?.rawInput || "",
				start_date: w.dates?.startDate || "",
				end_date: w.dates?.isCurrent ? "Present" : (w.dates?.endDate || ""),
				description: w.jobDescription || "",
			})),
			education: (d.education || []).map((e) => ({
				degree: e.accreditation?.education || e.accreditation?.inputStr || "",
				institution: e.organization || "",
				location: e.location?.rawInput || "",
				start_date: e.dates?.startDate || "",
				end_date: e.dates?.completionDate || "",
				grade: e.grade?.raw || "",
				description: "",
			})),
			certifications: (d.certifications || []).map((c) => ({
				name: c.name || c,
				organization: "",
				issue_date: "",
			})),
			languages: (d.languages || []).map((l) => typeof l === "string" ? l : l.name || l),
			awards: [],
			interests: [],
			totalYearsExperience: d.totalYearsExperience || 0,
			_aiProvider: "affinda",
		};
	} catch (err) {
		console.error("[cvExtractor] Affinda extraction failed:", err.message);
		return null;
	}
}

// ---------------------------------------------------------------------------
// AI-enhanced extraction (optional)
// ---------------------------------------------------------------------------

async function aiExtractCV(rawText) {
	const provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : null;
	if (!provider) return null;

	const prompt = `You are an expert CV/resume parser. Extract ALL structured data from this CV text with maximum accuracy and completeness.

IMPORTANT RULES:
- Extract EVERY work experience entry, education entry, and certification mentioned
- For dates, use the format as written (e.g. "Jan 2020", "2020", "March 2018")
- If currently employed, set end_date to "Present"
- For skills, extract ALL technical and professional skills mentioned anywhere in the CV
- For certifications, extract as structured objects (not just strings)
- Extract the professional summary/objective if present
- Extract location/city information if mentioned

CV TEXT:
${rawText.slice(0, 12000)}

Return ONLY valid JSON (no markdown, no code fences, no explanation):
{
  "name": "Full Name",
  "title": "Professional Title / Headline",
  "email": "email@example.com",
  "phone": "+971XXXXXXXXX",
  "location": "City, Country",
  "summary": "Professional summary paragraph from the CV",
  "skills": ["Skill1", "Skill2", "Skill3"],
  "experience": [
    {
      "role": "Job Title",
      "company": "Company Name",
      "location": "City, Country",
      "start_date": "Jan 2020",
      "end_date": "Present",
      "description": "Key responsibilities and achievements in this role"
    }
  ],
  "education": [
    {
      "degree": "BSc Computer Science",
      "institution": "University Name",
      "location": "City",
      "start_date": "2015",
      "end_date": "2019",
      "grade": "First Class",
      "description": ""
    }
  ],
  "certifications": [
    {
      "name": "Certification Name",
      "organization": "Issuing Organization",
      "issue_date": "2023"
    }
  ],
  "languages": ["English", "Arabic"],
  "awards": ["Award or achievement description"],
  "interests": ["Interest1", "Interest2"],
  "totalYearsExperience": 5
}`;

	// Try each available provider; fall through on failure
	const providers = [];
	if (process.env.ANTHROPIC_API_KEY) providers.push("anthropic");
	if (process.env.OPENAI_API_KEY) providers.push("openai");

	for (const p of providers) {
		try {
			let response;

			if (p === "anthropic") {
				const Anthropic = require("@anthropic-ai/sdk");
				const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
				const result = await client.messages.create({
					model: "claude-sonnet-4-20250514",
					max_tokens: 4000,
					messages: [{ role: "user", content: prompt }],
				});
				response = result.content[0].text;
			} else {
				const OpenAI = require("openai");
				const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
				const result = await client.chat.completions.create({
					model: "gpt-4o",
					messages: [{ role: "user", content: prompt }],
					max_tokens: 4000,
				});
				response = result.choices[0].message.content;
			}

			// Parse JSON response
			let clean = response.trim();
			if (clean.startsWith("```json")) clean = clean.slice(7);
			else if (clean.startsWith("```")) clean = clean.slice(3);
			if (clean.endsWith("```")) clean = clean.slice(0, -3);
			clean = clean.trim();

			const parsed = JSON.parse(clean);
			parsed._aiProvider = p;
			return parsed;
		} catch (err) {
			console.error(`[cvExtractor] ${p} extraction failed:`, err.message);
			// Continue to next provider
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract structured data from CV text.
 *
 * @param {string} rawText - The raw text extracted from the CV PDF
 * @param {object} options
 * @param {boolean} options.useAI - Whether to attempt AI extraction (default: true)
 * @param {Buffer} options.pdfBuffer - Original PDF buffer (for Affinda extraction)
 * @returns {Promise<object>} Structured CV data
 */
async function extractStructuredData(rawText, { useAI = true, pdfBuffer = null } = {}) {
	// Fix JSON-encoded text (legacy data stored via JSON.stringify)
	if (rawText && rawText.startsWith('"') && rawText.endsWith('"')) {
		try { rawText = JSON.parse(rawText); } catch { /* keep as-is */ }
	}

	if (!rawText || rawText.trim().length === 0) {
		return {
			success: false,
			error: "No text content to extract from",
			data: null,
		};
	}

	// Try AI extraction first (more accurate)
	if (useAI && (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
		try {
			const aiResult = await aiExtractCV(rawText);
			if (aiResult) {
				return {
					success: true,
					method: "ai",
					aiProvider: aiResult._aiProvider || "unknown",
					data: {
						name: aiResult.name || null,
						title: aiResult.title || null,
						email: aiResult.email || null,
						phone: aiResult.phone || null,
						location: aiResult.location || null,
						summary: aiResult.summary || null,
						skills: aiResult.skills || [],
						experience: (aiResult.experience || []).map((e) => ({
							role: e.role || e.title || "",
							company: e.company || "",
							location: e.location || "",
							start_date: e.start_date || (e.startYear ? String(e.startYear) : ""),
							end_date: e.end_date || (e.isCurrent ? "Present" : (e.endYear ? String(e.endYear) : "")),
							description: e.description || "",
						})),
						education: (aiResult.education || []).map((e) => ({
							degree: e.degree || "",
							institution: e.institution || "",
							location: e.location || "",
							start_date: e.start_date || "",
							end_date: e.end_date || (e.year ? String(e.year) : ""),
							grade: e.grade || "",
							description: e.description || "",
						})),
						certifications: (aiResult.certifications || []).map((c) =>
							typeof c === "string" ? { name: c, organization: "", issue_date: "" }
								: { name: c.name || "", organization: c.organization || "", issue_date: c.issue_date || "" }
						),
						languages: aiResult.languages || [],
						awards: aiResult.awards || [],
						interests: aiResult.interests || [],
						totalYearsExperience: aiResult.totalYearsExperience || 0,
					},
				};
			}
		} catch (err) {
			console.error("[cvExtractor] AI extraction error, falling back:", err.message);
		}
	}

	// Try Affinda extraction as second fallback (requires PDF buffer)
	if (useAI && pdfBuffer && process.env.AFFINDA_API_KEY) {
		try {
			const affindaResult = await extractWithAffinda(pdfBuffer);
			if (affindaResult) {
				return {
					success: true,
					method: "ai",
					aiProvider: "affinda",
					data: {
						name: affindaResult.name || null,
						title: affindaResult.title || null,
						email: affindaResult.email || null,
						phone: affindaResult.phone || null,
						location: affindaResult.location || null,
						summary: affindaResult.summary || null,
						skills: affindaResult.skills || [],
						experience: affindaResult.experience || [],
						education: affindaResult.education || [],
						certifications: affindaResult.certifications || [],
						languages: affindaResult.languages || [],
						awards: affindaResult.awards || [],
						interests: affindaResult.interests || [],
						totalYearsExperience: affindaResult.totalYearsExperience || 0,
					},
				};
			}
		} catch (err) {
			console.error("[cvExtractor] Affinda fallback error:", err.message);
		}
	}

	// Regex/heuristic extraction fallback
	const sections = detectSections(rawText);

	const emails = extractEmails(rawText);
	const phones = extractPhones(rawText);
	const name = extractName(rawText);

	// Skills - only extract from identified skills section (full-text is too noisy)
	const skillsText = sections.skills || "";
	let skills = extractSkillsFromText(skillsText);

	// Experience
	const experienceText = sections.experience || "";
	const experience = extractExperience(experienceText);

	// Education
	const educationText = sections.education || "";
	const education = extractEducation(educationText);

	// Certifications
	const certsText = sections.certifications || rawText;
	const certifications = extractCertifications(certsText);

	// Total years calculation
	let totalYears = 0;
	for (const exp of experience) {
		if (exp.years && exp.years > 0) totalYears += exp.years;
	}
	// Fallback: look for "X years of experience" pattern
	if (totalYears === 0) {
		const yearsMatch = rawText.match(/(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:experience|exp)/i);
		if (yearsMatch) totalYears = parseInt(yearsMatch[1], 10);
	}

	// Summary
	const summary = sections.summary || null;

	// Title - extract from header area (line after name, often contains job title)
	let title = null;
	const headerLines = (sections.header || "").split("\n").map(l => l.trim()).filter(Boolean);
	for (let i = 0; i < Math.min(5, headerLines.length); i++) {
		const line = headerLines[i];
		if (line.includes("@") || line.match(/^\+?\d/) || line.match(/^(http|www)/i)) continue;
		if (name && line.toLowerCase().includes(name.toLowerCase().split(" ")[0])) continue;
		// Title-like line: contains keywords like engineer, manager, developer, etc. or has | separator
		if (line.length > 5 && line.length < 100 && (line.includes("|") || /(?:engineer|developer|manager|designer|analyst|architect|specialist|consultant|director|lead|senior|junior)/i.test(line))) {
			title = line;
			break;
		}
	}

	// Awards
	const awardsText = sections.awards || "";
	const awards = awardsText ? awardsText.split("\n").map(l => l.replace(/^[\-*\u2022\u2023\u25E6\d.)\]]+\s*/, "").trim()).filter(l => l.length > 5) : [];

	// Interests
	const interestsText = sections.interests || "";
	const interests = interestsText ? extractSkillsFromText(interestsText) : [];

	// Languages
	const languagesText = sections.languages || "";
	const languages = languagesText ? extractSkillsFromText(languagesText) : [];

	return {
		success: true,
		method: "regex",
		data: {
			name: name || null,
			title: title || null,
			email: emails[0] || null,
			phone: phones[0] || null,
			location: null,
			summary,
			skills,
			experience: experience.map((e) => ({
				role: e.title || "",
				company: e.company || "",
				location: "",
				start_date: e.startDate || (e.startYear ? String(e.startYear) : ""),
				end_date: e.isCurrent ? "Present" : (e.endDate || (e.endYear ? String(e.endYear) : "")),
				description: e.description || "",
			})),
			education: education.map((e) => ({
				degree: e.degree || "",
				institution: e.institution || "",
				location: "",
				start_date: "",
				end_date: e.year ? String(e.year) : "",
				grade: "",
				description: "",
			})),
			certifications: certifications.map((c) =>
				typeof c === "string" ? { name: c, organization: "", issue_date: "" }
					: { name: c.name || c, organization: "", issue_date: "" }
			),
			languages,
			awards,
			interests,
			totalYearsExperience: totalYears,
		},
	};
}

/**
 * Extract data from a PDF file path.
 *
 * @param {string} filePath - Absolute path to the PDF file
 * @param {object} options
 * @param {boolean} options.useAI - Whether to attempt AI extraction
 * @returns {Promise<object>} Structured CV data
 */
async function extractFromFile(filePath, { useAI = true } = {}) {
	const buffer = await fs.readFile(filePath);
	const rawText = await extractTextFromPDF(buffer);
	const result = await extractStructuredData(rawText, { useAI, pdfBuffer: buffer });

	return {
		...result,
		source: {
			filePath,
			fileName: path.basename(filePath),
			textLength: rawText.length,
		},
	};
}

/**
 * Extract data from a PDF buffer.
 *
 * @param {Buffer} buffer - PDF file buffer
 * @param {object} options
 * @param {boolean} options.useAI - Whether to attempt AI extraction
 * @returns {Promise<object>} Structured CV data
 */
async function extractFromBuffer(buffer, { useAI = true } = {}) {
	const rawText = await extractTextFromPDF(buffer);
	const result = await extractStructuredData(rawText, { useAI, pdfBuffer: buffer });

	return {
		...result,
		source: {
			textLength: rawText.length,
		},
	};
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
	extractTextFromPDF,
	extractStructuredData,
	extractFromFile,
	extractFromBuffer,
	extractWithAffinda,

	// Individual extractors (exported for testing/reuse)
	extractEmails,
	extractPhones,
	extractName,
	detectSections,
	extractSkillsFromText,
	extractExperience,
	extractEducation,
	extractCertifications,
};
