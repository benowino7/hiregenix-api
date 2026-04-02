# HireGeniX - Backend API

Node.js/Express REST API powering the HireGeniX platform. Handles authentication, job management, recruiter workflows, job seeker profiles, AI-powered candidate ranking, and CV extraction.

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express 5.2
- **ORM**: Prisma 7.3 (PostgreSQL)
- **Auth**: JWT (jsonwebtoken) + bcryptjs
- **Validation**: express-validator
- **File Uploads**: Multer (PDF only)
- **CV Parsing**: pdf-parse
- **Rate Limiting**: express-rate-limit
- **AI (optional)**: Anthropic Claude / OpenAI GPT-4o (algorithmic matching works without API keys)
- **CV Parsing**: Affinda Resume Parser (optional, fallback provider)
- **PDF Generation**: Puppeteer (server-side CV PDF export)

## Prerequisites

- Node.js >= 18
- PostgreSQL database
- npm or yarn

## Setup

1. **Clone and install**
   ```bash
   git clone https://github.com/Kiprotich78/hiregenix_server.git
   cd hiregenix_server
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env-example .env
   ```
   Edit `.env` and set:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/hiregenix
   PORT=6565
   JWT_SECRET=your-secret-key-here
   ```

   Optional AI keys (matching works without these):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   OPENAI_API_KEY=sk-...
   AFFINDA_API_KEY=aff_...
   AFFINDA_WORKSPACE=default
   ```

3. **Run database migrations**
   ```bash
   npx prisma migrate deploy
   ```

4. **Start the server**
   ```bash
   # Development (with hot reload)
   npm run dev

   # Production
   node server.js
   ```

   Server runs on `http://localhost:6565` by default.

## API Reference

Base URL: `/api/v1`

### Authentication (`/auth`)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/auth/register` | Register new user (JOB_SEEKER or RECRUITER) | No |
| POST | `/auth/login` | Login with email or phone + password | No |
| POST | `/auth/forgot-password` | Request password reset token | No |
| POST | `/auth/reset-password` | Reset password with token | No |
| POST | `/auth/2fa/setup` | Generate 2FA secret + QR code | Yes |
| POST | `/auth/2fa/verify` | Verify 2FA TOTP code and enable 2FA | Yes |
| POST | `/auth/2fa/disable` | Disable 2FA for the user | Yes |
| POST | `/auth/change-password` | Change password (requires current password) | Yes |

