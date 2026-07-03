// backend/routes/admin/ai.js
const express = require('express');
const router = express.Router();

// Import middleware from the correct path
const { authenticateToken, isAdmin } = require('../../middleware/auth');

// Mock AI responses
const mockAI = {
  generateQuestions: (topic, subject, difficulty, count) => {
    try {
      // Validate inputs
      if (!topic) {
        throw new Error('Topic is required for question generation');
      }
      
      // Ensure count is reasonable
      const questionCount = Math.min(Math.max(1, parseInt(count) || 5), 20);
      const questions = [];
      
      for (let i = 0; i < questionCount; i++) {
        questions.push({
          id: `ai-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`,
          question: `What is a key concept in ${topic}? (Question ${i + 1})`,
          options: [
            `Correct answer about ${topic}`,
            `Common misconception about ${topic}`,
            `Related but incorrect concept`,
            `Unrelated fact`
          ],
          correctAnswer: `Correct answer about ${topic}`,
          layout: 'text-first',
          questionImage: '',
          explanation: `This is the correct answer because it relates to ${topic}`,
          difficulty: difficulty || 'medium',
          subject: subject || 'general'
        });
      }
      return questions;
    } catch (error) {
      console.error('Error in generateQuestions:', error);
      throw error;
    }
  },
  
  improveQuestion: (question, options, correctAnswer) => {
    return {
      improvedQuestion: `${question} (Improved: Be more specific...)`,
      improvedOptions: [...options],
      improvedCorrectAnswer: correctAnswer,
      suggestedDistractors: ["Distractor 1", "Distractor 2", "Distractor 3"],
      hint: "Think about the key principle here.",
      score: 85,
      issues: ["Consider making the question more specific"]
    };
  },
  
  estimateDifficulty: (question, subject) => {
    return {
      difficulty: 'intermediate',
      confidence: 0.75,
      reasons: ["Appropriate vocabulary level", "Moderate concept depth"]
    };
  },
  
  validateQuestion: (question, options, correctAnswer) => {
    const issues = [];
    let score = 100;
    
    if (!question || question.length < 10) {
      issues.push("Question is too short or missing");
      score -= 20;
    }
    if (question && !question.includes('?')) {
      issues.push("Question should end with a question mark");
      score -= 15;
    }
    
    if (!options || !Array.isArray(options) || options.length < 2) {
      issues.push("At least 2 options are required");
      score -= 30;
    } else {
      const uniqueOptions = new Set(options);
      if (uniqueOptions.size < options.length) {
        issues.push("Duplicate options detected");
        score -= 25;
      }
    }
    
    if (!correctAnswer) {
      issues.push("Correct answer is missing");
      score -= 30;
    }
    
    return {
      isValid: score >= 60,
      score: Math.max(0, score),
      issues,
      suggestions: issues.map(i => `Fix: ${i}`)
    };
  }
};

// Health check endpoint
router.get('/health', authenticateToken, isAdmin, (req, res) => {
  try {
    res.json({
      success: true,
      status: 'AI Service Running',
      timestamp: new Date().toISOString(),
      endpoints: [
        'POST /api/ai/generate-questions',
        'POST /api/ai/extract-from-text',
        'POST /api/ai/improve-question',
        'POST /api/ai/generate-distractors',
        'POST /api/ai/add-hint',
        'POST /api/ai/validate-question',
        'POST /api/ai/check-plagiarism',
        'POST /api/ai/estimate-difficulty',
        'POST /api/ai/reformat-options',
        'POST /api/ai/extract-question'
      ]
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ success: false, error: 'Health check failed' });
  }
});

// Generate questions from topic
router.post('/generate-questions', authenticateToken, isAdmin, async (req, res) => {
  try {
    console.log('Generate questions request received:', req.body);
    
    const { topic, subject, difficulty, count = 5 } = req.body;
    
    // Validate required fields
    if (!topic) {
      return res.status(400).json({ 
        success: false, 
        error: 'Topic is required',
        code: 'MISSING_TOPIC'
      });
    }
    
    // Validate and sanitize count
    let questionCount = parseInt(count);
    if (isNaN(questionCount) || questionCount < 1) {
      questionCount = 5;
    }
    if (questionCount > 20) {
      questionCount = 20;
    }
    
    // Generate questions with timeout
    const questions = await Promise.race([
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(mockAI.generateQuestions(topic, subject, difficulty, questionCount));
        }, 100);
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Generation timeout')), 10000)
      )
    ]);
    
    // Validate generated questions
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      throw new Error('No questions were generated');
    }
    
    console.log(`Successfully generated ${questions.length} questions`);
    
    res.json({ 
      success: true, 
      questions,
      metadata: {
        count: questions.length,
        topic,
        subject: subject || 'general',
        difficulty: difficulty || 'medium',
        generatedAt: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('AI generation error:', error);
    
    // Send appropriate error response
    const statusCode = error.message === 'Generation timeout' ? 504 : 500;
    res.status(statusCode).json({ 
      success: false, 
      error: 'Failed to generate questions',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      code: error.message === 'Generation timeout' ? 'TIMEOUT' : 'GENERATION_FAILED'
    });
  }
});

