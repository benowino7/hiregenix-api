/**
 * industryTaxonomy.js
 * ===================
 * SIC-like canonical industry taxonomy for job board.
 *
 * 109 industries across 17 verticals with keyword-based normalisation.
 * Maps free-text industry names (from AI extraction) to canonical labels,
 * then resolves those labels to existing Industry records in the database.
 *
 * Core functions:
 *   normaliseToCanonical(raw)         → { code, label, vertical } or null
 *   matchIndustriesToDb(names, prisma) → [{ id, name }] from DB
 *   getGroupedTaxonomy()              → verticals with their industries
 *   getActiveGroupedTaxonomy(prisma)  → verticals with job counts from DB
 */

const { prisma } = require("../../prisma");

// ── Master taxonomy ─────────────────────────────────────────────────────────
// Format: [code, label, vertical, [keywords]]

const _RAW = [
	// ── Banking & Financial Services ──────────────────────────────────────────
	["BFS-001", "Retail Banking", "Banking & Financial Services", ["retail banking", "branch banking", "personal banking", "finance", "financial services", "banking"]],
	["BFS-002", "Corporate & Investment Banking", "Banking & Financial Services", ["investment banking", "corporate finance", "IB", "capital markets"]],
	["BFS-003", "Derivatives & Treasury", "Banking & Financial Services", ["derivatives", "ISDA", "treasury", "swaps", "hedging", "structured finance"]],
	["BFS-004", "Asset & Wealth Management", "Banking & Financial Services", ["asset management", "wealth management", "fund management", "portfolio management"]],
	["BFS-005", "Islamic Finance", "Banking & Financial Services", ["Islamic finance", "Shariah", "sukuk", "murabaha", "takaful"]],
	["BFS-006", "Private Equity & Venture Capital", "Banking & Financial Services", ["private equity", "PE", "venture capital", "VC", "growth equity"]],
	["BFS-007", "Risk & Compliance", "Banking & Financial Services", ["risk management", "compliance", "AML", "KYC", "regulatory compliance", "financial risk"]],
	["BFS-008", "FinTech", "Banking & Financial Services", ["fintech", "payments", "digital banking", "blockchain", "cryptocurrency", "DeFi"]],
	["BFS-009", "Insurance", "Banking & Financial Services", ["insurance", "underwriting", "actuarial", "reinsurance", "InsurTech"]],
	["BFS-010", "Accounting & Audit", "Banking & Financial Services", ["accounting", "audit", "CPA", "ACCA", "CFA", "financial reporting", "tax"]],

	// ── Legal & Compliance ────────────────────────────────────────────────────
	["LEG-001", "Banking & Finance Law", "Legal & Compliance", ["banking law", "finance law", "financial regulation", "derivatives law"]],
	["LEG-002", "Corporate & Commercial Law", "Legal & Compliance", ["corporate law", "M&A", "commercial law", "mergers and acquisitions", "contracts"]],
	["LEG-003", "Litigation & Dispute Resolution", "Legal & Compliance", ["litigation", "arbitration", "dispute resolution", "court"]],
	["LEG-004", "Real Estate Law", "Legal & Compliance", ["real estate law", "property law", "conveyancing", "zoning law"]],
	["LEG-005", "Employment & Labour Law", "Legal & Compliance", ["employment law", "labour law", "HR legal", "wrongful termination"]],
	["LEG-006", "Intellectual Property", "Legal & Compliance", ["IP", "patents", "trademarks", "copyright", "intellectual property"]],
	["LEG-007", "Regulatory & Government Affairs", "Legal & Compliance", ["regulatory", "government affairs", "public law", "DFSA", "ADGM"]],
	["LEG-008", "In-House Counsel", "Legal & Compliance", ["in-house", "general counsel", "GC", "legal counsel"]],
	["LEG-009", "LegalTech", "Legal & Compliance", ["legaltech", "legal operations", "e-discovery", "contract management", "legal AI"]],

	// ── Technology & Engineering ──────────────────────────────────────────────
	["TEC-001", "Software Development", "Technology & Engineering", ["software development", "software engineer", "software", "backend", "frontend", "full stack", "full-stack", "programming", "information technology", "IT"]],
	["TEC-002", "Data Science & AI", "Technology & Engineering", ["data science", "machine learning", "artificial intelligence", "AI", "ML", "NLP", "LLM", "data analyst", "data analytics", "data engineer"]],
	["TEC-003", "Cloud & DevOps", "Technology & Engineering", ["cloud", "DevOps", "AWS", "Azure", "GCP", "Kubernetes", "infrastructure", "SRE"]],
	["TEC-004", "Cybersecurity", "Technology & Engineering", ["cybersecurity", "infosec", "information security", "penetration testing", "zero trust"]],
	["TEC-005", "Product Management", "Technology & Engineering", ["product manager", "product management", "PM", "roadmap", "agile", "scrum"]],
	["TEC-006", "UI/UX Design", "Technology & Engineering", ["UI", "UX", "user experience", "user interface", "Figma", "product design"]],
	["TEC-007", "IT Support & Infrastructure", "Technology & Engineering", ["IT support", "sysadmin", "helpdesk", "IT infrastructure", "network engineering", "engineering", "technology", "systems engineer", "MEP", "technician"]],
	["TEC-008", "Telecommunications", "Technology & Engineering", ["telecom", "telecommunications", "network", "5G", "fibre", "wireless"]],
	["TEC-009", "Embedded & Hardware Engineering", "Technology & Engineering", ["embedded systems", "hardware", "ASIC", "FPGA", "firmware", "IoT", "electronics"]],
	["TEC-010", "Gaming & Esports", "Technology & Engineering", ["gaming", "esports", "game development", "game design", "Unity", "Unreal"]],
	["TEC-011", "Blockchain & Web3", "Technology & Engineering", ["blockchain", "Web3", "smart contracts", "NFT", "DeFi", "crypto", "decentralised"]],
	["TEC-012", "AR/VR & Immersive Tech", "Technology & Engineering", ["AR", "VR", "augmented reality", "virtual reality", "mixed reality", "XR", "metaverse"]],

	// ── Healthcare & Life Sciences ────────────────────────────────────────────
	["HLS-001", "Medical & Clinical", "Healthcare & Life Sciences", ["doctor", "physician", "clinical", "GP", "hospital", "medicine", "surgery", "medical", "healthcare"]],
	["HLS-002", "Nursing & Allied Health", "Healthcare & Life Sciences", ["nurse", "nursing", "allied health", "physiotherapy", "occupational therapy", "paramedic"]],
	["HLS-003", "Pharmacy & Pharmaceuticals", "Healthcare & Life Sciences", ["pharmacist", "pharmacy", "pharmaceutical", "drug", "medication", "clinical trials"]],
	["HLS-004", "Biotech & Life Sciences", "Healthcare & Life Sciences", ["biotech", "biotechnology", "life sciences", "R&D", "laboratory", "genomics"]],
	["HLS-005", "Mental Health & Counselling", "Healthcare & Life Sciences", ["mental health", "psychologist", "counsellor", "therapist", "psychiatry"]],
	["HLS-006", "Healthcare Management", "Healthcare & Life Sciences", ["healthcare management", "hospital administration", "health operations"]],
	["HLS-007", "Medical Devices & HealthTech", "Healthcare & Life Sciences", ["medical devices", "healthtech", "digital health", "health technology", "wearables"]],
	["HLS-008", "Veterinary & Animal Health", "Healthcare & Life Sciences", ["veterinary", "vet", "animal health", "pet care"]],

	// ── Real Estate & Construction ────────────────────────────────────────────
	["REC-001", "Residential Real Estate", "Real Estate & Construction", ["residential", "property sales", "estate agent", "lettings", "mortgage", "real estate", "property"]],
	["REC-002", "Commercial Real Estate", "Real Estate & Construction", ["commercial property", "commercial real estate", "office space", "retail space"]],
	["REC-003", "Property Development", "Real Estate & Construction", ["property development", "real estate development", "masterplan", "developer"]],
	["REC-004", "Construction & Civil Engineering", "Real Estate & Construction", ["construction", "civil engineering", "site management", "quantity surveying"]],
	["REC-005", "Architecture & Interior Design", "Real Estate & Construction", ["architect", "architecture", "interior design", "AutoCAD", "BIM", "urban planning", "fit-out", "carpentry"]],
	["REC-006", "Facilities & Asset Management", "Real Estate & Construction", ["facilities management", "FM", "asset management", "property management", "maintenance", "facilities supervisor", "facilities manager"]],

	// ── Sales, Marketing & Communications ────────────────────────────────────
	["SMC-001", "Sales & Business Development", "Sales, Marketing & Communications", ["sales", "business development", "BD", "account manager", "revenue", "B2B sales", "sales consultant", "upsell", "customer service", "call center"]],
	["SMC-002", "Digital Marketing", "Sales, Marketing & Communications", ["digital marketing", "marketing", "SEO", "SEM", "social media", "PPC", "performance marketing"]],
	["SMC-003", "Brand & Communications", "Sales, Marketing & Communications", ["brand", "PR", "public relations", "communications", "brand strategy"]],
	["SMC-004", "Content & Creative", "Sales, Marketing & Communications", ["content", "copywriting", "creative", "video production", "content marketing", "journalism"]],
	["SMC-005", "E-commerce & Retail", "Sales, Marketing & Communications", ["e-commerce", "ecommerce", "retail", "merchandising", "Amazon", "DTC"]],
	["SMC-006", "Market Research & Analytics", "Sales, Marketing & Communications", ["market research", "insights", "analytics", "CRM", "data analytics", "business intelligence"]],
	["SMC-007", "Advertising & AdTech", "Sales, Marketing & Communications", ["advertising", "adtech", "programmatic", "media buying", "display advertising"]],

	// ── Human Resources & Education ───────────────────────────────────────────
	["HRE-001", "HR & People Operations", "Human Resources & Education", ["HR", "human resources", "people operations", "HRBP", "talent management", "HR executive", "HR officer", "HR coordinator"]],
	["HRE-002", "Talent Acquisition & Recruitment", "Human Resources & Education", ["recruitment", "talent acquisition", "sourcing", "headhunting", "staffing", "recruiter"]],
	["HRE-003", "Learning & Development", "Human Resources & Education", ["learning and development", "L&D", "training", "e-learning", "instructional design"]],
	["HRE-004", "Education & Teaching", "Human Resources & Education", ["teacher", "education", "school", "university", "lecturer", "academic", "curriculum", "librarian", "admissions"]],
	["HRE-005", "EdTech", "Human Resources & Education", ["edtech", "educational technology", "online learning", "LMS", "adaptive learning"]],

	// ── Operations, Logistics & Supply Chain ─────────────────────────────────
	["OLS-001", "Supply Chain & Procurement", "Operations, Logistics & Supply Chain", ["supply chain", "procurement", "sourcing", "purchasing", "vendor management"]],
	["OLS-002", "Logistics & Transport", "Operations, Logistics & Supply Chain", ["logistics", "transport", "freight", "shipping", "last mile", "courier", "3PL"]],
	["OLS-003", "Warehousing & Distribution", "Operations, Logistics & Supply Chain", ["warehouse", "warehousing", "distribution", "fulfilment", "inventory management"]],
	["OLS-004", "Operations Management", "Operations, Logistics & Supply Chain", ["operations", "COO", "process improvement", "lean", "six sigma", "project manager", "project architect"]],
	["OLS-005", "Aviation & Aerospace", "Operations, Logistics & Supply Chain", ["aviation", "airline", "pilot", "aerospace", "MRO", "aircraft", "airport"]],
	["OLS-006", "Maritime & Shipping", "Operations, Logistics & Supply Chain", ["maritime", "shipping", "port", "vessel", "seafarer", "marine", "naval"]],

	// ── Manufacturing & Industrial ────────────────────────────────────────────
	["MFG-001", "Advanced Manufacturing", "Manufacturing & Industrial", ["manufacturing", "advanced manufacturing", "additive manufacturing", "3D printing"]],
	["MFG-002", "Automotive & Transportation", "Manufacturing & Industrial", ["automotive", "auto", "vehicle", "car manufacturing", "EV", "electric vehicle"]],
	["MFG-003", "Aerospace & Defence Manufacturing", "Manufacturing & Industrial", ["aerospace manufacturing", "defence manufacturing", "military", "defence"]],
	["MFG-004", "Chemical & Materials", "Manufacturing & Industrial", ["chemical", "materials science", "polymers", "composites", "specialty chemicals"]],
	["MFG-005", "Electronics & Semiconductor", "Manufacturing & Industrial", ["electronics", "semiconductor", "chip design", "PCB", "hardware manufacturing"]],
	["MFG-006", "Food & Beverage Manufacturing", "Manufacturing & Industrial", ["food manufacturing", "beverage manufacturing", "FMCG", "food processing"]],
	["MFG-007", "Textile & Apparel Manufacturing", "Manufacturing & Industrial", ["textile", "apparel manufacturing", "garment", "fashion manufacturing"]],

	// ── Agriculture & Food ────────────────────────────────────────────────────
	["AGR-001", "Agriculture & Farming", "Agriculture & Food", ["agriculture", "farming", "crop", "arable", "agribusiness"]],
	["AGR-002", "AgriTech", "Agriculture & Food", ["agritech", "precision agriculture", "vertical farming", "smart farming"]],
	["AGR-003", "Food & Beverage", "Agriculture & Food", ["food and beverage", "restaurant", "food service", "catering", "culinary", "chef"]],
	["AGR-004", "Food Retail & Grocery", "Agriculture & Food", ["grocery", "supermarket", "food retail", "convenience store", "food delivery"]],
	["AGR-005", "Aquaculture & Fisheries", "Agriculture & Food", ["aquaculture", "fisheries", "fish farming", "seafood"]],

	// ── Energy & Environment ──────────────────────────────────────────────────
	["ENE-001", "Oil & Gas", "Energy & Environment", ["oil", "gas", "upstream", "downstream", "petroleum", "ADNOC", "LNG", "refinery"]],
	["ENE-002", "Renewable Energy", "Energy & Environment", ["solar", "wind", "renewable energy", "clean energy", "photovoltaic"]],
	["ENE-003", "Utilities & Infrastructure", "Energy & Environment", ["utilities", "power", "water utility", "electricity", "grid", "smart grid"]],
	["ENE-004", "Environmental & Sustainability", "Energy & Environment", ["environment", "ESG", "sustainability", "carbon", "climate change", "net zero"]],
	["ENE-005", "Space & Satellite", "Energy & Environment", ["space", "satellite", "space technology", "rocket", "space exploration"]],

	// ── Hospitality, Tourism & Events ─────────────────────────────────────────
	["HTE-001", "Hotels & Accommodation", "Hospitality, Tourism & Events", ["hotel", "hospitality", "accommodation", "resort", "front desk", "concierge", "housekeeping", "guest experience", "InterContinental", "Hilton", "Marriott"]],
	["HTE-002", "Food & Beverage Service", "Hospitality, Tourism & Events", ["restaurant", "bar", "F&B", "food service", "beverage", "sommelier", "waiter", "bakery", "storekeeper", "chef", "kitchen"]],
	["HTE-003", "Travel & Tour Operations", "Hospitality, Tourism & Events", ["travel", "tour operator", "tourism", "travel agent", "DMC"]],
	["HTE-004", "Events & Conference Management", "Hospitality, Tourism & Events", ["events", "conference", "MICE", "event management", "wedding planning"]],
	["HTE-005", "Cruise & Luxury Travel", "Hospitality, Tourism & Events", ["cruise", "luxury travel", "yacht", "superyacht"]],

	// ── Adventure & Outdoor Tourism ───────────────────────────────────────────
	["OAS-001", "Outdoor & Adventure Sports", "Adventure & Outdoor Tourism", ["adventure", "outdoor", "extreme sports", "rafting", "zip line", "skydiving"]],
	["AAA-001", "Air & Aerial Activities", "Adventure & Outdoor Tourism", ["helicopter tour", "hot air balloon", "paragliding", "hang gliding"]],
	["LTT-001", "Land & Terrain Tours", "Adventure & Outdoor Tourism", ["desert safari", "hiking guide", "nature walk", "cycling tour", "mountain biking"]],
	["WMA-001", "Water & Marine Activities", "Adventure & Outdoor Tourism", ["snorkeling", "fishing guide", "jet boat", "white water rafting", "water sports"]],
	["EAA-001", "Equestrian & Animal Activities", "Adventure & Outdoor Tourism", ["horse riding", "polo club", "rodeo", "dog sled", "bird watching"]],
	["SUT-001", "Sightseeing & Urban Tours", "Adventure & Outdoor Tourism", ["sightseeing", "segway tour", "city tour", "cultural tour", "walking tour"]],

	// ── Health, Wellness & Fitness ────────────────────────────────────────────
	["HWL-001", "Yoga & Wellness Retreats", "Health, Wellness & Fitness", ["yoga", "wellness retreat", "mindfulness", "meditation", "retreat", "wellness", "spa wellness"]],
	["HWL-002", "Personal Training & Fitness", "Health, Wellness & Fitness", ["personal trainer", "gym", "fitness", "CrossFit", "strength coach", "fitness equipment"]],
	["HWL-003", "Nutrition & Dietetics", "Health, Wellness & Fitness", ["nutritionist", "dietitian", "sports nutrition", "meal planning"]],
	["HWL-004", "Spa & Beauty", "Health, Wellness & Fitness", ["spa", "beauty", "massage", "aesthetician", "skincare"]],
	["HWL-005", "Sports & Recreation", "Health, Wellness & Fitness", ["sports", "recreation", "athletics", "MMA", "martial arts", "swimming"]],

	// ── Fashion, Luxury & Consumer Goods ─────────────────────────────────────
	["FLC-001", "Fashion & Apparel", "Fashion, Luxury & Consumer Goods", ["fashion", "apparel", "clothing", "garment", "fashion design", "fashion consultant", "luxury fashion"]],
	["FLC-002", "Luxury Goods & Jewellery", "Fashion, Luxury & Consumer Goods", ["luxury", "jewellery", "jewelry", "watches", "accessories"]],
	["FLC-003", "Beauty & Cosmetics", "Fashion, Luxury & Consumer Goods", ["beauty", "cosmetics", "makeup", "skincare", "personal care"]],
	["FLC-004", "Consumer Electronics", "Fashion, Luxury & Consumer Goods", ["consumer electronics", "wearables", "smart devices"]],
	["FLC-005", "Furniture & Home Decor", "Fashion, Luxury & Consumer Goods", ["furniture", "home decor", "interior", "home goods", "lighting"]],

	// ── Media, Entertainment & Arts ───────────────────────────────────────────
	["MEA-001", "Film, TV & Broadcasting", "Media, Entertainment & Arts", ["film", "TV", "television", "broadcasting", "video production", "streaming"]],
	["MEA-002", "Music & Performing Arts", "Media, Entertainment & Arts", ["music", "performing arts", "artist", "theatre", "dance", "opera"]],
	["MEA-003", "Publishing & Journalism", "Media, Entertainment & Arts", ["journalism", "publishing", "editor", "media", "news", "writing"]],
	["MEA-004", "Animation & Visual Effects", "Media, Entertainment & Arts", ["animation", "VFX", "2D animation", "3D animation", "visual effects", "motion graphics"]],

	// ── Government, Non-Profit & Social ────────────────────────────────────────
	["GPS-001", "Government & Public Sector", "Government, Non-Profit & Social", ["government", "public sector", "civil service", "municipality", "security guard"]],
	["GPS-002", "Non-Profit & NGO", "Government, Non-Profit & Social", ["NGO", "non-profit", "charity", "humanitarian", "social impact", "UAE charity"]],
	["GPS-003", "International Development", "Government, Non-Profit & Social", ["international development", "UN", "World Bank", "UNDP", "aid"]],
	["GPS-004", "Social Services", "Government, Non-Profit & Social", ["social services", "community services", "welfare", "youth development"]],
];