**Register** - `POST /auth/register`
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phoneNumber": "712345678",
  "countryCode": "+971",
  "password": "securepassword",
  "role": "JOB_SEEKER"
}
```

**Login** - `POST /auth/login`
```json
{
  "email": "john@example.com",
  "password": "securepassword"
}
```
Returns: `{ accessToken, user: { id, firstName, lastName, email, roles } }`

### Job Seeker (`/job-seeker`)

All routes require `Authorization: Bearer <token>` header.

| Method | Endpoint | Description | Subscription |
|--------|----------|-------------|-------------|
| GET | `/job-seeker/profile` | Get full profile with skills, CVs, experience, education | None |
| POST | `/job-seeker/profile` | Create job seeker profile | None |
| PUT | `/job-seeker/profile` | Update profile (name, phone, summary, languages, awards, interests) | None |
| POST | `/job-seeker/profile/experience` | Add work experience | None |
| POST | `/job-seeker/profile/education` | Add education entry | None |
| POST | `/job-seeker/profile/certifications` | Add certification | None |
| POST | `/job-seeker/cv` | Upload CV (PDF, multipart/form-data) | None |
| GET | `/job-seeker/cvs` | List all uploaded CVs | None |
| PATCH | `/job-seeker/cvs/:id` | Update CV metadata or replace file | None |
| DELETE | `/job-seeker/cvs/:id` | Delete a CV | None |
| GET | `/job-seeker/cvs/:id/file` | Download/view CV file (download blocked for trial) | None* |
| POST | `/job-seeker/cv/:cvId/extract` | Extract structured data from CV | None |
| POST | `/job-seeker/cv/extract-and-fill` | Extract CV data and auto-fill profile | None |
| GET | `/job-seeker/profile/download-cv` | Download profile as PDF CV | Paid only |
| POST | `/job-seeker/cv/html-to-pdf` | Convert rendered CV template HTML to PDF | Paid only |
| GET | `/job-seeker/dashboard` | Dashboard stats | None |
| POST | `/job-seeker/skill` | Add a skill | None |
| GET | `/job-seeker/skills` | List your skills | None |
| PATCH | `/job-seeker/skills/:id` | Update a skill | None |
| DELETE | `/job-seeker/skills/:id` | Remove a skill | None |
| POST | `/job-seeker/jobs/:jobId/apply` | Apply for a job | Paid only |
| POST | `/job-seeker/jobs/:jobId/external-apply` | Track external job application | Paid only |
| GET | `/job-seeker/jobs/:jobId/external-apply/status` | Check external apply status | None |
| GET | `/job-seeker/jobs/applications` | List your applications | None |
| PATCH | `/job-seeker/jobs/:jobApplicationId/withdraw` | Withdraw application | None |
| GET | `/job-seeker/jobs/suggestions` | AI-suggested jobs | Paid only |
| POST | `/job-seeker/jobs/:jobId/save` | Save a job | Paid only |
| GET | `/job-seeker/jobs/saved-jobs` | List saved jobs | None |
| DELETE | `/job-seeker/jobs/:jobId/save` | Unsave a job | None |
| GET | `/job-seeker/testimonial` | Get user's testimonial | None |
| POST | `/job-seeker/testimonial` | Submit testimonial | None |
| POST | `/job-seeker/subscriptions` | Subscribe to a plan | None |
| GET | `/job-seeker/subscriptions/latest` | Get current subscription + trial info | None |
| GET | `/job-seeker/subscriptions/upgrade-quote` | Get prorated upgrade cost | Active |
| GET | `/job-seeker/subscriptions/invoices` | List subscription invoices with line items | Active |
| GET | `/job-seeker/subscriptions/invoices/:invoiceId` | Get specific invoice details | Active |

\* CV file download with `?download=true` returns 403 for trial users.

### Recruiter (`/recruiter`)

All routes require `Authorization: Bearer <token>` header + recruiter role.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/recruiter/company` | Onboard company |
| POST | `/recruiter/company/industry` | Add industry to company |
| GET | `/recruiter/details` | Get recruiter profile + company |
| GET | `/recruiter/dashboard` | Dashboard stats |
| POST | `/recruiter/job` | Create draft job posting |
| POST | `/recruiter/jobs/bulk` | Bulk create up to 50 jobs at once |
| PATCH | `/recruiter/job/:id` | Update draft job |
| POST | `/recruiter/job/:id/publish` | Publish a job |
| PATCH | `/recruiter/job/:id/suspend` | Suspend a job |
| PATCH | `/recruiter/job/:id/unsuspend` | Unsuspend a job |
| GET | `/recruiter/jobs` | List all your jobs |
| GET | `/recruiter/jobs/:jobId/applications` | View applications for a job |
| GET | `/recruiter/jobs/:jobApplicationId/application/cv` | View applicant's CV |
| PATCH | `/recruiter/jobs/:jobApplicationId/status` | Update application status |
| GET | `/recruiter/jobs/:jobId/suggested-job-seekers` | Get suggested candidates |
| GET | `/recruiter/jobs/:jobId/ai-rankings` | AI-ranked candidates for a job |
| GET | `/recruiter/jobs/:jobId/ai-rankings/:applicationId` | Detailed AI analysis for one applicant |
| POST | `/recruiter/jobs/:jobId/ai-screen` | Trigger AI screening for all applicants |
| POST | `/recruiter/ai-jobs/parse` | AI job description parser |
| POST | `/recruiter/ai-jobs/publish` | Publish AI-parsed job |
| POST | `/recruiter/cv/generate-pdf` | Generate PDF CV from client-supplied data |
| GET | `/recruiter/testimonial` | Get recruiter's testimonial |
| POST | `/recruiter/testimonial` | Submit testimonial |
| GET | `/recruiter/subscriptions/latest` | Get current subscription |
| GET | `/recruiter/subscriptions/upgrade-quote` | Get prorated upgrade cost |
| GET | `/recruiter/subscriptions/invoices` | List subscription invoices with line items |
| GET | `/recruiter/subscriptions/invoices/:invoiceId` | Get specific invoice |

**Recruiter Subscription Gating:**

Most recruiter endpoints are gated behind subscription middleware:

