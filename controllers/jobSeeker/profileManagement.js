const { prisma } = require("../../prisma");
const crypto = require("crypto");

// =======================
// UPDATE JOB SEEKER PROFILE
// =======================
// PUT /job-seeker/profile
const updateJobSeekerProfile = async (req, res) => {
	try {
		const userId = req.user.userId;

		const { firstName, lastName, middleName, phoneNumber, countryCode, summary, languages, awards, interests, hasVisa, hasWorkPermit } = req.body;

		// 1) Ensure user exists and is active
		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { id: true, isActive: true },
		});

		if (!user || !user.isActive) {
			return res.status(403).json({
				status: "FAIL",
				message: "User account is inactive or not found",
			});
		}

		// 2) Ensure job seeker profile exists
		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found. Please create a profile first.",
			});
		}

		// 3) Build update data (only include provided fields)
		const updateData = {};
		if (firstName !== undefined) updateData.firstName = firstName.trim();
		if (lastName !== undefined) updateData.lastName = lastName.trim();
		if (middleName !== undefined) updateData.middleName = middleName ? middleName.trim() : null;
		if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber.trim();
		if (countryCode !== undefined) updateData.countryCode = countryCode.trim();

		// 3b) Build JobSeeker update data (summary, languages, awards, interests)
		const jobSeekerUpdateData = {};
		if (summary !== undefined) jobSeekerUpdateData.summary = summary ? summary.trim() : null;
		if (languages !== undefined) jobSeekerUpdateData.languages = languages;
		if (awards !== undefined) jobSeekerUpdateData.awards = awards;
		if (interests !== undefined) jobSeekerUpdateData.interests = interests;
		if (typeof hasVisa === "boolean") jobSeekerUpdateData.hasVisa = hasVisa;
		if (typeof hasWorkPermit === "boolean") jobSeekerUpdateData.hasWorkPermit = hasWorkPermit;

		if (Object.keys(updateData).length === 0 && Object.keys(jobSeekerUpdateData).length === 0) {
			return res.status(400).json({
				status: "FAIL",
				message: "No fields provided to update",
			});
		}

		// 4) Check for phone uniqueness if phone is being updated
		if (updateData.phoneNumber || updateData.countryCode) {
			const phoneToCheck = updateData.phoneNumber || (await prisma.user.findUnique({ where: { id: userId }, select: { phoneNumber: true } })).phoneNumber;
			const codeToCheck = updateData.countryCode || (await prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } })).countryCode;

			const existingPhone = await prisma.user.findFirst({
				where: {
					phoneNumber: phoneToCheck,
					countryCode: codeToCheck,
					id: { not: userId },
				},
			});

			if (existingPhone) {
				return res.status(409).json({
					status: "FAIL",
					message: "Phone number already in use by another account",
				});
			}
		}

		// 5) Update user record (if any user fields provided)
		let updatedUser = null;
		if (Object.keys(updateData).length > 0) {
			updatedUser = await prisma.user.update({
				where: { id: userId },
				data: updateData,
				select: {
					id: true,
					firstName: true,
					middleName: true,
					lastName: true,
					email: true,
					phoneNumber: true,
					countryCode: true,
					updatedAt: true,
				},
			});
		}

		// 6) Update job seeker record (summary, languages, awards, interests)
		let updatedJobSeeker = null;
		if (Object.keys(jobSeekerUpdateData).length > 0) {
			updatedJobSeeker = await prisma.jobSeeker.update({
				where: { userId },
				data: jobSeekerUpdateData,
				select: {
					summary: true,
					languages: true,
					awards: true,
					interests: true,
				},
			});
		}

		return res.status(200).json({
			status: "SUCCESS",
			message: "Profile updated successfully",
			data: {
				...(updatedUser || {}),
				...(updatedJobSeeker || {}),
			},
		});
	} catch (error) {
		console.error("Update job seeker profile error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to update profile",
		});
	}
};