// ── Build lookup structures ─────────────────────────────────────────────────

const INDUSTRIES = _RAW.map(([code, label, vertical, keywords]) => ({
	code,
	label,
	vertical,
	keywords,
}));

const _LABEL_INDEX = {};
for (const ind of INDUSTRIES) {
	_LABEL_INDEX[ind.label.toLowerCase()] = ind;
}

const _CODE_INDEX = {};
for (const ind of INDUSTRIES) {
	_CODE_INDEX[ind.code] = ind;
}

// ── Normalisation ─────────────────────────────────────────────────────────

/**
 * Map a free-text industry string to the nearest canonical taxonomy entry.
 *
 * Matching priority:
 *   1. Exact label match
 *   2. Whole-phrase keyword match
 *   3. Vertical name match (returns first industry in that vertical)
 *
 * @param {string} rawIndustry - Free-text industry name from AI extraction
 * @returns {{ code: string, label: string, vertical: string } | null}
 */
function normaliseToCanonical(rawIndustry) {
	if (!rawIndustry) return null;
	const rawLower = rawIndustry.toLowerCase().trim();

	// 1. Exact label match
	if (_LABEL_INDEX[rawLower]) {
		return _LABEL_INDEX[rawLower];
	}

	// 2. Whole-phrase keyword match (word-boundary safe)
	for (const ind of INDUSTRIES) {
		for (const kw of ind.keywords) {
			const kwL = kw.toLowerCase();
			if (
				kwL === rawLower ||
				(` ${rawLower} `).includes(` ${kwL} `) ||
				rawLower.startsWith(kwL + " ") ||
				rawLower.endsWith(" " + kwL)
			) {
				return ind;
			}
		}
	}

	// 3. Vertical name match — require word-boundary match to avoid "hospital" → "hospitality"
	for (const ind of INDUSTRIES) {
		const vLower = ind.vertical.toLowerCase();
		if (rawLower.includes(vLower) || vLower === rawLower) {
			return ind;
		}
		// Check if rawLower matches a complete word within the vertical name
		const vWords = vLower.split(/[\s,&]+/).filter(Boolean);
		if (vWords.some((w) => w === rawLower || (rawLower.length > 5 && w.startsWith(rawLower)))) {
			return ind;
		}
	}

	return null;
}

