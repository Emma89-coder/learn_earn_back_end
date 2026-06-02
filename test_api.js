(async () => {
  try {
    const fetch = global.fetch || (await import('node-fetch')).default;
    const login = await fetch('http://localhost:5000/api/auth/test-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    const loginJson = await login.json();
    console.log('login response:', loginJson);
    if (!loginJson.token) throw new Error('No token from test-login');
    const token = loginJson.token;

    const payload = {
      title: 'Automated Test Quiz',
      topic: 'social-studies',
      description: 'Created by automated test',
      questions: [
        {
          question: 'What is 2 + 2?',
          questionImage: null,
          options: ['1', '2', '4', '3'],
          correctAnswer: '4',
          layout: 'text-first'
        }
      ],
      start_time: null,
      end_time: null,
      is_active: true,
      image_url: null
    };

    const res = await fetch('http://localhost:5000/api/admin/quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });

    const j = await res.json();
    console.log('create quiz response:', j);
  } catch (err) {
    console.error('error', err);
    process.exitCode = 1;
  }
})();