// =======================
// ADD WORK EXPERIENCE
// =======================
// POST /job-seeker/profile/experience
const addWorkExperience = async (req, res) => {
	try {
		const userId = req.user.userId;

		const { jobTitle, companyName, location, startDate, endDate, isCurrent, description } = req.body;

		if (!jobTitle || !companyName || !startDate) {
			return res.status(400).json({
				status: "FAIL",
				message: "jobTitle, companyName, and startDate are required",
			});
		}

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true, experience: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
			});
		}

		const start = new Date(startDate);
		if (isNaN(start.getTime())) {
			return res.status(400).json({
				status: "FAIL",
				message: "Invalid startDate format",
			});
		}

		let end = null;
		if (endDate && !isCurrent) {
			end = new Date(endDate);
			if (isNaN(end.getTime())) {
				return res.status(400).json({
					status: "FAIL",
					message: "Invalid endDate format",
				});
			}
			if (end <= start) {
				return res.status(400).json({
					status: "FAIL",
					message: "endDate must be after startDate",
				});
			}
		}

		const experienceEntry = {
			id: crypto.randomUUID(),
			jobTitle: jobTitle.trim(),
			companyName: companyName.trim(),
			location: location ? location.trim() : null,
			startDate: start.toISOString(),
			endDate: end ? end.toISOString() : null,
			isCurrent: !!isCurrent,
			description: description ? description.trim() : null,
			createdAt: new Date().toISOString(),
		};

		// Read from DB JSON field, append, save back
		const experiences = Array.isArray(jobSeeker.experience) ? [...jobSeeker.experience] : [];
		experiences.push(experienceEntry);

		await prisma.jobSeeker.update({
			where: { id: jobSeeker.id },
			data: { experience: experiences },
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Work experience added successfully",
			data: experienceEntry,
		});
	} catch (error) {
		console.error("Add work experience error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to add work experience",
		});
	}
};

// =======================
// ADD EDUCATION
// =======================
// POST /job-seeker/profile/education
const addEducation = async (req, res) => {
	try {
		const userId = req.user.userId;

		const { institution, degree, fieldOfStudy, startDate, endDate, isCurrent, grade, description } = req.body;

		if (!institution || !degree || !startDate) {
			return res.status(400).json({
				status: "FAIL",
				message: "institution, degree, and startDate are required",
			});
		}

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true, education: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
			});
		}

		const start = new Date(startDate);
		if (isNaN(start.getTime())) {
			return res.status(400).json({
				status: "FAIL",
				message: "Invalid startDate format",
			});
		}

		let end = null;
		if (endDate && !isCurrent) {
			end = new Date(endDate);
			if (isNaN(end.getTime())) {
				return res.status(400).json({
					status: "FAIL",
					message: "Invalid endDate format",
				});
			}
		}

		const educationEntry = {
			id: crypto.randomUUID(),
			institution: institution.trim(),
			degree: degree.trim(),
			fieldOfStudy: fieldOfStudy ? fieldOfStudy.trim() : null,
			startDate: start.toISOString(),
			endDate: end ? end.toISOString() : null,
			isCurrent: !!isCurrent,
			grade: grade ? grade.trim() : null,
			description: description ? description.trim() : null,
			createdAt: new Date().toISOString(),
		};

		const educations = Array.isArray(jobSeeker.education) ? [...jobSeeker.education] : [];
		educations.push(educationEntry);

		await prisma.jobSeeker.update({
			where: { id: jobSeeker.id },
			data: { education: educations },
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Education added successfully",
			data: educationEntry,
		});
	} catch (error) {
		console.error("Add education error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to add education",
		});
	}
};

// =======================
// ADD CERTIFICATION
// =======================
// POST /job-seeker/profile/certifications
const addCertification = async (req, res) => {
	try {
		const userId = req.user.userId;

		const { name, issuingOrganization, issueDate, expiryDate, credentialId, credentialUrl, description } = req.body;

		if (!name || !issuingOrganization) {
			return res.status(400).json({
				status: "FAIL",
				message: "name and issuingOrganization are required",
			});
		}

		const jobSeeker = await prisma.jobSeeker.findUnique({
			where: { userId },
			select: { id: true, certifications: true },
		});

		if (!jobSeeker) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker profile not found",
			});
		}

		let issue = null;
		if (issueDate) {
			issue = new Date(issueDate);
			if (isNaN(issue.getTime())) {
				return res.status(400).json({
					status: "FAIL",
					message: "Invalid issueDate format",
				});
			}
		}

		let expiry = null;
		if (expiryDate) {
			expiry = new Date(expiryDate);
			if (isNaN(expiry.getTime())) {
				return res.status(400).json({
					status: "FAIL",
					message: "Invalid expiryDate format",
				});
			}
		}

		const certificationEntry = {
			id: crypto.randomUUID(),
			name: name.trim(),
			issuingOrganization: issuingOrganization.trim(),
			issueDate: issue ? issue.toISOString() : null,
			expiryDate: expiry ? expiry.toISOString() : null,
			credentialId: credentialId ? credentialId.trim() : null,
			credentialUrl: credentialUrl ? credentialUrl.trim() : null,
			description: description ? description.trim() : null,
			createdAt: new Date().toISOString(),
		};

		const certifications = Array.isArray(jobSeeker.certifications) ? [...jobSeeker.certifications] : [];
		certifications.push(certificationEntry);

		await prisma.jobSeeker.update({
			where: { id: jobSeeker.id },
			data: { certifications },
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Certification added successfully",
			data: certificationEntry,
		});
	} catch (error) {
		console.error("Add certification error:", error);

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to add certification",
		});
	}
};

module.exports = {
	updateJobSeekerProfile,
	addWorkExperience,
	addEducation,
	addCertification,
};
