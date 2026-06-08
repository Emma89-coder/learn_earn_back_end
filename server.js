require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// ============ FIXED PDF PARSER IMPORT ============
let pdfParse;
try {
  const pdfParseModule = require('pdf-parse');
  pdfParse = pdfParseModule.default || pdfParseModule;
  console.log('✅ PDF Parse loaded successfully');
} catch (error) {
  console.error('❌ Failed to load pdf-parse:', error.message);
  pdfParse = null;
}

const app = express();

// ============ ENHANCED CORS ============
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============ REQUEST LOGGING MIDDLEWARE ============
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============ CLOUDFLARE R2 CONFIGURATION ============
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|pdf|text\/csv|application\/vnd.ms-excel|csv/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDF, and CSV files are allowed'));
    }
  }
});

// ============ AUTHENTICATION MIDDLEWARE ============
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ============ RANDOMIZATION UTILITIES ============
const shuffleArray = (array) => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const randomizeQuizQuestions = (questions) => {
  if (!questions || !Array.isArray(questions)) return [];
  
  let parsedQuestions = questions;
  if (typeof questions === 'string') {
    parsedQuestions = JSON.parse(questions);
  }
  
  const shuffledQuestions = shuffleArray([...parsedQuestions]);
  
  const randomizedQuestions = shuffledQuestions.map((question) => {
    const optionsWithMeta = (question.options || []).map((option, optIdx) => ({
      text: option,
      originalIndex: optIdx,
      isCorrect: option === question.correctAnswer
    }));
    
    const shuffledOptions = shuffleArray(optionsWithMeta);
    const newCorrectAnswer = shuffledOptions.find(opt => opt.isCorrect)?.text || question.correctAnswer;
    
    return {
      ...question,
      options: shuffledOptions.map(opt => opt.text),
      correctAnswer: newCorrectAnswer
    };
  });
  
  return randomizedQuestions;
};

const selectRandomQuestions = (questionBank, numberOfQuestions = 20) => {
  if (!questionBank || !Array.isArray(questionBank)) return [];
  
  let questions = questionBank;
  if (typeof questionBank === 'string') {
    questions = JSON.parse(questionBank);
  }
  
  if (questions.length <= numberOfQuestions) {
    return shuffleArray(questions);
  }
  
  const shuffled = shuffleArray([...questions]);
  return shuffled.slice(0, numberOfQuestions);
};

// ============ LEVEL HELPER FUNCTIONS - ONLY STANDARDS 5-8 ============
const ALL_LEVELS = [
  'standard-5', 'standard-6', 'standard-7', 'standard-8'
];

const isValidLevel = (level) => ALL_LEVELS.includes(level);
const getLevelIndex = (level) => ALL_LEVELS.indexOf(level);
const canAdvanceToLevel = (currentLevel, targetLevel) => getLevelIndex(targetLevel) <= getLevelIndex(currentLevel) + 1;

// ============ SMART CORRECT ANSWER DETECTION ============
function detectCorrectAnswer(question, options, originalText = '') {
  if (!options || options.length === 0) return '';
  
  const cleanOptions = options.map(opt => opt.replace(/[✓*]/g, '').trim());
  
  if (originalText) {
    for (let i = 0; i < options.length; i++) {
      const originalOpt = options[i];
      if (originalOpt.includes('✓') || 
          originalOpt.includes('*') || 
          originalOpt.includes('(correct)') ||
          originalOpt.toLowerCase().includes('correct answer')) {
        return cleanOptions[i];
      }
    }
  }
  
  for (let i = 0; i < cleanOptions.length; i++) {
    const opt = cleanOptions[i];
    if (opt === opt.toUpperCase() && opt.length > 2 && !opt.includes(' ')) {
      return opt;
    }
  }
  
  const questionLower = question.toLowerCase();
  const keywordMatches = [];
  
  for (let i = 0; i < cleanOptions.length; i++) {
    const optLower = cleanOptions[i].toLowerCase();
    if (optLower.length > 3 && questionLower.includes(optLower)) {
      keywordMatches.push({ index: i, score: optLower.length });
    }
  }
  
  if (keywordMatches.length > 0) {
    keywordMatches.sort((a, b) => b.score - a.score);
    return cleanOptions[keywordMatches[0].index];
  }
  
  const longestIndex = cleanOptions.reduce((maxIdx, opt, idx, arr) => 
    opt.length > arr[maxIdx].length ? idx : maxIdx, 0);
  
  const avgLength = cleanOptions.reduce((sum, opt) => sum + opt.length, 0) / cleanOptions.length;
  if (cleanOptions[longestIndex].length > avgLength * 1.3) {
    return cleanOptions[longestIndex];
  }
  
  for (let i = 0; i < cleanOptions.length; i++) {
    const optLower = cleanOptions[i].toLowerCase();
    if (optLower.includes('all of the above') || optLower.includes('all the above')) {
      return cleanOptions[i];
    }
  }
  
  return cleanOptions[0];
}

function ensureFourOptions(options) {
  const clean = options.filter(o => o && o.trim() !== '');
  while (clean.length < 4) clean.push('');
  return clean.slice(0, 4);
}

function parseCSVRow(row) {
  const result = [];
  let inQuotes = false;
  let currentField = '';
  
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  result.push(currentField.trim());
  
  return result;
}

