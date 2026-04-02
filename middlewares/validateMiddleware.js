// src/middlewares/validateRequest.js
const { validationResult } = require("express-validator");

module.exports = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    // Map errors to { field: "fieldName", message: "error message" }
    const formattedErrors = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));

    return res.status(400).json({
      status: "FAIL",
      errors: formattedErrors,
    });
  }

  next();
};
