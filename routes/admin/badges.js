// backend/routes/admin/badges.js
const express = require('express');
const router = express.Router();
const { authenticateToken, isAdmin } = require('../../middleware/auth');
const Badge = require('../../models/Badge');
const Learner = require('../../models/Learner');

// Get all badges
router.get('/', authenticateToken, isAdmin, async (req, res) => {
  try {
    const badges = await Badge.find().sort({ createdAt: -1 });
    res.json({ success: true, badges });
  } catch (error) {
    console.error('Error fetching badges:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch badges' });
  }
});

// Create a new badge
router.post('/', authenticateToken, isAdmin, async (req, res) => {
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

    // Validate required fields
    if (!name) {
      return res.status(400).json({ success: false, message: 'Badge name is required' });
    }

    // Check if badge with same name exists
    const existingBadge = await Badge.findOne({ name: name.trim() });
    if (existingBadge) {
      return res.status(400).json({ success: false, message: 'A badge with this name already exists' });
    }

    const badge = new Badge({
      name: name.trim(),
      description: description || 'No description provided',
      icon_url: icon_url || '',
      criteria: criteria || 'Complete the required actions to earn this badge',
      is_active: is_active !== undefined ? is_active : true,
      automation_enabled: automation_enabled || false,
      automation_trigger: automation_trigger || '',
      automation_condition: automation_condition || 'greater_equal',
      automation_threshold: automation_threshold || 0,
      automation_points_reward: automation_points_reward || 0
    });

    await badge.save();
    res.status(201).json({ success: true, badge });
  } catch (error) {
    console.error('Error creating badge:', error);
    res.status(500).json({ success: false, message: 'Failed to create badge' });
  }
});

// Update a badge
router.put('/:id', authenticateToken, isAdmin, async (req, res) => {
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

    const badge = await Badge.findById(id);
    if (!badge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    // Check if name is being changed and if it already exists
    if (name && name.trim() !== badge.name) {
      const existingBadge = await Badge.findOne({ name: name.trim() });
      if (existingBadge && existingBadge._id.toString() !== id) {
        return res.status(400).json({ success: false, message: 'A badge with this name already exists' });
      }
      badge.name = name.trim();
    }

    // Update fields
    if (description !== undefined) badge.description = description || 'No description provided';
    if (icon_url !== undefined) badge.icon_url = icon_url || '';
    if (criteria !== undefined) badge.criteria = criteria || 'Complete the required actions to earn this badge';
    if (is_active !== undefined) badge.is_active = is_active;
    if (automation_enabled !== undefined) badge.automation_enabled = automation_enabled;
    if (automation_trigger !== undefined) badge.automation_trigger = automation_trigger || '';
    if (automation_condition !== undefined) badge.automation_condition = automation_condition || 'greater_equal';
    if (automation_threshold !== undefined) badge.automation_threshold = automation_threshold || 0;
    if (automation_points_reward !== undefined) badge.automation_points_reward = automation_points_reward || 0;

    await badge.save();
    res.json({ success: true, badge });
  } catch (error) {
    console.error('Error updating badge:', error);
    res.status(500).json({ success: false, message: 'Failed to update badge' });
  }
});

// Delete a badge
router.delete('/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const badge = await Badge.findByIdAndDelete(id);
    if (!badge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }
    res.json({ success: true, message: 'Badge deleted successfully' });
  } catch (error) {
    console.error('Error deleting badge:', error);
    res.status(500).json({ success: false, message: 'Failed to delete badge' });
  }
});

// Assign badge to a learner
router.post('/assign', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { badgeId, learnerId } = req.body;

    if (!badgeId || !learnerId) {
      return res.status(400).json({ success: false, message: 'Badge ID and Learner ID are required' });
    }

    const badge = await Badge.findById(badgeId);
    if (!badge) {
      return res.status(404).json({ success: false, message: 'Badge not found' });
    }

    const learner = await Learner.findById(learnerId);
    if (!learner) {
      return res.status(404).json({ success: false, message: 'Learner not found' });
    }

    // Check if learner already has this badge
    if (learner.badges && learner.badges.includes(badgeId)) {
      return res.status(400).json({ success: false, message: 'Learner already has this badge' });
    }

    // Initialize badges array if it doesn't exist
    if (!learner.badges) {
      learner.badges = [];
    }
    learner.badges.push(badgeId);
    await learner.save();

    res.json({ success: true, message: 'Badge assigned successfully' });
  } catch (error) {
    console.error('Error assigning badge:', error);
    res.status(500).json({ success: false, message: 'Failed to assign badge' });
  }
});

// Get badge statistics
router.get('/stats', authenticateToken, isAdmin, async (req, res) => {
  try {
    const totalBadges = await Badge.countDocuments();
    const activeBadges = await Badge.countDocuments({ is_active: true });
    const automatedBadges = await Badge.countDocuments({ automation_enabled: true });
    
    res.json({
      success: true,
      stats: {
        total: totalBadges,
        active: activeBadges,
        automated: automatedBadges
      }
    });
  } catch (error) {
    console.error('Error fetching badge stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch badge statistics' });
  }
});

module.exports = router;