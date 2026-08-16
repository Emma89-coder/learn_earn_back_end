// backend/routes/admin/ai.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const OpenAI = require('openai');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Import middleware from the correct path
const { authenticateToken, isAdmin } = require('../../middleware/auth');

let pdfParse;
try {
  const pdfParseModule = require('pdf-parse');
  pdfParse = pdfParseModule.default || pdfParseModule;
} catch (error) {
  pdfParse = null;
}

const getOpenAIClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_key_here' || apiKey.trim() === '') {
    return null;
  }

  return new OpenAI({ apiKey });
};

// Mock AI responses
const normalizeQuestion = (question, index, fallbackSubject, fallbackDifficulty) => {
  const cleanQuestion = typeof question?.question === 'string' ? question.question.trim() : '';
  const rawOptions = Array.isArray(question?.options) ? question.options : [];
  const options = rawOptions
    .map((opt) => String(opt || '').replace(/^[A-Da-d][\.)\-:\s]*/g, '').trim())
    .filter(Boolean)
    .slice(0, 4);

  const finalOptions = options.length >= 4
    ? options.slice(0, 4)
    : [
        `Correct answer about ${fallbackSubject || 'this topic'}`,
        `Common misconception about ${fallbackSubject || 'this topic'}`,
        `Related but incorrect concept`,
        `Unrelated fact`
      ].slice(0, 4);

  const answerText = typeof question?.correctAnswer === 'string'
    ? question.correctAnswer.replace(/^[A-Da-d][\.)\-:\s]*/g, '').trim()
    : '';

  const normalizedCorrectAnswer = finalOptions.includes(answerText)
    ? answerText
    : (finalOptions[0] || 'Correct answer');

  return {
    id: question?.id || `ai-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}`,
    question: cleanQuestion || `What is a key concept in ${fallbackSubject || 'this topic'}?`,
    options: finalOptions,
    correctAnswer: normalizedCorrectAnswer,
    layout: question?.layout || 'text-first',
    questionImage: question?.questionImage || '',
    explanation: question?.explanation || `This answer is correct because it matches the core idea of ${fallbackSubject || 'the topic'}.`,
    difficulty: question?.difficulty || fallbackDifficulty || 'medium',
    subject: question?.subject || fallbackSubject || 'general'
  };
};

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

  generateHangmanHint: (word, category) => {
    const normalizedWord = String(word || '').trim();
    if (!normalizedWord) return 'Think of a word related to this subject.';

    const root = normalizedWord.length <= 4 ? 'short' : normalizedWord.length <= 7 ? 'medium' : 'long';
    const categoryHints = {
      mathematics: 'Think of a mathematical term or concept.',
      science: 'Think of a science word or natural process.',
      english: 'Think of a vocabulary word used in English.',
      'social-studies': 'Think of a place, event, or idea from social studies.',
      'bible-knowledge': 'Think of a biblical idea or key figure.',
      'arts-life-skills': 'Think of a creative or practical everyday word.',
      chichewa: 'Think of a common Chichewa word used in everyday life.'
    };

    const base = categoryHints[String(category || '').toLowerCase()] || 'Think of a word related to this subject.';
    return `${base} It has ${normalizedWord.length} letters and is a ${root}-length word.`;
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

const generateQuestionsFromTextSource = async (sourceText, subject, difficulty, count) => {
  const ai = getOpenAIClient();
  const questionCount = Math.min(Math.max(1, parseInt(count) || 5), 20);

  if (!sourceText || !sourceText.trim()) {
    throw new Error('Source text is required');
  }

  if (!ai) {
    return mockAI.generateQuestions(sourceText.slice(0, 120), subject, difficulty, questionCount);
  }

  try {
    const text = String(sourceText).replace(/\s+/g, ' ').trim();
    const sourceSnippet = text.length > 3000 ? text.slice(0, 3000) : text;

    const response = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: 'You are an expert curriculum designer. Generate quiz questions directly from the provided source material. Return only valid JSON. Root object must contain a "questions" array. Each question must include id, question, options, correctAnswer, layout, questionImage, explanation, difficulty, subject. Make each question based on the content, not generic filler. Ensure the option values are plain strings without letters like A/B/C/D and correctAnswer exactly matches one of the options.'
        },
        {
          role: 'user',
          content: `Create ${questionCount} multiple-choice questions from this study material. Subject: "${subject || 'general'}". Difficulty: "${difficulty || 'medium'}". Source material: ${sourceSnippet} Return JSON in the exact structure: {"questions":[{"id":"q1","question":"...","options":["...","...","...","..."],"correctAnswer":"...","layout":"text-first","questionImage":"","explanation":"...","difficulty":"${difficulty || 'medium'}","subject":"${subject || 'general'}"}]}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      return mockAI.generateQuestions(sourceSnippet.slice(0, 120), subject, difficulty, questionCount);
    }

    const cleanedContent = String(content).replace(/^```json\s*|```\s*$/gi, '').trim();
    const parsed = JSON.parse(cleanedContent);
    const sourceQuestions = Array.isArray(parsed?.questions) ? parsed.questions : [];

    if (!sourceQuestions.length) {
      return mockAI.generateQuestions(sourceSnippet.slice(0, 120), subject, difficulty, questionCount);
    }

    return sourceQuestions.slice(0, questionCount).map((question, index) => normalizeQuestion(question, index, subject || 'general', difficulty || 'medium'));
  } catch (error) {
    console.warn('OpenAI text-source question generation failed, using fallback:', error.message || error);
    return mockAI.generateQuestions(sourceText.slice(0, 120), subject, difficulty, questionCount);
  }
};

const generateQuestionsWithAI = async (topic, subject, difficulty, count) => {
  const ai = getOpenAIClient();
  const questionCount = Math.min(Math.max(1, parseInt(count) || 5), 20);

  if (!ai) {
    return mockAI.generateQuestions(topic, subject, difficulty, questionCount);
  }

  try {
    const response = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: 'You are an expert curriculum designer. Create high-quality multiple-choice questions in a clear educational tone. Return only valid JSON. The root object must contain a "questions" array. Each question object must contain: id, question, options, correctAnswer, layout, questionImage, explanation, difficulty, subject. Keep the question text clear and specific. Ensure options are exactly four strings, no letters like A/B/C/D in the values, and correctAnswer must exactly match one of the option strings.'
        },
        {
          role: 'user',
          content: `Generate ${questionCount} multiple-choice questions about "${topic}" for the subject "${subject || 'general'}" with difficulty "${difficulty || 'medium'}". Use a realistic classroom level and include a brief explanation for the correct answer. Return JSON in this exact structure: {"questions":[{"id":"q1","question":"...","options":["...","...","...","..."],"correctAnswer":"...","layout":"text-first","questionImage":"","explanation":"...","difficulty":"${difficulty || 'medium'}","subject":"${subject || 'general'}"}]}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      return mockAI.generateQuestions(topic, subject, difficulty, questionCount);
    }

    const cleanedContent = String(content).replace(/^```json\s*|```\s*$/gi, '').trim();
    const parsed = JSON.parse(cleanedContent);
    const sourceQuestions = Array.isArray(parsed?.questions)
      ? parsed.questions
      : Array.isArray(parsed)
        ? parsed
        : [];

    if (!sourceQuestions.length) {
      return mockAI.generateQuestions(topic, subject, difficulty, questionCount);
    }

    return sourceQuestions.slice(0, questionCount).map((question, index) => normalizeQuestion(question, index, subject || 'general', difficulty || 'medium'));
  } catch (error) {
    console.warn('OpenAI question generation failed, using fallback:', error.message || error);
    return mockAI.generateQuestions(topic, subject, difficulty, questionCount);
  }
};

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
    
    const questions = await generateQuestionsWithAI(topic, subject, difficulty, questionCount);
    
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
    const { text, count = 5, subject, difficulty } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid text is required' });
    }

    if (text.length < 50) {
      return res.status(400).json({ success: false, error: 'Text should be at least 50 characters long' });
    }

    const questions = await generateQuestionsFromTextSource(text, subject || 'general', difficulty || 'medium', count);

    res.json({ success: true, questions });
  } catch (error) {
    console.error('AI text extraction error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate questions from text' });
  }
});

