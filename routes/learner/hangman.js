// routes/learner/hangman.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/supabase');
const auth = require('../../middleware/auth');

// ==================== LEARNER HANGMAN ROUTES ====================

// Get all active words for learners (with auth)
router.get('/words', auth, async (req, res) => {
  try {
    const { data: words, error } = await supabase
      .from('words')
      .select('id, word, category, hint, difficulty, points, image_url')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('word', { ascending: true });

    if (error) throw error;

    // If no words found, return empty array
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
router.get('/categories', auth, async (req, res) => {
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

// Get words by category for learners
router.get('/words/category/:category', auth, async (req, res) => {
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

// Track word attempt (for analytics and points)
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

// Get user's hangman stats
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