| Middleware | Effect |
|-----------|--------|
| `requireActiveRecruiterSubscription` | Blocks if no active subscription |
| `requirePaidRecruiterSubscription` | Blocks free trial users |
| `requireRecruiterFeature(category, key)` | Checks plan feature flags (e.g. `ai.rankings`, `access.bulkUpload`) |

Feature gating by plan:

| Feature | Free Trial | Silver ($15) | Gold ($30) | Platinum ($50) |
|---------|-----------|-------------|-----------|---------------|
| Active Jobs | 0 | 5 | 20 | Unlimited |
| Job Posting | No | Yes | Yes | Yes |
| Candidate Suggestions | No | Basic | AI-Powered | AI-Powered |
| Bulk Upload | No | No | No | Yes |
| AI Rankings | No | No | Yes | Yes |
| AI Analysis | No | No | Yes | Yes |
| AI Screening | No | No | No | Yes |
| CV PDF Export | No | Yes | Yes | Yes |

**Recruiter CV PDF Export** - `POST /recruiter/cv/generate-pdf`

Accepts CV data built in the frontend CV Builder and generates a PDF using Puppeteer:
```json
{
  "cvData": {
    "personal": { "firstName": "...", "lastName": "...", "title": "...", "email": "...", "phone": "...", "location": "...", "photo": "data:image/..." },
    "summary": "<p>Rich HTML summary...</p>",
    "skills": ["React", "Node.js"],
    "experience": [{ "title": "...", "company": "...", "startDate": "...", "endDate": "...", "current": false, "description": "<p>Rich HTML...</p>" }],
    "education": [{ "degree": "...", "institution": "...", "field": "...", "startYear": "2020", "endYear": "2024" }],
    "certifications": [{ "name": "...", "issuer": "...", "issueYear": "2023" }],
    "links": { "linkedin": "...", "github": "...", "portfolio": "...", "other": "..." }
  },
  "templateId": 36
}
```
Returns: PDF file with `Content-Disposition: attachment`.

### Admin (`/admin`)

