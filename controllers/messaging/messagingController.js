const { prisma } = require("../../prisma");

// ─── Contact Info Filter ───────────────────────────────────────
// Strips emails and phone numbers from message body before saving.
// Returns { cleanBody, wasStripped }
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{1,4}\)?[\s\-.]?\d{2,4}[\s\-.]?\d{2,4}[\s\-.]?\d{0,4}/g;

function stripContactInfo(text) {
  let wasStripped = false;
  let clean = text;

  if (EMAIL_REGEX.test(clean)) {
    clean = clean.replace(EMAIL_REGEX, "[email removed]");
    wasStripped = true;
  }
  // Reset regex lastIndex
  EMAIL_REGEX.lastIndex = 0;

  // Only strip phone-like sequences that have at least 7 digits
  clean = clean.replace(PHONE_REGEX, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 7) {
      wasStripped = true;
      return "[phone removed]";
    }
    return match;
  });

  return { cleanBody: clean.trim(), wasStripped };
}

// ─── Helpers ───────────────────────────────────────────────────

async function getUserRoleAndSubscription(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: true,
      userSubscription: {
        where: { status: "ACTIVE" },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!user) return null;

  const roles = user.roles.filter((r) => r.isActive).map((r) => r.role);
  const subscription = user.userSubscription[0] || null;
  const isPlatinum =
    subscription?.plan?.name?.toLowerCase() === "platinum" &&
    subscription?.status === "ACTIVE";

  return { user, roles, subscription, isPlatinum };
}

// Check if both participants are platinum (needed for contact sharing)
async function areBothPlatinum(userAId, userBId) {
  const [a, b] = await Promise.all([
    getUserRoleAndSubscription(userAId),
    getUserRoleAndSubscription(userBId),
  ]);
  return a?.isPlatinum && b?.isPlatinum;
}

// Find or create conversation, ensuring participantA < participantB for uniqueness
async function findOrCreateConversation(userAId, userBId, jobId = null) {
  // Sort IDs to ensure consistent ordering for the unique constraint
  const [pA, pB] =
    userAId < userBId ? [userAId, userBId] : [userBId, userAId];

  let conversation = await prisma.conversation.findUnique({
    where: {
      participantAId_participantBId: { participantAId: pA, participantBId: pB },
    },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        participantAId: pA,
        participantBId: pB,
        jobId,
      },
    });
  }

  return conversation;
}

// ─── Controllers ───────────────────────────────────────────────

/**
 * GET /messaging/conversations
 * List all conversations for the authenticated user
 */
async function getConversations(req, res) {
  try {
    const userId = req.user.userId;

    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ participantAId: userId }, { participantBId: userId }],
      },
      include: {
        participantA: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            roles: { where: { isActive: true }, select: { role: true } },
          },
        },
        participantB: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            roles: { where: { isActive: true }, select: { role: true } },
          },
        },
      },
      orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    });

    // Transform: identify the "other" participant for each conversation
    const result = conversations.map((conv) => {
      const isA = conv.participantAId === userId;
      const other = isA ? conv.participantB : conv.participantA;
      const unreadCount = isA ? conv.unreadCountA : conv.unreadCountB;

      return {
        id: conv.id,
        otherUser: {
          id: other.id,
          firstName: other.firstName,
          lastName: other.lastName,
          email: other.email,
          role: other.roles[0]?.role || "UNKNOWN",
        },
        lastMessageText: conv.lastMessageText,
        lastMessageAt: conv.lastMessageAt,
        unreadCount,
        jobId: conv.jobId,
        createdAt: conv.createdAt,
      };
    });

    return res.json({ result });
  } catch (error) {
    console.error("getConversations error:", error);
    return res.status(500).json({ message: "Failed to load conversations" });
  }
}

/**
 * GET /messaging/conversations/:conversationId/messages
 * Get messages for a conversation (with pagination)
 */
async function getMessages(req, res) {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;
    const { cursor, limit = 50 } = req.query;

    // Verify user is a participant
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (
      conversation.participantAId !== userId &&
      conversation.participantBId !== userId
    ) {
      return res.status(403).json({ message: "Not a participant" });
    }

    const where = { conversationId };
    if (cursor) {
      where.createdAt = { lt: new Date(cursor) };
    }

    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: parseInt(limit),
      include: {
        sender: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Mark messages as read
    const isA = conversation.participantAId === userId;
    await prisma.$transaction([
      prisma.message.updateMany({
        where: {
          conversationId,
          senderId: { not: userId },
          isRead: false,
        },
        data: { isRead: true },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: isA ? { unreadCountA: 0 } : { unreadCountB: 0 },
      }),
    ]);

    return res.json({ result: messages.reverse() });
  } catch (error) {
    console.error("getMessages error:", error);
    return res.status(500).json({ message: "Failed to load messages" });
  }
}

