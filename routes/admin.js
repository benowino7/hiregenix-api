const express = require("express");
const { authenticate, adminOnly } = require("../middlewares/authorizationMiddleware");
const { prisma } = require("../prisma");
const Router = express.Router();

// Protect ALL admin routes with authentication + admin role check
Router.use(authenticate, adminOnly);

// Users
const { getUsers, getUserStats, updateUser, deleteUser, approveRecruiter, rejectRecruiter, updateUserStatus, createUser } = require("../controllers/admin/users")
Router.get("/users", getUsers)
Router.get("/users/stats", getUserStats)
Router.post("/users/create", createUser)
Router.patch("/users/:id", updateUser)
Router.delete("/users/:id", deleteUser)
Router.post("/recruiter/approve", approveRecruiter)
Router.post("/recruiter/reject", rejectRecruiter)
Router.patch("/users/:id/status", updateUserStatus)

// Admin Profile
const { updateAdminProfile } = require("../controllers/admin/profile")
Router.put("/profile", updateAdminProfile)

// Stats
const { getAdminStats } = require("../controllers/admin/stats")
Router.get("/stats", getAdminStats)

// Industries
const { createIndustry, getIndustries, getIndustryById, addSkillsToIndustry, updateIndustry, deleteIndustry } = require("../controllers/admin/industry")
Router.post("/industries", createIndustry)
Router.get("/industries", getIndustries)
Router.get("/industries/:id", getIndustryById)
Router.put("/industries/:id", updateIndustry)
Router.delete("/industries/:id", deleteIndustry)
Router.post("/industries/:id/skills", addSkillsToIndustry)

// Skills
const { createSkill, getSkills, getSkillById } = require("../controllers/admin/skills")
Router.post("/skills", createSkill)
Router.get("/skills", getSkills)
Router.get("/skills/:id", getSkillById)

// Jobs
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const { getAdminJobs, getAdminJobStats, getRecruitersForFilter, getAdminJobById, updateAdminJob, deleteAdminJob, deleteAllClosedJobs, getJobApplications, createAdminJob, parseJobPdf } = require("../controllers/admin/jobs")
Router.get("/jobs", getAdminJobs)
Router.get("/jobs/stats", getAdminJobStats)
Router.get("/jobs/recruiters", getRecruitersForFilter)
Router.post("/jobs", createAdminJob)
Router.post("/jobs/parse-pdf", upload.single("file"), parseJobPdf)
Router.patch("/jobs/closed/archive", deleteAllClosedJobs)
Router.get("/jobs/:id", getAdminJobById)
Router.patch("/jobs/:id", updateAdminJob)
Router.delete("/jobs/:id", deleteAdminJob)
Router.get("/jobs/:id/applications", getJobApplications)

// CV Analysis
const { analyzeCv, getJobsForAnalysis } = require("../controllers/admin/cvAnalysis")
Router.post("/cv-analysis", upload.array("file", 10), analyzeCv)
Router.get("/cv-analysis/jobs", getJobsForAnalysis)

// Payment Links & Transactions
const { generatePaymentLink, getPaymentTransactions, getUsersForPayment } = require("../controllers/admin/paymentLinks")
Router.post("/payment-links", generatePaymentLink)
Router.get("/payment-transactions", getPaymentTransactions)
Router.get("/payment-users", getUsersForPayment)

// Payment Stats & Subscription Plans
const { getPaymentStats, getSubscriptionPlans, updateSubscriptionPlan, createSubscriptionPlan } = require("../controllers/admin/paymentStats")
Router.get("/payment-stats", getPaymentStats)
Router.get("/subscription-plans", getSubscriptionPlans)
Router.post("/subscription-plans", createSubscriptionPlan)
Router.patch("/subscription-plans/:id", updateSubscriptionPlan)

// Invoices
const { getAdminInvoices } = require("../controllers/admin/invoices")
Router.get("/invoices", getAdminInvoices)

// Testimonials
const { getAllTestimonials, updateTestimonial, deleteTestimonial } = require("../controllers/testimonial")
Router.get("/testimonials", getAllTestimonials)
Router.patch("/testimonials/:id", updateTestimonial)
Router.delete("/testimonials/:id", deleteTestimonial)

// Leads
const { getLeads, downloadLeadCv, updateLead, deleteLead } = require("../controllers/admin/leads")
Router.get("/leads", getLeads)
Router.get("/leads/:id/cv", downloadLeadCv)
Router.patch("/leads/:id", updateLead)
Router.delete("/leads/:id", deleteLead)

