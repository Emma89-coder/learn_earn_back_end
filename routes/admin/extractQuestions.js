const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const csv = require('csv-parser');
const { Readable } = require('stream');
const authenticateToken = require('../middleware/auth');

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ============ ENHANCED OPTION REFORMATTER AGENT ============
const OptionReformatterAgent = {
  // Parse inline options like "A 1972 C. 1974 B 1973 D. 1975"
  parseInlineOptions: (text) => {
    // Pattern to find all options (A, B, C, D followed by text)
    // Handles formats: "A 1972", "C. 1974", "B 1973", "D. 1975"
    const pattern = /([A-D])(?:\.|\s)?\s*([^A-D]*?)(?=\s*[A-D]|$)/gi;
    const matches = [...text.matchAll(pattern)];
    
    if (matches.length >= 2) {
      const options = [];
      for (const match of matches) {
        const letter = match[1];
        let optionText = match[2].trim();
        if (optionText) {
          // Clean up the option text
          optionText = optionText.replace(/^\.\s*/, '').trim();
          options.push({
            letter: letter.toUpperCase(),
            text: optionText,
            original: match[0]
          });
        }
      }
      
      if (options.length >= 2) {
        const expectedOrder = ['A', 'B', 'C', 'D'];
        const sorted = [...options].sort((a, b) => 
          expectedOrder.indexOf(a.letter) - expectedOrder.indexOf(b.letter)
        );
        return sorted.map(opt => `${opt.letter}. ${opt.text}`);
      }
    }
    return null;
  },

  // Extract question from line that has inline options
  extractQuestionFromInlineLine: (line) => {
    // Find the first option pattern
    const firstOptionMatch = line.match(/[A-D](?:\.|\s)/);
    if (firstOptionMatch && firstOptionMatch.index > 0) {
      const questionText = line.substring(0, firstOptionMatch.index).trim();
      const optionsText = line.substring(firstOptionMatch.index);
      const parsedOptions = OptionReformatterAgent.parseInlineOptions(optionsText);
      if (parsedOptions && parsedOptions.length >= 2) {
        return { questionText, options: parsedOptions };
      }
    }
    return null;
  },

  // Reformat out-of-order options and fix missing delimiters
  reformatOptions: (options) => {
    if (!options || !Array.isArray(options) || options.length === 0) return options;
    
    // First, try to parse options from a single string (like "A 1972 C. 1974 B 1973 D. 1975")
    if (options.length === 1 && typeof options[0] === 'string') {
      const parsed = OptionReformatterAgent.parseInlineOptions(options[0]);
      if (parsed && parsed.length >= 2) {
        options = parsed;
      }
    }
    
    // Parse options with their letters
    const parsedOptions = [];
    for (let i = 0; i < options.length; i++) {
      let opt = options[i];
      if (!opt || typeof opt !== 'string') {
        parsedOptions.push(null);
        continue;
      }
      
      // Try to extract letter and text from various formats
      let match = opt.match(/^([A-Da-d])[\.\)\-\s]+\s*(.+)/);
      if (!match) {
        // Handle format like "A 1972" (no dot or dash)
        match = opt.match(/^([A-Da-d])\s+(.+)/);
      }
      if (!match) {
        // Handle format like "1972" (no letter) - add default letter
        parsedOptions.push({
          letter: String.fromCharCode(65 + i),
          text: opt.trim(),
          original: opt,
          needsLetter: true
        });
        continue;
      }
      
      parsedOptions.push({
        letter: match[1].toUpperCase(),
        text: match[2].trim(),
        original: opt,
        index: i
      });
    }
    
    const validOptions = parsedOptions.filter(p => p !== null);
    if (validOptions.length < 2) return options;
    
    // Ensure we have exactly 4 options (add empty ones if needed)
    const expectedOrder = ['A', 'B', 'C', 'D'];
    const currentOrder = validOptions.map(p => p.letter);
    
    // Check if options are out of order
    const isOutOfOrder = validOptions.length >= 2 && 
      !currentOrder.every((letter, idx) => letter === expectedOrder[idx]);
    
    // Check if any option needs a letter
    const needsLetters = validOptions.some(p => p.needsLetter);
    
    if (isOutOfOrder || needsLetters || validOptions.length !== 4) {
      // Create a complete set of 4 options
      const completeOptions = [];
      
      // Sort existing options by letter
      const sorted = [...validOptions].sort((a, b) => 
        expectedOrder.indexOf(a.letter) - expectedOrder.indexOf(b.letter)
      );
      
      // Fill in all 4 positions
      for (let i = 0; i < 4; i++) {
        const expectedLetter = expectedOrder[i];
        const existing = sorted.find(s => s.letter === expectedLetter);
        
        if (existing) {
          completeOptions.push(`${expectedLetter}. ${existing.text}`);
        } else {
          // Missing option - add placeholder
          completeOptions.push(`${expectedLetter}. `);
        }
      }
      
      return completeOptions;
    }
    
    // Ensure proper formatting (add dot after letter if missing)
    return options.map(opt => {
      if (opt.match(/^[A-D]\s/)) {
        return opt.replace(/^([A-D])\s/, '$1. ');
      }
      return opt;
    });
  },
  
  // Split inline options like "A. Text B. Text C. Text D. Text"
  splitInlineOptions: (text) => {
    const pattern = /([A-D])[\.\)\-\s]+\s*([^A-D]*?)(?=\s*[A-D][\.\)\-\s]|\s*$)/gi;
    const matches = [...text.matchAll(pattern)];
    
    if (matches.length >= 2) {
      const options = [];
      for (const match of matches) {
        const letter = match[1];
        let optionText = match[2].trim();
        if (optionText) {
          const hasMarker = optionText.includes('✓') || optionText.includes('*') || optionText.includes('✔');
          optionText = optionText.replace(/[✓*✔✅]/g, '').replace(/\(correct\)/i, '').trim();
          options.push({
            letter,
            text: optionText,
            isCorrect: hasMarker
          });
        }
      }
      
      if (options.length >= 2) {
        const expectedOrder = ['A', 'B', 'C', 'D'];
        const sorted = [...options].sort((a, b) => 
          expectedOrder.indexOf(a.letter) - expectedOrder.indexOf(b.letter)
        );
        const reformattedOptions = sorted.map(opt => `${opt.letter}. ${opt.text}`);
        const correctAnswer = options.find(opt => opt.isCorrect)?.text || sorted[0]?.text;
        return { options: reformattedOptions, correctAnswer };
      }
    }
    return null;
  },
  
  // Auto-complete missing options (for questions with only 2 options)
  completeMissingOptions: (options) => {
    const result = [...options];
    while (result.length < 4) {
      const nextLetter = String.fromCharCode(65 + result.length);
      result.push(`${nextLetter}. `);
    }
    return result;
  },
  
  // Check if options are incomplete (less than 4)
  hasIncompleteOptions: (options) => {
    return options.length < 4 || options.some(opt => !opt || opt.trim() === '' || opt.match(/^[A-D]\.\s*$/));
  },
  
  // Detect correct answer from various markers
  detectCorrectAnswer: (options, line = '') => {
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (typeof opt === 'string') {
        if (opt.includes('✓') || opt.includes('*') || opt.includes('✔') || 
            opt.includes('✅') || opt.toLowerCase().includes('(correct)')) {
          return opt.replace(/[✓*✔✅]/g, '').replace(/\(correct\)/i, '').trim();
        }
      }
    }
    
    if (line) {
      const answerMatch = line.match(/(?:answer|correct answer|correct|ans)[:\s]+(.+)/i);
      if (answerMatch) {
        let answer = answerMatch[1].trim();
        answer = answer.replace(/[✓*✔✅]/g, '').replace(/\(correct\)/i, '').trim();
        
        for (const opt of options) {
          if (typeof opt === 'string' && 
              (opt.toLowerCase() === answer.toLowerCase() ||
               opt.toLowerCase().includes(answer.toLowerCase()) ||
               answer.toLowerCase().includes(opt.toLowerCase()))) {
            return opt;
          }
        }
        
        const letterMatch = answer.match(/^([A-D])$/i);
        if (letterMatch) {
          const letterIndex = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
          if (options[letterIndex]) {
            return options[letterIndex];
          }
        }
      }
    }
    return null;
  },
  
  // Main reformat function for all questions
  reformatAllQuestions: (questions) => {
    let reformattedCount = 0;
    let incompleteCount = 0;
    
    const reformatted = questions.map(q => {
      let changed = false;
      let newOptions = [...q.options];
      
      // Check if options are a single string (inline)
      if (newOptions.length === 1 && typeof newOptions[0] === 'string') {
        const parsed = OptionReformatterAgent.parseInlineOptions(newOptions[0]);
        if (parsed && parsed.length >= 2) {
          newOptions = parsed;
          changed = true;
        }
      }
      
      // Reformat options
      const reformattedOpts = OptionReformatterAgent.reformatOptions(newOptions);
      if (JSON.stringify(reformattedOpts) !== JSON.stringify(newOptions)) {
        newOptions = reformattedOpts;
        changed = true;
        reformattedCount++;
      }
      
      // Check for incomplete options
      if (OptionReformatterAgent.hasIncompleteOptions(newOptions)) {
        newOptions = OptionReformatterAgent.completeMissingOptions(newOptions);
        changed = true;
        incompleteCount++;
      }
      
      // Update correct answer if needed
      let newCorrectAnswer = q.correctAnswer;
      if (newCorrectAnswer && !newOptions.includes(newCorrectAnswer)) {
        const cleanCorrect = newCorrectAnswer.replace(/^[A-D][\.\)\-\s]*/, '').trim();
        const matchingOption = newOptions.find(opt => 
          opt.replace(/^[A-D][\.\)\-\s]*/, '').trim() === cleanCorrect
        );
        if (matchingOption) {
          newCorrectAnswer = matchingOption;
          changed = true;
        }
      }
      
      return changed ? { ...q, options: newOptions, correctAnswer: newCorrectAnswer } : q;
    });
    
    return { questions: reformatted, reformattedCount, incompleteCount };
  },
  
  // Analyze options for issues
  analyzeOptions: (options) => {
    const issues = [];
    const letters = [];
    
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const match = opt.match(/^([A-D])/i);
      if (match) {
        letters.push(match[1].toUpperCase());
      } else {
        issues.push({ type: 'missing_letter', index: i, text: opt });
      }
    }
    
    const expectedOrder = ['A', 'B', 'C', 'D'];
    const isOutOfOrder = letters.length === 4 && 
      !letters.every((letter, idx) => letter === expectedOrder[idx]);
    
    if (isOutOfOrder) {
      issues.push({ type: 'out_of_order', current: letters, expected: expectedOrder });
    }
    
    return {
      hasIssues: issues.length > 0,
      issues,
      needsReformat: isOutOfOrder || issues.some(i => i.type === 'missing_letter')
    };
  }
};

