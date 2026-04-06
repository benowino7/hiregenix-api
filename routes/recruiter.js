const express = require("express");
const { check, query, body, validationResult } = require("express-validator");
const validateRequest = require("../middlewares/validateMiddleware");
const { authenticate, recruiterOnly } = require("../middlewares/authorizationMiddleware");
const { requireActiveRecruiterSubscription, enforceActiveJobsLimit, requireRecruiterFeature } = require("../middlewares/subscriptionMiddleware");
const Router = express.Router();

// Company
const { onboardRecruiterCompany, getRecruiterDetails, addCompanyIndustry } = require("../controllers/recruiter/recruiterCompany");
Router.post(
	"/company",
	authenticate,
	recruiterOnly,
	[
		body("companyName").trim().notEmpty().withMessage("Company name is required"),

		body("registrationNumber").trim().notEmpty().withMessage("Registration number is required"),

		body("industries").isArray({ min: 1 }).withMessage("Industries must be a non-empty array"),

		body("industries.*").isUUID().withMessage("Each industry must be a valid ID"),

		body("address").optional().isString().bail().notEmpty().withMessage("Address cannot be empty"),

		body("country").optional().isString().bail().notEmpty().withMessage("Country cannot be empty"),

		body("website")
			.optional()
			.notEmpty()
			.withMessage("Website cannot be empty")
			.bail()
			.isURL({ require_protocol: true })
			.withMessage("Website must be a valid URL"),
	],
	validateRequest,
	onboardRecruiterCompany,
);
Router.post("/company/industry", authenticate, recruiterOnly, requireActiveRecruiterSubscription, addCompanyIndustry);
Router.get("/details", authenticate, recruiterOnly, getRecruiterDetails); // keep open — needed to check onboarding before subscription

// dashboard (subscription-gated)
const { getRecruiterDashboard } = require("../controllers/recruiter/dashboard")
Router.get("/dashboard", authenticate, recruiterOnly, requireActiveRecruiterSubscription, getRecruiterDashboard)

