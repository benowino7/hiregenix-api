const { prisma } = require("../../prisma"); // adjust import
const { findOrCreateNormalizedSkill, inferProficiency } = require("../ai/skillNormalizer");

// Helper: get jobSeekerId from auth user
async function getJobSeekerIdOrThrow(userId) {
	const jobSeeker = await prisma.jobSeeker.findUnique({
		where: { userId },
		select: { id: true },
	});
	if (!jobSeeker) {
		const err = new Error("Job seeker profile not found");
		err.statusCode = 404;
		throw err;
	}
	return jobSeeker.id;
}

// POST /job-seeker/skills
// body: { skillId: string, proficiency?: string|null }
// OR:   { name: string, proficiency?: string|null }  (resolves via normalizer)
const createJobSeekerSkill = async (req, res) => {
	try {
		const userId = req.user?.userId;
		let { skillId, name, proficiency } = req.body;

		if (!skillId && !name) {
			return res.status(400).json({
				status: "FAIL",
				message: "skillId or name is required",
			});
		}

		const jobSeekerId = await getJobSeekerIdOrThrow(userId);

		// If name provided instead of skillId, normalize and find/create
		if (!skillId && name) {
			skillId = await findOrCreateNormalizedSkill(prisma, name);
		}

		// Validate skill exists
		const skill = await prisma.skill.findUnique({
			where: { id: skillId },
			select: { id: true, name: true },
		});

		if (!skill) {
			return res.status(400).json({
				status: "FAIL",
				message: "Invalid skillId",
			});
		}

		const created = await prisma.jobSeekerSkill.create({
			data: {
				jobSeekerId,
				skillId,
				proficiency: proficiency?.trim() || null,
			},
			select: {
				id: true,
				skillId: true,
				proficiency: true,
				createdAt: true,
				skill: { select: { id: true, name: true } },
			},
		});

		return res.status(201).json({
			status: "SUCCESS",
			message: "Skill added to job seeker",
			data: created,
		});
	} catch (err) {
		console.error(err);

		// Duplicate (jobSeekerId, skillId)
		if (err?.code === "P2002") {
			return res.status(409).json({
				status: "FAIL",
				message: "Skill already added",
			});
		}

		return res.status(err.statusCode || 500).json({
			status: "ERROR",
			message: err.statusCode ? err.message : "Failed to add skill",
		});
	}
};

// GET /job-seeker/skills
const getJobSeekerSkills = async (req, res) => {
  try {
    const userId = req.user?.userId;

    // 1) Get jobSeekerId
    const jobSeeker = await prisma.jobSeeker.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!jobSeeker) {
      return res.status(404).json({
        status: "FAIL",
        message: "Job seeker profile not found",
      });
    }

    // 2) Fetch skills
    const skills = await prisma.jobSeekerSkill.findMany({
      where: { jobSeekerId: jobSeeker.id },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        proficiency: true,
        createdAt: true,
        skill: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return res.json({
      status: "SUCCESS",
      data: skills.map((s) => ({
        id: s.id,
        skillId: s.skill.id,
        skillName: s.skill.name,
        proficiency: s.proficiency,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "ERROR",
      message: "Failed to fetch job seeker skills",
    });
  }
};


// PATCH /job-seeker/skills/:id
// body: { proficiency?: string|null }
// (Simple update: only proficiency)
const updateJobSeekerSkill = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const linkId = req.params.id;
		const { proficiency } = req.body;

		const jobSeekerId = await getJobSeekerIdOrThrow(userId);

		// Ensure the link belongs to this job seeker
		const existing = await prisma.jobSeekerSkill.findFirst({
			where: { id: linkId, jobSeekerId },
			select: { id: true },
		});

		if (!existing) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker skill not found",
			});
		}

		const updated = await prisma.jobSeekerSkill.update({
			where: { id: linkId },
			data: {
				// allow clearing by sending "" or null
				...(proficiency !== undefined && { proficiency: proficiency?.trim() || null }),
			},
			select: {
				id: true,
				skillId: true,
				proficiency: true,
				createdAt: true,
				skill: { select: { id: true, name: true } },
			},
		});

		return res.json({
			status: "SUCCESS",
			message: "Job seeker skill updated",
			data: updated,
		});
	} catch (err) {
		console.error(err);
		return res.status(500).json({
			status: "ERROR",
			message: "Failed to update job seeker skill",
		});
	}
};

// DELETE /job-seeker/skills/:id
const deleteJobSeekerSkill = async (req, res) => {
	try {
		const userId = req.user?.userId;
		const linkId = req.params.id;

		const jobSeekerId = await getJobSeekerIdOrThrow(userId);

		// Ensure ownership first
		const existing = await prisma.jobSeekerSkill.findFirst({
			where: { id: linkId, jobSeekerId },
			select: { id: true },
		});

		if (!existing) {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker skill not found",
			});
		}

		await prisma.jobSeekerSkill.delete({
			where: { id: linkId },
		});

		return res.json({
			status: "SUCCESS",
			message: "Job seeker skill deleted",
		});
	} catch (err) {
		console.error(err);

		// record not found
		if (err?.code === "P2025") {
			return res.status(404).json({
				status: "FAIL",
				message: "Job seeker skill not found",
			});
		}

		return res.status(500).json({
			status: "ERROR",
			message: "Failed to delete job seeker skill",
		});
	}
};

module.exports = {
	createJobSeekerSkill,
    getJobSeekerSkills,
	updateJobSeekerSkill,
	deleteJobSeekerSkill,
};
