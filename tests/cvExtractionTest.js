/**
 * CV Extraction Test Harness
 * ==========================
 * Tests the extraction pipeline against sample CVs to measure quality.
 * Run: node tests/cvExtractionTest.js
 *
 * Outputs a comparison table showing extraction results per CV.
 */

require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { extractFromFile } = require("../controllers/ai/cvExtractor");
const { normalizeSkillName } = require("../controllers/ai/skillNormalizer");

const SAMPLE_CVS_DIR = path.resolve(__dirname, "../../../cvs");

const FIELDS = [
  "name", "email", "phone", "location", "summary", "title",
  "skills", "experience", "education", "certifications",
  "languages", "awards", "interests", "totalYearsExperience",
];

function countField(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (Array.isArray(val)) return val.length;
  if (typeof val === "string" && val.trim().length > 0) return 1;
  if (typeof val === "number" && val > 0) return 1;
  return 0;
}

function formatField(val) {
  if (val === null || val === undefined || val === "") return "-";
  if (Array.isArray(val)) return val.length > 0 ? `${val.length} items` : "-";
  if (typeof val === "string") return val.length > 40 ? val.slice(0, 40) + "..." : val;
  return String(val);
}

async function testExtraction() {
  console.log("CV Extraction Test Harness");
  console.log("=".repeat(80));

  // Find all PDF files
  let files;
  try {
    const allFiles = await fs.readdir(SAMPLE_CVS_DIR);
    files = allFiles.filter((f) => /\.pdf$/i.test(f));
  } catch (err) {
    console.error(`Could not read CVs directory: ${SAMPLE_CVS_DIR}`);
    console.error(err.message);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log("No PDF files found in", SAMPLE_CVS_DIR);
    process.exit(1);
  }

  console.log(`Found ${files.length} CVs to test\n`);

  const results = [];

  for (const file of files) {
    const filePath = path.join(SAMPLE_CVS_DIR, file);
    console.log(`\nProcessing: ${file}`);
    console.log("-".repeat(60));

    try {
      const result = await extractFromFile(filePath, { useAI: true });

      if (!result.success) {
        console.log(`  FAILED: ${result.error}`);
        results.push({ file, success: false, error: result.error });
        continue;
      }

      const data = result.data;
      const entry = { file, success: true, method: result.method, aiProvider: result.aiProvider || "regex" };

      // Count populated fields
      let populated = 0;
      let total = FIELDS.length;

      for (const field of FIELDS) {
        const val = data[field];
        const count = countField(val);
        const display = formatField(val);
        entry[field] = { count, display, raw: val };

        if (count > 0) populated++;
        console.log(`  ${field.padEnd(24)} ${count > 0 ? "OK" : "MISS"}  ${display}`);
      }

      entry.coverage = `${populated}/${total} (${Math.round((populated / total) * 100)}%)`;
      console.log(`  ${"COVERAGE".padEnd(24)} ${entry.coverage}`);

      // Test skill normalization
      if (data.skills && data.skills.length > 0) {
        console.log(`\n  Skill Normalization:`);
        const normalizedSkills = data.skills.map((s) => {
          const canonical = normalizeSkillName(s);
          const changed = canonical !== s;
          return { raw: s, canonical, changed };
        });

        const normalized = normalizedSkills.filter((s) => s.changed);
        if (normalized.length > 0) {
          for (const s of normalized.slice(0, 5)) {
            console.log(`    "${s.raw}" -> "${s.canonical}"`);
          }
          if (normalized.length > 5) {
            console.log(`    ... and ${normalized.length - 5} more`);
          }
        } else {
          console.log(`    No skills needed normalization`);
        }
        entry.skillsNormalized = normalized.length;
      }

      results.push(entry);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      results.push({ file, success: false, error: err.message });
    }
  }

  // Summary table
  console.log("\n\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`${"CV File".padEnd(40)} ${"Method".padEnd(12)} ${"Coverage".padEnd(14)} ${"Skills".padEnd(8)} ${"Exp".padEnd(6)} ${"Edu".padEnd(6)}`);
  console.log("-".repeat(86));

  for (const r of results) {
    if (!r.success) {
      console.log(`${r.file.slice(0, 38).padEnd(40)} FAILED       ${(r.error || "").slice(0, 30)}`);
      continue;
    }

    const skills = r.skills?.count || 0;
    const exp = r.experience?.count || 0;
    const edu = r.education?.count || 0;

    console.log(
      `${r.file.slice(0, 38).padEnd(40)} ${(r.aiProvider || r.method).padEnd(12)} ${(r.coverage || "").padEnd(14)} ${String(skills).padEnd(8)} ${String(exp).padEnd(6)} ${String(edu).padEnd(6)}`
    );
  }

  // Overall stats
  const successful = results.filter((r) => r.success);
  const avgCoverage = successful.length > 0
    ? Math.round(
        successful.reduce((sum, r) => {
          const [pop, tot] = (r.coverage || "0/0").split(" ")[0].split("/").map(Number);
          return sum + (pop / tot) * 100;
        }, 0) / successful.length
      )
    : 0;

  console.log("-".repeat(86));
  console.log(`Total: ${files.length} CVs | Successful: ${successful.length} | Avg Coverage: ${avgCoverage}%`);
}

testExtraction().catch((err) => {
  console.error("Test harness error:", err);
  process.exit(1);
});