// Job vacancy
const { createDraftJob, updateDraftJob, publishJob, suspendJob, unsuspendJob, getAllJobs, bulkCreateJobs } = require("../controllers/recruiter/jobVacancies");
Router.post(
	"/job",
	authenticate,
	recruiterOnly,
	requireActiveRecruiterSubscription,
	enforceActiveJobsLimit,
	[
		body("title").trim().notEmpty().withMessage("Job title is required").bail(),

		body("description").trim().notEmpty().withMessage("Job description is required").bail(),

		body("vacancies").optional().isInt({ min: 1 }).withMessage("Vacancies must be a number greater than 0"),

		body("employmentType")
			.notEmpty()
			.withMessage("Employment type is required")
			.bail()
			.isIn(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"])
			.withMessage("Invalid employment type"),

		body("experienceLevel").optional().trim().notEmpty().withMessage("Experience level cannot be empty"),

		body("isRemote").optional().isBoolean().withMessage("isRemote must be a boolean"),

		// Location required ONLY if not remote
		body("locationName").if(body("isRemote").equals("false")).trim().notEmpty().withMessage("Job location is required for non-remote jobs"),

		body("latitude").if(body("isRemote").equals("false")).isFloat({ min: -90, max: 90 }).withMessage("Latitude must be between -90 and 90"),

		body("longitude").if(body("isRemote").equals("false")).isFloat({ min: -180, max: 180 }).withMessage("Longitude must be between -180 and 180"),

		body("minSalary").optional().isInt({ min: 0 }).withMessage("Minimum salary must be a positive number"),

		body("maxSalary").optional().isInt({ min: 0 }).withMessage("Maximum salary must be a positive number"),

		body("currency").optional().trim().isLength({ min: 3, max: 3 }).withMessage("Currency must be a 3-letter code"),

		body("showSalary").optional().isBoolean().withMessage("showSalary must be a boolean"),

		body("industries").isArray({ min: 1 }).withMessage("At least one industry is required"),

		body("industries.*").isUUID().withMessage("Each industry must be a valid UUID"),

		body("skills").isArray({ min: 1 }).withMessage("At least one skill is required"),

		body("skills.*").isUUID().withMessage("Each skill must be a valid UUID"),
	],
	validateRequest,
	createDraftJob,
);

// Bulk job creation
Router.post(
	"/jobs/bulk",
	authenticate,
	recruiterOnly,
	requireActiveRecruiterSubscription,
	requireRecruiterFeature("access", "bulkUpload"),
	[
		body("jobs").isArray({ min: 1 }).withMessage("jobs must be a non-empty array"),
		body("jobs.*.title").trim().notEmpty().withMessage("Each job must have a title"),
		body("jobs.*.description").trim().notEmpty().withMessage("Each job must have a description"),
		body("jobs.*.employmentType")
			.optional()
			.isIn(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"])
			.withMessage("Invalid employment type"),
	],
	validateRequest,
	bulkCreateJobs,
);

Router.patch(
	"/job/:id",
	authenticate,
	recruiterOnly,
	requireActiveRecruiterSubscription,
	[
		body("title").optional().notEmpty().withMessage("Job title cannot be empty").bail(),

		body("description").optional().trim().notEmpty().withMessage("Job description cannot be empty").bail(),

		body("vacancies").optional().isInt({ min: 1 }).withMessage("Vacancies must be a number greater than 0"),

		body("employmentType")
			.optional()
			.notEmpty()
			.withMessage("Employment type cannot be empty")
			.bail()
			.isIn(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP", "TEMPORARY"])
			.withMessage("Invalid employment type"),

		body("experienceLevel").optional().trim().notEmpty().withMessage("Experience level cannot be empty"),

		body("isRemote").optional().isBoolean().withMessage("isRemote must be a boolean"),

		// Location required ONLY if not remote
		body("locationName").if(body("isRemote").equals("false")).trim().notEmpty().withMessage("Job location is required for non-remote jobs"),

		body("latitude").if(body("isRemote").equals("false")).isFloat({ min: -90, max: 90 }).withMessage("Latitude must be between -90 and 90"),

		body("longitude").if(body("isRemote").equals("false")).isFloat({ min: -180, max: 180 }).withMessage("Longitude must be between -180 and 180"),

		body("minSalary").optional().isInt({ min: 0 }).withMessage("Minimum salary must be a positive number"),

		body("maxSalary").optional().isInt({ min: 0 }).withMessage("Maximum salary must be a positive number"),

		body("currency").optional().trim().isLength({ min: 3, max: 3 }).withMessage("Currency must be a 3-letter code"),

		body("showSalary").optional().isBoolean().withMessage("showSalary must be a boolean"),

		body("industries").optional().isArray({ min: 1 }).withMessage("At least one industry is required"),

		body("industries.*").optional().isUUID().withMessage("Each industry must be a valid UUID"),

		body("skills").optional().isArray({ min: 1 }).withMessage("At least one skill is required"),

		body("skills.*").optional().isUUID().withMessage("Each skill must be a valid UUID"),
	],
	validateRequest,
	updateDraftJob,
);

Router.post("/job/:id/publish", authenticate, recruiterOnly, requireActiveRecruiterSubscription, enforceActiveJobsLimit, publishJob);
Router.patch("/job/:id/suspend", authenticate, recruiterOnly, requireActiveRecruiterSubscription, suspendJob);
Router.patch("/job/:id/unsuspend", authenticate, recruiterOnly, requireActiveRecruiterSubscription, enforceActiveJobsLimit, unsuspendJob);
Router.get("/jobs", authenticate, recruiterOnly, requireActiveRecruiterSubscription, getAllJobs);

// Job applications
const { getJobApplications, updateApplicationStatusByRecruiter, serveJobSeekerCv } = require("../controllers/recruiter/jobApplications");
Router.get("/jobs/:jobId/applications", authenticate, recruiterOnly, requireActiveRecruiterSubscription, getJobApplications);
Router.get("/jobs/:jobApplicationId/application/cv", authenticate, recruiterOnly, requireActiveRecruiterSubscription, serveJobSeekerCv);
Router.patch("/jobs/:jobApplicationId/status", authenticate, recruiterOnly, requireActiveRecruiterSubscription, updateApplicationStatusByRecruiter);

// suggest job seekers
const { suggestJobSeekers } = require("../controllers/jobSeeker/suggestJobs");
// recruiter routes
Router.get("/jobs/:jobId/suggested-job-seekers", authenticate, recruiterOnly, requireActiveRecruiterSubscription, requireRecruiterFeature("access", "candidateSuggestions"), suggestJobSeekers);

// AI Rankings & Screening
const { getAIRankings, getApplicationAIAnalysis, triggerAIScreen } = require("../controllers/recruiter/aiRankings");
Router.get("/jobs/:jobId/ai-rankings", authenticate, recruiterOnly, requireActiveRecruiterSubscription, requireRecruiterFeature("ai", "rankings"), getAIRankings);
Router.get("/jobs/:jobId/ai-rankings/:applicationId", authenticate, recruiterOnly, requireActiveRecruiterSubscription, requireRecruiterFeature("ai", "analysis"), getApplicationAIAnalysis);
Router.post("/jobs/:jobId/ai-screen", authenticate, recruiterOnly, requireActiveRecruiterSubscription, requireRecruiterFeature("ai", "screening"), triggerAIScreen);

// AI Job Parser (PDF/DOCX upload → structured job data)
const multer = require("multer");
const jdUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
	fileFilter: (req, file, cb) => {
		const allowed = [
			"application/pdf",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		];
		if (allowed.includes(file.mimetype) || file.originalname.match(/\.(pdf|docx)$/i)) {
			cb(null, true);
		} else {
			cb(new Error("Only PDF and DOCX files are supported"));
		}
	},
});
const { parseJobFiles, publishParsedJobs } = require("../controllers/recruiter/aiJobParser");
Router.post("/ai-jobs/parse", authenticate, recruiterOnly, requireActiveRecruiterSubscription, requireRecruiterFeature("ai", "rankings"), jdUpload.array("files", 20), parseJobFiles);
Router.post("/ai-jobs/publish", authenticate, recruiterOnly, requireActiveRecruiterSubscription, requireRecruiterFeature("ai", "rankings"), publishParsedJobs);

// CV PDF Generation
const { generateRecruiterCvPdf } = require("../controllers/jobSeeker/cvPdfGenerator");
Router.post("/cv/generate-pdf", authenticate, recruiterOnly, requireActiveRecruiterSubscription, generateRecruiterCvPdf);

// Subscriptions
const {
	chooseRecruiterSubscription,
	getRecruiterLatestSubscription,
	getRecruiterUpgradeQuote,
	getRecruiterInvoices,
	getRecruiterInvoiceById,
} = require("../controllers/subscriptions/recruiterSubscriptions");

Router.post(
	"/subscriptions",
	authenticate,
	recruiterOnly,
	[
		body("planId").notEmpty().withMessage("planId is required"),
		body("paymentMethod").optional().isIn(["CARD", "GPAY_APAY"]).withMessage("Invalid payment method"),
		body("currency").optional().isString().withMessage("Currency must be a string"),
		body("customer").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("customer details are required for GPAY/APAY"),
		body("billingAddress").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("billingAddress is required for GPAY/APAY"),
		body("customer.firstName").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("firstName is required"),
		body("customer.lastName").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("lastName is required"),
		body("customer.email").if(body("paymentMethod").equals("GPAY_APAY")).isEmail().withMessage("Valid email is required"),
		body("customer.phone").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("phone is required"),
		body("billingAddress.address1").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("address1 is required"),
		body("billingAddress.administrativeArea").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("administrativeArea is required"),
		body("billingAddress.country").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("country is required"),
		body("billingAddress.locality").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("locality is required"),
		body("billingAddress.postalCode").if(body("paymentMethod").equals("GPAY_APAY")).notEmpty().withMessage("postalCode is required"),
	],
	validateRequest,
	chooseRecruiterSubscription,
);
Router.get("/subscriptions/latest", authenticate, recruiterOnly, getRecruiterLatestSubscription);

// PayPal payment initiation
const { initiatePaypalPayment, cancelPaypalPayment, cancelSubscription, getCancellationInfo } = require("../payments/paypal/initiatePaypal");
Router.post("/subscriptions/paypal", authenticate, recruiterOnly, initiatePaypalPayment);
Router.post("/subscriptions/paypal/cancel", authenticate, recruiterOnly, cancelPaypalPayment);
Router.post("/subscriptions/cancel", authenticate, recruiterOnly, cancelSubscription);
Router.get("/subscriptions/cancellation-info", authenticate, recruiterOnly, getCancellationInfo);
Router.get("/subscriptions/upgrade-quote", authenticate, recruiterOnly, getRecruiterUpgradeQuote);
Router.get("/subscriptions/invoices", authenticate, recruiterOnly, getRecruiterInvoices);
Router.get("/subscriptions/invoices/:invoiceId", authenticate, recruiterOnly, getRecruiterInvoiceById);

// Testimonial (subscription-gated)
const { getMyTestimonial, upsertTestimonial } = require("../controllers/testimonial");
Router.get("/testimonial", authenticate, recruiterOnly, requireActiveRecruiterSubscription, getMyTestimonial);
Router.post("/testimonial", authenticate, recruiterOnly, requireActiveRecruiterSubscription, upsertTestimonial);

module.exports = Router;
