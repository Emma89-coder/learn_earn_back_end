const express = require('express');
const multer = require('multer');
const { extractQuestionsFromPDF } = require('../../utils/pdfExtractor');

// Router with mergeParams enabled to inherit parent params
const router = express.Router({ mergeParams: true });

// Configure multer for file upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept PDF files
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

/**
 * POST /extract-questions
 * Extract questions from uploaded PDF
 * Requires: authentication and admin role
 */
router.post('/extract-questions', upload.single('pdf'), async (req, res) => {
  console.log('Extract questions endpoint called');
  
  try {
    // Check if file was uploaded
    if (!req.file) {
      console.log('No file uploaded');
      return res.status(400).json({
        success: false,
        message: 'No file uploaded. Please select a PDF file to upload.'
      });
    }
    
    console.log(`File received: ${req.file.originalname}, size: ${req.file.size} bytes, type: ${req.file.mimetype}`);
    
    // Validate file type
    if (req.file.mimetype !== 'application/pdf') {
      console.log('Invalid file type:', req.file.mimetype);
      return res.status(400).json({
        success: false,
        message: 'Invalid file type. Please upload a PDF file.'
      });
    }
    
    // Validate file size
    if (req.file.size > 15 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum file size is 15MB.'
      });
    }
    
    // Extract questions from PDF
    console.log('Processing PDF...');
    const questions = await extractQuestionsFromPDF(req.file.buffer);
    
    if (!questions || questions.length === 0) {
      console.log('No questions extracted');
      return res.status(400).json({
        success: false,
        message: 'No questions could be extracted from the PDF. Please check the file format.'
      });
    }
    
    console.log(`Successfully extracted ${questions.length} questions`);
    
    // Format questions for frontend
    const formattedQuestions = questions.map((q, index) => ({
      id: `${Date.now()}-${index}`,
      question: (q.question || '').trim(),
      questionImage: q.questionImage || null,
      options: (q.options || []).map(opt => (opt || '').trim()),
      correctAnswer: (q.correctAnswer || '').trim(),
      layout: 'text-first'
    }));
    
    // Return success response
    return res.status(200).json({
      success: true,
      message: `Successfully extracted ${formattedQuestions.length} questions from PDF`,
      questions: formattedQuestions,
      totalQuestions: formattedQuestions.length
    });
    
  } catch (error) {
    console.error('PDF extraction error:', error);
    
    // Return detailed error message
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to extract questions from PDF',
      error: error.toString()
    });
  }
});

module.exports = router;
