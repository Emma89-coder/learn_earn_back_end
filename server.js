const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';
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

// ============ INITIALIZE EXPRESS APP ============
const app = express();

// ============ AI ROUTES ============
const aiRoutes = require('./routes/admin/ai');
app.use('/api/ai', aiRoutes);

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

// Supabase Client (initialized at startup after DNS check)
let supabase;

// ============ CLOUDFLARE R2 CONFIGURATION ============
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

// ============ CLOUDFLARE R2 HELPER FUNCTIONS ============
const uploadToR2 = async (buffer, fileName, mimeType) => {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileName,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000',
    });

    await r2Client.send(command);
    const url = `${process.env.CLOUDFLARE_PUBLIC_URL}/${fileName}`;
    return { success: true, url };
  } catch (error) {
    console.error('Error uploading to R2:', error);
    return { success: false, error: error.message };
  }
};

const deleteFromR2 = async (fileName) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET,
      Key: fileName,
    });

    await r2Client.send(command);
    return { success: true };
  } catch (error) {
    console.error('Error deleting from R2:', error);
    return { success: false, error: error.message };
  }
};

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

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (!role || !role.includes('admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ============ REWARDS ENDPOINTS ============

// Get all rewards
app.get('/api/admin/rewards', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: rewards, error } = await supabase
      .from('rewards')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching rewards:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, rewards: rewards || [] });
  } catch (error) {
    console.error('Get rewards error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rewards' });
  }
});

// Create a new reward
app.post('/api/admin/create-reward', authenticateToken, requireAdmin, async (req, res) => {
  console.log('📝 Creating new reward:', req.body);
  
  try {
    const { name, description, points_required, stock_quantity, image_url, is_active } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Reward name is required' });
    }

    if (!points_required || points_required <= 0) {
      return res.status(400).json({ success: false, error: 'Points required must be greater than 0' });
    }

    const newReward = {
      name: name.trim(),
      description: description?.trim() || '',
      points_required: parseInt(points_required),
      stock_quantity: parseInt(stock_quantity) || 0,
      image_url: image_url || null,
      is_active: is_active !== false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('Inserting reward with data:', newReward);

    const { data, error } = await supabase
      .from('rewards')
      .insert([newReward])
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log('✅ Reward created successfully:', data.id);
    res.json({ success: true, reward: data, message: 'Reward created successfully' });
  } catch (error) {
    console.error('Create reward error:', error);
    res.status(500).json({ success: false, error: 'Failed to create reward' });
  }
});

// Update a reward

app.post('/api/admin/update-reward/:id', authenticateToken, requireAdmin, async (req, res) => {
  console.log('✏️ Updating reward:', req.params.id, req.body);
  
  try {
    const { id } = req.params;
    const { name, description, points_required, stock_quantity, image_url, is_active } = req.body;

    // Check if reward exists
    const { data: existingReward, error: fetchError } = await supabase
      .from('rewards')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingReward) {
      return res.status(404).json({ success: false, error: 'Reward not found' });
    }

    const updates = {
      name: name?.trim(),
      description: description?.trim() || '',
      points_required: parseInt(points_required),
      stock_quantity: parseInt(stock_quantity) || 0,
      image_url: image_url || null,
      is_active: is_active !== false,
      updated_at: new Date().toISOString()
    };

    // Remove undefined fields
    Object.keys(updates).forEach(key => updates[key] === undefined && delete updates[key]);

    console.log('Updating reward with data:', updates);

    const { data, error } = await supabase
      .from('rewards')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log('✅ Reward updated successfully:', data.id);
    res.json({ success: true, reward: data, message: 'Reward updated successfully' });
  } catch (error) {
    console.error('Update reward error:', error);
    res.status(500).json({ success: false, error: 'Failed to update reward' });
  }
});

// Delete a reward
app.delete('/api/admin/delete-reward/:id', authenticateToken, requireAdmin, async (req, res) => {
  console.log('🗑️ Deleting reward:', req.params.id);
  
  try {
    const { id } = req.params;

    // Check if reward exists
    const { data: existingReward, error: fetchError } = await supabase
      .from('rewards')
      .select('id, image_url')
      .eq('id', id)
      .single();

    if (fetchError || !existingReward) {
      return res.status(404).json({ success: false, error: 'Reward not found' });
    }

    // Delete image from R2 if exists
    if (existingReward.image_url) {
      try {
        const fileKey = existingReward.image_url.split('/').slice(-2).join('/');
        await deleteFromR2(fileKey);
        console.log('✅ Deleted image from R2');
      } catch (deleteError) {
        console.error('Error deleting image from R2:', deleteError);
        // Continue with reward deletion even if image deletion fails
      }
    }

    const { error } = await supabase
      .from('rewards')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Supabase delete error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    console.log('✅ Reward deleted successfully:', id);
    res.json({ success: true, message: 'Reward deleted successfully' });
  } catch (error) {
    console.error('Delete reward error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete reward' });
  }
});

// ============ LEARNER REWARDS ENDPOINTS ============

// Get available rewards for learners (no admin required)
app.get('/api/learner/rewards', authenticateToken, async (req, res) => {
  try {
    const { data: rewards, error } = await supabase
      .from('rewards')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching learner rewards:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, rewards: rewards || [] });
  } catch (error) {
    console.error('Get learner rewards error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rewards' });
  }
});

// ============ LEADERBOARD ENDPOINT ============

// Get global leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    // Get all learners with their points
    const { data: learners, error } = await supabase
      .from('users')
      .select('id, username, full_name, class_level, current_points, lifetime_points, role')
      .eq('role', 'learner')
      .order('lifetime_points', { ascending: false });

    if (error) {
      console.error('Error fetching leaderboard:', error);
      return res.status(400).json({ success: false, error: error.message });
    }

    // Add rank to each learner
    const leaderboard = (learners || []).map((learner, index) => ({
      ...learner,
      rank: index + 1
    }));

    res.json({ 
      success: true, 
      leaderboard: leaderboard,
      total: leaderboard.length
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

// Redeem a reward
app.post('/api/learner/redeem-reward', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rewardId } = req.body;

    if (!rewardId) {
      return res.status(400).json({ error: 'Reward ID is required' });
    }

    // Get the reward
    const { data: reward, error: rewardError } = await supabase
      .from('rewards')
      .select('*')
      .eq('id', rewardId)
      .eq('is_active', true)
      .single();

    if (rewardError || !reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    // Check stock
    if (reward.stock_quantity !== undefined && reward.stock_quantity <= 0) {
      return res.status(400).json({ error: 'Reward is out of stock' });
    }

    // Get user's current points
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('current_points, lifetime_points')
      .eq('id', userId)
      .single();

    if (userError || !userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user has enough points
    if (userData.current_points < reward.points_required) {
      return res.status(400).json({ error: 'Insufficient points' });
    }

    // Start a transaction - deduct points and update stock
    const newPoints = userData.current_points - reward.points_required;
    const newStock = reward.stock_quantity !== undefined ? reward.stock_quantity - 1 : null;

    // Update user points
    const { error: updatePointsError } = await supabase
      .from('users')
      .update({
        current_points: newPoints,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updatePointsError) {
      console.error('Error updating points:', updatePointsError);
      return res.status(500).json({ error: 'Failed to process redemption' });
    }

    // Update reward stock if stock is tracked
    if (newStock !== null) {
      const { error: updateStockError } = await supabase
        .from('rewards')
        .update({
          stock_quantity: newStock,
          updated_at: new Date().toISOString()
        })
        .eq('id', rewardId);

      if (updateStockError) {
        console.error('Error updating stock:', updateStockError);
        // Rollback points if stock update fails
        await supabase
          .from('users')
          .update({
            current_points: userData.current_points,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);
        return res.status(500).json({ error: 'Failed to process redemption' });
      }
    }

    // Record the redemption
    const { error: redeemError } = await supabase
      .from('redemptions')
      .insert([{
        user_id: userId,
        reward_id: rewardId,
        points_spent: reward.points_required,
        redeemed_at: new Date().toISOString(),
        status: 'completed'
      }]);

    if (redeemError) {
      console.error('Error recording redemption:', redeemError);
      // Don't fail the request, just log the error
    }

    res.json({
      success: true,
      message: 'Reward redeemed successfully!',
      points_remaining: newPoints
    });
  } catch (error) {
    console.error('Redeem reward error:', error);
    res.status(500).json({ error: 'Failed to redeem reward' });
  }
});

// Get user's redemption history
app.get('/api/learner/redemptions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: redemptions, error } = await supabase
      .from('redemptions')
      .select(`
        *,
        rewards:reward_id (name, image_url, points_required)
      `)
      .eq('user_id', userId)
      .order('redeemed_at', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({
      success: true,
      redemptions: redemptions || []
    });
  } catch (error) {
    console.error('Get redemptions error:', error);
    res.status(500).json({ error: 'Failed to fetch redemption history' });
  }
});

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

// ============ HANGMAN ROUTES ============

// Get all words (admin)
app.get('/api/admin/hangman/words', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: words, error } = await supabase
      .from('words')
      .select('*')
      .order('category', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;

    res.json({ success: true, words });
  } catch (error) {
    console.error('Error fetching words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Add new word (admin)
app.post('/api/admin/hangman/words', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { word, category, hint, difficulty, points } = req.body;
    
    if (!word || !category) {
      return res.status(400).json({ 
        success: false, 
        message: 'Word and category are required' 
      });
    }

    // Check if word already exists in this category
    const { data: existingWord, error: checkError } = await supabase
      .from('words')
      .select('id')
      .eq('word', word.toUpperCase())
      .eq('category', category)
      .maybeSingle();

    if (existingWord) {
      return res.status(400).json({ 
        success: false, 
        message: 'This word already exists in this category' 
      });
    }

    let imageUrl = null;
    let imagePath = null;

    // Upload image to Cloudflare R2 if provided
    if (req.file) {
      const fileName = `hangman/${Date.now()}-${req.file.originalname}`;
      const uploadResult = await uploadToR2(
        req.file.buffer,
        fileName,
        req.file.mimetype
      );
      
      if (uploadResult.success) {
        imageUrl = uploadResult.url;
        imagePath = fileName;
      } else {
        return res.status(500).json({
          success: false,
          message: 'Failed to upload image'
        });
      }
    }

    const wordData = {
      word: word.toUpperCase(),
      category,
      hint: hint || '',
      difficulty: difficulty || 'medium',
      points: parseInt(points) || 10,
      image_url: imageUrl,
      image_path: imagePath,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newWord, error } = await supabase
      .from('words')
      .insert([wordData])
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      success: true, 
      message: 'Word added successfully',
      word: newWord 
    });
  } catch (error) {
    console.error('Error adding word:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to add word: ' + error.message 
    });
  }
});