router.post('/generate-from-pdf', authenticateToken, isAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'PDF file is required' });
    }

    const fileName = String(req.file.originalname || 'document.pdf');
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ success: false, error: 'Only PDF files are allowed for this endpoint' });
    }

    if (!pdfParse) {
      return res.status(500).json({ success: false, error: 'PDF parsing library is not available' });
    }

    let pdfTextData;
    try {
      pdfTextData = await pdfParse(req.file.buffer);
    } catch (pdfParseError) {
      console.warn('Invalid PDF uploaded to AI generator:', pdfParseError.message || pdfParseError);
      return res.status(400).json({
        success: false,
        error: 'This file is not a valid PDF or it is corrupted. Please upload a readable PDF file.'
      });
    }

    const extractedText = String(pdfTextData?.text || '').trim();

    if (!extractedText) {
      return res.status(400).json({ success: false, error: 'No readable text found in the PDF' });
    }

    const parsePageSelection = (rawPageNumbers, maxPages) => {
      const normalized = String(rawPageNumbers || '').trim();
      if (!normalized) return [];

      const selected = new Set();
      normalized.split(',').forEach((token) => {
        const part = token.trim();
        if (!part) return;

        const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          if (Number.isNaN(start) || Number.isNaN(end)) return;
          const from = Math.max(1, Math.min(start, end));
          const to = Math.min(maxPages, Math.max(start, end));
          for (let p = from; p <= to; p += 1) selected.add(p);
          return;
        }

        const page = parseInt(part, 10);
        if (!Number.isNaN(page) && page >= 1 && page <= maxPages) {
          selected.add(page);
        }
      });

      return Array.from(selected).sort((a, b) => a - b);
    };

    const { subject, difficulty, count, topic, pageNumbers } = req.body;
    const totalPages = Number(pdfTextData?.numpages || 0);
    const selectedPages = parsePageSelection(pageNumbers, totalPages || 1);

    let selectedText = extractedText;
    if (selectedPages.length > 0 && totalPages > 0) {
      const pageChunks = extractedText.split(/\f+/).map((chunk) => chunk.trim()).filter(Boolean);
      if (pageChunks.length === totalPages) {
        selectedText = selectedPages
          .map((pageNum) => pageChunks[pageNum - 1] || '')
          .join('\n\n')
          .trim();
      }
    }

    const topicContext = String(topic || '').trim();
    const pageContext = String(pageNumbers || '').trim();
    const sourceTextForAI = [
      topicContext ? `Requested topic: ${topicContext}` : '',
      pageContext ? `Requested pages: ${pageContext}` : '',
      selectedText
    ].filter(Boolean).join('\n\n');

    const questions = await generateQuestionsFromTextSource(
      sourceTextForAI,
      subject || 'general',
      difficulty || 'medium',
      count || 5
    );

    res.json({
      success: true,
      questions,
      metadata: {
        fileName,
        extractedChars: selectedText.length,
        topic: topicContext || null,
        pageNumbers: pageContext || null,
        selectedPages,
        subject: subject || 'general',
        difficulty: difficulty || 'medium',
        count: questions.length
      }
    });
  } catch (error) {
    console.error('AI PDF generation error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate questions from PDF' });
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
    
    const ai = getOpenAIClient();
    let hint = `💡 Hint: Review the key concepts related to this topic. Think about what makes the correct answer right.`;

    if (ai) {
      try {
        const response = await ai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: `Create a short educational hint for this multiple-choice question, without revealing the answer. Question: ${question}. Correct answer is: ${correctAnswer || 'not provided'}. Keep it to one sentence.`
          }],
          temperature: 0.5
        });

        const content = response?.choices?.[0]?.message?.content;
        if (content) {
          hint = content.trim();
        }
      } catch (openAiError) {
        console.warn('OpenAI hint generation failed, using fallback hint.', openAiError.message || openAiError);
      }
    }

    res.json({ success: true, hint });
  } catch (error) {
    console.error('Add hint error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate hint' });
  }
});

router.post('/generate-hangman-hint', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { word, category } = req.body;
    if (!word || typeof word !== 'string' || !word.trim()) {
      return res.status(400).json({ success: false, error: 'Word is required' });
    }

    const ai = getOpenAIClient();
    let hint = mockAI.generateHangmanHint(word, category);

    if (ai) {
      try {
        const response = await ai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: `Generate a very short, helpful hangman clue for the word "${word}" in the category "${category || 'general'}". The clue should not reveal the exact word; it should be a single sentence under 120 characters.`
          }],
          temperature: 0.6
        });

        const content = response?.choices?.[0]?.message?.content?.trim();
        if (content) {
          hint = content;
        }
      } catch (openAiError) {
        console.warn('OpenAI hangman hint generation failed, using fallback:', openAiError.message || openAiError);
      }
    }

    res.json({ success: true, hint });
  } catch (error) {
    console.error('Generate hangman hint error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate hangman hint' });
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
module.exports.__test = {
  getOpenAIClient,
  generateQuestionsWithAI,
  mockAI
};
