/**
 * Skill Normalizer
 * ================
 * Provides semantic skill normalization using an alias dictionary.
 * Maps common variations of skill names to their canonical form.
 *
 * Usage:
 *   const { findOrCreateNormalizedSkill } = require("./skillNormalizer");
 *   const { skillId, name } = await findOrCreateNormalizedSkill(prisma, "react.js");
 *   // Returns { skillId: "...", name: "React" }
 */

const SKILL_ALIASES = {
  // JavaScript ecosystem
  "javascript": "JavaScript",
  "java script": "JavaScript",
  "js": "JavaScript",
  "es6": "JavaScript",
  "es2015": "JavaScript",
  "ecmascript": "JavaScript",
  "typescript": "TypeScript",
  "ts": "TypeScript",
  "react": "React",
  "react.js": "React",
  "reactjs": "React",
  "react js": "React",
  "react native": "React Native",
  "reactnative": "React Native",
  "next.js": "Next.js",
  "nextjs": "Next.js",
  "next js": "Next.js",
  "vue": "Vue.js",
  "vue.js": "Vue.js",
  "vuejs": "Vue.js",
  "vue js": "Vue.js",
  "angular": "Angular",
  "angularjs": "Angular",
  "angular.js": "Angular",
  "angular js": "Angular",
  "node": "Node.js",
  "node.js": "Node.js",
  "nodejs": "Node.js",
  "node js": "Node.js",
  "express": "Express.js",
  "express.js": "Express.js",
  "expressjs": "Express.js",
  "jquery": "jQuery",
  "j query": "jQuery",
  "svelte": "Svelte",
  "sveltejs": "Svelte",
  "nuxt": "Nuxt.js",
  "nuxt.js": "Nuxt.js",
  "nuxtjs": "Nuxt.js",
  "gatsby": "Gatsby",
  "gatsby.js": "Gatsby",

  // CSS / Styling
  "css": "CSS",
  "css3": "CSS",
  "cascading style sheets": "CSS",
  "html": "HTML",
  "html5": "HTML",
  "html/css": "HTML/CSS",
  "html & css": "HTML/CSS",
  "sass": "SASS/SCSS",
  "scss": "SASS/SCSS",
  "less": "LESS",
  "tailwind": "Tailwind CSS",
  "tailwindcss": "Tailwind CSS",
  "tailwind css": "Tailwind CSS",
  "bootstrap": "Bootstrap",
  "material ui": "Material UI",
  "material-ui": "Material UI",
  "mui": "Material UI",
  "styled components": "Styled Components",
  "styled-components": "Styled Components",
  "chakra ui": "Chakra UI",
  "chakra": "Chakra UI",

  // Backend / Databases
  "python": "Python",
  "py": "Python",
  "java": "Java",
  "c#": "C#",
  "c sharp": "C#",
  "csharp": "C#",
  "c++": "C++",
  "cpp": "C++",
  "c plus plus": "C++",
  "golang": "Go",
  "go lang": "Go",
  "go": "Go",
  "rust": "Rust",
  "ruby": "Ruby",
  "ruby on rails": "Ruby on Rails",
  "rails": "Ruby on Rails",
  "ror": "Ruby on Rails",
  "php": "PHP",
  "laravel": "Laravel",
  "django": "Django",
  "flask": "Flask",
  "fastapi": "FastAPI",
  "fast api": "FastAPI",
  "spring": "Spring",
  "spring boot": "Spring Boot",
  "springboot": "Spring Boot",
  ".net": ".NET",
  "dotnet": ".NET",
  "dot net": ".NET",
  "asp.net": "ASP.NET",
  "asp net": "ASP.NET",
  "kotlin": "Kotlin",
  "swift": "Swift",
  "objective-c": "Objective-C",
  "objective c": "Objective-C",
  "scala": "Scala",
  "r": "R",
  "matlab": "MATLAB",
  "perl": "Perl",
  "lua": "Lua",
  "dart": "Dart",
  "flutter": "Flutter",

  // Databases
  "sql": "SQL",
  "mysql": "MySQL",
  "my sql": "MySQL",
  "postgresql": "PostgreSQL",
  "postgres": "PostgreSQL",
  "pg": "PostgreSQL",
  "mongodb": "MongoDB",
  "mongo": "MongoDB",
  "mongo db": "MongoDB",
  "redis": "Redis",
  "elasticsearch": "Elasticsearch",
  "elastic search": "Elasticsearch",
  "dynamodb": "DynamoDB",
  "dynamo db": "DynamoDB",
  "firebase": "Firebase",
  "firestore": "Firestore",
  "supabase": "Supabase",
  "sqlite": "SQLite",
  "mariadb": "MariaDB",
  "maria db": "MariaDB",
  "oracle db": "Oracle DB",
  "oracle": "Oracle DB",
  "ms sql": "MS SQL Server",
  "mssql": "MS SQL Server",
  "sql server": "MS SQL Server",
  "cassandra": "Cassandra",
  "neo4j": "Neo4j",
  "prisma": "Prisma",
  "prisma orm": "Prisma",
  "sequelize": "Sequelize",
  "mongoose": "Mongoose",
  "typeorm": "TypeORM",

  // Cloud / DevOps
  "aws": "AWS",
  "amazon web services": "AWS",
  "azure": "Azure",
  "microsoft azure": "Azure",
  "gcp": "Google Cloud",
  "google cloud": "Google Cloud",
  "google cloud platform": "Google Cloud",
  "docker": "Docker",
  "kubernetes": "Kubernetes",
  "k8s": "Kubernetes",
  "terraform": "Terraform",
  "ansible": "Ansible",
  "jenkins": "Jenkins",
  "ci/cd": "CI/CD",
  "ci cd": "CI/CD",
  "continuous integration": "CI/CD",
  "github actions": "GitHub Actions",
  "gitlab ci": "GitLab CI",
  "circleci": "CircleCI",
  "nginx": "Nginx",
  "apache": "Apache",
  "linux": "Linux",
  "ubuntu": "Ubuntu",
  "centos": "CentOS",
  "devops": "DevOps",
  "dev ops": "DevOps",
  "serverless": "Serverless",
  "lambda": "AWS Lambda",
  "aws lambda": "AWS Lambda",
  "cloudformation": "CloudFormation",
  "vercel": "Vercel",
  "netlify": "Netlify",
  "heroku": "Heroku",
  "digitalocean": "DigitalOcean",
  "digital ocean": "DigitalOcean",

  // Version Control
  "git": "Git",
  "github": "GitHub",
  "gitlab": "GitLab",
  "bitbucket": "Bitbucket",
  "svn": "SVN",
  "subversion": "SVN",

  // Testing
  "jest": "Jest",
  "mocha": "Mocha",
  "cypress": "Cypress",
  "selenium": "Selenium",
  "playwright": "Playwright",
  "junit": "JUnit",
  "pytest": "pytest",
  "unit testing": "Unit Testing",
  "tdd": "TDD",
  "test driven development": "TDD",
  "bdd": "BDD",

  // Data / AI / ML
  "machine learning": "Machine Learning",
  "ml": "Machine Learning",
  "deep learning": "Deep Learning",
  "dl": "Deep Learning",
  "artificial intelligence": "Artificial Intelligence",
  "ai": "Artificial Intelligence",
  "natural language processing": "NLP",
  "nlp": "NLP",
  "computer vision": "Computer Vision",
  "cv": "Computer Vision",
  "tensorflow": "TensorFlow",
  "pytorch": "PyTorch",
  "pandas": "Pandas",
  "numpy": "NumPy",
  "scikit-learn": "scikit-learn",
  "sklearn": "scikit-learn",
  "data science": "Data Science",
  "data analysis": "Data Analysis",
  "data analytics": "Data Analytics",
  "data visualization": "Data Visualization",
  "power bi": "Power BI",
  "powerbi": "Power BI",
  "tableau": "Tableau",
  "excel": "Microsoft Excel",
  "microsoft excel": "Microsoft Excel",
  "ms excel": "Microsoft Excel",

  // Design
  "figma": "Figma",
  "sketch": "Sketch",
  "adobe xd": "Adobe XD",
  "xd": "Adobe XD",
  "photoshop": "Adobe Photoshop",
  "adobe photoshop": "Adobe Photoshop",
  "illustrator": "Adobe Illustrator",
  "adobe illustrator": "Adobe Illustrator",
  "indesign": "Adobe InDesign",
  "adobe indesign": "Adobe InDesign",
  "ui/ux": "UI/UX Design",
  "ui ux": "UI/UX Design",
  "ux design": "UX Design",
  "ui design": "UI Design",
  "user experience": "UX Design",
  "user interface": "UI Design",

  // APIs / Protocols
  "rest": "REST API",
  "rest api": "REST API",
  "restful": "REST API",
  "restful api": "REST API",
  "graphql": "GraphQL",
  "graph ql": "GraphQL",
  "grpc": "gRPC",
  "websocket": "WebSocket",
  "websockets": "WebSocket",
  "soap": "SOAP",

  // Tools / Methodologies
  "agile": "Agile",
  "scrum": "Scrum",
  "kanban": "Kanban",
  "jira": "Jira",
  "confluence": "Confluence",
  "trello": "Trello",
  "asana": "Asana",
  "slack": "Slack",
  "project management": "Project Management",
  "product management": "Product Management",

  // Microsoft Office
  "microsoft office": "Microsoft Office",
  "ms office": "Microsoft Office",
  "microsoft word": "Microsoft Word",
  "ms word": "Microsoft Word",
  "word": "Microsoft Word",
  "powerpoint": "Microsoft PowerPoint",
  "ms powerpoint": "Microsoft PowerPoint",
  "microsoft powerpoint": "Microsoft PowerPoint",
  "ppt": "Microsoft PowerPoint",
  "outlook": "Microsoft Outlook",
  "ms outlook": "Microsoft Outlook",

  // Security
  "cybersecurity": "Cybersecurity",
  "cyber security": "Cybersecurity",
  "information security": "Information Security",
  "infosec": "Information Security",
  "penetration testing": "Penetration Testing",
  "pen testing": "Penetration Testing",
  "ethical hacking": "Ethical Hacking",

  // Other
  "sap": "SAP",
  "erp": "ERP",
  "crm": "CRM",
  "salesforce": "Salesforce",
  "hubspot": "HubSpot",
  "seo": "SEO",
  "sem": "SEM",
  "google analytics": "Google Analytics",
  "social media marketing": "Social Media Marketing",
  "smm": "Social Media Marketing",
  "digital marketing": "Digital Marketing",
  "content marketing": "Content Marketing",
  "email marketing": "Email Marketing",
  "copywriting": "Copywriting",
  "technical writing": "Technical Writing",
  "communication": "Communication",
  "leadership": "Leadership",
  "team management": "Team Management",
  "problem solving": "Problem Solving",
  "problem-solving": "Problem Solving",
  "critical thinking": "Critical Thinking",
  "time management": "Time Management",
  "customer service": "Customer Service",
  "public speaking": "Public Speaking",
  "negotiation": "Negotiation",
  "strategic planning": "Strategic Planning",
};

