const express = require("express");
const { check, query, body, validationResult } = require("express-validator");
const validateRequest = require("../middlewares/validateMiddleware");
const Router = express.Router();
const { authenticate } = require("../middlewares/authorizationMiddleware");
const { requireActiveJobSeekerSubscription, enforceSavedJobsLimit } = require("../middlewares/subscriptionMiddleware");
const upload = require("../middlewares/uploadCvMiddleware");

// Profile (subscription-gated)
const { createJobSeekerProfile, getJobSeekerProfile, uploadCV, getCVs, serveCV, updateCV, deleteCV } = require("../controllers/jobSeeker/profile");
const { updateJobSeekerProfile, addWorkExperience, addEducation, addCertification } = require("../controllers/jobSeeker/profileManagement");
Router.get("/profile", authenticate, requireActiveJobSeekerSubscription, getJobSeekerProfile);
Router.post("/profile", authenticate, requireActiveJobSeekerSubscription, createJobSeekerProfile);
Router.put("/profile", authenticate, requireActiveJobSeekerSubscription, [
	body("firstName").optional().notEmpty().withMessage("First name cannot be empty"),
	body("lastName").optional().notEmpty().withMessage("Last name cannot be empty"),
	body("middleName").optional(),
	body("phoneNumber").optional().notEmpty().isNumeric().withMessage("Phone number must contain only digits"),
	body("countryCode").optional().matches(/^\+\d{1,4}$/).withMessage("Country code must be in E.164 format"),
	body("summary").optional().isString().withMessage("Summary must be a string"),
	body("languages").optional().isArray().withMessage("Languages must be an array"),
	body("awards").optional().isArray().withMessage("Awards must be an array"),
	body("interests").optional().isArray().withMessage("Interests must be an array"),
], validateRequest, updateJobSeekerProfile);
Router.post("/profile/experience", authenticate, requireActiveJobSeekerSubscription, [
	body("jobTitle").notEmpty().withMessage("Job title is required"),
	body("companyName").notEmpty().withMessage("Company name is required"),
	body("startDate").notEmpty().withMessage("Start date is required"),
	body("endDate").optional(),
	body("isCurrent").optional().isBoolean().withMessage("isCurrent must be a boolean"),
	body("location").optional(),
	body("description").optional(),
], validateRequest, addWorkExperience);
Router.post("/profile/education", authenticate, requireActiveJobSeekerSubscription, [
	body("institution").notEmpty().withMessage("Institution is required"),
	body("degree").notEmpty().withMessage("Degree is required"),
	body("startDate").notEmpty().withMessage("Start date is required"),
	body("fieldOfStudy").optional(),
	body("endDate").optional(),
	body("isCurrent").optional().isBoolean().withMessage("isCurrent must be a boolean"),
	body("grade").optional(),
	body("description").optional(),
], validateRequest, addEducation);
Router.post("/profile/certifications", authenticate, requireActiveJobSeekerSubscription, [
	body("name").notEmpty().withMessage("Certification name is required"),
	body("issuingOrganization").notEmpty().withMessage("Issuing organization is required"),
	body("issueDate").optional(),
	body("expiryDate").optional(),
	body("credentialId").optional(),
	body("credentialUrl").optional().isURL().withMessage("Credential URL must be a valid URL"),
	body("description").optional(),
], validateRequest, addCertification);
Router.post("/cv", authenticate, requireActiveJobSeekerSubscription, upload.single("file"), uploadCV);
Router.get("/cvs", authenticate, requireActiveJobSeekerSubscription, getCVs);
Router.patch("/cvs/:id", authenticate, requireActiveJobSeekerSubscription, upload.single("file"), updateCV);
Router.delete("/cvs/:id", authenticate, requireActiveJobSeekerSubscription, deleteCV);
Router.get("/cvs/:id/file", authenticate, requireActiveJobSeekerSubscription, serveCV);

// dashboard (subscription-gated)
const { getJobSeekerDashboard } = require('../controllers/jobSeeker/dashbaord')
Router.get("/dashboard", authenticate, requireActiveJobSeekerSubscription, getJobSeekerDashboard)

// skills (subscription-gated)
const { createJobSeekerSkill, getJobSeekerSkills, updateJobSeekerSkill, deleteJobSeekerSkill } = require("../controllers/jobSeeker/skills");
Router.post("/skill", authenticate, requireActiveJobSeekerSubscription, createJobSeekerSkill);
Router.get("/skills", authenticate, requireActiveJobSeekerSubscription, getJobSeekerSkills);
Router.patch("/skills/:id", authenticate, requireActiveJobSeekerSubscription, updateJobSeekerSkill);
Router.delete("/skills/:id", authenticate, requireActiveJobSeekerSubscription, deleteJobSeekerSkill);

// job applications
const { applyForJob, getMyApplications, withdrawJobApplication } = require("../controllers/jobSeeker/jopApplication");
Router.post("/jobs/:jobId/apply", authenticate, requireActiveJobSeekerSubscription, applyForJob);
Router.get("/jobs/applications", authenticate, requireActiveJobSeekerSubscription, getMyApplications);
Router.patch("/jobs/:jobApplicationId/withdraw", authenticate, requireActiveJobSeekerSubscription, withdrawJobApplication);

