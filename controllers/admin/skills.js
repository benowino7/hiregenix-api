const { prisma } = require("../../prisma");

/**
 * Create a new skill and optionally link to industries
 * POST /api/skills
 */
const createSkill = async (req, res) => {
	try {
		const { name, industryIds = [] } = req.body;

		if (!name) {
			return res.status(400).json({
				status: "FAIL",
				message: "Skill name is required",
			});
		}

		if (!Array.isArray(industryIds)) {
			return res.status(400).json({
				status: "FAIL",
				message: "industryIds must be an array",
			});
		}

		// Validate industries (if provided)
		if (industryIds.length > 0) {
			const count = await prisma.industry.count({
				where: { id: { in: industryIds } },
			});

			if (count !== industryIds.length) {
				return res.status(400).json({
					status: "FAIL",
					message: "One or more industry IDs are invalid",
				});
			}
		}

		// Check if skill already exists
		const existingSkill = await prisma.skill.findUnique({
			where: { name },
		});

		if (existingSkill) {
			return res.status(409).json({
				status: "FAIL",
				message: "Skill already exists",
			});
		}

		// Create skill
		const skill = await prisma.skill.create({
			data: { name },
		});

		// Link skill to industries
		if (industryIds.length > 0) {
			await prisma.industrySkill.createMany({
				data: industryIds.map((industryId) => ({
					skillId: skill.id,
					industryId,
				})),
				skipDuplicates: true,
			});
		}

		// Return skill with industries
		const skillWithIndustries = await prisma.skill.findUnique({
			where: { id: skill.id },
			include: {
				industries: {
					include: {
						industry: true,
					},
				},
			},
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Skill created successfully",
			data: skillWithIndustries,
		});
	} catch (error) {
		console.error("Create Skill Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Get all skills with linked industries
 * GET /api/skills
 */
const getSkills = async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page || "1", 10), 1);
		const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
		const search = req.query.search || "";
		const industryId = req.query.industryId || "";
		const skip = (page - 1) * limit;

		const where = {
			...(search && { name: { contains: search, mode: "insensitive" } }),
			...(industryId && { industries: { some: { industryId } } }),
		};

		const [skills, total] = await Promise.all([
			prisma.skill.findMany({
				where,
				select: {
					id: true,
					name: true,
					createdAt: true,
					_count: { select: { industries: true } },
				},
				orderBy: { createdAt: "desc" },
				skip,
				take: limit,
			}),
			prisma.skill.count({ where }),
		]);

		const totalPages = Math.ceil(total / limit);
		return res.status(200).json({
			status: "SUCCESS",
			data: skills,
			meta: {
				page,
				limit,
				total,
				totalPages,
				hasNext: page < totalPages,
				hasPrev: page > 1,
			},
		});
	} catch (error) {
		console.error("Get Skills Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

/**
 * Get single skill by ID
 * GET /api/skills/:id
 */
const getSkillById = async (req, res) => {
	try {
		const { id } = req.params;

		const skill = await prisma.skill.findUnique({
			where: { id },
			include: {
				industries: {
					include: {
						industry: true,
					},
				},
			},
		});

		if (!skill) {
			return res.status(404).json({
				status: "FAIL",
				message: "Skill not found",
			});
		}

		return res.status(200).json({
			status: "SUCCESS",
			data: skill,
		});
	} catch (error) {
		console.error("Get Skill Error:", error);
		return res.status(500).json({
			status: "ERROR",
			message: "Something went wrong",
		});
	}
};

module.exports = {
    createSkill,
    getSkills,
    getSkillById
}