/**
 * Normalize a skill name using the alias dictionary.
 * @param {string} rawName
 * @returns {string} Canonical skill name
 */
function normalizeSkillName(rawName) {
  if (!rawName || typeof rawName !== "string") return rawName;
  const trimmed = rawName.trim();
  if (!trimmed) return trimmed;

  const key = trimmed.toLowerCase();
  return SKILL_ALIASES[key] || trimmed;
}

/**
 * Find or create a skill in the database with semantic normalization.
 *
 * Steps:
 * 1. Normalize the name via alias dictionary
 * 2. Look up by canonical name (case-insensitive)
 * 3. If not found, create with canonical name
 *
 * @param {import('../../generated/prisma/client').PrismaClient} prisma
 * @param {string} rawSkillName
 * @returns {Promise<{skillId: string, name: string} | null>}
 */
async function findOrCreateNormalizedSkill(prisma, rawSkillName) {
  const canonical = normalizeSkillName(rawSkillName);
  if (!canonical || canonical.length < 2) return null;

  // Try to find existing skill by canonical name
  let skill = await prisma.skill.findFirst({
    where: { name: { equals: canonical, mode: "insensitive" } },
    select: { id: true, name: true },
  });

  if (skill) return { skillId: skill.id, name: skill.name };

  // Also try the raw name in case there's an existing entry that doesn't match the alias
  if (canonical !== rawSkillName.trim()) {
    skill = await prisma.skill.findFirst({
      where: { name: { equals: rawSkillName.trim(), mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (skill) return { skillId: skill.id, name: skill.name };
  }

  // Create new skill with canonical name
  try {
    skill = await prisma.skill.create({
      data: { name: canonical },
      select: { id: true, name: true },
    });
    return { skillId: skill.id, name: skill.name };
  } catch (err) {
    // Handle race condition (unique constraint)
    if (err.code === "P2002") {
      skill = await prisma.skill.findFirst({
        where: { name: { equals: canonical, mode: "insensitive" } },
        select: { id: true, name: true },
      });
      if (skill) return { skillId: skill.id, name: skill.name };
    }
    return null;
  }
}

/**
 * Infer proficiency level based on years of experience with the skill.
 * @param {number} totalYears - Total years of professional experience
 * @param {string} skillName - The skill name (for context)
 * @returns {string} Proficiency level
 */
function inferProficiency(totalYears) {
  if (totalYears >= 8) return "EXPERT";
  if (totalYears >= 5) return "ADVANCED";
  if (totalYears >= 2) return "INTERMEDIATE";
  return "BEGINNER";
}

module.exports = {
  SKILL_ALIASES,
  normalizeSkillName,
  findOrCreateNormalizedSkill,
  inferProficiency,
};