// Update word (admin)
app.put('/api/admin/hangman/words/:id', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { word, category, hint, difficulty, points, removeImage, is_active } = req.body;

    // Get existing word
    const { data: existingWord, error: fetchError } = await supabase
      .from('words')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existingWord) {
      return res.status(404).json({ 
        success: false, 
        message: 'Word not found' 
      });
    }

    let imageUrl = existingWord.image_url;
    let imagePath = existingWord.image_path;

    // Handle image removal
    if (removeImage === 'true' || removeImage === true) {
      if (existingWord.image_path) {
        await deleteFromR2(existingWord.image_path);
      }
      imageUrl = null;
      imagePath = null;
    }

    // Upload new image if provided
    if (req.file) {
      // Delete old image if exists
      if (existingWord.image_path) {
        await deleteFromR2(existingWord.image_path);
      }

      const fileName = `hangman/${Date.now()}-${req.file.originalname}`;
      const uploadResult = await uploadToR2(
        req.file.buffer,
        fileName,
        req.file.mimetype
      );
      
      if (uploadResult.success) {
        imageUrl = uploadResult.url;
        imagePath = fileName;
      } else {
        return res.status(500).json({
          success: false,
          message: 'Failed to upload image'
        });
      }
    }

    const wordData = {
      word: word ? word.toUpperCase() : existingWord.word,
      category: category || existingWord.category,
      hint: hint !== undefined ? hint : existingWord.hint,
      difficulty: difficulty || existingWord.difficulty,
      points: points !== undefined ? parseInt(points) : existingWord.points,
      image_url: imageUrl,
      image_path: imagePath,
      updated_at: new Date().toISOString()
    };

    // Add is_active if provided (for toggling status)
    if (is_active !== undefined) {
      wordData.is_active = is_active;
    }

    const { data: updatedWord, error } = await supabase
      .from('words')
      .update(wordData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      success: true, 
      message: 'Word updated successfully',
      word: updatedWord 
    });
  } catch (error) {
    console.error('Error updating word:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update word: ' + error.message 
    });
  }
});

// Delete word (admin)
app.delete('/api/admin/hangman/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get word to delete image if exists
    const { data: word, error: fetchError } = await supabase
      .from('words')
      .select('image_path')
      .eq('id', id)
      .single();

    if (fetchError) {
      return res.status(404).json({ 
        success: false, 
        message: 'Word not found' 
      });
    }

    // Delete image from Cloudflare R2 if exists
    if (word.image_path) {
      await deleteFromR2(word.image_path);
    }

    const { error } = await supabase
      .from('words')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ 
      success: true, 
      message: 'Word deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting word:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete word: ' + error.message 
    });
  }
});

// Bulk import words (admin)
app.post('/api/admin/hangman/words/import', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { words } = req.body;
    
    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid data format' 
      });
    }

    const imported = [];
    const errors = [];

    for (const wordData of words) {
      const { word, category, hint, difficulty, points, image_url } = wordData;
      
      if (word && category) {
        try {
          // Check if word already exists
          const { data: existing, error: checkError } = await supabase
            .from('words')
            .select('id')
            .eq('word', word.toUpperCase())
            .eq('category', category)
            .maybeSingle();

          if (existing) {
            errors.push(`${word} already exists in ${category}`);
            continue;
          }

          const newWord = {
            word: word.toUpperCase(),
            category,
            hint: hint || '',
            difficulty: difficulty || 'medium',
            points: parseInt(points) || 10,
            image_url: image_url || null,
            image_path: null,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          const { data: insertedWord, error } = await supabase
            .from('words')
            .insert([newWord])
            .select()
            .single();

          if (!error && insertedWord) {
            imported.push(insertedWord);
          } else {
            errors.push(`Failed to import ${word}: ${error?.message}`);
          }
        } catch (err) {
          errors.push(`Error importing ${word}: ${err.message}`);
        }
      }
    }

    res.json({ 
      success: true, 
      message: `Imported ${imported.length} words successfully. ${errors.length} errors.`,
      imported,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error importing words:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to import words: ' + error.message 
    });
  }
});