/**
 * POST /messaging/conversations/:conversationId/messages
 * Send a message in an existing conversation
 */
async function sendMessage(req, res) {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;
    const { body } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({ message: "Message body is required" });
    }

    // Get conversation
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (
      conversation.participantAId !== userId &&
      conversation.participantBId !== userId
    ) {
      return res.status(403).json({ message: "Not a participant" });
    }

    // Get sender info
    const senderInfo = await getUserRoleAndSubscription(userId);
    if (!senderInfo) {
      return res.status(404).json({ message: "User not found" });
    }

    const isJobSeeker = senderInfo.roles.includes("JOB_SEEKER");
    const isRecruiter = senderInfo.roles.includes("RECRUITER");
    const isAdmin = senderInfo.roles.includes("ADMIN");

    // JOB SEEKER RESTRICTIONS:
    // 1. Cannot initiate (handled at startConversation level)
    // 2. Cannot respond unless on Platinum
    if (isJobSeeker && !isAdmin) {
      if (!senderInfo.isPlatinum) {
        return res.status(403).json({
          message:
            "Upgrade to Platinum to respond to messages. Your account needs an active Platinum subscription to use messaging.",
          requiresUpgrade: true,
        });
      }
    }

    // RECRUITER RESTRICTIONS: must have Platinum to message
    if (isRecruiter && !isAdmin && !senderInfo.isPlatinum) {
      return res.status(403).json({
        message:
          "Upgrade to Platinum to send messages. Messaging is available exclusively for Platinum subscribers.",
        requiresUpgrade: true,
      });
    }

    // Contact info filtering
    const otherId =
      conversation.participantAId === userId
        ? conversation.participantBId
        : conversation.participantAId;

    let finalBody = body;
    let contactInfoStripped = false;

    // Check if both are platinum — if so, allow contact info
    const bothPlatinum = await areBothPlatinum(userId, otherId);
    if (!bothPlatinum && !isAdmin) {
      const { cleanBody, wasStripped } = stripContactInfo(body);
      finalBody = cleanBody;
      contactInfoStripped = wasStripped;
    }

    // Create message and update conversation
    const isA = conversation.participantAId === userId;

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId: userId,
          body: finalBody,
          contactInfoStripped,
        },
        include: {
          sender: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageText:
            finalBody.length > 100
              ? finalBody.substring(0, 100) + "..."
              : finalBody,
          lastMessageAt: new Date(),
          // Increment unread for the OTHER participant
          ...(isA
            ? { unreadCountB: { increment: 1 } }
            : { unreadCountA: { increment: 1 } }),
        },
      }),
    ]);

    // Emit via socket.io if available
    if (req.io) {
      req.io.to(`user:${otherId}`).emit("new_message", {
        conversationId,
        message,
      });
    }

    return res.status(201).json({
      result: message,
      contactInfoStripped,
      ...(contactInfoStripped && {
        warning:
          "Contact information (email/phone) was removed from your message. Contact sharing is only allowed when both parties have Platinum subscriptions.",
      }),
    });
  } catch (error) {
    console.error("sendMessage error:", error);
    return res.status(500).json({ message: "Failed to send message" });
  }
}

/**
 * POST /messaging/conversations
 * Start a new conversation (recruiters and admins only)
 * Body: { recipientId, body, jobId? }
 */
