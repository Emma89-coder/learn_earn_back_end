require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  try {
    const { data, error } = await supabase.from('quizzes').select('*').limit(1);
    console.log('error', error);
    console.log('data', data);
  } catch (err) {
    console.error('exception', err);
  }
})();