// Get word statistics (admin)
app.get('/api/admin/hangman/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Get total words count
    const { count: totalWords, error: totalError } = await supabase
      .from('words')
      .select('*', { count: 'exact', head: true });

    if (totalError) throw totalError;

    // Get words with images count
    const { count: wordsWithImages, error: imageError } = await supabase
      .from('words')
      .select('*', { count: 'exact', head: true })
      .not('image_url', 'is', null);

    if (imageError) throw imageError;

    // Get category distribution
    const { data: categoryData, error: catError } = await supabase
      .from('words')
      .select('category')
      .not('category', 'is', null);

    if (catError) throw catError;

    const categoryDistribution = {};
    categoryData.forEach(item => {
      categoryDistribution[item.category] = (categoryDistribution[item.category] || 0) + 1;
    });

    // Get difficulty distribution
    const { data: difficultyData, error: diffError } = await supabase
      .from('words')
      .select('difficulty');

    if (diffError) throw diffError;

    const difficultyDistribution = {};
    difficultyData.forEach(item => {
      const diff = item.difficulty || 'medium';
      difficultyDistribution[diff] = (difficultyDistribution[diff] || 0) + 1;
    });

    // Get average points
    const { data: pointsData, error: pointsError } = await supabase
      .from('words')
      .select('points');

    if (pointsError) throw pointsError;

    let totalPoints = 0;
    pointsData.forEach(item => {
      totalPoints += item.points || 10;
    });
    const avgPoints = pointsData.length > 0 ? Math.round(totalPoints / pointsData.length) : 0;

    res.json({
      success: true,
      stats: {
        totalWords: totalWords || 0,
        wordsWithImages: wordsWithImages || 0,
        avgPoints,
        categories: Object.keys(categoryDistribution).length,
        categoryDistribution,
        difficultyDistribution
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ============ LEARNER HANGMAN ROUTES ============

// Get all active words for learners
app.get('/api/hangman/words', authenticateToken, async (req, res) => {
  try {
    const { data: words, error } = await supabase
      .from('words')
      .select('id, word, category, hint, difficulty, points, image_url')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;

    res.json({ 
      success: true, 
      words: words || [],
      count: words?.length || 0
    });
  } catch (error) {
    console.error('Error fetching learner words:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch words',
      words: []
    });
  }
});

// Get categories with word counts for learners
app.get('/api/hangman/categories', authenticateToken, async (req, res) => {
  try {
    const { data: categories, error } = await supabase
      .from('words')
      .select('category')
      .eq('is_active', true)
      .order('category');

    if (error) throw error;

    const categoryMap = {};
    categories.forEach(item => {
      categoryMap[item.category] = (categoryMap[item.category] || 0) + 1;
    });

    const result = Object.entries(categoryMap).map(([category, count]) => ({
      category,
      count
    }));

    res.json({ 
      success: true, 
      categories: result 
    });
  } catch (error) {
    console.error('Error fetching learner categories:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch categories' 
    });
  }
});

// Get words by category for learners
app.get('/api/hangman/words/category/:category', authenticateToken, async (req, res) => {
  try {
    const { category } = req.params;
    
    const { data: words, error } = await supabase
      .from('words')
      .select('id, word, category, hint, difficulty, points, image_url')
      .eq('category', category)
      .eq('is_active', true)
      .order('word', { ascending: true });

    if (error) throw error;

    res.json({ 
      success: true, 
      words: words || [] 
    });
  } catch (error) {
    console.error('Error fetching words by category:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch words' 
    });
  }
});

/// ============ HANGMAN TRACK ATTEMPT ENDPOINT ============
app.post('/api/hangman/track-attempt', authenticateToken, async (req, res) => {
  try {
    const { wordId, correct, attempts, timeSpent } = req.body;
    const userId = req.user.id;

    console.log('📝 Tracking Hangman attempt:', { wordId, correct, attempts, timeSpent, userId });

    if (!wordId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Word ID is required' 
      });
    }

    // First, verify the word exists and get its points
    const { data: wordData, error: wordError } = await supabase
      .from('words')
      .select('id, points, word')
      .eq('id', wordId)
      .maybeSingle();

    if (wordError) {
      console.error('Error fetching word:', wordError);
    }

    // If word not found, try with string conversion
    let wordIdToUse = wordId;
    if (!wordData) {
      console.log('Word not found with provided ID, trying string conversion...');
      const { data: wordByString, error: stringError } = await supabase
        .from('words')
        .select('id, points, word')
        .eq('id', String(wordId))
        .maybeSingle();
      
      if (!stringError && wordByString) {
        wordIdToUse = String(wordId);
        wordData = wordByString;
        console.log('Found word with string ID:', wordByString);
      }
    }

    // Insert attempt record with proper error handling
    let attemptError;
    try {
      const { error } = await supabase
        .from('word_attempts')
        .insert([{
          word_id: wordIdToUse,
          user_id: userId,
          correct: correct || false,
          attempts: attempts || 1,
          time_spent: timeSpent || 0,
          attempted_at: new Date().toISOString()
        }]);
      attemptError = error;
    } catch (insertError) {
      console.error('Insert error:', insertError);
      attemptError = insertError;
    }

    if (attemptError) {
      console.error('Error inserting attempt:', attemptError);
      
      // If the error is about UUID format, try with integer conversion
      if (attemptError.code === '22P02' || attemptError.message?.includes('uuid')) {
        console.log('🔄 UUID format error, trying integer conversion...');
        
        // Try to find the word with integer ID
        const { data: wordByInt, error: intError } = await supabase
          .from('words')
          .select('id, points, word')
          .eq('id', parseInt(wordId))
          .maybeSingle();
        
        if (!intError && wordByInt) {
          console.log('Found word with integer ID:', wordByInt);
          
          // Retry with integer ID
          const { error: retryError } = await supabase
            .from('word_attempts')
            .insert([{
              word_id: parseInt(wordId),
              user_id: userId,
              correct: correct || false,
              attempts: attempts || 1,
              time_spent: timeSpent || 0,
              attempted_at: new Date().toISOString()
            }]);
          
          if (retryError) {
            console.error('Retry with integer ID failed:', retryError);
            return res.status(500).json({ 
              success: false, 
              message: 'Failed to track attempt: ' + retryError.message 
            });
          }
          
          // Update wordData for points
          wordData = wordByInt;
        } else {
          // If still can't find the word, return error
          return res.status(400).json({ 
            success: false, 
            message: 'Invalid word ID format. Please use a valid ID.' 
          });
        }
      } else {
        // Other error
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to track attempt: ' + attemptError.message 
        });
      }
    }

    // If correct and word found, add points
    if (correct && wordData) {
      const pointsToAdd = wordData.points || 2;
      console.log(`✅ Adding ${pointsToAdd} points to user ${userId} for word: ${wordData.word}`);
      
      // Get current user points
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('current_points, lifetime_points')
        .eq('id', userId)
        .single();

      if (userError) {
        console.error('Error fetching user data:', userError);
      } else if (userData) {
        const newPoints = (userData.current_points || 0) + pointsToAdd;
        const newLifetimePoints = (userData.lifetime_points || 0) + pointsToAdd;

        const { error: updateError } = await supabase
          .from('users')
          .update({
            current_points: newPoints,
            lifetime_points: newLifetimePoints,
            updated_at: new Date().toISOString()
          })
          .eq('id', userId);

        if (updateError) {
          console.error('Error updating points:', updateError);
        } else {
          console.log(`✅ Successfully added ${pointsToAdd} points to user ${userId}`);
        }
      }
    }

    res.json({ 
      success: true, 
      message: 'Attempt tracked successfully' 
    });
  } catch (error) {
    console.error('Error tracking attempt:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to track attempt: ' + error.message 
    });
  }
});

// ============ HANGMAN USER STATS ENDPOINT ============
app.get('/api/hangman/user-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('📊 Fetching Hangman stats for user:', userId);

    // Get total attempts
    const { data: attempts, error: attemptsError } = await supabase
      .from('word_attempts')
      .select('correct, attempts, attempted_at, word_id')
      .eq('user_id', userId)
      .order('attempted_at', { ascending: false });

    if (attemptsError) {
      console.error('Error fetching attempts:', attemptsError);
      // Return empty stats instead of error
      return res.json({
        success: true,
        stats: {
          totalAttempts: 0,
          correctAttempts: 0,
          successRate: 0,
          uniqueWordsCount: 0,
          totalPoints: 0,
          lifetimePoints: 0,
          recentAttempts: []
        }
      });
    }

    const totalAttempts = attempts?.length || 0;
    const correctAttempts = attempts?.filter(a => a.correct).length || 0;
    const successRate = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;

    // Get unique words attempted
    const uniqueWords = [...new Set(attempts?.map(a => a.word_id) || [])];
    const uniqueWordsCount = uniqueWords.length;

    // Get user's total points from users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('current_points, lifetime_points')
      .eq('id', userId)
      .single();

    if (userError) {
      console.error('Error fetching user data:', userError);
      // Continue with default points
    }

    // Format recent attempts
    const recentAttempts = (attempts || []).slice(0, 10).map(a => ({
      id: a.id,
      wordId: a.word_id,
      correct: a.correct,
      attempts: a.attempts,
      attempted_at: a.attempted_at || a.created_at,
      // You might want to fetch word details here if needed
    }));

    console.log(`✅ Stats: ${totalAttempts} total attempts, ${correctAttempts} correct, ${successRate}% success rate`);

    res.json({
      success: true,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate,
        uniqueWordsCount,
        totalPoints: userData?.current_points || 0,
        lifetimePoints: userData?.lifetime_points || 0,
        recentAttempts
      }
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    // Return empty stats instead of error to prevent UI issues
    res.json({
      success: true,
      stats: {
        totalAttempts: 0,
        correctAttempts: 0,
        successRate: 0,
        uniqueWordsCount: 0,
        totalPoints: 0,
        lifetimePoints: 0,
        recentAttempts: []
      }
    });
  }
});