async function startConversation(req, res) {
  try {
    const userId = req.user.userId;
    const { recipientId, body, jobId } = req.body;

    if (!recipientId) {
      return res.status(400).json({ message: "recipientId is required" });
    }
    if (!body || !body.trim()) {
      return res.status(400).json({ message: "Message body is required" });
    }

    // Get sender info
    const senderInfo = await getUserRoleAndSubscription(userId);
    if (!senderInfo) {
      return res.status(404).json({ message: "User not found" });
    }

    const isRecruiter = senderInfo.roles.includes("RECRUITER");
    const isAdmin = senderInfo.roles.includes("ADMIN");
    const isJobSeeker =
      senderInfo.roles.includes("JOB_SEEKER") && !isAdmin && !isRecruiter;

    // Job seekers CANNOT initiate conversations
    if (isJobSeeker) {
      return res.status(403).json({
        message:
          "Job seekers cannot initiate conversations. You can only respond when contacted by a recruiter or admin.",
        requiresUpgrade: false,
      });
    }

    // Recruiters must have Platinum to message
    if (isRecruiter && !isAdmin && !senderInfo.isPlatinum) {
      return res.status(403).json({
        message:
          "Upgrade to Platinum to send messages. Messaging is available exclusively for Platinum subscribers.",
        requiresUpgrade: true,
      });
    }

    // Verify recipient exists
    const recipientInfo = await getUserRoleAndSubscription(recipientId);
    if (!recipientInfo) {
      return res.status(404).json({ message: "Recipient not found" });
    }

    // Recruiters can only message job seekers
    if (isRecruiter && !isAdmin) {
      const recipientIsJobSeeker = recipientInfo.roles.includes("JOB_SEEKER");
      if (!recipientIsJobSeeker) {
        return res
          .status(403)
          .json({ message: "Recruiters can only message job seekers" });
      }
    }

    // Find or create conversation
    const conversation = await findOrCreateConversation(
      userId,
      recipientId,
      jobId
    );

    // Contact info filtering
    let finalBody = body;
    let contactInfoStripped = false;

    const bothPlatinum = await areBothPlatinum(userId, recipientId);
    if (!bothPlatinum && !isAdmin) {
      const { cleanBody, wasStripped } = stripContactInfo(body);
      finalBody = cleanBody;
      contactInfoStripped = wasStripped;
    }

    // Determine which participant is sender
    const isA = conversation.participantAId === userId;

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          body: finalBody,
          contactInfoStripped,
        },
        include: {
          sender: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageText:
            finalBody.length > 100
              ? finalBody.substring(0, 100) + "..."
              : finalBody,
          lastMessageAt: new Date(),
          ...(isA
            ? { unreadCountB: { increment: 1 } }
            : { unreadCountA: { increment: 1 } }),
        },
      }),
    ]);

    // Emit via socket.io if available
    if (req.io) {
      req.io.to(`user:${recipientId}`).emit("new_message", {
        conversationId: conversation.id,
        message,
      });
      req.io.to(`user:${recipientId}`).emit("new_conversation", {
        conversationId: conversation.id,
      });
    }

    return res.status(201).json({
      result: { conversation: { id: conversation.id }, message },
      contactInfoStripped,
      ...(contactInfoStripped && {
        warning:
          "Contact information (email/phone) was removed from your message. Contact sharing is only allowed when both parties have Platinum subscriptions.",
      }),
    });
  } catch (error) {
    console.error("startConversation error:", error);
    return res.status(500).json({ message: "Failed to start conversation" });
  }
}

/**
 * GET /messaging/unread-count
 * Get total unread message count for the authenticated user
 */
async function getUnreadCount(req, res) {
  try {
    const userId = req.user.userId;

    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ participantAId: userId }, { participantBId: userId }],
      },
      select: {
        participantAId: true,
        participantBId: true,
        unreadCountA: true,
        unreadCountB: true,
      },
    });

    const totalUnread = conversations.reduce((sum, conv) => {
      const isA = conv.participantAId === userId;
      return sum + (isA ? conv.unreadCountA : conv.unreadCountB);
    }, 0);

    return res.json({ result: { unreadCount: totalUnread } });
  } catch (error) {
    console.error("getUnreadCount error:", error);
    return res.status(500).json({ message: "Failed to get unread count" });
  }
}

/**
 * POST /messaging/conversations/:conversationId/read
 * Mark all messages in a conversation as read
 */
async function markAsRead(req, res) {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (
      conversation.participantAId !== userId &&
      conversation.participantBId !== userId
    ) {
      return res.status(403).json({ message: "Not a participant" });
    }

    const isA = conversation.participantAId === userId;

    await prisma.$transaction([
      prisma.message.updateMany({
        where: {
          conversationId,
          senderId: { not: userId },
          isRead: false,
        },
        data: { isRead: true },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: isA ? { unreadCountA: 0 } : { unreadCountB: 0 },
      }),
    ]);

    return res.json({ message: "Marked as read" });
  } catch (error) {
    console.error("markAsRead error:", error);
    return res.status(500).json({ message: "Failed to mark as read" });
  }
}

/**
 * GET /messaging/searchable-users
 * Search for users that can be messaged (for starting new conversations)
 * Admins: can search all users; Recruiters: can search job seekers only
 */