// Suggest jobs
const { suggestJobsForJobSeeker } = require("../controllers/jobSeeker/suggestJobs");
Router.get("/jobs/suggestions", authenticate, requireActiveJobSeekerSubscription, suggestJobsForJobSeeker);

// Jobs
const { saveJob, getSavedJobs, unsaveJob } = require("../controllers/jobSeeker/jobs");
Router.post("/jobs/:jobId/save", authenticate, requireActiveJobSeekerSubscription, enforceSavedJobsLimit, saveJob);
Router.get("/jobs/saved-jobs", authenticate, requireActiveJobSeekerSubscription, getSavedJobs);
Router.delete("/jobs/:jobId/save", authenticate, requireActiveJobSeekerSubscription, unsaveJob);

// subscriptions
const {
	chooseJobSeekerSubscription,
	getMyLatestSubscription,
	getMyInvoices,
	getInvoiceById,
	getUpgradeTopUpAmount,
} = require("../controllers/subscriptions/jobSeekerSubscriptions");
Router.post(
	"/subscriptions",
	authenticate,
	[
		// planId (always required)
		body("planId").notEmpty().withMessage("planId is required"),

		// paymentMethod (optional but must be valid if provided)
		body("paymentMethod").optional().isIn(["CARD", "GPAY_APAY"]).withMessage("Invalid payment method"),

		// currency (optional)
		body("currency").optional().isString().withMessage("Currency must be a string"),

		// =============================
		// CONDITIONAL VALIDATION
		// =============================

		// customer object required if GPAY_APAY
		body("customer").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("customer details are required for GPAY/APAY"),

		// billingAddress required if GPAY_APAY
		body("billingAddress").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("billingAddress is required for GPAY/APAY"),

		// =============================
		// CUSTOMER FIELDS
		// =============================

		body("customer.firstName").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("firstName is required"),

		body("customer.lastName").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("lastName is required"),

		body("customer.email").if(body("paymentMethod").equals("GPAY_APAY")).isEmail().withMessage("Valid email is required"),

		body("customer.phone").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("phone is required"),

		// =============================
		// BILLING ADDRESS FIELDS
		// =============================

		body("billingAddress.address1").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("address1 is required"),

		body("billingAddress.administrativeArea").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("administrativeArea is required"),

		body("billingAddress.country").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("country is required"),

		body("billingAddress.locality").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("locality is required"),

		body("billingAddress.postalCode").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("postalCode is required"),
	],
    validateRequest,
	chooseJobSeekerSubscription,
);
Router.get("/subscriptions/latest", authenticate, getMyLatestSubscription);

// PayPal payment initiation
const { initiatePaypalPayment, cancelPaypalPayment, cancelSubscription, getCancellationInfo } = require("../payments/paypal/initiatePaypal");
Router.post("/subscriptions/paypal", authenticate, initiatePaypalPayment);
Router.post("/subscriptions/paypal/cancel", authenticate, cancelPaypalPayment);
Router.post("/subscriptions/cancel", authenticate, cancelSubscription);
Router.get("/subscriptions/cancellation-info", authenticate, getCancellationInfo);
Router.get("/subscriptions/upgrade-quote", authenticate, getUpgradeTopUpAmount);
Router.get("/subscriptions/invoices", authenticate, getMyInvoices);
Router.get("/subscriptions/invoices/:invoiceId", authenticate, getInvoiceById);

// External Apply ($3 payment)
const { initiateExternalApply, checkExternalApplyStatus } = require("../controllers/jobSeeker/externalApply");
Router.post("/jobs/:jobId/external-apply", authenticate, requireActiveJobSeekerSubscription, initiateExternalApply);
Router.get("/jobs/:jobId/external-apply/status", authenticate, checkExternalApplyStatus);

// CV Extraction (AI-powered)
const { extractCVData, extractAndFillProfile } = require("../controllers/jobSeeker/cvExtract");
Router.post("/cv/:cvId/extract", authenticate, requireActiveJobSeekerSubscription, extractCVData);
Router.post("/cv/extract-and-fill", authenticate, requireActiveJobSeekerSubscription, extractAndFillProfile);

// CV PDF Download (subscription-gated)
const { downloadProfileAsCv, htmlToPdf } = require("../controllers/jobSeeker/cvPdfGenerator");
Router.get("/profile/download-cv", authenticate, requireActiveJobSeekerSubscription, downloadProfileAsCv);
Router.post("/cv/html-to-pdf", authenticate, requireActiveJobSeekerSubscription, htmlToPdf);

// Testimonial (subscription-gated)
const { getMyTestimonial, upsertTestimonial } = require("../controllers/testimonial");
Router.get("/testimonial", authenticate, requireActiveJobSeekerSubscription, getMyTestimonial);
Router.post("/testimonial", authenticate, requireActiveJobSeekerSubscription, upsertTestimonial);

module.exports = Router;