// ============ HANGMAN WORDS FOR LEARNERS ENDPOINT ============
app.get('/api/hangman/words', authenticateToken, async (req, res) => {
  try {
    console.log('📚 Fetching Hangman words for learner:', req.user.id);

    const { data: words, error } = await supabase
      .from('words')
      .select('id, word, category, hint, difficulty, points, image_url')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('word', { ascending: true });

    if (error) {
      console.error('Error fetching words:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch words',
        words: []
      });
    }

    // Ensure each word has an id that can be used for tracking
    const formattedWords = (words || []).map(word => ({
      ...word,
      // Ensure id is properly formatted
      id: word.id || word._id
    }));

    console.log(`✅ Found ${formattedWords.length} words for learner`);

    res.json({ 
      success: true, 
      words: formattedWords,
      count: formattedWords.length
    });
  } catch (error) {
    console.error('Error fetching learner words:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch words',
      words: []
    });
  }
});

// ============ HANGMAN CATEGORIES ENDPOINT ============
app.get('/api/hangman/categories', authenticateToken, async (req, res) => {
  try {
    console.log('📚 Fetching Hangman categories for learner:', req.user.id);

    const { data: categories, error } = await supabase
      .from('words')
      .select('category')
      .eq('is_active', true)
      .order('category');

    if (error) {
      console.error('Error fetching categories:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch categories' 
      });
    }

    // Get unique categories with counts
    const categoryMap = {};
    (categories || []).forEach(item => {
      categoryMap[item.category] = (categoryMap[item.category] || 0) + 1;
    });

    const result = Object.entries(categoryMap).map(([category, count]) => ({
      category,
      count
    }));

    console.log(`✅ Found ${result.length} categories`);

    res.json({ 
      success: true, 
      categories: result 
    });
  } catch (error) {
    console.error('Error fetching learner categories:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch categories' 
    });
  }
});
// ==================== LEARNER SPELLING BEE ROUTES ====================

// Get all active spelling words (for learners)
app.get('/api/spelling/words', async (req, res) => {
  try {
    const { difficulty } = req.query;
    
    let query = supabase
      .from('spelling_words')
      .select('*')
      .eq('is_active', true);
    
    if (difficulty && difficulty !== 'all') {
      query = query.eq('difficulty', difficulty);
    }
    
    const { data: words, error } = await query
      .order('difficulty', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;

    res.json({ success: true, words });
  } catch (error) {
    console.error('Error fetching spelling words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Get words by difficulty
app.get('/api/spelling/words/difficulty/:difficulty', async (req, res) => {
  try {
    const { difficulty } = req.params;
    
    const { data: words, error } = await supabase
      .from('spelling_words')
      .select('*')
      .eq('difficulty', difficulty)
      .eq('is_active', true)
      .order('word', { ascending: true });

    if (error) throw error;

    res.json({ success: true, words });
  } catch (error) {
    console.error('Error fetching words by difficulty:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Track spelling attempt
app.post('/api/spelling/track-attempt', authenticateToken, async (req, res) => {
  try {
    const { wordId, correct, timeSpent } = req.body;
    const userId = req.user.id;

    if (!wordId) {
      return res.status(400).json({ success: false, message: 'Word ID is required' });
    }

    // Record the attempt
    const { error: attemptError } = await supabase
      .from('spelling_attempts')
      .insert([{
        user_id: userId,
        word_id: wordId,
        correct,
        time_spent: timeSpent || 0,
        attempted_at: new Date().toISOString()
      }]);

    if (attemptError) throw attemptError;

    // If correct, award points
    if (correct) {
      // Get word points
      const { data: wordData, error: wordError } = await supabase
        .from('spelling_words')
        .select('points')
        .eq('id', wordId)
        .single();

      if (!wordError && wordData) {
        // Get current user points
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('current_points, lifetime_points')
          .eq('id', userId)
          .single();

        if (!userError && userData) {
          const pointsToAdd = wordData.points || 10;
          const newPoints = (userData.current_points || 0) + pointsToAdd;
          const newLifetimePoints = (userData.lifetime_points || 0) + pointsToAdd;

          // Update user's points
          const { error: updateError } = await supabase
            .from('users')
            .update({
              current_points: newPoints,
              lifetime_points: newLifetimePoints,
              updated_at: new Date().toISOString()
            })
            .eq('id', userId);

          if (updateError) {
            console.error('Error updating points:', updateError);
          }
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error tracking attempt:', error);
    res.status(500).json({ success: false, message: 'Failed to track attempt: ' + error.message });
  }
});

// Get user's spelling stats
app.get('/api/spelling/user-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: attempts, error } = await supabase
      .from('spelling_attempts')
      .select('correct, time_spent, attempted_at')
      .eq('user_id', userId)
      .order('attempted_at', { ascending: false });

    if (error) throw error;

    const totalAttempts = attempts.length;
    const correctAttempts = attempts.filter(a => a.correct).length;
    const successRate = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
    const avgTime = totalAttempts > 0 ? Math.round(attempts.reduce((sum, a) => sum + (a.time_spent || 0), 0) / totalAttempts) : 0;

    res.json({
      success: true,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate,
        avgTime,
        recentAttempts: attempts.slice(0, 10)
      }
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// (Admin spelling routes are defined later in the file - single canonical set retained)


// server.js - Add or update these routes

// ============ SPELLING BEE TIMER SETTINGS ROUTES ============

// Get timer settings (admin)
app.get('/api/spelling/admin/timer-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_timer_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching timer settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = {
      defaultTimeLimit: 60,
      timeLimitPerDifficulty: {
        easy: 60,
        medium: 45,
        hard: 30,
        expert: 20
      }
    };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    // Convert snake_case to camelCase for frontend
    const formattedSettings = {
      defaultTimeLimit: settings.default_time_limit,
      timeLimitPerDifficulty: settings.time_limit_per_difficulty || defaultSettings.timeLimitPerDifficulty
    };

    res.json({ success: true, settings: formattedSettings });
  } catch (error) {
    console.error('Error in GET /api/spelling/admin/timer-settings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch timer settings' });
  }
});

// Save timer settings (admin)
app.post('/api/spelling/admin/timer-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { defaultTimeLimit, timeLimitPerDifficulty } = req.body;

    console.log('📝 Saving timer settings:', { defaultTimeLimit, timeLimitPerDifficulty });

    // Validate input
    if (!defaultTimeLimit || defaultTimeLimit < 10 || defaultTimeLimit > 120) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid default time limit. Must be between 10 and 120 seconds.' 
      });
    }

    // Check if timeLimitPerDifficulty is valid
    if (timeLimitPerDifficulty) {
      const difficulties = ['easy', 'medium', 'hard', 'expert'];
      for (const diff of difficulties) {
        if (timeLimitPerDifficulty[diff] && (timeLimitPerDifficulty[diff] < 10 || timeLimitPerDifficulty[diff] > 120)) {
          return res.status(400).json({ 
            success: false, 
            message: `Invalid time limit for ${diff}. Must be between 10 and 120 seconds.` 
          });
        }
      }
    }

    const settingsData = {
      default_time_limit: defaultTimeLimit,
      time_limit_per_difficulty: timeLimitPerDifficulty || {
        easy: 60,
        medium: 45,
        hard: 30,
        expert: 20
      },
      updated_at: new Date().toISOString(),
      updated_by: req.user.id
    };

    // Check if settings already exist
    const { data: existing, error: checkError } = await supabase
      .from('spelling_timer_settings')
      .select('id')
      .limit(1)
      .single();

    let result;
    if (existing) {
      // Update existing
      const { data, error } = await supabase
        .from('spelling_timer_settings')
        .update(settingsData)
        .eq('id', existing.id)
        .select()
        .single();
      
      if (error) {
        console.error('Error updating timer settings:', error);
        return res.status(400).json({ success: false, message: error.message });
      }
      result = data;
    } else {
      // Insert new
      const { data, error } = await supabase
        .from('spelling_timer_settings')
        .insert([settingsData])
        .select()
        .single();
      
      if (error) {
        console.error('Error inserting timer settings:', error);
        return res.status(400).json({ success: false, message: error.message });
      }
      result = data;
    }

    console.log('✅ Timer settings saved successfully:', result);

    // Return formatted response
    res.json({ 
      success: true, 
      settings: {
        defaultTimeLimit: result.default_time_limit,
        timeLimitPerDifficulty: result.time_limit_per_difficulty
      },
      message: 'Timer settings saved successfully!' 
    });
  } catch (error) {
    console.error('Error in POST /api/spelling/admin/timer-settings:', error);
    res.status(500).json({ success: false, message: 'Failed to save timer settings: ' + error.message });
  }
});

// Get timer settings (learners)
app.get('/api/spelling/timer-settings', authenticateToken, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_timer_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching timer settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = {
      defaultTimeLimit: 60,
      timeLimitPerDifficulty: {
        easy: 60,
        medium: 45,
        hard: 30,
        expert: 20
      }
    };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        defaultTimeLimit: settings.default_time_limit,
        timeLimitPerDifficulty: settings.time_limit_per_difficulty || defaultSettings.timeLimitPerDifficulty
      }
    });
  } catch (error) {
    console.error('Error in GET /api/spelling/timer-settings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch timer settings' });
  }
});

