// routes/admin/settings.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../../config/supabase');

// Get settings
router.get('/settings', async (req, res) => {
  try {
    console.log('📥 Fetching settings...');
    
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .eq('key', 'appearance')
      .single();

    if (error) {
      console.error('❌ Supabase error:', error);
      
      // If no settings found, return defaults
      if (error.code === 'PGRST116') {
        console.log('📝 No settings found, returning defaults');
        return res.json({
          success: true,
          settings: getDefaultSettings()
        });
      }
      throw error;
    }

    console.log('✅ Settings fetched successfully');
    res.json({
      success: true,
      settings: data.value
    });
  } catch (error) {
    console.error('❌ Error fetching settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch settings',
      error: error.message
    });
  }
});

// Update settings
router.put('/settings', async (req, res) => {
  try {
    const settings = req.body;
    const userId = req.user?.id;

    console.log('📝 Updating settings:', settings);

    // Validate settings
    const validation = validateSettings(settings);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Check if settings exist
    const { data: existing, error: checkError } = await supabase
      .from('app_settings')
      .select('id')
      .eq('key', 'appearance')
      .single();

    let result;
    if (existing) {
      // Update existing
      const { data, error } = await supabase
        .from('app_settings')
        .update({
          value: settings,
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('key', 'appearance')
        .select()
        .single();

      if (error) throw error;
      result = data;
    } else {
      // Insert new
      const { data, error } = await supabase
        .from('app_settings')
        .insert({
          key: 'appearance',
          value: settings,
          updated_by: userId
        })
        .select()
        .single();

      if (error) throw error;
      result = data;
    }

    console.log('✅ Settings updated successfully');
    res.json({
      success: true,
      settings: result.value,
      message: 'Settings updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
      error: error.message
    });
  }
});

// Reset to defaults
router.post('/settings/reset', async (req, res) => {
  try {
    const defaults = getDefaultSettings();
    const userId = req.user?.id;

    console.log('🔄 Resetting settings to defaults');

    const { data, error } = await supabase
      .from('app_settings')
      .update({
        value: defaults,
        updated_by: userId,
        updated_at: new Date().toISOString()
      })
      .eq('key', 'appearance')
      .select()
      .single();

    if (error) {
      // If no row exists, insert
      if (error.code === 'PGRST116') {
        const { data: insertData, error: insertError } = await supabase
          .from('app_settings')
          .insert({
            key: 'appearance',
            value: defaults,
            updated_by: userId
          })
          .select()
          .single();

        if (insertError) throw insertError;
        return res.json({
          success: true,
          settings: insertData.value,
          message: 'Settings reset to defaults'
        });
      }
      throw error;
    }

    console.log('✅ Settings reset successfully');
    res.json({
      success: true,
      settings: data.value,
      message: 'Settings reset to defaults'
    });
  } catch (error) {
    console.error('❌ Error resetting settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset settings',
      error: error.message
    });
  }
});

// Helper functions
function getDefaultSettings() {
  return {
    fontFamily: 'Inter',
    fontSize: '16',
    headingSize: '24',
    bodyColor: '#e2e8f0',
    sidebarTextColor: '#e2e8f0',
    cardTextColor: '#e2e8f0',
    headingColor: '#ffffff',
    linkColor: '#5eead4',
    bgColor: '#003B46',
    cardBg: '#003B46',
    borderRadius: '12',
    lineHeight: '1.6'
  };
}

function validateSettings(settings) {
  const required = ['fontFamily', 'fontSize', 'headingSize', 'bodyColor', 'sidebarTextColor', 'cardTextColor', 'headingColor', 'linkColor', 'bgColor', 'cardBg', 'borderRadius', 'lineHeight'];
  
  for (const key of required) {
    if (!settings[key] && settings[key] !== 0) {
      return { valid: false, error: `Missing required field: ${key}` };
    }
  }

  // Validate colors (hex format)
  const colorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
  const colorFields = ['bodyColor', 'sidebarTextColor', 'cardTextColor', 'headingColor', 'linkColor', 'bgColor', 'cardBg'];
  for (const field of colorFields) {
    if (!colorRegex.test(settings[field])) {
      return { valid: false, error: `Invalid color format for ${field}. Use hex color (e.g., #1f2937)` };
    }
  }

  // Validate numbers
  if (isNaN(settings.fontSize) || parseInt(settings.fontSize) < 10 || parseInt(settings.fontSize) > 32) {
    return { valid: false, error: 'Font size must be between 10 and 32' };
  }

  if (isNaN(settings.headingSize) || parseInt(settings.headingSize) < 16 || parseInt(settings.headingSize) > 48) {
    return { valid: false, error: 'Heading size must be between 16 and 48' };
  }

  if (isNaN(settings.borderRadius) || parseInt(settings.borderRadius) < 0 || parseInt(settings.borderRadius) > 32) {
    return { valid: false, error: 'Border radius must be between 0 and 32' };
  }

  if (isNaN(settings.lineHeight) || parseFloat(settings.lineHeight) < 1 || parseFloat(settings.lineHeight) > 3) {
    return { valid: false, error: 'Line height must be between 1 and 3' };
  }

  return { valid: true };
}

module.exports = router;