function extractQuestionsFromText(text) {
  const questions = [];
  const lines = text.split('\n');
  
  let currentQuestion = null;
  let currentOptions = [];
  let currentCorrectAnswer = null;
  let currentRawOptions = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.length < 3) continue;
    
    const isQuestionLine = (
      line.includes('?') || 
      /^\d+[\.\)]/.test(line) ||
      /^Q\d+[\.\):]/i.test(line) ||
      /^Question\s*\d+/i.test(line)
    );
    
    if ((isQuestionLine || (line.endsWith('?') && line.length < 200)) && !line.match(/^[A-D][\.\)]/)) {
      if (currentQuestion && currentOptions.length >= 2) {
        if (!currentCorrectAnswer) {
          currentCorrectAnswer = detectCorrectAnswer(currentQuestion, currentRawOptions, currentRawOptions.join(' '));
        }
        
        questions.push({
          id: `q-${Date.now()}-${questions.length}`,
          question: currentQuestion,
          options: ensureFourOptions(currentOptions),
          correctAnswer: currentCorrectAnswer,
          layout: 'text-first'
        });
      }
      
      currentQuestion = line
        .replace(/^\d+[\.\)]\s*/, '')
        .replace(/^Q\d+[\.\):]\s*/i, '')
        .replace(/^Question\s*\d+[\.\):]\s*/i, '')
        .trim();
      currentOptions = [];
      currentRawOptions = [];
      currentCorrectAnswer = null;
    }
    else if (/^[A-D][\.\)]/.test(line) && currentQuestion) {
      let option = line.replace(/^[A-D][\.\)]\s*/, '').trim();
      const originalOption = option;
      
      const isCorrect = (
        option.includes('✓') || 
        option.includes('*') || 
        option.includes('(correct)') ||
        option.toLowerCase().includes('correct answer') ||
        option.toLowerCase().includes('**') ||
        line.includes('✓') ||
        line.includes('*')
      );
      
      option = option
        .replace(/[✓*]/g, '')
        .replace(/\(\s*correct\s*\)/i, '')
        .replace(/\s+correct\s*$/i, '')
        .replace(/\*\*/g, '')
        .trim();
      
      if (option) {
        currentOptions.push(option);
        currentRawOptions.push(originalOption);
        if (isCorrect) {
          currentCorrectAnswer = option;
        }
      }
    }
    else if (line.match(/^answer\s*:/i) && currentQuestion) {
      const answerMatch = line.match(/^answer\s*:\s*(.+)/i);
      if (answerMatch) {
        let answer = answerMatch[1].trim();
        answer = answer.replace(/[✓*]/g, '').replace(/\(correct\)/i, '').trim();
        
        for (let opt of currentOptions) {
          if (opt.toLowerCase() === answer.toLowerCase() ||
              opt.toLowerCase().includes(answer.toLowerCase()) ||
              answer.toLowerCase().includes(opt.toLowerCase())) {
            currentCorrectAnswer = opt;
            break;
          }
        }
        
        const letterMatch = answer.match(/^([A-D])/i);
        if (letterMatch && !currentCorrectAnswer) {
          const letterIndex = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
          if (currentOptions[letterIndex]) {
            currentCorrectAnswer = currentOptions[letterIndex];
          }
        }
        
        if (!currentCorrectAnswer && currentOptions.length > 0) {
          currentCorrectAnswer = currentOptions[0];
        }
      }
    }
  }
  
  if (currentQuestion && currentOptions.length >= 2) {
    if (!currentCorrectAnswer) {
      currentCorrectAnswer = detectCorrectAnswer(currentQuestion, currentRawOptions, currentRawOptions.join(' '));
    }
    
    questions.push({
      id: `q-${Date.now()}-${questions.length}`,
      question: currentQuestion,
      options: ensureFourOptions(currentOptions),
      correctAnswer: currentCorrectAnswer,
      layout: 'text-first'
    });
  }
  
  return questions;
}

// ============ QUESTION BANK ENDPOINTS ============

