/* prisma/seed-jobseeker-plans.js */
const { prisma } = require("../prisma");

const toCents = (usd) => Math.round(Number(usd) * 100);

// Map interval to the DB enum value for seeding
const INTERVALS = {
  QUARTER: "QUARTER",
  HALF_YEAR: "HALF_YEAR",
  YEAR: "YEAR",
};

async function seedSubscriptions() {
  const currency = "USD";
  const userType = "JOB_SEEKER";

  // MODE: "skip" | "upsert"
  const mode = (process.env.MODE || "upsert").toLowerCase();

  const plans = [
    {
      name: "Free Trial",
      amount: 0,
      features: {
        labels: { tier: "Free Trial" },
        pricing: { monthlyPrice: "$0.00" },
        limits: { savedJobs: 0, aiCoverLetters: 0 },
        access: {
          jobAccess: "Browse Only",
          searchFilters: "Basic",
          visibility: "Standard",
          support: "Email",
          applicationTool: "Not Available",
        },
        ai: {
          matchScore: "Not Available",
          cvBuilder: "1 Standard Template (Save Only)",
          skillGapAnalysis: false,
          coverLetters: "Not Included",
        },
        insights: { dubaiMarketInsights: false },
        trial: {
          durationDays: 7,
          canExportPdf: false,
          canApply: false,
          canSaveJobs: false,
          canViewSuggestions: false,
        },
      },
    },
    // ── Silver tier (4 durations) ──
    {
      name: "Silver 1-Month",
      amount: toCents(10.00),
      interval: INTERVALS.MONTH,
      features: {
        labels: { tier: "Silver (Starter)" },
        pricing: { price: "$10.00", duration: "1 month" },
        limits: { savedJobs: 25, aiCoverLetters: 0 },
        access: { jobAccess: "25 Saved Jobs", searchFilters: "Basic", visibility: "Standard", support: "Priority Email", applicationTool: "Standard Apply" },
        ai: { matchScore: "Basic Compatibility", cvBuilder: "1 Standard Template", skillGapAnalysis: false, coverLetters: "Not Included" },
        insights: { dubaiMarketInsights: false },
      },
    },
    {
      name: "Silver 3-Month",
      amount: toCents(29.95),
      interval: INTERVALS.QUARTER,
      features: {
        labels: { tier: "Silver (Starter)" },
        pricing: { price: "$29.95", duration: "3 months" },
        limits: { savedJobs: 25, aiCoverLetters: 0 },
        access: {
          jobAccess: "25 Saved Jobs",
          searchFilters: "Basic",
          visibility: "Standard",
          support: "Priority Email",
          applicationTool: "Standard Apply",
        },
        ai: {
          matchScore: "Basic Compatibility",
          cvBuilder: "1 Standard Template",
          skillGapAnalysis: false,
          coverLetters: "Not Included",
        },
        insights: { dubaiMarketInsights: false },
      },
    },
    {
      name: "Silver 6-Month",
      amount: toCents(47.95),
      interval: INTERVALS.HALF_YEAR,
      features: {
        labels: { tier: "Silver (Starter)" },
        pricing: { price: "$47.95", duration: "6 months" },
        limits: { savedJobs: 25, aiCoverLetters: 0 },
        access: {
          jobAccess: "25 Saved Jobs",
          searchFilters: "Basic",
          visibility: "Standard",
          support: "Priority Email",
          applicationTool: "Standard Apply",
        },
        ai: {
          matchScore: "Basic Compatibility",
          cvBuilder: "1 Standard Template",
          skillGapAnalysis: false,
          coverLetters: "Not Included",
        },
        insights: { dubaiMarketInsights: false },
      },
    },
    {
      name: "Silver 1-Year",
      amount: toCents(119.40),
      interval: INTERVALS.YEAR,
      features: {
        labels: { tier: "Silver (Starter)" },
        pricing: { price: "$79.95", duration: "12 months" },
        limits: { savedJobs: 25, aiCoverLetters: 0 },
        access: {
          jobAccess: "25 Saved Jobs",
          searchFilters: "Basic",
          visibility: "Standard",
          support: "Priority Email",
          applicationTool: "Standard Apply",
        },
        ai: {
          matchScore: "Basic Compatibility",
          cvBuilder: "1 Standard Template",
          skillGapAnalysis: false,
          coverLetters: "Not Included",
        },
        insights: { dubaiMarketInsights: false },
      },
    },
    // ── Gold tier (4 durations) ──
    {
      name: "Gold 1-Month",
      amount: toCents(20.00),
      interval: INTERVALS.MONTH,
      features: {
        labels: { tier: "Gold (Popular)" },
        pricing: { price: "$20.00", duration: "1 month" },
        limits: { savedJobs: -1, aiCoverLetters: 0 },
        access: { jobAccess: "Unlimited Saved Jobs", searchFilters: "Advanced + Alerts", visibility: "Enhanced", support: "Chat & Email", applicationTool: "One-Click Apply" },
        ai: { matchScore: "Deep Skill Insight", cvBuilder: "All Premium Templates", skillGapAnalysis: true, coverLetters: "Not Included" },
        insights: { dubaiMarketInsights: false },
      },
    },
    {
      name: "Gold 3-Month",
      amount: toCents(59.95),
      interval: INTERVALS.QUARTER,
      features: {
        labels: { tier: "Gold (Popular)" },
        pricing: { price: "$59.95", duration: "3 months" },
        limits: { savedJobs: -1, aiCoverLetters: 0 },
        access: {
          jobAccess: "Unlimited Saved Jobs",
          searchFilters: "Advanced + Alerts",
          visibility: "High",
          support: "Chat & Email",
          applicationTool: "One-Click Apply",
        },
        ai: {
          matchScore: "Deep Skill Insight",
          cvBuilder: "All Premium Templates",
          skillGapAnalysis: true,
          coverLetters: "Not Included",
        },
        insights: { dubaiMarketInsights: false },
      },
    },
    {
      name: "Gold 6-Month",
      amount: toCents(95.95),
      interval: INTERVALS.HALF_YEAR,
      features: {
        labels: { tier: "Gold (Popular)" },
        pricing: { price: "$95.95", duration: "6 months" },
        limits: { savedJobs: -1, aiCoverLetters: 0 },
        access: {
          jobAccess: "Unlimited Saved Jobs",
          searchFilters: "Advanced + Alerts",
          visibility: "High",
          support: "Chat & Email",
          applicationTool: "One-Click Apply",
        },
        ai: {
          matchScore: "Deep Skill Insight",
          cvBuilder: "All Premium Templates",
          skillGapAnalysis: true,
          coverLetters: "Not Included",
        },
        insights: { dubaiMarketInsights: false },
      },
    },
    {
      name: "Gold 1-Year",
      amount: toCents(239.40),
      interval: INTERVALS.YEAR,
      features: {
        labels: { tier: "Gold (Popular)" },
        pricing: { price: "$159.95", duration: "12 months" },
        limits: { savedJobs: -1, aiCoverLetters: 0 },
        access: {
          jobAccess: "Unlimited Saved Jobs",
          searchFilters: "Advanced + Alerts",
          visibility: "High",
          support: "Chat & Email",
          applicationTool: "One-Click Apply",
        },
        ai: {
          matchScore: "Deep Skill Insight",
          cvBuilder: "All Premium Templates",
          skillGapAnalysis: true,
          coverLetters: "Not Included",
        },
        insights: { dubaiMarketInsights: false },
      },
    },
    // ── Platinum tier (4 durations) ──
    {
      name: "Platinum 1-Month",
      amount: toCents(30.00),
      interval: INTERVALS.MONTH,
      features: {
        labels: { tier: "Platinum (Elite)" },
        pricing: { price: "$30.00", duration: "1 month" },
        limits: { savedJobs: -1, aiCoverLetters: -1 },
        access: { jobAccess: "Unlimited Saved Jobs + Priority", searchFilters: "Advanced + Exclusive Listings", visibility: "Priority Visibility", support: "VIP Phone + 1-on-1 Session", applicationTool: "One-Click Apply + Priority" },
        ai: { matchScore: "ATS-Optimized Scoring", cvBuilder: "All Premium + ATS Templates", skillGapAnalysis: true, coverLetters: "AI-Generated Unlimited" },
        insights: { dubaiMarketInsights: "Full Access + Salary Data" },
      },
    },
    {
      name: "Platinum 3-Month",
      amount: toCents(89.95),
      interval: INTERVALS.QUARTER,
      features: {
        labels: { tier: "Platinum (Elite)" },
        pricing: { price: "$89.95", duration: "3 months" },
        limits: { savedJobs: -1, aiCoverLetters: -1 },
        access: {
          jobAccess: "Unlimited + Exclusive Listings",
          searchFilters: "Advanced + Early Access",
          visibility: "VIP (Top of Recruiter List)",
          support: "VIP Phone + 1-on-1 Session",
          applicationTool: "One-Click + Auto-Fill",
        },
        ai: {
          matchScore: "Priority Match Ranking",
          cvBuilder: "AI-Optimized (ATS-Ready)",
          skillGapAnalysis: true,
          coverLetters: "Unlimited AI Generation",
        },
        insights: {
          dubaiMarketInsights:
            "Included (Salary calculator + cost of living calculators)",
        },
      },
    },
    {
      name: "Platinum 6-Month",
      amount: toCents(143.95),
      interval: INTERVALS.HALF_YEAR,
      features: {
        labels: { tier: "Platinum (Elite)" },
        pricing: { price: "$143.95", duration: "6 months" },
        limits: { savedJobs: -1, aiCoverLetters: -1 },
        access: {
          jobAccess: "Unlimited + Exclusive Listings",
          searchFilters: "Advanced + Early Access",
          visibility: "VIP (Top of Recruiter List)",
          support: "VIP Phone + 1-on-1 Session",
          applicationTool: "One-Click + Auto-Fill",
        },
        ai: {
          matchScore: "Priority Match Ranking",
          cvBuilder: "AI-Optimized (ATS-Ready)",
          skillGapAnalysis: true,
          coverLetters: "Unlimited AI Generation",
        },
        insights: {
          dubaiMarketInsights:
            "Included (Salary calculator + cost of living calculators)",
        },
      },
    },
    {
      name: "Platinum 1-Year",
      amount: toCents(359.40),
      interval: INTERVALS.YEAR,
      features: {
        labels: { tier: "Platinum (Elite)" },
        pricing: { price: "$233.95", duration: "12 months" },
        limits: { savedJobs: -1, aiCoverLetters: -1 },
        access: {
          jobAccess: "Unlimited + Exclusive Listings",
          searchFilters: "Advanced + Early Access",
          visibility: "VIP (Top of Recruiter List)",
          support: "VIP Phone + 1-on-1 Session",
          applicationTool: "One-Click + Auto-Fill",
        },
        ai: {
          matchScore: "Priority Match Ranking",
          cvBuilder: "AI-Optimized (ATS-Ready)",
          skillGapAnalysis: true,
          coverLetters: "Unlimited AI Generation",
        },
        insights: {
          dubaiMarketInsights:
            "Included (Salary calculator + cost of living calculators)",
        },
      },
    },
    {
      name: "Diamond",
      amount: toCents(99.0),
      features: {
        labels: { tier: "Diamond (Custom)" },
        pricing: { monthlyPrice: "$99.00" },

        limits: { savedJobs: -1, aiCoverLetters: -1 },

        access: {
          jobAccess: "Unlimited + Exclusive Listings + External Jobs",
          searchFilters: "Advanced + Early Access + Custom Alerts",
          visibility: "VIP (Top of Recruiter List)",
          support: "Dedicated Recruiter + VIP Phone + 1-on-1 Session",
          applicationTool: "One-Click + Auto-Fill + External Apply",
          externalApply: true,
        },

        ai: {
          matchScore: "Priority Match Ranking",
          cvBuilder: "AI-Optimized (ATS-Ready)",
          skillGapAnalysis: true,
          coverLetters: "Unlimited AI Generation",
        },

        insights: {
          dubaiMarketInsights:
            "Included (Salary calculator + cost of living calculators)",
        },

        recruiter: {
          customJobSearch: true,
          companyRepresentation: true,
          interviewScheduling: true,
          referenceChecks: true,
          offerNegotiation: true,
          hiringManagerFeedback: true,
          telephoneSupport: true,
        },
      },
    },
  ];

  // Deactivate old monthly Silver/Gold/Platinum plans (replaced by multi-duration plans)
  const oldMonthlyNames = ["Silver", "Gold", "Platinum"];
  for (const oldName of oldMonthlyNames) {
    const old = await prisma.subscriptionPlan.findFirst({
      where: { name: oldName, userType, currency },
    });
    if (old) {
      await prisma.subscriptionPlan.update({
        where: { id: old.id },
        data: { isActive: false },
      });
      console.log(`🚫 Deactivated old plan: ${oldName}`);
    }
  }

  // Fetch existing plans once (fast + avoids repeated queries)
  // Match by userType + currency + name (not interval) so we can fix stale intervals
  const existingPlans = await prisma.subscriptionPlan.findMany({
    where: { userType, currency },
    select: { id: true, name: true },
  });

  const existingByName = new Map(existingPlans.map((p) => [p.name, p]));

  for (const p of plans) {
    const existing = existingByName.get(p.name);
    const planInterval = p.interval || "MONTH"; // Free Trial + Diamond default to MONTH

    // ------------------- PLAN -------------------
    let plan;

    if (existing) {
      if (mode === "skip") {
        plan = existing;
        console.log(`⏭️  Skipped plan (exists): ${p.name}`);
      } else {
        plan = await prisma.subscriptionPlan.update({
          where: { id: existing.id },
          data: {
            amount: p.amount,
            interval: planInterval,
            isActive: true,
          },
          select: { id: true, name: true },
        });
        console.log(`🔁 Updated plan: ${p.name}`);
      }
    } else {
      plan = await prisma.subscriptionPlan.create({
        data: {
          name: p.name,
          userType,
          amount: p.amount,
          currency,
          interval: planInterval,
          isActive: true,
        },
        select: { id: true, name: true },
      });
      console.log(`✅ Created plan: ${p.name}`);
    }

    // ------------------- FEATURES -------------------
    // Ensure features exist for this plan
    const featureExists = await prisma.subscriptionFeature.findUnique({
      where: { planId: plan.id },
      select: { id: true },
    });

    if (featureExists) {
      if (mode === "skip") {
        console.log(`⏭️  Skipped features (exists): ${p.name}`);
      } else {
        await prisma.subscriptionFeature.update({
          where: { planId: plan.id },
          data: { features: p.features },
        });
        console.log(`🔁 Updated features: ${p.name}`);
      }
    } else {
      await prisma.subscriptionFeature.create({
        data: { planId: plan.id, features: p.features },
      });
      console.log(`✅ Created features: ${p.name}`);
    }
  }

  console.log("🎉 Job Seeker subscription seeding done.");
}

