const https = require("https");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");
const { prisma } = require("../prisma");
const { normaliseToCanonical, INDUSTRIES } = require("../controllers/ai/industryTaxonomy");

const FEED_URL =
  "https://www.jobg8.com/fileserver/jobs.aspx?username=579EC76BC2&password=C446E61CF8&accountnumber=824097&filename=Jobs.zip";

const RECRUITER_EMAIL = "contechkenya7@gmail.com";

// UAE city coordinates lookup
const UAE_CITIES = {
  dubai: { lat: 25.2048, lng: 55.2708 },
  "abu dhabi": { lat: 24.4539, lng: 54.3773 },
  sharjah: { lat: 25.3463, lng: 55.4209 },
  ajman: { lat: 25.4052, lng: 55.5136 },
  "ras al khaimah": { lat: 25.7895, lng: 55.9432 },
  "ras al-khaimah": { lat: 25.7895, lng: 55.9432 },
  fujairah: { lat: 25.1288, lng: 56.3265 },
  "al ain": { lat: 24.2075, lng: 55.7447 },
  "umm al quwain": { lat: 25.5647, lng: 55.5554 },
  "united arab emirates": { lat: 25.2048, lng: 55.2708 },
  uae: { lat: 25.2048, lng: 55.2708 },
};

// Map employment type from feed to our enum
function mapEmploymentType(empType, workHours) {
  const e = (empType || "").toLowerCase();
  const w = (workHours || "").toLowerCase();

  if (w.includes("part time") || w.includes("teilzeit")) return "PART_TIME";
  if (e.includes("contract") || e.includes("temporary") || e.includes("befristet")) return "CONTRACT";
  if (e.includes("internship") || e.includes("praktikum")) return "INTERNSHIP";
  return "FULL_TIME";
}

// Extract currency code from strings like "Euro . EUR", "US Dollar . USD"
function extractCurrency(currStr) {
  if (!currStr) return null;
  const match = currStr.match(/[A-Z]{3}/);
  return match ? match[0] : null;
}

// Lookup city coordinates
function lookupCoords(location) {
  if (!location) return { lat: null, lng: null };
  const key = location.toLowerCase().trim();
  for (const [city, coords] of Object.entries(UAE_CITIES)) {
    if (key.includes(city)) return coords;
  }
  // Default to Dubai if UAE location but no match
  return UAE_CITIES.dubai;
}

