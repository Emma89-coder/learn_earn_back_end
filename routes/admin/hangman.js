// routes/admin/hangman.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../../config/supabase');
const { uploadToR2, deleteFromR2 } = require('../../config/cloudflare');
const auth = require('../../middleware/auth');

// Configure multer for memory storage (for Cloudflare R2)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(file.originalname.split('.').pop().toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  }
});

// ==================== ADMIN ROUTES ====================

// Get all words (admin)
router.get('/words', auth, async (req, res) => {
  try {
    const { data: words, error } = await supabase
      .from('words')
      .select('*')
      .order('category', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;

    res.json({ success: true, words: words || [] });
  } catch (error) {
    console.error('Error fetching words:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch words' });
  }
});

// Add new word (admin)
router.post('/words', auth, upload.single('image'), async (req, res) => {
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
      points: parseInt(points) || 2,
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
router.put('/words/:id', auth, upload.single('image'), async (req, res) => {
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
router.delete('/words/:id', auth, async (req, res) => {
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
router.post('/words/import', auth, async (req, res) => {
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
            points: parseInt(points) || 2,
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
router.get('/stats', auth, async (req, res) => {
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
      totalPoints += item.points || 2;
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

// ==================== LEARNER ROUTES ====================

// Get all active words for learners (no auth required for viewing words)
router.get('/learner/words', async (req, res) => {
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

// Get all available categories with word counts (for learners)
router.get('/learner/categories', async (req, res) => {
  try {
    const { data: categories, error } = await supabase
      .from('words')
      .select('category')
      .eq('is_active', true)
      .order('category');

    if (error) throw error;

    // Get unique categories with counts
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

// Get words for a specific category (for learners)
router.get('/learner/words/category/:category', async (req, res) => {
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

// Track word attempt (for analytics and points) - LEARNER ROUTE
router.post('/track-attempt', auth, async (req, res) => {
  try {
    const { wordId, correct, attempts, timeSpent } = req.body;
    const userId = req.user.id;

    if (!wordId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Word ID is required' 
      });
    }

    // Insert attempt record
    const { error: attemptError } = await supabase
      .from('word_attempts')
      .insert([{
        word_id: wordId,
        user_id: userId,
        correct: correct || false,
        attempts: attempts || 1,
        time_spent: timeSpent || 0,
        attempted_at: new Date().toISOString()
      }]);

    if (attemptError) throw attemptError;

    // If correct, add points to user
    if (correct) {
      // Get word points
      const { data: wordData, error: wordError } = await supabase
        .from('words')
        .select('points')
        .eq('id', wordId)
        .single();

      if (!wordError && wordData) {
        const pointsToAdd = wordData.points || 2;
        
        // Update user's points in users table
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('current_points, lifetime_points')
          .eq('id', userId)
          .single();

        if (!userError && userData) {
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
            console.log(`✅ Added ${pointsToAdd} points to user ${userId} for Hangman word`);
          }
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

// Get user's hangman stats - LEARNER ROUTE
router.get('/user-stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get total attempts
    const { data: attempts, error: attemptsError } = await supabase
      .from('word_attempts')
      .select('correct, attempts, created_at, word_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (attemptsError) throw attemptsError;

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
    }

    res.json({
      success: true,
      stats: {
        totalAttempts,
        correctAttempts,
        successRate,
        uniqueWordsCount,
        totalPoints: userData?.current_points || 0,
        lifetimePoints: userData?.lifetime_points || 0,
        recentAttempts: (attempts || []).slice(0, 10).map(a => ({
          ...a,
          attempted_at: a.created_at
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch user stats' 
    });
  }
});

module.exports = router;