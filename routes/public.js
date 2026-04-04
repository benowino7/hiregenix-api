const express = require("express");
const { check, query, body, validationResult } = require("express-validator");
const validateRequest = require("../middlewares/validateMiddleware");
const Router = express.Router();

// jobs
const { getAllJobs, getJobById } = require("../controllers/recruiter/jobVacancies");
const { aiSearchJobs } = require("../controllers/ai/aiSearch");
Router.get("/jobs/ai-search", aiSearchJobs);
Router.get("/jobs", getAllJobs);
Router.get("/jobs/:id", getJobById);

// subscriptions
const { getSubscriptions } = require("../controllers/admin/subscriptions")
const  { subscriptionGatewayCallback } = require("../payments/card/gatewayCallback")
const  { paypalWebhook } = require("../payments/paypal/paypalWebhook")
Router.get("/subscriptions", getSubscriptions)
Router.post("/gateway/callback", subscriptionGatewayCallback)
Router.post("/paypal/webhook", paypalWebhook)

// Payment status check (polled by confirmation page)
const { prisma } = require("../prisma");
Router.get("/payment-status/:reference", async (req, res) => {
	try {
		const { reference } = req.params;
		if (!reference) return res.status(400).json({ error: true, status: "UNKNOWN" });

		const invoice = await prisma.invoice.findFirst({
			where: { reference },
			select: { id: true, status: true },
		});

		if (!invoice) {
			// Try subscription reference
			const sub = await prisma.userSubscription.findFirst({
				where: { reference },
				select: { status: true },
			});
			if (sub) return res.json({ error: false, status: sub.status === "ACTIVE" ? "PAID" : sub.status });
			return res.json({ error: false, status: "PENDING" });
		}

		return res.json({ error: false, status: invoice.status }); // OPEN, PAID, VOID
	} catch (err) {
		console.error("payment-status error:", err);
		return res.status(500).json({ error: true, status: "UNKNOWN" });
	}
})

// companies
const { getCompanies, getCompanyById, getCompanyJobs } = require("../controllers/admin/users")
Router.get("/companies", getCompanies)
Router.get("/companies/:id", getCompanyById)
Router.get("/companies/:id/jobs", getCompanyJobs)

// industry taxonomy (SIC-like grouped verticals with job counts) — must be before /industries
const { getGroupedTaxonomy, getActiveGroupedTaxonomy } = require("../controllers/ai/industryTaxonomy")
Router.get("/industries/taxonomy", async (req, res) => {
	try {
		const activeOnly = req.query.active !== "false";
		const data = activeOnly ? await getActiveGroupedTaxonomy() : getGroupedTaxonomy();
		return res.status(200).json({ error: false, result: data });
	} catch (error) {
		console.error("Taxonomy error:", error);
		return res.status(500).json({ error: true, message: "Failed to fetch taxonomy" });
	}
})

// industries (public — for filter dropdowns)
const { getIndustries } = require("../controllers/admin/industry")
Router.get("/industries", getIndustries)

// testimonials
const { getPublicTestimonials } = require("../controllers/testimonial")
Router.get("/testimonials", getPublicTestimonials)

// Lead capture (landing page CV upload)
const multer = require("multer");
const leadUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only PDF, DOC, and DOCX files are allowed"));
    }
    cb(null, true);
  },
});
const { submitLeadCapture, getLeadRecommendations, checkEmail } = require("../controllers/public/leadCapture")
Router.post("/lead-capture", leadUpload.single("cv"), submitLeadCapture)
Router.get("/lead-recommendations/:leadId", getLeadRecommendations)
Router.get("/check-email", checkEmail)

module.exports = Router;
