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
const pdfParse = require('pdf-parse'); // Add this for PDF parsing

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

// Configure multer for memory storage (for R2 upload)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only images are allowed (jpeg, jpg, png, gif, webp)'));
    }
  }
});

// PDF upload configuration (10MB limit)
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
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

// ============ PDF EXTRACTION FUNCTION ============
const extractQuestionsFromPDF = (text) => {
  const questions = [];
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  let currentQuestion = null;
  let currentOptions = [];
  let foundAnswer = null;
  
  // Patterns for detection
  const questionPatterns = [
    /^(\d+)[\.\)]\s+(.+)/,                    // "1. Question"
    /^Q(\d+)[\.\):]\s+(.+)/i,                 // "Q1. Question" or "Q1: Question"
    /^(\d+)\)\s+(.+)/,                         // "1) Question"
  ];
  
  const optionPatterns = [
    /^([A-D])[\.\)]\s+(.+)/i,                 // "A. Option" or "A) Option"
    /^([a-d])[\.\)]\s+(.+)/,                  // "a. Option" or "a) Option"
  ];
  
  const answerPatterns = [
    /^Answer:\s*([A-D])/i,                    // "Answer: A"
    /^Correct Answer:\s*([A-D])/i,            // "Correct Answer: B"
    /^\*{0,2}([A-D])\*{0,2}\s*$/i,            // "*A" or "B*"
    /^Right Answer:\s*([A-D])/i,              // "Right Answer: C"
    /^Ans\.:\s*([A-D])/i,                     // "Ans.: D"
  ];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if line is a question
    let isQuestion = false;
    let questionText = '';
    
    for (const pattern of questionPatterns) {
      const match = line.match(pattern);
      if (match) {
        questionText = match[2];
        isQuestion = true;
        break;
      }
    }
    
    // If question found, save previous question and start new one
    if (isQuestion) {
      if (currentQuestion && currentOptions.length >= 2 && foundAnswer) {
        // Only add if we have question, options, and answer
        const answerIndex = foundAnswer.toUpperCase().charCodeAt(0) - 65;
        if (currentOptions[answerIndex]) {
          questions.push({
            question: currentQuestion,
            options: currentOptions,
            correctAnswer: currentOptions[answerIndex]
          });
        }
      }
      
      currentQuestion = questionText;
      currentOptions = [];
      foundAnswer = null;
      continue;
    }
    
    // Check if line is an option
    let isOption = false;
    let optionText = '';
    let optionLetter = '';
    
    for (const pattern of optionPatterns) {
      const match = line.match(pattern);
      if (match) {
        optionLetter = match[1].toUpperCase();
        optionText = match[2];
        isOption = true;
        break;
      }
    }
    
    if (isOption && currentQuestion) {
      currentOptions[optionLetter.charCodeAt(0) - 65] = optionText;
      continue;
    }
    
    // Check if line contains the answer
    for (const pattern of answerPatterns) {
      const match = line.match(pattern);
      if (match && currentQuestion) {
        foundAnswer = match[1].toUpperCase();
        break;
      }
    }
  }
  
  // Don't forget the last question
  if (currentQuestion && currentOptions.length >= 2 && foundAnswer) {
    const answerIndex = foundAnswer.toUpperCase().charCodeAt(0) - 65;
    if (currentOptions[answerIndex]) {
      questions.push({
        question: currentQuestion,
        options: currentOptions,
        correctAnswer: currentOptions[answerIndex]
      });
    }
  }
  
  return questions;
};

// ============ PDF UPLOAD AND EXTRACTION ENDPOINT ============
app.post('/api/admin/extract-questions', authenticateToken, requireAdmin, pdfUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file provided' });
    }

    // Parse the PDF file
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text;
    
    console.log(`📄 PDF extracted: ${text.length} characters`);
    
    // Extract questions from the text
    const extractedQuestions = extractQuestionsFromPDF(text);
    
    console.log(`✅ Extracted ${extractedQuestions.length} questions`);
    
    if (extractedQuestions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No questions could be extracted from the PDF. Please ensure your PDF follows the correct format.' 
      });
    }
    
    res.json({
      success: true,
      questions: extractedQuestions,
      message: `Successfully extracted ${extractedQuestions.length} questions`
    });
    
  } catch (error) {
    console.error('PDF extraction error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to extract questions from PDF',
      details: error.message 
    });
  }
});

