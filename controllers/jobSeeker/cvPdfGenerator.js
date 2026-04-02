/**
 * CV PDF Generator (Server-Side)
 * ===============================
 * Generates a professional PDF CV from the job seeker's profile data.
 * Uses Puppeteer to render HTML templates into PDF files.
 *
 * Endpoint: GET /job-seeker/profile/download-cv?templateId=0
 * Requires: Active paid subscription
 */

const { prisma } = require("../../prisma");

/**
 * Generate HTML for a CV template with profile data.
 */
function generateCvHtml(data, templateId = 0) {
	const {
		name = "Your Name",
		email = "",
		phone = "",
		location = "",
		title = "",
		summary = "",
		experience = [],
		education = [],
		skills = [],
		certifications = [],
		languages = [],
		awards = [],
		interests = [],
	} = data;

	const templateStyles = getTemplateStyles(templateId);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 11pt; line-height: 1.5; color: #333; }
  .cv-container { max-width: 800px; margin: 0 auto; padding: 40px; }
  ${templateStyles.css}
</style>
</head>
<body>
<div class="cv-container">
  ${templateStyles.renderHeader({ name, email, phone, location, title })}

  ${summary ? `
  <section class="cv-section">
    <h2 class="section-title">Professional Summary</h2>
    <p class="summary-text">${escapeHtml(summary)}</p>
  </section>` : ""}

  ${experience.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Work Experience</h2>
    ${experience.map((exp) => `
    <div class="entry">
      <div class="entry-header">
        <strong class="entry-title">${escapeHtml(exp.jobTitle || exp.role || "")}</strong>
        <span class="entry-date">${formatDateRange(exp.startDate, exp.endDate, exp.isCurrent)}</span>
      </div>
      <div class="entry-subtitle">${escapeHtml(exp.companyName || exp.company || "")}${exp.location ? ` | ${escapeHtml(exp.location)}` : ""}</div>
      ${exp.description ? `<p class="entry-description">${escapeHtml(exp.description)}</p>` : ""}
    </div>`).join("")}
  </section>` : ""}

  ${education.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Education</h2>
    ${education.map((edu) => `
    <div class="entry">
      <div class="entry-header">
        <strong class="entry-title">${escapeHtml(edu.degree || "")}</strong>
        <span class="entry-date">${formatDateRange(edu.startDate, edu.endDate)}</span>
      </div>
      <div class="entry-subtitle">${escapeHtml(edu.institution || "")}${edu.fieldOfStudy ? ` - ${escapeHtml(edu.fieldOfStudy)}` : ""}${edu.grade ? ` (${escapeHtml(edu.grade)})` : ""}</div>
      ${edu.description ? `<p class="entry-description">${escapeHtml(edu.description)}</p>` : ""}
    </div>`).join("")}
  </section>` : ""}

  ${skills.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Skills</h2>
    <div class="skills-grid">
      ${skills.map((s) => `<span class="skill-tag">${escapeHtml(typeof s === "string" ? s : s.name || "")}</span>`).join("")}
    </div>
  </section>` : ""}

  ${certifications.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Certifications</h2>
    ${certifications.map((cert) => `
    <div class="entry">
      <div class="entry-header">
        <strong class="entry-title">${escapeHtml(cert.name || "")}</strong>
        <span class="entry-date">${cert.issueDate ? formatDate(cert.issueDate) : ""}</span>
      </div>
      ${cert.issuingOrganization && cert.issuingOrganization !== "N/A" ? `<div class="entry-subtitle">${escapeHtml(cert.issuingOrganization)}</div>` : ""}
    </div>`).join("")}
  </section>` : ""}

  ${languages.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Languages</h2>
    <div class="skills-grid">
      ${languages.map((l) => `<span class="skill-tag">${escapeHtml(typeof l === "string" ? l : l.name || "")}${l.proficiency ? ` (${l.proficiency})` : ""}</span>`).join("")}
    </div>
  </section>` : ""}

  ${awards.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Awards & Achievements</h2>
    <ul class="awards-list">
      ${awards.map((a) => `<li>${escapeHtml(typeof a === "string" ? a : a.title || "")}</li>`).join("")}
    </ul>
  </section>` : ""}

  ${interests.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Interests</h2>
    <div class="skills-grid">
      ${interests.map((i) => `<span class="skill-tag">${escapeHtml(typeof i === "string" ? i : "")}</span>`).join("")}
    </div>
  </section>` : ""}
</div>
</body>
</html>`;
}

function getTemplateStyles(templateId) {
	const templates = {
		// Classic Professional
		0: {
			css: `
				.cv-header { text-align: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #2563eb; }
				.cv-name { font-size: 28pt; font-weight: 700; color: #1e3a5f; margin-bottom: 4px; }
				.cv-title { font-size: 14pt; color: #4b5563; margin-bottom: 8px; }
				.cv-contact { font-size: 10pt; color: #6b7280; }
				.cv-contact span { margin: 0 8px; }
				.section-title { font-size: 14pt; color: #1e3a5f; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; margin: 20px 0 12px; text-transform: uppercase; letter-spacing: 1px; }
				.entry { margin-bottom: 14px; }
				.entry-header { display: flex; justify-content: space-between; align-items: baseline; }
				.entry-title { color: #1f2937; font-size: 11pt; }
				.entry-date { color: #6b7280; font-size: 9pt; white-space: nowrap; }
				.entry-subtitle { color: #4b5563; font-size: 10pt; margin-top: 2px; }
				.entry-description { color: #374151; font-size: 10pt; margin-top: 4px; }
				.summary-text { color: #374151; font-size: 10.5pt; }
				.skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
				.skill-tag { background: #eff6ff; color: #1e40af; padding: 3px 10px; border-radius: 4px; font-size: 9.5pt; }
				.awards-list { padding-left: 20px; font-size: 10pt; color: #374151; }
				.awards-list li { margin-bottom: 4px; }
			`,
			renderHeader: ({ name, email, phone, location, title }) => `
				<header class="cv-header">
					<h1 class="cv-name">${escapeHtml(name)}</h1>
					${title ? `<p class="cv-title">${escapeHtml(title)}</p>` : ""}
					<div class="cv-contact">
						${email ? `<span>${escapeHtml(email)}</span>` : ""}
						${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
						${location ? `<span>${escapeHtml(location)}</span>` : ""}
					</div>
				</header>`,
		},
		// Modern Sidebar (Executive style)
		31: {
			css: `
				.cv-container { display: flex; gap: 0; padding: 0; }
				.cv-sidebar { width: 250px; background: #1e293b; color: #e2e8f0; padding: 30px 20px; min-height: 100vh; }
				.cv-main { flex: 1; padding: 30px; }
				.cv-name { font-size: 22pt; font-weight: 700; color: #fff; margin-bottom: 4px; }
				.cv-title { font-size: 11pt; color: #94a3b8; margin-bottom: 16px; }
				.cv-contact { font-size: 9pt; color: #cbd5e1; }
				.cv-contact span { display: block; margin-bottom: 6px; }
				.section-title { font-size: 13pt; color: #1e293b; border-bottom: 2px solid #3b82f6; padding-bottom: 4px; margin: 20px 0 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
				.cv-sidebar .section-title { color: #93c5fd; border-bottom-color: #475569; }
				.entry { margin-bottom: 14px; }
				.entry-header { display: flex; justify-content: space-between; align-items: baseline; }
				.entry-title { color: #1f2937; font-size: 11pt; font-weight: 600; }
				.entry-date { color: #6b7280; font-size: 9pt; }
				.entry-subtitle { color: #4b5563; font-size: 10pt; }
				.entry-description { color: #374151; font-size: 10pt; margin-top: 4px; }
				.summary-text { color: #374151; font-size: 10.5pt; }
				.skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
				.skill-tag { background: #334155; color: #e2e8f0; padding: 3px 10px; border-radius: 4px; font-size: 9pt; }
				.awards-list { padding-left: 16px; font-size: 10pt; color: #cbd5e1; }
			`,
			renderHeader: ({ name, email, phone, location, title }) => `
				<header class="cv-header" style="margin-bottom:20px;">
					<h1 class="cv-name">${escapeHtml(name)}</h1>
					${title ? `<p class="cv-title">${escapeHtml(title)}</p>` : ""}
					<div class="cv-contact">
						${email ? `<span>${escapeHtml(email)}</span>` : ""}
						${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
						${location ? `<span>${escapeHtml(location)}</span>` : ""}
					</div>
				</header>`,
		},
		// Tech Modern
		32: {
			css: `
				.cv-header { background: #0f172a; color: #f8fafc; padding: 24px 30px; margin: -40px -40px 24px; }
				.cv-name { font-size: 26pt; font-weight: 700; font-family: 'Courier New', monospace; }
				.cv-title { font-size: 12pt; color: #60a5fa; margin-top: 4px; font-family: 'Courier New', monospace; }
				.cv-contact { font-size: 9.5pt; color: #94a3b8; margin-top: 8px; }
				.cv-contact span { margin-right: 16px; }
				.section-title { font-size: 13pt; color: #0f172a; margin: 20px 0 12px; font-family: 'Courier New', monospace; padding-left: 12px; border-left: 3px solid #3b82f6; }
				.entry { margin-bottom: 14px; }
				.entry-header { display: flex; justify-content: space-between; }
				.entry-title { color: #1e293b; font-size: 11pt; font-weight: 600; }
				.entry-date { color: #64748b; font-size: 9pt; font-family: 'Courier New', monospace; }
				.entry-subtitle { color: #475569; font-size: 10pt; }
				.entry-description { color: #334155; font-size: 10pt; margin-top: 4px; }
				.summary-text { color: #334155; font-size: 10.5pt; }
				.skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
				.skill-tag { background: #1e293b; color: #60a5fa; padding: 3px 10px; border-radius: 2px; font-size: 9pt; font-family: 'Courier New', monospace; }
				.awards-list { padding-left: 20px; font-size: 10pt; }
			`,
			renderHeader: ({ name, email, phone, location, title }) => `
				<header class="cv-header">
					<h1 class="cv-name">${escapeHtml(name)}</h1>
					${title ? `<p class="cv-title">${escapeHtml(title)}</p>` : ""}
					<div class="cv-contact">
						${email ? `<span>${escapeHtml(email)}</span>` : ""}
						${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
						${location ? `<span>${escapeHtml(location)}</span>` : ""}
					</div>
				</header>`,
		},
		// Creative Portfolio
		33: {
			css: `
				.cv-header { display: flex; gap: 24px; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 3px solid #8b5cf6; }
				.cv-name { font-size: 26pt; font-weight: 800; color: #7c3aed; }
				.cv-title { font-size: 12pt; color: #a78bfa; margin-top: 2px; }
				.cv-contact { font-size: 9.5pt; color: #6b7280; margin-top: 6px; }
				.cv-contact span { display: block; margin-bottom: 2px; }
				.section-title { font-size: 14pt; color: #7c3aed; margin: 20px 0 12px; padding: 4px 12px; background: #f5f3ff; border-radius: 4px; }
				.entry { margin-bottom: 14px; padding-left: 12px; border-left: 2px solid #c4b5fd; }
				.entry-header { display: flex; justify-content: space-between; }
				.entry-title { color: #1f2937; font-size: 11pt; font-weight: 600; }
				.entry-date { color: #7c3aed; font-size: 9pt; }
				.entry-subtitle { color: #4b5563; font-size: 10pt; }
				.entry-description { color: #374151; font-size: 10pt; margin-top: 4px; }
				.summary-text { color: #374151; font-size: 10.5pt; }
				.skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
				.skill-tag { background: linear-gradient(135deg, #8b5cf6, #6366f1); color: white; padding: 4px 12px; border-radius: 20px; font-size: 9pt; }
				.awards-list { padding-left: 20px; font-size: 10pt; }
			`,
			renderHeader: ({ name, email, phone, location, title }) => `
				<header class="cv-header">
					<div>
						<h1 class="cv-name">${escapeHtml(name)}</h1>
						${title ? `<p class="cv-title">${escapeHtml(title)}</p>` : ""}
						<div class="cv-contact">
							${email ? `<span>${escapeHtml(email)}</span>` : ""}
							${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
							${location ? `<span>${escapeHtml(location)}</span>` : ""}
						</div>
					</div>
				</header>`,
		},
		// Minimalist Plus
		34: {
			css: `
				.cv-header { text-align: left; margin-bottom: 32px; }
				.cv-name { font-size: 30pt; font-weight: 300; color: #111827; letter-spacing: 2px; }
				.cv-title { font-size: 11pt; color: #9ca3af; text-transform: uppercase; letter-spacing: 3px; margin-top: 4px; }
				.cv-contact { font-size: 9pt; color: #9ca3af; margin-top: 12px; }
				.cv-contact span { margin-right: 20px; }
				.section-title { font-size: 10pt; color: #9ca3af; margin: 28px 0 12px; text-transform: uppercase; letter-spacing: 4px; }
				.entry { margin-bottom: 16px; }
				.entry-header { display: flex; justify-content: space-between; }
				.entry-title { color: #111827; font-size: 11pt; font-weight: 500; }
				.entry-date { color: #9ca3af; font-size: 9pt; }
				.entry-subtitle { color: #6b7280; font-size: 10pt; }
				.entry-description { color: #4b5563; font-size: 10pt; margin-top: 6px; }
				.summary-text { color: #4b5563; font-size: 10.5pt; }
				.skills-grid { display: flex; flex-wrap: wrap; gap: 8px; }
				.skill-tag { color: #374151; padding: 2px 0; font-size: 10pt; border-bottom: 1px solid #e5e7eb; }
				.awards-list { padding-left: 20px; font-size: 10pt; list-style: none; }
				.awards-list li::before { content: "—  "; color: #9ca3af; }
			`,
			renderHeader: ({ name, email, phone, location, title }) => `
				<header class="cv-header">
					<h1 class="cv-name">${escapeHtml(name)}</h1>
					${title ? `<p class="cv-title">${escapeHtml(title)}</p>` : ""}
					<div class="cv-contact">
						${email ? `<span>${escapeHtml(email)}</span>` : ""}
						${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
						${location ? `<span>${escapeHtml(location)}</span>` : ""}
					</div>
				</header>`,
		},
		// Dubai Professional
		35: {
			css: `
				.cv-header { background: linear-gradient(135deg, #1e3a5f, #0c2340); color: #fff; padding: 28px 30px; margin: -40px -40px 24px; border-bottom: 4px solid #d4a853; }
				.cv-name { font-size: 26pt; font-weight: 700; color: #d4a853; }
				.cv-title { font-size: 12pt; color: #e2e8f0; margin-top: 4px; }
				.cv-contact { font-size: 9.5pt; color: #94a3b8; margin-top: 8px; }
				.cv-contact span { margin-right: 16px; }
				.section-title { font-size: 13pt; color: #1e3a5f; margin: 20px 0 12px; padding-bottom: 4px; border-bottom: 2px solid #d4a853; text-transform: uppercase; letter-spacing: 1px; }
				.entry { margin-bottom: 14px; }
				.entry-header { display: flex; justify-content: space-between; }
				.entry-title { color: #1e3a5f; font-size: 11pt; font-weight: 600; }
				.entry-date { color: #d4a853; font-size: 9pt; font-weight: 500; }
				.entry-subtitle { color: #4b5563; font-size: 10pt; }
				.entry-description { color: #374151; font-size: 10pt; margin-top: 4px; }
				.summary-text { color: #374151; font-size: 10.5pt; }
				.skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
				.skill-tag { background: #1e3a5f; color: #d4a853; padding: 3px 10px; border-radius: 4px; font-size: 9pt; }
				.awards-list { padding-left: 20px; font-size: 10pt; }
			`,
			renderHeader: ({ name, email, phone, location, title }) => `
				<header class="cv-header">
					<h1 class="cv-name">${escapeHtml(name)}</h1>
					${title ? `<p class="cv-title">${escapeHtml(title)}</p>` : ""}
					<div class="cv-contact">
						${email ? `<span>${escapeHtml(email)}</span>` : ""}
						${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
						${location ? `<span>${escapeHtml(location)}</span>` : ""}
					</div>
				</header>`,
		},
		// HireGeniX Teal
		36: {
			css: `
				.cv-header { background: linear-gradient(135deg, #0097A7, #00838F); color: #fff; padding: 28px 30px; margin: -40px -40px 24px; }
				.cv-photo { width: 80px; height: 80px; border-radius: 50%; border: 3px solid rgba(255,255,255,0.8); object-fit: cover; margin-right: 20px; float: left; }
				.cv-name { font-size: 26pt; font-weight: 700; color: #fff; }
				.cv-title { font-size: 12pt; color: rgba(255,255,255,0.9); margin-top: 4px; }
				.cv-contact { font-size: 9.5pt; color: rgba(255,255,255,0.8); margin-top: 8px; }
				.cv-contact span { margin-right: 16px; }
				.section-title { font-size: 13pt; color: #0097A7; margin: 20px 0 12px; padding-bottom: 4px; border-bottom: 2px solid #0097A7; text-transform: uppercase; letter-spacing: 1px; }
				.entry { margin-bottom: 14px; }
				.entry-header { display: flex; justify-content: space-between; }
				.entry-title { color: #1f2937; font-size: 11pt; font-weight: 600; }
				.entry-date { color: #0097A7; font-size: 9pt; font-weight: 500; }
				.entry-subtitle { color: #4b5563; font-size: 10pt; }
				.entry-description { color: #374151; font-size: 10pt; margin-top: 4px; }
				.summary-text { color: #374151; font-size: 10.5pt; }
				.skills-grid { display: flex; flex-wrap: wrap; gap: 6px; }
				.skill-tag { background: #E0F4F5; color: #0097A7; padding: 3px 10px; border-radius: 4px; font-size: 9pt; border: 1px solid #80CBC4; }
				.awards-list { padding-left: 20px; font-size: 10pt; }
				.rich-text { font-size: 10pt; color: #374151; }
				.rich-text ul, .rich-text ol { padding-left: 20px; margin: 4px 0; }
				.rich-text li { margin-bottom: 2px; }
				.rich-text p { margin-bottom: 4px; }
			`,
			renderHeader: ({ name, email, phone, location, title, photo }) => `
				<header class="cv-header">
					${photo ? `<img class="cv-photo" src="${photo}" alt="Photo" />` : ""}
					<h1 class="cv-name">${escapeHtml(name)}</h1>
					${title ? `<p class="cv-title">${escapeHtml(title)}</p>` : ""}
					<div class="cv-contact">
						${email ? `<span>${escapeHtml(email)}</span>` : ""}
						${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
						${location ? `<span>${escapeHtml(location)}</span>` : ""}
					</div>
					<div style="clear:both;"></div>
				</header>`,
		},
	};

	return templates[templateId] || templates[0];
}

/**
 * Sanitize rich text HTML — allow basic formatting tags, strip everything else.
 */
function sanitizeRichText(html) {
	if (!html) return "";
	const str = String(html);
	// Allow: b, i, u, em, strong, s, p, br, ul, ol, li, span (with style), h1-h6, a
	// Strip all other tags
	return str
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/on\w+="[^"]*"/gi, "")
		.replace(/on\w+='[^']*'/gi, "");
}