All routes require `Authorization: Bearer <token>` header + admin role.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/users` | List all users (supports `?role=RECRUITER&page=1&limit=20`) |
| GET | `/admin/users/stats` | User statistics (total, job seekers, recruiters, pending, suspended) |
| PATCH | `/admin/users/:id` | Update user details (name, email) |
| POST | `/admin/recruiter/approve` | Approve a recruiter |
| POST | `/admin/recruiter/reject` | Reject a recruiter (with reason) |
| PATCH | `/admin/users/:id/status` | Suspend or reactivate a user |
| GET | `/admin/users/:userId/jobs` | Get all jobs posted by a recruiter (looked up by user ID) |
| GET | `/admin/stats` | Platform stats (industries, skills, jobs, mappings, users) |
| POST | `/admin/industries` | Create industry |
| GET | `/admin/industries` | List industries (paginated: `?page=1&limit=20&search=`) |
| GET | `/admin/industries/:id` | Get industry by ID (with full skill details) |
| POST | `/admin/industries/:id/skills` | Add skills to industry |
| POST | `/admin/skills` | Create skill |
| GET | `/admin/skills` | List skills (paginated: `?page=1&limit=20&search=&industryId=`) |
| GET | `/admin/skills/:id` | Get skill by ID (with full industry details) |
| GET | `/admin/jobs` | List all jobs with pagination, filters, search (including recruiter name/email) |
| GET | `/admin/jobs/stats` | Job statistics (total, published, draft, closed, suspended, applications) |
| GET | `/admin/jobs/recruiters` | List recruiters for filter dropdown |
| DELETE | `/admin/jobs/closed` | Delete all closed jobs and related records |
| GET | `/admin/jobs/:id` | Full job details with application breakdown |
| PATCH | `/admin/jobs/:id` | Update job fields (title, description, status, etc.) |
| DELETE | `/admin/jobs/:id` | Hard-delete a job and all related records |
| GET | `/admin/jobs/:id/applications` | Paginated job applications |
| GET | `/admin/testimonials` | List all testimonials |
| PATCH | `/admin/testimonials/:id` | Update testimonial (approve/reject) |
| DELETE | `/admin/testimonials/:id` | Delete testimonial |
| GET | `/admin/leads` | List lead captures (paginated) |
| GET | `/admin/leads/:id/cv` | Download lead's CV |
| PATCH | `/admin/leads/:id` | Update lead (mark reviewed) |
| DELETE | `/admin/leads/:id` | Delete lead |
| GET | `/admin/subscription-management/user/:userId` | Get user's subscription details |
| POST | `/admin/subscription-management/change` | Change user's subscription plan |
| POST | `/admin/subscription-plans` | Create new subscription plan |
| PATCH | `/admin/subscription-plans/:id` | Update subscription plan (name, amount, interval, features) |
| GET | `/admin/invoices` | List all subscription invoices (paginated) |
| GET | `/admin/transactions` | List all payment transactions (paginated, 20/page) |
| GET | `/admin/payment-stats` | Payment statistics |
| POST | `/admin/payment-links` | Generate a payment link for a user |

### Messaging (`/messaging`)

All routes require `Authorization: Bearer <token>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/messaging/conversations` | List user's conversations (sorted by last message) |
| POST | `/messaging/conversations` | Start a new conversation (recruiters/admins only) |
| GET | `/messaging/conversations/:id/messages` | Get messages in a conversation (paginated) |
| POST | `/messaging/conversations/:id/messages` | Send a message in a conversation |
| POST | `/messaging/conversations/:id/read` | Mark conversation as read |
| GET | `/messaging/unread-count` | Get total unread message count |
| GET | `/messaging/searchable-users` | Search users to start a conversation with |
| GET | `/messaging/contacts` | List messaging contacts |
| GET | `/messaging/recruiter-jobs` | Get recruiter's jobs for messaging context |
| GET | `/messaging/job-applicants/:jobId` | Get job applicants for messaging |
| POST | `/messaging/diamond-inquiry` | Send diamond plan inquiry |

**Start Conversation** - `POST /messaging/conversations`
```json
{
  "participantId": "user-uuid",
  "jobId": "job-uuid (optional)"
}
```
Job seekers cannot initiate conversations (403). Only recruiters and admins can start new conversations.

**Send Message** - `POST /messaging/conversations/:id/messages`
```json
{
  "body": "Hello, I'd like to discuss the position..."
}
```

**Contact Info Filtering:**
- Email addresses and phone numbers (7+ digits) are automatically stripped from message bodies before sending
- The response includes `contactInfoStripped: true` when content was filtered
- Admin users bypass contact filtering
- Contact info sharing is only allowed when BOTH participants are on Platinum subscriptions

**Job Seeker Messaging Restrictions:**
- Job seekers cannot initiate conversations — they can only respond when contacted by a recruiter or admin
- Job seekers must have a **Platinum subscription** to send messages. Non-Platinum job seekers receive a 403 with `{ requiresUpgrade: true }`

### Real-Time Messaging (Socket.io)

The server uses Socket.io for real-time message delivery over WebSocket connections.

**Connection:**
```javascript
const socket = io("wss://api.hiregenix.ai", {
  auth: { token: "jwt-access-token" }
});
```

**Events:**
| Event | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `connection` | Client→Server | JWT in auth | Authenticated connection, joins `user:{userId}` room |
| `new_message` | Server→Client | `{ message, conversationId }` | New message received |
| `typing` | Client→Server | `{ conversationId, userId }` | User is typing indicator |
| `user_typing` | Server→Client | `{ conversationId, userId }` | Another user is typing |
| `join_conversation` | Client→Server | `conversationId` | Join a conversation room |
| `leave_conversation` | Client→Server | `conversationId` | Leave a conversation room |

**Authentication:** Socket connections require a valid JWT token in the `auth.token` field. Invalid tokens are rejected with a connection error.

### Public (`/public`)

No authentication required.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/public/jobs` | Browse all published jobs |
| GET | `/public/jobs/ai-search` | AI-powered job search |
| GET | `/public/jobs/:id` | Get single job details |
| GET | `/public/subscriptions` | List available subscription plans |
| GET | `/public/companies` | List companies |
| GET | `/public/companies/:id` | Get company details |
| GET | `/public/companies/:id/jobs` | Get company's jobs |
| GET | `/public/industries/taxonomy` | Get industry taxonomy tree |
| GET | `/public/industries` | List all industries |
| GET | `/public/testimonials` | List approved testimonials |
| POST | `/public/lead-capture` | Submit lead capture form |
| GET | `/public/lead-recommendations/:leadId` | Get job recommendations for lead |
| GET | `/public/check-email` | Check if email exists |
| GET | `/public/payment-status/:reference` | Check payment status |
| POST | `/public/gateway/callback` | Payment gateway webhook |