/**
 * Normalise a list of free-text industry names to canonical entries.
 * Returns deduplicated list.
 */
function normaliseIndustriesList(rawList) {
	const results = [];
	const seen = new Set();
	for (const raw of rawList) {
		const match = normaliseToCanonical(raw);
		if (match && !seen.has(match.code)) {
			seen.add(match.code);
			results.push(match);
		}
	}
	return results;
}

// ── DB matching ─────────────────────────────────────────────────────────────

/**
 * Match free-text industry names to existing Industry records in the DB.
 *
 * Strategy:
 *   1. Normalise via taxonomy to get canonical labels
 *   2. Search DB for those canonical labels (exact + contains)
 *   3. For unmatched raw names, fall back to direct DB search
 *
 * @param {string[]} industryNames - Free-text industry names from AI
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function matchIndustriesToDb(industryNames) {
	if (!industryNames || industryNames.length === 0) return [];

	const matched = [];
	const seenIds = new Set();

	// Strategy 1: Use taxonomy normalisation first
	for (const name of industryNames) {
		const canonical = normaliseToCanonical(name);

		if (canonical) {
			// Try exact match on canonical label
			let industry = await prisma.industry.findFirst({
				where: { name: { equals: canonical.label, mode: "insensitive" } },
				select: { id: true, name: true },
			});

			// Try contains match on canonical label
			if (!industry) {
				industry = await prisma.industry.findFirst({
					where: { name: { contains: canonical.label, mode: "insensitive" } },
					select: { id: true, name: true },
				});
			}

			// Try vertical name
			if (!industry) {
				industry = await prisma.industry.findFirst({
					where: { name: { contains: canonical.vertical, mode: "insensitive" } },
					select: { id: true, name: true },
				});
			}

			if (industry && !seenIds.has(industry.id)) {
				seenIds.add(industry.id);
				matched.push(industry);
				continue;
			}
		}

		// Strategy 2: Direct DB search as fallback
		let industry = await prisma.industry.findFirst({
			where: { name: { equals: name, mode: "insensitive" } },
			select: { id: true, name: true },
		});

		if (!industry) {
			industry = await prisma.industry.findFirst({
				where: { name: { contains: name, mode: "insensitive" } },
				select: { id: true, name: true },
			});
		}

		if (industry && !seenIds.has(industry.id)) {
			seenIds.add(industry.id);
			matched.push(industry);
		}
	}

	// If nothing matched, try "General" fallback
	if (matched.length === 0) {
		const fallback = await prisma.industry.findFirst({
			where: { name: { contains: "General", mode: "insensitive" } },
			select: { id: true, name: true },
		});
		if (fallback) matched.push(fallback);
	}

	return matched;
}

// ── Grouped taxonomy for API/frontend ───────────────────────────────────────

/**
 * Get all industries grouped by vertical (static, no DB).
 */