// ============ EXCEL/CSV UPLOAD AND EXTRACTION ENDPOINT ============
app.post('/api/admin/import-questions', authenticateToken, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    const fileType = req.file.mimetype;
    const questions = [];
    
    if (fileType === 'text/csv' || fileType === 'application/vnd.ms-excel') {
      // Parse CSV
      const csvData = req.file.buffer.toString('utf-8');
      const rows = csvData.split('\n');
      const headers = rows[0].split(',');
      
      for (let i = 1; i < rows.length; i++) {
        const columns = rows[i].split(',');
        if (columns.length >= 6) {
          questions.push({
            question: columns[0]?.trim(),
            options: [columns[1]?.trim(), columns[2]?.trim(), columns[3]?.trim(), columns[4]?.trim()],
            correctAnswer: columns[5]?.trim()
          });
        }
      }
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      // For Excel files, you'd need to add the 'xlsx' package
      return res.status(400).json({ error: 'Excel files not yet supported. Please use CSV format.' });
    }
    
    res.json({
      success: true,
      questions: questions.filter(q => q.question && q.correctAnswer),
      message: `Imported ${questions.length} questions`
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

    // Generate unique filename
    const fileExtension = path.extname(req.file.originalname);
    const fileName = `${uuidv4()}${fileExtension}`;
    const fileKey = `quizzes/${fileName}`;

    // Upload to Cloudflare R2
    const command = new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await r2Client.send(command);

    // Generate public URL
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

    // Extract file key from URL
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

// ============ CORRECTED ADMIN LOGIN (USING ARRAY RESPONSE) ============
app.post('/api/auth/login', async (req, res) => {
  console.log('📨 Admin login request:', { username: req.body.username });
  
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Query using array response instead of single()
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, full_name, role, password_hash')
      .eq('username', username.trim())
      .eq('role', 'admin');

    console.log('📊 Query results:', { 
      usersFound: users?.length || 0, 
      error: error?.message 
    });

    if (error) {
      console.log('❌ Database error:', error.message);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!users || users.length === 0) {
      console.log('❌ No admin found with username:', username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0]; // Get the first user from the array
    console.log('✅ Admin found:', { id: user.id, username: user.username });

    if (!user.password_hash) {
      console.log('❌ No password hash for admin');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    console.log('🔑 Password valid:', isValid);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ Login successful, token generated');

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

// ============ TEST ENDPOINT (Hardcoded - works!) ============
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

// Admin alternative login endpoint
app.post('/api/auth/admin-login', async (req, res) => {
  console.log('📨 Admin login (alt):', { username: req.body.username });
  
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
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============ LEARNER AUTHENTICATION ENDPOINTS ============

// Learner Login (using single users table)
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

// Get Learner Points Balance
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

// Get Learner Profile
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

    res.json({ success: true, learner: users[0] });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Get Available Quizzes
app.get('/api/learner/quizzes', authenticateToken, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select('*')
      .eq('is_active', true)
      .or(`start_time.lte.${now},start_time.is.null`)
      .or(`end_time.gte.${now},end_time.is.null`)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quizzes: quizzes || [] });
  } catch (error) {
    console.error('Get quizzes error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

// Get Quiz Page Topics
app.get('/api/learner/quiz-topics', authenticateToken, async (req, res) => {
  try {
    const topics = [
      {
        id: 'social-studies',
        title: 'Social Studies',
        description: 'Learn about people, history, places, and our communities.',
        icon: '🌍',
        totalQuizzes: 12,
        rewardPoints: 50,
        gradient: 'from-blue-600 to-cyan-500'
      },
      {
        id: 'primary-science',
        title: 'Primary Science',
        description: 'Explore nature, plants, animals, energy, and the human body.',
        icon: '🔬',
        totalQuizzes: 15,
        rewardPoints: 60,
        gradient: 'from-emerald-600 to-teal-400'
      },
      {
        id: 'arts-life-skills',
        title: 'Arts & Life Skills',
        description: 'Discover creative arts, health habits, and important safety skills.',
        icon: '🎨',
        totalQuizzes: 8,
        rewardPoints: 40,
        gradient: 'from-amber-500 to-orange-400'
      },
      {
        id: 'mathematics',
        title: 'Mathematics',
        description: 'Practice numbers, fractions, geometry, and solving word problems.',
        icon: '🔢',
        totalQuizzes: 20,
        rewardPoints: 75,
        gradient: 'from-indigo-600 to-purple-500'
      },
      {
        id: 'english',
        title: 'English Language',
        description: 'Improve your reading, spelling, sentence structures, and grammar.',
        icon: '📚',
        totalQuizzes: 14,
        rewardPoints: 50,
        gradient: 'from-pink-600 to-rose-400'
      }
    ];

    res.json({ success: true, topics });
  } catch (error) {
    console.error('Get quiz topics error:', error);
    res.status(500).json({ error: 'Failed to fetch quiz topics' });
  }
});

// Get quizzes by topic slug
app.get('/api/learner/quizzes/topic/:topicId', authenticateToken, async (req, res) => {
  try {
    const { topicId } = req.params;
    const now = new Date().toISOString();

    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select('*')
      .eq('is_active', true)
      .ilike('topic', `%${topicId}%`)
      .or(`start_time.lte.${now},start_time.is.null`)
      .or(`end_time.gte.${now},end_time.is.null`);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, quizzes: quizzes || [] });
  } catch (error) {
    console.error('Get quizzes by topic error:', error);
    res.status(500).json({ error: 'Failed to fetch quizzes for topic' });
  }
});

// Get Single Quiz with Questions
app.get('/api/learner/quiz/:quizId', authenticateToken, async (req, res) => {
  try {
    const { quizId } = req.params;

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

    res.json({ success: true, quiz });
  } catch (error) {
    console.error('Get quiz error:', error);
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
});

// Submit Quiz Answers
app.post('/api/learner/quiz-submit', authenticateToken, async (req, res) => {
  try {
    const { quizId, answers, score } = req.body;
    const userId = req.user.id;

    if (!quizId || !answers) {
      return res.status(400).json({ error: 'Quiz ID and answers required' });
    }

    const { data, error } = await supabase
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

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    if (score >= 60) {
      const pointsToAward = Math.floor(score / 10);
      
      const { data: users } = await supabase
        .from('users')
        .select('current_points, lifetime_points')
        .eq('id', userId);

      if (users && users.length > 0) {
        const user = users[0];
        await supabase
          .from('users')
          .update({
            current_points: (user.current_points || 0) + pointsToAward,
            lifetime_points: (user.lifetime_points || 0) + pointsToAward
          })
          .eq('id', userId);
      }
    }

    res.json({ success: true, submission: data, message: 'Quiz submitted successfully' });
  } catch (error) {
    console.error('Quiz submit error:', error);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// Get Learner Badges
app.get('/api/learner/badges', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: badges, error } = await supabase
      .from('user_badges')
      .select('badge_id, badges(*)')
      .eq('user_id', userId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, badges: badges || [] });
  } catch (error) {
    console.error('Get badges error:', error);
    res.status(500).json({ error: 'Failed to fetch badges' });
  }
});

// Get Rewards Catalogue
app.get('/api/learner/rewards', authenticateToken, async (req, res) => {
  try {
    const { data: rewards, error } = await supabase
      .from('rewards')
      .select('*')
      .eq('is_active', true)
      .order('points_required', { ascending: true });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, rewards: rewards || [] });
  } catch (error) {
    console.error('Get rewards error:', error);
    res.status(500).json({ error: 'Failed to fetch rewards' });
  }
});

// Redeem Reward
app.post('/api/learner/redeem-reward', authenticateToken, async (req, res) => {
  try {
    const { rewardId } = req.body;
    const userId = req.user.id;

    if (!rewardId) {
      return res.status(400).json({ error: 'Reward ID required' });
    }

    const { data: rewards, error: rewardError } = await supabase
      .from('rewards')
      .select('*')
      .eq('id', rewardId);

    if (rewardError || !rewards || rewards.length === 0) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    const reward = rewards[0];

    const { data: users, error: userError } = await supabase
      .from('users')
      .select('current_points')
      .eq('id', userId);

    if (userError || !users || users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];

    if ((user.current_points || 0) < reward.points_required) {
      return res.status(400).json({ error: 'Insufficient points' });
    }

    const { data: redemption, error: redemptionError } = await supabase
      .from('redemptions')
      .insert([
        {
          user_id: userId,
          reward_id: rewardId,
          points_spent: reward.points_required,
          status: 'pending',
          requested_at: new Date()
        }
      ])
      .select()
      .single();

    if (redemptionError) {
      return res.status(400).json({ error: redemptionError.message });
    }

    await supabase
      .from('users')
      .update({ current_points: (user.current_points || 0) - reward.points_required })
      .eq('id', userId);

    res.json({ success: true, redemption, message: 'Reward redeemed successfully' });
  } catch (error) {
    console.error('Redeem reward error:', error);
    res.status(500).json({ error: 'Failed to redeem reward' });
  }
});

// ============ ADMIN ENDPOINTS ============

// Get All Learners
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

// Create Learner
app.post('/api/admin/learners', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { username, full_name, registration_number, class_level } = req.body;

    if (!username || !full_name || !registration_number) {
      return res.status(400).json({ error: 'Username, full name, and registration number are required' });
    }

    const normalizedUsername = username.trim();
    const normalizedRegNumber = registration_number.trim();

    const { count: existingUsername } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'learner')
      .eq('username', normalizedUsername);

    if (existingUsername > 0) {
      return res.status(409).json({ error: 'A learner with that username already exists' });
    }

    const { count: existingRegistration } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'learner')
      .eq('registration_number', normalizedRegNumber);

    if (existingRegistration > 0) {
      return res.status(409).json({ error: 'A learner with that registration number already exists' });
    }

    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          username: normalizedUsername,
          full_name: full_name.trim(),
          registration_number: normalizedRegNumber,
          class_level: class_level?.trim() || null,
          role: 'learner',
          current_points: 0,
          lifetime_points: 0
        }
      ])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, learner: data });
  } catch (error) {
    console.error('Create learner error:', error);
    res.status(500).json({ error: 'Failed to create learner' });
  }
});

