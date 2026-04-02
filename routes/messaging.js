const express = require("express");
const { body } = require("express-validator");
const validateRequest = require("../middlewares/validateMiddleware");
const { authenticate } = require("../middlewares/authorizationMiddleware");
const {
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
} = require("../controllers/messaging/messagingController");

const Router = express.Router();

// All messaging routes require authentication
Router.use(authenticate);

// List conversations
Router.get("/conversations", getConversations);

// Get unread count
Router.get("/unread-count", getUnreadCount);

// Search users to message
Router.get("/searchable-users", searchUsers);

// Get contacts list (admin: all users, recruiter: job applicants)
Router.get("/contacts", getContacts);

// Get recruiter's jobs with applicant counts
Router.get("/recruiter-jobs", getRecruiterJobs);

// Get applicants for a specific job
Router.get("/job-applicants/:jobId", getJobApplicants);

// Diamond pricing inquiry (any user can initiate)
Router.post("/diamond-inquiry", diamondInquiry);

// Start a new conversation
Router.post(
  "/conversations",
  [
    body("recipientId").isUUID().withMessage("Valid recipientId is required"),
    body("body").trim().notEmpty().withMessage("Message body is required"),
    body("jobId").optional().isUUID().withMessage("jobId must be a valid UUID"),
  ],
  validateRequest,
  startConversation
);

// Get messages in a conversation
Router.get("/conversations/:conversationId/messages", getMessages);

// Send a message in a conversation
Router.post(
  "/conversations/:conversationId/messages",
  [body("body").trim().notEmpty().withMessage("Message body is required")],
  validateRequest,
  sendMessage
);

// Mark conversation as read
Router.post("/conversations/:conversationId/read", markAsRead);

module.exports = Router;