// ============ SPELLING BEE VOICE SETTINGS ROUTES ============

// Get voice settings (admin)
app.get('/api/spelling/admin/voice-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_voice_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching voice settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = {
      enabled: true,
      useClonedVoice: false,
      voiceSpeed: 0.9,
      voicePitch: 1.0,
      cloneVoiceData: null
    };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        enabled: settings.enabled !== false,
        useClonedVoice: settings.use_cloned_voice || false,
        voiceSpeed: parseFloat(settings.voice_speed) || 0.9,
        voicePitch: parseFloat(settings.voice_pitch) || 1.0,
        cloneVoiceData: settings.clone_voice_data || null
      }
    });
  } catch (error) {
    console.error('Error in GET /api/spelling/admin/voice-settings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch voice settings' });
  }
});

// Save voice settings (admin)
app.post('/api/spelling/admin/voice-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { enabled, useClonedVoice, voiceSpeed, voicePitch, cloneVoiceData } = req.body;

    console.log('📝 Saving voice settings:', { 
      enabled, 
      useClonedVoice, 
      voiceSpeed, 
      voicePitch,
      hasCloneVoice: !!cloneVoiceData 
    });

    const settingsData = {
      enabled: enabled !== false,
      use_cloned_voice: useClonedVoice || false,
      voice_speed: voiceSpeed || 0.9,
      voice_pitch: voicePitch || 1.0,
      clone_voice_data: cloneVoiceData || null,
      updated_at: new Date().toISOString(),
      updated_by: parseInt(req.user.id) // Convert to integer if needed
    };

    // Check if settings already exist
    const { data: existing, error: checkError } = await supabase
      .from('spelling_voice_settings')
      .select('id')
      .limit(1)
      .single();

    let result;
    if (existing) {
      // Update existing
      const { data, error } = await supabase
        .from('spelling_voice_settings')
        .update(settingsData)
        .eq('id', existing.id)
        .select()
        .single();
      
      if (error) {
        console.error('Error updating voice settings:', error);
        return res.status(400).json({ success: false, message: error.message });
      }
      result = data;
    } else {
      // Insert new
      const { data, error } = await supabase
        .from('spelling_voice_settings')
        .insert([settingsData])
        .select()
        .single();
      
      if (error) {
        console.error('Error inserting voice settings:', error);
        return res.status(400).json({ success: false, message: error.message });
      }
      result = data;
    }

    console.log('✅ Voice settings saved successfully:', result.id);

    res.json({ 
      success: true, 
      settings: {
        enabled: result.enabled,
        useClonedVoice: result.use_cloned_voice,
        voiceSpeed: parseFloat(result.voice_speed) || 0.9,
        voicePitch: parseFloat(result.voice_pitch) || 1.0,
        cloneVoiceData: result.clone_voice_data
      },
      message: 'Voice settings saved successfully!' 
    });
  } catch (error) {
    console.error('Error in POST /api/spelling/admin/voice-settings:', error);
    res.status(500).json({ success: false, message: 'Failed to save voice settings: ' + error.message });
  }
});

// Get voice settings (learners)
app.get('/api/spelling/voice-settings', authenticateToken, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_voice_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching voice settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = {
      enabled: true,
      useClonedVoice: false,
      voiceSpeed: 0.9,
      voicePitch: 1.0
    };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        enabled: settings.enabled !== false,
        useClonedVoice: settings.use_cloned_voice || false,
        voiceSpeed: parseFloat(settings.voice_speed) || 0.9,
        voicePitch: parseFloat(settings.voice_pitch) || 1.0
      }
    });
  } catch (error) {
    console.error('Error in GET /api/spelling/voice-settings:', error);
    res.json({ 
      success: true, 
      settings: {
        enabled: true,
        useClonedVoice: false,
        voiceSpeed: 0.9,
        voicePitch: 1.0
      }
    });
  }
});

// Delete cloned voice (admin)
app.delete('/api/spelling/admin/clone-voice', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: existing, error: checkError } = await supabase
      .from('spelling_voice_settings')
      .select('id')
      .limit(1)
      .single();

    if (existing) {
      const { error } = await supabase
        .from('spelling_voice_settings')
        .update({
          clone_voice_data: null,
          updated_at: new Date().toISOString(),
          updated_by: parseInt(req.user.id)
        })
        .eq('id', existing.id);

      if (error) {
        console.error('Error deleting clone voice:', error);
        return res.status(400).json({ success: false, message: error.message });
      }
    }

    res.json({ success: true, message: 'Cloned voice deleted successfully' });
  } catch (error) {
    console.error('Error deleting clone voice:', error);
    res.status(500).json({ success: false, message: 'Failed to delete cloned voice' });
  }
});


// ============ SPELLING BEE USER PROGRESS ROUTES ============

// Get user's spelling progress
app.get('/api/spelling/user-progress', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: progress, error } = await supabase
      .from('spelling_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching progress:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    if (!progress) {
      return res.json({ 
        success: true,
        currentLevel: 1,
        maxUnlockedLevel: 1,
        levelProgress: {},
        totalScore: 0,
        totalWordsCompleted: 0
      });
    }

    res.json({ 
      success: true,
      currentLevel: progress.current_level || 1,
      maxUnlockedLevel: progress.max_unlocked_level || 1,
      levelProgress: progress.level_progress || {},
      totalScore: progress.total_score || 0,
      totalWordsCompleted: progress.total_words_completed || 0
    });
  } catch (error) {
    console.error('Error in GET /api/spelling/user-progress:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch progress' });
  }
});

