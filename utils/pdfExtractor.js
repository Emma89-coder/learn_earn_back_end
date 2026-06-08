const pdfParse = require('pdf-parse');
const path = require('path');

/**
 * Extract text from PDF buffer with multiple fallback methods
 */
const extractTextFromPDF = async (pdfBuffer) => {
  try {
    // Method 1: Standard pdf-parse
    const data = await pdfParse(pdfBuffer, {
      max: 0, // No page limit
      version: 'v1.10.100'
    });
    
    if (data && data.text && data.text.trim().length > 0) {
      console.log(`PDF extracted: ${data.text.length} characters, ${data.numpages} pages`);
      return data.text;
    }
    throw new Error('No text content found in PDF');
    
  } catch (error) {
    console.error('PDF parse error details:', error);
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
};

/**
 * Parse questions from extracted text with multiple format support
 */
const parseQuestionsFromText = (text) => {
  const questions = [];
  
  if (!text || text.trim().length === 0) {
    return questions;
  }
  
  // Clean the text
  let cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\x20-\x7E\n]/g, '') // Remove non-printable characters
    .replace(/\n{3,}/g, '\n\n'); // Normalize multiple line breaks
  
  const lines = cleanText.split('\n');
  
  // Pattern 1: Standard numbered questions with options
  let currentQuestion = null;
  let currentOptions = [];
  let collectingOptions = false;
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    
    // Match question numbers: 1., 1), 1:, Q1., Q1), etc.
    const questionMatch = line.match(/^(?:Q\.?\s*)?(\d+)[\.\)\:]\s+(.+)/i);
    
    if (questionMatch && !collectingOptions) {
      // Save previous question
      if (currentQuestion && currentOptions.length >= 2) {
        // Find correct answer (marked with (correct), ✓, *, or "Answer:" prefix)
        let correctAnswer = currentOptions[0];
        for (let opt of currentOptions) {
          const optLower = opt.toLowerCase();
          if (optLower.includes('(correct)') || 
              optLower.includes('✓') || 
              optLower.includes('*correct*') ||
              optLower.includes('answer')) {
            correctAnswer = opt.replace(/[\*\(\)]|correct|✓/gi, '').trim();
            break;
          }
        }
        
        // Clean options (remove markers)
        const cleanOptions = currentOptions.map(opt => 
          opt.replace(/[\*\(\)]|correct|✓/gi, '').trim()
        );
        
        questions.push({
          question: currentQuestion,
          options: cleanOptions,
          correctAnswer: correctAnswer
        });
      }
      
      // Start new question
      currentQuestion = questionMatch[2].trim();
      currentOptions = [];
      collectingOptions = true;
      continue;
    }
    
    // Match option patterns: A., A), A:, a., etc.
    const optionMatch = line.match(/^([A-Da-d])[\.\)\:]\s+(.+)/i);
    if (optionMatch && currentQuestion) {
      const optionText = optionMatch[2].trim();
      currentOptions.push(optionText);
      continue;
    }
    
    // If line doesn't match option but we're collecting options, it might be continuation of last option
    if (collectingOptions && currentOptions.length > 0 && !optionMatch && line.length > 0) {
      // Append to last option
      const lastIndex = currentOptions.length - 1;
      currentOptions[lastIndex] = currentOptions[lastIndex] + ' ' + line;
    }
  }
  
  // Add the last question
  if (currentQuestion && currentOptions.length >= 2) {
    let correctAnswer = currentOptions[0];
    for (let opt of currentOptions) {
      const optLower = opt.toLowerCase();
      if (optLower.includes('(correct)') || 
          optLower.includes('✓') || 
          optLower.includes('*correct*')) {
        correctAnswer = opt.replace(/[\*\(\)]|correct|✓/gi, '').trim();
        break;
      }
    }
    
    const cleanOptions = currentOptions.map(opt => 
      opt.replace(/[\*\(\)]|correct|✓/gi, '').trim()
    );
    
    questions.push({
      question: currentQuestion,
      options: cleanOptions,
      correctAnswer: correctAnswer
    });
  }
  
  // If no questions found with pattern 1, try pattern 2 (simple list format)
  if (questions.length === 0) {
    return parseSimpleFormat(cleanText);
  }
  
  // Ensure all questions have 4 options (pad if necessary)
  return questions.map(q => ({
    ...q,
    options: q.options.length === 4 ? q.options : 
             [...q.options, ...Array(4 - q.options.length).fill('Option ' + (q.options.length + 1))],
    correctAnswer: q.correctAnswer || q.options[0]
  }));
};