app.get('/api/admin/question-bank', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { subject_id, difficulty_level, class_level, page = 1, limit = 20 } = req.query;
    
    let query = supabase
      .from('questions')
      .select('*', { count: 'exact' });
    
    if (subject_id && subject_id !== 'undefined' && subject_id !== '') {
      query = query.eq('subject_id', subject_id);
    }
    if (difficulty_level && difficulty_level !== 'undefined' && difficulty_level !== '') {
      query = query.eq('difficulty_level', difficulty_level);
    }
    if (class_level && class_level !== 'undefined' && class_level !== '') {
      query = query.eq('class_level', class_level);
    }
    
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    
    const { data: questions, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);
    
    if (error) {
      console.error('Error fetching questions:', error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
    const parsedQuestions = (questions || []).map(q => ({
      ...q,
      options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
      tags: q.tags || []
    }));
    
    res.json({
      success: true,
      questions: parsedQuestions,
      total: count || 0,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Error in GET /api/admin/question-bank:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/question-bank/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: questions, error } = await supabase
      .from('questions')
      .select('subject_id, difficulty_level');
    
    if (error) {
      console.error('Error fetching stats:', error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
    const stats = {};
    (questions || []).forEach(q => {
      const subject = q.subject_id || 'uncategorized';
      if (!stats[subject]) {
        stats[subject] = {
          total: 0,
          byDifficulty: {
            beginner: 0,
            easy: 0,
            medium: 0,
            hard: 0,
            expert: 0
          },
          avgSuccessRate: 0
        };
      }
      
      stats[subject].total++;
      
      const difficulty = q.difficulty_level || 'medium';
      if (stats[subject].byDifficulty[difficulty] !== undefined) {
        stats[subject].byDifficulty[difficulty]++;
      }
    });
    
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error in GET /api/admin/question-bank/stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/question-bank', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Received request to save question to bank');
  
  try {
    const {
      subject_id,
      difficulty_level,
      class_level,
      question,
      options,
      correct_answer,
      explanation,
      points,
      time_limit,
      tags
    } = req.body;
    
    if (!subject_id) {
      return res.status(400).json({ success: false, error: 'subject_id is required' });
    }
    if (!difficulty_level) {
      return res.status(400).json({ success: false, error: 'difficulty_level is required' });
    }
    if (!class_level) {
      return res.status(400).json({ success: false, error: 'class_level is required' });
    }
    if (!question || question.trim() === '') {
      return res.status(400).json({ success: false, error: 'question text is required' });
    }
    if (!options || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ success: false, error: 'at least 2 options are required' });
    }
    if (!correct_answer || correct_answer.trim() === '') {
      return res.status(400).json({ success: false, error: 'correct_answer is required' });
    }
    
    const newQuestion = {
      subject_id: subject_id,
      difficulty_level: difficulty_level,
      class_level: class_level,
      question: question.trim(),
      options: JSON.stringify(options),
      correct_answer: correct_answer,
      explanation: explanation || null,
      points: points || 2,
      time_limit: time_limit || 30,
      tags: JSON.stringify(tags || []),
      usage_count: 0,
      success_rate: 0,
      created_by: req.user.id,
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const { data, error } = await supabase
      .from('questions')
      .insert([newQuestion])
      .select()
      .single();
    
    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
    console.log('✅ Question saved successfully with ID:', data.id);
    
    res.json({
      success: true,
      id: data.id,
      message: 'Question added successfully'
    });
  } catch (error) {
    console.error('Error in POST /api/admin/question-bank:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/question-bank/bulk-import', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📦 Bulk import request received');
  
  try {
    const { questions: questionsToImport, subject_id, difficulty_level, class_level } = req.body;
    
    if (!questionsToImport || !Array.isArray(questionsToImport) || questionsToImport.length === 0) {
      return res.status(400).json({ success: false, error: 'No questions to import' });
    }
    
    let savedCount = 0;
    let failedCount = 0;
    const errors = [];
    
    for (const q of questionsToImport) {
      try {
        const newQuestion = {
          subject_id: subject_id,
          difficulty_level: difficulty_level,
          class_level: class_level,
          question: q.question.trim(),
          options: JSON.stringify(q.options),
          correct_answer: q.correctAnswer,
          explanation: q.explanation || null,
          points: q.points || 2,
          time_limit: q.time_limit || 30,
          tags: JSON.stringify(q.tags || []),
          usage_count: 0,
          success_rate: 0,
          created_by: req.user.id,
          created_at: new Date(),
          updated_at: new Date()
        };
        
        const { error } = await supabase
          .from('questions')
          .insert([newQuestion]);
        
        if (error) {
          failedCount++;
          errors.push({ question: q.question.substring(0, 50), error: error.message });
        } else {
          savedCount++;
        }
      } catch (err) {
        failedCount++;
        errors.push({ question: q.question.substring(0, 50), error: err.message });
      }
    }
    
    console.log(`✅ Bulk import complete: ${savedCount} saved, ${failedCount} failed`);
    
    res.json({
      success: true,
      savedCount,
      failedCount,
      errors: errors.slice(0, 10),
      message: `Successfully imported ${savedCount} questions to question bank`
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/quiz/generate', authenticateToken, async (req, res) => {
  try {
    const { subject_id, difficulty_level, class_level, count = 10 } = req.query;
    
    let query = supabase
      .from('questions')
      .select('*');
    
    if (subject_id && subject_id !== 'undefined' && subject_id !== '') {
      query = query.eq('subject_id', subject_id);
    }
    if (difficulty_level && difficulty_level !== 'undefined' && difficulty_level !== '') {
      query = query.eq('difficulty_level', difficulty_level);
    }
    if (class_level && class_level !== 'undefined' && class_level !== '') {
      query = query.eq('class_level', class_level);
    }
    
    const { data: questions, error } = await query
      .limit(parseInt(count) * 2);
    
    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }
    
    const shuffledQuestions = shuffleArray(questions || []);
    const selectedQuestions = shuffledQuestions.slice(0, parseInt(count));
    
    const parsedQuestions = selectedQuestions.map(q => ({
      ...q,
      options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options,
      tags: q.tags || []
    }));
    
    res.json({
      success: true,
      questions: parsedQuestions,
      count: parsedQuestions.length
    });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Failed to generate quiz' });
  }
});

app.post('/api/quiz/update-success-rate', authenticateToken, async (req, res) => {
  try {
    const { questionId, wasCorrect } = req.body;
    
    const { data: question, error: fetchError } = await supabase
      .from('questions')
      .select('success_rate, usage_count')
      .eq('id', questionId)
      .single();
    
    if (fetchError || !question) {
      return res.status(404).json({ success: false, error: 'Question not found' });
    }
    
    const currentRate = question.success_rate || 0;
    const usageCount = question.usage_count || 0;
    const newRate = ((currentRate * usageCount) + (wasCorrect ? 100 : 0)) / (usageCount + 1);
    
    const { error: updateError } = await supabase
      .from('questions')
      .update({
        success_rate: Math.round(newRate),
        usage_count: usageCount + 1,
        updated_at: new Date()
      })
      .eq('id', questionId);
    
    if (updateError) {
      return res.status(400).json({ success: false, error: updateError.message });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating success rate:', error);
    res.status(500).json({ error: 'Failed to update success rate' });
  }
});

// ============ ADMIN DASHBOARD ENDPOINTS ============

app.get('/api/admin/activities', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📊 Fetching admin activities...');
  
  try {
    const activities = [];
    
    const { data: submissions, error: submissionsError } = await supabase
      .from('quiz_submissions')
      .select('id, score, submitted_at, user_id, quiz_id')
      .order('submitted_at', { ascending: false })
      .limit(20);
    
    if (!submissionsError && submissions && submissions.length > 0) {
      for (const sub of submissions) {
        const { data: userData } = await supabase
          .from('users')
          .select('username, full_name')
          .eq('id', sub.user_id)
          .single();
        
        const { data: quizData } = await supabase
          .from('quizzes')
          .select('title')
          .eq('id', sub.quiz_id)
          .single();
        
        activities.push({
          id: `sub-${sub.id}`,
          type: 'quiz_submitted',
          message: `${userData?.full_name || userData?.username || 'A learner'} completed quiz "${quizData?.title || 'Quiz'}" with ${sub.score}%`,
          timestamp: sub.submitted_at,
          user: userData?.full_name || userData?.username,
          details: { score: sub.score, quizId: sub.quiz_id }
        });
      }
    }
    
    const { data: newLearners, error: learnersError } = await supabase
      .from('users')
      .select('id, full_name, username, created_at, class_level')
      .eq('role', 'learner')
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (!learnersError && newLearners && newLearners.length > 0) {
      newLearners.forEach(learner => {
        activities.push({
          id: `learner-${learner.id}`,
          type: 'learner_registered',
          message: `New learner "${learner.full_name || learner.username}" registered${learner.class_level ? ` for ${learner.class_level}` : ''}`,
          timestamp: learner.created_at,
          user: learner.full_name || learner.username,
          details: { classLevel: learner.class_level }
        });
      });
    }
    
    const { data: newQuizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('id, title, created_at, topic')
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (!quizzesError && newQuizzes && newQuizzes.length > 0) {
      newQuizzes.forEach(quiz => {
        activities.push({
          id: `quiz-${quiz.id}`,
          type: 'quiz_created',
          message: `New quiz "${quiz.title}" created in ${quiz.topic}`,
          timestamp: quiz.created_at,
          user: 'Admin',
          details: { topic: quiz.topic }
        });
      });
    }
    
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    console.log(`✅ Found ${activities.length} activities`);
    
    res.json({
      success: true,
      activities: activities.slice(0, 30)
    });
    
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ error: 'Failed to fetch activities', message: error.message });
  }
});

app.get('/api/admin/dashboard-stats', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📊 Fetching dashboard statistics...');
  
  try {
    const { count: totalLearners, error: learnersError } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'learner');
    
    const { count: totalQuizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('id', { count: 'exact', head: true });
    
    const { count: totalSubmissions, error: submissionsError } = await supabase
      .from('quiz_submissions')
      .select('id', { count: 'exact', head: true });
    
    const { data: pointsData, error: pointsError } = await supabase
      .from('users')
      .select('lifetime_points')
      .eq('role', 'learner');
    
    const totalPoints = pointsData?.reduce((sum, user) => sum + (user.lifetime_points || 0), 0) || 0;
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const { count: activeLearners, error: activeError } = await supabase
      .from('quiz_submissions')
      .select('user_id', { count: 'exact', head: true })
      .gte('submitted_at', oneWeekAgo.toISOString());
    
    const { data: scoreData, error: scoreError } = await supabase
      .from('quiz_submissions')
      .select('score');
    
    const avgScore = scoreData && scoreData.length > 0
      ? Math.round(scoreData.reduce((sum, s) => sum + (s.score || 0), 0) / scoreData.length)
      : 0;
    
    const { count: totalQuestions, error: questionsError } = await supabase
      .from('questions')
      .select('id', { count: 'exact', head: true });
    
    console.log(`✅ Stats: Learners=${totalLearners}, Quizzes=${totalQuizzes}, Questions=${totalQuestions}`);
    
    res.json({
      success: true,
      stats: {
        total_learners: totalLearners || 0,
        total_quizzes: totalQuizzes || 0,
        total_questions: totalQuestions || 0,
        total_submissions: totalSubmissions || 0,
        total_points_awarded: totalPoints,
        active_learners_this_week: activeLearners || 0,
        average_quiz_score: avgScore
      }
    });
    
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
});

// ============ PDF UPLOAD AND EXTRACTION ENDPOINT ============
app.post('/api/admin/extract-questions', authenticateToken, requireAdmin, upload.single('pdf'), async (req, res) => {
  console.log('='.repeat(50));
  console.log('📄 PDF EXTRACTION REQUEST');
  console.log('='.repeat(50));
  
  try {
    if (!req.file) {
      console.log('❌ No file provided');
      return res.status(400).json({ 
        success: false, 
        message: 'No file provided. Please select a PDF or CSV file.' 
      });
    }

    console.log(`📁 File: ${req.file.originalname}`);
    console.log(`📁 Type: ${req.file.mimetype}`);
    console.log(`📁 Size: ${req.file.size} bytes`);

    let questions = [];

    if (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf')) {
      console.log('🔄 Processing PDF file...');
      
      if (!pdfParse) {
        console.error('❌ PDF parser not available');
        return res.status(500).json({ 
          success: false, 
          message: 'PDF parser is not installed. Please run: npm install pdf-parse@1.1.1' 
        });
      }
      
      try {
        const data = await pdfParse(req.file.buffer);
        console.log(`📄 PDF text length: ${data.text.length} characters`);
        console.log(`📄 Preview: ${data.text.substring(0, 500)}...`);
        
        questions = extractQuestionsFromText(data.text);
        console.log(`✅ Extracted ${questions.length} questions from PDF`);
        
        questions.forEach((q, idx) => {
          console.log(`Q${idx + 1}: Detected correct answer: "${q.correctAnswer}"`);
        });
        
        if (questions.length === 0) {
          console.log('🔄 Trying fallback extraction...');
          const lines = data.text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('?') && line.length < 200 && line.length > 15) {
              questions.push({
                id: `q-${Date.now()}-${questions.length}`,
                question: line,
                options: ['Option A', 'Option B', 'Option C', 'Option D'],
                correctAnswer: 'Option A',
                layout: 'text-first'
              });
            }
            if (questions.length >= 20) break;
          }
          console.log(`✅ Fallback found ${questions.length} questions`);
        }
        
      } catch (pdfError) {
        console.error('❌ PDF parsing error:', pdfError);
        return res.status(400).json({ 
          success: false, 
          message: `Failed to parse PDF: ${pdfError.message}. Make sure the PDF contains selectable text.` 
        });
      }
    }
    else if (req.file.mimetype === 'text/csv' || req.file.originalname.toLowerCase().endsWith('.csv')) {
      console.log('🔄 Processing CSV file...');
      
      try {
        const csvText = req.file.buffer.toString('utf-8');
        const lines = csvText.split('\n');
        
        if (lines.length < 2) {
          throw new Error('CSV must have at least a header row and one data row');
        }
        
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        console.log('CSV Headers:', headers);
        
        for (let i = 1; i < Math.min(lines.length, 51); i++) {
          if (!lines[i].trim()) continue;
          
          const values = parseCSVRow(lines[i]);
          if (values.length < 5) continue;
          
          const question = values[0]?.trim();
          const options = [
            values[1]?.trim() || '',
            values[2]?.trim() || '',
            values[3]?.trim() || '',
            values[4]?.trim() || ''
          ];
          let correctAnswer = values[5]?.trim() || '';
          
          if (correctAnswer.match(/^[A-D]$/i)) {
            const letterIndex = correctAnswer.toUpperCase().charCodeAt(0) - 65;
            correctAnswer = options[letterIndex] || options[0];
          }
          
          if (question && options.some(o => o)) {
            questions.push({
              id: `q-${Date.now()}-${i}`,
              question: question,
              options: ensureFourOptions(options),
              correctAnswer: correctAnswer || options[0],
              layout: 'text-first'
            });
          }
        }
        
        console.log(`✅ Extracted ${questions.length} questions from CSV`);
        
      } catch (csvError) {
        console.error('❌ CSV parsing error:', csvError);
        return res.status(400).json({ 
          success: false, 
          message: `Failed to parse CSV: ${csvError.message}` 
        });
      }
    }
    else {
      return res.status(400).json({ 
        success: false, 
        message: 'Unsupported file type. Please upload PDF or CSV files only.' 
      });
    }

    if (questions.length === 0) {
      console.log('❌ No questions extracted');
      return res.status(400).json({ 
        success: false, 
        message: 'No valid questions found. Please ensure the file has properly formatted questions.' 
      });
    }

    questions = questions.map(q => ({
      ...q,
      options: ensureFourOptions(q.options),
      correctAnswer: q.correctAnswer && q.options.includes(q.correctAnswer) 
        ? q.correctAnswer 
        : (q.options[0] || '')
    }));

    console.log(`✅ SUCCESS: Returning ${questions.length} questions with auto-detected answers`);
    console.log('='.repeat(50));
    
    res.json({
      success: true,
      questions: questions,
      message: `Successfully extracted ${questions.length} questions from ${req.file.originalname}. Correct answers have been auto-detected.`
    });
    
  } catch (error) {
    console.error('❌ FATAL ERROR:', error);
    console.error('Stack:', error.stack);
    console.log('='.repeat(50));
    
    res.status(500).json({ 
      success: false, 
      message: `Server error: ${error.message}` 
    });
  }
});

// ============ CSV IMPORT ENDPOINT ============
app.post('/api/admin/import-questions', authenticateToken, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    const questions = [];
    
    if (req.file.mimetype === 'text/csv' || req.file.originalname.toLowerCase().endsWith('.csv')) {
      const csvData = req.file.buffer.toString('utf-8');
      const rows = csvData.split('\n');
      
      const firstRow = rows[0].toLowerCase();
      const hasHeader = firstRow.includes('question') || firstRow.includes('option');
      const startRow = hasHeader ? 1 : 0;
      
      for (let i = startRow; i < rows.length; i++) {
        if (!rows[i].trim()) continue;
        
        const columns = parseCSVRow(rows[i]);
        if (columns.length >= 6) {
          let correctAnswer = columns[5]?.trim();
          
          if (correctAnswer && correctAnswer.match(/^[A-D]$/i)) {
            const letterIndex = correctAnswer.toUpperCase().charCodeAt(0) - 65;
            const options = [columns[1], columns[2], columns[3], columns[4]];
            correctAnswer = options[letterIndex] || columns[1];
          }
          
          questions.push({
            id: `${Date.now()}-${questions.length}`,
            question: columns[0]?.trim(),
            options: [columns[1]?.trim(), columns[2]?.trim(), columns[3]?.trim(), columns[4]?.trim()],
            correctAnswer: correctAnswer || columns[1]?.trim() || '',
            layout: 'text-first'
          });
        }
      }
    }
    
    const validQuestions = questions.filter(q => q.question && q.correctAnswer);
    
    res.json({
      success: true,
      questions: validQuestions,
      message: `Imported ${validQuestions.length} questions`
    });
    
  } catch (error) {
    console.error('CSV import error:', error);
    res.status(500).json({ error: 'Failed to import questions from file' });
  }
});

// ============ IMAGE UPLOAD ENDPOINT ============
app.post('/api/admin/upload-image', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const fileExtension = path.extname(req.file.originalname);
    const fileName = `${uuidv4()}${fileExtension}`;
    const fileKey = `quizzes/${fileName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await r2Client.send(command);

    const imageUrl = `${process.env.CLOUDFLARE_PUBLIC_URL}/${fileKey}`;

    res.json({
      success: true,
      imageUrl: imageUrl,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// ============ DELETE IMAGE ENDPOINT ============
app.delete('/api/admin/delete-image', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { imageUrl } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'Image URL required' });
    }

    const fileKey = imageUrl.split('/').slice(-2).join('/');
    
    const command = new DeleteObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileKey,
    });

    await r2Client.send(command);

    res.json({
      success: true,
      message: 'Image deleted successfully'
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// ============ AUTHENTICATION ENDPOINTS ============

app.post('/api/auth/login', async (req, res) => {
  console.log('📨 Admin login request:', { username: req.body.username });
  
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, full_name, role, password_hash')
      .eq('username', username.trim())
      .eq('role', 'admin');

    if (error || !users || users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0];

    if (!user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name || user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

app.post('/api/auth/test-login', (req, res) => {
  console.log('📨 Test login request:', req.body);
  const { username, password } = req.body;
  
  if (username === 'admin' && password === 'admin123') {
    const token = jwt.sign(
      { id: 1, username: 'admin', role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    return res.json({
      success: true,
      token,
      user: {
        id: 1,
        username: 'admin',
        fullName: 'System Administrator',
        role: 'admin'
      }
    });
  }
  
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/auth/learner-login', async (req, res) => {
  try {
    const { username, registrationNumber } = req.body;

    if (!username || !registrationNumber) {
      return res.status(400).json({ error: 'Username and registration number required' });
    }

    const normalizedUsername = username.trim();
    const normalizedRegNumber = registrationNumber.trim();

    let user = null;

    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'learner')
      .eq('username', normalizedUsername)
      .ilike('registration_number', normalizedRegNumber);

    if (!error && users && users.length > 0) {
      user = users[0];
    } else {
      const { data: fullNameUsers, error: fullNameError } = await supabase
        .from('users')
        .select('*')
        .eq('role', 'learner')
        .ilike('full_name', normalizedUsername)
        .ilike('registration_number', normalizedRegNumber);

      if (!fullNameError && fullNameUsers && fullNameUsers.length > 0) {
        user = fullNameUsers[0];
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        classLevel: user.class_level,
        currentPoints: user.current_points || 0,
        lifetimePoints: user.lifetime_points || 0,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Learner login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============ LEARNER ENDPOINTS ============

app.get('/api/learner/balance', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: users, error } = await supabase
      .from('users')
      .select('current_points, lifetime_points')
      .eq('id', userId);

    if (error || !users || users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    res.json({
      success: true,
      current_points: user.current_points || 0,
      lifetime_points: user.lifetime_points || 0
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

app.get('/api/learner/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId);

    if (error || !users || users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const learner = users[0];
    
    // Add max possible level based on class
    const maxLevel = learner.class_level || 'standard-8';
    const maxLevelIndex = ALL_LEVELS.indexOf(maxLevel);
    const unlockedLevels = ALL_LEVELS.slice(0, maxLevelIndex + 1);

    res.json({ 
      success: true, 
      learner: {
        ...learner,
        max_level: maxLevel,
        unlocked_levels: unlockedLevels
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ============ UPDATED LEARNER QUIZZES ENDPOINT WITH STRICT LEVEL ENFORCEMENT ============
app.get('/api/learner/quizzes', authenticateToken, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const userId = req.user.id;

    // Get learner's current level and class level
    const { data: learnerData, error: learnerError } = await supabase
      .from('users')
      .select('class_level, current_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      console.error('Error fetching learner data:', learnerError);
      return res.status(400).json({ error: learnerError.message });
    }

    const learnerClass = learnerData?.class_level;
    const currentLevel = learnerData?.current_level || learnerClass || 'standard-5';
    
    // CRITICAL: Only show quizzes for the learner's CURRENT level, not class level
    const allowedLevel = currentLevel;

    console.log(`📚 Learner ${userId}: Class=${learnerClass}, Current Level=${currentLevel}, Allowed Level=${allowedLevel}`);

    // Get all active quizzes
    const { data: quizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('*')
      .eq('is_active', true)
      .or(`start_time.lte.${now},start_time.is.null`)
      .or(`end_time.gte.${now},end_time.is.null`)
      .order('created_at', { ascending: false });

    if (quizzesError) {
      return res.status(400).json({ error: quizzesError.message });
    }

    // Get class assignments
    const { data: assignments, error: assignmentsError } = await supabase
      .from('class_assignments')
      .select('quiz_id, class_level');

    const quizClassMap = {};
    if (!assignmentsError && assignments) {
      assignments.forEach(assignment => {
        if (!quizClassMap[assignment.quiz_id]) {
          quizClassMap[assignment.quiz_id] = [];
        }
        quizClassMap[assignment.quiz_id].push(assignment.class_level);
      });
    }

    // STRICT FILTERING: Quiz level must match learner's CURRENT level
    const filteredQuizzes = quizzes.filter(quiz => {
      // Check class assignment
      const assignedClasses = quizClassMap[quiz.id] || [];
      const classMatch = assignedClasses.length === 0 || assignedClasses.includes(learnerClass);
      
      // Quiz level must match learner's current level
      const quizLevel = quiz.class_level;
      let levelMatch = true;
      
      if (quizLevel) {
        levelMatch = quizLevel === currentLevel;
      }
      
      return classMatch && levelMatch;
    });

    res.json({ 
      success: true, 
      quizzes: filteredQuizzes,
      learner_progress: {
        current_level: currentLevel,
        class_level: learnerClass,
        next_level: getNextLevel(currentLevel, learnerClass)
      }
    });
    
  } catch (error) {
    console.error('Get quizzes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

// Helper function to get next level
function getNextLevel(currentLevel, classLevel) {
  const currentIndex = ALL_LEVELS.indexOf(currentLevel);
  const classIndex = ALL_LEVELS.indexOf(classLevel);
  
  if (currentIndex < classIndex) {
    return ALL_LEVELS[currentIndex + 1];
  }
  return null;
}

// ============ LEVEL PROGRESSION ENDPOINTS ============

// Get learner's current level and unlocked levels
app.get('/api/learner/progress', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: learner, error: learnerError } = await supabase
      .from('users')
      .select('current_level, completed_levels, class_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      return res.status(400).json({ error: learnerError.message });
    }

    const { data: completions, error: completionError } = await supabase
      .from('level_completion')
      .select('level, completed_at, score_percentage')
      .eq('user_id', userId)
      .order('completed_at', { ascending: true });

    const currentLevelIndex = ALL_LEVELS.indexOf(learner.current_level);
    const unlockedLevels = ALL_LEVELS.slice(0, currentLevelIndex + 1);
    const lockedLevels = ALL_LEVELS.slice(currentLevelIndex + 1);
    
    // Check if learner can advance further (not at class level yet)
    const classIndex = ALL_LEVELS.indexOf(learner.class_level);
    const canAdvance = currentLevelIndex < classIndex;

    res.json({
      success: true,
      progress: {
        current_level: learner.current_level,
        completed_levels: completions || [],
        unlocked_levels: unlockedLevels,
        locked_levels: lockedLevels,
        all_levels: ALL_LEVELS,
        class_level: learner.class_level,
        can_advance: canAdvance,
        next_level: canAdvance ? ALL_LEVELS[currentLevelIndex + 1] : null
      }
    });
  } catch (error) {
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// Advance learner to next level (with class level boundary check)
app.post('/api/learner/advance-level', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_level, next_level, score_percentage, quizzes_passed, total_quizzes } = req.body;

    // Get learner's class level to enforce boundary
    const { data: learner, error: learnerError } = await supabase
      .from('users')
      .select('class_level, current_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      return res.status(400).json({ error: learnerError.message });
    }

    const currentIndex = ALL_LEVELS.indexOf(current_level);
    const nextIndex = ALL_LEVELS.indexOf(next_level);
    const classIndex = ALL_LEVELS.indexOf(learner.class_level);

    // Cannot advance beyond class level
    if (nextIndex > classIndex) {
      return res.status(400).json({ 
        error: `Cannot advance beyond your class level (${learner.class_level})`,
        max_level: learner.class_level
      });
    }

    if (nextIndex === -1 || nextIndex <= currentIndex) {
      return res.status(400).json({ error: 'Invalid level progression' });
    }

    // Record level completion
    await supabase
      .from('level_completion')
      .insert([{
        user_id: userId,
        level: current_level,
        completed_at: new Date(),
        score_percentage: score_percentage,
        quizzes_passed: quizzes_passed,
        total_quizzes: total_quizzes
      }]);

    // Update user's current level
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({ current_level: next_level })
      .eq('id', userId)
      .select()
      .single();

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    res.json({
      success: true,
      message: `Advanced to ${next_level}!`,
      new_level: next_level,
      max_level: learner.class_level,
      is_max_level: nextIndex === classIndex
    });
  } catch (error) {
    console.error('Advance level error:', error);
    res.status(500).json({ error: 'Failed to advance level' });
  }
});

// Check if learner can access a specific level's quiz
app.get('/api/learner/can-access-level/:level', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { level } = req.params;

    const { data: learner, error: learnerError } = await supabase
      .from('users')
      .select('current_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      return res.status(400).json({ error: learnerError.message });
    }

    const currentIndex = ALL_LEVELS.indexOf(learner.current_level);
    const requestedIndex = ALL_LEVELS.indexOf(level);
    const canAccess = requestedIndex <= currentIndex;

    res.json({
      success: true,
      can_access: canAccess,
      current_level: learner.current_level,
      requested_level: level,
      message: canAccess ? 'Access granted' : `Complete ${learner.current_level} first`
    });
  } catch (error) {
    console.error('Check access error:', error);
    res.status(500).json({ error: 'Failed to check access' });
  }
});

// Check if learner can access a specific quiz
app.get('/api/learner/can-access-quiz/:quizId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { quizId } = req.params;

    const { data: learner, error: learnerError } = await supabase
      .from('users')
      .select('current_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      return res.status(400).json({ error: learnerError.message });
    }

    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('class_level')
      .eq('id', quizId)
      .single();

    if (quizError) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const canAccess = !quiz.class_level || quiz.class_level === learner.current_level;

    res.json({
      success: true,
      can_access: canAccess,
      current_level: learner.current_level,
      quiz_level: quiz.class_level,
      message: canAccess ? 'Access granted' : `You need to complete ${learner.current_level} first to unlock ${quiz.class_level}`
    });
  } catch (error) {
    console.error('Check quiz access error:', error);
    res.status(500).json({ error: 'Failed to check access' });
  }
});

// ============ UPDATED LEARNER QUIZ ENDPOINT WITH RANDOMIZATION ============
app.get('/api/learner/quiz/:quizId', authenticateToken, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { random = 'false', limit = '20' } = req.query;

    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select('*')
      .eq('id', quizId);

    if (error || !quizzes || quizzes.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = quizzes[0];
    const now = new Date();
    
    if (!quiz.is_active) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    if (quiz.start_time && new Date(quiz.start_time) > now) {
      return res.status(404).json({ error: 'Quiz not available yet' });
    }
    if (quiz.end_time && new Date(quiz.end_time) < now) {
      return res.status(404).json({ error: 'Quiz is no longer available' });
    }

    let questions = quiz.questions;
    
    const shouldRandomize = random === 'true' || quiz.random_selection === true;
    
    if (shouldRandomize) {
      const numQuestions = parseInt(limit) || quiz.questions_per_attempt || 20;
      questions = selectRandomQuestions(questions, numQuestions);
      console.log(`🎲 Randomly selected ${questions.length} questions from quiz "${quiz.title}"`);
    }
    
    const randomizedQuestions = randomizeQuizQuestions(questions);

    res.json({ 
      success: true, 
      quiz: {
        ...quiz,
        questions: randomizedQuestions,
        total_questions_available: quiz.questions?.length || 0,
        selected_questions: randomizedQuestions.length
      }
    });
  } catch (error) {
    console.error('Get quiz error:', error);
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
});

app.post('/api/learner/quiz-submit', authenticateToken, async (req, res) => {
  try {
    const { quizId, answers, score, pointsEarned } = req.body;
    const userId = req.user.id;

    if (!quizId || !answers) {
      return res.status(400).json({ error: 'Quiz ID and answers required' });
    }

    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('id, difficulty, class_level')
      .eq('id', quizId)
      .single();

    if (quizError) {
      return res.status(400).json({ error: 'Quiz not found' });
    }

    const { data: submission, error: submitError } = await supabase
      .from('quiz_submissions')
      .insert([
        {
          user_id: userId,
          quiz_id: quizId,
          answers,
          score,
          submitted_at: new Date()
        }
      ])
      .select()
      .single();

    if (submitError) {
      return res.status(400).json({ error: submitError.message });
    }

    if (score >= 60 && pointsEarned && pointsEarned > 0) {
      const { data: users, error: userError } = await supabase
        .from('users')
        .select('current_points, lifetime_points')
        .eq('id', userId)
        .single();

      if (!userError && users) {
        const newCurrentPoints = (users.current_points || 0) + pointsEarned;
        const newLifetimePoints = (users.lifetime_points || 0) + pointsEarned;
        
        await supabase
          .from('users')
          .update({
            current_points: newCurrentPoints,
            lifetime_points: newLifetimePoints
          })
          .eq('id', userId);
      }
    }

    res.json({ 
      success: true, 
      submission: submission, 
      pointsAwarded: score >= 60 ? pointsEarned : 0
    });
  } catch (error) {
    console.error('Quiz submit error:', error);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// ============ CLASS ASSIGNMENT ENDPOINTS ============

app.post('/api/admin/assign-quiz', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Assign quiz request:', req.body);
  
  try {
    const { quizId, classIds } = req.body;

    if (!quizId || !classIds || !Array.isArray(classIds)) {
      return res.status(400).json({ error: 'Quiz ID and class IDs array are required' });
    }

    const { error: deleteError } = await supabase
      .from('class_assignments')
      .delete()
      .eq('quiz_id', quizId);

    if (deleteError) {
      console.error('Error deleting existing assignments:', deleteError);
    }

    const assignments = classIds.map(classId => ({
      quiz_id: parseInt(quizId),
      class_level: classId
    }));

    const { data, error } = await supabase
      .from('class_assignments')
      .insert(assignments)
      .select();

    if (error) {
      console.error('Insert error:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log(`✅ Quiz assigned to ${classIds.length} class(es) successfully`);

    res.json({
      success: true,
      message: `Quiz assigned to ${classIds.length} class(es) successfully`,
      assignments: data
    });

  } catch (error) {
    console.error('Assign quiz error:', error);
    res.status(500).json({ error: 'Failed to assign quiz to classes' });
  }
});

app.get('/api/admin/quiz-classes/:quizId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;

    const { data, error } = await supabase
      .from('class_assignments')
      .select('class_level')
      .eq('quiz_id', quizId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const assignedClasses = data.map(item => item.class_level);

    res.json({
      success: true,
      classes: assignedClasses
    });

  } catch (error) {
    console.error('Get quiz classes error:', error);
    res.status(500).json({ error: 'Failed to fetch quiz classes' });
  }
});

app.get('/api/admin/quizzes-with-classes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: quizzes, error: quizzesError } = await supabase
      .from('quizzes')
      .select('*')
      .order('created_at', { ascending: false });

    if (quizzesError) {
      return res.status(400).json({ error: quizzesError.message });
    }

    const { data: assignments, error: assignmentsError } = await supabase
      .from('class_assignments')
      .select('*');

    if (assignmentsError) {
      console.error('Error fetching assignments:', assignmentsError);
    }

    const quizClassMap = {};
    if (assignments) {
      assignments.forEach(assignment => {
        if (!quizClassMap[assignment.quiz_id]) {
          quizClassMap[assignment.quiz_id] = [];
        }
        quizClassMap[assignment.quiz_id].push(assignment.class_level);
      });
    }

    const quizzesWithClasses = quizzes.map(quiz => ({
      ...quiz,
      assigned_classes: quizClassMap[quiz.id] || []
    }));

    res.json({
      success: true,
      quizzes: quizzesWithClasses
    });

  } catch (error) {
    console.error('Get quizzes with classes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes with class assignments' });
  }
});

app.get('/api/learner/available-classes', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: learnerData, error: learnerError } = await supabase
      .from('users')
      .select('class_level')
      .eq('id', userId)
      .single();

    if (learnerError) {
      return res.status(400).json({ error: learnerError.message });
    }

    res.json({
      success: true,
      learnerClass: learnerData?.class_level || null,
      availableClasses: ALL_LEVELS
    });

  } catch (error) {
    console.error('Get available classes error:', error);
    res.status(500).json({ error: 'Failed to fetch available classes' });
  }
});

// ============ LEARNER MANAGEMENT ENDPOINTS ============

// Get all learners
app.get('/api/admin/learners', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: learners, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'learner')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, learners: learners || [] });
  } catch (error) {
    console.error('Get learners error:', error);
    res.status(500).json({ error: 'Failed to fetch learners' });
  }
});

// Register new learner - current_level MUST equal class_level
app.post('/api/admin/learners', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Registering new learner:', { 
    username: req.body.username, 
    full_name: req.body.full_name,
    class_level: req.body.class_level 
  });
  
  try {
    const { username, full_name, registration_number, class_level } = req.body;

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    if (!registration_number || !registration_number.trim()) {
      return res.status(400).json({ error: 'Registration number is required' });
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('username', username.trim())
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const { data: existingReg } = await supabase
      .from('users')
      .select('id')
      .eq('registration_number', registration_number.trim())
      .maybeSingle();

    if (existingReg) {
      return res.status(400).json({ error: 'Registration number already exists' });
    }

    const defaultPassword = registration_number;
    const password_hash = await bcrypt.hash(defaultPassword, 10);

    // CRITICAL: current_level MUST equal class_level
    const assignedClass = class_level || 'standard-5';

    const newLearner = {
      username: username.trim(),
      full_name: full_name.trim(),
      registration_number: registration_number.trim(),
      class_level: assignedClass,
      current_level: assignedClass,
      password_hash: password_hash,
      role: 'learner',
      current_points: 0,
      lifetime_points: 0,
      created_at: new Date(),
      updated_at: new Date()
    };

    const { data, error } = await supabase
      .from('users')
      .insert([newLearner])
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(400).json({ error: error.message });
    }

    console.log('✅ Learner registered successfully:', data.id);
    
    const { password_hash: _, ...learnerWithoutPassword } = data;

    res.json({ 
      success: true, 
      message: 'Learner registered successfully',
      learner: learnerWithoutPassword,
      default_password: defaultPassword
    });

  } catch (error) {
    console.error('Register learner error:', error);
    res.status(500).json({ error: 'Failed to register learner: ' + error.message });
  }
});

// Update learner's class level - MUST also sync current_level
app.put('/api/admin/learners/:learnerId/class', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { class_level } = req.body;

    if (!class_level) {
      return res.status(400).json({ error: 'Class level is required' });
    }

    if (!ALL_LEVELS.includes(class_level)) {
      return res.status(400).json({ error: 'Invalid class level' });
    }

    // Update both class_level and current_level to the same value
    const { data, error } = await supabase
      .from('users')
      .update({ 
        class_level: class_level, 
        current_level: class_level,
        updated_at: new Date() 
      })
      .eq('id', learnerId)
      .eq('role', 'learner')
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Class level updated successfully', learner: data });
  } catch (error) {
    console.error('Update learner class error:', error);
    res.status(500).json({ error: 'Failed to update learner class' });
  }
});

// Get single learner
app.get('/api/admin/learners/:learnerId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', learnerId)
      .eq('role', 'learner')
      .single();

    if (error) {
      return res.status(404).json({ error: 'Learner not found' });
    }

    const { password_hash, ...learner } = data;

    res.json({ success: true, learner });
  } catch (error) {
    console.error('Get learner error:', error);
    res.status(500).json({ error: 'Failed to fetch learner' });
  }
});

// Delete learner
app.delete('/api/admin/learners/:learnerId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;

    const { error: submissionsError } = await supabase
      .from('quiz_submissions')
      .delete()
      .eq('user_id', learnerId);

    if (submissionsError) {
      console.error('Error deleting submissions:', submissionsError);
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', learnerId)
      .eq('role', 'learner');

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Learner deleted successfully' });
  } catch (error) {
    console.error('Delete learner error:', error);
    res.status(500).json({ error: 'Failed to delete learner' });
  }
});

// Get learner's level completion history
app.get('/api/admin/learners/:learnerId/level-history', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;

    const { data: history, error } = await supabase
      .from('level_completion')
      .select('*')
      .eq('user_id', learnerId)
      .order('completed_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, history: history || [] });
  } catch (error) {
    console.error('Get level history error:', error);
    res.status(500).json({ error: 'Failed to fetch level history' });
  }
});

// Update learner's current level (Admin only) - WITH STRICT CLASS BOUNDARY
app.put('/api/admin/learners/:learnerId/current-level', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { current_level } = req.body;

    if (!current_level) {
      return res.status(400).json({ error: 'Current level is required' });
    }

    if (!ALL_LEVELS.includes(current_level)) {
      return res.status(400).json({ error: 'Invalid level' });
    }

    // First get the learner's class level
    const { data: learner, error: fetchError } = await supabase
      .from('users')
      .select('class_level')
      .eq('id', learnerId)
      .eq('role', 'learner')
      .single();

    if (fetchError) {
      return res.status(404).json({ error: 'Learner not found' });
    }

    // Validate that current_level cannot exceed class_level
    const classIndex = ALL_LEVELS.indexOf(learner.class_level);
    const currentIndex = ALL_LEVELS.indexOf(current_level);

    if (currentIndex > classIndex) {
      return res.status(400).json({ 
        error: `Cannot set current level (${current_level}) above class level (${learner.class_level})`,
        max_allowed: learner.class_level
      });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ current_level: current_level, updated_at: new Date() })
      .eq('id', learnerId)
      .eq('role', 'learner')
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Current level updated successfully', learner: data });
  } catch (error) {
    console.error('Update learner current level error:', error);
    res.status(500).json({ error: 'Failed to update learner current level' });
  }
});

// ============ ADMIN QUIZ ENDPOINTS ============

app.get('/api/admin/quizzes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quizzes: quizzes || [] });
  } catch (error) {
    console.error('Get admin quizzes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

// Create quiz with random selection settings
app.post('/api/admin/quizzes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { 
      title, topic, description, questions, start_time, end_time, 
      is_active, image_url, difficulty, 
      random_selection = false, 
      questions_per_attempt = 20,
      class_level
    } = req.body;

    if (!title || !topic || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Title, topic, and questions array are required' });
    }

    const newQuiz = {
      title: title.trim(),
      topic: topic.trim(),
      description: description?.trim() || '',
      questions,
      start_time: start_time || null,
      end_time: end_time || null,
      is_active: is_active !== false,
      image_url: image_url?.trim() || null,
      difficulty: difficulty || 'intermediate',
      random_selection: random_selection,
      questions_per_attempt: questions_per_attempt,
      class_level: class_level || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const { data, error } = await supabase
      .from('quizzes')
      .insert([newQuiz])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quiz: data });
  } catch (error) {
    console.error('Create quiz error:', error);
    res.status(500).json({ error: 'Failed to create quiz' });
  }
});

// Update quiz with random selection settings
app.put('/api/admin/quizzes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, topic, description, questions, start_time, end_time, 
      is_active, image_url, difficulty,
      random_selection, questions_per_attempt,
      class_level
    } = req.body;

    const updates = {
      title: title?.trim(),
      topic: topic?.trim(),
      description: description?.trim(),
      questions,
      start_time: start_time || null,
      end_time: end_time || null,
      is_active: is_active !== false,
      image_url: image_url?.trim() || null,
      difficulty: difficulty || 'intermediate',
      random_selection: random_selection,
      questions_per_attempt: questions_per_attempt,
      class_level: class_level || null,
      updated_at: new Date()
    };

    const { data, error } = await supabase
      .from('quizzes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quiz: data });
  } catch (error) {
    console.error('Update quiz error:', error);
    res.status(500).json({ error: 'Failed to update quiz' });
  }
});

// Delete quiz with cleanup
app.delete('/api/admin/quizzes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error: assignmentError } = await supabase
      .from('class_assignments')
      .delete()
      .eq('quiz_id', id);
    
    if (assignmentError) {
      console.error('Error deleting class assignments:', assignmentError);
    }
    
    const { error: submissionsError } = await supabase
      .from('quiz_submissions')
      .delete()
      .eq('quiz_id', id);
    
    if (submissionsError) {
      console.error('Error deleting submissions:', submissionsError);
    }
    
    const { error } = await supabase
      .from('quizzes')
      .delete()
      .eq('id', id);
    
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    
    res.json({ success: true, message: 'Quiz deleted successfully' });
  } catch (error) {
    console.error('Delete quiz error:', error);
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// ============ SUBJECTS AND DIFFICULTIES ENDPOINTS ============

app.get('/api/subjects', authenticateToken, async (req, res) => {
  try {
    const subjects = [
      { subject_id: 'mathematics', name: 'Mathematics', icon: '🔢', color: 'blue' },
      { subject_id: 'english', name: 'English', icon: '📖', color: 'green' },
      { subject_id: 'primary-science', name: 'Science', icon: '🔬', color: 'purple' },
      { subject_id: 'social-studies', name: 'Social Studies', icon: '🌍', color: 'orange' },
      { subject_id: 'bible-knowledge', name: 'Bible Knowledge', icon: '📖', color: 'yellow' },
      { subject_id: 'arts-life-skills', name: 'Arts & Life Skills', icon: '🎨', color: 'pink' },
      { subject_id: 'chichewa', name: 'Chichewa', icon: '🇲🇼', color: 'red' }
    ];
    
    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

app.get('/api/difficulty-levels', authenticateToken, async (req, res) => {
  try {
    const difficulties = [
      { id: 'beginner', name: 'Beginner', icon: '🌱', points: 1, timeLimit: 45 },
      { id: 'easy', name: 'Easy', icon: '📘', points: 2, timeLimit: 35 },
      { id: 'medium', name: 'Medium', icon: '📚', points: 3, timeLimit: 30 },
      { id: 'hard', name: 'Hard', icon: '🎓', points: 4, timeLimit: 25 },
      { id: 'expert', name: 'Expert', icon: '🏆', points: 5, timeLimit: 20 }
    ];
    
    res.json({ success: true, difficulties });
  } catch (error) {
    console.error('Error fetching difficulties:', error);
    res.status(500).json({ error: 'Failed to fetch difficulty levels' });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Debug endpoint
app.get('/api/debug-admin', async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, role, full_name, password_hash')
      .eq('role', 'admin');

    if (error) {
      return res.json({ error: error.message });
    }

    res.json({
      success: true,
      adminCount: users?.length || 0,
      admins: users?.map(u => ({
        id: u.id,
        username: u.username,
        role: u.role,
        fullName: u.full_name,
        hasPassword: !!u.password_hash
      }))
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Learn & Earn server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📄 PDF extraction: POST to http://localhost:${PORT}/api/admin/extract-questions`);
  console.log(`📊 Admin activities: GET to http://localhost:${PORT}/api/admin/activities`);
  console.log(`📊 Dashboard stats: GET to http://localhost:${PORT}/api/admin/dashboard-stats`);
  console.log(`📚 Question Bank: GET to http://localhost:${PORT}/api/admin/question-bank`);
  console.log(`📚 Question Bank Stats: GET to http://localhost:${PORT}/api/admin/question-bank/stats`);
  console.log(`📝 Save Question: POST to http://localhost:${PORT}/api/admin/question-bank`);
  console.log(`🎲 Generate Quiz: GET to http://localhost:${PORT}/api/quiz/generate`);
  console.log(`🖼️ Image upload: POST to http://localhost:${PORT}/api/admin/upload-image`);
  console.log(`👥 Learner Management: GET/POST to http://localhost:${PORT}/api/admin/learners`);
  console.log(`📈 Level Progression: GET/POST to http://localhost:${PORT}/api/learner/progress`);
  console.log(`🔓 Level Access Check: GET to http://localhost:${PORT}/api/learner/can-access-level/:level`);
  console.log(`✅ Auto-detection of correct answers is enabled for PDF imports`);
  console.log(`🎲 Question and option randomization is enabled for learners`);
  console.log(`📚 Class assignment endpoints are enabled`);
  console.log(`🎯 Random question selection from question bank is enabled`);
  console.log(`🔐 Progressive level unlocking is enabled`);
  console.log(`⚡ Strict class-level relationship enforced (Standards 5-8 only)`);
});