// Complete a level
app.post('/api/spelling/level-complete', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { level, score, correctAttempts, totalAttempts } = req.body;

    if (!level || level < 1 || level > 10) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid level. Must be 1-10.' 
      });
    }

    // Get existing progress
    const { data: existing, error: fetchError } = await supabase
      .from('spelling_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    let levelProgress = {};
    let totalScore = score || 0;
    let totalWordsCompleted = correctAttempts || 0;

    if (existing) {
      levelProgress = existing.level_progress || {};
      totalScore = (existing.total_score || 0) + (score || 0);
      totalWordsCompleted = (existing.total_words_completed || 0) + (correctAttempts || 0);
    }

    // Update level progress
    levelProgress[level] = {
      completed: true,
      score: score || 0,
      correctAttempts: correctAttempts || 0,
      totalAttempts: totalAttempts || 0,
      completedAt: new Date().toISOString()
    };

    const newMaxUnlockedLevel = Math.min(level + 1, 10);

    if (existing) {
      // Update existing progress
      const { data, error } = await supabase
        .from('spelling_progress')
        .update({
          current_level: Math.min(level + 1, 10),
          max_unlocked_level: newMaxUnlockedLevel,
          level_progress: levelProgress,
          total_score: totalScore,
          total_words_completed: totalWordsCompleted,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
    } else {
      // Create new progress
      const { error } = await supabase
        .from('spelling_progress')
        .insert([{
          user_id: userId,
          current_level: Math.min(level + 1, 10),
          max_unlocked_level: newMaxUnlockedLevel,
          level_progress: levelProgress,
          total_score: totalScore,
          total_words_completed: totalWordsCompleted,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]);

      if (error) throw error;
    }

    res.json({
      success: true,
      message: `Level ${level} completed successfully!`,
      newMaxLevel: newMaxUnlockedLevel
    });
  } catch (error) {
    console.error('Error in POST /api/spelling/level-complete:', error);
    res.status(500).json({ success: false, message: 'Failed to complete level' });
  }
});

// ============ SPELLING BEE WORDS BY LEVEL ============

// Get words by level (learners) - NO DEFAULT WORDS
app.get('/api/spelling/words/level/:level', async (req, res) => {
  try {
    const level = parseInt(req.params.level);
    if (level < 1 || level > 10) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid level. Must be 1-10.' 
      });
    }

    const { data: words, error } = await supabase
      .from('spelling_words')
      .select('*')
      .eq('level', level)
      .eq('is_active', true)
      .order('difficulty', { ascending: true })
      .order('word', { ascending: true });

    if (error) {
      console.error('Error fetching words by level:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    if (!words || words.length === 0) {
      return res.json({ 
        success: true, 
        words: [],
        message: `No words available for Level ${level}. Please ask an admin to add words.`
      });
    }

    res.json({ success: true, words });
  } catch (error) {
    console.error('Error in GET /api/spelling/words/level/:level:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// server.js - Add this route

// Get voice settings (learners)
app.get('/api/spelling/voice-settings', authenticateToken, async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('spelling_voice_settings')
      .select('*')
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching voice settings:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const defaultSettings = {
      enabled: true,
      useClonedVoice: false,
      voiceSpeed: 0.9,
      voicePitch: 1.0
    };

    if (!settings) {
      return res.json({ success: true, settings: defaultSettings });
    }

    res.json({ 
      success: true, 
      settings: {
        enabled: settings.enabled !== false,
        useClonedVoice: settings.use_cloned_voice || false,
        voiceSpeed: settings.voice_speed || 0.9,
        voicePitch: settings.voice_pitch || 1.0
      }
    });
  } catch (error) {
    console.error('Error in GET /api/spelling/voice-settings:', error);
    // Return default values instead of error
    res.json({ 
      success: true, 
      settings: {
        enabled: true,
        useClonedVoice: false,
        voiceSpeed: 0.9,
        voicePitch: 1.0
      }
    });
  }
});

// ============ SPELLING BEE ADMIN ROUTES ============

// Get all spelling words (admin)
app.get('/api/spelling/admin/words', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: words, error } = await supabase
      .from('spelling_words')
      .select('*')
      .order('level', { ascending: true })
      .order('difficulty', { ascending: true })
      .order('word', { ascending: true });

    if (error) {
      console.error('Error fetching spelling words:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, words: words || [] });
  } catch (error) {
    console.error('Error in GET /api/spelling/admin/words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Add new spelling word (admin)
app.post('/api/spelling/admin/words', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { word, hint, example, difficulty, level, points, is_active } = req.body;

    if (!word || !difficulty || !level) {
      return res.status(400).json({ 
        success: false, 
        message: 'Word, difficulty, and level are required.' 
      });
    }

    if (level < 1 || level > 10) {
      return res.status(400).json({ 
        success: false, 
        message: 'Level must be between 1 and 10.' 
      });
    }

    // Check if word already exists
    const { data: existing, error: checkError } = await supabase
      .from('spelling_words')
      .select('id')
      .eq('word', word.toUpperCase())
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'This word already exists.' 
      });
    }

    const difficultyPoints = {
      easy: 5,
      medium: 10,
      hard: 15,
      expert: 20
    };

    const newWord = {
      word: word.toUpperCase(),
      hint: hint || '',
      example: example || '',
      difficulty: difficulty,
      level: parseInt(level),
      points: points || difficultyPoints[difficulty] || 10,
      is_active: is_active !== false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('spelling_words')
      .insert([newWord])
      .select()
      .single();

    if (error) {
      console.error('Error adding spelling word:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, word: data, message: 'Word added successfully!' });
  } catch (error) {
    console.error('Error in POST /api/spelling/admin/words:', error);
    res.status(500).json({ success: false, message: 'Failed to add word' });
  }
});

// Update spelling word (admin)
app.put('/api/spelling/admin/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { word, hint, example, difficulty, level, points, is_active } = req.body;

    if (!word || !difficulty || !level) {
      return res.status(400).json({ 
        success: false, 
        message: 'Word, difficulty, and level are required.' 
      });
    }

    if (level < 1 || level > 10) {
      return res.status(400).json({ 
        success: false, 
        message: 'Level must be between 1 and 10.' 
      });
    }

    const difficultyPoints = {
      easy: 5,
      medium: 10,
      hard: 15,
      expert: 20
    };

    const updateData = {
      word: word.toUpperCase(),
      hint: hint || '',
      example: example || '',
      difficulty: difficulty,
      level: parseInt(level),
      points: points || difficultyPoints[difficulty] || 10,
      updated_at: new Date().toISOString()
    };

    if (is_active !== undefined) {
      updateData.is_active = is_active;
    }

    const { data, error } = await supabase
      .from('spelling_words')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating spelling word:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, word: data, message: 'Word updated successfully!' });
  } catch (error) {
    console.error('Error in PUT /api/spelling/admin/words/:id:', error);
    res.status(500).json({ success: false, message: 'Failed to update word' });
  }
});

// Delete spelling word (admin)
app.delete('/api/spelling/admin/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('spelling_words')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting spelling word:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, message: 'Word deleted successfully!' });
  } catch (error) {
    console.error('Error in DELETE /api/spelling/admin/words/:id:', error);
    res.status(500).json({ success: false, message: 'Failed to delete word' });
  }
});

// Bulk import spelling words (admin)
app.post('/api/spelling/admin/words/import', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { words } = req.body;

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid data format. Expected an array of words.' 
      });
    }

    const difficultyPoints = {
      easy: 5,
      medium: 10,
      hard: 15,
      expert: 20
    };

    let imported = 0;
    let errors = [];

    for (const wordData of words) {
      const { word, hint, example, difficulty, level, points } = wordData;

      if (word && difficulty && level) {
        try {
          // Check if word already exists
          const { data: existing, error: checkError } = await supabase
            .from('spelling_words')
            .select('id')
            .eq('word', word.toUpperCase())
            .maybeSingle();

          if (existing) {
            errors.push(`Word "${word}" already exists.`);
            continue;
          }

          const newWord = {
            word: word.toUpperCase(),
            hint: hint || '',
            example: example || '',
            difficulty: difficulty,
            level: parseInt(level) || 1,
            points: points || difficultyPoints[difficulty] || 10,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          const { error } = await supabase
            .from('spelling_words')
            .insert([newWord]);

          if (error) {
            errors.push(`Failed to import "${word}": ${error.message}`);
          } else {
            imported++;
          }
        } catch (err) {
          errors.push(`Error importing "${word}": ${err.message}`);
        }
      } else {
        errors.push(`Invalid word data: ${JSON.stringify(wordData)}`);
      }
    }

    res.json({
      success: true,
      imported,
      errors: errors.length > 0 ? errors : undefined,
      message: `Successfully imported ${imported} words. ${errors.length} errors.`
    });
  } catch (error) {
    console.error('Error in POST /api/spelling/admin/words/import:', error);
    res.status(500).json({ success: false, message: 'Failed to import words' });
  }
});