// Advanced question extraction from various file types
router.post('/extract-questions-advanced', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileType = req.file.mimetype;
    const fileName = req.file.originalname;
    let extractedText = '';
    let questions = [];

    console.log(`📄 Processing file: ${fileName}, Type: ${fileType}, Size: ${req.file.size} bytes`);

    if (fileType === 'application/pdf' || fileName.endsWith('.pdf')) {
      const pdfData = await pdfParse(req.file.buffer);
      extractedText = pdfData.text;
      console.log(`📄 PDF extracted text length: ${extractedText.length} characters`);
    } 
    else if (fileType === 'text/csv' || fileName.endsWith('.csv')) {
      questions = await parseCSVQuestions(req.file.buffer);
      console.log(`📊 CSV extracted ${questions.length} questions`);
      return res.json({ success: true, questions, message: `Extracted ${questions.length} questions from CSV` });
    }
    else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value;
      console.log(`📄 DOCX extracted text length: ${extractedText.length} characters`);
    }
    else {
      return res.status(400).json({ success: false, message: 'Unsupported file type. Please upload PDF, CSV, or DOCX' });
    }

    if (extractedText) {
      questions = parseQuestionsFromText(extractedText);
      console.log(`📋 Found ${questions.length} questions from text parsing`);
    }

    if (questions.length === 0) {
      questions = fallbackExtraction(extractedText);
      console.log(`📋 Fallback extraction found ${questions.length} questions`);
    }

    if (questions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No questions could be extracted. Please ensure your document has numbered questions with options.' 
      });
    }

    // Reorganize and clean questions
    questions = reorganizeQuestions(questions);
    
    // Apply full reformatting
    const { questions: reformattedQuestions, reformattedCount, incompleteCount } = 
      OptionReformatterAgent.reformatAllQuestions(questions);

    res.json({ 
      success: true, 
      questions: reformattedQuestions, 
      stats: {
        total: reformattedQuestions.length,
        valid: reformattedQuestions.filter(q => q.question && q.correctAnswer).length,
        reformatted: reformattedCount,
        incomplete: incompleteCount
      },
      message: `Successfully extracted ${reformattedQuestions.length} questions (${reformattedCount} reformatted, ${incompleteCount} completed)`
    });

  } catch (error) {
    console.error('Extraction error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to extract questions: ' + error.message 
    });
  }
});