async function searchUsers(req, res) {
  try {
    const userId = req.user.userId;
    const { q = "", role: filterRole } = req.query;

    const senderInfo = await getUserRoleAndSubscription(userId);
    if (!senderInfo) {
      return res.status(404).json({ message: "User not found" });
    }

    const isAdmin = senderInfo.roles.includes("ADMIN");
    const isRecruiter = senderInfo.roles.includes("RECRUITER");

    // Job seekers cannot search for users to message
    if (!isAdmin && !isRecruiter) {
      return res.status(403).json({ message: "Not allowed" });
    }

    const where = {
      id: { not: userId },
      isActive: true,
    };

    // Search by name or email
    if (q.trim()) {
      where.OR = [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    // Role filter: Recruiters can only message job seekers
    if (isRecruiter && !isAdmin) {
      where.roles = { some: { role: "JOB_SEEKER", isActive: true } };
    } else if (filterRole) {
      where.roles = { some: { role: filterRole, isActive: true } };
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        roles: { where: { isActive: true }, select: { role: true } },
      },
      take: 20,
      orderBy: { firstName: "asc" },
    });

    const result = users.map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      role: u.roles[0]?.role || "UNKNOWN",
    }));

    return res.json({ result });
  } catch (error) {
    console.error("searchUsers error:", error);
    return res.status(500).json({ message: "Failed to search users" });
  }
}

/**
 * GET /messaging/contacts
 * Admin: returns all job seekers + recruiters (paginated, searchable)
 * Recruiter: returns job applicants who applied to their posted jobs
 */
async function getContacts(req, res) {
  try {
    const userId = req.user.userId;
    const { q = "", role: filterRole, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const senderInfo = await getUserRoleAndSubscription(userId);
    if (!senderInfo) {
      return res.status(404).json({ message: "User not found" });
    }

    const isAdmin = senderInfo.roles.includes("ADMIN");
    const isRecruiter = senderInfo.roles.includes("RECRUITER");

    if (!isAdmin && !isRecruiter) {
      return res.status(403).json({ message: "Not allowed" });
    }

    if (isAdmin) {
      // Admin: list all job seekers and recruiters
      const where = {
        id: { not: userId },
        isActive: true,
      };

      // Role filter
      if (filterRole) {
        where.roles = { some: { role: filterRole, isActive: true } };
      } else {
        where.roles = {
          some: { role: { in: ["JOB_SEEKER", "RECRUITER"] }, isActive: true },
        };
      }

      // Search
      if (q.trim()) {
        where.OR = [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ];
      }

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            roles: { where: { isActive: true }, select: { role: true } },
          },
          skip,
          take,
          orderBy: { firstName: "asc" },
        }),
        prisma.user.count({ where }),
      ]);

      const result = users.map((u) => ({
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.roles[0]?.role || "UNKNOWN",
      }));

      return res.json({
        result,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / take),
      });
    }

    // Recruiter: list applicants from their posted jobs
    const recruiterProfile = await prisma.recruiterProfile.findUnique({
      where: { userId },
    });

    if (!recruiterProfile) {
      return res.json({ result: [], total: 0, page: 1, totalPages: 0 });
    }

    // Query applications directly via job->recruiterProfile relationship
    const appWhere = {
      job: { recruiterProfileId: recruiterProfile.id },
    };

    // Search by applicant name/email or job title
    if (q.trim()) {
      appWhere.OR = [
        {
          jobSeeker: {
            user: {
              OR: [
                { firstName: { contains: q, mode: "insensitive" } },
                { lastName: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            },
          },
        },
        { job: { title: { contains: q, mode: "insensitive" } } },
      ];
    }

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where: appWhere,
        select: {
          id: true,
          jobId: true,
          job: { select: { id: true, title: true } },
          jobSeeker: {
            select: {
              userId: true,
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
            },
          },
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.jobApplication.count({ where: appWhere }),
    ]);

    // Deduplicate by user (a user may apply to multiple jobs)
    const seenUsers = new Set();
    const result = [];
    for (const app of applications) {
      const u = app.jobSeeker.user;
      const key = u.id;
      if (!seenUsers.has(key)) {
        seenUsers.add(key);
        result.push({
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          role: "JOB_SEEKER",
          jobTitle: app.job.title,
          jobId: app.job.id,
          applicationStatus: app.status,
        });
      }
    }

    return res.json({
      result,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / take),
    });
  } catch (error) {
    console.error("getContacts error:", error);
    return res.status(500).json({ message: "Failed to load contacts" });
  }
}

/**
 * GET /messaging/recruiter-jobs
 * Returns the recruiter's posted jobs with applicant counts
 */