### Pagination

The `GET /admin/industries` and `GET /admin/skills` endpoints support server-side pagination:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | int | 1 | Page number (1-based) |
| `limit` | int | 20 | Items per page (max 100) |
| `search` | string | "" | Filter by name (case-insensitive partial match) |
| `industryId` | string | "" | Filter skills by industry (skills endpoint only) |

**Response format:**
```json
{
  "status": "SUCCESS",
  "data": [...],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 7366,
    "totalPages": 369,
    "hasNext": true,
    "hasPrev": false
  }
}
```

List endpoints return `_count` for relations (e.g. `_count.skills` for industries) instead of full nested objects. Detail endpoints (`/:id`) return full nested data for editing.

### Admin Stats

`GET /admin/stats` returns fast counts for all major entities. Industry and industry-skill mapping counts are filtered to only include priority=1 (flattened/top-level) industries:

```json
{
  "status": "SUCCESS",
  "data": {
    "industries": 7366,
    "skills": 4773,
    "jobs": 10036,
    "mappings": 1383730,
    "users": 3,
    "jobSeekers": 1,
    "recruiters": 1
  }
}
```

## CV Extraction Engine

The CV extractor parses uploaded PDF resumes and returns structured data. It supports all industries out of the box.

**Three Extraction Providers (with fallback chain):**
1. **AI-enhanced extraction** (primary) - Claude or GPT-4o for highest accuracy
2. **Affinda Resume Parser** (fallback) - when `AFFINDA_API_KEY` is set, used as secondary provider
3. **Regex/heuristic extraction** (final fallback) - pattern matching, no API key required

**Extracted Fields:**
- Contact information (name, email, phone, location)
- Professional summary
- Skills (any industry, with semantic normalization — 200+ alias mappings)
- Work experience (with dates, company, description)
- Education (degrees, institutions, years)
- Certifications & licenses
- Languages (with proficiency levels)
- Awards & achievements
- Interests

**Smart Profile Fill:**
- **Merge-not-overwrite**: Re-extracting a CV does not destroy existing profile data. Experience, education, and certifications are matched by key fields (company+title, institution+degree, cert name) and only new entries are added.
- **Semantic skill normalization**: "js", "javascript", "Java Script" all map to the canonical "JavaScript" skill. The normalizer has 200+ alias mappings.
- **Proficiency inference**: Skill proficiency is automatically inferred from total years of experience (BEGINNER/INTERMEDIATE/ADVANCED/EXPERT).

**Server-Side PDF Export:**
- `GET /job-seeker/profile/download-cv?templateId=X` generates a PDF from profile data via Puppeteer (7 built-in templates)
- `POST /job-seeker/cv/html-to-pdf` converts any rendered CV template HTML to PDF — used by the frontend CV Builder to export exactly what the user sees (35 templates)
- `POST /recruiter/cv/generate-pdf` generates PDF from recruiter-supplied CV data with the orange brand template
- The HTML-to-PDF endpoint sets viewport to A4 dimensions (794×1123px), loads Google Fonts, and renders with zero margins for pixel-perfect output
- All PDF export endpoints are gated behind paid subscription

**Test Harness:**
- `node tests/cvExtractionTest.js` runs extraction against sample CVs and reports field coverage per CV

**Supported Industry Certifications:**
The extractor recognizes certification keywords across all sectors:
- **Tech**: AWS, Azure, GCP, Cisco, CompTIA, Microsoft, Google, Oracle, ITIL, Scrum, Kubernetes
- **Project Management**: PMP, CAPM, Six Sigma, Lean, PMBOK, PRINCE2
- **Finance & Accounting**: CFA, CPA, ACCA, CIMA, CFP, FRM
- **Healthcare & Medical**: BLS, ACLS, PALS, RN, LPN, CNA, CPR, First Aid, HIPAA
- **Legal**: Bar Admission, Paralegal, Notary, Compliance
- **Construction & Engineering**: OSHA, NEBOSH, IOSH, LEED, Safety, Hazmat
- **Hospitality & Food**: HACCP, ServSafe, Food Safety, Hygiene, Sommelier
- **Education**: TEFL, TESOL, CELTA, Teaching
- **HR & Management**: SHRM, CIPD, SPHR, PHR, Coaching
- **Real Estate**: RERA, Property, Valuation
- **Marketing & Digital**: HubSpot, Salesforce, SEO, AdWords, Analytics
- **Logistics & Supply Chain**: CSCP, CPIM, CLTD

