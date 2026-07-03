const mongoose = require('mongoose');

const SpellingWordSchema = new mongoose.Schema({
  word: {
    type: String,
    required: true,
    uppercase: true,
    trim: true
  },
  hint: {
    type: String,
    default: ''
  },
  example: {
    type: String,
    default: ''
  },
  difficulty: {
    type: String,
    enum: ['easy', 'medium', 'hard', 'expert'],
    default: 'medium'
  },
  level: {
    type: Number,
    min: 1,
    max: 10,
    default: 1,
    required: true
  },
  points: {
    type: Number,
    default: 10,
    min: 1,
    max: 50
  },
  is_active: {
    type: Boolean,
    default: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  correct_attempts: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('SpellingWord', SpellingWordSchema);