// Parse CSV file
function parseCSVQuestions(buffer) {
  return new Promise((resolve, reject) => {
    const questions = [];
    const stream = Readable.from(buffer.toString());
    
    stream
      .pipe(csv())
      .on('data', (row) => {
        let options = [
          row.option_a || row.OptionA || row.a || row.A || '',
          row.option_b || row.OptionB || row.b || row.B || '',
          row.option_c || row.OptionC || row.c || row.C || '',
          row.option_d || row.OptionD || row.d || row.D || ''
        ];
        
        options = OptionReformatterAgent.reformatOptions(options);
        
        let correctAnswer = row.correct_answer || row.CorrectAnswer || row.answer || row.Answer || '';
        
        if (!correctAnswer) {
          correctAnswer = OptionReformatterAgent.detectCorrectAnswer(options);
        }
        
        const question = {
          id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          question: row.question || row.Question || row.text || row.Text || '',
          options: options,
          correctAnswer: correctAnswer || options[0] || '',
          questionImage: row.image_url || row.ImageUrl || '',
          layout: 'text-first',
          difficulty: row.difficulty || 'intermediate'
        };
        
        if (question.question && question.correctAnswer) {
          questions.push(question);
        }
      })
      .on('end', () => resolve(questions))
      .on('error', reject);
  });
}