// Get Dashboard Statistics
app.get('/api/admin/statistics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { count: totalLearners } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'learner');

    const { count: totalQuizzes } = await supabase
      .from('quizzes')
      .select('id', { count: 'exact', head: true });

    const { count: totalRewards } = await supabase
      .from('rewards')
      .select('id', { count: 'exact', head: true });

    const { count: totalRedemptions } = await supabase
      .from('redemptions')
      .select('id', { count: 'exact', head: true });

    res.json({
      success: true,
      statistics: {
        total_learners: totalLearners || 0,
        total_quizzes: totalQuizzes || 0,
        total_rewards: totalRewards || 0,
        total_redemptions: totalRedemptions || 0
      }
    });
  } catch (error) {
    console.error('Get statistics error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Admin register helper
app.post('/api/admin/register', async (req, res) => {
  try {
    const { username, password, fullName, adminKey } = req.body;

    if (!username || !password || !fullName) {
      return res.status(400).json({ error: 'Username, password, and full name are required' });
    }

    if (process.env.ADMIN_SETUP_KEY) {
      if (!adminKey || adminKey !== process.env.ADMIN_SETUP_KEY) {
        return res.status(403).json({ error: 'Invalid admin setup key' });
      }
    } else {
      const { count } = await supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin');

      if (count > 0) {
        return res.status(403).json({ error: 'Admin account already exists' });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('users')
      .insert([
        {
          username: username.trim(),
          full_name: fullName.trim(),
          role: 'admin',
          password_hash: passwordHash,
          current_points: 0,
          lifetime_points: 0
        }
      ])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, admin: data });
  } catch (error) {
    console.error('Admin register error:', error);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

// Admin reward catalog management - FIXED to use points_required
app.get('/api/admin/rewards', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: rewards, error } = await supabase
      .from('rewards')
      .select('*')
      .order('points_required', { ascending: true });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, rewards: rewards || [] });
  } catch (error) {
    console.error('Get admin rewards error:', error);
    res.status(500).json({ error: 'Failed to fetch admin rewards' });
  }
});