async function seedRecruiterSubscriptions() {
  const currency = "USD";
  const interval = "MONTH";
  const userType = "RECRUITER";

  const mode = (process.env.MODE || "upsert").toLowerCase();

  // Deactivate legacy plans from TopDubaiJobs
  await prisma.subscriptionPlan.updateMany({
    where: { userType, name: { endsWith: "(Legacy)" } },
    data: { isActive: false },
  });

  const plans = [
    {
      name: "Free Trial",
      amount: 0,
      features: {
        labels: { tier: "Free Trial" },
        pricing: { monthlyPrice: "$0.00" },
        limits: { activeJobs: 0 },
        access: {
          jobPosting: "Not Available",
          applicationManagement: "View Only",
          candidateSuggestions: "Not Available",
          bulkUpload: "Not Available",
          support: "Email",
        },
        ai: {
          rankings: false,
          analysis: false,
          screening: false,
        },
        trial: {
          durationDays: 7,
          canPostJobs: false,
          canUseAI: false,
          canBulkUpload: false,
        },
      },
    },
    {
      name: "Silver",
      amount: toCents(99.0),
      features: {
        labels: { tier: "Single Job Posting" },
        pricing: { price: "$99.00" },
        limits: { activeJobs: 1 },
        access: {
          jobPosting: "1 Active Job",
          applicationManagement: "Full Access",
          candidateSuggestions: "Basic Suggestions",
          bulkUpload: "Not Available",
          support: "Email Support",
        },
        ai: {
          rankings: false,
          analysis: false,
          screening: false,
        },
      },
    },
    {
      name: "Gold",
      amount: toCents(240.0),
      features: {
        labels: { tier: "Package 2 — Three (3) Job Postings" },
        pricing: { price: "$240.00" },
        limits: { activeJobs: 3 },
        access: {
          jobPosting: "3 Active Jobs",
          applicationManagement: "Full Access",
          candidateSuggestions: "AI-Powered Suggestions",
          bulkUpload: "Not Available",
          support: "Chat & Email Support",
        },
        ai: {
          rankings: true,
          analysis: true,
          screening: false,
        },
      },
    },
    {
      name: "Platinum",
      amount: toCents(350.0),
      features: {
        labels: { tier: "Package 3 — Five (5) Job Postings" },
        pricing: { price: "$350.00" },
        limits: { activeJobs: 5 },
        access: {
          jobPosting: "5 Active Jobs",
          applicationManagement: "Full Access + Priority",
          candidateSuggestions: "AI-Powered + Priority Matching",
          bulkUpload: "Up to 5 Jobs at Once",
          support: "VIP Phone + Account Manager",
        },
        ai: {
          rankings: true,
          analysis: true,
          screening: true,
        },
      },
    },
    {
      name: "Diamond",
      amount: toCents(9900.0),
      interval: "YEAR",
      features: {
        labels: { tier: "Unlimited Job Postings" },
        pricing: { yearlyPrice: "$9,900.00" },
        limits: { activeJobs: -1 },
        access: {
          jobPosting: "Unlimited Active Jobs (Unlimited Recruiter Seats)",
          applicationManagement: "Full Access + Priority + Dedicated",
          candidateSuggestions: "AI-Powered + Priority + Headhunting",
          bulkUpload: "Unlimited Bulk Upload",
          support: "Dedicated Account Manager + VIP Phone + 1-on-1 Session",
        },
        ai: {
          rankings: true,
          analysis: true,
          screening: true,
        },
        recruiterServices: {
          seats: -1,
          customCandidateSearch: true,
          companyRepresentation: true,
          interviewScheduling: true,
          referenceChecks: true,
          offerNegotiation: true,
          hiringManagerFeedback: true,
          telephoneSupport: true,
        },
      },
    },
  ];

  const existingPlans = await prisma.subscriptionPlan.findMany({
    where: { userType, currency },
    select: { id: true, name: true },
  });

  const existingByName = new Map(existingPlans.map((p) => [p.name, p]));

  for (const p of plans) {
    const existing = existingByName.get(p.name);
    let plan;

    if (existing) {
      if (mode === "skip") {
        plan = existing;
        console.log(`[RECRUITER] Skipped plan (exists): ${p.name}`);
      } else {
        plan = await prisma.subscriptionPlan.update({
          where: { id: existing.id },
          data: { amount: p.amount, interval: p.interval || interval, isActive: true },
          select: { id: true, name: true },
        });
        console.log(`[RECRUITER] Updated plan: ${p.name}`);
      }
    } else {
      plan = await prisma.subscriptionPlan.create({
        data: {
          name: p.name,
          userType,
          amount: p.amount,
          currency,
          interval: p.interval || interval,
          isActive: true,
        },
        select: { id: true, name: true },
      });
      console.log(`[RECRUITER] Created plan: ${p.name}`);
    }

    const featureExists = await prisma.subscriptionFeature.findUnique({
      where: { planId: plan.id },
      select: { id: true },
    });

    if (featureExists) {
      if (mode === "skip") {
        console.log(`[RECRUITER] Skipped features (exists): ${p.name}`);
      } else {
        await prisma.subscriptionFeature.update({
          where: { planId: plan.id },
          data: { features: p.features },
        });
        console.log(`[RECRUITER] Updated features: ${p.name}`);
      }
    } else {
      await prisma.subscriptionFeature.create({
        data: { planId: plan.id, features: p.features },
      });
      console.log(`[RECRUITER] Created features: ${p.name}`);
    }
  }

  console.log("Recruiter subscription seeding done.");
}

module.exports = { seedSubscriptions, seedRecruiterSubscriptions };