**Detected CV Sections:**
Skills, Experience, Education, Certifications, Summary, Projects, Languages, Volunteer, Publications, Awards, References (plus variations like Clinical Experience, Teaching Experience, etc.)

## AI Matching Engine

The AI matching engine ranks candidates against job postings using a weighted scoring model:

| Factor | Weight | How It Works |
|--------|--------|-------------|
| Skills Match | 35% | Exact match, synonym detection, fuzzy matching, transferable skills |
| Experience | 25% | Years of experience vs. job requirements |
| Education | 15% | Degree level and field relevance |
| Semantic Fit | 25% | CV content alignment with job description |

**Features:**
- Works algorithmically without any API keys
- Optional AI enhancement when Anthropic or OpenAI keys are configured
- Plagiarism detection: JD copy-paste, cross-candidate duplicates, keyword stuffing
- Red/green flag detection for candidate quality signals
- Star ratings (1-5) with detailed reasoning

## Subscription System

### Job Seeker Plans

| Plan | Price | Duration | Key Features |
|------|-------|----------|-------------|
| Free Trial | $0 | 7 days | Browse jobs, build CV (save only), manage profile. No apply, no save jobs, no suggestions, no PDF export |
| Silver | $10/mo | 30 days | 5 saved jobs, basic CV builder, job applications, standard visibility |
| Gold | $20/mo | 30 days | 30 saved jobs, all templates, AI match scores, priority visibility |
| Platinum | $30/mo | 30 days | Unlimited saved jobs, all AI features, skill gap analysis, Dubai market insights |

### Recruiter Plans

| Plan | Price | Duration | Key Features |
|------|-------|----------|-------------|
| Free Trial | $0 | 7 days | Dashboard access only. No job posting, no candidate suggestions |
| Silver | $15/mo | 30 days | 5 active jobs, basic candidate suggestions, application management, CV PDF export |
| Gold | $30/mo | 30 days | 20 active jobs, AI-powered candidate suggestions, AI rankings + analysis, CV PDF export |
| Platinum | $50/mo | 30 days | Unlimited active jobs, all AI features (rankings, analysis, screening), bulk upload, CV PDF export |
| Diamond | $99/mo | 30 days | All Platinum features + dedicated recruiter services, custom candidate search, company representation |
| Diamond Compact | $240/mo | 30 days | Diamond features with 3 recruiter seats |
| Diamond Compact Plus | $350/mo | 30 days | Diamond features with 5 recruiter seats |
| Diamond Unlimited | $9,900/yr | 1 year | Diamond features with unlimited recruiter seats |

### Free Trial Flow

1. **Auto-granted on registration** — when a JOB_SEEKER or RECRUITER registers, a 7-day trial subscription is automatically created (no payment required)
2. **Trial restrictions** — trial users are blocked from: applying for jobs, saving jobs, AI suggestions, and PDF export (CV download with `?download=true`)
3. **Auto-expires** — the existing `expiresAt > now` check in the subscription middleware handles expiry automatically
4. **Trial to paid** — when a trial user subscribes to a paid plan, the payment gateway callback expires all ACTIVE subscriptions (including trial) and activates the new plan

### Automatic Subscription Expiry

The server runs two automatic expiry mechanisms to keep subscription statuses accurate in the database:

1. **Hourly cron job** (`0 * * * *`) — every hour, marks any `ACTIVE` subscription whose `expiresAt <= now` as `EXPIRED`. This applies to both job seeker and recruiter subscriptions.
2. **Startup check** — on server boot, immediately expires any stale subscriptions that expired while the server was down.

This ensures the database status stays consistent with actual expiry dates. The middleware also performs runtime checks (`expiresAt > now`) on every request as a second layer of protection.

### Subscription Response

`GET /job-seeker/subscriptions/latest` returns:
```json
{
  "error": false,
  "message": "Latest subscription found",
  "result": {
    "subscription": { "id": "...", "plan": { "name": "Free Trial", ... }, ... },
    "isActiveNow": true,
    "isTrial": true,
    "trialDaysLeft": 5
  }
}
```

### Middleware Chain