app.post('/api/admin/rewards', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, description, points_required, stock_quantity, image_url, is_active } = req.body;

    console.log('Creating reward with data:', { name, points_required, stock_quantity, image_url });

    if (!name || !points_required) {
      return res.status(400).json({ error: 'Reward name and points are required' });
    }

    const pointsRequiredNum = Number(points_required);
    if (isNaN(pointsRequiredNum) || pointsRequiredNum <= 0) {
      return res.status(400).json({ error: 'Points required must be a valid number greater than 0' });
    }

    const { data, error } = await supabase
      .from('rewards')
      .insert([
        {
          name: name.trim(),
          description: description?.trim() || '',
          points_required: pointsRequiredNum,
          stock_quantity: stock_quantity ? Number(stock_quantity) : 0,
          image_url: image_url?.trim() || null,
          is_active: is_active !== false
        }
      ])
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, reward: data });
  } catch (error) {
    console.error('Create reward error:', error);
    res.status(500).json({ error: 'Failed to create reward: ' + error.message });
  }
});

app.put('/api/admin/rewards/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, points_required, stock_quantity, image_url, is_active } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();
    if (points_required !== undefined) updates.points_required = Number(points_required);
    if (stock_quantity !== undefined) updates.stock_quantity = Number(stock_quantity);
    if (image_url !== undefined) updates.image_url = image_url.trim() || null;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
      .from('rewards')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, reward: data });
  } catch (error) {
    console.error('Update reward error:', error);
    res.status(500).json({ error: 'Failed to update reward' });
  }
});