// Parse questions from text
function parseQuestionsFromText(text) {
  const questions = [];
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  
  let currentQuestion = null;
  let currentOptions = [];
  let currentCorrectAnswer = null;
  let inQuestion = false;
  let currentAnswerLine = '';
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    
    // Check for inline options with question text
    const inlineExtraction = OptionReformatterAgent.extractQuestionFromInlineLine(line);
    if (inlineExtraction && inlineExtraction.options.length >= 2) {
      questions.push({
        id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${questions.length}`,
        question: inlineExtraction.questionText,
        options: inlineExtraction.options,
        correctAnswer: inlineExtraction.options[0],
        questionImage: '',
        layout: 'text-first'
      });
      continue;
    }
    
    // Check for inline options pattern (options only)
    const inlineResult = OptionReformatterAgent.splitInlineOptions(line);
    if (inlineResult && inlineResult.options && inlineResult.options.length >= 2 && currentQuestion) {
      questions.push({
        id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${questions.length}`,
        question: currentQuestion,
        options: inlineResult.options,
        correctAnswer: inlineResult.correctAnswer || inlineResult.options[0],
        questionImage: '',
        layout: 'text-first'
      });
      currentQuestion = null;
      currentOptions = [];
      inQuestion = false;
      continue;
    }
    
    // Check for question patterns
    const questionPatterns = [
      /^(\d+)[\.\)\-:]\s+(.+)/i,
      /^Q\.?(\d+)[\.\)\-:]\s+(.+)/i,
      /^Question\s+(\d+)[\.\)\-:]\s+(.+)/i,
      /^Item\s+(\d+)[\.\)\-:]\s+(.+)/i,
      /^[\(\[](\d+)[\)\]]\s+(.+)/i,
    ];
    
    let isQuestion = false;
    let questionText = null;
    
    for (const pattern of questionPatterns) {
      const match = line.match(pattern);
      if (match) {
        isQuestion = true;
        questionText = match[2];
        break;
      }
    }
    
    if (!isQuestion && line.endsWith('?') && line.length > 15 && line.length < 300 && !line.match(/^[A-D]/i)) {
      isQuestion = true;
      questionText = line;
    }
    
    if (isQuestion) {
      if (currentQuestion && currentOptions.length >= 2) {
        const reformattedOptions = OptionReformatterAgent.reformatOptions(currentOptions);
        let correctAnswer = currentCorrectAnswer;
        
        if (!correctAnswer) {
          correctAnswer = OptionReformatterAgent.detectCorrectAnswer(reformattedOptions, currentAnswerLine);
        }
        
        questions.push({
          id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${questions.length}`,
          question: currentQuestion,
          options: reformattedOptions,
          correctAnswer: correctAnswer || reformattedOptions[0],
          questionImage: '',
          layout: 'text-first'
        });
      }
      
      currentQuestion = questionText;
      currentOptions = [];
      currentCorrectAnswer = null;
      currentAnswerLine = '';
      inQuestion = true;
    }
    else if (inQuestion && isOptionLine(line)) {
      const option = extractOptionText(line);
      if (option) {
        currentOptions.push(option);
        
        if (line.includes('✓') || line.includes('*') || line.includes('✔') || 
            line.includes('✅') || line.toLowerCase().includes('(correct)')) {
          currentCorrectAnswer = option;
        }
      }
    }
    else if (inQuestion && isAnswerLine(line)) {
      currentAnswerLine = line;
      const answer = extractAnswer(line);
      if (answer) {
        const matchedOption = matchAnswerWithOptions(answer, currentOptions);
        if (matchedOption) {
          currentCorrectAnswer = matchedOption;
        }
      }
    }
    else if (inQuestion && currentQuestion && currentOptions.length === 0 && !isOptionLine(line)) {
      if (line.length > 5 && !line.match(/^\d+/)) {
        currentQuestion += ' ' + line;
      }
    }
  }
  
  if (currentQuestion && currentOptions.length >= 2) {
    const reformattedOptions = OptionReformatterAgent.reformatOptions(currentOptions);
    let correctAnswer = currentCorrectAnswer;
    
    if (!correctAnswer) {
      correctAnswer = OptionReformatterAgent.detectCorrectAnswer(reformattedOptions, currentAnswerLine);
    }
    
    questions.push({
      id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${questions.length}`,
      question: currentQuestion,
      options: reformattedOptions,
      correctAnswer: correctAnswer || reformattedOptions[0],
      questionImage: '',
      layout: 'text-first'
    });
  }
  
  return questions;
}