/**
 * Parse simple question format (one per line or simple numbered list)
 */
const parseSimpleFormat = (text) => {
  const questions = [];
  const lines = text.split('\n');
  
  let currentQuestion = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Simple numbered question
    const simpleMatch = line.match(/^(\d+)[\.\)\:]\s+(.+)/);
    if (simpleMatch) {
      if (currentQuestion) {
        // For simple format, create a basic question with placeholder options
        questions.push({
          question: currentQuestion,
          options: ['Option A', 'Option B', 'Option C', 'Option D'],
          correctAnswer: 'Option A'
        });
      }
      currentQuestion = simpleMatch[2];
    } else if (currentQuestion && !simpleMatch) {
      // If we have a current question and this line doesn't start a new one,
      // treat as continuation of question
      currentQuestion += ' ' + line;
    }
  }
  
  // Add last question
  if (currentQuestion) {
    questions.push({
      question: currentQuestion,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctAnswer: 'Option A'
    });
  }
  
  return questions;
};

/**
 * Parse CSV-style format (question,opt1,opt2,opt3,opt4,correct)
 */
const parseCSVStyle = (text) => {
  const questions = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    // Try comma separator
    let parts = line.split(',').map(p => p.trim());
    
    // Try pipe separator if comma didn't work
    if (parts.length < 3 && line.includes('|')) {
      parts = line.split('|').map(p => p.trim());
    }
    
    // Try tab separator
    if (parts.length < 3 && line.includes('\t')) {
      parts = line.split('\t').map(p => p.trim());
    }
    
    if (parts.length >= 3) {
      const question = parts[0];
      const options = parts.slice(1, 5);
      const correctAnswer = parts[5] || options[0];
      
      // Pad options to 4
      while (options.length < 4) {
        options.push(`Option ${options.length + 1}`);
      }
      
      if (question && question.length > 0) {
        questions.push({
          question: question,
          options: options,
          correctAnswer: correctAnswer
        });
      }
    }
  }
  
  return questions;
};

/**
 * Main function to extract questions with multiple strategies
 */
const extractQuestionsFromPDF = async (pdfBuffer) => {
  console.log('Starting PDF extraction...');
  
  try {
    // Step 1: Extract text from PDF
    console.log('Extracting text from PDF...');
    const text = await extractTextFromPDF(pdfBuffer);
    
    if (!text || text.trim().length === 0) {
      throw new Error('PDF contains no readable text. The file might be scanned or image-based.');
    }
    
    console.log(`Extracted ${text.length} characters of text`);
    console.log('First 500 characters:', text.substring(0, 500));
    
    // Step 2: Try to parse questions using standard format
    console.log('Parsing questions from text...');
    let questions = parseQuestionsFromText(text);
    
    // Step 3: If no questions found, try CSV style
    if (questions.length === 0) {
      console.log('No questions found with standard format, trying CSV style...');
      questions = parseCSVStyle(text);
    }
    
    // Step 4: Validate results
    if (questions.length === 0) {
      throw new Error('No questions could be extracted. Please ensure your PDF contains questions in one of these formats:\n\n' +
        'Format 1 (Numbered):\n' +
        '1. What is the capital?\n' +
        'A. Lilongwe (correct)\n' +
        'B. Blantyre\n' +
        'C. Mzuzu\n' +
        'D. Zomba\n\n' +
        'Format 2 (CSV):\n' +
        'Question,Option A,Option B,Option C,Option D,Correct Answer');
    }
    
    // Step 5: Clean and validate each question
    const validQuestions = questions.filter(q => {
      const hasQuestion = q.question && q.question.trim().length > 0;
      const hasOptions = q.options && q.options.some(opt => opt && opt.trim().length > 0);
      const hasAnswer = q.correctAnswer && q.correctAnswer.trim().length > 0;
      
      if (!hasQuestion) console.log('Skipping question with no text');
      if (!hasOptions) console.log('Skipping question with no options');
      
      return hasQuestion && hasOptions;
    });
    
    if (validQuestions.length === 0) {
      throw new Error('No valid questions found after validation');
    }
    
    console.log(`Successfully extracted ${validQuestions.length} questions`);
    
    return validQuestions;
    
  } catch (error) {
    console.error('PDF extraction error:', error);
    throw error;
  }
};

module.exports = {
  extractQuestionsFromPDF,
  extractTextFromPDF,
  parseQuestionsFromText,
  parseCSVStyle
};