// Subscription Management (admin@hiregenix.ai only)
const { getUserSubscriptionInfo, changeUserSubscription } = require("../controllers/admin/subscriptionManagement")
Router.get("/subscription-management/user/:userId", getUserSubscriptionInfo)
Router.post("/subscription-management/change", changeUserSubscription)

// One-time: remap all published jobs to proper taxonomy industries
Router.post("/remap-industries", async (req, res) => {
  try {
    const { normaliseToCanonical, INDUSTRIES } = require("../controllers/ai/industryTaxonomy");

    // Load all active industries for name lookup
    const allIndustries = await prisma.industry.findMany({ where: { isActive: true } });
    const industryByName = new Map();
    for (const ind of allIndustries) {
      industryByName.set(ind.name.toLowerCase(), ind.id);
    }

    // Build a keyword-to-industry map for title matching
    // Maps each keyword to canonical label for DB lookup
    const titleKeywordMap = [];
    for (const ind of INDUSTRIES) {
      for (const kw of ind.keywords) {
        titleKeywordMap.push({ keyword: kw.toLowerCase(), label: ind.label });
      }
    }
    // Sort by keyword length descending (longer = more specific matches first)
    titleKeywordMap.sort((a, b) => b.keyword.length - a.keyword.length);

    // Helper: find industry from job title via keyword scan
    function matchTitleToIndustry(title) {
      const titleLower = ` ${title.toLowerCase()} `;
      for (const { keyword, label } of titleKeywordMap) {
        // Word-boundary check
        if (
          titleLower.includes(` ${keyword} `) ||
          titleLower.includes(`-${keyword} `) ||
          titleLower.includes(` ${keyword}-`) ||
          titleLower.includes(` ${keyword}/`) ||
          titleLower.includes(`/${keyword} `)
        ) {
          const dbId = industryByName.get(label.toLowerCase());
          if (dbId) return dbId;
        }
      }
      return null;
    }

    // Get all published jobs with their current industries
    const jobs = await prisma.job.findMany({
      where: { status: "PUBLISHED" },
      select: {
        id: true,
        title: true,
        industries: {
          select: {
            industryId: true,
            industry: { select: { id: true, name: true } },
          },
        },
      },
    });

    let remapped = 0, alreadyCorrect = 0, noMatch = 0;

    for (const job of jobs) {
      const currentIndustries = job.industries.map(ji => ji.industry);

      // Check if current industries are already in taxonomy
      let allInTaxonomy = currentIndustries.length > 0 && currentIndustries.every(ind => {
        const canonical = normaliseToCanonical(ind.name);
        return canonical && canonical.label.toLowerCase() === ind.name.toLowerCase();
      });

      if (allInTaxonomy) {
        alreadyCorrect++;
        continue;
      }

      // Strategy 1: Try to remap using current industry names
      const newIndustryIds = new Set();
      for (const ind of currentIndustries) {
        const canonical = normaliseToCanonical(ind.name);
        if (canonical) {
          const dbId = industryByName.get(canonical.label.toLowerCase());
          if (dbId) newIndustryIds.add(dbId);
        }
      }

      // Strategy 2: Try normaliseToCanonical on job title
      if (newIndustryIds.size === 0) {
        const canonical = normaliseToCanonical(job.title);
        if (canonical) {
          const dbId = industryByName.get(canonical.label.toLowerCase());
          if (dbId) newIndustryIds.add(dbId);
        }
      }

      // Strategy 3: Keyword scan on job title
      if (newIndustryIds.size === 0) {
        const dbId = matchTitleToIndustry(job.title);
        if (dbId) newIndustryIds.add(dbId);
      }

      if (newIndustryIds.size > 0) {
        await prisma.jobIndustry.deleteMany({ where: { jobId: job.id } });
        for (const indId of newIndustryIds) {
          await prisma.jobIndustry.create({
            data: { jobId: job.id, industryId: indId },
          }).catch(() => {});
        }
        remapped++;
      } else {
        noMatch++;
      }
    }

    return res.json({
      status: "SUCCESS",
      message: `Remap complete: ${remapped} remapped, ${alreadyCorrect} already correct, ${noMatch} no match found`,
      data: { total: jobs.length, remapped, alreadyCorrect, noMatch },
    });
  } catch (err) {
    console.error("[RemapIndustries] Error:", err);
    return res.status(500).json({ error: true, message: err.message });
  }
});