function escapeHtml(str) {
	if (!str) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function formatDate(dateStr) {
	if (!dateStr) return "";
	try {
		const d = new Date(dateStr);
		if (isNaN(d.getTime())) return String(dateStr);
		return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
	} catch {
		return String(dateStr);
	}
}

function formatDateRange(start, end, isCurrent) {
	const s = formatDate(start);
	if (isCurrent) return s ? `${s} - Present` : "Present";
	const e = formatDate(end);
	if (s && e) return `${s} - ${e}`;
	return s || e || "";
}

/**
 * GET /job-seeker/profile/download-cv
 * Generates and downloads a PDF CV from profile data.
 * Query params: templateId (default 0)
 */
const downloadProfileAsCv = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const templateId = parseInt(req.query.templateId) || 0;

		// Fetch full profile data
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: {
				firstName: true,
				lastName: true,
				middleName: true,
				email: true,
				phoneNumber: true,
				countryCode: true,
			},
		});

		if (!user) {
			return res.status(404).json({ status: "FAIL", message: "User not found" });
		}

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: {
				experience: true,
				education: true,
				certifications: true,
				summary: true,
				languages: true,
				awards: true,
				interests: true,
				skills: {
					include: { skill: { select: { name: true } } },
				},
			},
		});

		if (!jobSeeker) {
			return res.status(404).json({ status: "FAIL", message: "Job seeker profile not found" });
		}

		const data = {
			name: [user.firstName, user.middleName, user.lastName].filter(Boolean).join(" "),
			email: user.email,
			phone: user.countryCode && user.phoneNumber ? `${user.countryCode} ${user.phoneNumber}` : user.phoneNumber || "",
			location: "",
			title: "",
			summary: jobSeeker.summary || "",
			experience: Array.isArray(jobSeeker.experience) ? jobSeeker.experience : [],
			education: Array.isArray(jobSeeker.education) ? jobSeeker.education : [],
			skills: (jobSeeker.skills || []).map((s) => s.skill?.name || "").filter(Boolean),
			certifications: Array.isArray(jobSeeker.certifications) ? jobSeeker.certifications : [],
			languages: Array.isArray(jobSeeker.languages) ? jobSeeker.languages : [],
			awards: Array.isArray(jobSeeker.awards) ? jobSeeker.awards : [],
			interests: Array.isArray(jobSeeker.interests) ? jobSeeker.interests : [],
		};

		const html = generateCvHtml(data, templateId);

		// Generate PDF using Puppeteer
		let puppeteer;
		try {
			puppeteer = require("puppeteer-core");
		} catch {
			try {
				puppeteer = require("puppeteer");
			} catch {
				// Fallback: return HTML if Puppeteer not installed
				res.setHeader("Content-Type", "text/html");
				return res.send(html);
			}
		}

		const browser = await puppeteer.launch({
			headless: true,
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
		});

		try {
			const page = await browser.newPage();
			await page.setContent(html, { waitUntil: "networkidle0" });

			const pdfBuffer = await page.pdf({
				format: "A4",
				printBackground: true,
				margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
			});

			const fileName = `${data.name.replace(/[^a-zA-Z0-9]/g, "_")}_CV.pdf`;

			res.setHeader("Content-Type", "application/pdf");
			res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
			res.setHeader("Content-Length", pdfBuffer.length);
			return res.send(Buffer.from(pdfBuffer));
		} finally {
			await browser.close();
		}
	} catch (error) {
		console.error("[cvPdfGenerator] downloadProfileAsCv error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to generate CV PDF",
		});
	}
};