**Job Seeker:**
- `requireActiveJobSeekerSubscription` — blocks if no active subscription; sets `req.isTrial`, `req.planName`
- `requirePaidSubscription` — runs after the above; blocks trial users with 403 `{ requiresUpgrade: true }`
- `getSubscriptionInfo` — non-blocking; attaches subscription info to `req` without gating access
- `enforceSavedJobsLimit` — checks saved jobs count against plan limits

**Recruiter:**
- `requireActiveRecruiterSubscription` — blocks if no active subscription; attaches `req.subscriptionFeatures`
- `requirePaidRecruiterSubscription` — blocks free trial users
- `requireRecruiterFeature(category, key)` — checks feature flags from plan (e.g. `ai.rankings`, `access.bulkUpload`). Returns 403 with `{ requiresUpgrade: true, feature }` when blocked
- `enforceActiveJobsLimit` — checks active jobs count against plan limit (`access.activeJobs`)

## Lead Capture System

The lead capture system allows potential users to submit their information and CV before registering, enabling the platform to provide job recommendations and follow up with leads.

- **Submit lead**: `POST /public/lead-capture` accepts name, email, phone, CV file, and optional fields (experience level, preferred industry, etc.)
- **Job recommendations**: `GET /public/lead-recommendations/:leadId` returns matching job suggestions based on the lead's submitted information
- **Admin management**: Admins can list leads (`GET /admin/leads`), download CVs (`GET /admin/leads/:id/cv`), mark leads as reviewed (`PATCH /admin/leads/:id`), and delete leads (`DELETE /admin/leads/:id`)

## Testimonials System

Users (both job seekers and recruiters) can submit testimonials that are reviewed by admins before being displayed publicly.

- **Submit**: Job seekers (`POST /job-seeker/testimonial`) and recruiters (`POST /recruiter/testimonial`) can submit testimonials
- **View own**: Users can retrieve their submitted testimonial via `GET /job-seeker/testimonial` or `GET /recruiter/testimonial`
- **Public display**: Approved testimonials are listed at `GET /public/testimonials`
- **Admin review**: Admins can list all testimonials (`GET /admin/testimonials`), approve or reject them (`PATCH /admin/testimonials/:id`), and delete them (`DELETE /admin/testimonials/:id`)

## Data Model Notes

- **Experience, Education, Certifications, Languages, Awards, Interests** are stored as JSON fields on the `JobSeeker` model (not separate tables). CV extraction populates these directly.
- **Summary** is stored as a `Text` field on `JobSeeker` for professional summaries extracted from CVs.
- **CV extracted data** is stored in the `extractedData` JSON field on `JobSeekerCV`, preserving the raw extraction result.
- **Industry-Skill mappings** use a many-to-many `IndustrySkill` join table. The platform currently has ~1.38M mappings across 7,366 industries and 4,773 skills.
- **User roles** use a separate `UserRole` relation table (not a direct `role` field on User).

## Security

- JWT-based authentication on all protected routes
- Role-based authorization (Admin, Recruiter, Job Seeker)
- CORS restricted to production domains (api/jobseeker/recruiter/dashboard.hiregenix.ai)
- Deactivated users are blocked from logging in
- Rate limiting: 200 req/15min global, 20 req/15min for auth
- File upload restricted to PDF only with size limits
- Path traversal prevention on file serving
- Two-Factor Authentication (TOTP-based 2FA) with QR code setup
- Password change with current password verification
- Password hashing with bcryptjs (12 rounds)

## Project Structure

```
├── controllers/
│   ├── admin/          # Admin endpoints (users, industries, skills)
│   ├── ai/             # AI matching engine, CV extractor, skill normalizer
│   ├── auth/           # Login, register, password reset, 2FA, change password
│   ├── jobSeeker/      # Profile, CVs, applications, skills, dashboard
│   ├── messaging/      # In-app messaging (conversations, messages, contact filtering)
│   ├── recruiter/      # Company, jobs, applications, AI rankings
│   └── subscriptions/  # Subscription management
├── middlewares/         # Auth, validation, subscription, upload
├── payments/           # Payment gateway integration
├── prisma/             # Schema & migrations
├── routes/             # Route definitions
├── tests/              # Extraction test harness
├── uploads/            # CV file storage (gitignored)
└── server.js           # App entry point (Express + Socket.io)
```

## Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| Global | 200 requests | 15 minutes |
| Auth endpoints | 20 requests | 15 minutes |