// One-time: ensure every industry has at least 3 skills
Router.post("/populate-industry-skills", async (req, res) => {
  try {
    // Comprehensive mapping of industry labels to relevant skill names
    const INDUSTRY_SKILLS = {
      // Banking & Financial Services
      "Retail Banking": ["Financial Analysis", "Customer Relationship Management", "Risk Assessment", "Credit Analysis", "Banking Operations"],
      "Corporate & Investment Banking": ["Financial Modeling", "Valuation", "M&A Advisory", "Capital Markets", "Due Diligence"],
      "Derivatives & Treasury": ["Derivatives Pricing", "Treasury Management", "Risk Management", "Financial Instruments", "ISDA Documentation"],
      "Asset & Wealth Management": ["Portfolio Management", "Investment Analysis", "Wealth Planning", "Asset Allocation", "Client Advisory"],
      "Islamic Finance": ["Shariah Compliance", "Islamic Banking", "Sukuk Structuring", "Financial Analysis", "Regulatory Compliance"],
      "Private Equity & Venture Capital": ["Due Diligence", "Financial Modeling", "Deal Sourcing", "Portfolio Management", "Valuation"],
      "Risk & Compliance": ["Risk Management", "Regulatory Compliance", "AML/KYC", "Internal Audit", "Policy Development"],
      "FinTech": ["Digital Payments", "Blockchain", "API Integration", "Product Management", "Software Development"],
      "Insurance": ["Underwriting", "Actuarial Analysis", "Claims Management", "Risk Assessment", "Policy Administration"],
      "Accounting & Audit": ["Financial Reporting", "Auditing", "Tax Planning", "IFRS", "Bookkeeping"],

      // Legal & Compliance
      "Banking & Finance Law": ["Legal Drafting", "Financial Regulation", "Contract Negotiation", "Compliance Advisory", "Due Diligence"],
      "Corporate & Commercial Law": ["Corporate Governance", "Contract Law", "M&A Legal", "Commercial Agreements", "Legal Research"],
      "Litigation & Dispute Resolution": ["Litigation Strategy", "Arbitration", "Legal Research", "Court Procedures", "Mediation"],
      "Real Estate Law": ["Property Law", "Conveyancing", "Land Registration", "Real Estate Contracts", "Zoning Regulations"],
      "Employment & Labour Law": ["Employment Law", "HR Compliance", "Dispute Resolution", "Labor Relations", "Policy Drafting"],
      "Intellectual Property": ["Patent Filing", "Trademark Law", "Copyright Protection", "IP Strategy", "Licensing"],
      "Regulatory & Government Affairs": ["Regulatory Compliance", "Government Relations", "Public Policy", "Licensing", "Legal Advisory"],
      "In-House Counsel": ["Corporate Law", "Contract Management", "Legal Advisory", "Risk Mitigation", "Compliance"],
      "LegalTech": ["Legal Operations", "E-Discovery", "Contract Management", "Legal AI", "Process Automation"],

      // Technology & Engineering
      "Software Development": ["JavaScript", "Python", "React", "Node.js", "SQL", "Git", "REST APIs"],
      "Data Science & AI": ["Python", "Machine Learning", "Data Analysis", "TensorFlow", "SQL", "Statistics"],
      "Cloud & DevOps": ["AWS", "Docker", "Kubernetes", "CI/CD", "Linux", "Terraform"],
      "Cybersecurity": ["Network Security", "Penetration Testing", "SIEM", "Incident Response", "Risk Assessment"],
      "Product Management": ["Product Strategy", "Agile", "Scrum", "User Research", "Roadmap Planning", "Stakeholder Management"],
      "UI/UX Design": ["Figma", "User Research", "Wireframing", "Prototyping", "Design Systems", "Usability Testing"],
      "IT Support & Infrastructure": ["Network Administration", "Windows Server", "Active Directory", "Help Desk", "IT Infrastructure"],
      "Telecommunications": ["Network Engineering", "5G", "RF Engineering", "Fiber Optics", "Wireless Networks"],
      "Embedded & Hardware Engineering": ["Embedded C", "FPGA", "PCB Design", "IoT", "Firmware Development"],
      "Gaming & Esports": ["Unity", "Unreal Engine", "Game Design", "3D Modeling", "C++"],
      "Blockchain & Web3": ["Solidity", "Smart Contracts", "DeFi", "Web3.js", "Blockchain Architecture"],
      "AR/VR & Immersive Tech": ["Unity", "3D Modeling", "AR Development", "VR Development", "Spatial Computing"],

      // Healthcare & Life Sciences
      "Medical & Clinical": ["Clinical Assessment", "Patient Care", "Medical Diagnosis", "Electronic Health Records", "Clinical Research"],
      "Nursing & Allied Health": ["Patient Care", "Clinical Skills", "Health Assessment", "Infection Control", "Emergency Care"],
      "Pharmacy & Pharmaceuticals": ["Pharmacology", "Drug Safety", "Clinical Trials", "Regulatory Affairs", "Pharmaceutical Research"],
      "Biotech & Life Sciences": ["Laboratory Techniques", "Genomics", "Bioinformatics", "R&D", "Cell Biology"],
      "Mental Health & Counselling": ["Cognitive Behavioral Therapy", "Counselling", "Mental Health Assessment", "Crisis Intervention", "Psychotherapy"],
      "Healthcare Management": ["Healthcare Operations", "Hospital Administration", "Health Policy", "Quality Assurance", "Patient Experience"],
      "Medical Devices & HealthTech": ["Medical Device Design", "Regulatory Affairs", "Quality Management", "Clinical Engineering", "Digital Health"],
      "Veterinary & Animal Health": ["Veterinary Medicine", "Animal Care", "Surgery", "Diagnostics", "Pharmacology"],

      // Real Estate & Construction
      "Residential Real Estate": ["Property Valuation", "Sales Negotiation", "Market Analysis", "Client Management", "Real Estate Marketing"],
      "Commercial Real Estate": ["Lease Negotiation", "Property Valuation", "Market Analysis", "Tenant Relations", "Commercial Leasing"],
      "Property Development": ["Project Management", "Feasibility Studies", "Urban Planning", "Budget Management", "Stakeholder Management"],
      "Construction & Civil Engineering": ["Project Management", "AutoCAD", "Structural Engineering", "Quantity Surveying", "Site Management"],
      "Architecture & Interior Design": ["AutoCAD", "Revit", "BIM", "3D Visualization", "Architectural Design"],
      "Facilities & Asset Management": ["Facilities Management", "Maintenance Planning", "Vendor Management", "Budget Management", "Space Planning"],

      // Sales, Marketing & Communications
      "Sales & Business Development": ["Sales Strategy", "CRM", "Negotiation", "Lead Generation", "Account Management"],
      "Digital Marketing": ["SEO", "Google Analytics", "Social Media Marketing", "PPC", "Content Marketing"],
      "Brand & Communications": ["Brand Strategy", "Public Relations", "Corporate Communications", "Media Relations", "Crisis Communications"],
      "Content & Creative": ["Copywriting", "Content Strategy", "Video Production", "Creative Writing", "Adobe Creative Suite"],
      "E-commerce & Retail": ["E-commerce Platforms", "Inventory Management", "Customer Experience", "Digital Marketing", "Merchandising"],
      "Market Research & Analytics": ["Data Analysis", "Market Research", "Survey Design", "Business Intelligence", "Statistical Analysis"],
      "Advertising & AdTech": ["Programmatic Advertising", "Media Planning", "Campaign Management", "Google Ads", "Performance Marketing"],

      // Human Resources & Education
      "HR & People Operations": ["Talent Management", "Employee Relations", "HR Policies", "Performance Management", "HRIS"],
      "Talent Acquisition & Recruitment": ["Sourcing", "Interviewing", "ATS", "Employer Branding", "Candidate Assessment"],
      "Learning & Development": ["Training Design", "E-Learning", "Instructional Design", "LMS", "Facilitation"],
      "Education & Teaching": ["Curriculum Development", "Classroom Management", "Lesson Planning", "Student Assessment", "Educational Technology"],
      "EdTech": ["LMS Administration", "E-Learning Development", "Educational Content", "Product Management", "User Experience"],

      // Operations, Logistics & Supply Chain
      "Supply Chain & Procurement": ["Supply Chain Management", "Procurement", "Vendor Management", "Inventory Management", "Cost Optimization"],
      "Logistics & Transport": ["Logistics Planning", "Fleet Management", "Route Optimization", "Warehouse Management", "Transportation Management"],
      "Warehousing & Distribution": ["Warehouse Management", "Inventory Control", "Distribution Planning", "WMS", "Order Fulfillment"],
      "Operations Management": ["Process Improvement", "Lean Management", "Six Sigma", "Project Management", "KPI Tracking"],
      "Aviation & Aerospace": ["Aviation Safety", "Aircraft Maintenance", "Flight Operations", "IATA Regulations", "Air Traffic Management"],
      "Maritime & Shipping": ["Maritime Operations", "Port Management", "Vessel Operations", "Marine Safety", "Shipping Logistics"],

      // Manufacturing & Industrial
      "Advanced Manufacturing": ["Manufacturing Processes", "Quality Control", "Lean Manufacturing", "CAD/CAM", "Process Engineering"],
      "Automotive & Transportation": ["Automotive Engineering", "Vehicle Design", "Manufacturing", "Quality Assurance", "Electric Vehicles"],
      "Aerospace & Defence Manufacturing": ["Aerospace Engineering", "Quality Assurance", "Manufacturing", "Defense Systems", "Compliance"],
      "Chemical & Materials": ["Chemical Engineering", "Materials Science", "Process Engineering", "Quality Control", "R&D"],
      "Electronics & Semiconductor": ["Circuit Design", "PCB Layout", "Semiconductor Manufacturing", "Testing", "Embedded Systems"],
      "Food & Beverage Manufacturing": ["Food Safety", "HACCP", "Quality Control", "Production Planning", "Supply Chain Management"],
      "Textile & Apparel Manufacturing": ["Textile Production", "Quality Control", "Pattern Making", "Supply Chain Management", "Production Planning"],

      // Agriculture & Food
      "Agriculture & Farming": ["Crop Management", "Agronomy", "Farm Operations", "Soil Science", "Agricultural Technology"],
      "AgriTech": ["Precision Agriculture", "IoT", "Data Analytics", "Drone Technology", "Smart Farming"],
      "Food & Beverage": ["Food Preparation", "Menu Planning", "Food Safety", "Inventory Management", "Customer Service"],
      "Food Retail & Grocery": ["Retail Operations", "Inventory Management", "Customer Service", "Merchandising", "Supply Chain"],
      "Aquaculture & Fisheries": ["Aquaculture Management", "Marine Biology", "Water Quality Management", "Fish Farming", "Sustainability"],

      // Energy & Environment
      "Oil & Gas": ["Petroleum Engineering", "Drilling Operations", "HSE", "Reservoir Engineering", "Process Engineering"],
      "Renewable Energy": ["Solar Energy", "Wind Energy", "Energy Storage", "Grid Integration", "Sustainability"],
      "Utilities & Infrastructure": ["Power Systems", "Grid Management", "Infrastructure Planning", "SCADA", "Utility Operations"],
      "Environmental & Sustainability": ["Environmental Impact Assessment", "Sustainability Reporting", "ESG", "Carbon Management", "Environmental Compliance"],
      "Space & Satellite": ["Satellite Communications", "Orbital Mechanics", "Space Systems", "RF Engineering", "Mission Planning"],

      // Hospitality, Tourism & Events
      "Hotels & Accommodation": ["Hospitality Management", "Guest Relations", "Revenue Management", "Front Office Operations", "Housekeeping Management"],
      "Food & Beverage Service": ["Food Service Management", "Menu Planning", "Customer Service", "Inventory Management", "Health & Safety"],
      "Travel & Tour Operations": ["Tour Planning", "Travel Management", "Customer Service", "Destination Knowledge", "Booking Systems"],
      "Events & Conference Management": ["Event Planning", "Vendor Coordination", "Budget Management", "Logistics", "Client Management"],
      "Cruise & Luxury Travel": ["Luxury Hospitality", "Guest Relations", "Maritime Operations", "Concierge Services", "Revenue Management"],

      // Adventure & Outdoor Tourism
      "Outdoor & Adventure Sports": ["Safety Management", "Adventure Guiding", "First Aid", "Equipment Maintenance", "Customer Service"],
      "Air & Aerial Activities": ["Aviation Safety", "Pilot Operations", "Customer Service", "Equipment Maintenance", "Risk Assessment"],
      "Land & Terrain Tours": ["Tour Guiding", "Navigation", "First Aid", "Customer Service", "Environmental Awareness"],
      "Water & Marine Activities": ["Water Safety", "Diving Certification", "Boat Operations", "Customer Service", "Equipment Maintenance"],
      "Equestrian & Animal Activities": ["Animal Care", "Equestrian Skills", "Customer Service", "Safety Management", "Training"],
      "Sightseeing & Urban Tours": ["Tour Guiding", "Local Knowledge", "Customer Service", "Languages", "Public Speaking"],

      // Health, Wellness & Fitness
      "Yoga & Wellness Retreats": ["Yoga Instruction", "Wellness Program Design", "Meditation", "Client Assessment", "Nutrition Basics"],
      "Personal Training & Fitness": ["Personal Training", "Exercise Programming", "Nutrition", "Client Assessment", "Fitness Assessment"],
      "Nutrition & Dietetics": ["Nutrition Planning", "Dietary Assessment", "Meal Planning", "Clinical Nutrition", "Health Coaching"],
      "Spa & Beauty": ["Spa Treatments", "Skincare", "Customer Service", "Aesthetics", "Health & Safety"],
      "Sports & Recreation": ["Sports Coaching", "Athletic Training", "Event Organization", "Performance Analysis", "First Aid"],

      // Fashion, Luxury & Consumer Goods
      "Fashion & Apparel": ["Fashion Design", "Trend Analysis", "Merchandising", "Textile Knowledge", "Brand Management"],
      "Luxury Goods & Jewellery": ["Luxury Brand Management", "Gemology", "Sales", "Visual Merchandising", "Client Relations"],
      "Beauty & Cosmetics": ["Product Knowledge", "Beauty Consulting", "Marketing", "Brand Management", "Trend Analysis"],
      "Consumer Electronics": ["Product Management", "Electronics Knowledge", "Marketing", "Supply Chain", "Customer Support"],
      "Furniture & Home Decor": ["Interior Design", "Product Sourcing", "Visual Merchandising", "Sales", "Customer Service"],

      // Media, Entertainment & Arts
      "Film, TV & Broadcasting": ["Video Production", "Editing", "Storytelling", "Camera Operations", "Post-Production"],
      "Music & Performing Arts": ["Music Production", "Performance", "Audio Engineering", "Event Management", "Artistic Direction"],
      "Publishing & Journalism": ["Writing", "Editing", "Research", "Content Management", "Digital Publishing"],
      "Animation & Visual Effects": ["3D Animation", "VFX", "Motion Graphics", "Adobe After Effects", "Compositing"],

      // Government, Non-Profit & Social
      "Government & Public Sector": ["Public Administration", "Policy Analysis", "Stakeholder Management", "Government Relations", "Compliance"],
      "Non-Profit & NGO": ["Program Management", "Fundraising", "Grant Writing", "Community Engagement", "Impact Assessment"],
      "International Development": ["Development Policy", "Program Management", "Monitoring & Evaluation", "Grant Management", "Stakeholder Engagement"],
      "Social Services": ["Social Work", "Case Management", "Community Outreach", "Program Development", "Crisis Intervention"],
    };

    // Get all industries with their current skill count
    const industries = await prisma.industry.findMany({
      where: { isActive: true },
      include: {
        skills: { select: { skillId: true } },
      },
    });

    let populated = 0, skipped = 0, noMapping = 0;
    const details = [];

    for (const industry of industries) {
      // Skip industries that already have >= 3 skills
      if (industry.skills.length >= 3) {
        skipped++;
        continue;
      }

      const skillNames = INDUSTRY_SKILLS[industry.name];
      if (!skillNames || skillNames.length === 0) {
        noMapping++;
        details.push({ industry: industry.name, status: "no mapping found" });
        continue;
      }

      const existingSkillIds = new Set(industry.skills.map(s => s.skillId));
      let added = 0;

      for (const skillName of skillNames) {
        // Find or create skill
        let skill = await prisma.skill.findFirst({ where: { name: skillName } });
        if (!skill) {
          skill = await prisma.skill.create({ data: { name: skillName } });
        }

        // Skip if already linked
        if (existingSkillIds.has(skill.id)) continue;

        // Link skill to industry
        await prisma.industrySkill.create({
          data: { industryId: industry.id, skillId: skill.id },
        }).catch(() => {}); // skip if duplicate

        existingSkillIds.add(skill.id);
        added++;
      }

      if (added > 0) {
        populated++;
        details.push({ industry: industry.name, skillsAdded: added });
      }
    }

    return res.json({
      status: "SUCCESS",
      message: `Done: ${populated} industries populated, ${skipped} already had 3+ skills, ${noMapping} had no mapping`,
      data: { total: industries.length, populated, skipped, noMapping, details },
    });
  } catch (err) {
    console.error("[PopulateIndustrySkills] Error:", err);
    return res.status(500).json({ error: true, message: err.message });
  }
});

module.exports = Router