function detectInlineOptions(line) {
  const optionPattern = /([A-D])[\.\)\-:]\s*([^A-D]*?)(?=\s*[A-D][\.\)\-:]|\s*$)/gi;
  const matches = [...line.matchAll(optionPattern)];
  
  if (matches.length >= 2) {
    const options = [];
    let questionText = '';
    
    const firstOptionIndex = line.search(/[A-D][\.\)\-:]/);
    if (firstOptionIndex > 0) {
      questionText = line.substring(0, firstOptionIndex).trim();
    }
    
    for (const match of matches) {
      const optionText = match[2].trim();
      if (optionText) {
        options.push(optionText);
      }
    }
    
    let correctAnswer = null;
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (opt.includes('✓') || opt.includes('*') || opt.includes('✔')) {
        correctAnswer = opt.replace(/[✓*✔]/g, '').trim();
        options[i] = correctAnswer;
        break;
      }
    }
    
    if (questionText && options.length >= 2) {
      return { questionText, options, correctAnswer };
    }
  }
  return null;
}

function isOptionLine(line) {
  return line.match(/^[A-D][\.\)\-:]\s+/i) ||
         line.match(/^[a-d][\.\)\-:]\s+/) ||
         line.match(/^[A-D]\)\s+/) ||
         line.match(/^\([A-D]\)\s+/) ||
         line.match(/^[A-D]\s+/);
}

function extractOptionText(line) {
  let option = line;
  option = option.replace(/^[A-D][\.\)\-:]\s*/i, '');
  option = option.replace(/^[a-d][\.\)\-:]\s*/, '');
  option = option.replace(/^[A-D]\)\s*/, '');
  option = option.replace(/^\([A-D]\)\s*/, '');
  option = option.replace(/^[A-D]\s+/i, '');
  option = option.replace(/[✓*✔✅]/g, '');
  option = option.replace(/\(correct\)/i, '');
  return option.trim();
}

function isAnswerLine(line) {
  return line.toLowerCase().includes('answer:') ||
         line.toLowerCase().includes('correct answer:') ||
         line.toLowerCase().includes('correct:') ||
         line.toLowerCase().includes('ans:');
}

function extractAnswer(line) {
  const match = line.match(/(?:answer|correct answer|correct|ans)[:\s]+(.+)/i);
  if (match) {
    let answer = match[1].trim();
    answer = answer.replace(/[✓*✔✅]/g, '').replace(/\(correct\)/i, '').trim();
    return answer;
  }
  return null;
}

