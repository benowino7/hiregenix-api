const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(), // easiest (your code supports buffer)
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed"));
    }
    cb(null, true);
  },
});

module.exports = upload;