// Generate questions from text
router.post('/extract-from-text', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { text, count = 5 } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid text is required' });
    }
    
    if (text.length < 50) {
      return res.status(400).json({ success: false, error: 'Text should be at least 50 characters long' });
    }
    
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
    
    if (sentences.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid sentences found in text' });
    }
    
    let questionCount = Math.min(parseInt(count) || 5, sentences.length, 10);
    const questions = [];
    
    for (let i = 0; i < questionCount; i++) {
      questions.push({
        id: `ai-text-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 5)}`,
        question: `Based on: "${sentences[i].substring(0, 100)}..." What is the main idea?`,
        options: [
          "The primary concept discussed",
          "A supporting detail",
          "An unrelated conclusion",
          "A contradictory statement"
        ],
        correctAnswer: "The primary concept discussed",
        layout: 'text-first',
        questionImage: '',
        explanation: "This can be customized based on the text content"
      });
    }
    
    res.json({ success: true, questions });
  } catch (error) {
    console.error('AI text extraction error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate questions from text' });
  }
});

// Improve existing question
router.post('/improve-question', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { question, options, correctAnswer } = req.body;
    
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid question is required' });
    }
    
    const result = mockAI.improveQuestion(question, options, correctAnswer);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('AI improvement error:', error);
    res.status(500).json({ success: false, error: 'Failed to improve question' });
  }
});

// Generate distractors
router.post('/generate-distractors', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { question, correctAnswer, count = 3 } = req.body;
    
    if (!question || !correctAnswer) {
      return res.status(400).json({ success: false, error: 'Question and correct answer are required' });
    }
    
    const distractors = [
      `Common misconception about this topic`,
      `Frequently confused concept`,
      `Partially correct but incomplete answer`
    ].slice(0, Math.min(count, 3));
    
    res.json({ success: true, distractors });
  } catch (error) {
    console.error('Generate distractors error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate distractors' });
  }
});

// Add hint
router.post('/add-hint', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { question, correctAnswer } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }
    
    const hint = `💡 Hint: Review the key concepts related to this topic. Think about what makes the correct answer right.`;
    res.json({ success: true, hint });
  } catch (error) {
    console.error('Add hint error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate hint' });
  }
});

// Validate question
router.post('/validate-question', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { question, options, correctAnswer } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required for validation' });
    }
    
    const result = mockAI.validateQuestion(question, options, correctAnswer);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Validate question error:', error);
    res.status(500).json({ success: false, error: 'Failed to validate question' });
  }
});

// Check plagiarism
router.post('/check-plagiarism', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }
    
    const similarity = 0.1;
    res.json({ 
      success: true, 
      similarity: similarity,
      matches: [],
      message: "Question appears original",
      isOriginal: similarity < 0.3
    });
  } catch (error) {
    console.error('Plagiarism check error:', error);
    res.status(500).json({ success: false, error: 'Failed to check plagiarism' });
  }
});

// Estimate difficulty
router.post('/estimate-difficulty', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { question, subject } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }
    
    const result = mockAI.estimateDifficulty(question, subject);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Estimate difficulty error:', error);
    res.status(500).json({ success: false, error: 'Failed to estimate difficulty' });
  }
});

// Reformat options
router.post('/reformat-options', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { options } = req.body;
    
    if (!options || !Array.isArray(options)) {
      return res.status(400).json({ success: false, error: 'Options array is required' });
    }
    
    if (options.length < 2) {
      return res.status(400).json({ success: false, error: 'At least 2 options are required' });
    }
    
    const letters = ['A', 'B', 'C', 'D'];
    const reformatted = options.map((opt, idx) => {
      if (typeof opt !== 'string') return `${letters[idx]}. `;
      const cleaned = opt.replace(/^[A-D][\.\)\-\s]*/i, '').trim();
      return `${letters[idx]}. ${cleaned || 'Option'}`;
    });
    
    while (reformatted.length < 4) {
      reformatted.push(`${letters[reformatted.length]}. Option ${reformatted.length + 1}`);
    }
    
    res.json({ success: true, reformatted: reformatted.slice(0, 4) });
  } catch (error) {
    console.error('Reformat options error:', error);
    res.status(500).json({ success: false, error: 'Failed to reformat options' });
  }
});

// Extract question from text
router.post('/extract-question', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid text is required' });
    }
    
    const questionMatch = text.match(/^(.+?)\?/);
    const question = questionMatch ? questionMatch[1] + '?' : text.substring(0, 100);
    
    const optionMatches = text.match(/[A-D][\.\)\-\s]+([^A-D]+)/gi);
    let options = ['', '', '', ''];
    
    if (optionMatches && optionMatches.length >= 2) {
      options = optionMatches.slice(0, 4).map(opt => 
        opt.replace(/^[A-D][\.\)\-\s]*/i, '').trim()
      );
    }
    
    // Filter out empty options
    options = options.filter(opt => opt.length > 0);
    
    res.json({
      success: true,
      question,
      options: options.length >= 2 ? options : ['Option 1', 'Option 2', 'Option 3', 'Option 4'],
      correctAnswer: options[0] || 'Option 1'
    });
  } catch (error) {
    console.error('Extract question error:', error);
    res.status(500).json({ success: false, error: 'Failed to extract question' });
  }
});

module.exports = router;