app.delete('/api/admin/rewards/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('rewards')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Reward deleted' });
  } catch (error) {
    console.error('Delete reward error:', error);
    res.status(500).json({ error: 'Failed to delete reward' });
  }
});

// Admin badge management
app.get('/api/admin/badges', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: badges, error } = await supabase
      .from('badges')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, badges: badges || [] });
  } catch (error) {
    console.error('Get admin badges error:', error);
    res.status(500).json({ error: 'Failed to fetch badges' });
  }
});

app.post('/api/admin/badges', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, description, icon_url, criteria, is_active } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Badge name is required' });
    }

    const { data, error } = await supabase
      .from('badges')
      .insert([
        {
          name: name.trim(),
          description: description?.trim() || '',
          icon_url: icon_url?.trim() || '',
          criteria: criteria?.trim() || '',
          is_active: is_active !== false
        }
      ])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, badge: data });
  } catch (error) {
    console.error('Create badge error:', error);
    res.status(500).json({ error: 'Failed to create badge' });
  }
});

app.put('/api/admin/badges/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('badges')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, badge: data });
  } catch (error) {
    console.error('Update badge error:', error);
    res.status(500).json({ error: 'Failed to update badge' });
  }
});

app.delete('/api/admin/badges/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('badges')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: 'Badge deleted' });
  } catch (error) {
    console.error('Delete badge error:', error);
    res.status(500).json({ error: 'Failed to delete badge' });
  }
});

app.post('/api/admin/badges/assign', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { user_id, badge_id } = req.body;

    if (!user_id || !badge_id) {
      return res.status(400).json({ error: 'User ID and badge ID are required' });
    }

    const { data, error } = await supabase
      .from('user_badges')
      .insert([
        {
          user_id,
          badge_id
        }
      ])
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, assignment: data });
  } catch (error) {
    console.error('Assign badge error:', error);
    res.status(500).json({ error: 'Failed to assign badge' });
  }
});

// Admin quiz management
app.post('/api/admin/quizzes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, topic, description, questions, start_time, end_time, is_active, image_url, assigned_classes, difficulty } = req.body;

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
      assigned_classes: assigned_classes || [],
      difficulty: difficulty || 'intermediate',
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

app.put('/api/admin/quizzes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, topic, description, questions, start_time, end_time, is_active, image_url, assigned_classes, difficulty } = req.body;

    const updates = {
      title: title?.trim(),
      topic: topic?.trim(),
      description: description?.trim(),
      questions,
      start_time: start_time || null,
      end_time: end_time || null,
      is_active: is_active !== false,
      image_url: image_url?.trim() || null,
      assigned_classes: assigned_classes || [],
      difficulty: difficulty || 'intermediate',
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

app.delete('/api/admin/quizzes/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // First, delete all submissions related to this quiz
    const { error: submissionsError } = await supabase
      .from('quiz_submissions')
      .delete()
      .eq('quiz_id', id);
    
    if (submissionsError) {
      console.error('Error deleting submissions:', submissionsError);
    }
    
    // Then delete the quiz
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

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { data: leaderboard, error } = await supabase
      .from('users')
      .select('id, username, full_name, current_points, lifetime_points, class_level')
      .eq('role', 'learner')
      .order('lifetime_points', { ascending: false })
      .limit(100);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, leaderboard: leaderboard || [] });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Debug endpoint - Check admin status
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
        hasPassword: !!u.password_hash,
        passwordPreview: u.password_hash ? u.password_hash.substring(0, 20) + '...' : null
      }))
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
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
  console.log(`🔍 Debug admin: http://localhost:${PORT}/api/debug-admin`);
  console.log(`🧪 Test login: POST to http://localhost:${PORT}/api/auth/test-login`);
  console.log(`🖼️ Image upload: POST to http://localhost:${PORT}/api/admin/upload-image`);
  console.log(`📄 PDF extraction: POST to http://localhost:${PORT}/api/admin/extract-questions`);
});