/**
 * Generate HTML for a recruiter CV from client-supplied data.
 * Supports rich text (HTML pass-through) and photo embedding.
 */
function generateRecruiterCvHtml(cvData, templateId = 36) {
	const personal = cvData.personal || {};
	const name = [personal.firstName, personal.lastName].filter(Boolean).join(" ") || "Your Name";
	const email = personal.email || "";
	const phone = personal.phone || "";
	const location = personal.location || "";
	const title = personal.title || "";
	const photo = personal.photo || "";
	const summary = cvData.summary || "";
	const experience = Array.isArray(cvData.experience) ? cvData.experience : [];
	const education = Array.isArray(cvData.education) ? cvData.education : [];
	const skills = Array.isArray(cvData.skills) ? cvData.skills : [];
	const certifications = Array.isArray(cvData.certifications) ? cvData.certifications : [];
	const links = cvData.links || {};

	const templateStyles = getTemplateStyles(templateId);
	const isRichText = typeof summary === "string" && summary.includes("<");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 11pt; line-height: 1.5; color: #333; }
  .cv-container { max-width: 800px; margin: 0 auto; padding: 40px; }
  .rich-text { font-size: 10.5pt; color: #374151; }
  .rich-text ul, .rich-text ol { padding-left: 20px; margin: 4px 0; }
  .rich-text li { margin-bottom: 2px; }
  .rich-text p { margin-bottom: 4px; }
  ${templateStyles.css}
</style>
</head>
<body>
<div class="cv-container">
  ${templateStyles.renderHeader({ name, email, phone, location, title, photo })}

  ${summary ? `
  <section class="cv-section">
    <h2 class="section-title">Professional Summary</h2>
    <div class="${isRichText ? "rich-text" : "summary-text"}">${isRichText ? sanitizeRichText(summary) : escapeHtml(summary)}</div>
  </section>` : ""}

  ${experience.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Work Experience</h2>
    ${experience.map((exp) => {
			const expDesc = exp.description || "";
			const isExpRich = expDesc.includes("<");
			const startStr = exp.startDate || "";
			const endStr = exp.current ? "Present" : (exp.endDate || "");
			const dateRange = startStr && endStr ? `${startStr} - ${endStr}` : startStr || endStr;
			return `
    <div class="entry">
      <div class="entry-header">
        <strong class="entry-title">${escapeHtml(exp.title || "")}</strong>
        <span class="entry-date">${escapeHtml(dateRange)}</span>
      </div>
      <div class="entry-subtitle">${escapeHtml(exp.company || "")}${exp.location ? ` | ${escapeHtml(exp.location)}` : ""}</div>
      ${expDesc ? `<div class="${isExpRich ? "rich-text" : "entry-description"}">${isExpRich ? sanitizeRichText(expDesc) : escapeHtml(expDesc)}</div>` : ""}
    </div>`;
		}).join("")}
  </section>` : ""}

  ${education.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Education</h2>
    ${education.map((edu) => {
			const dateRange = edu.startYear && edu.endYear ? `${edu.startYear} - ${edu.endYear}` : edu.startYear || edu.endYear || "";
			return `
    <div class="entry">
      <div class="entry-header">
        <strong class="entry-title">${escapeHtml(edu.degree || "")}</strong>
        <span class="entry-date">${escapeHtml(String(dateRange))}</span>
      </div>
      <div class="entry-subtitle">${escapeHtml(edu.institution || "")}${edu.field ? ` - ${escapeHtml(edu.field)}` : ""}</div>
    </div>`;
		}).join("")}
  </section>` : ""}

  ${skills.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Skills</h2>
    <div class="skills-grid">
      ${skills.map((s) => `<span class="skill-tag">${escapeHtml(typeof s === "string" ? s : s.name || "")}</span>`).join("")}
    </div>
  </section>` : ""}

  ${certifications.length > 0 ? `
  <section class="cv-section">
    <h2 class="section-title">Certifications</h2>
    ${certifications.map((cert) => `
    <div class="entry">
      <div class="entry-header">
        <strong class="entry-title">${escapeHtml(cert.name || "")}</strong>
        <span class="entry-date">${cert.issueYear || ""}</span>
      </div>
      ${cert.issuer ? `<div class="entry-subtitle">${escapeHtml(cert.issuer)}</div>` : ""}
    </div>`).join("")}
  </section>` : ""}

  ${Object.values(links || {}).some(Boolean) ? `
  <section class="cv-section">
    <h2 class="section-title">Links</h2>
    <div style="font-size: 10pt;">
      ${links.linkedin ? `<div><strong>LinkedIn:</strong> <a href="${escapeHtml(links.linkedin)}">${escapeHtml(links.linkedin)}</a></div>` : ""}
      ${links.github ? `<div><strong>GitHub:</strong> <a href="${escapeHtml(links.github)}">${escapeHtml(links.github)}</a></div>` : ""}
      ${links.portfolio ? `<div><strong>Portfolio:</strong> <a href="${escapeHtml(links.portfolio)}">${escapeHtml(links.portfolio)}</a></div>` : ""}
      ${links.other ? `<div><strong>Other:</strong> <a href="${escapeHtml(links.other)}">${escapeHtml(links.other)}</a></div>` : ""}
    </div>
  </section>` : ""}
</div>
</body>
</html>`;
}

/**
 * POST /recruiter/cv/generate-pdf
 * Generates a PDF from client-supplied CV data (recruiter CV builder).
 * Body: { cvData: {...}, templateId: 36 }
 */
const generateRecruiterCvPdf = async (req, res) => {
	try {
		const { cvData, templateId = 36 } = req.body;

		if (!cvData) {
			return res.status(400).json({ status: "FAIL", message: "cvData is required" });
		}

		const html = generateRecruiterCvHtml(cvData, parseInt(templateId));

		let puppeteer;
		try {
			puppeteer = require("puppeteer-core");
		} catch {
			try {
				puppeteer = require("puppeteer");
			} catch {
				res.setHeader("Content-Type", "text/html");
				return res.send(html);
			}
		}

		const browser = await puppeteer.launch({
			headless: true,
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
		});

		try {
			const page = await browser.newPage();
			await page.setContent(html, { waitUntil: "networkidle0" });

			const pdfBuffer = await page.pdf({
				format: "A4",
				printBackground: true,
				margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
			});

			const personal = cvData.personal || {};
			const name = [personal.firstName, personal.lastName].filter(Boolean).join("_") || "CV";
			const fileName = `${name.replace(/[^a-zA-Z0-9_]/g, "_")}_CV.pdf`;

			res.setHeader("Content-Type", "application/pdf");
			res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
			res.setHeader("Content-Length", pdfBuffer.length);
			return res.send(Buffer.from(pdfBuffer));
		} finally {
			await browser.close();
		}
	} catch (error) {
		console.error("[cvPdfGenerator] generateRecruiterCvPdf error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to generate CV PDF",
		});
	}
};

/**
 * Convert client-rendered HTML to PDF.
 * Accepts { html, fileName } in req.body.
 * This ensures the downloaded PDF matches exactly what the user sees in the browser.
 */
const htmlToPdf = async (req, res) => {
	try {
		const { html, fileName = "CV.pdf" } = req.body;
		if (!html) {
			return res.status(400).json({ status: "FAIL", message: "html is required" });
		}

		let puppeteer;
		try {
			puppeteer = require("puppeteer-core");
		} catch {
			try {
				puppeteer = require("puppeteer");
			} catch {
				return res.status(500).json({ status: "ERROR", message: "PDF engine not available" });
			}
		}

		const browser = await puppeteer.launch({
			headless: true,
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
		});

		try {
			const page = await browser.newPage();

			// Wrap the HTML in a full document with print styles
			// A4 = 210mm x 297mm. At 96dpi that's ~794px x 1123px.
			// We set the viewport to 794px and constrain content width.
			const fullHtml = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600&family=Outfit:wght@300;400;500;600;700;800;900&family=Playfair+Display:ital,wght@0,700;0,900;1,700&family=DM+Serif+Display:ital@0;1&family=Josefin+Sans:wght@300;400;600;700&family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
html,body{margin:0;padding:0;width:100%;overflow:hidden}
@page{margin:0;size:A4}
#cv-root{width:100%;max-width:100%;overflow:hidden;word-wrap:break-word;overflow-wrap:break-word}
#cv-root>div{max-width:100%!important;margin:0!important;width:100%!important}
#cv-root p{overflow-wrap:break-word;word-break:break-word;margin:0 0 2px}
#cv-root ul,#cv-root ol{margin:2px 0;padding-left:18px}
#cv-root li{margin-bottom:1px}
</style></head><body><div id="cv-root">${html}</div></body></html>`;

			await page.setViewport({ width: 794, height: 1123 });
			await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 30000 });
			await new Promise(r => setTimeout(r, 1000)); // Let fonts load

			const pdfBuffer = await page.pdf({
				format: "A4",
				printBackground: true,
				margin: { top: 0, right: 0, bottom: 0, left: 0 },
			});

			const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
			res.setHeader("Content-Type", "application/pdf");
			res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
			res.setHeader("Content-Length", pdfBuffer.length);
			return res.send(Buffer.from(pdfBuffer));
		} finally {
			await browser.close();
		}
	} catch (error) {
		console.error("[cvPdfGenerator] htmlToPdf error:", error);
		return res.status(500).json({ status: "ERROR", message: "Failed to generate PDF" });
	}
};

module.exports = {
	downloadProfileAsCv,
	generateCvHtml,
	generateRecruiterCvPdf,
	htmlToPdf,
};