function getGroupedTaxonomy() {
	const groups = {};
	for (const ind of INDUSTRIES) {
		if (!groups[ind.vertical]) {
			groups[ind.vertical] = [];
		}
		groups[ind.vertical].push({
			code: ind.code,
			label: ind.label,
		});
	}

	return Object.entries(groups).map(([vertical, options]) => ({
		vertical,
		options,
	}));
}

/**
 * Get active industries grouped by vertical with job counts from DB.
 * Only returns verticals/industries that have at least 1 published job.
 */
async function getActiveGroupedTaxonomy() {
	// Get all industries with published job counts
	const industries = await prisma.industry.findMany({
		where: {
			isActive: true,
			jobIndustries: {
				some: {
					job: { status: "PUBLISHED" },
				},
			},
		},
		select: {
			id: true,
			name: true,
			_count: {
				select: {
					jobIndustries: {
						where: { job: { status: "PUBLISHED" } },
					},
				},
			},
		},
		orderBy: { name: "asc" },
	});

	// Map DB industries to taxonomy verticals
	const verticalMap = {};

	for (const dbInd of industries) {
		const canonical = normaliseToCanonical(dbInd.name);
		const vertical = canonical ? canonical.vertical : "Other";

		if (!verticalMap[vertical]) {
			verticalMap[vertical] = { industries: [], totalJobs: 0 };
		}

		const jobCount = dbInd._count?.jobIndustries || 0;
		verticalMap[vertical].industries.push({
			id: dbInd.id,
			name: dbInd.name,
			code: canonical?.code || null,
			jobCount,
		});
		verticalMap[vertical].totalJobs += jobCount;
	}

	// Sort by total jobs descending
	return Object.entries(verticalMap)
		.map(([vertical, data]) => ({
			vertical,
			jobCount: data.totalJobs,
			industries: data.industries.sort((a, b) => b.jobCount - a.jobCount),
		}))
		.sort((a, b) => b.jobCount - a.jobCount);
}

// ── Flat list for simple dropdowns ──────────────────────────────────────────

function getFlatTaxonomy() {
	return INDUSTRIES.map((ind) => ({
		code: ind.code,
		label: ind.label,
		vertical: ind.vertical,
	})).sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = {
	INDUSTRIES,
	normaliseToCanonical,
	normaliseIndustriesList,
	matchIndustriesToDb,
	getGroupedTaxonomy,
	getActiveGroupedTaxonomy,
	getFlatTaxonomy,
};
