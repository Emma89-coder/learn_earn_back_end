require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  try {
    console.log('Querying quizzes columns...');
    const { data, error } = await supabase
      .from('quizzes')
      .select('id, image_url, title, topic')
      .limit(1);
    console.log('data:', data);
    console.log('error:', error);
  } catch (err) {
    console.error('exception', err);
  }
})();
