// backend/config/supabase.js
const { createClient } = require('@supabase/supabase-js');

// Get environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase environment variables:');
  console.error('SUPABASE_URL:', supabaseUrl ? '✅ Set' : '❌ Missing');
  console.error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY:', supabaseKey ? '✅ Set' : '❌ Missing');
  throw new Error('Supabase configuration is incomplete. Please check your .env file.');
}

// Create Supabase client
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

console.log('✅ Supabase client initialized from config/supabase.js');

module.exports = { supabase };