function matchAnswerWithOptions(answer, options) {
  for (const opt of options) {
    if (opt.toLowerCase() === answer.toLowerCase()) {
      return opt;
    }
  }
  
  for (const opt of options) {
    if (opt.toLowerCase().includes(answer.toLowerCase()) ||
        answer.toLowerCase().includes(opt.toLowerCase())) {
      return opt;
    }
  }
  
  const letterMatch = answer.match(/^([A-D])$/i);
  if (letterMatch) {
    const letterIndex = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
    if (options[letterIndex]) {
      return options[letterIndex];
    }
  }
  return null;
}

function fallbackExtraction(text) {
  const questions = [];
  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    const inlineMatch = detectInlineOptions(line);
    if (inlineMatch) {
      const reformattedOptions = OptionReformatterAgent.reformatOptions(inlineMatch.options);
      questions.push({
        id: `fallback-${Date.now()}-${questions.length}`,
        question: inlineMatch.questionText,
        options: reformattedOptions,
        correctAnswer: inlineMatch.correctAnswer || reformattedOptions[0],
        questionImage: '',
        layout: 'text-first'
      });
      continue;
    }
    
    if ((line.includes('?') || line.match(/^\d+/)) && line.length > 10 && line.length < 300) {
      const options = [];
      let j = i + 1;
      
      while (j < lines.length && j < i + 8) {
        const nextLine = lines[j].trim();
        if (isOptionLine(nextLine)) {
          const opt = extractOptionText(nextLine);
          if (opt) {
            options.push(opt);
          }
        } else if (options.length === 0 && nextLine.length > 0 && !nextLine.match(/^\d+/)) {
          break;
        } else if (options.length > 0 && !isOptionLine(nextLine)) {
          break;
        }
        j++;
      }
      
      if (options.length >= 2) {
        const reformattedOptions = OptionReformatterAgent.reformatOptions(options);
        questions.push({
          id: `fallback-${Date.now()}-${questions.length}`,
          question: line,
          options: reformattedOptions,
          correctAnswer: reformattedOptions[0],
          questionImage: '',
          layout: 'text-first'
        });
        i = j;
      }
    }
  }
  return questions;
}

function reorganizeQuestions(questions) {
  const seen = new Set();
  const uniqueQuestions = [];
  
  for (const q of questions) {
    const normalizedText = q.question.toLowerCase().trim();
    if (!seen.has(normalizedText)) {
      seen.add(normalizedText);
      
      while (q.options.length < 4) {
        q.options.push('');
      }
      q.options = q.options.slice(0, 4);
      
      q.options = q.options.map(opt => {
        if (typeof opt === 'string') {
          return opt.replace(/[✓*✔✅]/g, '').replace(/\(correct\)/i, '').trim();
        }
        return '';
      });
      
      if (typeof q.correctAnswer === 'string') {
        q.correctAnswer = q.correctAnswer.replace(/[✓*✔✅]/g, '').replace(/\(correct\)/i, '').trim();
      }
      
      if (!q.correctAnswer || !q.options.includes(q.correctAnswer)) {
        q.correctAnswer = q.options[0] || '';
      }
      
      uniqueQuestions.push(q);
    }
  }
  return uniqueQuestions;
}

// Debug endpoint
router.post('/debug-extract', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    let extractedText = '';
    
    if (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf')) {
      const pdfData = await pdfParse(req.file.buffer);
      extractedText = pdfData.text;
    } else if (req.file.mimetype === 'text/csv' || req.file.originalname.toLowerCase().endsWith('.csv')) {
      extractedText = req.file.buffer.toString('utf-8');
    } else if (req.file.originalname.toLowerCase().endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value;
    }
    
    res.json({
      success: true,
      preview: extractedText.substring(0, 3000),
      fullLength: extractedText.length,
      lineCount: extractedText.split('\n').length,
      first50Lines: extractedText.split('\n').slice(0, 50)
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Analyze options endpoint
router.post('/analyze-options', authenticateToken, async (req, res) => {
  try {
    const { options } = req.body;
    const analysis = OptionReformatterAgent.analyzeOptions(options);
    const reformatted = OptionReformatterAgent.reformatOptions(options);
    
    res.json({
      success: true,
      analysis,
      reformatted,
      wasReformatted: JSON.stringify(options) !== JSON.stringify(reformatted)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;