async function getRecruiterJobs(req, res) {
  try {
    const userId = req.user.userId;
    const { q = "" } = req.query;

    const recruiterProfile = await prisma.recruiterProfile.findUnique({
      where: { userId },
    });

    if (!recruiterProfile) {
      return res.json({ result: [] });
    }

    const where = {
      recruiterProfileId: recruiterProfile.id,
      jobApplications: { some: {} }, // Only jobs with at least 1 applicant
    };
    if (q.trim()) {
      where.title = { contains: q, mode: "insensitive" };
    }

    const jobs = await prisma.job.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        _count: { select: { jobApplications: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const result = jobs.map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      applicantCount: j._count.jobApplications,
      createdAt: j.createdAt,
    }));

    return res.json({ result });
  } catch (error) {
    console.error("getRecruiterJobs error:", error);
    return res.status(500).json({ message: "Failed to load jobs" });
  }
}

/**
 * GET /messaging/job-applicants/:jobId
 * Returns applicants for a specific job (for recruiter)
 */
async function getJobApplicants(req, res) {
  try {
    const userId = req.user.userId;
    const { jobId } = req.params;
    const { q = "" } = req.query;

    const recruiterProfile = await prisma.recruiterProfile.findUnique({
      where: { userId },
    });

    if (!recruiterProfile) {
      return res.status(403).json({ message: "Not a recruiter" });
    }

    // Verify job belongs to this recruiter
    const job = await prisma.job.findFirst({
      where: { id: jobId, recruiterProfileId: recruiterProfile.id },
    });

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const appWhere = { jobId };
    if (q.trim()) {
      appWhere.jobSeeker = {
        user: {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        },
      };
    }

    const applications = await prisma.jobApplication.findMany({
      where: appWhere,
      select: {
        id: true,
        status: true,
        createdAt: true,
        jobSeeker: {
          select: {
            userId: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const result = applications.map((app) => ({
      id: app.jobSeeker.user.id,
      firstName: app.jobSeeker.user.firstName,
      lastName: app.jobSeeker.user.lastName,
      email: app.jobSeeker.user.email,
      role: "JOB_SEEKER",
      applicationStatus: app.status,
      appliedAt: app.createdAt,
    }));

    return res.json({ result });
  } catch (error) {
    console.error("getJobApplicants error:", error);
    return res.status(500).json({ message: "Failed to load applicants" });
  }
}

/**
 * POST /messaging/diamond-inquiry
 * Any authenticated user can initiate a Diamond pricing inquiry with admin.
 * Bypasses normal restrictions (job seekers can't initiate, subscription checks).
 */
async function diamondInquiry(req, res) {
  try {
    const userId = req.user.userId;

    // Limit: only 1 diamond inquiry per account
    const existingInquiry = await prisma.message.findFirst({
      where: {
        senderId: userId,
        body: { contains: "Diamond price" },
      },
      select: { id: true },
    });

    if (existingInquiry) {
      return res.status(429).json({ message: "You have already sent a Diamond pricing inquiry. An admin will respond shortly." });
    }

    // Find admin user
    const adminUser = await prisma.user.findFirst({
      where: { roles: { some: { role: "ADMIN", isActive: true } } },
      select: { id: true },
    });

    if (!adminUser) {
      return res.status(500).json({ message: "No admin available to handle your inquiry" });
    }

    if (adminUser.id === userId) {
      return res.status(400).json({ message: "Admin cannot send inquiry to self" });
    }

    // Find or create conversation
    const conversation = await findOrCreateConversation(userId, adminUser.id);

    const messageBody = "What's The Diamond price please send me a quotation and a payment link";

    // Determine which participant is sender
    const isA = conversation.participantAId === userId;

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          body: messageBody,
          contactInfoStripped: false,
        },
        include: {
          sender: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageText: messageBody,
          lastMessageAt: new Date(),
          ...(isA
            ? { unreadCountB: { increment: 1 } }
            : { unreadCountA: { increment: 1 } }),
        },
      }),
    ]);

    // Emit via socket.io if available
    if (req.io) {
      req.io.to(`user:${adminUser.id}`).emit("new_message", {
        conversationId: conversation.id,
        message,
      });
      req.io.to(`user:${adminUser.id}`).emit("new_conversation", {
        conversationId: conversation.id,
      });
    }

    return res.status(201).json({
      message: "Diamond inquiry sent to admin",
      result: { conversationId: conversation.id },
    });
  } catch (error) {
    console.error("diamondInquiry error:", error);
    return res.status(500).json({ message: "Failed to send Diamond inquiry" });
  }
}

module.exports = {
  getConversations,
  getMessages,
  sendMessage,
  startConversation,
  getUnreadCount,
  markAsRead,
  searchUsers,
  getContacts,
  getRecruiterJobs,
  getJobApplicants,
  diamondInquiry,
};
