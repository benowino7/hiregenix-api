const jwt = require("jsonwebtoken");

/**
 * Middleware to verify JWT access token
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      status: "FAIL",
      message: "Access token missing",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user info to request
    req.user = decoded; 
    next();
  } catch (error) {
    return res.status(401).json({
      status: "FAIL",
      message: "Invalid or expired token",
    });
  }
};

/**
 * Middleware to allow only recruiters
 */
const recruiterOnly = (req, res, next) => {
  if (!req.user || !req.user.roles.includes("RECRUITER")) {
    return res.status(403).json({
      status: "FAIL",
      message: "Only recruiters can access this resource",
    });
  }

  next();
};

/**
 * Middleware to allow only admins
 */
const adminOnly = (req, res, next) => {
  if (!req.user || !req.user.roles.includes("ADMIN")) {
    return res.status(403).json({
      status: "FAIL",
      message: "Only admins can access this resource",
    });
  }

  next();
};

/**
 * Middleware to allow only job seekers
 */
const jobSeekerOnly = (req, res, next) => {
  if (!req.user || !req.user.roles.includes("JOB_SEEKER")) {
    return res.status(403).json({
      status: "FAIL",
      message: "Only job seekers can access this resource",
    });
  }

  next();
};

module.exports = {
  authenticate,
  recruiterOnly,
  adminOnly,
  jobSeekerOnly,
}