// Download file from URL into a buffer
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadBuffer(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Find or create a Company entry for a feed advertiser.
 * Uses an in-memory cache to avoid repeated DB lookups.
 */
const companyCache = new Map();

async function findOrCreateFeedCompany(advertiserName, locationName) {
  if (!advertiserName) return null;

  const cacheKey = advertiserName.toLowerCase().trim();
  if (companyCache.has(cacheKey)) return companyCache.get(cacheKey);

  // Try to find existing company by name (case-insensitive)
  let company = await prisma.company.findFirst({
    where: { name: { equals: advertiserName.trim(), mode: "insensitive" } },
  });

  if (!company) {
    // Create a new company for this advertiser
    const regNum = `FEED-${cacheKey.replace(/[^a-z0-9]/g, "-").substring(0, 40)}-${Date.now()}`;
    try {
      company = await prisma.company.create({
        data: {
          name: advertiserName.trim(),
          registrationNumber: regNum,
          country: locationName ? locationName.split(",").pop()?.trim() || "UAE" : "UAE",
          isVerified: false,
        },
      });
    } catch (err) {
      // Might be a race condition with registrationNumber, try finding again
      company = await prisma.company.findFirst({
        where: { name: { equals: advertiserName.trim(), mode: "insensitive" } },
      });
      if (!company) throw err;
    }
  }

  companyCache.set(cacheKey, company);
  return company;
}

async function syncJobFeed() {
  console.log("[FeedSync] Starting JobG8 feed sync...");
  const startTime = Date.now();
  companyCache.clear();

  // 1. Find the recruiter profile (fallback company for jobs without advertiser)
  const recruiter = await prisma.recruiterProfile.findFirst({
    where: { user: { email: RECRUITER_EMAIL } },
    include: { user: true, company: true },
  });

  if (!recruiter) {
    console.error("[FeedSync] Recruiter not found:", RECRUITER_EMAIL);
    return;
  }
  if (!recruiter.companyId) {
    console.error("[FeedSync] Recruiter has no company");
    return;
  }

  console.log(`[FeedSync] Using recruiter: ${recruiter.user.firstName} ${recruiter.user.lastName}, company: ${recruiter.company.name}`);

  // 2. Load all industries and build taxonomy-aware lookup
  const industries = await prisma.industry.findMany({ where: { isActive: true } });
  const industryByName = new Map();
  for (const ind of industries) {
    industryByName.set(ind.name.toLowerCase(), ind.id);
  }

  // Build keyword-to-industry map for title-based matching
  const titleKeywordMap = [];
  for (const ind of INDUSTRIES) {
    for (const kw of ind.keywords) {
      titleKeywordMap.push({ keyword: kw.toLowerCase(), label: ind.label });
    }
  }
  titleKeywordMap.sort((a, b) => b.keyword.length - a.keyword.length);

  function matchTitleToIndustry(title) {
    const t = ` ${title.toLowerCase()} `;
    for (const { keyword, label } of titleKeywordMap) {
      if (t.includes(` ${keyword} `) || t.includes(`-${keyword} `) || t.includes(` ${keyword}-`) || t.includes(` ${keyword}/`) || t.includes(`/${keyword} `)) {
        return industryByName.get(label.toLowerCase()) || null;
      }
    }
    return null;
  }

  // 3. Download and parse feed
  console.log("[FeedSync] Downloading feed ZIP...");
  const zipBuffer = await downloadBuffer(FEED_URL);
  console.log(`[FeedSync] Downloaded ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const xmlEntry = entries.find((e) => e.entryName.toLowerCase().endsWith(".xml"));
  if (!xmlEntry) {
    console.error("[FeedSync] No XML file found in ZIP");
    return;
  }

  const xmlContent = xmlEntry.getData().toString("utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
  });
  const parsed = parser.parse(xmlContent);

  // Handle both single job and array of jobs
  let jobs = parsed?.Jobs?.Job || [];
  if (!Array.isArray(jobs)) jobs = [jobs];
  console.log(`[FeedSync] Parsed ${jobs.length} jobs from feed`);

  // 4. Preload existing feed jobs for fast diff (avoids 10k individual lookups)
  const existingJobs = await prisma.job.findMany({
    where: { source: "FEED" },
    select: { id: true, externalId: true, title: true, description: true, applicationUrl: true, status: true },
  });
  const existingByExtId = new Map();
  for (const ej of existingJobs) {
    if (ej.externalId) existingByExtId.set(ej.externalId, ej);
  }
  console.log(`[FeedSync] Loaded ${existingByExtId.size} existing feed jobs for diff`);

  // 5. Process jobs in batches
  const BATCH_SIZE = 100;
  let created = 0, updated = 0, skipped = 0, unchanged = 0, errors = 0;
  let companiesCreated = 0;
  const feedExternalIds = new Set();

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);

    for (const job of batch) {
      try {
        const externalId = String(job.SenderReference || "").trim();
        if (!externalId) {
          skipped++;
          continue;
        }
        feedExternalIds.add(externalId);

        const title = String(job.Position || "Untitled").trim();
        const description = String(job.Description || "").trim();
        const locationName = String(job.Location || "Dubai").trim();
        const coords = lookupCoords(locationName);
        const employmentType = mapEmploymentType(job.EmploymentType, job.WorkHours);
        const applicationUrl = String(job.ApplicationURL || "").trim();
        const currency = extractCurrency(String(job.SalaryCurrency || ""));
        const salaryMin = job.SalaryMinimum ? Math.round(parseFloat(job.SalaryMinimum)) : null;
        const salaryMax = job.SalaryMaximum ? Math.round(parseFloat(job.SalaryMaximum)) : null;

        const advertiserName = String(job.Advertiser || job.Company || job.AdvertiserName || "").trim();

        let jobCompanyId = recruiter.companyId;
        if (advertiserName) {
          const cacheSizeBefore = companyCache.size;
          const feedCompany = await findOrCreateFeedCompany(advertiserName, locationName);
          if (feedCompany) {
            jobCompanyId = feedCompany.id;
            if (companyCache.size > cacheSizeBefore) companiesCreated++;
          }
        }

        const classification = String(job.Classification || "").trim();
        let industryId = null;
        if (classification) {
          const canonical = normaliseToCanonical(classification);
          if (canonical) {
            industryId = industryByName.get(canonical.label.toLowerCase()) || null;
          }
          if (!industryId) {
            industryId = industryByName.get(classification.toLowerCase()) || null;
          }
        }
        if (!industryId) {
          industryId = matchTitleToIndustry(title);
        }

        const jobData = {
          title,
          description,
          vacancies: 1,
          employmentType,
          locationName,
          latitude: coords.lat,
          longitude: coords.lng,
          minSalary: salaryMin,
          maxSalary: salaryMax,
          currency: currency,
          showSalary: !!(salaryMin || salaryMax),
          status: "PUBLISHED",
          companyId: jobCompanyId,
          recruiterProfileId: recruiter.id,
          applicationUrl,
          source: "FEED",
          publishedAt: new Date(),
        };

        const existing = existingByExtId.get(externalId);

        if (existing) {
          // Skip update if key fields haven't changed (major perf win)
          if (existing.title === title && existing.applicationUrl === applicationUrl && existing.status === "PUBLISHED") {
            unchanged++;
            continue;
          }
          await prisma.job.update({ where: { externalId }, data: jobData });
          if (industryId) {
            const hasCorrectLink = await prisma.jobIndustry.findFirst({
              where: { jobId: existing.id, industryId },
            });
            if (!hasCorrectLink) {
              await prisma.jobIndustry.deleteMany({ where: { jobId: existing.id } });
              await prisma.jobIndustry.create({ data: { jobId: existing.id, industryId } }).catch(() => {});
            }
          }
          updated++;
        } else {
          const newJob = await prisma.job.create({
            data: { ...jobData, externalId },
          });
          if (industryId) {
            await prisma.jobIndustry.create({ data: { jobId: newJob.id, industryId } }).catch(() => {});
          }
          created++;
        }
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.error(`[FeedSync] Error processing job:`, err.message);
        }
      }
    }
  }

  // 6. Close stale feed jobs not in current feed (batch by IDs instead of notIn with 10k strings)
  const staleIds = [];
  for (const [extId, ej] of existingByExtId) {
    if (!feedExternalIds.has(extId) && ej.status !== "CLOSED") {
      staleIds.push(ej.id);
    }
  }
  const staleResult = staleIds.length > 0
    ? await prisma.job.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "CLOSED" },
      })
    : { count: 0 };
  console.log(`[FeedSync] Unchanged: ${unchanged}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[FeedSync] Complete in ${elapsed}s — Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}, Closed stale: ${staleResult.count}, New companies: ${companiesCreated}`
  );
}

module.exports = { syncJobFeed };