// Get spelling words (learners) - with optional filters
app.get('/api/spelling/words', async (req, res) => {
  try {
    const { difficulty, level } = req.query;

    let query = supabase
      .from('spelling_words')
      .select('*')
      .eq('is_active', true);

    if (difficulty && difficulty !== 'all') {
      query = query.eq('difficulty', difficulty);
    }

    if (level && level !== 'all') {
      query = query.eq('level', parseInt(level));
    }

    const { data: words, error } = await query
      .order('level', { ascending: true })
      .order('difficulty', { ascending: true })
      .order('word', { ascending: true });

    if (error) {
      console.error('Error fetching spelling words:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    res.json({ success: true, words: words || [] });
  } catch (error) {
    console.error('Error in GET /api/spelling/words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Track spelling attempt (learners)
app.post('/api/spelling/track-attempt', authenticateToken, async (req, res) => {
  try {
    const { wordId, correct, timeSpent, level } = req.body;
    const userId = req.user.id;

    if (!wordId) {
      return res.status(400).json({ success: false, message: 'Word ID is required' });
    }

    // Record the attempt
    const { error: attemptError } = await supabase
      .from('spelling_attempts')
      .insert([{
        user_id: userId,
        word_id: wordId,
        correct: correct || false,
        time_spent: timeSpent || 0,
        level: level || 1,
        attempted_at: new Date().toISOString()
      }]);

    if (attemptError) {
      console.error('Error tracking attempt:', attemptError);
      return res.status(400).json({ success: false, message: attemptError.message });
    }

    // If correct, award points
    if (correct) {
      // Get word points
      const { data: wordData, error: wordError } = await supabase
        .from('spelling_words')
        .select('points')
        .eq('id', wordId)
        .single();

      if (!wordError && wordData) {
        // Get current user points
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('current_points, lifetime_points')
          .eq('id', userId)
          .single();

        if (!userError && userData) {
          const pointsToAdd = wordData.points || 10;
          const newPoints = (userData.current_points || 0) + pointsToAdd;
          const newLifetimePoints = (userData.lifetime_points || 0) + pointsToAdd;

          // Update user's points
          const { error: updateError } = await supabase
            .from('users')
            .update({
              current_points: newPoints,
              lifetime_points: newLifetimePoints,
              updated_at: new Date().toISOString()
            })
            .eq('id', userId);

          if (updateError) {
            console.error('Error updating points:', updateError);
          }
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error in POST /api/spelling/track-attempt:', error);
    res.status(500).json({ success: false, message: 'Failed to track attempt' });
  }
});

// Get user's spelling stats
app.get('/api/spelling/user-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: attempts, error } = await supabase
      .from('spelling_attempts')
      .select('correct, time_spent, attempted_at, level')
      .eq('user_id', userId)
      .order('attempted_at', { ascending: false });

    if (error) {
      console.error('Error fetching user stats:', error);
      return res.status(400).json({ success: false, message: error.message });
    }

    const totalAttempts = attempts.length;
    const correctAttempts = attempts.filter(a => a.correct).length;
    const successRate = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
    const avgTime = totalAttempts > 0 ? Math.round(attempts.reduce((sum, a) => sum + (a.time_spent || 0), 0) / totalAttempts) : 0;

    // Get level distribution
    const levelDistribution = {};
    attempts.forEach(a => {
      const level = a.level || 1;
      levelDistribution[level] = (levelDistribution[level] || 0) + 1;
    });

    res.json({
      success: true,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate,
        avgTime,
        levelDistribution,
        recentAttempts: attempts.slice(0, 10)
      }
    });
  } catch (error) {
    console.error('Error in GET /api/spelling/user-stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ============ ADVANCED EXTRACTION ENDPOINT ============
app.post('/api/admin/extract-questions-advanced', authenticateToken, requireAdmin, upload.single('file'), async (req, res) => {
  console.log('='.repeat(50));
  console.log('📄 ADVANCED EXTRACTION REQUEST');
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

    let extractedText = '';
    let questions = [];

    // Handle PDF files
    if (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf')) {
      console.log('🔄 Processing PDF file with advanced parser...');
      
      if (!pdfParse) {
        console.error('❌ PDF parser not available');
        return res.status(500).json({ 
          success: false, 
          message: 'PDF parser is not installed. Please run: npm install pdf-parse@1.1.1' 
        });
      }
      
      try {
        const data = await pdfParse(req.file.buffer);
        extractedText = data.text;
        console.log(`📄 PDF text length: ${extractedText.length} characters`);
        
        questions = extractQuestionsFromText(extractedText);
        console.log(`✅ Extracted ${questions.length} questions from PDF`);
        
      } catch (pdfError) {
        console.error('❌ PDF parsing error:', pdfError);
        return res.status(400).json({ 
          success: false, 
          message: `Failed to parse PDF: ${pdfError.message}` 
        });
      }
    }
    // Handle CSV files
    else if (req.file.mimetype === 'text/csv' || req.file.originalname.toLowerCase().endsWith('.csv')) {
      console.log('🔄 Processing CSV file with advanced parser...');
      
      try {
        const csvText = req.file.buffer.toString('utf-8');
        const lines = csvText.split('\n');
        
        if (lines.length < 2) {
          throw new Error('CSV must have at least a header row and one data row');
        }
        
        // Detect headers
        const firstRow = lines[0].toLowerCase();
        const hasHeader = firstRow.includes('question') || firstRow.includes('option');
        const startRow = hasHeader ? 1 : 0;
        
        for (let i = startRow; i < Math.min(lines.length, 500); i++) {
          if (!lines[i].trim()) continue;
          
          const values = parseCSVRow(lines[i]);
          if (values.length < 5) continue;
          
          const questionText = values[0]?.trim();
          const options = [
            values[1]?.trim() || '',
            values[2]?.trim() || '',
            values[3]?.trim() || '',
            values[4]?.trim() || ''
          ];
          let correctAnswer = values[5]?.trim() || '';
          
          // Handle letter-based correct answer (e.g., "A", "B", etc.)
          if (correctAnswer && correctAnswer.match(/^[A-D]$/i)) {
            const letterIndex = correctAnswer.toUpperCase().charCodeAt(0) - 65;
            correctAnswer = options[letterIndex] || options[0];
          }
          
          // Handle correct answer markers in options
          for (let j = 0; j < options.length; j++) {
            if (options[j].includes('✓') || options[j].includes('*') || options[j].includes('(correct)')) {
              correctAnswer = options[j].replace(/[✓*]/g, '').replace(/\(correct\)/i, '').trim();
              options[j] = correctAnswer;
              break;
            }
          }
          
          if (questionText && options.some(o => o)) {
            questions.push({
              id: `csv-${Date.now()}-${questions.length}`,
              question: questionText,
              options: ensureFourOptions(options),
              correctAnswer: correctAnswer || options[0] || '',
              layout: 'text-first',
              questionImage: '',
              difficulty: 'intermediate'
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
    // Handle DOCX files
    else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
             req.file.originalname.toLowerCase().endsWith('.docx')) {
      console.log('🔄 Processing DOCX file...');
      
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        extractedText = result.value;
        console.log(`📄 DOCX text length: ${extractedText.length} characters`);
        
        questions = extractQuestionsFromText(extractedText);
        console.log(`✅ Extracted ${questions.length} questions from DOCX`);
        
      } catch (docxError) {
        console.error('❌ DOCX parsing error:', docxError);
        return res.status(400).json({ 
          success: false, 
          message: `Failed to parse DOCX: ${docxError.message}. Please install mammoth: npm install mammoth` 
        });
      }
    }
    else {
      return res.status(400).json({ 
        success: false, 
        message: 'Unsupported file type. Please upload PDF, CSV, or DOCX files.' 
      });
    }

    if (questions.length === 0) {
      console.log('❌ No questions extracted');
      return res.status(400).json({ 
        success: false, 
        message: 'No valid questions found. Please ensure the file has properly formatted questions with options A, B, C, D.' 
      });
    }

    // Clean and validate all questions
    questions = questions.filter(q => {
      const hasQuestion = q.question && q.question.trim().length > 0;
      const hasValidOptions = q.options && q.options.some(opt => opt && opt.trim().length > 0);
      const hasCorrectAnswer = q.correctAnswer && q.correctAnswer.trim().length > 0;
      return hasQuestion && hasValidOptions && hasCorrectAnswer;
    });

    // Ensure each question has correct answer in options
    questions = questions.map(q => {
      let correctAnswer = q.correctAnswer;
      if (!q.options.includes(correctAnswer)) {
        correctAnswer = q.options[0] || '';
      }
      return {
        ...q,
        options: ensureFourOptions(q.options),
        correctAnswer: correctAnswer
      };
    });

    // Remove duplicates
    const seenQuestions = new Set();
    const uniqueQuestions = [];
    for (const q of questions) {
      const normalizedQuestion = q.question.toLowerCase().trim();
      if (!seenQuestions.has(normalizedQuestion)) {
        seenQuestions.add(normalizedQuestion);
        uniqueQuestions.push(q);
      }
    }

    console.log(`✅ SUCCESS: Returning ${uniqueQuestions.length} unique questions from ${questions.length} total`);
    console.log('='.repeat(50));
    
    res.json({
      success: true,
      questions: uniqueQuestions,
      stats: {
        total_extracted: questions.length,
        unique: uniqueQuestions.length,
        duplicates_removed: questions.length - uniqueQuestions.length
      },
      message: `Successfully extracted ${uniqueQuestions.length} unique questions from ${req.file.originalname}.`
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

// ============ PDF UPLOAD AND EXTRACTION ENDPOINT (Legacy) ============
app.post('/api/admin/extract-questions', authenticateToken, requireAdmin, upload.single('pdf'), async (req, res) => {
  console.log('='.repeat(50));
  console.log('📄 PDF EXTRACTION REQUEST (Legacy)');
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
      JWT_SECRET,
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
      JWT_SECRET,
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
      JWT_SECRET,
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

// ============ ADMIN BADGES ENDPOINTS ============

// Get all badges
app.get('/api/admin/badges', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: badges, error } = await supabase
      .from('badges')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching badges:', error);
      return res.status(400).json({ success: false, message: 'Failed to fetch badges' });
    }

    res.json({ success: true, badges: badges || [] });
  } catch (error) {
    console.error('Fetch badges error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch badges' });
  }
});

// Create a new badge
app.post('/api/admin/badges', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      icon_url,
      criteria,
      is_active,
      automation_enabled,
      automation_trigger,
      automation_condition,
      automation_threshold,
      automation_points_reward
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Badge name is required' });
    }

    // Check if badge with same name exists
    const { data: existingBadge } = await supabase
      .from('badges')
      .select('id')
      .eq('name', name.trim())
      .single();

    if (existingBadge) {
      return res.status(400).json({ success: false, message: 'A badge with this name already exists' });
    }

    const { data: badge, error } = await supabase
      .from('badges')
      .insert([{
        name: name.trim(),
        description: description || 'No description provided',
        icon_url: icon_url || '',
        criteria: criteria || 'Complete the required actions to earn this badge',
        is_active: is_active !== undefined ? is_active : true,
        automation_enabled: automation_enabled || false,
        automation_trigger: automation_trigger || '',
        automation_condition: automation_condition || 'greater_equal',
        automation_threshold: automation_threshold || 0,
        automation_points_reward: automation_points_reward || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error creating badge:', error);
      return res.status(400).json({ success: false, message: 'Failed to create badge' });
    }

    res.status(201).json({ success: true, badge });
  } catch (error) {
    console.error('Create badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to create badge' });
  }
});

// Update a badge
app.put('/api/admin/badges/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      icon_url,
      criteria,
      is_active,
      automation_enabled,
      automation_trigger,
      automation_condition,
      automation_threshold,
      automation_points_reward
    } = req.body;

    // Check if badge exists
    const { data: existingBadge } = await supabase
      .from('badges')
      .select('*')
      .eq('id', id)
      .single();

    if (!existingBadge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    // If name is changing, check for duplicates
    if (name && name.trim() !== existingBadge.name) {
      const { data: duplicate } = await supabase
        .from('badges')
        .select('id')
        .eq('name', name.trim())
        .single();

      if (duplicate) {
        return res.status(400).json({ success: false, message: 'A badge with this name already exists' });
      }
    }

    const { data: badge, error } = await supabase
      .from('badges')
      .update({
        name: name ? name.trim() : existingBadge.name,
        description: description !== undefined ? description : existingBadge.description,
        icon_url: icon_url !== undefined ? icon_url : existingBadge.icon_url,
        criteria: criteria !== undefined ? criteria : existingBadge.criteria,
        is_active: is_active !== undefined ? is_active : existingBadge.is_active,
        automation_enabled: automation_enabled !== undefined ? automation_enabled : existingBadge.automation_enabled,
        automation_trigger: automation_trigger !== undefined ? automation_trigger : existingBadge.automation_trigger,
        automation_condition: automation_condition !== undefined ? automation_condition : existingBadge.automation_condition,
        automation_threshold: automation_threshold !== undefined ? automation_threshold : existingBadge.automation_threshold,
        automation_points_reward: automation_points_reward !== undefined ? automation_points_reward : existingBadge.automation_points_reward,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating badge:', error);
      return res.status(400).json({ success: false, message: 'Failed to update badge' });
    }

    res.json({ success: true, badge });
  } catch (error) {
    console.error('Update badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to update badge' });
  }
});

// Delete a badge
app.delete('/api/admin/badges/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: badge, error } = await supabase
      .from('badges')
      .delete()
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error deleting badge:', error);
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    res.json({ success: true, message: 'Badge deleted successfully' });
  } catch (error) {
    console.error('Delete badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete badge' });
  }
});

// Assign badge to a learner
app.post('/api/admin/badges/assign', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { badgeId, learnerId } = req.body;

    if (!badgeId || !learnerId) {
      return res.status(400).json({ success: false, message: 'Badge ID and Learner ID are required' });
    }

    // Check if badge exists
    const { data: badge } = await supabase
      .from('badges')
      .select('id')
      .eq('id', badgeId)
      .single();

    if (!badge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    // Check if learner exists
    const { data: learner } = await supabase
      .from('users')
      .select('id')
      .eq('id', learnerId)
      .eq('role', 'learner')
      .single();

    if (!learner) {
      return res.status(404).json({ success: false, message: 'Learner not found' });
    }

    // Check if learner already has this badge
    const { data: existingAssignment } = await supabase
      .from('learner_badges')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('badge_id', badgeId)
      .single();

    if (existingAssignment) {
      return res.status(400).json({ success: false, message: 'Learner already has this badge' });
    }

    // Assign the badge
    const { error } = await supabase
      .from('learner_badges')
      .insert([{
        learner_id: learnerId,
        badge_id: badgeId,
        assigned_at: new Date().toISOString()
      }]);

    if (error) {
      console.error('Error assigning badge:', error);
      return res.status(400).json({ success: false, message: 'Failed to assign badge' });
    }

    res.json({ success: true, message: 'Badge assigned successfully' });
  } catch (error) {
    console.error('Assign badge error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign badge' });
  }
});

// Get all learners
app.get('/api/admin/learners', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: learners, error } = await supabase
      .from('users')
      .select('id, username, email, full_name, class_level, current_points, lifetime_points, role')
      .eq('role', 'learner')
      .order('full_name', { ascending: true });

    if (error) {
      console.error('Error fetching learners:', error);
      return res.status(400).json({ success: false, message: 'Failed to fetch learners' });
    }

    res.json({ success: true, learners: learners || [] });
  } catch (error) {
    console.error('Fetch learners error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch learners' });
  }
});

// Upload image for badge
app.post('/api/admin/upload-image', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }

    const file = req.file;
    const fileName = `badges/${Date.now()}-${file.originalname}`;

    // Upload to R2
    const uploadResult = await uploadToR2(file.buffer, fileName, file.mimetype);

    if (!uploadResult.success) {
      console.error('Error uploading to R2:', uploadResult.error);
      return res.status(500).json({ success: false, message: 'Failed to upload image' });
    }

    res.json({ success: true, imageUrl: uploadResult.url });
  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({ success: false, message: 'Failed to upload image' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server with Supabase DNS check and client initialization
const PORT = process.env.PORT || 5000;

(async () => {
  try {
    const dns = require('dns').promises;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!supabaseUrl) {
      console.error('❌ SUPABASE_URL is not set in .env. Set SUPABASE_URL to your Supabase project URL.');
      process.exit(1);
    }

    let hostname;
    try {
      hostname = new URL(supabaseUrl).hostname;
    } catch (err) {
      console.error('❌ SUPABASE_URL is invalid:', supabaseUrl);
      process.exit(1);
    }

    try {
      await dns.lookup(hostname);
      console.log(`✅ DNS lookup successful for ${hostname}`);
    } catch (err) {
      console.error(`❌ DNS lookup failed for ${hostname}:`, err.message || err);
      console.error('Possible causes: no internet connection, incorrect SUPABASE_URL, or the Supabase project was deleted/renamed.');
      console.error('Check your SUPABASE_URL in backend/.env and ensure the host resolves from this machine.');
      process.exit(1);
    }

    // Initialize Supabase client now that DNS is confirmed
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
    );

    app.listen(PORT, () => {
      console.log(`🚀 Learn & Earn server running on http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`🎁 Rewards endpoints: http://localhost:${PORT}/api/admin/rewards`);
      console.log(`🎁 Create reward: POST http://localhost:${PORT}/api/admin/create-reward`);
      console.log(`🎁 Update reward: POST http://localhost:${PORT}/api/admin/update-reward/:id`);
      console.log(`🎁 Delete reward: DELETE http://localhost:${PORT}/api/admin/delete-reward/:id`);
      console.log(`🎁 Learner rewards: GET http://localhost:${PORT}/api/learner/rewards`);
      console.log(`🏆 Leaderboard: GET http://localhost:${PORT}/api/leaderboard`);
      console.log(`🕹️ HANGMAN: Admin routes at /api/admin/hangman/*`);
      console.log(`🕹️ HANGMAN: Learner routes at /api/hangman/*`);
      console.log(`🔤 SPELLING BEE: Admin routes at /api/spelling/admin/*`);
      console.log(`🔤 SPELLING BEE: Learner routes at /api/spelling/*`);
    });

  } catch (err) {
    console.error('Server startup error:', err);
    process.exit(1);
  }
})();